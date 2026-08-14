#!/bin/bash
# Restart the hive lead in place, then hand it back to the store.
#
# Why this exists: a hive MCP server loads dist/ once, at session start. After
# `npm run build` the running lead is still executing the OLD code, and no
# amount of rebuilding changes that. This respawns the lead pane so a fresh
# server picks up the new dist.
#
# HOW TO VERIFY A RESTART ACTUALLY WORKED: lessons pad, section RESTARTING THE
# LEAD IN PLACE. Do not duplicate that procedure here; two copies will drift.
#
# The prompt it sends is deliberately GENERIC and must stay that way. It tells
# the new lead to read the runbook and the board, which is where the previous
# lead left its next instruction. A task-specific prompt baked in here would be
# wrong within a day and this script would quietly start lying.
#
# WHO RUNS THIS: the lead, on purpose, usually on itself. There is no timer and
# there should not be one. The point is that the human can say "restart
# yourself" from a phone and the lead can carry it out without anyone reaching
# for a laptop, or that a lead which just merged a build can pick up its own new
# dist. A scheduled restart would kill sessions nobody asked to lose.
#
# Running it from inside the pane it is about to kill is the NORMAL case, not an
# edge case: the script re-execs itself detached so it outlives the pane, waits,
# then respawns. Expect the conversation to end mid-sentence; that is the tool
# working.
#
# Usage:
#   restart-lead.sh                 restart if it is safe to
#   restart-lead.sh --dry-run       say what it would do, touch nothing
#   restart-lead.sh --force         skip the running-agents refusal
#   restart-lead.sh --delay 10      seconds between kill and respawn (default 5)
#
# Three refusals below are not paranoia; each is a bug this project has already
# paid for. Read the comment above each before removing it.

set -uo pipefail

