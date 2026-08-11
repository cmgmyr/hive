#!/usr/bin/env node
// hive CLI: open a project's orchestration session and manage its commands.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { checkAbi, describeAbi, describeInterpreter, nodeRangeForNodeApi, requiredNodeApi } from "./abi.js";
import { claudeConfigDir } from "./claudeDir.js";
import {
  ATTACH_MODES,
  AUTO_ATTACH_MODES,
  attachMode,
  AttachMode,
  AutoAttach,
  isAttachMode,
  isAutoAttach,
  resolvedAttachMode,
  resolvedAutoAttach,
  setAttachMode,
  setAutoAttach,
} from "./config.js";
import {
  cliPath,
  dispatcherDir,
  dispatcherPath,
  dispatcherScript,
  durabilityLines,
  firstHiveOnPath,
  pathAdvice,
  readDispatcher,
} from "./dispatcher.js";
import {
  hiveRegistrations,
  registrationOffer,
  registrationProblem,
  type McpRegistration,
} from "./mcpConfig.js";
import { DEFAULT_DATA_DIR } from "./dataDir.js";
import { dataDir, db, migrate } from "./db.js";
import { isLowHeadroom, ptyHeadroom } from "./ptys.js";
import {
  agentProjectPin,
  currentActor,
  effectiveProjectId,
  findProjectForCwd,
  getProject,
  listProjects,
  takeRegistrationNotice,
  type Project,
} from "./context.js";
import { ensureHooksFile } from "./hooks.js";
import { errorMessage, registrationNoticeText, withTrailingNewline } from "./result.js";
import { ACTIVE_TIMER_WHERE, janitor } from "./scheduler.js";
import {
  probeSessionInterpreter,
  reexecTarget,
  type ReexecTarget,
  sessionStartVerdict,
} from "./sessionProbe.js";
import {
  backupHealth,
  backupNow,
  backupsDir,
  formatBytes,
  listSnapshots,
  previewRestore,
  restoreSnapshot,
  totalSizeBytes,
} from "./backup.js";
import {
  asNameClash,
  buildEnvFlags,
  closeAgentRow,
  isReservedAgentName,
  launchAgent,
  LEAD_KIND,
  LEAD_NAME,
  mintLeadActorId,
  upsertActor,
  withWindowClaim,
} from "./spawn.js";
import {
  adoptableWindow,
  claimInitialWindow,
  configureHiveWindow,
  controlModeFor,
  createWindow,
  describePaneChoice,
  ensureSession,
  findProjectWindow,
  foreignSocket,
  inputBoxState,
  isPaneTarget,
  isViewSessionName,
  listOwnedWindows,
  paneChoiceCheck,
  panePid,
  RAW_ATTACH_TMUX_CONFIG,
  renderAttachCommand,
  resolveAttachTarget,
  resolveInTmuxTarget,
  paneReissued,
  rowLive,
  rowLiveProbe,
  SESSION_PREFIX,
  sessionName,
  shellQuote,
  tmux,
  TMUX_DOC,
  tmuxSaysNothingThere,
  tmuxSocketPath,
  untrustedTmuxServer,
} from "./tmux.js";
import {
  activeProfile,
  configHash,
  loadProjectYml,
  NO_PROFILE,
  resolveCommandDir,
  type YmlProcess,
} from "./projectYml.js";
import { isClaudeCommand, writeProjectPosture } from "./brief.js";
import {
  deriveProvenance,
  describeForHuman,
  describeLastLogEvent,
  lastLogEvent,
  reportsAgentStateLog,
  type ProvenanceRow,
} from "./stateProvenance.js";
import {
  checkoutRoot,
  createProfile,
  forkProfile,
  PROFILE_FILES,
  ProfileError,
  profileExists,
  profileNames,
  profileStatus,
  readProfileFile,
  renderProfileFile,
  resolveProfileFile,
  REWRITE_THRESHOLD,
  templateVars,
  userProfilesDir,
  type ProfileFile,
  type ProfileFileStatus,
} from "./profiles.js";
import {
  getTodoDetail,
  listTodoSummaries,
  OPEN_BLOCKERS_SQL,
  TODO_STATUSES,
  type TodoDetail,
} from "./tools/todos.js";
import {
  createPad,
  getActivePadByName,
  listActivePads,
  overwritePadContent,
} from "./tools/pads.js";

function usage(): never {
  console.log(`hive — shared memory and coordination for Claude Code sessions

Usage:
  hive [path]                open the project's session with a lead window
  hive lead [path]           same; lead is the default command
  hive init [path] [--profile <name>|--no-profile]
                             set the project up: hive.yml, profile, starter pads
  hive attach [path]         attach without adding windows
  hive start <process> [path] start one hive.yml process by name
  hive status                overview of agents, todos, and wake-ups everywhere
  hive setup [--dir <dir>]   write a \`hive\` that runs the interpreter this build
                             was compiled for; re-run after every update
  hive setup --attach <mode> auto|raw|control: whether tmux attaches carry -CC
  hive doctor [--strict]     check the environment and clean up stale state;
                             --strict also exits non-zero on warnings that mean
                             this install is wrong (dispatcher, registration, ABI)
  hive pads                  list the current project's pads
  hive pad <name>            print a pad's content
  hive pad <name> --edit     export to a temp file and open your markdown editor
  hive pad <name> --save     write the edited export back (revision-guarded)
  hive todos [--all] [--status <s>] [--tag <t>]
                             list this project's todos; open work by default
  hive todo <id>             print one todo in full, comments included
  hive backups               list automatic store snapshots
  hive restore <name> [--yes] [--force]  overwrite the live store from a snapshot
  hive runbook               this project's standing process, vars resolved
  hive posture               the posture text this project's lead starts with
  hive kickoff [--explain]   SessionStart hook output; silent unless this is a lead checkout
  hive profile [list|path|fork|create]  standing instructions shared across projects
  hive statusline            one-line store summary; silent outside hive projects

hive lead reads hive.yml from the project root when present; hive init
writes this starter file (uncomment what you need):

${HIVE_YML_TEMPLATE.trimEnd().replace(/^/gm, "  ")}

Repo-defined commands run only after a one-time interactive approval; any
change to a command re-requires it. By default (attach mode auto), lead/attach
use iTerm's control mode: the lead, workers, and commands all appear as native
windows and panes. hive setup --attach raw switches to a plain tmux attach;
raw mode works without tmux config; one global notification setting is recommended
for Claude Code panes hive did not create (see docs/tmux.md).`);
  process.exit(1);
}

// An explicit path argument gets the SAME treatment a locked session's
// explicit numeric project_id already gets from assertAccessible: refused
// under HIVE_PROJECT_LOCK=1 when it disagrees with the pin, never silently
// honoured and never silently overridden by the pin either. Before this fix,
// the pin (consulted first inside resolveHomeProject) silently outranked the
// chdir above - `hive init ~/other-repo` run from a pinned pane seeded
// ~/other-repo's hive.yml into the PINNED project instead, with no error at
// all. A path argument is just another way to name a target project;
// letting it bypass the lock while an equivalent numeric project_id cannot
// would make the lock optional depending on which parameter shape a caller
// happens to use, not a real safety boundary.
//
// This does not piggyback on effectiveProjectId's override param (which
// already routes a numeric id through assertAccessible): that path requires
// the project to already exist, so an unregistered directory would have to
// be registered FIRST to reach the check, and register-then-refuse would
// manufacture exactly the junk project row finding 1's fix exists to stop
// creating - refuse first, register nothing, on the same branch.
// effectiveProjectId() can trigger resolveHomeProject's silent registration
// fallback (src/context.ts), same as the MCP tool layer, but run()'s notice
// (src/result.ts) only wraps that layer - the CLI has no equivalent choke
// point, so this is it. Both call sites below route through here rather than
// calling getProject(effectiveProjectId())! directly, the same reasoning as
// run() itself: one place, not one per command, so a future resolveProject
// caller inherits the notice for free instead of needing to remember it.
// onNotice lets a caller defer WHEN the notice is printed without changing
// WHAT gets printed or that it prints on stderr: `hive lead`'s attach scrolls
// the terminal within about a second of this function returning, so printing
// here is invisible in practice (decisions/2026-08-05-cli-notices-go-to-
// stderr.md's sibling problem, not the one that decision fixes). Every other
// caller omits it and keeps today's print-at-resolve-time behaviour
// unchanged - this is the one choke point, so a future resolveProject caller
// still inherits the notice for free without inheriting the deferral.
function resolveProjectAndNotify(id: number, onNotice?: (text: string) => void): Project {
  const project = getProject(id)!;
  const notice = takeRegistrationNotice();
  // stderr, not stdout: this is diagnostic output describing a side effect,
  // not data a command produces. `hive pad lessons > out.md` from an
  // unregistered directory routes through this same function, and stdout is
  // that command's one machine-readable output - a notice on stdout would
  // land inside the redirected file, ahead of the pad content it is meant to
  // capture. A human still sees this printed to their terminal either way;
  // a redirect only stops capturing it.
  if (notice) {
    const text = registrationNoticeText(notice);
    if (onNotice) onNotice(text);
    else console.error(text);
  }
  return project;
}

function resolveProject(path?: string, onNotice?: (text: string) => void): Project {
  if (!path) return resolveProjectAndNotify(effectiveProjectId(), onNotice);
  process.chdir(path);
  const pinned = agentProjectPin();
  if (pinned == null) return resolveProjectAndNotify(effectiveProjectId(), onNotice);
  const target = findProjectForCwd();
  if (target != null && target.id === pinned) return target;
  const pinnedProject = getProject(pinned)!;
  throw new Error(
    `This session is locked to project ${pinned} ("${pinnedProject.name}") but "${path}" resolves to ${
      target ? `project ${target.id} ("${target.name}")` : "no registered project"
    }. An explicit path argument cannot escape HIVE_PROJECT_LOCK=1. Unset HIVE_AGENT_ID and HIVE_PROJECT_LOCK in this pane, or open a new one, to act on a different project.`,
  );
}

// cmdStatusline/cmdTodos/cmdTodo's shared entry point: consult the SAME pin
// agent_spawn's own tools honor (src/context.ts's agentProjectPin, reached
// via effectiveProjectId in every other command), falling back to
// findProjectForCwd when there is no pin. MUST NEVER REGISTER - unlike
// resolveProject above, whose effectiveProjectId can register a project as a
// side effect, these three commands are deliberately silent outside a hive
// project (D5, see the comment on cmdTodos) rather than creating one merely
// because they were run in some directory. agentProjectPin only reads the
// agents/projects tables and findProjectForCwd is already non-registering
// (its own doc comment in context.ts), so this preserves that contract.
function pinnedOrCwdProject(): Project | null {
  const pinned = agentProjectPin();
  if (pinned != null) return getProject(pinned) ?? null;
  return findProjectForCwd();
}

// A yes/no prompt that never hangs on a stream nothing will answer: readline's
// question() does not resolve on its own against an already-closed/non-TTY
// stdin (see cmdRestore below for what that costs), so every confirm in this
// file checks isTTY before ever constructing a readline interface. Returns
// null, not false, when there is no TTY to ask on, so a caller can print its
// own contextual refusal instead of a generic one.
async function confirmYesNo(question: string): Promise<boolean | null> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return null;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(question);
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

async function ensureTrusted(
  projectId: number,
  name: string,
  command: string,
  dir: string | null,
  env: Record<string, string>,
): Promise<boolean> {
  const hash = configHash(name, command, dir, env);
  const trusted = db
    .prepare("SELECT 1 FROM command_trust WHERE project_id = ? AND name = ? AND config_hash = ?")
    .get(projectId, name, hash);
  if (trusted) return true;
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.log(`! "${name}" is not trusted yet; run hive interactively to review it.`);
    return false;
  }
  console.log(`\nhive.yml defines "${name}":`);
  console.log(`  command: ${command}`);
  if (dir) console.log(`  dir: ${dir}`);
  if (Object.keys(env).length > 0) console.log(`  env: ${JSON.stringify(env)}`);
  if (!(await confirmYesNo("Trust and run this command from now on? [y/N] "))) {
    console.log(`Skipped "${name}".`);
    return false;
  }
  db.prepare(
    "INSERT OR IGNORE INTO command_trust (project_id, name, config_hash) VALUES (?, ?, ?)",
  ).run(projectId, name, hash);
  return true;
}

function startYmlCommand(project: Project, name: string, proc: YmlProcess): string {
  // Issue #27's L4 fix round, DECISION 7c, the hive.yml half. This lookup
  // carries no kind filter, so a process literally named "lead" would
  // otherwise match the REAL lead's own running row here and report "already
  // running" without ever starting anything - and if no lead happened to be
  // running yet, launchAgent below would take the name outright, so the next
  // `hive lead` collides on idx_agents_running_name the same way agent_spawn
  // used to (requireNameFree, src/tools/agents.ts). Refused before either
  // can happen.
  if (isReservedAgentName(name)) {
    return `skipped: "lead" is reserved for this project's lead session and cannot be used as a process name`;
  }
  const existing = db
    .prepare("SELECT id, tmux_target, tmux_socket FROM agents WHERE project_id = ? AND name = ? AND status = 'running'")
    .get(project.id, name) as { id: number; tmux_target: string; tmux_socket: string } | undefined;
  if (existing) {
    // Issue #73, D6: a foreign socket reads unknown here the same way an
    // unanswered probe already does, below - never as "already running" and
    // never as grounds to start a second copy either.
    const live = rowLive(existing.tmux_socket, existing.tmux_target);
    if (live) return "already running";
    // Unknown liveness must not start a second copy. These are hive.yml
    // processes, so a duplicate is a second dev server fighting for the port
    // while the first one's row is closed and nothing tracks it any more.
    // That is a write to the world, not just to the store.
    if (live === null) return "skipped: tmux could not be probed, so hive cannot tell whether it is already running";
    closeAgentRow(existing.id);
  }
  let dir: string;
  try {
    dir = resolveCommandDir(project.path, proc.dir);
  } catch (e) {
    return `skipped: ${errorMessage(e)}`;
  }
  try {
    launchAgent({
      projectId: project.id,
      projectName: project.name,
      projectPath: project.path,
      name,
      kind: "command",
      commandString: proc.command,
      cwd: dir,
      env: proc.env,
      placement: "window",
      parentActor: currentActor(),
    });
    return "started";
  } catch (e) {
    return `failed: ${errorMessage(e)}`;
  }
}

// A worker's window is stamped, cosmetic-only-by-name (decisions/2026-08-05-
// tmux-topology-windows-not-sessions.md).
//
// The sentence that used to sit here - "the caller is already IN the session
// this pane belongs to" - was FALSE from the commit that added view sessions
// (todo 279, counselors codex #3 and opus #1). A pane belongs to a window,
// and once a view session is grouped with the base, the human looking at that
// pane is in the VIEW. Both branches below now resolve who is actually
// asking rather than assuming; switch-client is back too, for the caller in
// an unrelated tmux session that one session per store did not remove.
// `window` is the caller's own answer to which window to land on, for a
// caller that already knows one this lookup would get wrong: cmdLead's
// adopted-pane branch (todo 276), where the lead's pane is live in a window
// that is NOT the one carrying this project's stamp. Every other caller omits
// it and the stamp lookup stands.
function attach(session: string, project: Project, window?: string): void {
  if (process.env.TMUX) {
    // resolveInTmuxTarget (src/tmux.ts) qualifies the window with the
    // CALLER's own session rather than the base session's name, and carries
    // why: the one-line version this replaced moved the BASE session's
    // current window, so a caller inside a view session yanked the OTHER
    // terminal and did not move itself (todo 279).
    const argv = resolveInTmuxTarget(session, window ?? findProjectWindow(session, project.id));
    if (argv) spawnSync("tmux", argv, { stdio: "inherit" });
    return;
  }
  const controlMode = controlModeFor(process.env.TERM_PROGRAM === "iTerm.app");
  // resolveAttachTarget (src/tmux.ts) decides plain attach vs. a view
  // session AND selects the project's window, with every tmux mutation
  // folded into the returned argv rather than performed as a side effect -
  // this is the ONE source both branches below read from, so the two can
  // never drift the way pad 71 opened on ("two pieces of hive's own advice
  // pointing opposite ways, neither citing the other").
  const argv = resolveAttachTarget(session, project.id, controlMode, window);
  if (!process.stdout.isTTY) {
    console.log(`Session ${session} is ready for project "${project.name}" (${project.path}).`);
    console.log(`Attach from a terminal with: tmux ${renderAttachCommand(argv)}`);
    return;
  }
  const result = spawnSync("tmux", argv, { stdio: "inherit" });
  process.exit(result.status ?? 0);
}

// The lead's own identity, so hive has one identity mechanism (an agents row)
// instead of two: HIVE_AGENT_ID for workers and nothing at all for the lead.
// kind='lead' needs no migration - agents.kind carries no CHECK constraint -
// and idx_agents_running_name already enforces one running "lead" row per
// project, the same index that stops two workers racing for a name.
//
// REUSE ON RESTART IS THE POINT, not an optimisation. A restarted lead is the
// SAME lead; minting lead:5, lead:6, lead:7 across restarts would fragment one
// seat's identity across agent_state_log and every pad/todo write it makes as
// itself. So this looks up the running row for (project_id, "lead") first and
// reuses its actor_id rather than inserting unconditionally.
//
// FIXED (was a NAMED RISK): src/scheduler.ts's janitor now skips kind='lead'
// in its agent sweep, so a reused row's stale created_at (from its ORIGINAL
// insert, not this restart) can no longer cost it SETTLE_WINDOW's grace and
// get it swept between an external restart script killing the lead's old
// pane and this function recording the new one.
//
// That alone is not enough, because every ALREADY-RUNNING MCP server in
// another session keeps running the PRE-FIX janitor (no kind filter) until
// its own session restarts, and a kind filter added here cannot reach them.
// So identity has to survive the row being closed by someone else, not
// merely avoid being closed: when no RUNNING lead row exists, look for the
// most recent CLOSED kind='lead' row for this project and, if it has a
// non-empty actor_id, give the new row THAT actor_id instead of minting
// lead:<newRowId>. Skip rows with actor_id = '' - a row left behind by a
// process that died between the INSERT and the actor_id UPDATE below (see
// DECISION 6, not yet fixed) is not a real prior identity to inherit.
//
// actor_id is opaque to every consumer (agent_state_log, pads, todos all key
// on it as an unstructured string), so lead:5 living on agents row 9 is
// correct, not a bug to "fix" on sight.
//
// Accepted consequence, stated here rather than left implicit: a lead row
// now stays status='running' after its own session ends, until the next
// `hive lead` re-records a live pane on it. `hive doctor` reports a lead
// whose pane is not live rather than the janitor silently sweeping it.
//
// Issue #27's L4 fix round R8, todo 175 item 1. Named separately from
// asNameClash (src/spawn.ts) rather than reusing its LEAD_NAME branch: that
// branch's "another `hive lead` won the race" is correct for the INSERT
// door (two `hive lead`s racing past the running-row lookup), but wrong
// advice here, where the collision is a WORKER holding the name, not a
// peer lead. Looks up who actually holds it so the message names a fixable
// cause instead of a plausible-but-wrong one.
function asLeadNameReuseClash(e: unknown, projectId: number, leadRowId: number): unknown {
  const err = e as { code?: string; message?: string };
  const message = err.message ?? "";
  if (err.code !== "SQLITE_CONSTRAINT_UNIQUE" || !(message.includes("agents.name") || message.includes("idx_agents_running_name"))) {
    return e;
  }
  // Issue #27's L4 fix round R9, todo 179 item 2 (codex F4). COLLATE NOCASE,
  // matching idx_agents_running_name's own collation: a legacy worker named
  // "Lead" or "LEAD" is exactly who this constraint fires against (the
  // index is case-insensitive), and a plain `name = ?` here would miss it,
  // reporting "could not find which one" instead of naming the culprit.
  const holder = db
    .prepare(
      "SELECT id, kind, actor_id FROM agents WHERE project_id = ? AND name = ? COLLATE NOCASE AND status = 'running' AND id != ?",
    )
    .get(projectId, LEAD_NAME, leadRowId) as { id: number; kind: string; actor_id: string } | undefined;
  if (!holder) {
    return new Error(
      'Cannot reclaim the name "lead": another running row already holds it, but a second look could not find ' +
        "which one. Re-run `hive lead`.",
    );
  }
  return new Error(
    `Cannot reclaim the name "lead": a running ${holder.kind} (actor ${holder.actor_id}, agents.id ${holder.id}) ` +
      `already holds it. Rename or close that ${holder.kind} first, then re-run \`hive lead\`.`,
  );
}

