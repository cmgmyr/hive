import { dataDir, db } from "./db.js";
import {
  applyLayout,
  claimInitialWindow,
  createWindow,
  DEFAULT_LAYOUT,
  ensureSession,
  crossServerRefusal,
  findProjectWindow,
  panePid,
  paneWindow,
  rowLive,
  sessionName,
  tmux,
  tmuxSocketPath,
  untrustedTmuxServer,
  windowOwner,
  windowTitle,
  type WindowLayout,
} from "./tmux.js";

// Todo 277 (counselors codex #2 and opus #3 independently, so certain). ONE
// PROCESS AT A TIME may decide whether this store's session already has a
// window for a project. Four sites used to read that and then create one
// (cmdLead's two branches, launchAgent's two), each an unguarded
// read-then-create: two concurrent creators both saw no window and both made
// one, both stamped for the same project. findProjectWindow uses .find(), so
// the lower-index window then wins FOREVER - the lead attaches to one tab,
// parentless splits land in the other, and nothing detects or reconciles it.
//
// THE LOCK IS THE STORE'S OWN WRITE LOCK, and that is the whole reason this
// works across processes: every hive instance on a machine shares one WAL-mode
// SQLite database (CLAUDE.md), and SQLite allows exactly one writer at a time.
// BEGIN IMMEDIATE takes that writer slot up front rather than on first write,
// so a section that writes nothing still excludes every other section here.
// A second process gets SQLITE_BUSY and waits out db.ts's 5s busy_timeout,
// which is four orders of magnitude more than the few tmux forks inside.
//
// WHY NOT RECONCILE AFTER THE FACT (create, re-list, loser kills the window it
// just made). That was the shape the fix round was briefed with, and it is
// strictly weaker: the reconcile has the SAME read-then-act race one level up.
// Two processes that both create a window and then both re-list can each
// re-list BEFORE the other's stamp lands, each conclude it is the only
// claimant, and keep both windows - the exact state it was supposed to
// remove. It also has to kill a window whose process has already started, and
// in claimInitialWindow's case that window is the session's only one, so
// killing it destroys the session. Excluding the race is cheaper than
// unwinding it.
//
// Two honest limits, stated rather than left to be discovered:
//   - tmux side effects DO NOT roll back with the transaction. A throw inside
//     leaves whatever windows were created; the lock buys mutual exclusion,
//     not atomicity.
//   - a process that dies inside the section releases the lock (SQLite rolls
//     the transaction back on connection loss), which is precisely why this
//     is a transaction and not a leases-table claim with a TTL to get wrong.
//
// THE HAZARD THAT WOULD SILENTLY REMOVE THE EXCLUSION, not merely a limit of
// it, and now REFUSED rather than merely watched for: better-sqlite3 nests a
// transaction inside another one via SAVEPOINT rather than throwing. A
// `claim` called from inside an already-open, DEFERRED outer transaction
// would take no writer slot at all here - the outer transaction already
// holds (or will lazily acquire) whatever lock SQLite gives it, and this
// call would become a no-op savepoint riding along inside it, with the
// read-then-create race this function exists to close back and nothing to
// say so. Until todo 346 this was only checked at review (pad 79 T5) - every
// db.transaction call in src/ that ran before a withWindowClaim call site
// confirmed to sit outside it - and a review-time check protects only the
// code as it stood that day, with nothing enforcing it going forward. The
// guard below closes that: it throws on `db.inTransaction` before
// db.transaction is ever entered, so a future caller wrapping its own call
// to launchAgent, cmdLead, or cmdAttach in a transaction gets a loud refusal
// instead of a silent race. Pinned by test/window-claim-guard.test.mjs.
//
// THE CLAIM MUST NEVER CONTAIN ANYTHING THAT BLOCKS ON A HUMAN. It holds the
// store's only writer slot (BEGIN IMMEDIATE), so a prompt inside it would
// hold every other hive process on this machine hostage to someone reading a
// terminal. hive.yml's trust prompt is the live example of a prompt that
// exists near this code and must stay OUTSIDE the claim: ensureTrusted runs
// well above cmdLead's own claim call, never inside it. This is the same
// shape as .claude/rules/store-and-datadir.md's second accepted residual ("a
// CLI process blocked on an interactive prompt") one level up - that residual
// is about a restore racing an open connection; this is about a lock, but
// the failure mode a blocking prompt would create here is the identical one
// that rule already warns against admitting.
export function withWindowClaim<T>(claim: () => T): T {
  if (db.inTransaction) {
    throw new Error(
      "withWindowClaim was called from inside an already-open transaction. better-sqlite3 nests a " +
        "transaction inside another one as a no-op SAVEPOINT rather than throwing, so this call would " +
        "take no writer slot of its own and the machine-wide window-claim exclusion would silently " +
        "disappear - no error, no failing test, just the read-then-create race back. Move the outer " +
        "transaction so it does not wrap this call, or move the work it does inside this claim instead: " +
        "withWindowClaim must be the outermost transaction on its call stack.",
    );
  }
  return db.transaction(claim).immediate();
}

