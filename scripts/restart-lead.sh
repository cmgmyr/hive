#!/bin/bash

set -uo pipefail

resolve_script_dir() {
  local src="$1" dir
  while [ -h "$src" ]; do
    dir="$(cd -P "$(dirname "$src")" && pwd)"
    src="$(readlink "$src")"
    case "$src" in
      /*) ;;
      *) src="$dir/$src" ;;
    esac
  done
  cd -P "$(dirname "$src")" && pwd
}
SCRIPT_DIR=$(resolve_script_dir "$0")

REPO="${HIVE_REPO:-$(cd "$SCRIPT_DIR/.." && pwd)}"

DATA_DIR="${HIVE_DATA_DIR:-$HOME/.hive}"
case "$DATA_DIR" in
  /*) ;;
  *) DATA_DIR="$(pwd)/$DATA_DIR" ;;
esac
DB="$DATA_DIR/hive.db"
GLOBAL_YML="$DATA_DIR/hive.yml"
LOG="${HIVE_RESTART_LOG:-$HOME/.hive/restart-lead.log}"

READY_TIMEOUT="${HIVE_RESTART_READY_TIMEOUT:-45}"

DRY_RUN=0
FORCE=0
DELAY="${HIVE_RESTART_DELAY:-5}"
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --force) FORCE=1 ;;
    --delay) shift; DELAY="${1:-}" ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
  shift
done
case "$DELAY" in
  ''|*[!0-9]*) echo "--delay wants whole seconds, got '$DELAY'" >&2; exit 2 ;;
esac

mkdir -p "$(dirname "$LOG")"
log() { printf '%s  %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >>"$LOG"; }
say() { log "$*"; [ -t 1 ] && echo "$*"; return 0; }

refuse() { log "REFUSED: $*"; echo "REFUSED: $*" >&2; exit 1; }

gone() { log "RESTART FAILED PAST THE KILL: $*"; echo "RESTART FAILED PAST THE KILL: $*" >&2; exit 1; }

say "--- restart-lead starting (dry_run=$DRY_RUN force=$FORCE delay=${DELAY}s detached=${HIVE_RESTART_DETACHED:-0}) ---"

command -v tmux >/dev/null || refuse "tmux is not on PATH"
command -v hive >/dev/null || refuse "hive is not on PATH"

command -v sqlite3 >/dev/null || refuse "sqlite3 is not on PATH"

sql_escape() { printf '%s' "$1" | sed "s/'/''/g"; }
db_query() { sqlite3 -separator "$(printf '\t')" "$DB" "$1" 2>/dev/null; }

resolve_project() {
  local repo="$1" row common_dir primary
  row=$(db_query "select id, name, path from projects where path = '$(sql_escape "$repo")';")
  if [ -z "$row" ]; then
    common_dir=$(cd "$repo" 2>/dev/null && git rev-parse --git-common-dir 2>/dev/null)
    if [ -n "$common_dir" ]; then
      case "$common_dir" in
        /*) ;;
        *) common_dir="$repo/$common_dir" ;;
      esac
      if [ "$(basename "$common_dir")" = ".git" ]; then
        primary=$(cd -P "$(dirname "$common_dir")" 2>/dev/null && pwd)
        [ -n "$primary" ] && row=$(db_query "select id, name, path from projects where path = '$(sql_escape "$primary")';")
      fi
    fi
  fi
  [ -n "$row" ] || return 1
  PROJECT_ID=$(printf '%s' "$row" | cut -f1)
  PROJECT_NAME=$(printf '%s' "$row" | cut -f2)
  PROJECT_PATH=$(printf '%s' "$row" | cut -f3)
  return 0
}

resolve_project "$REPO" || refuse "REPO ($REPO) does not resolve to a registered hive project (checked its own path and, if it is a git worktree, its primary checkout's); run 'hive init' there first, or set HIVE_REPO to a registered checkout"
say "resolved project: $PROJECT_NAME (id $PROJECT_ID, $PROJECT_PATH)"

DIST_SPAWN="$SCRIPT_DIR/../dist/spawn.js"
DIST_TMUX="$SCRIPT_DIR/../dist/tmux.js"

# Prints gone, reissued, live, unknown or changed for one lead row identity, through hive's own
# classifier, or classifier-failed (its stderr goes to the log) when node or the addon could not run it.
ownership_of() {
  local out err
  err=$(mktemp)
  out=$(HIVE_DATA_DIR="$DATA_DIR" RL_DIST_SPAWN="$DIST_SPAWN" node --input-type=module -e '
    const { currentOwnership } = await import(process.env.RL_DIST_SPAWN);
    const [id, tmux_target, tmux_socket, pane_pid] = process.argv.slice(1);
    process.stdout.write(currentOwnership(Number(id), { tmux_target, tmux_socket, pane_pid }));
  ' "$1" "$2" "$3" "$4" 2>"$err")
  case "$out" in
    gone|reissued|live|unknown|changed) printf '%s' "$out" ;;
    *)
      log "ownership classifier failed: $(head -c 2000 "$err")"
      printf classifier-failed
      ;;
  esac
  rm -f "$err"
}

resolve_lead_pane() {
  local row sess rows
  row=$(db_query "select id, tmux_target, tmux_socket, pane_pid from agents where project_id = $PROJECT_ID and kind = 'lead' and status = 'running' order by id limit 1;")
  PANE=""
  PANE_CMD=""
  LEAD_OWNERSHIP="none"
  [ -n "$row" ] || return 0
  LEAD_ID=$(printf '%s' "$row" | cut -f1)
  LEAD_TARGET=$(printf '%s' "$row" | cut -f2)
  LEAD_SOCKET=$(printf '%s' "$row" | cut -f3)
  LEAD_PID=$(printf '%s' "$row" | cut -f4)
  LEAD_OWNERSHIP=$(ownership_of "$LEAD_ID" "$LEAD_TARGET" "$LEAD_SOCKET" "$LEAD_PID")
  [ "$LEAD_OWNERSHIP" = "live" ] || return 0
  row="$LEAD_TARGET"
  if [ -n "${HIVE_SESSION:-}" ]; then
    sess="$HIVE_SESSION"
    tmux list-panes -s -t "=$sess" -F '#{pane_id}' 2>/dev/null | grep -qxF "$row" || return 0
  else

    rows=$(tmux list-panes -a -F '#{pane_id}	#{session_name}' 2>/dev/null | awk -F'\t' -v p="$row" '$1 == p { print $2 }')
    sess=$(printf '%s\n' "$rows" | grep -vE 'view-[0-9]+(-[0-9]+)?$' | head -n1)
  fi
  [ -n "$sess" ] || return 0
  PANE="$row"
  PANE_CMD=$(tmux list-panes -s -t "=$sess" -F '#{pane_id}	#{pane_current_command}' 2>/dev/null \
    | awk -F'\t' -v p="$row" '$1 == p { print $2; exit }')
  SESSION="$sess"
  return 0
}

command -v node >/dev/null || refuse "node is not on PATH, so the lead row's pane ownership cannot be verified; refusing to kill or type by stored pane id alone"
[ -f "$DIST_SPAWN" ] || refuse "cannot verify the lead's pane ownership: $DIST_SPAWN is missing (dist/ not built) - run 'npm run build' first"

refuse_unowned() {
  case "$LEAD_OWNERSHIP" in
    unknown) refuse "the lead row's pane ownership is unknown ($LEAD_TARGET has no recorded pane pid, a legacy window target, another tmux socket, or tmux did not answer); not killing or typing into it. If the row is stale, retire it with agent_close(row_only=true) from a peer lead or terminal, then re-run" ;;
    reissued) refuse "the lead row's pane id $LEAD_TARGET now belongs to a different process (its recorded pane pid no longer matches); not killing or typing into it. Retire the stale row with agent_close, then re-run" ;;
    changed) refuse "the lead row changed while this script was reading it; re-run" ;;
    classifier-failed) refuse "could not run the ownership classifier (node or the native addon failed; the node on this PATH is $(command -v node), and its error is in $LOG); not killing or typing into $LEAD_TARGET" ;;
  esac
}

resolve_lead_pane
refuse_unowned
if [ -n "$PANE" ]; then
  say "lead pane: $PANE (running: $PANE_CMD; session: $SESSION; resolved via: store, project $PROJECT_ID's running kind='lead' row, pane ownership live)"
elif [ "$LEAD_OWNERSHIP" = "live" ]; then
  refuse "the lead row owns live pane $LEAD_TARGET but no session holding it could be resolved; not killing it blind"
else
  say "no live pane for project $PROJECT_ID's lead (pane ownership: $LEAD_OWNERSHIP) - nothing to kill; will just run hive lead"
fi

pane_says() {
  command -v node >/dev/null || return 2
  [ -f "$DIST_TMUX" ] || return 2
  RL_DIST_TMUX="$DIST_TMUX" RL_Q="$1" RL_PANE="$2" node -e '
    const t = require(process.env.RL_DIST_TMUX);
    const answer = process.env.RL_Q === "dialog"
      ? t.paneAwaitingChoice(process.env.RL_PANE)
      : t.paneHasInputBox(process.env.RL_PANE);
    process.exit(answer === null ? 2 : answer ? 0 : 1);
  ' 2>/dev/null
}

CLAUDE_PANE_CMD='^[0-9]+\.[0-9]+(\.[0-9]+)?$|^claude$'

if [ -n "$PANE" ]; then
  pane_says input-box "$PANE"
  HAS_BOX=$?

  if [ "$HAS_BOX" != "0" ] && ! grep -qE "$CLAUDE_PANE_CMD" <<<"$PANE_CMD"; then
    refuse "pane $PANE does not look like claude (command '$PANE_CMD', no claude chrome on screen); not touching it"
  fi
fi

hive status >/dev/null 2>&1 || refuse "hive status failed; the running-agent count below cannot be trusted, and a live kill on a stale answer cannot be undone (check hive's dispatcher: hive doctor)"
RUNNING=$(db_query "select count(*) from agents where status = 'running' and kind = 'agent' and project_id = $PROJECT_ID;")
[ -n "$RUNNING" ] || RUNNING="?"
say "running agents: $RUNNING"
if [ "$RUNNING" != "0" ]; then
  [ "$FORCE" = "1" ] || refuse "$RUNNING agent(s) still running; restarting would orphan the lane (--force to override)"
  say "--force given; restarting with $RUNNING agent(s) live"
fi

awaiting_choice() {
  pane_says dialog "$1"
  [ $? = 0 ]
}

if [ -n "$PANE" ] && awaiting_choice "$PANE"; then
  refuse "pane $PANE is waiting on a choice; typing into it would answer the prompt"
fi

DIST_PROJECTYML="$SCRIPT_DIR/../dist/projectYml.js"
if [ -f "$PROJECT_PATH/hive.yml" ] || [ -f "$GLOBAL_YML" ]; then
  command -v node >/dev/null || refuse "hive.yml configuration exists but node is not on PATH to check whether its lead: command is trusted; put node on PATH, or run 'hive lead' interactively once, before restarting unattended"
  [ -f "$DIST_PROJECTYML" ] || refuse "cannot verify hive.yml configuration trust: $DIST_PROJECTYML is missing (dist/ not built, or a build is in progress) - run 'npm run build', or wait for the current one to finish, before restarting unattended"
  TRUST_CHECK=$(HIVE_DATA_DIR="$DATA_DIR" RL_PROJECT_PATH="$PROJECT_PATH" RL_DIST_PROJECTYML="$DIST_PROJECTYML" node -e '
    const { loadProjectYml, configHash } = require(process.env.RL_DIST_PROJECTYML);
    const { config } = loadProjectYml(process.env.RL_PROJECT_PATH);
    if (!config) { process.stdout.write("PARSE_ERROR"); process.exit(0); }
    if (!config.lead) { process.stdout.write("NO_LEAD"); process.exit(0); }
    process.stdout.write("LEAD:" + configHash("lead", config.lead, null, {}));
  ' 2>&1)
  NODE_STATUS=$?
  [ "$NODE_STATUS" = "0" ] || refuse "could not verify hive.yml configuration trust (node exited $NODE_STATUS: $TRUST_CHECK); run 'hive lead' interactively once to check it by hand before restarting unattended"
  case "$TRUST_CHECK" in
    NO_LEAD) ;;
    PARSE_ERROR)
      refuse "hive.yml configuration failed to parse; hive lead would silently fall back to plain claude - fix the configuration, or run 'hive lead' interactively once to see the real error, before restarting unattended"
      ;;
    LEAD:*)
      LEAD_HASH="${TRUST_CHECK#LEAD:}"
      TRUSTED=$(db_query "select 1 from command_trust where project_id = $PROJECT_ID and name = 'lead' and config_hash = '$(sql_escape "$LEAD_HASH")';")
      [ -n "$TRUSTED" ] || refuse "hive.yml's lead: command is not trusted for its current config; run 'hive lead' interactively once to approve it before restarting unattended"
      ;;
    *)
      refuse "could not verify hive.yml's trust (unexpected output: $TRUST_CHECK); run 'hive lead' interactively once to check it by hand before restarting unattended"
      ;;
  esac
fi

if [ "$DRY_RUN" = "1" ]; then
  if [ -n "$PANE" ]; then
    say "dry run: would kill $PANE, run 'hive lead $REPO --no-dashboard', and send the handoff prompt"
  else
    say "dry run: no live lead pane to kill; would just run 'hive lead $REPO --no-dashboard' and send the handoff prompt"
  fi
  exit 0
fi

if [ -n "$PANE" ] && [ "${TMUX_PANE:-}" = "$PANE" ] && [ -z "${HIVE_RESTART_DETACHED:-}" ]; then
  say "launched from the target pane; re-execing detached and exiting"
  ARGS=(--delay "$DELAY")
  [ "$FORCE" = "1" ] && ARGS+=(--force)
  HIVE_RESTART_DETACHED=1 nohup "$0" "${ARGS[@]}" >/dev/null 2>&1 &
  disown 2>/dev/null || true
  exit 0
fi

PLACEHOLDER=""
remove_placeholder() {
  [ -n "$PLACEHOLDER" ] || return 0
  tmux kill-window -t "$PLACEHOLDER" 2>/dev/null || true
  PLACEHOLDER=""
}

if [ -n "$PANE" ]; then

  if [ "$DELAY" -gt 0 ]; then
    say "waiting ${DELAY}s before killing the pane"
    sleep "$DELAY"
  fi

  PLACEHOLDER=$(tmux new-window -d -P -F '#{window_id}' -t "=$SESSION" -n "restart-lead-placeholder-$$" 2>/dev/null) || PLACEHOLDER=""
  [ -n "$PLACEHOLDER" ] || refuse "could not create a placeholder window to protect the session across the kill; refusing to kill $PANE without it"

  LEAD_OWNERSHIP=$(ownership_of "$LEAD_ID" "$LEAD_TARGET" "$LEAD_SOCKET" "$LEAD_PID")
  if [ "$LEAD_OWNERSHIP" != "live" ]; then
    remove_placeholder
    [ "$LEAD_OWNERSHIP" = "gone" ] && refuse "the lead pane $PANE went away during the delay; nothing was killed - re-run to start a fresh lead"
    refuse_unowned
    refuse "the lead pane's ownership changed during the delay; nothing was killed"
  fi

  say "killing $PANE"

  tmux kill-pane -t "$PANE" || gone "kill-pane failed; $PANE may still be live, in an unknown state - check it by hand before touching this lead again"
else
  say "no live pane to kill; skipping straight to hive lead"
fi

say "running: hive lead $REPO --no-dashboard"
env -u HIVE_AGENT_ID -u HIVE_LEAD -u HIVE_AGENT_NAME hive lead "$REPO" --no-dashboard ||
  gone "hive lead failed; check by hand"

resolve_lead_pane
[ -n "$PANE" ] || gone "hive lead ran but left no running, live kind='lead' pane for project $PROJECT_ID - check by hand"
say "new lead pane: $PANE (running: $PANE_CMD; session: $SESSION; resolved via: store, project $PROJECT_ID's running kind='lead' row)"

say "waiting up to ${READY_TIMEOUT}s for the input box"
READY=0
for _ in $(seq 1 $((READY_TIMEOUT * 2))); do
  if pane_says input-box "$PANE"; then
    READY=1
    break
  fi
  sleep 0.5
done

[ "$READY" = "1" ] || gone "pane never became ready; claude may be up but unprompted - check it by hand"

sleep 1
if awaiting_choice "$PANE"; then
  gone "restarted pane is on a choice dialog; NOT sending the prompt - answer it by hand, then prompt it"
fi

STORE_PANE=$(db_query "select tmux_target from agents where project_id = $PROJECT_ID and kind = 'lead' and status = 'running' order by id limit 1;")
[ "$STORE_PANE" = "$PANE" ] || gone "about to type into $PANE, but the store's lead row now names '${STORE_PANE:-<none>}' - refusing to type a handoff into a pane the store no longer considers the lead; check by hand"

PROMPT='Run `hive runbook`, read the board pad in full, then continue from its first live item. This session was restarted automatically by scripts/restart-lead.sh, so nothing was handed to you in conversation and the store is the only handoff. Anything outward-facing still waits for the human.'

# A bracketed paste, rechecked against the row's recorded identity before the paste and again before the Enter.
SEND_OUT=$(HIVE_DATA_DIR="$DATA_DIR" RL_DIST_SPAWN="$DIST_SPAWN" RL_DIST_TMUX="$DIST_TMUX" node --input-type=module -e '
  const { requireStillOwned } = await import(process.env.RL_DIST_SPAWN);
  const { sendText } = await import(process.env.RL_DIST_TMUX);
  const [id, tmux_target, tmux_socket, pane_pid, prompt] = process.argv.slice(1);
  const identity = { tmux_target, tmux_socket, pane_pid };
  let pasted = false;
  try {
    await sendText(tmux_target, prompt, true, () => { pasted = true; }, undefined,
      () => requireStillOwned(Number(id), identity, "restart-lead handoff"));
  } catch (err) {
    process.stdout.write((pasted ? "PASTED " : "") + String(err?.message ?? err));
    process.exit(1);
  }
' "$LEAD_ID" "$LEAD_TARGET" "$LEAD_SOCKET" "$LEAD_PID" "$PROMPT" 2>&1) ||
  gone "handoff prompt not delivered to $PANE: $SEND_OUT - check it by hand"

remove_placeholder
say "prompt sent; restart complete"