// previousTarget is the row's tmux_target as it stood BEFORE this call, "" for
// a brand new row. cmdLead uses it to tell a surviving lead pane from a
// surviving window that just lost its lead (DECISION 2).
//
// Issue #27's L4 fix round R10, todo 181 item 2 (BOTH SEATS, opus's fix).
// casExpected is a SEPARATE value from previousTarget, added because one
// value used to do both jobs and they are not the same job. previousTarget
// answers "what pane did this identity last have", which stillThere below
// needs even when it names a pane from a previous tmux generation. casExpected
// answers "what does the tmux_target COLUMN actually hold right now", which
// the CAS a few lines below cmdLead needs exactly - and for a fresh INSERT
// those two answers now differ: the column is seeded "" (see the INSERT
// below), never the closed row's stale pane, so a crash between this INSERT
// and the CAS leaves the row advertising tmux_target='' - which todo 180
// made a universal "not live" - rather than a pane id from a previous tmux
// generation that this invocation never confirmed and that the CURRENT
// generation may have already reissued to someone else.
function ensureLeadRow(
  project: Project,
  command: string,
): {
  agentId: number;
  actorId: string;
  previousTarget: string;
  previousSocket: string;
  previousPanePid: string;
  casExpected: string;
} {
  // Keyed on kind='lead' + running, not on name (issue #27's L4 fix round,
  // DECISION 5). Keying on name too would only give a rename somewhere to
  // hide behind - and agent_rename now refuses a lead target outright
  // (DECISION 4), so this is defence in depth for a path that should
  // already be unreachable, not a guard against one that still is.
  //
  // Issue #27's L4 fix round R9, todo 179 item 4 (opus F5). This used to
  // claim idx_agents_running_name "enforces at most one running row named
  // lead per project, so this cannot match two" - true of the NAME, not of
  // kind='lead'. The index constrains (project_id, name), not (project_id,
  // kind), so once a pre-fix agent_rename moves the lead row off "lead" -
  // the exact premise the name reset just above this function's INSERT
  // branch exists to undo - the name "lead" is free again, and an older
  // `hive lead` on that same pre-fix server can INSERT a second running
  // kind='lead' row: nothing here stops it, since idx_agents_running_name
  // has nothing to say about a row named something else. Both would then
  // persist, and .get() with no ORDER BY picks whichever SQLite happens to
  // return first - non-deterministic across otherwise-identical runs. ORDER
  // BY id does not prevent the double row (that needs a kind-scoped unique
  // index, a bigger change than this comment fix); it only makes which one
  // this function acts on deterministic rather than accidental.
  const existing = db
    .prepare(
      "SELECT id, actor_id, tmux_target, tmux_socket, pane_pid FROM agents WHERE project_id = ? AND kind = ? AND status = 'running' ORDER BY id",
    )
    .get(project.id, LEAD_KIND) as
    | { id: number; actor_id: string; tmux_target: string; tmux_socket: string; pane_pid: string }
    | undefined;
  // One reuse branch for a found running row, healing two independent kinds
  // of damage another process or version may have left on it - merged from
  // two near-identical branches in /simplify, since both ran the identical
  // "UPDATE command plus one other column, then upsertActor" transaction and
  // differed only in which column and where its value came from.
  //
  // DECISION 6. actor_id = '' names a row an earlier `hive lead` process
  // left behind after dying between its INSERT and the actor_id UPDATE
  // further down - before that fix, a three-write sequence with a real gap
  // in the middle. A lookup that treated this row as a normal hit would
  // launch the lead with HIVE_AGENT_ID= (empty), and the hook then writes
  // neither a state log row nor last_seen_at for it. Treating it as a plain
  // MISS is not enough either: it is still the running "lead" row,
  // idx_agents_running_name still holds its name, and an INSERT below would
  // hit SQLITE_CONSTRAINT_UNIQUE and surface asNameClash's generic "already
  // exists, pick another name" - true of the row, useless as advice, since
  // "lead" is not a name this caller chose. So a damaged actor_id is healed
  // in place rather than left as a miss: `existing.actor_id || mintLeadActorId(...)`
  // mints only when the column is empty, keeps it unchanged otherwise.
  //
  // Issue #27's L4 fix round R6, todo 170 (counselors codex F5). An
  // already-running pre-41bbd77 MCP server (agent_rename did not yet refuse
  // a lead target) can still execute its old agent_rename against this row -
  // found by kind, addressed by whatever name it currently carries, same
  // shape as the actor_id-reuse gap decision 3 closes for other
  // already-running pre-fix servers. Reset the name back to LEAD_NAME on
  // EVERY reuse (not only the healed-actor_id case), the same "identity
  // survives what another version did to the row" argument decision 2
  // already rests on: otherwise a rename strands the canonical "lead" handle
  // every wake, pad and todo comment addresses this row by, and the NEXT
  // `hive lead`'s own running-row lookup (kind='lead' + status='running',
  // not name - DECISION 5) still finds THIS row fine, but nothing else that
  // resolves "lead" by name can reach it any more.
  if (existing) {
    const actorId = existing.actor_id || mintLeadActorId(existing.id);
    // Issue #27's L4 fix round R8, todo 175 item 1 (counselors opus F2,
    // MEDIUM). idx_agents_running_name is UNIQUE(project_id, name COLLATE
    // NOCASE) WHERE status='running', and this UPDATE unconditionally resets
    // name back to LEAD_NAME with no guard of its own - only the INSERT
    // branch below wraps its own constraint hit. This round's own premise is
    // the scenario that trips it: an already-running pre-41bbd77 server
    // renames this row to something else (exactly what todo 170's reset
    // above exists to undo), and a pre-7c agent_spawn on that same old
    // server takes the now-free "lead" name for a worker before this reset
    // runs. asNameClash's own LEAD_NAME branch is the wrong message here -
    // "another `hive lead` won the race" names a peer lead, and the actual
    // holder is a worker - so this looks up who really holds the name.
    try {
      db.transaction(() => {
        db.prepare("UPDATE agents SET command = ?, actor_id = ?, name = ? WHERE id = ?").run(
          command,
          actorId,
          LEAD_NAME,
          existing.id,
        );
        upsertActor(actorId, LEAD_NAME, LEAD_KIND);
      })();
    } catch (e) {
      throw asLeadNameReuseClash(e, project.id, existing.id);
    }
    // casExpected equals previousTarget here, deliberately: this UPDATE never
    // touches tmux_target (only command/actor_id/name), so the column still
    // holds exactly what it held before this call - unlike the fresh-INSERT
    // branch below, where the column is about to be seeded to something the
    // row's own previousTarget does NOT equal. previousSocket is this same
    // row's tmux_socket, similarly untouched by this UPDATE (issue #73) -
    // cmdLead's stillThere check needs it alongside previousTarget to decide
    // whether that PANE, not just this row, is one this process can honestly
    // judge.
    return {
      agentId: existing.id,
      actorId,
      previousTarget: existing.tmux_target,
      previousSocket: existing.tmux_socket,
      previousPanePid: existing.pane_pid,
      casExpected: existing.tmux_target,
    };
  }
  // Issue #27's L4 fix round R9, todo 178 (counselors opus F2, MEDIUM,
  // opus's fix). tmux_target is read here too, not just actor_id, and
  // handed back as previousTarget below instead of "". Read why that
  // matters at the return statement; the short version is that a closed
  // row still knows where its pane was, and throwing that away was the bug.
  const priorClosed = db
    .prepare(
      "SELECT actor_id, tmux_target, tmux_socket, pane_pid FROM agents WHERE project_id = ? AND kind = ? AND status = 'closed' AND actor_id != '' ORDER BY id DESC LIMIT 1",
    )
    .get(project.id, LEAD_KIND) as
    | { actor_id: string; tmux_target: string; tmux_socket: string; pane_pid: string }
    | undefined;
  // The INSERT, its actor_id UPDATE and upsertActor used to be three
  // separate writes, which is exactly the gap this whole comment block is
  // about - one transaction now, so a process dying anywhere in here leaves
  // either nothing or a fully-formed row, never the actor_id = '' state
  // above. Belt and braces, not a substitute for it: a crash mid-fsync
  // inside better-sqlite3's synchronous transaction is not impossible, and
  // that residual is exactly what the branch above still exists to repair,
  // for a row this fix could not have prevented because it predates it.
  let result;
  try {
    result = db.transaction(() => {
      // Issue #27's L4 fix round R10, todo 181 item 2 (BOTH SEATS, opus's
      // fix, superseding R9's todo 178 reasoning below the old version of
      // this comment gave). Seeded "" unconditionally now, NOT the closed
      // row's own stale target. R9 seeded the closed row's value here so the
      // CAS below would match; that made a running row ADVERTISE a pane id
      // from a previous tmux generation that this invocation never
      // confirmed, from the moment this INSERT commits. A crash between here
      // and the CAS (ensureSession throwing crossServerRefusal, new-session
      // failing) then leaves the row running and naming that stale pane -
      // which the CURRENT tmux generation may have already reissued to some
      // other live agent, exactly the "hive types into a stranger's pane"
      // failure class #27 exists to remove. "" carries no such risk (todo
      // 180 made it universally read as not-live), and casExpected below is
      // set to match it, so the CAS is unaffected: it now compares against
      // what the column actually holds instead of what previousTarget
      // claims. previousTarget itself is UNCHANGED - see the return
      // statement - so stillThere's adoption check still gets the closed
      // row's real last pane to decide about.
      // Issue #73: recorded at creation, same as launchAgent's INSERT
      // (src/spawn.ts) - the fact is a property of THIS process and does not
      // wait on the CAS below to land it.
      // pane_pid seeded '' alongside tmux_target's own '', for the identical
      // reason (todo 180's comment above, restated for the newer column):
      // there is no live pane yet at INSERT time, and '' is this column's
      // own "no fact recorded" - never a pid to compare against. The CAS
      // below records the real one once a pane actually exists.
      const info = db
        .prepare(
          "INSERT INTO agents (project_id, name, command, cwd, kind, parent_actor_id, tmux_target, tmux_socket, pane_pid) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          project.id,
          LEAD_NAME,
          command,
          project.path,
          LEAD_KIND,
          currentActor(),
          "",
          tmuxSocketPath(process.env.TMUX, process.env.TMUX_TMPDIR),
          "",
        );
      const agentId = Number(info.lastInsertRowid);
      const actorId = priorClosed?.actor_id ?? mintLeadActorId(agentId);
      db.prepare("UPDATE agents SET actor_id = ? WHERE id = ?").run(actorId, agentId);
      upsertActor(actorId, LEAD_NAME, LEAD_KIND);
      return { agentId, actorId };
    })();
  } catch (e) {
    // The same idx_agents_running_name race launchAgent's own INSERT guards
    // against (src/spawn.ts): two `hive lead` invocations racing past the
    // lookup above. asNameClash turns the raw SQLITE_CONSTRAINT_UNIQUE into
    // hive's normal sentence instead of a stack trace naming a SQLite index.
    throw asNameClash(e, LEAD_NAME);
  }
  // Issue #27's L4 fix round R9, todo 178 (counselors opus F2, MEDIUM). This
  // used to always answer "" here, which the loser message's own advice
  // ("re-run `hive lead`") turns destructive for exactly the closed-row
  // case: `hive lead` reads the loser message and re-runs, ensureLeadRow
  // finds no RUNNING row (this one is closed) and takes this branch,
  // isPaneTarget("") is false so cmdLead's stillThere check can never even
  // ask whether the ORIGINAL pane is still there, and it unconditionally
  // splits a fresh one - leaving the original pane alive, untracked, and
  // still writing hook state under the SAME HIVE_AGENT_ID this new row just
  // inherited. That is the "two panes sharing one HIVE_AGENT_ID" damage the
  // CAS a few lines below exists to prevent, reached one invocation later
  // through a door the CAS never sees. A closed row still knows where its
  // pane was; handing that back as previousTarget lets cmdLead's EXISTING
  // stillThere check (the same one the ordinary reuse path already uses)
  // decide for itself whether that pane is genuinely still there, instead
  // of this function throwing the answer away before cmdLead ever gets to
  // ask. isPaneTarget() and targetLive() already reject a stale, dead, or
  // window-shaped value safely - this needs no tmux awareness of its own.
  //
  // casExpected is "" here, not priorClosed's target: the INSERT above now
  // always seeds the column "" (todo 181 item 2), so "" is what the CAS must
  // compare against for this branch to ever match. previousSocket rides along
  // with previousTarget for the same reason (issue #73): the closed row's own
  // recorded socket is what stillThere needs to judge that stale pane
  // honestly, not this fresh row's own tmux_socket (which the INSERT above
  // already seeded to THIS process's socket, and which is not what the pane
  // in question was ever recorded under).
  return {
    agentId: result.agentId,
    actorId: result.actorId,
    previousTarget: priorClosed?.tmux_target ?? "",
    previousSocket: priorClosed?.tmux_socket ?? "",
    previousPanePid: priorClosed?.pane_pid ?? "",
    casExpected: "",
  };
}