// The one place that knows the launch protocol shared by MCP agent_spawn and
// the CLI's hive.yml commands: insert the row, derive the actor id, create
// the tmux pane/window, record the target, and roll the row back on failure.

export interface LaunchSpec {
  projectId: number;
  projectName: string;
  projectPath: string;
  name: string;
  kind: "agent" | "command";
  // A callback runs once the row exists, so a caller can build the command
  // from the agent id and actor id (agent_spawn names the worker's brief file
  // after them). Its result is what gets recorded and launched.
  commandString: string | ((ids: { agentId: number; actorId: string }) => string);
  cwd: string;
  env: Record<string, string>;
  placement: "split" | "window";
  // How the lead's window is arranged when placement is "split".
  layout?: WindowLayout;
  parentActor: string;
  // Issue #154, D1. The UUID agent_spawn generated and passed as claude's
  // own --session-id, written on the row in the SAME statement that inserts
  // it - correct even for a worker that dies before its first hook fires.
  // '' for anything that is not a claude worker (D4's gate), matching the
  // "no fact recorded" convention tmux_socket and pane_pid already use.
  sessionId?: string;
}

// Where a split-placed worker's TARGET WINDOW is: THE SPAWNING LEAD's own
// window, resolved from the STORE (pad 71 "THE PLACEMENT RULE, STATED
// ONCE"): parent_actor_id -> that lead's agents row -> tmux_target (a pane
// id) -> its window (paneWindow, src/tmux.ts). Never from ambient
// TMUX_PANE, and never by window NAME - todo 267. The old TMUX_PANE read
// happened to answer the same question by luck of derivation (under one
// shared session, the CALLER's own pane usually IS the spawning lead's
// pane), but "usually" is the defect: a second claude session in the same
// project spawns into ITS OWN window rather than the lead's, because
// TMUX_PANE names whoever called, not who the row says is the parent.
//
// parent.tmux_target must pass rowLive - a live pane on THIS process's own
// tmux server, not a foreign socket's - before its window is trusted. A
// parent row recorded on a socket this process cannot see into must read as
// unresolvable, the same conservative bias every other tmux_target consumer
// in this codebase already has (.claude/rules/tmux-and-panes.md), not as
// "no parent". Skipping this check would let a stale or foreign parent row
// send a worker's pane to a window on a server this process has no business
// trusting.
//
// The `?? findProjectWindow(...)` fallback is the answer for a spawn with no
// resolvable parent: an unattended run, a caller that is not a lead (a raw
// `user:<name>` calling agent_spawn directly has no agents row of its own to
// resolve), or a parent row that failed the liveness check above.
//
// A pure lookup, not a create-and-launch (/simplify review, item 5): returns
// null when the project has no window yet, and the caller creates one via
// createWindow (src/tmux.ts) - the same helper cmdLead and launchAgent's own
// placement="window" branch use. This used to create and claim a window
// itself, returning `{window, pane}` where a non-null pane meant "already
// placed, do not split again" - the exact shape claimInitialWindow's return
// has, meaning the opposite. Splitting the lookup from the creation removes
// that trap along with the six positional parameters this only needed while
// it also created windows.
export function splitTargetWindow(session: string, projectId: number, parentActor: string): string | null {
  // Scoped to status='running' and ordered, NOT a bare lookup by actor_id.
  // A lead's actor_id is DELIBERATELY REUSED across a restart: ensureLeadRow
  // (src/cli.ts) mints a NEW running row that carries the CLOSED row's old
  // actor_id forward, specifically so the closed row's stale tmux_target
  // stays around for stillThere's adoption check. So after any lead
  // close-and-restart, two rows share one actor_id - a closed one holding a
  // STALE pane, and the running one holding the real pane - and an unscoped
  // `WHERE actor_id = ?` with no ORDER BY returns whichever SQLite hands
  // back first, ordinarily the lower (closed) rowid. Two failure shapes from
  // that, both silent: the stale pane reads dead and the worker quietly
  // stops landing next to its lead (falls to findProjectWindow instead, no
  // error); or the stale pane id gets REISSUED by a fresh tmux server (pane
  // ids restart at %0, and a socket PATH is not a server identity - two
  // servers reusing the default path compare equal, tmuxSocketPath's own
  // comment above) and the worker splits into a stranger's window, the exact
  // failure class this lane exists to remove. Same shape as
  // DELIVER_SOCKET_JOIN's own fix (.claude/rules/tmux-and-panes.md): "an
  // unscoped join let a closed row launder a foreign pane past this guard",
  // closed there by scoping to status='running'. ORDER BY id DESC LIMIT 1 on
  // top, matching ensureLeadRow's own reasoning: normal operation should
  // never have two running rows share an actor_id, but the ordering costs
  // nothing and is the honest defense if that invariant is ever wrong.
  // resolveDelivery (src/tools/wakes.ts) carries the identical shape for the
  // identical reason - cross-referenced there and here so a future reader
  // sees one convention, not two.
  const parent = db
    .prepare("SELECT tmux_target, tmux_socket FROM agents WHERE actor_id = ? AND status = 'running' ORDER BY id DESC LIMIT 1")
    .get(parentActor) as { tmux_target: string; tmux_socket: string } | undefined;
  if (parent && rowLive(parent.tmux_socket, parent.tmux_target) === true) {
    const window = paneWindow(parent.tmux_target);
    // Re-qualified with the BASE session passed in here, not whatever
    // session paneWindow() reported - same reasoning and same tmux 3.7b
    // measurement as adoptableWindow's identical re-qualification above:
    // once the lead's window is grouped with a view, list-panes can answer
    // with the VIEW's name, and a view is transient while a split-window
    // target built from it would outlive the view by seconds and fail
    // naming a session the caller never heard of. Only the window id is
    // load-bearing.
    if (window) return `${session}:${window.split(":")[1]}`;
  }
  return findProjectWindow(session, projectId) ?? null;
}