# The repo is wherever THIS script's own resolved location says it is - it
# lives at <repo>/scripts/restart-lead.sh, so its parent's parent is the
# repo. A hardcoded checkout path was fine for a file living in one
# machine's .claude/; it is wrong now that the file ships in the repo and
# whoever clones it may check out anywhere. Resolves symlinks by hand (no
# `readlink -f`, which is not on macOS by default) since a `hive`-adjacent
# tool being invoked through a symlinked path is not exotic on this machine
# (the dispatcher shim itself is one).
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
# SESSION is no longer hardcoded/defaulted here - it is derived below from
# the hive PROJECT that REPO resolves to (resolve_project), once the store is
# reachable. A fix round found the old pairing (derived REPO, hardcoded
# "hive-1" SESSION) breaks the exact portability case it was written for: run
# this script from a second ordinary clone and it kills PROJECT 1's lead
# while trying to restart the clone's. Deriving both from the same resolved
# project makes them unable to disagree.
DATA_DIR="${HIVE_DATA_DIR:-$HOME/.hive}"
case "$DATA_DIR" in
  /*) ;;
  *) DATA_DIR="$(pwd)/$DATA_DIR" ;;
esac
DB="$DATA_DIR/hive.db"
LOG="${HIVE_RESTART_LOG:-$HOME/.hive/restart-lead.log}"
# Overridable so a test can exercise "claude never became ready" without
# actually waiting 45s for it - the production default stays 45.
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
# Refusals always reach stderr, tty or not. An earlier version gated this on
# [ -t 1 ] and a non-interactive run therefore exited 1 having printed nothing,
# which is indistinguishable from a crash unless you know to read the log.
refuse() { log "REFUSED: $*"; echo "REFUSED: $*" >&2; exit 1; }
# A failure AFTER the kill is attempted is not a refusal - "REFUSED:" means
# "I touched nothing" everywhere else in this log, and past this point that
# is no longer true: the kill was attempted (whether or not it is confirmed
# to have worked) and there is no undo. A human reading the log from a phone
# is deciding whether to walk to the laptop; those two states need different
# words, not the same one read in context.
gone() { log "RESTART FAILED PAST THE KILL: $*"; echo "RESTART FAILED PAST THE KILL: $*" >&2; exit 1; }

say "--- restart-lead starting (dry_run=$DRY_RUN force=$FORCE delay=${DELAY}s detached=${HIVE_RESTART_DETACHED:-0}) ---"

command -v tmux >/dev/null || refuse "tmux is not on PATH"
command -v hive >/dev/null || refuse "hive is not on PATH"
# Probed the same way, for the same reason: without this, a missing sqlite3
# makes every db_query call below return empty, which RUNNING's fallback (see
# refusal 2) turns into "?" - fail-closed without --force, fail-OPEN with it,
# reporting "? agent(s) still running" while actually restarting blind.
command -v sqlite3 >/dev/null || refuse "sqlite3 is not on PATH"

sql_escape() { printf '%s' "$1" | sed "s/'/''/g"; }
db_query() { sqlite3 -separator "$(printf '\t')" "$DB" "$1" 2>/dev/null; }

# Resolve REPO to the hive project it names, giving PROJECT_ID/PROJECT_NAME/
# PROJECT_PATH - the store's own answer, used below for SESSION and refusal
# 2's scoping, rather than guessing either from window ordering or a
# hardcoded session name.
#
# Direct path match covers the ordinary case: a project is normally
# registered at its own root, and REPO already IS that root (scripts/'s
# parent). The git-common-dir fallback covers a linked worktree, where REPO
# is the worktree's own path but the registered project's path is the
# PRIMARY checkout's - the one case context.ts's gitPrimaryRoot exists for.
# Deliberately narrower than that function's full bestPrefixMatch/
# hasStricterMatch rule (which only differs from this for nested registered
# projects, an arrangement this script has no way to disambiguate safely
# anyway): anything git-common-dir does not resolve to a genuine
# `<root>/.git` checkout - a separate-git-dir checkout, a bare repo's own
# worktree - is refused rather than guessed at, same bias context.ts
# documents for the same reason.
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

# Resolve the lead's pane FROM THE STORE, and ONLY from the store. THERE IS
# NO FALLBACK. Round 1 found that choosing a pane by window ordering can
# kill a worker - this project's own hive.yml sets `placement: split`, so
# the lead's window ordinarily holds worker panes too. The first fix round
# demoted that scan to a fallback rather than deleting it, and round 2 found
# the fallback IS the round-1 defect, reachable three separate ways:
# --force with a dead lead row and a live worker sharing the window, ANY
# untracked live claude pane sharing the window (src/cli.ts documents this
# state itself - a losing `hive lead` leaves an orphan pane running,
# untracked), or two running kind='lead' rows making the store-equality test
# miss both (see LIMIT 1 below). One line of code, a HIGH finding in both
# rounds - deleting it makes the whole class unreachable rather than
# narrower.
#
# The scan has no job left once it is gone. It existed for "the lead died
# without cmdLead recording its replacement" - but in that state there is
# NOTHING TO KILL, the pane is already gone. `hive lead`'s own stillThere
# check (src/cli.ts) already takes the split-window/new-window branch off a
# dead previousTarget and launches a fresh lead unassisted. So resolution
# only ever answers one of two things: a LIVE pane to kill, or nothing to
# kill at all - never a guess at which pane might be the lead. The scan
# predates the lead having an agents row at all (before #68/eb31990); that
# stopped being true a long time ago and the code never caught up.
#
# LIMIT 1, matching ensureLeadRow's own `.get()`: src/cli.ts documents that
# multiple running kind='lead' rows can coexist (an older server's
# rename-repair path can leave two). Two rows used to turn `row` into a
# two-line string that could never equal a single pane id, which silently
# dropped resolution into the window scan - the same finding from a second
# angle. LIMIT 1 picks the same row `hive lead` itself would pick.
#
# Liveness is exact membership in a bare pane_id list (`grep -qxF`), not
# whether `pane_current_command` happens to render non-empty: a pane whose
# current command legitimately prints nothing was being read as "not live"
# by the old field-3 check.
#
# A function, not inline: the restart itself creates a NEW pane with a NEW
# id, so everything below that resolves $PANE once must resolve it again
# after `hive lead` runs. Sets PANE/PANE_CMD/SESSION; PANE empty means "no
# live pane, nothing to kill" - a real state the caller acts on, not an
# error.
#
# SESSION is derived from the PANE ITSELF here, via tmux, rather than
# reimplemented from HIVE_DATA_DIR the way a prior version of this script
# did (dataDirTag()/sessionName(), src/dataDir.ts and src/tmux.ts,
# hand-copied into bash as data_dir_tag/session_name_for/canon_dir).
# Counselors round 2 found that copy broken at birth: canon_dir ran as a
# PIPELINE STAGE, so pwd's trailing newline reached shasum while
# src/dataDir.ts hashes the resolved path with no newline - the two
# digests could never agree, so every non-default HIVE_DATA_DIR run
# derived a session name that did not exist. No test caught it because
# every test set HIVE_SESSION explicitly. Deleted rather than fixed: a
# second hand-copy of hive's internal naming carries the same drift risk
# CHOICE_DIALOG's copy does, with none of that copy's sync test.
#
# `tmux display-message -p -t "$row" -F '#{session_name}'` is NOT used as
# the liveness answer itself - .claude/rules/tmux-and-panes.md documents
# that display-message SILENTLY FALLS BACK to an unrelated default target
# when the one given is dead, verified directly against a throwaway tmux
# server before relying on this (a killed pane's id, probed this way,
# returned exit 0 and a WRONG session's name instead of failing). Its
# output is used ONLY to name a session to scope a REAL liveness check
# against (the list-panes membership test below): if $row is genuinely
# dead it cannot appear in ANY session's pane list, including a wrong
# fallback one, so landing on the wrong session name here cannot produce a
# false "alive".
#
# HIVE_SESSION still overrides, for tests and for a human debugging - when
# set, it is trusted outright and tmux is never asked.
resolve_lead_pane() {
  local row sess rows
  row=$(db_query "select tmux_target from agents where project_id = $PROJECT_ID and kind = 'lead' and status = 'running' order by id limit 1;")
  PANE=""
  PANE_CMD=""
  [ -n "$row" ] || return 0
  if [ -n "${HIVE_SESSION:-}" ]; then
    sess="$HIVE_SESSION"
    tmux list-panes -s -t "=$sess" -F '#{pane_id}' 2>/dev/null | grep -qxF "$row" || return 0
  else
    # `display-message -p -t <pane-id>` is AMBIGUOUS the instant this pane's
    # window is also linked into a VIEW session (topology-3c, view sessions):
    # the pane is a member of both sessions in the group, and tmux answers
    # with whichever one it currently favors - measured against tmux 3.7b,
    # it favors the view even right after the BASE session's own window was
    # selected, and stays that way regardless of which one was touched most
    # recently. That is one failure mode; the other is worse: a view session
    # can vanish (destroy-unattached) at any moment, so a SESSION resolved to
    # its name can name a session that no longer exists by the time the next
    # command uses it, refusing (or worse, reading "no live pane") for a lead
    # that is perfectly fine.
    #
    # `list-panes -a` lists a linked pane once PER SESSION it belongs to
    # (measured), so every session actually containing this pane is right
    # there in one query - filter OUT anything shaped like viewSessionName()
    # (src/tmux.ts) and what remains is the durable base session. The SUFFIX
    # shape alone ("view-<pid>", or "view-<pid>-<n>" once freeViewSessionName
    # bumps past a live collision - issue #117 counselors) is enough to tell
    # the two apart without reimplementing dataDirTag()'s hash in bash, which
    # is exactly the hand-copy this file already got bitten by once (see the
    # comment on SESSION's derivation above) and does not retry. Keep this
    # pattern in sync with isViewSessionName's (src/tmux.ts) by hand - the
    # EXCLUDE direction here is the dangerous one: a bumped view this pattern
    # fails to recognize gets mistaken for the durable base session.
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

resolve_lead_pane
if [ -n "$PANE" ]; then
  say "lead pane: $PANE (running: $PANE_CMD; session: $SESSION; resolved via: store, project $PROJECT_ID's running kind='lead' row)"
else
  say "no live pane for project $PROJECT_ID's lead (no running row, or its row's pane is not live) - nothing to kill; will just run hive lead"
fi

# The markers hive itself uses for DIALOG detection. Kept in sync with
# CHOICE_DIALOG and INPUT_BOX_PRESENT in src/tmux.ts; if claude's chrome
# changes, both move.
# TODO 399: THESE USED TO BE TWO HAND-TRANSCRIBED REGEXES AND THEY ARE NOW A
# CALL INTO hive's OWN CODE. The input-box half read
# 'for shortcuts|shift\+tab to cycle|mode on|permissions on' - four substrings
# of claude's permission-mode footer, all on ONE line of its UI, a line claude
# multiplexes with other transient hints. While another hint held that line the
# predicate was FALSE on a pane with an input box plainly on screen, so
# awaiting_choice below degenerated to the bare footer match. THIS SCRIPT
# REPAINTS THE LEAD'S PANE - the one pane a human types into - so that defect
# lived on the surface where it eats real work, and todo 399 fixing src/tmux.ts
# alone would have left it live here.
#
# Kept in sync by hand was the structure that allowed it: a sync test compared
# the two regexes as SOURCE TEXT, which works only while both are regex
# literals, and todo 392 had already found this copy carrying the bug that lane
# fixed. Two lanes, one structure.
#
# THE SHELL-OUT IS THIS FILE'S OWN ESTABLISHED PATTERN, not a new dependency:
# see DIST_PROJECTYML further down, which runs the SAME parser `hive lead`
# runs rather than a bash approximation, with the identical fail-closed
# handling for "no node" and "dist/ missing". Same argument, same shape.
#
# IT ALSO RETIRES THE WINDOW PROBLEM. capture_trimmed's `18` existed only to
# match src/tmux.ts's tailCaptureLines(), and this file's own comments record
# getting that mismatch wrong once already. paneHasInputBox and
# paneAwaitingChoice do their own capture inside src/tmux.ts, so the window
# cannot drift from hive's any more.
DIST_TMUX="$SCRIPT_DIR/../dist/tmux.js"

# Answers hive's own question about a pane. `$1` is `input-box` or `dialog`;
# `$2` is the pane. Exit 0 = yes, 1 = no, 2 = could not answer.
#
# FAILS CLOSED IN THE CALLER, NOT HERE, because "yes" and "no" are refusals in
# opposite directions at the three call sites below: refusal 1 wants "no input
# box" to refuse, refusal 3 wants "dialog" to refuse, and the readiness wait
# wants "input box" to proceed. A single exit code cannot carry that, so this
# reports UNKNOWN as 2 and each caller decides - which is the same tri-state
# discipline src/tmux.ts uses for every tmux probe it makes.
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

# A SEPARATE identity signal, for refusal 1 only, deliberately not
# CHOICE_DIALOG. Todo 392 round-1 review (F2): CHOICE_DIALOG is a bare,
# unanchored substring match, loose ON PURPOSE so a real dialog whose wording
# drifts is still caught (see CHOICE_DIALOG's own comment in src/tmux.ts).
# That looseness is safe everywhere it is paired with INPUT_BOX's absence -
# the pairing is what turns "this text is somewhere on screen" into "this is
# a dialog". Refusal 1 used to OR it in UNGUARDED, as proof the pane is
# claude at all, and "Esc to cancel" alone was implausible in an ordinary
# shell's scrollback - but "Would you like to proceed" (added for the
# plan-approval dialog, D3) is ordinary installer/CLI prompt text. A bare
# shell whose scrollback happens to carry it (an apt/brew/npm confirmation,
# say) would have passed as claude and been KILLED - exactly the case
# refusal 1 exists to prevent (issue #157's bare-shell-in-%0).
#
# claude's own pane_current_command IS its version string ("2.1.220",
# "2.1.231", ...) for the pane's entire life - measured live, idle, busy, and
# sitting on a real permission-prompt dialog all report the identical value.
# That is not "wrong", contrary to what this file used to say two paragraphs
# below: it is claude's actual process title, and unlike a hardcoded exact
# version it is not a moving target, because CLAUDE_PANE_CMD matches the
# SHAPE (a version number) rather than any one release. It also cannot be
# forged by anything printed to the screen, which is exactly the property
# CHOICE_DIALOG lacks for this purpose.
#
# Known limit, accepted rather than closed (todo 392 round 2 review, F3/C4):
# `pane_current_command` reflects whatever the foreground process's own
# comm resolves to, and in principle nothing stops an unrelated process
# from making that a bare version string too - a binary literally named
# "2.1.231", say. MEASURED to be harder than it sounds, not just assumed
# safe: neither of the two ordinary ways a shell script can try (`exec -a
# "2.1.231" cmd`, which only sets argv[0]; a Node process setting
# `process.title = "2.1.231"`) actually changed what tmux itself reports
# for pane_current_command in this file's own testing - both still showed
# the real underlying binary. Left as an accepted residual anyway, because
# an ACTUAL binary named or compiled to report that shape is still a real,
# if narrow, possibility this regex cannot rule out. Accepted for the same
# reason CHOICE_DIALOG's own remaining "Esc to cancel" alternative is: the
# failure direction this file cares about most (refusal 1 wrongly PASSING a
# non-claude pane through so it gets killed) needs someone to have engineered
# a fake process to look like this, not a real installer's output the way
# CHOICE_DIALOG's prose alternatives could be; the opposite miss (a real
# claude reporting something other than a bare version, e.g. a wrapper
# launch: `mise exec -- claude`, `npx`) fails in the refuse direction below,
# which is safe.
CLAUDE_PANE_CMD='^[0-9]+\.[0-9]+(\.[0-9]+)?$|^claude$'

# Mirrors capturePane() in src/tmux.ts, and has to: a bare `capture-pane -p
# -S -N` is NOT the window hive's own dialog detector reads. Measured
# against a real tmux 3.7b, `-S -N` returns N rows of HISTORY PLUS THE
# WHOLE VISIBLE PANE (~68 rows for -S -18 against an 80-line scroll on a
# 50-row pane) - hive's capturePane() strips TRAILING blank rows from that
# raw output first, then takes the LAST N of what remains, which is a much
# NARROWER effective window whenever the pane has blank padding below its
# real content (the ordinary case: claude's own chrome sits well above the
# bottom of a tall pane).
#
# Todo 392 round 2 review (F2/opus finding 1) found this file used the raw
# form for both consumers of these markers, and named the reachable
# consequence: a lead pane sitting on a real dialog, whose earlier
# transcript rows (above the dialog, still within the WIDER raw window)
# quote "shift+tab to cycle" or "mode on" - a lead reviewing this exact
# lane, or that grepped src/tmux.ts, or that catted a pane fixture, the
# precise case decision D5 exists for - reads as a real dialog to hive's
# own paneAwaitingChoice (narrow window, never sees the stray text) and as
# NO dialog to this script's old raw-window version (wide window, sees it,
# INPUT_BOX matches, awaiting_choice returns false). Refusal 3 would not
# have fired, and the script would have killed a lead waiting on a human.
# Defined here, before refusal 1, so both readers of INPUT_BOX (this one and
# refusal 3's awaiting_choice) share it.
capture_trimmed() {
  local n="$1" target="$2" raw
  raw=$(tmux capture-pane -p -t "$target" -S "-$n" 2>/dev/null) || return 1
  printf '%s\n' "$raw" | awk -v n="$n" '
    { lines[NR] = $0 }
    END {
      last = NR
      while (last > 0 && lines[last] ~ /^[[:space:]]*$/) last--
      start = last - n + 1
      if (start < 1) start = 1
      for (i = start; i <= last; i++) print lines[i]
    }'
}

# REFUSAL 1. Do not respawn a pane that is not running claude. If someone left
# a shell, a build, or an editor there, killing it destroys work this script
# knows nothing about. Only applies when there IS a pane to examine - the
# skip-the-kill path (no live lead pane) has nothing here to check.
#
# Identity is CLAUDE_PANE_CMD (above) OR INPUT_BOX (claude's own idle/busy
# chrome) - never CHOICE_DIALOG, for the reason CLAUDE_PANE_CMD's own comment
# gives (todo 392 round 1, F2).
#
# Todo 392 round 2 review (F3) asked for INPUT_BOX to be dropped from this
# OR too, on the same reasoning as F2: it is still SCREEN TEXT, and a shell
# that `cat`s a captured pane fixture or its own scrollback from grepping
# src/tmux.ts would render "shift+tab to cycle" or "mode on" and pass as
# claude. Tried, and reverted after measurement (this round): dropping it
# does not just narrow an edge case, it breaks every EXISTING real-restart
# test in this file. makeFakeClaude() (test/helpers.mjs), the fixture this
# whole suite's restart tests use in place of a slow real claude spawn,
# `exec`s into a plain shell - and per CLAUDE_PANE_CMD's own "known limit"
# paragraph above, that shell's pane_current_command reads "bash" or "sh",
# never a version-shaped string, no matter which spoofing trick is tried.
# So CLAUDE_PANE_CMD alone cannot recognize any of this project's own
# fake-claude fixtures OR a real wrapper-launched claude (`mise exec --
# claude`, `npx`) - the identical failure mode CLAUDE_PANE_CMD's own comment
# already names as an accepted cost for the SECURITY side, reappearing here
# as a FUNCTIONAL cost that would have been much larger in practice: every
# restart this project's own suite exercises, and every real wrapper launch,
# refusing instead of restarting. Kept as a fallback rather than dropped:
# the residual F3 raised is real, but it is the SAME LOW-PROBABILITY CLASS
# already accepted for CHOICE_DIALOG's own remaining "Esc to cancel"
# alternative two sections up, not a new one - and unlike that trade, this
# one was going to cost something concrete and immediate (a broken suite,
# and refused restarts for ordinary wrapper launches) for a residual that
# was already accepted elsewhere in this exact file. What DID change this
# round: the WINDOW this reads is now capture_trimmed (its own comment is
# just above CLAUDE_PANE_CMD) rather than a bare capture-pane, since a wider
# raw window only makes the residual worse without buying anything back.
if [ -n "$PANE" ]; then
  pane_says input-box "$PANE"
  HAS_BOX=$?
  # UNKNOWN (2) is treated as "no chrome seen" here deliberately: this refusal
  # is a fail-closed identity check with a second, independent signal beside
  # it (CLAUDE_PANE_CMD), so an unanswerable probe costs a refusal a human can
  # read and act on, never a kill of a pane hive could not identify.
  if [ "$HAS_BOX" != "0" ] && ! grep -qE "$CLAUDE_PANE_CMD" <<<"$PANE_CMD"; then
    refuse "pane $PANE does not look like claude (command '$PANE_CMD', no claude chrome on screen); not touching it"
  fi
fi

# REFUSAL 2. Never restart while WORKERS are alive. They live in their own
# panes and survive this, which is the problem: the lane keeps running with
# nobody coordinating it, and any wake aimed at the lead's pane fires into a
# pane that is mid-restart and is recorded delivered (issue #27). `hive status`
# first, because it runs the janitor and sweeps rows whose panes are gone, so
# the count below is about live agents rather than stale ones.
#
# kind = 'agent' is an ALLOWLIST, not `kind != 'lead'`: this is the row this
# lead itself now carries (kind='lead', status='running'), which must never
# count against itself, and a future third kind must be excluded by default
# rather than silently counted. src/hook.ts scopes its own agent_state UPDATE
# the same way and for the same reason.
#
# project_id = $PROJECT_ID scopes this to the project just resolved, matching
# hive's own equivalent query (src/cli.ts's statusline count). Unscoped, this
# counted every project sharing the store: a worker in project B blocked
# project A's lead from ever restarting, and a --force run said nothing
# useful about the lane it was actually about to orphan.
#
# `hive status` failing here used to be a warning, not a refusal - wrong,
# because after the kill below there is no recovering from having trusted a
# stale answer. Concretely: a dispatcher whose file exists (`command -v hive`
# passes) but whose pinned interpreter is gone (this project's own issue #51
# class) makes `hive status` fail while the direct sqlite3 query below still
# happily returns 0. The old code killed the only lead on that "0" anyway,
# then `hive lead` failed for the identical reason - a lead row stuck
# `running` against a dead pane forever, janitor-exempt, with every
# lead-owned wake held against it and no process left to fix any of it. The
# preflight is the only chance to catch this before it is unrecoverable.
hive status >/dev/null 2>&1 || refuse "hive status failed; the running-agent count below cannot be trusted, and a live kill on a stale answer cannot be undone (check hive's dispatcher: hive doctor)"
RUNNING=$(db_query "select count(*) from agents where status = 'running' and kind = 'agent' and project_id = $PROJECT_ID;")
[ -n "$RUNNING" ] || RUNNING="?"
say "running agents: $RUNNING"
if [ "$RUNNING" != "0" ]; then
  [ "$FORCE" = "1" ] || refuse "$RUNNING agent(s) still running; restarting would orphan the lane (--force to override)"
  say "--force given; restarting with $RUNNING agent(s) live"
fi

# REFUSAL 3, and the sharpest one. A pane showing a modal choice has nowhere to
# put a pasted prompt and drops it, then reads the Enter as "choose the
# highlighted option". So typing here would ANSWER the dialog, usually with
# whatever says yes. A dialog is the footer present AND the input box absent:
# the footer alone also matches a worker whose transcript merely quotes the
# string, which wedged hive itself for a whole release (issue #27, decision D5).
#
# 18 to match src/tmux.ts's own tailCaptureLines() exactly - see
# capture_trimmed's own comment for why the WINDOW, not just this number,
# has to match.
#
# TODO 399: this is now hive's own paneAwaitingChoice, called through
# pane_says (above), rather than a transcription of it. The `18` this comment
# used to have to justify lives inside src/tmux.ts now and cannot drift from
# it. UNKNOWN is NOT a dialog here - an unanswerable probe already means the
# pane could not be read, and refusal 1 above has by then either refused or
# confirmed this pane is claude; treating unknown as "waiting on a choice"
# would refuse every restart on a machine whose dist/ is mid-build, which is
# the ordinary state right after the `npm run build` that motivates a restart.
awaiting_choice() {
  pane_says dialog "$1"
  [ $? = 0 ]
}

# Same guard as refusal 1: nothing to check on the skip-the-kill path.
if [ -n "$PANE" ] && awaiting_choice "$PANE"; then
  refuse "pane $PANE is waiting on a choice; typing into it would answer the prompt"
fi

# REFUSAL 4. hive.yml's `lead:` command must already be TRUSTED for its
# CURRENT config, or the detached restart silently downgrades it. ensureTrusted
# (src/cli.ts) returns false with NO PROMPT when stdin/stdout is not a TTY -
# true of the detached re-exec below - and `hive lead` then falls back to
# plain `claude` (src/cli.ts:615-617): no --model, no posture flag if that
# moved with it. Trust is keyed by a hash of the command, so the FIRST
# restart after ANY edit to hive.yml's `lead:` line takes that fallback
# silently - exit 0, "restart complete", nothing on screen, and the lead
# believes it is itself.
#
# An earlier version of this refusal extracted the `lead:` line with a
# single-line regex instead of real YAML parsing, and counselors round 2
# found it wrong in both directions: a `lead:` line elsewhere in an
# otherwise-BROKEN hive.yml (say, `processes: [`) still matched the regex
# and passed, while loadProjectYml rejects the WHOLE document and `hive
# lead` falls back to plain claude regardless - a preflight that says the
# downgrade cannot happen, on the exact document where it does. And genuine
# YAML the regex cannot see (`"lead": ...`, an indented root key) let an
# UNTRUSTED command sail through.
#
# So this now runs the SAME parser `hive lead` itself runs - loadProjectYml
# and configHash from THIS repo's own dist/projectYml.js (sibling of this
# script's scripts/ directory: the checkout that ships this script is the
# one whose parsing code is being trusted, not necessarily whatever `hive`
# happens to resolve to on PATH) - rather than a second, approximate
# reimplementation. Every branch fails closed: no node, or dist/ missing or
# unloadable (a build in progress, or none run yet), means "cannot verify
# trust", never "assume trusted"; hive.yml existing but failing to PARSE
# means "hive lead would silently downgrade on this exact file", not
# "nothing to check". Only "no hive.yml" and "hive.yml parses but has no
# lead: key" are genuinely nothing to trust-check - those are the same
# cases `hive lead` itself takes the default-claude path for, no prompt
# needed.
DIST_PROJECTYML="$SCRIPT_DIR/../dist/projectYml.js"
if [ -f "$PROJECT_PATH/hive.yml" ]; then
  command -v node >/dev/null || refuse "hive.yml exists but node is not on PATH to check whether its lead: command is trusted; put node on PATH, or run 'hive lead' interactively once, before restarting unattended"
  [ -f "$DIST_PROJECTYML" ] || refuse "cannot verify hive.yml's trust: $DIST_PROJECTYML is missing (dist/ not built, or a build is in progress) - run 'npm run build', or wait for the current one to finish, before restarting unattended"
  TRUST_CHECK=$(RL_PROJECT_PATH="$PROJECT_PATH" RL_DIST_PROJECTYML="$DIST_PROJECTYML" node -e '
    const { loadProjectYml, configHash } = require(process.env.RL_DIST_PROJECTYML);
    const { config } = loadProjectYml(process.env.RL_PROJECT_PATH);
    if (!config) { process.stdout.write("PARSE_ERROR"); process.exit(0); }
    if (!config.lead) { process.stdout.write("NO_LEAD"); process.exit(0); }
    process.stdout.write("LEAD:" + configHash("lead", config.lead, null, {}));
  ' 2>&1)
  NODE_STATUS=$?
  [ "$NODE_STATUS" = "0" ] || refuse "could not verify hive.yml's trust (node exited $NODE_STATUS: $TRUST_CHECK); run 'hive lead' interactively once to check it by hand before restarting unattended"
  case "$TRUST_CHECK" in
    NO_LEAD) ;;
    PARSE_ERROR)
      refuse "hive.yml exists but failed to parse; hive lead would silently fall back to plain claude on this exact file - fix hive.yml, or run 'hive lead' interactively once to see the real error, before restarting unattended"
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

# The normal case: the lead runs this in the pane it is about to kill, so
# respawn-pane would kill this script mid-flight. Re-exec detached and let the
# parent die with the pane.
#
# HIVE_RESTART_DETACHED is load-bearing, not decoration. The child inherits
# TMUX_PANE from this process, so a re-exec guarded only on
# "$TMUX_PANE" = "$PANE" re-enters this branch, forks again, and forks forever:
# a fork bomb, from a script whose whole job is to be run unattended from a
# phone. The sentinel is what makes the recursion terminate.
#
# Guarded on PANE being set too, not just on TMUX_PANE matching it: with no
# live pane to kill (PANE=""), an unset TMUX_PANE would otherwise satisfy
# "" = "" and re-exec for no reason at all.
if [ -n "$PANE" ] && [ "${TMUX_PANE:-}" = "$PANE" ] && [ -z "${HIVE_RESTART_DETACHED:-}" ]; then
  say "launched from the target pane; re-execing detached and exiting"
  ARGS=(--delay "$DELAY")
  [ "$FORCE" = "1" ] && ARGS+=(--force)
  HIVE_RESTART_DETACHED=1 nohup "$0" "${ARGS[@]}" >/dev/null 2>&1 &
  disown 2>/dev/null || true
  exit 0
fi

# The placeholder below protects the SESSION across a KILL. With no live
# pane to kill (the skip-the-kill path - no running kind='lead' row, or its
# row's pane is already dead), nothing here puts the session at risk, so
# neither the delay nor the placeholder applies; go straight to `hive lead`.
#
# NO EXIT TRAP on this. An earlier version removed the placeholder on any
# exit, reasoning "a forced failure cannot leave it behind" - backwards: a
# failure AFTER the kill is exactly when the placeholder is still doing its
# job, and in the single-pane/single-window case it is the ONLY thing
# keeping the session alive for a human to walk up to and check by hand.
# Removing it on a `gone()` path destroys the session at the moment
# recovery needs it most. It is now removed in exactly one place, explicitly,
# after a successful handoff - never on any failure path. A stray,
# obviously-named placeholder window left behind after a failed restart is a
# SIGNAL, not litter; do not "clean it up" by adding the trap back.
PLACEHOLDER=""
remove_placeholder() {
  [ -n "$PLACEHOLDER" ] || return 0
  tmux kill-window -t "$PLACEHOLDER" 2>/dev/null || true
  PLACEHOLDER=""
}

if [ -n "$PANE" ]; then
  # Give the old session a moment to finish whatever it was flushing, and
  # give a human on a phone a moment to see the restart start before the
  # pane goes.
  if [ "$DELAY" -gt 0 ]; then
    say "waiting ${DELAY}s before killing the pane"
    sleep "$DELAY"
  fi

  # Zero workers is the state refusal 2 REQUIRES, and this repo's own
  # hive.yml `processes:` block is empty, so in the ordinary success case
  # the lead's pane is the ONLY pane in the ONLY window. `tmux kill-pane`
  # then destroys the window, and tmux destroys the SESSION along with it -
  # dropping any attached client (the human's iTerm -CC window closes, or
  # jumps to another project's session and stays there), even though
  # `hive lead` recreates the session fine moments later. `respawn-pane -k`
  # never paid this cost, because it replaces a pane in place - that does
  # not make it right (both counselors seats confirmed the silent-reuse
  # mechanism kill-then-run exists to avoid, see the comment on `hive lead`
  # below); it is a cost this shape has to pay instead.
  #
  # A throwaway window held open across the gap pays it: as long as some
  # OTHER window exists in the session when the lead's own window dies with
  # its pane, the session survives, and tmux switches an attached client to
  # it rather than dropping the client outright. Named distinctively; it
  # carries no agents row, so `hive status`'s janitor has nothing here to
  # sweep. Removed explicitly, once, after a successful handoff (see the
  # comment above PLACEHOLDER's declaration for why not on any failure path).
  #
  # A creation failure here is knowable BEFORE the kill, and it is the only
  # thing standing between the kill and losing the session outright in the
  # single-pane/single-window case - this used to be a warning that killed
  # the pane anyway. REFUSED, not gone(): nothing has been touched yet.
  PLACEHOLDER=$(tmux new-window -d -P -F '#{window_id}' -t "=$SESSION" -n "restart-lead-placeholder-$$" 2>/dev/null) || PLACEHOLDER=""
  [ -n "$PLACEHOLDER" ] || refuse "could not create a placeholder window to protect the session across the kill; refusing to kill $PANE without it"

  say "killing $PANE"
  # A failed kill here must not fall through to `hive lead` below: a still-live
  # $PANE is exactly the condition that makes cmdLead take the silent reuse
  # branch (see the comment on the next line), so a failure here has to stop
  # the script rather than continue into that trap.
  tmux kill-pane -t "$PANE" || gone "kill-pane failed; $PANE may still be live, in an unknown state - check it by hand before touching this lead again"
else
  say "no live pane to kill; skipping straight to hive lead"
fi

# `hive lead` is what a bare respawn used to skip: it builds the full env
# (--settings, --append-system-prompt-file, HIVE_LEAD, HIVE_AGENT_ID,
# HIVE_DATA_DIR - src/cli.ts:699-706), CAS-updates the agents row's
# tmux_target, and re-points every pending lead-owned wake's deliver_pane at
# whatever pane it creates. Respawning `hive lead` INTO a still-live pane
# instead of killing it first would be silently wrong: cmdLead's
# existing-session branch treats a still-live previousTarget as proof the
# lead survived, reuses the pane, launches no claude at all, and returns -
# leaving a pane with nothing in it. Killing the pane first is what forces
# the split-window/new-window branch that actually launches claude. On the
# skip-the-kill path there is no still-live previousTarget to trap on - the
# row already names a dead pane, or there is no row at all - so cmdLead's
# own stillThere check takes that same split-window/new-window branch on
# its own; nothing here needs to force it.
#
# Clear the HIVE_* identity this process inherited from the pane it came
# from before invoking: a `hive` CLI call carrying a worker-shaped identity
# (HIVE_LEAD=1, HIVE_AGENT_ID=lead:N) into `hive lead` is exactly the class of
# bug this project has been bitten by before, even though ensureLeadRow does
# not currently read either. HIVE_DATA_DIR is NOT cleared: pointing the
# restart at the same store the caller used is correct.
#
# --no-dashboard (todo 356): this script's own `hive lead` and a human's are
# now the identical dispatch (bare `hive` defaults to "lead"), so without
# this flag a restart would pop a browser window on the human's desktop -
# exactly the class of bug todo 355 closed for auto-attach, reached through
# the lead restart path instead. Explicit rather than inferred from any
# ambient signal (a TTY check would not distinguish this pane, which is a
# real tty, from a human's), so it is visible right here rather than implied.
# cmdAttach's own kv TTL marker is a second, independent guard behind this
# one - see maybeOpenDashboard's comment in src/cli.ts - not a reason to
# drop this flag.
say "running: hive lead $REPO --no-dashboard"
env -u HIVE_AGENT_ID -u HIVE_LEAD -u HIVE_AGENT_NAME hive lead "$REPO" --no-dashboard ||
  gone "hive lead failed; check by hand"

# `hive lead` should have created or reused a live pane - re-resolve from
# the store rather than polling any old id, which would time out even on a
# perfect restart.
resolve_lead_pane
[ -n "$PANE" ] || gone "hive lead ran but left no running, live kind='lead' pane for project $PROJECT_ID - check by hand"
say "new lead pane: $PANE (running: $PANE_CMD; session: $SESSION; resolved via: store, project $PROJECT_ID's running kind='lead' row)"

# The placeholder is NOT dropped here. A live lead pane existing is not the
# same as a WORKING one: if claude fails to start (a bad trusted `lead:`
# command, a missing binary in the tmux server's own env, a crash right
# after launch), the pane below dies, its window dies with it, and in the
# single-pane/single-window case the placeholder is the only thing standing
# between that and losing the session and dropping the attached client - the
# exact harm it exists to prevent, during the window where it is most
# likely. It is removed in exactly one place: after the handoff is
# confirmed sent, at the very end of this script.

# Wait for claude to take the terminal. Keystrokes sent before it does are
# swallowed silently and tmux reports success, so this poll is the difference
# between a handoff and a prompt that never existed. Note the marker: the OLD
# readiness regex went stale against claude 2.1.220 and every hive spawn
# silently stopped announcing for days (issue #30). Do not shorten this to a
# fixed sleep. capture_trimmed rather than a bare capture-pane, for the same
# window-mismatch reason awaiting_choice uses it - this pane is freshly
# spawned so there is little real transcript for a stray match to hide in
# yet, but there is no reason to leave one of the two readers inconsistent
# with the other now that the mismatch is understood.
say "waiting up to ${READY_TIMEOUT}s for the input box"
READY=0
for _ in $(seq 1 $((READY_TIMEOUT * 2))); do
  if pane_says input-box "$PANE"; then
    READY=1
    break
  fi
  sleep 0.5
done

# Past the kill, so this is gone() territory (107a1c4), not a plain exit 1:
# `say` only reaches stdout under a tty, and the production run is detached
# under `nohup ... >/dev/null 2>&1`, so a bare `exit 1` here used to leave a
# real, unattended run having written nothing anywhere but the log - the
# exact defect refuse()'s own header comment says was fixed, left unfixed on
# the two paths where it is most likely to fire.
[ "$READY" = "1" ] || gone "pane never became ready; claude may be up but unprompted - check it by hand"

# Claude is up. It may be showing the folder-trust dialog rather than an input
# box on a cwd it does not know, so check again before typing: refusal 3 above
# applies to this moment too, not only to the pre-restart pane.
sleep 1
if awaiting_choice "$PANE"; then
  gone "restarted pane is on a choice dialog; NOT sending the prompt - answer it by hand, then prompt it"
fi

# READ THE FIELD BACK, right before typing, rather than trusting the value
# resolve_lead_pane returned a whole readiness poll ago. With the window scan
# gone, resolve_lead_pane's own PANE is always exactly what the store said AT
# THE MOMENT it was called - there is no fallback path left that could hand
# back a pane the store disagrees with. So a mismatch here can only mean
# TIME: another process (a stale scheduler, a second concurrent restart)
# changed the row's tmux_target in the gap between that call and now, up to
# ~45s of readiness polling later (counselors round 2, codex P1 5's
# interleaving). That is genuinely wrong, not something to type through -
# typing a lead's only handoff into a pane the store no longer considers the
# lead was the exact hole this read-back exists to close; the old DEGRADED
# path answered "the store disagrees" by typing anyway, which answered it
# backwards. A mismatch is now a hard failure.
STORE_PANE=$(db_query "select tmux_target from agents where project_id = $PROJECT_ID and kind = 'lead' and status = 'running' order by id limit 1;")
[ "$STORE_PANE" = "$PANE" ] || gone "about to type into $PANE, but the store's lead row now names '${STORE_PANE:-<none>}' - refusing to type a handoff into a pane the store no longer considers the lead; check by hand"

# Generic on purpose. The store is the handoff: the board's DO THIS FIRST line
# is the previous lead's last instruction, and hive's SessionStart hook has
# already injected the top of it.
PROMPT='Follow the standing process: run `hive runbook`, then pad_read(name="board") and read it IN FULL, then continue from its DO THIS FIRST. This session was restarted automatically by scripts/restart-lead.sh, so nothing was handed to you in conversation and the store is the only handoff. Anything outward-facing still waits for the human.'

# Both send-keys calls are now checked. Neither was before, and this script
# does not run under `set -e`: if claude exited in the gap between the
# readiness capture above and here, both would have failed silently, `say`
# still returns 0 either way, and the old code logged "restart complete" over
# a lead that never got its handoff at all.
tmux send-keys -t "$PANE" -l "$PROMPT" || gone "send-keys (prompt) failed against $PANE after the kill; the new lead may be up with no handoff typed - check it by hand"
sleep 0.3
tmux send-keys -t "$PANE" Enter || gone "send-keys (Enter) failed against $PANE after the kill; the prompt is pasted but not submitted - check it by hand"

# The ONE place the placeholder is removed: the handoff is confirmed sent,
# so the session no longer needs it and there is nothing left to fail.
remove_placeholder
say "prompt sent; restart complete"