async function cmdLead(path?: string): Promise<void> {
  // Deferred, not printed here: resolveProjectAndNotify runs at the very top
  // of this function, with the attach that takes over the terminal still a
  // second-plus and a dozen-odd console.log lines away, which is exactly why
  // a human never actually reads this notice at resolve time. Held until
  // just before attach() (decisions/2026-08-05-cli-notices-go-to-stderr.md's
  // sibling problem, not what that decision itself fixes) instead.
  //
  // The whole body below is wrapped in a try so a throw between capture and
  // the deferred print still gets the notice out before the process exits
  // (see the catch below, and the comment on the print itself for which
  // throws actually reach it). A `finally` was considered and is wrong
  // here: attach()'s TTY path calls `process.exit()` directly, which skips
  // a `finally` block entirely, so the notice would still go unprinted on
  // exactly the path that matters least to protect (the one where
  // everything else already worked).
  let registrationNotice: string | null = null;
  try {
    const project = resolveProject(path, (text) => {
      registrationNotice = text;
    });
    const session = sessionName();
    const hooksPath = ensureHooksFile();

    const { config, warnings } = loadProjectYml(project.path);
    for (const w of warnings) console.log(`! ${w}`);
    let leadCommand = "claude";
    if (!config) {
      console.log(
        "No hive.yml here; starting a plain claude lead. Add a hive.yml to define project commands and a custom lead (run hive --help for the format).",
      );
    } else if (config.lead) {
      if (await ensureTrusted(project.id, "lead", config.lead, null, {})) {
        leadCommand = config.lead;
      } else {
        console.log("Using the default claude lead instead.");
      }
    }

    // State hooks (working/idle/waiting) ride along via --settings, same as
    // every claude worker agent_spawn launches. Gated on isClaudeCommand for
    // the same reason the posture flag below is: a custom lead command from
    // hive.yml may not take the flag at all.
    if (!isClaudeCommand(leadCommand)) {
      console.log("! lead command is not claude; skipping hooks.");
    } else {
      leadCommand += ` --settings ${shellQuote(hooksPath)}`;
    }

    // Posture rides in the system prompt: prompt-cached, uncompactable, and
    // impossible for the lead to forget. A profile named in a committed
    // hive.yml that this machine does not have must never be an error; the
    // lead just starts without it, and hive doctor says so.
    const profile = activeProfile(config);
    if (profile) {
      const posture = resolveProfileFile(profile, "posture.md");
      if (!posture) {
        console.log(`! profile "${profile}" has no posture.md on this machine; starting without it.`);
      } else if (!isClaudeCommand(leadCommand)) {
        console.log(`! lead command is not claude; skipping profile "${profile}" posture.`);
      } else {
        // The flag takes a path, so the vars are resolved into a generated file
        // rather than into the profile. `hive posture` prints the same text.
        const rendered = renderProfileFile(profile, "posture.md", config?.vars ?? {}) ?? "";
        const path = writeProjectPosture(project.id, rendered);
        leadCommand += ` --append-system-prompt-file ${shellQuote(path)}`;
        console.log(`- profile: ${profile} (${posture.source} posture; see it with: hive posture)`);
      }
    }

    // The lead launches before auto-start processes so that on a fresh session
    // it claims the initial window rather than one of them.
    //
    // The window is named for the project alone, not "<project> - lead"
    // (decisions/2026-08-05-tmux-topology-windows-not-sessions.md, Chris's
    // call 2026-08-05): the window now holds the lead AND its workers, so it
    // is the project's iTerm tab, not the lead's pane. Safe to rename because
    // the lookup below no longer keys on it; windowTitle() still exists for
    // worker WINDOWS (placement="window" in src/spawn.ts), untouched here.
    const windowName = project.name;
    const {
      agentId: leadAgentId,
      actorId: leadActorId,
      previousTarget,
      previousSocket,
      previousPanePid,
      casExpected,
    } = ensureLeadRow(project, leadCommand);
    // HIVE_LEAD marks this session as the lead, distinctly from HIVE_AGENT_ID
    // being set at all: src/kickoff.ts's very first check (before it opens the
    // store, deliberately) has always read HIVE_AGENT_ID alone to mean "worker
    // session, no kickoff". Now that a lead carries HIVE_AGENT_ID too, that
    // check needs a way to tell the two apart without a database lookup, and a
    // second env var is cheaper than one.
    // Issue #27's L4 fix round R6, todo 167 (counselors codex F4, verified by
    // the lead against the code). launchAgent (src/spawn.ts) passes
    // HIVE_DATA_DIR to every worker it launches; this block never did for the
    // lead. Without it, `HIVE_DATA_DIR=/tmp/alt hive lead` writes the lead row
    // and the hooks file into /tmp/alt, but the claude process it launches
    // inherits the tmux server's own environment and defaults its MCP server
    // AND its hooks to ~/.hive - the alternate store gets no hook rows at all,
    // and a coincidentally-matching lead:N in the DEFAULT store gets mutated
    // instead. A lead whose hooks write to the wrong store is this lane's own
    // thesis failing. The suite hid this because every scratch store also gets
    // a freshly isolated tmux server that happens to inherit the matching
    // data dir - never exercising a lead launched into a server that does not.
    //
    // HIVE_PROJECT_LOCK and HIVE_PROJECT_PATH are never SET here - both exist
    // to PIN a worker to one project via its actor_id row (agentProjectPin,
    // src/context.ts), gated on HIVE_PROJECT_LOCK === "1", and a lead must
    // never be locked that way: cross-project access when a human asks (cd, or
    // a wake targeting another project) is exactly what distinguishes a lead
    // from a worker.
    //
    // Issue #27's L4 fix round R8, todo 175 item 2 (counselors codex F4,
    // MEDIUM). "Never set" used to mean "absent from this object", which is
    // NOT the same as absent from the pane: tmux panes inherit the SERVER's
    // own environment (src/spawn.ts's HIVE_LEAD: "" clear exists for exactly
    // this reason, the opposite direction), so a pre-existing server carrying
    // HIVE_PROJECT_LOCK=1 handed a project-locked lead, and a mismatching
    // inherited HIVE_PROJECT_PATH made its project-scoped calls fail outright.
    // Explicitly clearing both closes that the same way HIVE_LEAD's own clear
    // does for a worker - present-and-empty, not merely absent-and-hopeful.
    // buildEnvFlags (src/spawn.ts): the same flattening step launchAgent uses
    // for a worker's env, found in /simplify review after this array used to
    // be its own hand-rolled literal - a second, parallel implementation that
    // HIVE_DATA_DIR above had to be manually re-added to.
    const envFlags = buildEnvFlags({
      HIVE_AGENT_ID: leadActorId,
      HIVE_AGENT_NAME: LEAD_NAME,
      HIVE_LEAD: "1",
      HIVE_DATA_DIR: dataDir,
      HIVE_PROJECT_LOCK: "",
      HIVE_PROJECT_PATH: "",
    });
    // The lead's tmux_target is a PANE id (%N), never session:window. wakes.ts's
    // resolveDelivery prefers this row's tmux_target over TMUX_PANE, and a
    // window target delivers to that window's ACTIVE pane - a split worker's,
    // once one is running there - not the lead's. Each branch captures its own
    // pane directly rather than a trailing list-windows lookup afterward:
    // claimInitialWindow already returns one, and -P -F gets one straight off
    // new-window's/split-window's own output the same way launchAgent does
    // (src/spawn.ts).
    // Issue #27's L4 fix round R9, todo 177 item 1 (BOTH SEATS). Tracked at
    // the site each pane is actually made, not inferred afterward by
    // comparing leadPane to previousTarget: that comparison is a PROXY for
    // "this process created the pane" and it is unsound, because pane ids are
    // not globally unique - split-window can hand back an id that happens to
    // equal a stale previousTarget (opus's finding: a genuinely fresh pane
    // then reads as "already there" and a losing process leaves it running
    // untracked), and this file already relies elsewhere on ids restarting at
    // %0 on a fresh tmux server (see the "pane ids wrap around" comment
    // above). createdPane records the fact directly instead of re-deriving it
    // from a string comparison a few lines later.
    // The window the lead's pane actually ends up in, tracked at each site
    // that decides it rather than looked up again at attach time (todo 276).
    // The two disagree in exactly the case that todo exists for: a lead pane
    // adopted where it MOVED to sits in a window that is not the one carrying
    // this project's stamp, and a second findProjectWindow at the bottom of
    // this function would send the human to the tab the lead just left.
    // Todo 277: everything from ensureSession to the branch that produces a
    // pane is one read-then-create - does this session exist, does this
    // project already have a window - and two `hive lead` runs (or a `hive
    // lead` racing an agent_spawn) that interleave inside it both create and
    // stamp a window for the same project, permanently. withWindowClaim
    // (src/spawn.ts) is the store's own write lock, held across the section
    // rather than around each write in it; its comment carries why the
    // reconcile-afterwards alternative is weaker.
    const { leadPane, leadWindow, createdPane } = withWindowClaim(() => {
      let leadPane: string;
      let leadWindow: string;
      let createdPane: boolean;
      const started = ensureSession(session, project.path);
      if (started.created) {
        const claimed = claimInitialWindow(started, windowName, project.path, envFlags, leadCommand, project.id);
        leadPane = claimed.pane;
        leadWindow = claimed.window;
        createdPane = true;
      } else {
        // Found by the @hive-project-id OWNERSHIP STAMP, never by window name
        // (decisions/2026-08-05-tmux-topology-windows-not-sessions.md: the
        // window name is cosmetic now). findProjectWindow (src/tmux.ts) carries
        // the M7/no--A justification for the lookup itself.
        //
        // Todo 276 (counselors opus #2) INVERTED what this lookup decides.
        // Until this round, foundWindow gated the reuse of the row's previous
        // pane: `stillThere` required that pane to be a MEMBER of foundWindow,
        // and read a failed membership test as "the pane is gone" without ever
        // consulting rowLive on that path. Membership PROVING ownership was
        // sound and is kept (adoptableWindow, src/tmux.ts, states it as the
        // exclusion it always was); failed membership proving DEATH never held,
        // and a lead pane that merely moved to another window - `tmux
        // break-pane`, which is also how you get the lead full-screen - got a
        // SECOND claude split in beside it, both running under one
        // HIVE_AGENT_ID. That is the damage cmdLead's own CAS below exists to
        // prevent, arriving through a door the CAS cannot see, since one
        // process creates and records both panes and nothing races.
        //
        // So LIVENESS is primary now, and this lookup is what a project falls
        // back to when it has no live pane to take back.
        // test/lead-window-ownership.test.mjs still pins the property that must
        // not move with it: a stale target pointing into ANOTHER project's
        // window is refused, proven through a real cross-project pane adoption
        // rather than through a clause. test/lead-moved-pane.test.mjs pins this
        // new direction, and both have to hold at once.
        const foundWindow = findProjectWindow(session, project.id);
        // Issue #73, D6: previousSocket is the row's OWN recorded socket from
        // before this call (ensureLeadRow), not this process's - a foreign
        // value here means the row's last-known pane belongs to a server this
        // process cannot honestly judge, and rowLive reads that as unknown,
        // which the `=== true` below already treats as "not adoptable" (D6's
        // stated bias for this branch, same as an untrusted tmux server).
        //
        // Counselors round 1 (#73, A5), accepted and recorded rather than
        // changed. Treating unknown as "not still there" means `hive lead`
        // PROCEEDS on a liveness question it cannot honestly answer, and can
        // split a fresh pane while the OLD lead's pane is genuinely still
        // alive on the foreign server this process cannot see - two live
        // leads for the one row this project otherwise works hard to keep
        // singular. The alternative is refusing outright on unknown, which
        // trades that risk for the one F4 names as the honest cost of this
        // whole lane: a lead row stuck 'running' forever with no recorded
        // pane, unrecoverable the same way a foreign-socket worker row is
        // (`hive doctor` now names those; a lead that refuses to start at all
        // has no such recovery path).
        //
        // Counselors round 2 (#73, A5) corrected the comparison above: it is
        // not "maybe two leads" against "certainly no lead and no way to get
        // one". Refusing here does not strand the caller without a lead at
        // all - the ORIGINAL lead, if it is genuinely still alive on the
        // foreign socket, is exactly as reachable as it was before this call;
        // refusing only means THIS pane does not get a new one, and the human
        // is left where the real lead already was, back on the socket it is
        // actually running on. Nor does "a human notices two panes and closes
        // one" hold: the two panes live on DIFFERENT tmux servers, so nothing
        // run from this pane can ever list the other one - there is no single
        // view where a human would see both at once. The real trade is
        // between an UNDETECTABLE risk (a second live lead, on a server this
        // process cannot see well enough to warn about) and a DETECTABLE but
        // inconvenient cost (F4's stuck row, visible in `hive doctor`, but
        // only to whoever thinks to run it from the socket that row is
        // actually stuck on). PROCEEDING is still the choice made here: a
        // `hive lead` that refuses outright on unknown liveness is one that
        // stops working from a legitimate new pane the moment any stale row's
        // socket cannot be confirmed dead, which is the common case after any
        // reboot or crash, not the rare one. Deliberate bias, not an
        // oversight.
        // Issue #157. rowLive/adoptableWindow above answer "is the pane
        // alive" and "is it in a window this project owns" - neither asks
        // WHICH process is in it, so a bare shell cmdAttach left in %0 used
        // to pass both and get adopted, with nothing ever respawning
        // leadCommand into it. paneReissued (src/tmux.ts, added by #152 for
        // deliverable()'s identical comparison) is the primitive that closes
        // this: it already encodes "cannot judge" (previousPanePid === "", a
        // pre-migration row, or probe.pid === null) as false, so an upgrade
        // still adopts every existing lead's own window exactly as before -
        // only a pane that is genuinely live AND genuinely a different
        // process refuses.
        const probe = rowLiveProbe(previousSocket, previousTarget);
        const adopted =
          isPaneTarget(previousTarget) && probe.live === true && !paneReissued(previousPanePid, probe)
            ? adoptableWindow(session, project.id, previousTarget)
            : null;
        if (adopted) {
          // A live pane this project may take back, wherever in the session it
          // ended up. leadWindow is that pane's ACTUAL window, not foundWindow:
          // the two disagree in exactly the case this branch was added for, and
          // attaching to the stamped window would leave the human looking at
          // the tab the lead is no longer in.
          leadPane = previousTarget;
          leadWindow = adopted;
          createdPane = false;
        } else if (!foundWindow) {
          // THE ACCEPTED RESIDUAL, decided with Chris (plan-lane-3-tmux-
          // topology, todo 266): a lead running ACROSS the topology upgrade
          // lands here even though its OLD pane may still be alive. Its
          // previousTarget names a pane in the old per-project session
          // (hive-<project.id>), which this store no longer creates or looks
          // in, so findProjectWindow above can never find it - the row's
          // history is invisible to a lookup keyed on @hive-project-id in
          // hive-main. The old pane is not reused, not closed, not migrated: it
          // is stranded, a live claude in a window nothing in this store points
          // at any more, which `hive doctor` will name (a live pane, foreign
          // to every window this run creates or claims). Not data loss, not a
          // wrong store - a fresh pane starts here exactly as it would for a
          // project with no prior lead at all.
          // Accepted because Chris starts fresh instances daily and is the
          // only user; the condition that reverses it is the same shape as the
          // hive.yml vars gate in CLAUDE.md - someone other than Chris runs
          // hive, or leads start being left running for days. Migrating a
          // stranded old-topology pane into its new window (`move-window`) was
          // considered and rejected as transitional code for a boundary
          // crossed once, by one user, on the same grounds pad 71 rejected
          // "hive gather" for the pane-placement case.
          const fresh = createWindow(session, windowName, project.path, envFlags, leadCommand, project.id);
          leadPane = fresh.pane;
          leadWindow = fresh.window;
          createdPane = true;
        } else {
          // A found window is not proof of a live lead: split workers keep it
          // open (and keep carrying the project's ownership stamp) after the
          // lead's own claude exits, so finding the project's window is not
          // enough on its own (that was the "restart attaches to a window
          // containing no lead" defect, originally against a title match -
          // decisions/2026-07-24-claim-initial-tmux-window.md - now against the
          // ownership stamp instead, same defect shape either way). There is
          // nothing live to take back - the adopted branch above already asked
          // that question, across the whole session rather than inside this one
          // window - so split a fresh pane in for the lead.
          leadPane = tmux(
            "split-window",
            "-P",
            "-F",
            "#{pane_id}",
            "-t",
            foundWindow,
            "-c",
            project.path,
            ...envFlags,
            leadCommand,
          );
          leadWindow = foundWindow;
          createdPane = true;
        }
      }
      return { leadPane, leadWindow, createdPane };
    });
    // Issue #27's L4 fix round R6, todo 166 (counselors codex F1, verified by
    // the lead against the code). `deliver_pane` is snapshotted once at
    // wake_set time (src/tools/wakes.ts) and nothing else ever updates it, so
    // without this, a restart that changes the lead's pane - the NORMAL case,
    // not an exotic one - leaves every pending lead-owned wake naming a stale
    // pane. Two ways that fails, both bad: held forever if the old pane is
    // simply gone (the new lead-row exemption in the janitor and deliverable()
    // now protects it from ever being cancelled, so "held" looks deliberate
    // and never resolves), or worse, typed into a RECYCLED pane belonging to
    // someone else once the tmux server itself has restarted and pane ids
    // wrap around - the exact failure class issue #27 exists to remove,
    // reintroduced by a second route (the first was the window-target bug
    // fixed earlier in this round). One transaction with the pane update
    // itself, so a reader never observes the new pane recorded on the agents
    // row with a pending wake still naming the old one. held_at/held_reason
    // are cleared too: a wake held against the OLD pane is no longer held
    // against anything once it is re-pointed at a fresh one.
    //
    // Issue #27's L4 fix round R6, todo 170's investigation (counselors codex
    // F3, reasoned rather than executed, checked here before acting). Two
    // concurrent `hive lead` processes that both see the SAME dead
    // previousTarget both take this far: both create their own fresh pane
    // (new-window, or split-window in the found-window branch), and an
    // unconditional UPDATE would let the second write silently clobber the
    // first, leaving one of the two freshly-created panes' claude alive and
    // untracked, both sharing one HIVE_AGENT_ID. Guarded with a conditional
    // update instead: this only wins the write if tmux_target STILL reads what
    // this process itself read as casExpected (works for every branch above,
    // including the fresh-INSERT case where casExpected is "" and the
    // reused-pane case where casExpected is the row's unchanged pre-existing
    // value - SQLite counts a matched row as changed even when the new value
    // equals the old one). The loser kills the orphan pane it just created
    // rather than leaving a live, untracked claude process running, and fails
    // loudly telling the human to re-run - the same shape asNameClash's
    // race-loser message uses (todo 170's item 3) - rather than silently
    // retrying, which this round is not carrying. NOT closed by this guard,
    // and written down rather than chased: a crash between pane creation and
    // this UPDATE landing (this process dies, never reaching either branch)
    // leaves the SAME kind of orphan pane with nothing to detect it on the
    // next `hive lead`, since there is no second process racing to notice.
    // That residual needs a liveness sweep over stray panes in the lead's
    // window, which is a bigger change than this round's guard.
    // Issue #27's L4 fix round R8, todo 172 (counselors codex F1, HIGH). The
    // CAS above used to check only id and tmux_target; closeAgentRow() leaves
    // tmux_target unchanged when it closes a row, so a janitor closing this row
    // between ensureLeadRow's read and this write still let the UPDATE match, a
    // running lead's pane got recorded on a status='closed' row, and a SECOND
    // `hive lead` would then INSERT another running row for the same actor,
    // leaving two panes. status = 'running' closes it the same way the reuse
    // read above already filters on it.
    //
    // Issue #27's L4 fix round R10, todo 181 item 2 (BOTH SEATS). Matches
    // against casExpected now, not previousTarget: they agree for the reuse
    // branch but not for a fresh INSERT (see ensureLeadRow), and the CAS has
    // to compare against what the COLUMN holds, never against what
    // previousTarget merely claims - matching a value the column was never
    // actually written with would make the CAS fail (or worse, coincidentally
    // pass against an unrelated row state) for the wrong reason.
    const wonRace = db.transaction(() => {
      // Issue #73: a restart under a different tmux server must re-record the
      // socket here, in the same statement as the pane, or the row keeps
      // advertising a socket it no longer lives on.
      //
      // Todo 336: pane_pid re-recorded here too, in the same statement, for
      // the identical reason and the case this whole function exists to
      // handle - a tmux server restart is exactly when a pane id can be
      // reissued to a different pane, and leadPane here is confirmed live
      // (either just created, or the adopted branch's rowLive === true
      // check above) so there is a real pid to read. Any lead-owned wake
      // pointing at this actor picks up the fresh value through
      // deliverable()'s join, with no separate write needed - see that
      // function's own comment (src/scheduler.ts).
      const updated = db
        .prepare(
          "UPDATE agents SET tmux_target = ?, tmux_socket = ?, pane_pid = ? WHERE id = ? AND tmux_target = ? AND status = 'running'",
        )
        .run(
          leadPane,
          tmuxSocketPath(process.env.TMUX, process.env.TMUX_TMPDIR),
          panePid(leadPane),
          leadAgentId,
          casExpected,
        ).changes;
      if (updated === 0) return false;
      db.prepare(
        `UPDATE timers SET deliver_pane = ?, held_at = NULL, held_reason = NULL
         WHERE ${ACTIVE_TIMER_WHERE} AND deliver_actor = ?`,
      ).run(leadPane, leadActorId);
      return true;
    })();
    if (!wonRace) {
      // Issue #27's L4 fix round R8, todo 172 (counselors opus F1, MEDIUM but
      // the damage is a live session), refined in R9's todo 177 item 1. The
      // stillThere branch sets leadPane === previousTarget: a pane this
      // process PROBED as already live, not one it just created. Killing it
      // here was the bug - "the loser kills the orphan pane it just created"
      // is only true of the other two branches, which split or spawn a
      // genuinely fresh pane that has no reason to exist once the CAS says
      // someone else already recorded a live one. Only kill when this process
      // is actually the one that made it - tracked directly as createdPane,
      // not re-derived from comparing leadPane to previousTarget, which a
      // recycled pane id can satisfy by coincidence either way.
      if (createdPane) {
        try {
          tmux("kill-pane", "-t", leadPane);
        } catch {
          // Best effort; the pane may already be gone.
        }
      }
      throw new Error(
        "Another `hive lead` won the race to record a live pane for this project's lead session (both saw the " +
          "same dead pane and both tried to replace it, or this row was closed by another process mid-restart). " +
          "Re-run `hive lead`; it will attach to the pane that invocation recorded.",
      );
    }

    if (config) {
      for (const [name, proc] of Object.entries(config.processes)) {
        if (!proc.auto_start) {
          console.log(`- ${name}: defined, auto_start off (start with: hive start "${name}")`);
          continue;
        }
        if (await ensureTrusted(project.id, name, proc.command, proc.dir, proc.env)) {
          console.log(`- ${name}: ${startYmlCommand(project, name, proc)}`);
        }
      }
    }

    // Printed last, immediately before the attach that takes over the
    // terminal - the one place on this path a human is actually still
    // reading stderr. Still runs when nothing above set it
    // (registrationNotice stays null on an already-registered project) and
    // still runs on every attach outcome below: attach() either returns
    // after printing its own instructions (no TTY) or exec's into a real
    // tmux attach and never returns to this function at all, so nothing can
    // be placed AFTER it that still needs to run.
    //
    // Nulled out immediately after: the catch below reprints
    // registrationNotice on any throw that reaches it, and without this a
    // throw from attach() itself (its TTY branch only calls process.exit,
    // but nothing prevents a future change there) would print the notice
    // twice. ensureTrusted (both call sites above) does NOT throw - it
    // returns a boolean on every path - so it is not one of the throws the
    // catch below exists for.
    if (registrationNotice) {
      console.error(registrationNotice);
      registrationNotice = null;
    }
    attach(session, project, leadWindow);
  } catch (e) {
    // Review round 1, F5: this project's own review corrected a reachability
    // claim recorded here that named the CAS race-loser as the only throw
    // that could drop the notice, and that claim was wrong on its own terms
    // (idx_agents_running_name is UNIQUE(project_id, name) WHERE
    // status='running', so a second concurrent `hive lead` on the same
    // brand-new project fails its OWN INSERT inside ensureLeadRow's
    // transaction and throws asNameClash - it never reaches a CAS with
    // casExpected === "" at all). The real answer is plainer and does not
    // need a narrow story: EVERY tmux() call between the capture above and
    // the print above throws on failure (src/tmux.ts), and cmdLead makes
    // several before that print - ensureSession, claimInitialWindow, the
    // found-window branch's own tmux calls, and the CAS transaction's own
    // throw among them. The single most reachable case is the plainest:
    // `hive lead` in a freshly unregistered directory on a machine with no
    // tmux, or one whose tmux server this process refuses as foreign
    // (untrustedTmuxServer, src/tmux.ts) - registration succeeds, the
    // notice is captured, and the very next tmux call throws. Before this
    // try/catch existed, a throw here dropped the notice permanently: the
    // project is registered forever after, the notice is a consume-once
    // in-process fact, and no later invocation ever sees it again. Catching
    // here and reprinting closes exactly that gap, for every throw in the
    // body above, not only the tmux ones.
    if (registrationNotice) console.error(registrationNotice);
    throw e;
  }
}

const HIVE_YML_TEMPLATE = `# hive project config. Read by \`hive lead\` from the project root.
# Commands defined here run only after a one-time interactive approval,
# and re-require it whenever they change.

placement: split                # worker placement: split (panes) or window (tabs)

# layout: main-vertical         # pane arrangement for placement: split.
                                # tiled (default) | main-vertical | main-horizontal
                                # | even-horizontal | even-vertical.
                                # main-* gives the lead half the window.

# lead: claude --model opus     # custom command for the lead window (default: claude)

# lead_branches: [main, master] # branches where a session gets hive's kickoff
# vars:                         # substituted into the profile runbook
#   repo: owner/name            # {{repo}}
#   ticket_prefix: DEVX         # sections needing it drop when it is unset
#   install: npm install
#   start_command: /jira-start

# processes:
#   npm:dev: npm run dev        # shorthand; auto-starts with the session
#   typecheck:                  # expanded form
#     command: npx tsc --watch --preserveWatchOutput
#     dir: ./packages/api       # relative to the project root
#     auto_start: false         # start manually with: hive start typecheck
#     env:
#       NODE_ENV: development
`;

const RUNBOOK_TEMPLATE = `RUNBOOK — standing instructions for this project's lead session.

This pad is the durable operating manual. Read it whenever the human opens
the day ("good morning", "let's triage") or asks you to orchestrate work.
Live state belongs in the "board" pad and the todos, not here.

FIRST RUN (delete this section once done)
This runbook is a starter template. Before dispatching any real work,
interview the human and rewrite every section to fit this project. Ask:
- How does work arrive? Tickets, ad-hoc requests, PR reviews, planning?
- What are the branch, commit, and PR rules? What may the lead itself do?
- Where do worktrees live, and what does a fresh one need (installs, env)?
- How do workers verify their work before a lane is called done?
- What must never happen without explicit human approval?
Rewrite the sections below from the answers, keep the whole pad short
(every read costs tokens), then delete this section.

THE ONE RULE
<the invariant that always holds, e.g. "every commit goes through a PR;
the lead stays on main and never commits">

LANES
<the kinds of work and how each one runs, e.g.
- ticket (commits): worktree + ticket branch, one worker, PR at the end
- ad-hoc task (commits): worktree + slug branch, commit, PR
- review (no commits): worker drafts the review, the human posts it
- planning: interview first, plan to a pad, seed todos with blockers>

WORKTREES
<where they live, what setup a fresh one needs, when to remove them>

MORNING TRIAGE
1. Read the "board" pad, then todo_list(status="open") for the queue.
2. <project checks: PR queue, ticket tracker, CI state>
3. Update the board, agree the day's lanes with the human, then dispatch
   per help(topic="workflow").

BOARD DISCIPLINE
The "board" pad is the live picture of the work. Update it the moment
tasks change: a todo is created, re-scoped, blocked, or completed; a
worker starts or finishes a lane; something lands in "waiting on human".
A stale board is worse than no board. Keep it small: active work-streams
and their worktree, todo, and worker ids. At day end, pad_archive the old
board and write a fresh "board" carrying forward only what is still live.
History stays readable with pad_list(include_archived=true).

STANDING RULES
- Do not poll workers. With more than one running, set
  wake_when_idle(scope="project") once and go quiet: it reports each worker
  as it finishes and keeps watching. The agents=[...] form is a one-shot and
  stops watching the rest after the first finish.
- Read real diffs and agent_output before calling a lane done.
- Record decisions in pads or todo comments; sessions die, the store lives.
- Anything outward-facing (pushes, published PRs, posted reviews) waits
  for explicit human approval.
`;

const BOARD_TEMPLATE = `BOARD — live state for this project. Keep it small and current.

Update this pad whenever tasks change: todos created, re-scoped, blocked,
or completed; lanes started or finished. At day end, archive it and write
a fresh "board" carrying forward only what is still live.

TODAY
<the day's agreed lanes, one line each: worker, worktree, todo ids, status>

WAITING ON HUMAN
<approvals, answers, or reviews the crew is blocked on>

NEXT UP
<dispatchable todos worth starting when a lane frees>
`;

const pluginLinkPath = () => join(claudeConfigDir(), "skills", "hive");

// Printed paths keep the ~ shorthand only when that is where it actually
// resolves; a custom config dir gets the real path, since the reader has to be
// able to paste it.
const displayLinkPath = () => {
  const path = pluginLinkPath();
  const fromHome = join(homedir(), ".claude", "skills", "hive");
  return path === fromHome ? "~/.claude/skills/hive" : path;
};

// The session-start plugin is one symlink per MACHINE, not per project, so
// `hive init` in the second project should not advertise something already
// installed. hive never creates or removes it; it only reports what it finds.
function pluginInstallState(): { state: "missing" | "linked" | "elsewhere"; target?: string } {
  let target: string;
  try {
    target = realpathSync(pluginLinkPath());
  } catch {
    return { state: "missing" };
  }
  let expected: string;
  try {
    expected = realpathSync(join(checkoutRoot, "claude-plugin"));
  } catch {
    return { state: "elsewhere", target };
  }
  // Compared by real path: the documented install is a symlink, but a copied
  // directory or a link into another checkout both resolve here too, and the
  // second one silently runs a different hive's kickoff.
  return target === expected ? { state: "linked" } : { state: "elsewhere", target };
}

const PROFILE_BLURBS: Record<string, string> = {
  orchestration: "a lead that plans and delegates to workers in tmux",
  simple: "one session doing the work itself; hive is shared memory",
  [NO_PROFILE]: "project-only; hive seeds a runbook pad you fill in",
};

// Asked only when stdin is a TTY and hive.yml has not answered already.
// An absent profile key means "never asked", which is what lets a later
// `hive init` offer this without nagging anyone who declined.
async function askForProfile(): Promise<string | null> {
  // One list drives both the menu and the answer, so a forked profile shows
  // up without touching the parsing below.
  const options = [...profileNames(), NO_PROFILE];
  console.log(`\nA profile is a set of standing instructions shared across projects.
It gives the lead its posture and this project a runbook you can edit.`);
  options.forEach((name, i) => console.log(`  ${i + 1}) ${name.padEnd(15)} ${PROFILE_BLURBS[name] ?? ""}`));

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(`Profile for this project? [1-${options.length}, default 1] `)).trim();
  rl.close();
  if (answer === "") return options[0] ?? null;
  const index = Number(answer);
  if (Number.isInteger(index) && index >= 1 && index <= options.length) return options[index - 1];
  if (options.includes(answer)) return answer;
  console.log(`Not one of the options; leaving the profile unset. Re-run hive init to pick one.`);
  return null;
}