// Flattens an env object into tmux's `-e KEY=VALUE` flag pairs. The one
// place launchAgent and cmdLead (src/cli.ts) both funnel a spawned pane's
// environment through, found in /simplify review after cmdLead had
// hand-rolled its own parallel array literal: a var added to one path (as
// HIVE_DATA_DIR was, issue #27's L4 fix round R6 todo 167) had to be
// re-derived and re-added to the other by hand, with nothing to catch a
// future miss. One flattening step means a missing var is a one-line object
// literal to review, not a second manual audit.
export function buildEnvFlags(env: Record<string, string>): string[] {
  return Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
}

// The identity/scope vars every kind='agent' worker gets, whether it is a
// fresh spawn (launchAgent) or a revived one (resumeAgent) - factored out
// for the identical reason buildEnvFlags' own comment above states: a var
// added to one path and not the other is a future bug with nothing to catch
// it. HIVE_PROJECT_LOCK, HIVE_PROJECT_PATH and HIVE_DATA_DIR are a worker's
// identity and scope, not a caller's to override (see launchAgent's own
// call site for why spec.env spreads first, this second).
function agentIdentityEnv(actorId: string, name: string, projectPath: string): Record<string, string> {
  return {
    HIVE_AGENT_ID: actorId,
    HIVE_AGENT_NAME: name,
    HIVE_PROJECT_LOCK: "1",
    HIVE_PROJECT_PATH: projectPath,
    HIVE_DATA_DIR: dataDir,
    // Issue #27's L4 fix round, DECISION 7b. Never set true here, but never
    // explicitly cleared either, and tmux panes inherit the server's global
    // environment - so a worker launched on a server whose environment
    // happens to carry HIVE_LEAD=1 (nothing reachable sets it that way
    // today) would pass kickoff's === "1" check as if it were the lead.
    // Cheap insurance against a path that does not exist yet rather than
    // one that does.
    HIVE_LEAD: "",
  };
}

// The final write shared by launchAgent and resumeAgent once a pane is
// confirmed up: past this point the pane is live and its command has
// already started (respawn-pane/split-window/new-window launch it, not this
// statement). Todo 336: panePid(target) here rather than left '', so the row
// can tell "my pane" from "whatever a later server restart reissues this
// pane id to" - see src/db.ts's migration and deliverable()'s own comment
// (src/scheduler.ts). Read against the pane this statement's caller just
// confirmed live.
function recordPane(agentId: number, target: string, socket: string): void {
  db.prepare("UPDATE agents SET tmux_target = ?, tmux_socket = ?, pane_pid = ? WHERE id = ?").run(
    target,
    socket,
    panePid(target),
    agentId,
  );
}