// Appends the key rather than rewriting the file: hive.yml is the human's,
// and everything else in it (comments, processes, placement) must survive.
function writeProfileKey(ymlPath: string, profile: string): void {
  const existing = readFileSync(ymlPath, "utf8");
  const block = `\n# Standing instructions for this project (hive profile list).\nprofile: ${profile}\n`;
  writeFileSync(ymlPath, existing.endsWith("\n") ? existing + block : `${existing}\n${block}`);
}

async function cmdInit(argv: string[]): Promise<void> {
  const noProfile = argv.includes("--no-profile");
  const profileFlagIndex = argv.indexOf("--profile");
  // The value after --profile is not the path argument.
  const path = argv.find(
    (a, i) => !a.startsWith("--") && !(profileFlagIndex >= 0 && i === profileFlagIndex + 1),
  );
  let chosen: string | null = noProfile ? NO_PROFILE : null;
  if (profileFlagIndex >= 0) {
    const value = argv[profileFlagIndex + 1];
    if (!value || value.startsWith("--")) {
      console.log("Usage: hive init [path] [--profile <name> | --no-profile]");
      process.exit(1);
    }
    if (value !== NO_PROFILE && !profileExists(value)) {
      console.log(`No profile named "${value}". Available: ${profileNames().join(", ")}, none`);
      process.exit(1);
    }
    chosen = value;
  }

  const project = resolveProject(path);
  console.log(`Project: ${project.name} (${project.path})`);

  const ymlPath = join(project.path, "hive.yml");
  const already = existsSync(ymlPath) ? loadProjectYml(project.path).config?.profile ?? null : null;
  // A profile already in hive.yml always wins. Changing it is a one-line hand
  // edit, not something a setup command does to a committed file behind you.
  if (already != null) {
    if (chosen != null && chosen !== already) {
      console.log(`- hive.yml: already set to "profile: ${already}"; edit it by hand to change it`);
    }
    chosen = already;
  } else if (chosen == null && process.stdin.isTTY && process.stdout.isTTY) {
    chosen = await askForProfile();
  }

  if (!existsSync(ymlPath)) {
    writeFileSync(ymlPath, HIVE_YML_TEMPLATE + (chosen ? `\nprofile: ${chosen}\n` : ""));
    console.log(`- hive.yml: created${chosen ? ` with profile: ${chosen}` : ""}`);
  } else if (already == null && chosen != null) {
    writeProfileKey(ymlPath, chosen);
    console.log(`- hive.yml: added profile: ${chosen}`);
  } else {
    console.log(`- hive.yml: already exists${already ? ` (profile: ${already})` : ""}, left untouched`);
  }

  // A project with a profile reads its process from `hive runbook`, so a
  // runbook pad would be a second source of truth nobody updates. Seed one
  // only when the project decided against a profile, or has not decided yet.
  const usingProfile = chosen != null && chosen !== NO_PROFILE;
  if (usingProfile) {
    console.log(`- runbook: from profile "${chosen}" (read it with: hive runbook)`);
  } else {
    const padId = createPad(project.id, "runbook", RUNBOOK_TEMPLATE, []);
    console.log(
      padId == null
        ? "- runbook pad: already exists, left untouched"
        : `- runbook pad: seeded starter template (pad ${padId})`,
    );
  }

  const boardId = createPad(project.id, "board", BOARD_TEMPLATE, []);
  console.log(
    boardId == null
      ? "- board pad: already exists, left untouched"
      : `- board pad: seeded starter template (pad ${boardId})`,
  );

  if (chosen == null) {
    console.log(`\nNo profile set (nothing was asked, since this is not an interactive terminal).
Pick one later with: hive init --profile <name>   (hive profile list shows them)
or decide against it with: hive init --no-profile`);
  }

  if (usingProfile) {
    const plugin = pluginInstallState();
    if (plugin.state === "linked") {
      console.log(`\nSession-start kickoff: already installed for this machine, nothing to do.
Check what a session here would get with: hive kickoff --explain`);
    } else if (plugin.state === "elsewhere") {
      console.log(`\n! ${displayLinkPath()} resolves to ${plugin.target}, not this checkout.
Sessions here run THAT hive's kickoff. Repoint it if this checkout is the one you use:
  rm ${displayLinkPath()} && ln -s ${join(checkoutRoot, "claude-plugin")} ${displayLinkPath()}`);
    } else {
      console.log(`\nOptional, once per machine (not per project): let a session in this project
start with hive's live state already loaded.
  ln -s ${join(checkoutRoot, "claude-plugin")} ${displayLinkPath()}`);
    }
    console.log(`\nNext: run \`hive\` here. The lead starts with the "${chosen}" posture in its
system prompt; \`hive runbook\` is the process it follows. Fork the runbook to
make it yours: hive profile fork ${chosen} runbook.md`);
  } else {
    console.log(`\nNext: run \`hive\` here and tell the lead "good morning, let's triage".
The runbook's first-run section has the lead interview you and tailor
itself to this project before any real work runs.`);
  }
}

// The lead's standing process, resolved from the project's profile with
// hive.yml vars substituted. A project on `profile: none` keeps its process in
// the runbook pad, so print that instead of sending the lead somewhere else.
//
// Shared with cmdDoctor's check 3 below, which names the same fact.
const NO_RUNBOOK_PAD_MESSAGE = `is on "profile: none" but has no runbook pad. Create one with: hive init`;

function cmdRunbook(path?: string): void {
  const project = resolveProject(path);
  const { config, warnings } = loadProjectYml(project.path);
  for (const w of warnings) console.log(`! ${w}`);
  const profile = activeProfile(config);

  if (!profile) {
    const pad = getActivePadByName(project.id, "runbook");
    if (pad) {
      process.stdout.write(withTrailingNewline(pad.content));
      return;
    }
    console.log(
      config?.profile === NO_PROFILE
        ? `This project ${NO_RUNBOOK_PAD_MESSAGE}`
        : `This project has no profile. Add "profile: <name>" to hive.yml (hive profile list) or run hive init.`,
    );
    process.exit(1);
  }

  const vars = config?.vars ?? {};
  const rendered = renderProfileFile(profile, "runbook.md", vars);
  if (rendered == null) {
    console.log(`Profile "${profile}" has no runbook.md on this machine. Profiles hive can see: ${profileNames().join(", ") || "none"}`);
    process.exit(1);
  }
  process.stdout.write(withTrailingNewline(rendered));
}

// What the lead is actually running with. `hive lead` renders posture.md into
// a generated file and points --append-system-prompt-file at that, so
// `hive profile path` shows the unrendered source and nothing else would show
// the text the model really got.
function cmdPosture(path?: string): void {
  const project = resolveProject(path);
  const { config, warnings } = loadProjectYml(project.path);
  for (const w of warnings) console.log(`! ${w}`);
  const profile = activeProfile(config);
  if (!profile) {
    console.log(
      `This project has no profile, so its lead starts with no posture. Add "profile: <name>" to hive.yml (hive profile list) or run hive init.`,
    );
    process.exit(1);
  }
  const vars = config?.vars ?? {};
  const rendered = renderProfileFile(profile, "posture.md", vars);
  if (rendered == null) {
    console.log(`Profile "${profile}" has no posture.md on this machine, so the lead starts without one.`);
    process.exit(1);
  }
  process.stdout.write(withTrailingNewline(rendered));
}

function profileUsage(): never {
  console.log(`Usage:
  hive profile list                            profiles hive can see, and where each file comes from
  hive profile path <name> [file]              where a profile's files resolve to
  hive profile fork <name> [file]              copy hive's default into ${userProfilesDir()} to edit
  hive profile create <name> [--from <other>]  start a new profile

Files in a profile: ${PROFILE_FILES.join(", ")}`);
  process.exit(1);
}

function asProfileFile(value: string | undefined): ProfileFile | undefined {
  if (value == null) return undefined;
  if (!(PROFILE_FILES as readonly string[]).includes(value)) {
    console.log(`Unknown profile file "${value}". Files are: ${PROFILE_FILES.join(", ")}`);
    process.exit(1);
  }
  return value as ProfileFile;
}

// Shared by `hive doctor` and `hive profile list`: one sentence and one
// number for a fork's drift from hive's shipped default, so the two surfaces
// cannot disagree about the same file. Todo 326 comment 723 - doctor's own
// diff introduced exactly that gap by adding the percentage and the
// warn/info split to doctor alone, leaving list's older, plainer sentence
// behind it. null once the file has not moved since the fork.
function profileDriftText(f: ProfileFileStatus): { rewrite: boolean; text: string } | null {
  if (!f.upstreamMoved) return null;
  const pct = f.divergence != null ? Math.round(f.divergence * 100) : null;
  if (f.divergence != null && f.divergence >= REWRITE_THRESHOLD) {
    return { rewrite: true, text: `${f.file} is a ${pct}% rewrite of hive's default, not an edited copy of it` };
  }
  return {
    rewrite: false,
    text: `hive's default ${f.file} changed since you forked it${pct != null ? ` (${pct}% diverged)` : ""}`,
  };
}

function cmdProfile(argv: string[]): void {
  const [sub, ...rest] = argv;
  const positional = rest.filter((a) => !a.startsWith("--"));
  const name = positional[0];

  try {
    switch (sub) {
      case undefined:
      case "list": {
        const names = profileNames();
        if (names.length === 0) {
          console.log("No profiles found. hive ships orchestration and simple; check your install.");
          return;
        }
        // Works anywhere, so the current project is a bonus, not a requirement.
        const here = findProjectForCwd();
        const current = here ? activeProfile(loadProjectYml(here.path).config) : null;
        for (const profile of names) {
          const status = profileStatus(profile);
          console.log(`${profile === current ? "*" : " "} ${profile}`);
          for (const f of status.files) {
            const drift = profileDriftText(f);
            console.log(`    ${f.file.padEnd(11)} ${f.source.padEnd(7)} ${f.path}${drift ? `   (${drift.text})` : ""}`);
          }
        }
        if (current) console.log(`\n* is this project's profile.`);
        return;
      }
      case "path": {
        if (!name) profileUsage();
        if (!profileExists(name)) {
          console.log(`No profile named "${name}". List them with: hive profile list`);
          process.exit(1);
        }
        const only = asProfileFile(positional[1]);
        for (const file of only ? [only] : PROFILE_FILES) {
          const resolved = resolveProfileFile(name, file);
          if (resolved) console.log(resolved.path);
        }
        return;
      }
      case "fork": {
        if (!name) profileUsage();
        const { copied, skipped } = forkProfile(name, asProfileFile(positional[1]));
        for (const file of copied) console.log(`forked ${file} -> ${join(userProfilesDir(), name, file)}`);
        for (const file of skipped) console.log(`kept your ${file} (already forked)`);
        if (copied.length === 0 && skipped.length === 0) console.log(`Profile "${name}" ships no files to fork.`);
        return;
      }
      case "create": {
        if (!name) profileUsage();
        const fromIndex = rest.indexOf("--from");
        const from = fromIndex >= 0 ? rest[fromIndex + 1] : undefined;
        const dir = createProfile(name, from);
        console.log(`Created ${dir}`);
        console.log(`Use it with "profile: ${name}" in a project's hive.yml.`);
        return;
      }
      default:
        profileUsage();
    }
  } catch (e) {
    if (e instanceof ProfileError) {
      console.log(errorMessage(e));
      process.exit(1);
    }
    throw e;
  }
}

function cmdAttach(path?: string): void {
  const project = resolveProject(path);
  const session = sessionName();
  // Pad 79, T5(b), and the PR gate's finding on the first version of this
  // fix. Two DIFFERENT ways cmdAttach can reach a project with no window of
  // its own: a truly cold store (ensureSession CREATES the session, so its
  // first window is an ordinary, unstamped shell - claim that one) and a
  // WARM store where the session exists but carries only OTHER projects'
  // windows, because their `hive lead` ran first and this project's never
  // has (create a new one). The first version of this fix only handled the
  // cold case, gated on started.created alone, and left the warm-but-absent
  // case to attach()'s two callers with no window to give them: in tmux,
  // resolveInTmuxTarget's `!windowId` returns null and attach() does nothing
  // at all, silently, exit 0; outside tmux, resolveAttachTarget's
  // conditional select-window spread just drops, landing the human on a
  // view showing whatever base's CURRENT window happens to be - plausibly
  // another project's, the exact pop-into-a-stranger's-tab failure this
  // whole design exists to prevent. The fix is the same shape cmdLead's own
  // !foundWindow branch, launchAgent's create path, and splitTargetWindow's
  // create path already use: the claim's job is "this project HAS a
  // window", not "stamp whichever window ensureSession happened to create".
  // withWindowClaim, matching every other read-then-create site todo 277
  // covers (cmdLead's two branches, launchAgent's two): everything below is
  // one read-then-create, and racing a `hive lead` for the same project is a
  // fifth unguarded window race - the exact class T2 closed at the other
  // four - without it.
  const window = withWindowClaim(() => {
    const started = ensureSession(session, project.path);
    if (started.created) {
      configureHiveWindow(started.window, true, project.id);
      tmux("rename-window", "-t", started.window, project.name);
      return started.window;
    }
    const found = findProjectWindow(session, project.id);
    if (found) return found;
    // Not createWindow (src/tmux.ts): it always respawn-pane -k's a real
    // command into the pane, and there is nothing to launch here - a plain
    // shell for the human, same reasoning as the cold-store branch above.
    const created = tmux(
      "new-window", "-P", "-F", "#{session_name}:#{window_id}",
      "-t", `=${session}`, "-n", project.name, "-c", project.path,
    );
    configureHiveWindow(created, true, project.id);
    return created;
  });
  attach(session, project, window);
}

async function cmdStart(name?: string, path?: string): Promise<void> {
  if (!name) {
    console.log("Usage: hive start <process> [path]");
    process.exit(1);
  }
  const project = resolveProject(path);
  const { config, warnings } = loadProjectYml(project.path);
  for (const w of warnings) console.log(`! ${w}`);
  const proc = config?.processes[name];
  if (!proc) {
    const known = Object.keys(config?.processes ?? {});
    console.log(
      known.length > 0
        ? `No process "${name}" in hive.yml. Defined: ${known.join(", ")}`
        : "This project has no hive.yml processes.",
    );
    process.exit(1);
  }
  if (await ensureTrusted(project.id, name, proc.command, proc.dir, proc.env)) {
    console.log(`${name}: ${startYmlCommand(project, name, proc)}`);
  }
}

function cmdStatus(): void {
  janitor();
  let anyOutput = false;
  // sessionName() is invariant for the whole process (one store-scoped
  // session), so the listing below is identical on every iteration of the
  // loop - fetched at most once here and matched per project against the
  // shared result, rather than forking `tmux list-windows` once per project
  // for the same answer. Lazy, not hoisted above the loop unconditionally:
  // a project with no running agents/todos/timers never reaches the window
  // lookup at all (see the `continue` below), so the common "nothing
  // running" case still costs zero forks, exactly as before this change.
  let windows: [string, string][] | null | undefined;
  let windowsError: unknown;
  const ownedWindows = (): [string, string][] | null => {
    if (windows === undefined) {
      try {
        windows = listOwnedWindows(sessionName());
      } catch (e) {
        windows = null;
        windowsError = e;
      }
    }
    return windows;
  };
  for (const project of listProjects()) {
    const agents = db
      .prepare("SELECT * FROM agents WHERE project_id = ? AND status = 'running' ORDER BY kind DESC, id")
      .all(project.id) as (ProvenanceRow & {
      kind: string;
      name: string;
      tmux_target: string;
      cwd: string;
    })[];
    // archived_at IS NULL (#15): an archived todo can still carry status
    // 'open' or 'in_progress' (archived and completed are independent axes),
    // and this count exists to answer "is there live work here" at cold
    // boot - the exact moment archiving a closed lane's scaffolding is for.
    // Counting an archived row here would make the number climb forever
    // regardless of archiving, the same noise #15 exists to remove.
    const todos = (
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM todos WHERE project_id = ? AND status IN ('open', 'in_progress') AND archived_at IS NULL",
        )
        .get(project.id) as { n: number }
    ).n;
    // Issue #27. held is the half that was invisible before this lane: a
    // wake stuck behind a modal choice read identically to one simply not
    // due yet in the plain pending count. COUNT(held_at) skips NULLs, so one
    // query over the same PENDING row set (ACTIVE_TIMER_WHERE) gets both
    // numbers without a second round trip. NOT a guarantee that this only
    // ever counts a wake stuck right now, though - counselors A4: the held
    // write itself is guarded against a concurrent claim, but the clearing
    // write (deliver()'s bestEffortRun) is best-effort and can silently lose
    // to SQLITE_BUSY under lock contention, which the file's own comment on
    // that write calls the ordinary case, not the exotic one. This count can
    // then include a wake that delivered fine moments ago whose clearing
    // write simply never landed.
    const { timers, heldWakes } = db
      .prepare(
        `SELECT COUNT(*) AS timers, COUNT(held_at) AS heldWakes FROM timers WHERE project_id = ? AND ${ACTIVE_TIMER_WHERE}`,
      )
      .get(project.id) as { timers: number; heldWakes: number };
    if (agents.length === 0 && todos === 0 && timers === 0) continue;
    anyOutput = true;
    // Todo 272 / plan-lane-3-tmux-topology: found by the lead by RUNNING the
    // command, not by the suite. Under one store-scoped session this used to
    // print the identical `session: hive-<tag>main` for every project -
    // correct and useless, since the session no longer identifies a
    // project; its WINDOW does (@hive-project-id, findProjectWindow). Best-
    // effort: a project with open todos but no tmux session at all yet (the
    // lead never started) is the ordinary case, not a failure - tmux answers
    // "no such session" for it (tmuxSaysNothingThere), same as "no window
    // stamped for this project" reads.
    //
    // CORRECTED (review gate on PR #116, the ubuntu legs' first real pass):
    // the prior wording here named two paths into "unknown (tmux
    // unreachable)" and neither actually reaches it. A MISSING tmux BINARY
    // does not: tmuxSaysNothingThere() returns true for e.notInstalled by
    // design (src/tmux.ts, "no tmux binary: nothing tmux manages can be
    // alive either"), so it takes the SAME "none yet" branch as "the lead
    // never started" - correctly, not as a gap to close. Special-casing
    // notInstalled here to give it a distinct label would fight that design
    // for one call site; a machine with no tmux at all has nothing alive for
    // hive to report, and `hive doctor` is where that absence gets named. A
    // REFUSED CROSS-SERVER PAIRING does not reach here either:
    // listOwnedWindows never calls untrustedTmuxServer(), so
    // crossServerRefusal cannot be thrown from this path - that refusal
    // comes out of ensureSession, elsewhere in this file. What DOES reach
    // "unknown" is any tmux error tmuxSaysNothingThere does not recognise -
    // a transient socket failure, say - so the label is reachable, just not
    // by either case this comment used to name.
    let windowLabel: string;
    const fetched = ownedWindows();
    if (fetched) {
      windowLabel = fetched.find(([, ownerId]) => Number(ownerId) === project.id)?.[0] ?? "none yet";
    } else {
      windowLabel = tmuxSaysNothingThere(windowsError) ? "none yet" : "unknown (tmux unreachable)";
    }
    console.log(`\n${project.name}  (${project.path})  window: ${windowLabel}`);
    for (const a of agents) {
      // Not probed: this is display over rows already in hand, the same
      // choice kickoff makes and for the same reason (see its own comment) --
      // a status line should not cost a tmux fork per worker to print. A
      // command row (a dev server, not a hook-tracked worker) has no
      // provenance to report at all; "running" is the whole fact.
      const state = a.kind === "agent" ? describeForHuman(deriveProvenance(a, null)) : "running";
      // Issue #27's L4 fix round, DECISION 4. This used to be a two-way
      // ternary (command vs. everything else), so a lead's own row printed
      // as `agent  lead  running` - indistinguishable from an actual worker
      // named "lead" would be, and wrong on the one row this project has
      // exactly one of.
      const label = a.kind === "command" ? "cmd  " : a.kind === LEAD_KIND ? "lead " : "agent";
      console.log(`  ${label}  ${a.name.padEnd(20)} ${state}`);
      // Issue #72. A plain SQL query, not a tmux probe, so it costs nothing
      // the "not probed" comment above is protecting against. This is
      // deliberately a DIFFERENT fact from `state` on the line above: `state`
      // is the row that explains the current LATCH (deriveProvenance stops
      // looking once it finds one matching row); this is the log's own last
      // entry regardless of whether it moved the latch. The two usually
      // agree; when they do not (e.g. a notify|unchanged fired after the row
      // that actually explains the latch), that gap is itself information a
      // lead cannot get from the line above. No pane signal here on purpose
      // -- that needs a capture-pane fork per row, which this function's own
      // "not probed" design forbids; `agent_list` and `hive doctor` are
      // where that cost is already being paid.
      if (reportsAgentStateLog(a)) {
        console.log(`         last log event: ${describeLastLogEvent(lastLogEvent(a.actor_id))}`);
      }
    }
    if (agents.length === 0) console.log("  no running agents or commands");
    console.log(
      `  open todos: ${todos}   pending wake-ups: ${timers}${heldWakes > 0 ? ` (${heldWakes} held)` : ""}`,
    );
  }
  if (!anyOutput) console.log("Nothing running and no open work in any project.");
}