// Issue #27's L4 fix round R10, todo 182 item 3 (opus, orphaned-comment
// finding). This paragraph describes idx_agents_running_name, which
// asNameClash (below) turns a SQLITE_CONSTRAINT hit on into hive's own
// sentence - it used to sit above buildEnvFlags instead, orphaned from the
// function it was actually about.
//
// idx_agents_running_name only fires on the path requireNameFree cannot see:
// two sessions that both passed the application check and both write. A raw
// SQLITE_CONSTRAINT reaching a lead tells it nothing it can act on, so it
// becomes the sentence requireNameFree would have thrown. The index reports
// the columns rather than its own name on current SQLite; match either, since
// which one you get is a detail of the engine and not of this rule.
export function asNameClash(e: unknown, name: string): unknown {
  const err = e as { code?: string; message?: string };
  const message = err.message ?? "";
  if (
    err.code === "SQLITE_CONSTRAINT_UNIQUE" &&
    (message.includes("agents.name") || message.includes("idx_agents_running_name"))
  ) {
    // Issue #27's L4 fix round R6, todo 170 (counselors opus F7). "lead" is
    // never a name the caller CHOSE - it is this project's own reserved
    // name - so "pick another name" is advice a `hive lead` race's loser
    // cannot act on. What actually happened: two invocations both passed
    // ensureLeadRow's running-row lookup before either INSERTed, and this
    // constraint firing means the OTHER one won; its row now exists, so a
    // re-run finds it via that same lookup and reuses it rather than racing
    // again.
    if (name === LEAD_NAME) {
      return new Error(
        "Another `hive lead` won the race to start this project's lead session. Re-run `hive lead`; " +
          "it will find and reuse the row that invocation just created.",
      );
    }
    return new Error(`A running agent named "${name}" already exists. Pick another name.`);
  }
  return e;
}

// The lead's kind and its actor_id shape, defined once so ensureLeadRow
// (src/cli.ts, the only place that ever mints one) and every consumer that
// needs to recognise a lead without a row already in hand (src/scheduler.ts's
// janitor and deliverable()) move together. Counselors review on the L4 fix
// round's todo 161: three hand-written copies of "lead" - a kind check, an
// actor_id LIKE pattern, an actor_id startsWith - drifted from the mint site
// and from each other with nothing to catch it, since every fixture that
// exercises them also hand-writes the same literal (shape 7's question: if
// the format changed, no test would go red).
export const LEAD_KIND = "lead";
export const LEAD_ACTOR_PREFIX = `${LEAD_KIND}:`;
export const isLeadActorId = (actorId: string): boolean => actorId.startsWith(LEAD_ACTOR_PREFIX);
export const mintLeadActorId = (agentId: number): string => `${LEAD_ACTOR_PREFIX}${agentId}`;

// Issue #27's L4 fix round R8, todo 175 item 3 (BOTH SEATS). isLeadActorId
// alone is a STRING check on whatever HIVE_AGENT_ID happens to hold - env-
// shaped, the same argument agentProjectPin (src/context.ts) already makes
// against trusting identity by env var alone. currentActor() returns
// process.env.HIVE_AGENT_ID verbatim with no row lookup, so a caller can
// satisfy isLeadActorId by setting HIVE_AGENT_ID to any string with the
// right prefix, naming no row at all - the branch's own test proved this
// (test/typing-guards.test.mjs, "lead:999"). Row-shaped: a real, currently
// running kind='lead' agents row with this exact actor_id.
export const isRunningLeadActor = (actorId: string): boolean =>
  !!db.prepare("SELECT 1 FROM agents WHERE actor_id = ? AND kind = ? AND status = 'running'").get(actorId, LEAD_KIND);

// The lead's own row is also always named "lead" - the same string as
// LEAD_KIND, by design (its display name and its kind coincide), not two
// constants that happen to agree today. Exported here, not redeclared where
// it is compared, for the same drift reason as LEAD_KIND above: two hand-rolled
// "lead" reserved-name checks (src/cli.ts's hive.yml process names,
// src/tools/agents.ts's requireNameFree) used to carry the same reasoning in
// two comments and could disagree if only one were ever updated.
export const LEAD_NAME = LEAD_KIND;
export const isReservedAgentName = (name: string): boolean => name.toLowerCase() === LEAD_NAME;

// The actors row for an agents row: same id, a display name that can drift
// from it (renameAgent), and last_seen_at bumped on conflict. Shared by
// launchAgent and cmdLead's own lead-row insert (src/cli.ts) so the two
// identity paths cannot drift on this one statement.
export function upsertActor(actorId: string, name: string, kind: string): void {
  db.prepare(
    `INSERT INTO actors (id, name, kind) VALUES (?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, last_seen_at = datetime('now')`,
  ).run(actorId, name, kind);
}

// The pane/window placement shared by a fresh spawn and a resumed one:
// given a command already resolved to a string and the session it targets,
// decide where the pane lands under withWindowClaim's cross-process lock
// (see its own comment). Split out of launchAgent so resumeAgent (below)
// can share the identical placement logic against an EXISTING row instead
// of duplicating it - the placement rules (session bootstrap, split into
// the spawning lead's window, project window creation) do not care whether
// the row behind the pane is new or reused.
function placeAgentPane(
  session: string,
  spec: Pick<LaunchSpec, "projectId" | "projectName" | "projectPath" | "cwd" | "placement" | "layout" | "parentActor">,
  envFlags: string[],
  commandString: string,
  title: string,
): { target: string; landedInProjectId: number | null } {
  let landedInProjectId: number | null = null;
  const target = withWindowClaim((): string => {
    const started = ensureSession(session, spec.projectPath);
    if (started.created) {
      const windowName = spec.placement === "split" ? spec.projectName : title;
      const { pane, window } = claimInitialWindow(
        started, windowName, spec.cwd, envFlags, commandString,
        spec.placement === "split" ? spec.projectId : null,
      );
      return spec.placement === "split" ? pane : window;
    }
    if (spec.placement === "split") {
      const found = splitTargetWindow(session, spec.projectId, spec.parentActor);
      if (found) {
        const pane = tmux(
          "split-window", "-d", "-P", "-F", "#{pane_id}",
          "-t", found, "-c", spec.cwd, ...envFlags, commandString,
        );
        applyLayout(found, spec.layout ?? DEFAULT_LAYOUT);
        const owner = windowOwner(found);
        if (owner !== null && owner !== spec.projectId) landedInProjectId = owner;
        return pane;
      }
      return createWindow(session, spec.projectName, spec.cwd, envFlags, commandString, spec.projectId, true).pane;
    }
    return createWindow(session, title, spec.cwd, envFlags, commandString, null, true).window;
  });
  return { target, landedInProjectId };
}