// doctor's two non-failing levels, beside check()'s ok/FAIL. The prefix width
// and the continuation indent are load-bearing (the suite asserts on the
// spacing), so they live in one place rather than being retyped per line.
const report = (level: string, label: string, lines: string[]) => {
  console.log(`  ${level}  ${label}: ${lines[0]}`);
  for (const line of lines.slice(1)) console.log(`        ${line}`);
};
const info = (label: string, ...lines: string[]) => report("info", label, lines);
// TWO WARN FUNCTIONS, WHICH IS THE ONE BIT OF CLASSIFICATION `--strict` NEEDS,
// and the split is deliberately expressed as a name rather than a boolean
// argument: `gatingWarn(...)` at a call site is greppable, and a new check
// written as plain `warn(...)` is non-gating without its author deciding
// anything.
//
// THAT DEFAULT IS THE LOAD-BEARING HALF, not a convenience. Doctor's warns
// divide into "this install is wrong" and "something is true about your
// machine that you may not care about", and `--strict` promoting both is a
// flag that cannot return 0 on the machines it exists for: doctor warns about
// the lead row after EVERY normal session exit, and a registered project
// pinning a sub-floor Node warns on every run by design. The README tells you
// to put --strict in an update chain, so as first shipped it broke that chain
// on a healthy machine. Both counselors seats found it independently.
//
// Defaulting to non-gating also closes the ordering hazard this lane was built
// around, structurally instead of by remembering it: a warn added by a future
// lane cannot start failing somebody's update script the day it lands. Its
// author has to opt in.
//
// Two counters rather than one because the summary line reports both: every
// warn is printed and counted, and only the gating ones become problems under
// --strict. Module-level for the same reason report/info/warn are -
// reportDispatcher and friends sit outside cmdDoctor's closure - and doctor
// runs once per process and exits, so they live exactly as long as the run.
let warnings = 0;
let gatingWarnings = 0;
const warn = (label: string, ...lines: string[]) => {
  warnings += 1;
  report("warn", label, lines);
};
// For a state where hive itself is misconfigured: the dispatcher, the MCP
// registration, the addon. README calls these "the whole reason you ran
// doctor", and they are what an update script exists to catch.
const gatingWarn = (label: string, ...lines: string[]) => {
  gatingWarnings += 1;
  warn(label, ...lines);
};

function cmdSetup(argv: string[]): void {
  const dirFlag = argv.indexOf("--dir");
  const dir = dirFlag >= 0 ? resolve(argv[dirFlag + 1] ?? "") : dispatcherDir();
  const file = join(dir, "hive");
  const node = process.execPath;
  const cli = cliPath();

  // Validated before any write, dispatcher included: an unknown value should
  // never reach config.json, where it would silently read back as "auto" at
  // resolve time instead of failing here where a human can see it. Presence
  // is checked separately from the value itself: flagValue alone cannot tell
  // "--attach" with nothing after it from "--attach" never passed at all,
  // and the former deserves the same rejection as an unknown mode name.
  const attachRequested = argv.includes("--attach");
  const attachValue = flagValue(argv, "--attach");
  let attachArg: AttachMode | undefined;
  if (attachRequested) {
    if (!isAttachMode(attachValue)) {
      console.log(`--attach must be one of: ${ATTACH_MODES.join(", ")} (got ${attachValue ?? "nothing"})`);
      process.exit(1);
    }
    attachArg = attachValue;
  }

  const autoAttachRequested = argv.includes("--auto-attach");
  const autoAttachValue = flagValue(argv, "--auto-attach");
  let autoAttachArg: AutoAttach | undefined;
  if (autoAttachRequested) {
    if (!isAutoAttach(autoAttachValue)) {
      console.log(
        `--auto-attach must be one of: ${AUTO_ATTACH_MODES.join(", ")} (got ${autoAttachValue ?? "nothing"})`,
      );
      process.exit(1);
    }
    autoAttachArg = autoAttachValue;
  }

  const existing = readDispatcher(file);
  if (existing && !existing.mine && !argv.includes("--force")) {
    // Almost always npm link's shim, and overwriting someone else's `hive`
    // without being asked is not hive's call to make. A file hive wrote is
    // always repairable, even when an older version wrote it in a shape this
    // one cannot parse: repairing it is what setup is for.
    console.log(`${file} exists and was not written by hive setup; refusing to overwrite it.`);
    console.log("Move it aside, pick another directory with --dir, or overwrite it with --force.");
    process.exit(1);
  }

  mkdirSync(dir, { recursive: true });
  writeFileSync(file, dispatcherScript(node, cli));
  chmodSync(file, 0o755);

  const rewritten = existing?.mine && (existing.node !== node || existing.cli !== cli);
  console.log(`${existing?.mine ? (rewritten ? "Re-pinned" : "Refreshed") : "Wrote"} ${file}`);
  if (rewritten) console.log(`  was          ${existing.node ?? "an unrecognized exec line"} ${existing.cli ?? ""}`.trimEnd());
  console.log(`  interpreter  ${node}`);
  console.log(`               ${process.version}, NODE_MODULE_VERSION ${process.versions.modules}`);
  console.log(`  runs         ${cli}`);
  // WHAT THIS SENTENCE USED TO SAY WAS FALSE TWICE OVER, and it was printed at
  // every setup: "That is the interpreter that built better-sqlite3 here, so
  // the dispatcher and the addon cannot disagree about the ABI." Nothing built
  // better-sqlite3 here - 13 ships a prebuild and the install picks a file -
  // and they CAN still disagree, through the Node-API floor rather than a
  // NODE_MODULE_VERSION.
  //
  // The pin survives that correction with a better justification than the one
  // it lost, which is why this is rewritten rather than deleted. A version
  // manager resolves a bare `node` per directory, and a directory can pin a
  // Node below the addon's Node-API level; under one of those the addon does
  // not raise anything hive could report, the process dies inside dlopen. So
  // the pin is what stops a `cd` from producing a hive that segfaults.
  //
  // The range is DERIVED, never written here. Same reason abi.ts reads the
  // level out of better-sqlite3's own binding.gyp: a constant in hive would
  // keep printing 22.14.0 the day the dependency raises NAPI_VERSION, and
  // being confidently specific is worse than being unspecific.
  const need = requiredNodeApi();
  const range = need === null ? null : nodeRangeForNodeApi(need);
  console.log("\n`hive` now runs under that interpreter from any directory, whatever `node` a");
  console.log("version manager resolves there. better-sqlite3's addon needs a Node providing");
  console.log(
    range
      ? `Node-API ${need} (${range}); below that it does not fail, it dies inside dlopen.`
      : `Node-API ${need ?? "the level its binding.gyp names"}; below that it does not fail, it dies inside dlopen.`,
  );

  // An absent --attach leaves the stored value alone; setup only ever writes
  // it when asked. README:238 tells everyone to run this after every update,
  // so a bare `hive setup` that reset the setting to its default would read
  // as a hive bug on every rebuild. Echoed the way the interpreter above is,
  // whether this run changed it or not.
  if (attachArg) setAttachMode(attachArg);
  if (autoAttachArg) setAutoAttach(autoAttachArg);
  console.log(`\nattach mode  ${attachMode()}`);
  console.log(`auto-attach  ${resolvedAutoAttach().value}`);
  if (attachArg === "raw") {
    console.log("\nRecommended ~/.tmux.conf setting for raw attach mode:");
    for (const line of RAW_ATTACH_TMUX_CONFIG) console.log(`  ${line}`);
    console.log(`\nWhy these, and what else helps: ${TMUX_DOC}`);
  }

  console.log("");
  for (const line of durabilityLines(node)) console.log(line);

  console.log("\nA rebuild does not re-pin anything on its own. After every update:");
  console.log("  npm install && npm run build && hive setup");
  console.log(`\nPATH: ${pathAdvice(dir, file).join("\n")}`);
  reportSetupRegistrations(node);
}

// The half setup does not fix. Pinning the `hive` command says nothing about
// the MCP server: Claude Code starts that from its own registration, and the
// issue calls it the invisible failure precisely because fixing the command
// looks like fixing everything. Setup is the moment a user is already acting
// on instructions, so a registration that disagrees with the pin gets named
// here rather than waiting for them to run doctor.
//
// Conditional on purpose. A correct registration prints nothing: handing
// someone a command to run when they have nothing to fix trains them to
// ignore the ones that matter.
//
// Silent when nothing is registered, which is the case worth explaining.
// Setup cannot tell "not registered" from "registered somewhere I cannot
// see": it looks at one config dir and, at best, one project's .mcp.json,
// while a registration can live in any project on the machine or under
// another CLAUDE_CONFIG_DIR. Announcing an absence hive cannot establish
// would be wrong on every update for anyone who registered elsewhere. A fresh
// install gets that line from the README, one step below this command, and
// `hive doctor` reports it as info from inside a project.
function reportSetupRegistrations(pinned: string): void {
  const found = hiveRegistrations(findProjectForCwd()?.path ?? null);
  const problems = found
    .map((r) => ({ r, lines: registrationProblem(r, pinned) }))
    .filter((p): p is { r: McpRegistration; lines: string[] } => p.lines !== null);
  if (problems.length > 0) {
    console.log("\n! hive setup pins the `hive` command, not the MCP server. Claude Code starts");
    console.log("  hive's server from its own registration, and this one disagrees:");
    for (const { r, lines } of problems) {
      console.log(`  mcp registration (${r.scope} scope): ${lines[0]}`);
      for (const line of lines.slice(1)) console.log(`  ${line}`);
    }
    return;
  }
  // No "!" here: nothing is wrong. A config that lists MCP servers without
  // hive is a fresh install partway through the README, so this reads as the
  // next step rather than a fault. registrationOffer decides when that claim
  // can be made at all.
  const offer = registrationOffer(pinned, found);
  if (offer) {
    console.log("");
    for (const line of offer) console.log(`  ${line}`);
  }
}

// doctor's half of the same question, asked the way a human asks it: what does
// typing `hive` actually run. Warn, never fail: hive works without a
// dispatcher on a machine with one Node, and the dispatcher is worth having
// only where the working directory can change the answer.
//
// EVERY WARN HERE GATES (todo 292, Chris's call). This is the check an update
// script is running doctor FOR: each of these four says the dispatcher does
// not do its job - written by a version this one cannot read, pinning an
// interpreter that is gone, pinning a build this CLI is not, or losing on PATH
// to something else. None of them is routine and none clears itself. The
// motivating incident is one of these exactly: a dispatcher re-pinned
// backwards with ambient node, caught only by a human reading doctor's middle.
function reportDispatcher(): void {
  const onPath = firstHiveOnPath();
  // Whatever wins on PATH is the honest answer, including a dispatcher written
  // somewhere else with --dir. The default location is the fallback, so a
  // dispatcher that exists but loses to a shim still gets reported.
  const winner = onPath ? readDispatcher(onPath) : null;
  const dispatcher = winner?.mine ? winner : readDispatcher(dispatcherPath());
  if (!dispatcher?.mine) {
    info(
      "dispatcher",
      `none at ${dispatcherPath()}; \`hive setup\` writes one pinned to this build`,
      ...(onPath ? [`\`hive\` on PATH is ${onPath}`] : []),
    );
    return;
  }
  info("dispatcher", `${dispatcher.file} -> ${dispatcher.node ?? "an exec line hive cannot parse"}`);
  if (!dispatcher.node || !dispatcher.cli) {
    gatingWarn("dispatcher", "written by another version of hive; re-run `hive setup` to refresh it.");
  } else if (!existsSync(dispatcher.node)) {
    // Todo 307. NAMES THE PATH IN THE WARN ITSELF, not only on the info line
    // above it: this is the check that has to survive being read on its own,
    // in a grep of an update script's output, on the day a version manager
    // pruned one Node out of twenty-two.
    //
    // THE ADVICE THIS REPLACED COULD NOT WORK, in both of its halves.
    // "npm install && npm run build" is from the retired model where the
    // addon was built here; nothing about a rebuild puts the missing
    // interpreter back. And the trailing bare `hive setup` is the loop
    // .claude/rules/native-addon.md names - except worse here than where that
    // rule found it, because `hive` on PATH IS this dispatcher and its exec
    // line points at a file that no longer exists, so the command does not
    // re-pin the wrong Node, it fails outright with an exec error naming a
    // path the user has never heard of.
    // Same fallback wording abi.ts's own fix lines use, rather than a fourth
    // phrasing of one fact.
    const need = requiredNodeApi();
    const range = (need === null ? null : nodeRangeForNodeApi(need)) ?? "that Node-API level";
    gatingWarn(
      "dispatcher",
      `the interpreter it pins is gone: ${dispatcher.node}`,
      "A version manager can remove one. Typing `hive` now fails with an exec error, and the",
      "SessionStart hook loses the interpreter it re-execs into when a project's own `node`",
      "cannot load the addon - a session there prints the addon banner instead.",
      "Re-pin by naming a Node that exists (setup pins whatever Node runs it, and the `hive`",
      "on PATH is this dispatcher):",
      `  <a Node matching ${range}> "${cliPath()}" setup`,
    );
  } else if (dispatcher.node !== process.execPath || dispatcher.cli !== cliPath()) {
    gatingWarn(
      "dispatcher",
      "pinned to a different build than this CLI is running.",
      `this run: ${process.execPath} ${cliPath()}`,
      "Re-pin after a rebuild: npm run build && hive setup",
    );
  }
  if (onPath !== dispatcher.file) gatingWarn("dispatcher", ...pathAdvice(dispatcherDir(), dispatcher.file));
}

// Todo 306. The one question doctor never asked, and the reason a sub-floor
// project sat unnoticed for as long as it existed: can a session STARTING IN
// ANOTHER PROJECT load the addon? Everything above this point is about the
// machine hive is installed on and the directory doctor was run from.
//
// THIS CHANGES WHAT DOCTOR IS, from "how is it here" to "how is it on this
// machine", and that is the biggest thing in the todo rather than a check
// bolted onto an existing loop. cmdDoctor had no project loop at all -
// listProjects() is imported in this file for `hive status`, which is the
// other command that already reports every project regardless of scope, so
// this is consistent with what a diagnostic surface does here rather than a
// new posture. Nothing project-scoped is read: only each project's own
// directory is touched, by spawning an interpreter in it.
//
// ONLY PROJECTS WITH A hive.yml, because that is kickoff's own gate on both
// sides - claude-plugin/kickoff.mjs returns before its ABI check without one,
// and src/kickoff.ts's gate 2 returns before it can reach the store. A
// registered project with no hive.yml never reaches the addon at session
// start, so a warning about its interpreter would be a warning about nothing.
// The residual runs the other way and cannot be closed from here: a directory
// that HAS a hive.yml but was never registered does reach the addon, and
// doctor can only enumerate what the store knows about.
//
// COSTS ONE CHILD PROCESS PER PROJECT, which is what asking about another
// interpreter costs - checkAbi() answers for the process it runs in, so there
// is no in-process version of this question. Doctor is the tool a human runs
// to look closely, not one in a polling loop; the same trade is already made
// for the per-worker capture-pane forks below.
//
// TWO COSTS THAT ARE ACCEPTED RATHER THAN UNNOTICED, both raised by counselors:
//
// The `existsSync` below is a SYNCHRONOUS stat per registered project, and it
// runs BEFORE any timeout can apply - PROBE_TIMEOUT_MS bounds the spawn, not
// this. A project recorded on a hard-mounted unresponsive share blocks it
// uninterruptibly and doctor never returns. Accepted: every project in this
// store is a local checkout, and a mount in that state breaks the store's own
// worktrees and every other hive command long before doctor reaches this line.
// Worth reconsidering the day a project path can be a network mount.
//
// The loop is SERIAL, so the cost is N spawns end to end (~27ms each here, see
// sessionProbe.ts) and, in the pathological case, N times the probe timeout
// behind hung shims. Concurrency would cap the second number at one timeout;
// it is not built because it makes cmdDoctor async for a quarter second on a
// human-invoked command, and doctor already forks tmux serially throughout.
function reportSessionInterpreters(): void {
  // PROJECT LOCK, and it is the reason this loop can shrink to one row. Every
  // spawned worker gets HIVE_PROJECT_LOCK=1, CLAUDE.md says that disables
  // cross-project access entirely, and doctor is a command workers run. Before
  // this lane doctor was cwd-scoped, so the lock had nothing here to
  // constrain; a machine-wide loop that prints every project's absolute path
  // and spawns a process in each is new reach into a locked context. Under a
  // lock, report only the project the session is pinned to. Not an argument
  // that the invariant does not apply to a diagnostic - it is cheaper to obey
  // it than to carve out an exception, and `hive status`'s own machine-wide
  // listing is not a precedent this lane needs to lean on.
  const locked = process.env.HIVE_PROJECT_LOCK === "1";
  const here = locked ? findProjectForCwd() : null;
  const registered = locked ? (here ? [here] : []) : listProjects();
  const projects = registered.filter((p) => existsSync(join(p.path, "hive.yml")));
  if (projects.length === 0) return;
  info(
    "session interpreters",
    "one `node` resolved per project directory, with this process's own environment.",
    "That is how a version manager resolves the bare `node` the SessionStart hook runs under;",
    "a session started from a different environment can resolve a different interpreter.",
    ...(locked ? ["this project only: HIVE_PROJECT_LOCK is set for this session."] : []),
  );
  // Resolved at most once per doctor run, and only if some project needs it.
  // reexecTarget() now PROBES the pinned interpreter rather than stat'ing it,
  // so it costs a spawn; a machine where every project loads the addon never
  // pays for it.
  let resolved: ReexecTarget | undefined;
  const target = () => (resolved ??= reexecTarget());
  for (const project of projects) {
    const verdict = sessionStartVerdict(probeSessionInterpreter(project.path), target);
    // The path is in the LABEL, not the first line: a healthy project is then
    // one line naming the directory, the interpreter and the verdict, and the
    // report stays readable with ten projects on it.
    //
    // NON-GATING (todo 292), which is the plain `warn` below and not an
    // oversight: sessionProbe.ts's own header says ALWAYS A WARN, NEVER A
    // FAIL, because a project pinning a Node below the addon's floor is
    // another project's legitimate business. It also warns on EVERY run for as
    // long as that project exists, so gating it would make --strict
    // permanently non-zero on the exact machine todo 306 was built for.
    const emit = verdict.level === "warn" ? warn : info;
    emit(`project ${project.name} (${project.path})`, ...verdict.lines);
  }
}

// Warn, never fail. A machine with no version manager is fine with a bare
// `node`, and doctor must not fail over a registration it cannot see: hive
// can be perfectly installed and never registered from this directory.
//
// The registration warn GATES (todo 292): a registration that disagrees with
// the pin is the single most consequential thing doctor reports for an update
// flow - it is what says the dispatcher and the MCP server now name different
// Nodes - and it is the condition an update script exists to catch. The
// "nothing is registered" line above it stays an info, because that is a fresh
// install partway through the README rather than a fault.
function reportMcpRegistrations(project: Project | null): void {
  const registrations = hiveRegistrations(project?.path ?? null);
  if (registrations.length === 0) {
    info(
      "mcp registration",
      "none found for hive (checked ~/.claude.json and .mcp.json)",
      // Same helper as setup, so the fresh-install offer reads identically
      // wherever a user meets it, and stays silent in the same three states.
      ...(registrationOffer(process.execPath, registrations) ?? []),
    );
    return;
  }
  for (const r of registrations) {
    const where = `mcp registration (${r.scope} scope)`;
    info(where, [r.command, ...r.args].join(" "));
    const problem = registrationProblem(r, process.execPath);
    if (problem) gatingWarn(where, ...problem);
  }
}

// --strict promotes GATING warns to problems for the EXIT CODE. Bare `hive
// doctor` keeps its old semantics exactly - 0 clean, 1 on failures, warns
// count for nothing - because doctor warns during ordinary healthy operation,
// and an exit code that fires on a benign expected condition is one a script's
// author learns to ignore. That is the failure mode todo 292 exists to fix.
//
// The gating/non-gating split is what makes the flag usable at all, and it is
// the correction to this lane's first shape: promoting EVERY warn made
// --strict exit 1 after any normal session exit, and permanently on a machine
// with a registered sub-floor project. See the two warn functions above.
//
// The unknown-argument refusal is not decoration: `hive doctor --stict` has to
// fail loudly rather than run a non-gating doctor and report success. That is
// the same shape todo 298 closed on the MCP surface, where a misspelled key
// silently disarmed a guard, and an update script gating on --strict is
// exactly the caller that would never notice.
// Todo 311. The 2026-08-07 morning incident: a box hit its PTY ceiling (518
// allocated against kern.tty.ptmx_max=511), every tmux new-session/split/
// respawn failed with "fork failed: Device not configured", and that string
// named nothing a human could act on -- the path from it to "you are out of
// PTYs" took five separate probes across a whole morning while both lanes
// stalled. This is the check that string should have pointed at.
//
// Not `check()`: ptyHeadroom() never throws (see src/ptys.ts), and an
// unsupported platform or a probe failure both mean "say nothing", a third
// outcome `check()`'s ok/FAIL pair has no room for.
function reportPtyHeadroom(): void {
  const headroom = ptyHeadroom();
  if (!headroom) {
    // Unmeasurable platform (anything but darwin/linux) or a probe failure
    // (missing sysctl, unreadable /proc, no `ps` on PATH). Silence,
    // deliberately -- this is one additive, read-only check inside a
    // command that already has plenty of other reasons to be red.
    return;
  }
  const free = headroom.max - headroom.allocated;
  // "in use", not "allocated", and the word is load-bearing on darwin: what
  // was measured there is ttys with a live process on them, which is a LOWER
  // BOUND on what the kernel has allocated, not the allocation itself. See
  // ptyHeadroom's own comment for why that is the best available probe (macOS
  // publishes kern.tty.ptmx_max and NO counter to go with it -- checked, the
  // whole `sysctl -a` tty namespace on this box is that one key) and for the
  // direction the error runs in. Linux's number IS the kernel's count, from
  // /proc/sys/kernel/pty/nr, so one field carries two different KINDS of
  // number and the honest word covers both.
  if (!isLowHeadroom(headroom)) {
    info("ptys", `${headroom.allocated} of ${headroom.max} in use (${free} free)`);
    return;
  }
  // NON-GATING (plain warn(), never gatingWarn()): this names a machine
  // condition worth a look, not a broken hive install, the same distinction
  // todo 292's decision draws for the sub-floor interpreter and hive.yml
  // warns elsewhere in this function.
  //
  // THIS WARN IS MACHINE-STATE-DEPENDENT, and two tests diff doctor's
  // aggregate warning count across two runs and assume the delta is exactly
  // the one warn under test (test/config-warnings.test.mjs,
  // test/interpreter.test.mjs). Accepted, not overlooked, and recorded here
  // because it is this line that would break them: for the delta to move,
  // the box would have to cross the pty threshold in the seconds BETWEEN the
  // two doctor runs, and the only box that does is one already at its
  // ceiling -- where the suite is failing far louder with "fork failed:
  // Device not configured" on every tmux create, which is the incident at
  // the top of this comment. This warn also joins a class rather than
  // creating one: the lead-row warn, stuck foreign-socket rows and a stray
  // view session are all machine-state-dependent already and carry the same
  // exposure. Fixing it would mean teaching the shared warningCount() helper
  // to stop meaning "the number on the summary line", which is the contract
  // two other test files read it for.
  //
  // The orphan count is a CANDIDATE count, not reclaimable capacity, and the
  // reason is NOT that some of them are live -- by construction none of them
  // are, because a live pane's shell is parented to the tmux server and
  // never to launchd (src/ptys.ts, and the dead-end it cites). Measured on a
  // swept box on 2026-08-08: 26 ttys in use, 14 ppid-1 `-zsh`, all dated the
  // previous afternoon, and every live pane's shell parented to a tmux
  // server pid instead. The two real reasons to keep it a candidate count: a
  // DETACHED TERMINAL A HUMAN STILL WANTS also reads as ppid 1, so orphaned
  // is not the same as unwanted; and NOT EVERY PTY IS HELD BY A SHELL, so
  // this is a lower bound on one class of holder rather than headroom you
  // would get back. Worded as "worth looking at", never "you can free N",
  // and left out of the line entirely when it is zero.
  warn(
    "ptys",
    `${headroom.allocated} of ${headroom.max} in use (${free} free), below the safety margin`,
    "worth looking at: orphaned tmux servers on scratch sockets; login shells reparented to " +
      `launchd (ppid 1)${headroom.orphanLoginShells > 0 ? `, ${headroom.orphanLoginShells} resident right now` : ""}`,
    "resolve the live socket with `tmux display-message -p '#{socket_path}'` and kill others BY " +
      "SOCKET: `tmux -S <path> kill-server`. Never by pid -- a pid-to-socket mapping has been " +
      "observed ambiguous on a real row, and getting one wrong kills the live server.",
  );
}

function cmdDoctor(argv: string[]): void {
  const strict = argv.includes("--strict");
  const unknown = argv.find((a) => a !== "--strict");
  if (unknown !== undefined) {
    // stderr: doctor's stdout is the report, and a script reads its summary
    // line off that (.claude/sessions/decisions/2026-08-05-cli-notices-go-to-stderr.md).
    console.error(`hive doctor: unknown argument "${unknown}". The only flag is --strict.`);
    process.exit(1);
  }
  let failures = 0;
  // Same counting and FAIL formatting as check()'s catch below, split out for
  // a failure that is not the result of a thrown probe (issue #43's profile
  // checks: there is nothing to call and catch, only a fact already in
  // hand).
  const fail = (label: string, ...lines: string[]) => {
    failures += 1;
    report("FAIL", label, lines);
  };
  const check = (label: string, fn: () => string) => {
    try {
      console.log(`  ok    ${label}: ${fn()}`);
    } catch (e) {
      fail(label, errorMessage(e));
    }
  };
  console.log("hive doctor\n");
  check("node", () => describeInterpreter());
  // Unfailable in practice, and printed anyway: db.ts already guarded this
  // before main() got here, so a mismatch never reaches doctor's body. The
  // line is here so a working install still says which ABI it is pinned to,
  // which is the number a human needs when comparing two interpreters.
  check("better-sqlite3", () => {
    const status = checkAbi();
    if (!status.ok) throw new Error(describeAbi(status));
    return [describeAbi(status), status.addon].join("\n        ");
  });
  check("tmux", () => execFileSync("tmux", ["-V"], { encoding: "utf8" }).trim());
  reportPtyHeadroom();
  check("claude", () => execFileSync("which", ["claude"], { encoding: "utf8" }).trim());
  check("database", () => {
    const n = (db.prepare("SELECT COUNT(*) AS n FROM migrations").get() as { n: number }).n;
    return `${dataDir} (schema v${n})`;
  });
  check("hooks file", () => ensureHooksFile());
  // hive.yml PARSE warnings never fail: a malformed key already has a
  // fallback (loadProjectYml), and hive cannot tell a deliberately omitted
  // var from a forgotten one. Doctor used to read the profile out of
  // hive.yml without ever looking at the parse, so a malformed one passed a
  // clean run; that half stays a warn.
  //
  // The PROFILE checks below (1-3) call fail(), deliberately, even though
  // profiles are per-machine and hive.yml is committed -- the premise check
  // 1 itself rests on. Counselors review on PR #47 named the consequence:
  // `hive doctor` now exits 1 for a teammate whose machine lacks a profile
  // this repo's hive.yml names, which reaches any script or CI step gating
  // on it. That is the point, not an oversight -- issue #43 opens with
  // exactly this state, a lead running with no standing process and nothing
  // saying why, and a warn would report it just as loudly without ever
  // stopping a script that should stop.
  const here = findProjectForCwd();
  reportDispatcher();
  reportMcpRegistrations(here);
  reportSessionInterpreters();
  // Counselors review on PR #47, finding 3. `here` is null on a fresh clone:
  // nothing has registered the project yet, which is issue #43's own opening
  // scenario -- a lead has not started here before, so no project row exists.
  // hive.yml is still readable from the cwd doctor is actually run from, so
  // checks 1 and 2 below must not gate on `here`. Only check 3 needs it, for
  // here.id's pad lookup.
  const loaded = loadProjectYml(here?.path ?? process.cwd());
  // NON-GATING: a malformed key in a project's committed config is not this
  // install being wrong, and hive cannot tell a deliberately omitted var from
  // a forgotten one.
  for (const w of loaded.warnings) warn("hive.yml", w);
  const config = loaded.config;
  const profile = activeProfile(config);

  // Issue #43, sharpened by counselors review on PR #47 (findings 5 and 6).
  // Two early returns, so the vars-reporting tail sits at one indent level
  // rather than three.
  //
  // Check 1: a profile profileExists() cannot find is a lead starting with
  // no standing process and nothing saying why (kickoff.ts's own silence
  // there is correct; nothing else looked).
  //
  // Check 2 is keyed on READABLE CONTENT, not on whether profileStatus
  // resolved a path: resolveProfileFile accepts any existing path, including
  // one that is not a regular file, and readProfileFile turns a read failure
  // into null rather than throwing. A profileStatus that only checked
  // existence would call `profiles/broken/posture.md` (a directory) healthy
  // while `hive posture`/`hive runbook` both come back empty for it, which
  // contradicts the "nothing usable" this check exists to catch.
  //
  // runbook.md gets its own failure, separate from "nothing at all is
  // readable": a profile can legitimately ship fewer than all three files
  // (profiles/simple/ ships only posture.md, and `hive profile create`
  // itself writes only posture.md by default), so a missing worker.md or
  // posture.md alone stays quiet. runbook.md is different: it is the lead's
  // standing process, and its absence is the identical end state
  // profile: none already FAILs for when there is no runbook pad (check 3)
  // -- and it is gated the SAME way check 3 is, on that same pad. Chris
  // caught this by running it: profiles/simple/ is a profile hive itself
  // ships, and a project on it whose process legitimately lives in a
  // runbook pad was told its install was broken, ignoring the exact escape
  // hatch check 3 depends on three lines below. Only consult the pad when
  // `here` exists: on a fresh clone there is no project row and so no pad
  // to have, and that case correctly still FAILs (counselors finding 3).
  const reportProfile = (name: string, cfg: ReturnType<typeof loadProjectYml>["config"]) => {
    if (!profileExists(name)) {
      fail("profile", `"${name}" is named in hive.yml but is not on this machine. List what you have with: hive profile list`);
      return;
    }
    const resolved = profileStatus(name).files;
    const readable = (file: ProfileFile) => readProfileFile(name, file) != null;
    if (!resolved.some((f) => readable(f.file))) {
      fail("profile", `"${name}" has a directory but none of its files (${PROFILE_FILES.join(", ")}) resolve to readable content, here or in hive's shipped defaults.`);
      return;
    }
    const hasRunbookPad = here != null && getActivePadByName(here.id, "runbook") != null;
    if (!readable("runbook.md") && !hasRunbookPad) {
      fail("profile", `"${name}" has no readable runbook.md, here or in hive's shipped defaults, so a lead using it starts with no standing process.`);
    }
    const usable = resolved.filter((f) => readable(f.file));
    info("profile", `${name} (${usable.map((f) => `${f.file}: ${f.source}`).join(", ")})`);
    for (const f of resolved) {
      // NON-GATING, and todo 292's own body names this one as the example of
      // an advisory warn: a fork that has diverged from hive's default is a
      // decision left to the human, not a broken install.
      //
      // Todo 326 comment 721: for a fork that is a deliberate REWRITE rather
      // than drift, this warn can never clear - it fires again every time
      // hive's shipped default moves, forever, regardless of how the fork got
      // there or how good it is. Measured on this project's own orchestration
      // fork: 100% of doctor's warning output, permanently, and it got LOUDER
      // the night a real improvement landed in the fork. Past
      // REWRITE_THRESHOLD the fork shares too few lines with hive's default
      // to read as an edited copy of it, so this drops to `info` and says so
      // instead of repeating a warning that was never actionable. Wording and
      // the percentage come from profileDriftText, shared with `hive profile
      // list` so the two never disagree about the same file.
      const drift = profileDriftText(f);
      if (drift) (drift.rewrite ? info : warn)("profile", drift.text);
    }
    // Both files the project supplies vars to. worker.md is left out on
    // purpose: its vars include the agent identity hive fills in per spawn,
    // which would always read as "not set here".
    const referenced = [...new Set(
      ["runbook.md", "posture.md"].flatMap((file) => {
        const text = readProfileFile(name, file as ProfileFile);
        return text ? templateVars(text) : [];
      }),
    )].sort();
    const defined = Object.keys(cfg?.vars ?? {});
    const missing = referenced.filter((v) => !defined.includes(v));
    const unused = defined.filter((v) => !referenced.includes(v));
    if (referenced.length > 0) {
      info("profile vars", `runbook and posture reference ${referenced.join(", ")}`);
      if (missing.length > 0) info("profile vars", `not set here (sections drop): ${missing.join(", ")}`);
      if (unused.length > 0) info("profile vars", `defined but unreferenced: ${unused.join(", ")}`);
    }
  };

  // `here &&` is gone from this branch (counselors finding 3): a fresh
  // clone, before anything registers the project, has hive.yml on disk and
  // no project row, and issue #43 opens with exactly that case. Check 3
  // keeps `here &&`, because it needs here.id for the pad lookup.
  if (profile) {
    reportProfile(profile, config);
  } else if (here && config?.profile === NO_PROFILE && !getActivePadByName(here.id, "runbook")) {
    // Check 3. cmdRunbook (above) already knows this state is where the
    // standing process lives nowhere; doctor is where that should surface
    // before a lead starts, not after `hive runbook` comes back empty. A
    // project with no profile: key at all is out of scope, deliberately:
    // that is a legitimate, quiet default, not this state.
    fail("profile", `this project ${NO_RUNBOOK_PAD_MESSAGE}`);
  }
  // L1 (design-l1, issue #38) deliberately does not add a per-worker
  // provenance/age listing here. Doctor has never had one -- this check
  // reports the SWEEP's own outcome (counts of what it closed or cancelled),
  // not a per-agent line -- and `hive status` is already that surface, freshly
  // decorated with provenance in the same lane. Duplicating it here would be a
  // surface touched for symmetry rather than because a reader needs it there,
  // and doctor must not gain a check that passes or fails on how old a state
  // is: that is lane L2, and it was redesigned away from a bound after a query
  // against the live store, so building one here would ship the discarded
  // design a second time.
  check("stale state", () => {
    const r = janitor();
    // "0 closed" reads as a clean bill of health, so an unanswered probe must
    // not print it. Doctor is the tool a human runs BECAUSE tmux is
    // misbehaving; saying nothing is the one thing it must not do.
    if (!r.probed) {
      // "Re-run when tmux responds" is useless advice when the sweep was
      // refused rather than unanswered: retrying never helps, because tmux is
      // answering fine and hive is declining to believe it about this store.
      // Doctor is the tool a human runs to find out why, so it has to be able
      // to tell the two apart.
      if (untrustedTmuxServer()) {
        throw new Error(
          `TMUX_TMPDIR points at a private tmux server (${process.env.TMUX_TMPDIR}) while hive is ` +
            `using its default store at ${DEFAULT_DATA_DIR}. Nothing was swept, deliberately: the ` +
            "agents in that store live on the shared tmux server, so this one would report every " +
            "single one of them as dead. Unset TMUX_TMPDIR, or set HIVE_DATA_DIR to a scratch store " +
            "to go with the private server.",
        );
      }
      throw new Error("tmux did not answer, so nothing was swept. Re-run when tmux responds.");
    }
    return `${r.closed_agents} dead agents closed, ${r.cancelled_timers} undeliverable wake-ups cancelled`;
  });
  // DECISION 3's other half: the janitor now deliberately never closes a
  // kind='lead' row on its own (see ensureLeadRow's comment, src/cli.ts), so
  // a lead whose pane died stays status='running' silently unless something
  // says so. This is that something, gated on `here` for the same reason the
  // profile checks above are: a fresh clone has no project row yet.
  if (here) {
    // Issue #27's L4 fix round R10, todo 182 item 3 (opus F5). ORDER BY id:
    // ensureLeadRow's own comment (this file) documents that a pre-fix
    // `hive lead` server can still leave TWO running kind='lead' rows for one
    // project (idx_agents_running_name constrains name, not kind), and a
    // .get() with no ordering picks whichever SQLite happens to return
    // first - non-deterministic across otherwise-identical runs. Todo 179
    // item 4 fixed the identical defect in ensureLeadRow's own sibling
    // lookup and left this one; this is that fix's other half.
    const lead = db
      .prepare(
        "SELECT tmux_target, tmux_socket FROM agents WHERE project_id = ? AND kind = ? AND status = 'running' ORDER BY id",
      )
      .get(here.id, LEAD_KIND) as { tmux_target: string; tmux_socket: string } | undefined;
    if (lead) {
      // Issue #73, D6: a foreign socket reads unknown, same branch as an
      // unanswered probe below - never misreported as a confirmed-dead lead
      // this doctor run would otherwise tell a human to retire.
      const live = rowLive(lead.tmux_socket, lead.tmux_target);
      if (live === false) {
        // Issue #27's L4 fix round R9, todo 176 item 3. Two remedies now,
        // named: restart the SAME identity (`hive lead`), or retire it for
        // good with agent_close, which finally exists because a lead is no
        // longer immortal - and matters here specifically because a running
        // lead row is what makes `hive restore` refuse unconditionally.
        //
        // Issue #27's L4 fix round R10, todo 182 item 2 (opus F4). agent_close
        // is an MCP TOOL, not a `hive` CLI verb - this message used to say
        // "`agent_close` it" as if it were one, which sends a human at a bare
        // terminal (this check's own audience) looking for a subcommand that
        // does not exist. The only way to reach it is a live MCP session
        // against this store (a claude session with the hive MCP server
        // running), and that session itself holds hive.db open - relevant
        // here because the retirement is usually a step on the way to `hive
        // restore`, which needs every such session closed first anyway. Named
        // both: what agent_close actually is, and to end that session before
        // restoring, rather than adding a CLI verb whose only job would be
        // reaching a tool that already exists (see this todo's own comment
        // for the fuller argument).
        // NON-GATING (todo 292), and this is the warn that decided the
        // whole shape. It fires after EVERY normal session exit, by design -
        // the janitor deliberately leaves lead rows alone - and it clears
        // itself on the next `hive lead`. Promoting it under --strict is what
        // made that flag unable to return 0 on a healthy machine.
        warn(
          "lead",
          "the lead's row is running but its pane is not live. The janitor leaves lead rows alone on " +
            "purpose, so nothing will fix this by itself. Run `hive lead` to record a fresh pane and reuse " +
            "this identity, or ask a claude session connected to this project's hive MCP server to call " +
            "the agent_close tool on it to retire the row for good - required before `hive restore`, which " +
            "otherwise refuses while any lead row reads running, and end that session too, since it also " +
            "holds this store open.",
        );
      } else if (live === null) {
        warn("lead", "the lead's pane liveness could not be probed (tmux did not answer).");
      }
    }
    // Issue #73 counselors F4, the honest cost of D2/D4/D6's own refusal to
    // guess. A worker/command row whose recorded socket disagrees with this
    // process's own reads unknown, never dead, so the janitor sweep above
    // never closes it. Pre-#73 the identical row was closed WRONGLY -
    // probing the wrong server and getting a false "dead" - so it was
    // self-clearing; post-#73 it is correct but stuck 'running' forever,
    // its name stays taken against requireNameFree, agent_close throws
    // probeFailed on it, and hive restore counts it as active usage, with
    // no signal anywhere that anything is wrong. This names it instead of
    // building a retire-without-killing path (new surface on an
    // already-deep lane): visible-and-stuck is a state a human can act on,
    // silent-and-stuck is not.
    const stuck = db
      .prepare(
        "SELECT name, kind, tmux_socket FROM agents WHERE project_id = ? AND status = 'running' AND kind != ?",
      )
      .all(here.id, LEAD_KIND) as { name: string; kind: string; tmux_socket: string }[];
    for (const row of stuck) {
      if (!foreignSocket(row.tmux_socket)) continue;
      warn(
        `${row.kind} ${row.name}`,
        `recorded on tmux socket ${row.tmux_socket}, but this process would use ` +
          `${tmuxSocketPath(process.env.TMUX, process.env.TMUX_TMPDIR)}. The janitor cannot judge this row ` +
          "from here, so it stays 'running' - and its name stays taken - until it is probed from wherever " +
          "that socket actually lives.",
      );
    }
  }
  // Issue #72. NOT the per-worker listing the L1 comment on the "stale
  // state" check above declines to add: that decision was specifically
  // about duplicating `hive status`'s LATCH-based provenance line here for
  // symmetry. This is different information -- the actor's log regardless
  // of whether the latch moved, plus what the pane shows right now --
  // neither of which exists in `hive status` or anywhere else in doctor
  // today. Unconditional info lines, one per running claude worker, the same
  // reporting-only shape src/kickoff.ts already uses for its own per-worker
  // listing: never ok/warn/FAIL here, because a check that passes or fails
  // on how old a state is is exactly the bound/threshold/verdict
  // stateProvenance.ts's docstring and the L1 comment above both forbid
  // adding. A reader judges the age and the pane for themselves.
  //
  // Costs one capture-pane fork per running claude worker, unlike `hive
  // status`'s deliberately-not-probed line for the same signal (see its own
  // comment): doctor is the tool a human runs to look closely, not one
  // scripted into a tight polling loop, so that cost is worth paying here.
  //
  // Fix round 1, item 11 (the seats disagreed on this one). When tmux is
  // unreachable, the "stale state" check above already FAILs once with the
  // server-level fact; every row in the loop below then independently
  // forks capture-pane, gets nothing, and prints its own
  // `pane: could not be read` -- N lines restating one cause. Accepted
  // rather than special-cased: `r` (the janitor's own probed flag, the one
  // signal that would let this loop skip itself) is scoped inside that
  // check's own callback and not in hand here, and hoisting it out to save
  // doctor N redundant-but-individually-true lines on an already-rare path
  // (tmux unreachable) is not worth restructuring the check for. Each line
  // is still honest about the one pane it tried and failed to read.
  if (here) {
    const workers = db
      .prepare(
        "SELECT name, actor_id, command, kind, tmux_target, tmux_socket FROM agents WHERE project_id = ? AND status = 'running' AND kind = 'agent' ORDER BY id",
      )
      .all(here.id) as {
      name: string;
      actor_id: string;
      command: string;
      kind: string;
      tmux_target: string;
      tmux_socket: string;
    }[];
    // Todo 319. Nothing told you `inputBoxState`'s chrome-matching had
    // drifted, and every guard resting on it (the scheduler's wake hold,
    // agent_send's text refusal, agent_rename's refusal) fails SILENTLY when
    // it does - it reverts to pre-guard behaviour with no receipt field to
    // read, because a successful send/wake/rename carries no `input_box` at
    // all (`input_box` only appears on agent_status/agent_output, and on the
    // refusal that has by definition stopped firing). Full argument:
    // .claude/rules/tmux-and-panes.md's "unknown exemption" section.
    //
    // "unknown" is a SPECIFIC fact, not "the pane could not be read": it
    // means INPUT_BOX_PRESENT matched (claude has control, a box is on
    // screen) but findInputBoxRow could not find the prompt row inside it -
    // i.e. the box is there and the glyph/NBSP marker that finds it is not.
    // `null` (mid-turn, a real dialog, an unreadable pane, OR INPUT_BOX_PRESENT
    // itself no longer matching at all) is none of that and must not be
    // counted here - collapsing the two was rejected once already for a
    // sibling probe (.claude/sessions/dead-ends/2026-07-28-null-on-any-probe-
    // failure.md) and the reasoning transfers.
    //
    // COUNSELORS ON THIS LANE'S OWN PR, BOTH SEATS INDEPENDENTLY: the first
    // version incremented a single "checked" counter before classifying, so a
    // null read was silently counted as "classified cleanly" alongside a real
    // clean read. The dangerous case: a TOTAL chrome drift - INPUT_BOX_PRESENT
    // itself stops matching (src/tmux.ts's own `if (!INPUT_BOX_PRESENT.test
    // (raw)) return null`) - makes every worker read null, never "unknown",
    // and the old counter reported "N of N classified cleanly" during the
    // exact failure this check exists to catch. Three states now, reported
    // separately, each incremented only after the read: `inputBoxClean`,
    // `inputBoxDrifted` (the PARTIAL-drift case this check can actually
    // catch: a box is on screen, its prompt row is not), and
    // `inputBoxUnclassified` (null - nothing this check can say about it).
    // See the rule-file correction next to `inputBoxDrifted > 0` below for
    // what this does and does not close.
    let inputBoxClean = 0;
    let inputBoxDrifted = 0;
    let inputBoxUnclassified = 0;
    for (const w of workers) {
      if (!reportsAgentStateLog(w)) continue;
      // Issue #73 counselors F2. This used to call paneChoiceCheck
      // unconditionally, with no socket check at all: a foreign-socket row
      // (D2/D6) had its OWN pane id probed against THIS process's server
      // instead, and any pane genuinely alive here under that id was
      // captured and reported as if it were this worker's real screen.
      // foreignSocket() must gate the capture the same way rowLive/rowAlive
      // gate every other reader of this fact - stated plainly below rather
      // than folded silently into the ordinary "could not be read" case,
      // which reads as a transient tmux hiccup, not a structural refusal.
      const foreign = foreignSocket(w.tmux_socket);
      const { awaitingChoice, tail } = foreign
        ? { awaitingChoice: null, tail: "" }
        : paneChoiceCheck(w.tmux_target);
      // Fix round 1, item 1 (found independently by both counselors seats).
      // This used to print the tail only when awaitingChoice === true, which
      // drops it in exactly the case worker-state.md's #38 exists to
      // surface: a worker latched `working` after an API error, sitting
      // quietly with no dialog on screen. awaitingChoice is false there --
      // correctly, there is no dialog -- so the old gate printed
      // `pane: no dialog` with nothing else, identical to a healthy worker
      // mid-turn. The tail is the ONLY field this lane reports that carries
      // worker-state.md's own discriminator verbatim ("whose pane shows an
      // error and an empty input box"), so doctor -- the close-look surface
      // -- prints it unconditionally rather than gating it on the one
      // boolean that is exactly wrong for the case that matters most.
      // Fix round 2, item 3(b), corrected by fix round 3 (PR gate). An empty
      // tail (sanitizeTail returns "" when the pane rendered nothing
      // survivable, e.g. a blank screen) used to print the "tail:" header
      // anyway, promising content and then showing a single blank
      // continuation line -- reachable with no tmux failure at all. Named as
      // its own fact instead of an empty rendering.
      //
      // tail === "" is NOT one fact, though -- it is true for two different
      // reasons that paneChoiceCheck's own comment (src/tmux.ts) already
      // keeps apart: the capture SUCCEEDED and every visible line was blank
      // (awaitingChoice: false, a real read), or the capture FAILED outright
      // -- the pane died, capture-pane threw -- and paneChoiceCheck's catch
      // returns {awaitingChoice: null, tail: ""} having read NOTHING. Round
      // 2's fix collapsed both onto "(pane rendered nothing)", which for the
      // null case asserts a successful blank read that never happened --
      // this lane's own report-do-not-infer rule, broken by the exact line
      // meant to stop conflating two facts into one string. Branch on
      // awaitingChoice === null first, consistent with the `pane:` line
      // immediately above, which already tells the two apart. Do not
      // re-merge these: unreadable, read-but-empty and read-with-content are
      // three distinct facts, not two.
      // Fix round 2, item 4 (opus). Every non-empty tail line is prefixed
      // with "| " so a WORKER's own screen text can never be read as
      // DOCTOR's verdict vocabulary. Without this, a worker whose last six
      // screen lines happen to contain "  warn  worker ...:" (e.g. it just
      // ran `hive doctor` in its own pane) gets that text interleaved into
      // the lead's doctor report at the same continuation indent report()
      // uses for its own ok/warn/FAIL lines, indistinguishable from a real
      // verdict to a human skimming the output. Do not remove this prefix as
      // decoration; it exists to keep worker-controlled text out of
      // doctor's own vocabulary.
      info(
        `worker ${w.name}`,
        `last log event: ${describeLastLogEvent(lastLogEvent(w.actor_id))}`,
        foreign
          ? `pane: recorded on a different tmux socket (${w.tmux_socket}); this process cannot read it`
          : `pane: ${describePaneChoice(awaitingChoice)}`,
        ...(foreign
          ? ["tail: (not read - foreign socket)"]
          : awaitingChoice === null
            ? ["tail: (pane could not be read)"]
            : tail === ""
              ? ["tail: (pane rendered nothing)"]
              : ["tail:", ...tail.split("\n").map((line) => `| ${line}`)]),
      );
      // A SECOND capture-pane fork per worker, deliberately not fused with
      // paneChoiceCheck's read above it: that read is plain, this one needs
      // `-e` for the ghost/pending discriminator, and the two serializers
      // disagree about which rows are blank (tmux-and-panes.md, "the two
      // pane reads are deliberately NOT fused"). Measured cost (same file):
      // 3.5ms median per fork, plain and `-e` indistinguishable - the same
      // precedent that already justifies the FIRST fork a few lines up
      // (doctor is a close-look tool a human runs, not a polling loop), so a
      // second one here is affordable on the same grounds rather than a new
      // argument.
      if (!foreign) {
        const box = inputBoxState(w.tmux_target);
        // ONLY the observation, not a claim about the rest of the project -
        // that claim needs the RATIO across every probed worker, computed
        // once the loop ends, below. A single unknown pane against otherwise
        // clean ones is pane-specific noise, not the chrome-change signature;
        // saying "every pane" here from one data point was wrong the moment
        // a second worker classified cleanly in the same run and is the
        // exact "right about the code, wrong about why" shape this project
        // keeps re-shipping. Lead review on commit 1f323cf caught it before it
        // merged. NAMING A CAUSE was still wrong even after that fix -
        // counselors on this PR: INPUT_BOX_PRESENT is an unanchored match
        // over up to 18 captured rows (tailCaptureLines), so boxed tool
        // output sitting above a genuine dialog can satisfy it with no prompt
        // row below - "unknown" with no chrome change at all. State only what
        // was observed; the ratio below is what earns any conclusion.
        if (box === null) {
          inputBoxUnclassified += 1;
        } else if (box.state === "unknown") {
          inputBoxDrifted += 1;
          warn(
            `worker ${w.name}`,
            "input box classifies 'unknown': an input box is on screen (INPUT_BOX_PRESENT matched) but its prompt " +
              "row could not be found inside it (.claude/rules/tmux-and-panes.md, the 'unknown exemption' section).",
          );
        } else {
          inputBoxClean += 1;
        }
      }
    }
    // THE POSITIVE CASE, UNCONDITIONALLY, when any worker was actually
    // probed above: a check silent on a clean run is indistinguishable from
    // a check that never ran, which is this whole todo's defect restated one
    // level up. THREE STATES, ARITHMETIC NOT INFERENCE: clean, drifted
    // ("unknown"), and unclassified (null - nothing this check can say about
    // why). Counselors' fix: reporting only clean-vs-checked let a null read
    // launder into "classified cleanly" (see the counter comment above).
    const inputBoxChecked = inputBoxClean + inputBoxDrifted + inputBoxUnclassified;
    // ACCEPT AND RECORD (lead triage on this PR): silence here is deliberate,
    // not a residual of the null bug above. inputBoxChecked is 0 only when
    // every running claude worker was foreign-socket (none reachable to
    // probe) or there were no running claude workers at all - doctor already
    // names the running crew, if any, in the per-worker loop above, so there
    // is genuinely nothing left to report for this check specifically.
    if (inputBoxChecked > 0) {
      info(
        "input box classifier",
        `${inputBoxChecked} running claude worker box(es) probed: ${inputBoxClean} classified cleanly, ` +
          `${inputBoxDrifted} classified 'unknown', ${inputBoxUnclassified} not classified (no box currently on ` +
          "screen to classify - a dialog, mid-turn, or an unreadable pane)",
      );
      // THE PROJECT-SCOPED CLAIM BELONGS HERE, ON THE RATIO, NOT ON A SINGLE
      // WORKER'S WARN ABOVE. Only when EVERY probed box came back unknown is
      // that the chrome-change signature the three guards' silent-revert
      // argument is actually about; some-but-not-all is a per-pane fact
      // (a genuinely busy/oddly-drawn screen this instant), not chrome drift.
      //
      // "IN THIS PROJECT", NEVER "MACHINE-WIDE" (lead triage on this PR,
      // correcting counselors' own finding on this same sentence): `workers`
      // above is `WHERE project_id = ?` - this check has never seen past one
      // project, so "machine-wide" misdescribed its own scope regardless of
      // how many workers were probed. Say only what was observed.
      if (inputBoxDrifted > 0) {
        warn(
          "input box classifier",
          inputBoxDrifted === inputBoxChecked
            ? "every probed input box in this project classified 'unknown' - the chrome-change signature, not " +
                "pane-specific noise. The wake hold, agent_send's text refusal and agent_rename's refusal have " +
                "likely reverted to pre-guard behaviour across every probed worker in this project " +
                "(.claude/rules/tmux-and-panes.md, the 'unknown exemption' section)."
            : `${inputBoxDrifted} of ${inputBoxChecked} probed input boxes in this project classified 'unknown' - ` +
                "some but not all, so this reads as pane-specific rather than project-wide drift; the guards " +
                "above still work on the other worker(s)' panes.",
        );
      }
    }
    // ACCEPT AND RECORD (lead triage on this PR), NOT WIDENED IN THIS LANE: a
    // lead's own pane is never probed here - `workers` above is `kind =
    // 'agent'` only - though the guards this check exists to protect DO reach
    // it (agent_send's text path and the scheduler's wake hold both can type
    // into a lead's pane, .claude/rules/tmux-and-panes.md's "three of the
    // five" paragraph). REOPEN TRIGGER: probing the lead's row too is a
    // separate change with its own blast radius (a different `kind`, a
    // different liveness path already resolved a few hundred lines up in this
    // function) - do not fold it into this counter set without deciding that
    // on its own.
  }
  // One store-scoped session now, not one per project (pad 76, "3a's SCOPE
  // WIDENED"), so a hive- prefixed session on this server is either THE base
  // session or a transient view session (viewSessionName()) riding along
  // with it. Listed once and shared by the two blocks below: the "sessions"
  // check reports only the base session(s), so what it prints stays true
  // under one session per store; a view session is reported separately, on
  // its own terms, immediately after.
  const hiveSessions = (): string[] => {
    try {
      return execFileSync("tmux", ["ls", "-F", "#{session_name}"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      })
        .trim()
        .split("\n")
        .filter((s) => s.startsWith(SESSION_PREFIX));
    } catch {
      return [];
    }
  };
  const allSessions = hiveSessions();
  check("sessions", () => {
    const base = allSessions.filter((s) => !isViewSessionName(s));
    return base.length > 0 ? base.join(", ") : "none running";
  });
  // Todo 277. The race that produced this is closed (withWindowClaim,
  // src/spawn.ts), and the check stays anyway: the state it names is durable,
  // silent and permanent - findProjectWindow takes the lower-index window
  // forever, so the lead ends up in one tab while parentless splits land in
  // the other, with nothing in normal use ever saying why. A store carried
  // across the fix keeps whatever duplicates it already had, and any future
  // window-stamping site that forgets the claim reintroduces it.
  //
  // FAILS rather than warns, unlike the stray view session above, and the
  // difference is what a human can do about it: a stray view owns no panes
  // and destroy-unattached usually gets it, while two windows stamped for one
  // project silently split that project's own panes across two tabs until
  // somebody moves them. Doctor still only reports - the remedy names the
  // command rather than running it, matching this file's posture everywhere
  // else.
  check("window stamps", () => {
    const session = sessionName();
    // No session is not a finding: list-windows would throw here and this
    // check would FAIL on the ordinary machine where nothing is running.
    if (!allSessions.includes(session)) return "no session";
    const byProject = new Map<string, string[]>();
    for (const [window, owner] of listOwnedWindows(session)) {
      if (owner === "") continue;
      byProject.set(owner, [...(byProject.get(owner) ?? []), window]);
    }
    const duplicates = [...byProject.entries()].filter(([, windows]) => windows.length > 1);
    if (duplicates.length > 0) {
      throw new Error(
        duplicates
          .map(
            ([owner, windows]) =>
              `project ${owner} is stamped on ${windows.length} windows (${windows.join(", ")}). ` +
              "Only the lowest-indexed one is ever found, so this project's lead and its workers can end up " +
              "in different tabs. Move the panes into one window (tmux join-pane -t <window>) and " +
              `unstamp the other (tmux set-window-option -t <window> -u @hive-project-id).`,
          )
          .join("\n        "),
      );
    }
    const stamped = [...byProject.keys()].length;
    return stamped > 0 ? `${stamped} project window(s), no duplicates` : "no project windows";
  });
  // Todo 273, point 7 of pad 76's "VIEW SESSIONS DESIGNED AND SETTLED WITH
  // CHRIS" - Chris's call. REPORT a stray view session, never kill one:
  // destroy-unattached (set on every view at creation) should already make
  // one unreachable the instant its client detaches, and killing sessions is
  // a bigger posture than doctor takes anywhere else. This is belt-and-
  // braces for the case that guard somehow did not fire, not a sweep.
  // Only a CLIENTLESS view is stray - one with a client is in active use,
  // exactly why destroy-unattached has not touched it yet.
  for (const name of allSessions.filter(isViewSessionName)) {
    let hasClient: boolean;
    try {
      hasClient = execFileSync("tmux", ["list-clients", "-t", `=${name}`], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() !== "";
    } catch {
      // Gone between the listing above and this probe - its own
      // destroy-unattached already did doctor's job for it.
      continue;
    }
    if (hasClient) continue;
    // The quotes are load-bearing, not decoration: a bare leading `=` in a
    // command a human pastes into zsh triggers EQUALS EXPANSION
    // (.claude/rules/tmux-and-panes.md, "Two shell traps").
    warn(
      "view session",
      `${name} has no attached client, so it did not clean itself up (destroy-unattached should remove a view ` +
        "the instant its client detaches). Not touched here - a view session owns no panes, so removing it can " +
        `never lose a worker's output, but doctor's own posture stops at reporting. Remove it by hand: ` +
        `tmux kill-session -t '=${name}'`,
    );
  }
  check("backups", () => {
    const health = backupHealth(db, dataDir);
    if (!health.ok) throw new Error(health.message);
    return health.message;
  });
  {
    const { value, source } = resolvedAutoAttach();
    info(
      "auto-attach",
      source === "env"
        ? `${value} (HIVE_AUTO_ATTACH override; testing only)`
        : source === "config"
          ? `${value} (set with \`hive setup --auto-attach\`)`
          : `${value} (default; set with \`hive setup --auto-attach\`)`,
    );
  }
  {
    const { mode, source } = resolvedAttachMode();
    info(
      "attach mode",
      source === "env"
        ? `${mode} (HIVE_ATTACH_MODE override; testing only, does not reach auto-attach)`
        : source === "config"
          ? `${mode} (set with \`hive setup --attach\`)`
          : `${mode} (default; set with \`hive setup --attach\`)`,
    );
    if (mode === "raw") {
      // Globals may stay at their defaults: hive stamps the windows it owns.
      // Inspect those objects, not user configuration. allow-passthrough is a
      // pane option inherited from the window, so -p -A is load-bearing here:
      // show-options -p without -A reports the working inherited value as
      // unset. A missing server or no hive-owned windows is simply no report.
      try {
        const owned = execFileSync(
          "tmux",
          ["list-windows", "-a", "-F", "#{session_name}:#{window_id}\t#{@hive-owned}"],
          { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
        )
          .trim()
          .split("\n")
          .map((row) => row.split("\t"))
          // A window linked into a view session (topology-3c) is listed once
          // PER SESSION it belongs to, so an open view would otherwise print
          // the identical window's options TWICE under two different
          // session-qualified labels - once via the durable base session,
          // once via the view's own transient name. Keep only the base-
          // session copy; the view contributes no window this list does not
          // already have.
          .filter(([target, marker]) => {
            const [sess] = target.split(":");
            return target.startsWith(SESSION_PREFIX) && marker === "1" && !isViewSessionName(sess);
          });
        for (const [target] of owned) {
          const pane = execFileSync("tmux", ["list-panes", "-t", target, "-F", "#{pane_id}"], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
          }).trim().split("\n")[0];
          const option = (scope: "-p" | "-w", optionName: string): string =>
            execFileSync("tmux", ["show-options", scope, "-A", "-v", "-t", scope === "-p" ? pane : target, optionName], {
              encoding: "utf8",
              stdio: ["ignore", "pipe", "ignore"],
            }).trim();
          info(
            `tmux window ${target}`,
            `allow-passthrough ${option("-p", "allow-passthrough")}; ` +
              `pane-border-status ${option("-w", "pane-border-status")}; ` +
              `pane-border-format ${JSON.stringify(option("-w", "pane-border-format"))}; ` +
              `monitor-bell ${option("-w", "monitor-bell")}`,
          );
        }
      } catch {
        // Doctor already reports tmux availability; an object disappearing
        // during inspection must not turn cosmetic diagnostics into failure.
      }
    }
  }
  // THE SUMMARY LINE CARRIES BOTH COUNTS, and that is what makes this
  // testable. Exit codes saturate at 1, so a test comparing two of them
  // proves nothing on a box where an unrelated check already fails - the
  // recorded dead-end is a doctor test that would have gone green on the
  // regression it existed to catch
  // (.claude/sessions/dead-ends/2026-07-28-exit-code-comparison-as-environment-proof.md).
  // Counts do not saturate: a --strict run and a bare run of the same doctor
  // differ by exactly the warn count, on any machine, however many unrelated
  // checks are failing on it.
  //
  // "All good." now means what it says. It used to print with warns on
  // screen, which is half of what todo 292 reported.
  // ONLY THE GATING WARNS ARE PROMOTED. Every warn still prints and still
  // counts on the line below; --strict decides which ones become problems.
  // See the two warn functions above for why the default is non-gating.
  const problems = failures + (strict ? gatingWarnings : 0);
  const tail = strict
    ? `${warnings} warning(s), ${gatingWarnings} promoted by --strict.`
    : `${warnings} warning(s).`;
  console.log(
    failures === 0 && warnings === 0 ? "\nAll good." : `\n${problems} problem(s) found, ${tail}`,
  );
  process.exit(problems === 0 ? 0 : 1);
}

// One-line store summary for embedding in a shell prompt or Claude Code
// status line. Prints nothing outside a registered project, and never
// registers one; status lines run in every directory a session opens.
function cmdStatusline(): void {
  let project: Project | null;
  try {
    project = pinnedOrCwdProject();
  } catch {
    // pinnedOrCwdProject can throw (a missing/mismatched agents-row pin) -
    // that is the right behavior for cmdTodos/cmdTodo, which run once, on
    // purpose, and can afford to be loud. A status line redraws on every
    // prompt, so the same throw here would print the pin error on every
    // render and exit non-zero forever, breaking this function's own "prints
    // nothing" contract. The loud path belongs to the commands a human
    // actually runs, not to a line that redraws whether they asked or not.
    return;
  }
  if (!project) return;
  const count = (sql: string) => (db.prepare(sql).get(project.id) as { n: number }).n;
  const agents = count(
    "SELECT COUNT(*) AS n FROM agents WHERE project_id = ? AND status = 'running' AND kind = 'agent'",
  );
  const commands = count(
    "SELECT COUNT(*) AS n FROM agents WHERE project_id = ? AND status = 'running' AND kind = 'command'",
  );
  // archived_at IS NULL (#15): same reasoning as cmdStatus and kickoff's
  // digest - a status line must stop counting a lane once it is archived,
  // or the number it prints on every redraw never reflects the archiving.
  const todos = count(
    "SELECT COUNT(*) AS n FROM todos WHERE project_id = ? AND status IN ('open', 'in_progress') AND archived_at IS NULL",
  );
  const ready = count(
    `SELECT COUNT(*) AS n FROM todos t
     WHERE t.project_id = ? AND t.status IN ('open', 'in_progress') AND t.archived_at IS NULL
       AND NOT EXISTS (${OPEN_BLOCKERS_SQL})`,
  );
  const pads = count("SELECT COUNT(*) AS n FROM scratchpads WHERE project_id = ? AND archived = 0");
  const wakes = count(`SELECT COUNT(*) AS n FROM timers WHERE project_id = ? AND ${ACTIVE_TIMER_WHERE}`);

  // A project can get registered by a single passing tool call; an all-zero
  // row is noise, so only projects with live state get a status line.
  if (agents + commands + todos + pads + wakes === 0) return;

  const s = (n: number) => (n === 1 ? "" : "s");
  const parts = [
    `${agents} agent${s(agents)}`,
    `${todos} todo${s(todos)}${todos > 0 ? ` (${ready} ready)` : ""}`,
    `${pads} pad${s(pads)}`,
  ];
  if (commands > 0) parts.push(`${commands} cmd${s(commands)}`);
  if (wakes > 0) parts.push(`${wakes} wake${s(wakes)}`);
  console.log(`\x1b[33m⬡\x1b[0m \x1b[2mhive:\x1b[0m ${parts.join(" \x1b[2m·\x1b[0m ")}`);
}

function padSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "pad";
}