export function launchAgent(
  spec: LaunchSpec,
): { agentId: number; actorId: string; target: string; landedInProjectId: number | null } {
  // The write half of the guard in tmux.ts. Refusing to READ liveness off a
  // tmux server this store does not live on is only half a fix while the write
  // path keeps putting that server's pane ids into the store.
  //
  // What a spawn under the bad pair does: sessionName() returns the untagged
  // hive-main for the default store, ensureSession does not find it on the
  // private server and creates a second one there, and the pane id from that fresh
  // server (numbered from zero, so %0 or %1) is written into the SHARED store.
  // A lead on the shared server then holds a row naming a pane id that very
  // likely exists there belonging to someone else. agent_send types into a
  // stranger's pane; agent_close runs kill-pane on it. Same damage class as the
  // read path, arriving through the other door.
  //
  // Above the INSERT deliberately, not below it: the row is the first statement
  // precisely so a rejection never leaves a half-built pane, and a refusal
  // after it would leave an orphan row instead.
  if (untrustedTmuxServer()) throw crossServerRefusal("spawn");
  // Computed once and reused at both writes below (issue #73): it names the
  // server THIS call would talk to, which cannot change mid-call, and the
  // INSERT records it before the pane even exists so a row that dies before
  // reaching the tmux_target UPDATE still carries the fact.
  const socket = tmuxSocketPath(process.env.TMUX, process.env.TMUX_TMPDIR);
  let info;
  try {
    info = db
      .prepare(
        "INSERT INTO agents (project_id, name, command, cwd, kind, parent_actor_id, tmux_socket, session_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        spec.projectId,
        spec.name,
        // A callback cannot run until the row has an id, so the command lands
        // in the UPDATE below instead. The empty write is never observable: it
        // is inside the try that deletes the row on any failure, and the row is
        // not reachable until tmux_target is set.
        typeof spec.commandString === "string" ? spec.commandString : "",
        spec.cwd,
        spec.kind,
        spec.parentActor,
        socket,
        spec.sessionId ?? "",
      );
  } catch (e) {
    // The very first statement, before any tmux work, so losing the race
    // costs a rejected call and never a half-built pane.
    throw asNameClash(e, spec.name);
  }
  const agentId = Number(info.lastInsertRowid);
  const actorId = `${spec.kind}:${agentId}`;
  // Flips once the tmux pane/window actually exists and its command has
  // started - see the comment at the tmux_target UPDATE below for why the
  // catch below treats a failure before and after that moment differently.
  let paneUp = false;
  try {
    const commandString =
      typeof spec.commandString === "string" ? spec.commandString : spec.commandString({ agentId, actorId });
    db.prepare("UPDATE agents SET actor_id = ?, command = ? WHERE id = ?").run(actorId, commandString, agentId);
    upsertActor(actorId, spec.name, spec.kind);

    const session = sessionName();
    // spec.env spreads FIRST here, not last: a worker's identity and scope
    // (who it is, which project it is locked to) are not a caller's to
    // override. HIVE_PROJECT_LOCK moved for the same reason as
    // HIVE_PROJECT_PATH below it, not because it was implicated in a bug of
    // its own - agent_spawn always calls launchAgent with env: {} today, so
    // nothing exploits the old ordering yet, but "nothing does today" is not
    // an invariant worth leaving unguarded on this specific env block.
    //
    // No HIVE_PROJECT_ID here (issue #63's fix round): the project this
    // worker belongs to is already a fact on the agents row this function
    // just INSERTed, keyed by actor_id, which resolveHomeProject
    // (src/context.ts) now looks up directly instead of trusting a second,
    // env-shaped copy of the same number. HIVE_PROJECT_PATH is a GUARD on
    // that lookup, not the source - see projectPathGuard's comment.
    const env =
      spec.kind === "agent"
        ? { ...spec.env, ...agentIdentityEnv(actorId, spec.name, spec.projectPath) }
        : spec.env;
    const envFlags = buildEnvFlags(env);

    const title = windowTitle(spec.projectName, spec.name);
    // Todo 268: which project actually owns the window this pane landed in,
    // when a split worker's window came from splitTargetWindow's PARENT-pane
    // lookup rather than from this project's own stamp - the cross-repo case
    // (a worker recorded under project 9 whose spawning lead lives in project
    // 1's window). null everywhere else: the initial-session and
    // no-window-yet branches below always create and stamp a window for
    // spec.projectId itself, so there is nothing to disagree with, and
    // placement="window" never carries an ownership stamp to disagree
    // through. Populated below only in the one branch that can diverge.
    // Todo 277: ensureSession and every branch inside placeAgentPane read
    // whether this project already has a window and then create one when it
    // does not, so the whole read-then-create runs under withWindowClaim's
    // cross-process lock (see its own comment). It covers ensureSession too,
    // deliberately: "does this session exist" is the same shape of question
    // one level up, and todo 278's interleaving lives in the gap between
    // that answer and the window claim that follows it.
    //
    // A project's window is named for the project alone, matching
    // splitTargetWindow's own create path and cmdLead's
    // (decisions/2026-08-05-tmux-topology-windows-not-sessions.md): once
    // placement="split" makes this window hold the lead AND its workers, it
    // is the project's tab, not this worker's. A placement="window" worker's
    // OWN dedicated window keeps windowTitle. The stamp inside
    // placeAgentPane is gated on placement exactly like the name, and for
    // the identical reason: a placement="window" worker's window is ITS
    // OWN, never the project's. Stamping it anyway hands a later `hive lead`
    // or split-placed worker a private window to land in through
    // cmdLead's/splitTargetWindow's ownership lookup, defeating
    // placement="window" outright - the defect this comment prevents from
    // being re-introduced. Verified live:
    // test/worker-first-window-stamp.test.mjs fails with `'1' !== ''`, the
    // worker's window carrying the stamp it must not have.
    //
    // -d on the split path: a split without it makes the new pane active, so
    // a human typing into whatever pane had focus gets their keystrokes
    // stolen by the worker mid-sentence (todo 316, confirmed in real use).
    // applyLayout and the spawn announcement both target this pane by its
    // returned id, never by "the active pane", so nothing depends on the
    // split leaving it active. detach: true on both create-window paths
    // (todo 316) - a human watching some OTHER project's window in this
    // shared session must not get switched onto this one, and a worker's own
    // tab must not steal focus from whatever the human was looking at.
    const { target, landedInProjectId } = placeAgentPane(session, spec, envFlags, commandString, title);
    paneUp = true;
    // Past this line the pane is up and its command has already started
    // (respawn-pane/split-window/new-window above launch it, not this
    // statement) - with the worker's real env baked in via -e, including
    // HIVE_AGENT_ID naming THIS row. A failure recording tmux_target here
    // (SQLITE_BUSY past better-sqlite3's timeout, the same class src/db.ts
    // already retries for) must not roll the row back the way an earlier
    // failure does: deleting it would stand up a live, running worker whose
    // own agentProjectPin() lookup then finds no agents row at all and fails
    // loudly for the rest of its life, which is worse than the row it
    // replaces - pre-pin, that worker fell back to resolving from cwd and
    // kept working. The row already carries status='running' from its
    // INSERT; leave it there and just rethrow, so the caller sees the
    // failure while the worker it already spawned stays reachable by
    // actor_id, just without a recorded tmux_target.
    recordPane(agentId, target, socket);
    return { agentId, actorId, target, landedInProjectId };
  } catch (e) {
    if (paneUp) throw e;
    db.prepare("DELETE FROM agents WHERE id = ?").run(agentId);
    throw e;
  }
}

// Issue #154, D2 (todo 353's plan pad). agent_resume REUSES the row and its
// actor_id rather than minting a new one - a resumed worker is the SAME
// lane continuing, and there is direct precedent in this codebase:
// ensureLeadRow (src/cli.ts) reuses a lead's closed row and its actor_id
// across a restart, for the same reason. The actor id is the handle every
// wake, todo comment and agent_state_log row already addresses it by;
// minting a new one would split a worker's state history across two actors
// and orphan its comments' authorship.
//
// THE COST, stated rather than left implicit: 'closed' is no longer a
// terminal status once this exists - a caller cannot assume a closed row
// stays closed. Callers that swept only status='running' rows are
// unaffected (a resumed row reads 'running' again, same as any other);
// what would break is anything that assumed a row, once closed, never
// changes again - nothing in this codebase does today (the janitor and
// agent_list's filters both key on 'running', not on "closed forever"), but
// a future caller adding such an assumption would be building on a premise
// this function now falsifies.
export interface ResumeSpec {
  agentId: number;
  actorId: string;
  name: string;
  projectId: number;
  projectName: string;
  projectPath: string;
  cwd: string;
  // A plain string, unlike LaunchSpec's callback variant: that callback
  // shape exists only because launchAgent's ids do not exist until its own
  // INSERT runs. A resume's agentId and actorId are already known from the
  // closed row before this is ever called, so there is nothing for a
  // callback to wait on.
  commandString: string;
  placement: "split" | "window";
  layout?: WindowLayout;
  parentActor: string;
}

export function resumeAgent(
  spec: ResumeSpec,
): { target: string; landedInProjectId: number | null } {
  // Refuse ABOVE the row flip, mirroring launchAgent's own INSERT-above-
  // refusal ordering: a rejection here must never leave the row half-resumed.
  if (untrustedTmuxServer()) throw crossServerRefusal("resume");
  const socket = tmuxSocketPath(process.env.TMUX, process.env.TMUX_TMPDIR);
  // One UPDATE, not two - unlike launchAgent, whose command is not known
  // until after its own INSERT allocates an id, spec.commandString is
  // already resolved here, so the flip and the command write land in the
  // same statement. Conditional on status = 'closed', not merely on id: a
  // caller who reads a closed row and then calls this can race a concurrent
  // resume of the SAME row, and the changes count is how this tells
  // "flipped it" from "someone already did".
  //
  // Counselors (all three seats, independently): this flip used to leave
  // tmux_target/pane_pid pointing at the PANE agent_close already killed,
  // with status now reading 'running'. In the gap between this statement
  // and recordPane() below - which spans placeAgentPane's tmux forks and
  // withWindowClaim's machine-wide lock, up to seconds under contention -
  // that row matches every predicate of janitor()'s agents sweep
  // (src/scheduler.ts): running, non-empty tmux_target, past the settle
  // window (created_at is the row's ORIGINAL creation time, not this
  // resume, so a resumed row is never inside it). rowAlive reads false for
  // the dead pane, the janitor closes the row out from under this call, and
  // recordPane then writes the fresh pane onto a row the store says is
  // closed - live, unaddressable by name, and resumable a second time onto
  // a THIRD pane of the same session. Cleared here for the identical reason
  // launchAgent's fresh INSERT is immune to this by construction (its own
  // tmux_target starts ''): an empty tmux_target is what takes a row out of
  // the sweep's `tmux_target != ''` predicate, so the resumed row gets the
  // same protection a brand-new spawn already has, for the same gap.
  //
  // Counselors (opus): agent_state/state_changed_at are the hook's alone to
  // write (src/hook.ts) and closeAgentRow never touches them, so they were
  // left holding whatever the worker last reported before it closed -
  // 'idle' if it happened to close mid-idle, hours or days stale. Read on a
  // 'running' row (which this flip makes true before the resumed claude has
  // drawn a frame), a stale 'idle' satisfies standingIdleRows'
  // status='running' AND agent_state='idle' filter with no bound against
  // when the resume itself happened, so a wake_when_idle set any time after
  // resuming reports the worker finished on its very first scheduler tick.
  // Reset to 'unknown'/NULL - literally agents.agent_state's own DEFAULT for
  // a fresh row (src/db.ts) - so a resumed row starts exactly where a freshly
  // spawned one does: no claim about liveness until the first real hook event
  // makes one.
  //
  // D2's own named cost, checked rather than assumed (the plan pad): a
  // resumed row can collide with idx_agents_running_name if a different
  // worker has since taken the closed row's name (findClosedAgent's own
  // name search only excludes running rows, not closed ones - the exact gap
  // launchAgent's requireNameFree exists to prevent for a fresh spawn, and
  // has no equivalent here since there is no NEW name for a resume to
  // validate). The agent_resume tool calls requireNameFree itself before
  // ever reaching this function (closing the gap opus separately found:
  // idx_agents_running_name's COLLATE NOCASE folds ASCII only, while
  // requireNameFree folds in JS); this catch is the backstop for the
  // TOCTOU race between that check and this write, with a remedy this
  // caller can actually reach, rather than asNameClash's "pick another
  // name" - a resumed row's name is not the caller's to change.
  let flipped: number;
  try {
    flipped = db
      .prepare(
        "UPDATE agents SET status = 'running', closed_at = NULL, tmux_target = '', pane_pid = '', " +
          "agent_state = 'unknown', state_changed_at = NULL, tmux_socket = ?, command = ? " +
          "WHERE id = ? AND status = 'closed'",
      )
      .run(socket, spec.commandString, spec.agentId).changes;
  } catch (e) {
    const err = e as { code?: string; message?: string };
    const message = err.message ?? "";
    if (
      err.code === "SQLITE_CONSTRAINT_UNIQUE" &&
      (message.includes("agents.name") || message.includes("idx_agents_running_name"))
    ) {
      throw new Error(
        `Cannot resume agent ${spec.agentId}: a running agent already has the name "${spec.name}". Rename or ` +
          "close that one first, or resume a different agent_id.",
      );
    }
    throw e;
  }
  if (flipped === 0) {
    throw new Error(`Agent ${spec.agentId} is not closed - another caller may have resumed it first.`);
  }
  let paneUp = false;
  try {
    // Gate finding (PR #161): this used to run BETWEEN the flip and this
    // try, so a throw here (SQLITE_BUSY past busy_timeout under
    // contention with a concurrent withWindowClaim holder is the
    // realistic case) skipped the catch below entirely and stranded the
    // row 'running' with tmux_target='' forever - the same empty string
    // the flip deliberately writes to dodge the janitor's race window is
    // exactly what excludes a stranded row from ever being swept, since
    // janitor()'s agents sweep requires tmux_target != ''. Inside the try,
    // paneUp is still false, so the existing catch reverts the flip the
    // same as any other pre-pane failure.
    upsertActor(spec.actorId, spec.name, "agent");
    // A resumed row is always kind='agent' - agent_resume refuses a lead
    // target before this is ever reached - so this is the unconditional
    // half of launchAgent's own env ternary, not a second copy of it.
    const envFlags = buildEnvFlags(agentIdentityEnv(spec.actorId, spec.name, spec.projectPath));
    const session = sessionName();
    const title = windowTitle(spec.projectName, spec.name);
    const { target, landedInProjectId } = placeAgentPane(session, spec, envFlags, spec.commandString, title);
    paneUp = true;
    recordPane(spec.agentId, target, socket);
    return { target, landedInProjectId };
  } catch (e) {
    // launchAgent DELETEs a fresh row on a pre-pane failure; there is no
    // fresh row here to discard, so the equivalent is reverting the flip -
    // a failure before the pane exists must not strand the row 'running'
    // with no pane to back it. Once paneUp is true the row stays 'running'
    // with whatever tmux_target it last recorded, same as launchAgent past
    // its own identical point: the worker is live either way, and closing
    // the row out from under a live pane would be the worse failure.
    if (!paneUp) {
      db.prepare("UPDATE agents SET status = 'closed', closed_at = datetime('now') WHERE id = ?").run(spec.agentId);
    }
    throw e;
  }
}