const padExportPrefix = (projectId: number, name: string) =>
  `hive-pad-${projectId}-${padSlug(name)}.r`;

function findPadExports(projectId: number, name: string): string[] {
  const prefix = padExportPrefix(projectId, name);
  return readdirSync(tmpdir())
    .filter((f) => f.startsWith(prefix) && f.endsWith(".md"))
    .map((f) => join(tmpdir(), f));
}

function cmdBackups(): void {
  const snapshots = listSnapshots(dataDir);
  if (snapshots.length === 0) {
    console.log(`No backups yet in ${backupsDir(dataDir)}.`);
    console.log("They are taken automatically before migrations and hourly while any hive session is open.");
    return;
  }
  for (const s of snapshots) {
    console.log(
      `${s.name}  ${s.reason.padEnd(9)} ${formatBytes(s.sizeBytes).padStart(7)}  ${s.createdAt.toISOString()}`,
    );
  }
  console.log(`\n${snapshots.length} backup(s), ${formatBytes(totalSizeBytes(snapshots))} total, in ${backupsDir(dataDir)}`);
  console.log(`Restore one with: hive restore <name>`);
}

// Whether anything hive can SEE looks like it is using this store right now
// (PR #36, S1). Two independent signals, because either alone misses a real
// case hive itself created: `agents` catches a worker or command whose row is
// stale before its own tmux session would tell you, while a running tmux
// session catches a live lead even if its row's signal is momentarily wrong.
// Store-wide, not scoped to the current project: hive.db is one file shared
// across every project in it, and a restore replaces all of it, so a running
// worker in an unrelated project is just as much a reason to refuse as one in
// this one.
//
// A lead row is NOT trustworthy by status alone (issue #27's L4 fix round,
// DECISION 3): it deliberately stays 'running' after its own session ends,
// until the next `hive lead` re-records a live pane, so counting it the same
// way as a worker's row would make this refusal latch forever the first time
// any project ever runs `hive lead` - the tmux-session signal below already
// covers a lead that IS still live, which is why a lead row is excluded here
// UNLESS its own pane also probes live. Not an unconditional kind='lead'
// exclusion: a store whose live tmux session does not happen to match
// SESSION_PREFIX (a different tag, a probe that fails) would lose the
// live-lead case entirely if this signal did not also catch it.
//
// This is not, and cannot be, a complete answer to "is anything using this
// store" (C6): a claude session started directly rather than through hive
// holds the same hive.db open with neither signal present, and nothing
// checked here or anywhere else would see it. Name only what this function
// actually establishes at its call site; do not let the comment there claim
// more than this one does.
function activeHiveUsage(): string[] {
  const reasons: string[] = [];
  const runningNonLeads = (
    db.prepare("SELECT COUNT(*) AS c FROM agents WHERE status = 'running' AND kind != ?").get(LEAD_KIND) as {
      c: number;
    }
  ).c;
  if (runningNonLeads > 0) reasons.push(`${runningNonLeads} agent(s)/command(s) recorded as running`);

  // Issue #27's L4 fix round R9, todo 176 (BOTH SEATS, codex HIGH). This used
  // to probe each lead row's pane liveness (targetAlive against a
  // liveTargets() snapshot, todo 173) and only count a row as active usage
  // when the probe found it alive. Two failure directions, from one root
  // cause: a lead row is IMMORTAL (the janitor exempts kind='lead', DECISION
  // 3; agent_close refused it outright until this same round). Liveness
  // therefore could not be answered by probing - only guessed at - and every
  // guess failed a different way:
  //   - liveTargets() answers an EMPTY snapshot in essentially one realistic
  //     case: "no server running", because a live server always has at
  //     least one pane. That is the ORDINARY state after a reboot - exactly
  //     when a human restores a backup - so todo 173's snapshotEmpty rule
  //     refused restore on every store that had EVER run `hive lead`, with
  //     --force as the only way out. --force also skips the runningNonLeads
  //     check above, so routine use of it costs the signal that catches the
  //     common case (a genuinely running worker).
  //   - A POPULATED wrong server (a legitimate private-tmux/scratch-store
  //     pair, per .claude/rules/tmux-and-panes.md, probed from an ordinary
  //     shell on the shared server) yields a non-empty snapshot that simply
  //     does not contain this row's target. targetAlive correctly answers
  //     false, snapshotEmpty is false, and restore proceeds over a store a
  //     genuinely live lead still has open.
  // Cross-server liveness is not answerable without the socket-on-the-row
  // migration .claude/rules/tmux-and-panes.md already names as a residual.
  // So this stops asking it: any RUNNING kind='lead' row counts as active
  // usage, unconditionally, the same way runningNonLeads above never probes
  // tmux either. What makes this safe rather than a return to R6's own
  // "latches forever" complaint (todo 165) is that a lead row is no longer
  // immortal - agent_close now retires one whose pane is confirmed dead
  // (see src/tools/agents.ts), which converts the unanswerable liveness
  // question into an explicit human action instead of a permanent latch.
  const leadRows = (
    db.prepare("SELECT COUNT(*) AS c FROM agents WHERE status = 'running' AND kind = ?").get(LEAD_KIND) as {
      c: number;
    }
  ).c;
  if (leadRows > 0) {
    // Issue #27's L4 fix round R10, todo 182 item 2 (opus F4). Same fix as
    // doctor's message above: agent_close is an MCP tool, reached from a
    // claude session talking to this project's hive MCP server, not a `hive`
    // CLI verb - and that session has to end before a restore proceeds
    // anyway, since it holds this exact store open.
    reasons.push(
      `${leadRows} lead session(s) recorded as running - run \`hive doctor\` to check whether each is ` +
        "actually live; a confirmed-dead one can be retired by asking a claude session connected to this " +
        "project's hive MCP server to call the agent_close tool on it, which lets a later restore proceed " +
        "without --force. End that session before restoring either way, since it holds this store open too.",
    );
  }

  try {
    const sessions = execFileSync("tmux", ["ls", "-F", "#{session_name}"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .trim()
      .split("\n")
      // A view session (topology-3c) owns no panes of its own - it only
      // borrows the base session's windows - so it can never itself be what
      // holds hive.db open, unlike everything else this function checks.
      // Counting one here would refuse a restore over a spectator terminal
      // that is not really "hive running" in the sense this reason names,
      // and it is exactly the kind of session most likely to exist right as
      // someone runs `hive restore` from a second terminal.
      .filter((s) => s.startsWith(SESSION_PREFIX) && !isViewSessionName(s));
    if (sessions.length > 0) reasons.push(`tmux session(s) still running: ${sessions.join(", ")}`);
  } catch {
    // tmux not installed or unreachable; the agents check above still stands.
  }
  return reasons;
}

async function cmdRestore(argv: string[]): Promise<void> {
  const yes = argv.includes("--yes") || argv.includes("-y");
  const force = argv.includes("--force");
  const name = argv.find((a) => !a.startsWith("-"));
  if (!name) {
    console.log("Usage: hive restore <name> [--yes] [--force]");
    console.log("List available snapshots with: hive backups");
    process.exit(1);
  }

  let preview;
  try {
    preview = previewRestore(dataDir, name);
  } catch (e) {
    console.log(errorMessage(e));
    process.exit(1);
  }

  // Refused, not merely warned about, for the cases this CAN see: renaming a
  // fresh inode over a database another connection still has open, and
  // unlinking its shared -wal, is undefined behaviour per SQLite's own
  // documentation, not just risky UX. Second counselors pass, C6: this is
  // not a guarantee that nothing is using the store, and the comment must
  // not read as one. A claude session started directly rather than through
  // hive holds hive.db open with no agents row and no hive-* tmux session,
  // and this cannot see it. Nor can it see a session that starts in the
  // window between this check and the overwrite below - that gap is real
  // and not closeable by checking earlier or more often. What this line
  // does provide: the common case (a hive-spawned worker, or a live hive
  // session) is caught and stopped rather than merely advised against.
  const activity = activeHiveUsage();
  if (activity.length > 0 && !force) {
    console.log("Refusing to restore: this store looks like it is still in use.");
    for (const reason of activity) console.log(`  ${reason}`);
    console.log(
      "Close those sessions first, or pass --force: a server on this version will refuse every " +
        "hive tool once it notices (up to one tick of writes lost first); an older server has no " +
        "such guard and will keep writing to a file that no longer exists until it exits, losing " +
        "that work silently.",
    );
    process.exit(1);
  }

  console.log("This will overwrite:");
  console.log(
    `  ${preview.currentDbPath}` +
      (preview.currentDbExists ? ` (${formatBytes(preview.currentDbSizeBytes)})` : " (does not exist yet)"),
  );
  if (preview.hasProfiles) console.log(`  ${join(dataDir, "profiles")}`);
  console.log(
    `with the snapshot "${preview.snapshot.name}" (${formatBytes(preview.snapshot.sizeBytes)}, ` +
      `${preview.snapshot.reason}, taken ${preview.snapshot.createdAt.toISOString()}).`,
  );
  console.log("\nRestart every other hive session using this store once this completes.");

  if (!yes) {
    const confirmed = await confirmYesNo("Overwrite the live store with this snapshot? [y/N] ");
    if (confirmed === null) {
      console.log("Not restored: run hive interactively to confirm, or pass --yes.");
      return;
    }
    if (!confirmed) {
      console.log("Not restored.");
      return;
    }
  }

  // One more snapshot of the store as it stands right now, before this
  // destroys it (PR #36, S2): restore is itself the kind of operation this
  // whole feature exists to have a way back from, and until this line
  // nothing did. Logged, not gated on: a failure here must not block a
  // restore the operator already confirmed, so it is reported and then
  // proceeded past rather than thrown.
  //
  // preview.snapshot.name is passed as `protect` (PR #36, C2): without it,
  // this call's own retention pass could prune the RESTORE TARGET itself
  // (ten same-day snapshots plus the default keepLast=10 means this
  // eleventh backup evicts the oldest), and restoreSnapshot would then
  // report the snapshot the operator just confirmed as not existing.
  const preRestoreBackup = backupNow(db, dataDir, "manual", new Set([preview.snapshot.name]));
  if (preRestoreBackup.ok) {
    console.log(`Snapshotted the current store first: ${preRestoreBackup.path}`);
  } else {
    console.log(`Warning: could not snapshot the current store before restoring: ${preRestoreBackup.error}`);
  }

  // The file is about to be replaced out from under this process's own
  // connection; close it first so nothing here races better-sqlite3's own
  // -wal/-shm state against the files restoreSnapshot removes.
  db.close();
  const { restoredProfiles } = restoreSnapshot(dataDir, name);
  console.log(`Restored hive.db from "${name}"${restoredProfiles ? " (and profiles/)" : ""}.`);
}

function flagValue(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i !== -1 ? argv[i + 1] : undefined;
}

// Silent outside a hive project (D5): matches cmdStatusline exactly, via
// pinnedOrCwdProject rather than resolveProject, so a bare `hive todos` never
// registers a project as a side effect the way cmdPads does.
function cmdTodos(argv: string[]): void {
  const project = pinnedOrCwdProject();
  if (!project) return;

  const all = argv.includes("--all");
  const statusIdx = argv.indexOf("--status");
  const status = flagValue(argv, "--status");
  // A missing or unrecognized --status value is a usage error, not a filter
  // that happens to match nothing: without this check, a typo'd status reads
  // as "you have no todos" instead of "that isn't a status" (same failure
  // shape the MCP tool's zod enum already rejects for todo_list).
  if (statusIdx !== -1 && (status === undefined || status.startsWith("--"))) {
    console.log(`Usage: hive todos --status <s>  where <s> is one of: ${TODO_STATUSES.join(", ")}`);
    process.exit(1);
  }
  if (status !== undefined && !(TODO_STATUSES as readonly string[]).includes(status)) {
    console.log(`Unknown status "${status}". Valid: ${TODO_STATUSES.join(", ")}`);
    process.exit(1);
  }
  const tagIdx = argv.indexOf("--tag");
  const tag = flagValue(argv, "--tag");
  // Missing is a usage error the same way it is for --status; UNKNOWN is not,
  // since any string is a legitimate tag and "no todos carry it" is a real,
  // valid empty result rather than a typo.
  if (tagIdx !== -1 && (tag === undefined || tag.startsWith("--"))) {
    console.log("Usage: hive todos --tag <t>");
    process.exit(1);
  }

  // --all and --status share one axis (which statuses to include). Rather
  // than let argv order decide when both are passed, --all wins: it is the
  // more expansive ask, and a result that depends on flag order is a result
  // nobody will remember to check.
  const statuses = all ? undefined : status ? [status] : ["open", "in_progress"];

  const { todos, total_count } = listTodoSummaries(project.id, {
    statuses,
    tags: tag ? [tag] : undefined,
  });
  if (todos.length === 0) {
    // F4: naming the project alone reads as "there are none", which is false
    // whenever the default open/in_progress filter is hiding a completed
    // lane's todos — exactly the case a finished lane's own `issue-<N>` tag
    // (runbook step 13) hits every time. Name the filters that produced this
    // empty result instead, since that holds whether the project is truly
    // empty or just empty under this filter.
    // Same --all-wins-over---status precedence as the real query above
    // (line computing `statuses`): checking `status` first here would
    // describe a narrower filter than the one that actually ran whenever
    // both flags were passed together.
    const statusDesc = all ? "" : status ? `${status} ` : "open ";
    const tagDesc = tag ? ` with tag "${tag}"` : "";
    const hint = all ? "" : " Try --all.";
    console.log(`No ${statusDesc}todos in project "${project.name}"${tagDesc}.${hint}`);
    return;
  }

  const width = Math.max(...todos.map((t) => String(t.todo_id).length));
  for (const t of todos) {
    // One column, not a paragraph (D3): blank when dispatchable, a marker
    // when something else must complete first. Same predicate cmdStatusline
    // uses for its "ready" count, so the two can't disagree.
    const blocked = t.is_blocked ? "blocked" : "";
    console.log(
      `#${String(t.todo_id).padEnd(width)}  ${t.status.padEnd(11)} ${blocked.padEnd(8)} ${t.title}`,
    );
  }
  // No silent caps: listTodoSummaries defaults to 50 rows, and a list this
  // command exists to make readable must say so when it isn't showing all of
  // it, rather than reading as "that's everything".
  if (total_count > todos.length) {
    console.log(`\n...and ${total_count - todos.length} more not shown. Narrow with --status or --tag.`);
  }
}

// Silent outside a hive project (D5), same as cmdTodos and cmdStatusline:
// checked before validating argv, so `hive todo` with no id run outside any
// project stays silent rather than printing a usage line for a project that
// was never going to be registered.
function cmdTodo(argv: string[]): void {
  const project = pinnedOrCwdProject();
  if (!project) return;

  const id = Number(argv.find((a) => !a.startsWith("--")));
  if (!Number.isInteger(id)) {
    console.log("Usage: hive todo <id>  (run inside the project)");
    process.exit(1);
  }
  let d: TodoDetail;
  try {
    d = getTodoDetail(project.id, id, true);
  } catch {
    console.log(`No todo with id ${id} in project "${project.name}". List them with: hive todos --all`);
    process.exit(1);
  }

  console.log(`#${d.todo_id} ${d.title}`);
  console.log(
    `status ${d.status}   priority ${d.priority}${d.is_blocked ? "   blocked" : ""}${d.archived ? "   archived" : ""}`,
  );
  if (d.tags.length > 0) console.log(`tags ${d.tags.join(", ")}`);
  if (d.body) console.log(`\n${d.body}`);

  if (d.blockers.length > 0) {
    console.log(`\nblocked by:`);
    for (const b of d.blockers) console.log(`  #${b.id} [${b.status}] ${b.title}`);
  }
  if (d.blocking.length > 0) {
    console.log(`\nblocks:`);
    for (const b of d.blocking) console.log(`  #${b.id} [${b.status}] ${b.title}`);
  }

  // The comments are the payload (D4/D6): full text, actor attribution, never
  // truncated. A worker's handoff comment cut at 200 chars is the bug this
  // command exists to fix.
  const comments = d.comments ?? [];
  if (comments.length > 0) {
    console.log(`\ncomments:`);
    for (const c of comments) {
      console.log(`\n[${c.author} @ ${c.created_at}]`);
      console.log(c.body);
    }
  }
}

function cmdPads(): void {
  const project = resolveProject();
  const pads = listActivePads(project.id);
  if (pads.length === 0) {
    console.log(`No pads in project "${project.name}".`);
    return;
  }
  const width = Math.max(...pads.map((p) => p.name.length));
  for (const p of pads) {
    console.log(
      `${p.name.padEnd(width)}  rev ${String(p.revision).padStart(3)}  ${String(p.content_length).padStart(6)} chars  ${p.updated_by ?? "?"} @ ${p.updated_at}`,
    );
  }
}

function cmdPad(argv: string[]): void {
  const positional = argv.filter((a) => !a.startsWith("--"));
  const name = positional[0];
  if (!name) {
    console.log("Usage: hive pad <name> [--edit | --save [file]]  (run inside the project)");
    process.exit(1);
  }
  const project = resolveProject();
  const pad = getActivePadByName(project.id, name);
  if (!pad) {
    console.log(`No pad named "${name}" in project "${project.name}". List them with: hive pads`);
    process.exit(1);
  }

  if (argv.includes("--edit")) {
    const existing = findPadExports(project.id, name);
    if (existing.length > 0) {
      console.log(`An unsaved export already exists:\n  ${existing.join("\n  ")}`);
      console.log(`Save it with: hive pad "${name}" --save   (or delete the file to discard)`);
      process.exit(1);
    }
    const file = join(tmpdir(), `${padExportPrefix(project.id, name)}${pad.revision}.md`);
    try {
      // wx: atomic fail-if-exists (also refuses a pre-planted symlink);
      // 0600: pad content stays private to the user.
      writeFileSync(file, pad.content, { flag: "wx", mode: 0o600 });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") {
        console.log(`A file already exists at ${file}; refusing to overwrite it. Save or delete it first.`);
        process.exit(1);
      }
      throw e;
    }
    // "open" launches the system's default app for .md files; HIVE_EDITOR
    // overrides with an explicit command (e.g. HIVE_EDITOR=zed).
    const editor = process.env.HIVE_EDITOR || "open";
    const [cmd, ...cmdArgs] = editor.split(/\s+/);
    spawn(cmd, [...cmdArgs, file], { detached: true, stdio: "ignore" }).unref();
    console.log(file);
    console.log(`Opened "${name}" (rev ${pad.revision}) with ${cmd}. After saving your edits, write back with:`);
    console.log(`  hive pad "${name}" --save`);
    return;
  }

  if (argv.includes("--save")) {
    let file = positional[1];
    if (!file) {
      const matches = findPadExports(project.id, name);
      if (matches.length === 0) {
        console.log(`No exported file for "${name}" in ${tmpdir()}. Export one with: hive pad "${name}" --edit`);
        process.exit(1);
      }
      if (matches.length > 1) {
        console.log(`Multiple exports found; pass one explicitly:\n  ${matches.join("\n  ")}`);
        process.exit(1);
      }
      file = matches[0];
    }
    const content = readFileSync(file, "utf8");
    const marker = /\.r(\d+)\.md$/.exec(file);
    const expected = marker ? Number(marker[1]) : pad.revision;
    if (content === pad.content) {
      unlinkSync(file);
      console.log(`No changes; "${name}" left at rev ${pad.revision}. Removed ${file}.`);
      return;
    }
    try {
      const newRevision = overwritePadContent(project.id, pad.id, content, expected);
      unlinkSync(file);
      console.log(`Saved "${name}": rev ${expected} -> ${newRevision}. Removed ${file}.`);
    } catch (e) {
      console.log(errorMessage(e));
      console.log(`Your edits are untouched in ${file}.`);
      console.log(`Someone changed the pad since the export. Compare with: hive pad "${name}"`);
      console.log(`Then merge into the file and save with: hive pad "${name}" --save ${file}`);
      process.exit(1);
    }
    return;
  }

  process.stdout.write(withTrailingNewline(pad.content));
}

const args = process.argv.slice(2);
let command = args[0] ?? "lead";
let rest = args.slice(1);
if (command === "--help" || command === "-h" || command === "help") usage();
const COMMANDS = [
  "lead", "init", "attach", "start", "status", "setup", "doctor",
  "pads", "pad", "todos", "todo", "backups", "restore", "runbook", "posture", "profile", "kickoff", "statusline",
];
if (!COMMANDS.includes(command)) {
  // `hive <path>` opens that project's session; lead is the default command.
  if (existsSync(command)) {
    rest = [command, ...rest];
    command = "lead";
  } else {
    usage();
  }
}
migrate();
// A bad project pin (src/context.ts's agentProjectPin, now reachable from a
// CLI command via pinnedOrCwdProject/resolveProject rather than only from an
// MCP tool call wrapped by run()/src/result.ts) throws, same as every other
// unhandled error a command below might raise. Without this, that reaches
// the top of the module as an uncaught exception - a raw node stack trace
// instead of the message the error actually carries. Wraps the whole
// dispatch, not just the pin-consulting commands, since any command can
// throw and every one deserves the same clean floor.
try {
  switch (command) {
    case "lead":
      await cmdLead(rest[0]);
      break;
    case "init":
      await cmdInit(rest);
      break;
    case "attach":
      cmdAttach(rest[0]);
      break;
    case "start":
      await cmdStart(rest[0], rest[1]);
      break;
    case "status":
      cmdStatus();
      break;
    case "setup":
      cmdSetup(rest);
      break;
    case "doctor":
      cmdDoctor(rest);
      break;
    case "pads":
      cmdPads();
      break;
    case "pad":
      cmdPad(rest);
      break;
    case "todos":
      cmdTodos(rest);
      break;
    case "todo":
      cmdTodo(rest);
      break;
    case "backups":
      cmdBackups();
      break;
    case "restore":
      await cmdRestore(rest);
      break;
    case "runbook":
      cmdRunbook(rest[0]);
      break;
    case "posture":
      cmdPosture(rest[0]);
      break;
    case "profile":
      cmdProfile(rest);
      break;
    case "kickoff":
      // The plugin hook runs dist/kickoff.js directly, which never opens the
      // store unless a directory earns it. This path is for humans testing
      // the gates by hand, and pays cli.js's own startup cost.
      await (await import("./kickoff.js")).runKickoff(rest);
      break;
    case "statusline":
      cmdStatusline();
      break;
  }
} catch (e) {
  console.log(errorMessage(e));
  process.exit(1);
}