// The other half of naming an agent, next to launchAgent because that is what
// establishes a name in the first place: the agents row, the actors row (the
// display name for the same actor_id), and the tmux window when the worker
// has one of its own. The actor_id itself is deliberately untouched; it is
// stamped on everything the worker has already written.
//
// The window rename is best-effort: the store write has landed, and a window
// killed since the caller's liveness check must not fail the rename.
export function renameAgent(
  agent: { id: number; actor_id: string; tmux_target: string },
  newName: string,
  window: { projectName: string } | null,
): void {
  try {
    db.transaction(() => {
      db.prepare("UPDATE agents SET name = ? WHERE id = ?").run(newName, agent.id);
      db.prepare("UPDATE actors SET name = ? WHERE id = ?").run(newName, agent.actor_id);
    })();
  } catch (e) {
    // Same race as a spawn, one tool over: another session took the name
    // between this caller's check and this write. The transaction rolled both
    // updates back, so nothing tmux-side has happened yet.
    throw asNameClash(e, newName);
  }
  if (window) {
    try {
      tmux("rename-window", "-t", agent.tmux_target, windowTitle(window.projectName, newName));
    } catch {
      // Window gone; the label stays stale and the row is already correct.
    }
  }
}

// Issue #27's L4 fix round R10, todo 181 item 3 (codex F1). expectedTmuxTarget
// is optional and, when given, makes the close conditional on the row STILL
// naming the pane the caller actually probed - not just on id and
// status='running'. Without it, a caller that reads tmux_target, decides the
// pane is dead, and then calls this can race a DIFFERENT writer (the one
// case that matters here: `hive lead`'s own CAS) recording a fresh pane on
// the same row in between. id and status alone would still match, closing a
// row that is now genuinely running again on the strength of a probe that is
// no longer true - agent_close passes the target it probed for exactly this
// reason. The return value says whether the close actually happened, so a
// caller that cares (agent_close does) can tell "closed" from "the row moved
// out from under me" instead of reporting the former for both.
export function closeAgentRow(agentId: number, expectedTmuxTarget?: string): boolean {
  const info =
    expectedTmuxTarget === undefined
      ? db
          .prepare("UPDATE agents SET status = 'closed', closed_at = datetime('now') WHERE id = ? AND status = 'running'")
          .run(agentId)
      : db
          .prepare(
            "UPDATE agents SET status = 'closed', closed_at = datetime('now') WHERE id = ? AND status = 'running' AND tmux_target = ?",
          )
          .run(agentId, expectedTmuxTarget);
  return info.changes > 0;
}
