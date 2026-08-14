import { execFileSync } from "node:child_process";
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
//
// COUNSELORS, ALL THREE SEATS, ISSUE #156: RECORDPANE MUST NOT WRITE A PANE
// ONTO A ROW THAT IS NO LONGER RUNNING. That sentence is the invariant, and it
// is true regardless of who closed the row or why - which is what makes this
// the right layer for it rather than a guard at whichever caller happened to
// expose it.
//
// WHAT EXPOSED IT. resumeAgent's flip deliberately commits status='running'
// with tmux_target='' (to take the row out of the janitor's `tmux_target != ''`
// sweep for the duration of the resume). A concurrent agent_park then reads
// that row: targetLiveProbe('') answers `{live: false}` - FALSE, not null
// (src/tmux.ts) - so the caller's own "unknown liveness is never dead" refusal
// does not fire, no pane is killed, and parkAgentRow's CAS `AND tmux_target =
// ?` compares '' against '' AND MATCHES. The row goes closed+parked while the
// resume is still mid-flight, and this statement then wrote the live pane onto
// it. End state: a live `claude --resume` pane on a row that reads closed, so
// the janitor's status='running' sweep cannot see it, `hive status` lists it as
// resumable, and resuming again forks a SECOND pane on the same session -
// verbatim the failure the empty tmux_target was introduced to prevent,
// reached through a different door.
// NOT A NARROW WINDOW: placeAgentPane runs inside withWindowClaim, which is
// BEGIN IMMEDIATE, so a competing write BLOCKS on that lock and fires the
// instant it releases - precisely into the gap above this line. Contention
// makes this MORE likely, not less.
//
// FIXED HERE RATHER THAN AT THE CALLER, deliberately and with the scope cost
// accepted by the lead: launchAgent has the identical INSERT-to-recordPane gap
// (an agent_close landing in it), and a guard written into agent_park would
// have left that twin live while looking like a fix. This project's own record
// is that writing such a lesson down does not stop the second instance; only a
// fix at the site does.
//
// THE CALLER OWNS THE RECOVERY, because only the caller knows what it built:
// `changes === 0` means the row was retired underneath it, so there is a live
// pane belonging to nobody. Both callers kill that pane and throw rather than
// leaving it, which is the one action that cannot leak a process nothing
// tracks.
function recordPane(agentId: number, target: string, socket: string): boolean {
  return (
    db
      .prepare(
        "UPDATE agents SET tmux_target = ?, tmux_socket = ?, pane_pid = ? WHERE id = ? AND status = 'running'",
      )
      .run(target, socket, panePid(target), agentId).changes > 0
  );
}

// The pane this process just created, belonging to a row that no longer wants
// it. Best-effort: the throw that follows is the real report, and a kill-pane
// that itself fails must not replace a precise error with a tmux one.
function discardOrphanedPane(target: string): void {
  try {
    tmux("kill-pane", "-t", target);
  } catch {
    // Already gone, or a server we cannot reach. Nothing else to try.
  }
}

const paneRacedRetirement = (agentId: number) =>
  new Error(
    `Agent ${agentId}'s row was retired (closed or parked) while its pane was being created, so the pane was ` +
      "discarded rather than recorded against a row that is no longer running. Nothing is left running for it. " +
      "Re-read the row with agent_status and resume or spawn again if that was not what you intended.",
  );

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

// EVERY PLACEMENT RECORDS A PANE ID. Todo 371, and the reasoning has to live
// here because the line that returns it is one word long and reads as a
// tidy-up.
//
// placement="window" used to return the WINDOW id, so a row read
// `hive-main:@3`. A pane belongs to exactly one window permanently and
// `join-pane`/`break-pane` MOVE it (decisions/2026-08-05-tmux-topology-windows
// -not-sessions.md), so joining a window-placed worker's pane elsewhere
// destroys the window the row names. janitor()'s agents sweep then reads an
// honest `false` from rowAliveProbe and closes a row whose claude is still
// mid-turn: a WORKING worker reads as FINISHED, and nothing repoints a
// worker's tmux_target afterwards. It happened to a real crew on 2026-08-11
// (todo 371), and the topology decision above had already named it as a known
// consequence six days earlier. A PANE ID SURVIVES THE MOVE - measured, the
// pane keeps its id AND its #{pane_pid} across join-pane
// (test/window-target-moved-pane.test.mjs asserts both).
//
// WHY THIS DOES NOT BREAK THE READERS THAT WANT A WINDOW: tmux resolves a pane
// id UP to its window for every window-scoped command (measured on 3.7b:
// rename-window, kill-window, show-options -w, split-window all accept `%n`),
// so no consumer of this column has to change to keep working. What changes is
// which pane the pane-scoped ones MEAN, and there the pane id is the fix
// rather than the cost: `capture-pane -t @n` and `send-keys -t @n` resolve to
// the window's ACTIVE pane, so once a window-placed worker's window holds a
// second pane - which splitTargetWindow does whenever that worker spawns a
// split child - agent_output could return the child's screen and agent_send
// could type into it.
//
// TWO SITES DID READ IT AS A WINDOW ON PURPOSE, and neither wanted "is this a
// window id" - both wanted PLACEMENT, which is not stored anywhere, so
// tmux_target had been doubling as the placement record. See killAgentPane and
// agent_rename's window-title branch (src/tools/agents.ts) for how each one
// answers its real question now.
//
// NO `placement` COLUMN, AND THE REASON IS NOT COST. A reviewer holding this
// diff without the argument will propose one - it looks like the obviously
// honest fix for the conflation named above - so the argument lives here
// rather than only on todo 371. agent_resume (src/tools/agents.ts) already
// RE-DERIVES placement from hive.yml and the environment on every resume
// rather than reading it back off the row, so this codebase already treats
// placement as a per-spawn input and not a durable property of an agent. A
// column would be a second source of truth for a fact the code deliberately
// does not keep, and migrations are append-only, so it would be permanent.
// The one consumer that genuinely needs the fact is a COSMETIC window
// retitle, which is not the weight that justifies a schema change.
//
// ONE BEHAVIOUR CHANGE RIDES ALONG AND IS NOT A SIDE EFFECT TO DISCOVER
// LATER: killAgentPane (src/tools/agents.ts) branches on isPaneTarget, so
// agent_close/agent_park on a window-placed worker now runs kill-pane where it
// ran kill-window. The argument is at that function, next to the code that
// does it, rather than restated here where it would be a second copy to drift.
//
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
    // What a NEW window for this spawn is called, and who owns it. Hoisted to
    // one place (/simplify, todo 371): both remaining branches below create a
    // window and each used to spell this pair out again, so a third placement
    // - or any change to what gets stamped - had three sites to keep in step.
    // The values themselves are unchanged: a split worker's window is the
    // PROJECT's, named for it and stamped with its id, while a window-placed
    // worker's is ITS OWN, named for the worker and deliberately unstamped so
    // a later `hive lead` or parentless split never lands in it
    // (test/worker-first-window-stamp.test.mjs).
    const windowName = spec.placement === "split" ? spec.projectName : title;
    const windowOwnerId = spec.placement === "split" ? spec.projectId : null;
    const started = ensureSession(session, spec.projectPath);
    if (started.created) {
      return claimInitialWindow(started, windowName, spec.cwd, envFlags, commandString, windowOwnerId).pane;
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
    }
    return createWindow(session, windowName, spec.cwd, envFlags, commandString, windowOwnerId, true).pane;
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
        // resumed_at is deliberately NOT stamped here (todo 387, option (e)).
        // Todo 373 used to stamp it in this INSERT, on the grounds that a spawn
        // is a start exactly like a resume - but a spawn's "start" was
        // agent_spawn typing a `[hive]` line into the pane and submitting it,
        // which was the actual defect: a self-inflicted turn that could
        // silently swallow a real assignment absorbed into it, latching the
        // worker's finishes suppressed for good (todo 384). With nothing typed
        // into the pane at spawn, there is no spurious turn to suppress, and
        // this column is stamped only by resumeAgent's flip now - the one
        // start path that still speaks first with nothing hive controls.
        "INSERT INTO agents (project_id, name, command, cwd, kind, parent_actor_id, tmux_socket, session_id) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
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
    // applyLayout targets this pane by its returned id, never by "the active
    // pane", so nothing depends on the split leaving it active. detach: true
    // on both create-window paths
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
    // The row can have been retired since the INSERT above (an agent_close
    // landing in the gap this call spans). recordPane refuses to write onto a
    // row that is no longer running; when it does, this pane belongs to
    // nobody, so it is killed rather than leaked. paneUp is already true, so
    // the catch below rethrows without deleting the row - correct, and for the
    // reason stated above it: whoever retired the row owns it now.
    if (!recordPane(agentId, target, socket)) {
      discardOrphanedPane(target);
      throw paneRacedRetirement(agentId);
    }
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

// TODO 374. EVERY COLUMN resumeAgent's FLIP WRITES, so a pre-pane failure can
// put the row back exactly as it was rather than approximately.
//
// THE DEFECT THIS EXISTS FOR. The revert used to write status and closed_at
// and nothing else, so a resume that failed before its pane came up left the
// park stamp CLEARED on a row that was closed again. `hive status` stopped
// printing the resume call for that lane, agent_resume's parked-row name
// preference (todo 364) stopped applying to it, and parked_branch - the one
// fact that rebuilds a removed worktree - was gone. No work was lost: the row
// is closed, the session id is intact, agent_resume(agent_id) still works.
// What was lost is every way of FINDING the lane again.
//
// AND IT IS NOT ONLY DISCOVERABILITY, which is the half todo 374 was filed
// for. The reverted row satisfies every clause of standingGoneRows
// (src/scheduler.ts) and a standing watch FILES AN OBITUARY for it: the lead
// is told that worker died and to go and excavate its branch for what was
// lost, about a lane sitting safe on disk exactly where it parked it. Two
// separate clauses of that query are what let it through, which is why the
// list below is not just the park stamp:
//   parked_at = ''       - the park exclusion, cleared by the flip. Nothing
//                          ever wrote a gone-cursor row for the lane either,
//                          because that exclusion is a FILTER rather than a
//                          claim (see standingGoneRows' own comment), so the
//                          death reads as unreported news.
//   agent_state != 'idle' - the flip resets agent_state to 'unknown', so an
//                          ORDINARY closed row that closed FROM idle - never
//                          parked at all - loses ITS exclusion the same way.
//                          Same false obituary, and park is not involved.
//   closed_at             - every gone cursor and every seedGoneCursor row is
//                          keyed on closed_at AS THE EPISODE, so stamping a
//                          fresh one makes an already-reported death look like
//                          news to every standing watch in the project.
//
// SO THE RULE IS THE FLIP'S EXACT INVERSE, not a list of the columns somebody
// noticed: the row must read as though the resume was never attempted. That
// rule is the only one that stays true when a twelfth column is added, and it
// is held STRUCTURALLY rather than by this comment - the same list drives the
// capture SELECT and the restore UPDATE, and test/resume-revert-restores-row.
// test.mjs asserts it against the flip statement's own SET clause, so a column
// added to the flip and not to this list fails a test instead of silently
// going unreverted.
//
// RETURNING CANNOT DO THIS, and both todo 374 and its lane plan offer it as an
// alternative to reading first. SQLite's RETURNING yields POST-update values
// for an UPDATE and has no OLD.* access, so on this statement it can only hand
// back the sentinels the flip just wrote. Read-before-flip is the only route,
// which is why it is in a transaction with the flip rather than beside it.
//
// WHY NOT "just do not clear the stamp until the pane is up": the flip's own
// comment argues both park columns must move in the SAME statement that
// un-closes the row, and splitting them reintroduces a window where a row
// reads running-and-parked. Nothing here contradicts that - the flip is
// untouched, and only the failure path changed.
export const RESUME_FLIP_COLUMNS = [
  "status",
  "closed_at",
  "tmux_target",
  "pane_pid",
  "agent_state",
  "state_changed_at",
  "parked_at",
  "parked_branch",
  "resumed_at",
  "tmux_socket",
  "command",
];

// A FUNCTION RATHER THAN A CONST, and that is forced rather than a style
// choice: it splices PARK_STAMP_CLEARED, which is declared further down this
// file, so a top-level const here would read it inside its temporal dead zone
// and throw at import. Exported so the test above asserts against this builder
// rather than against a copy of the SQL - intercepting a statement by string
// literal is how test/spawn-cwd-scope's "finding 5" silently disarmed itself
// (decisions/2026-08-11-recordpane-guards-the-row-not-the-caller.md).
//
// SAY THE GUARANTEE EXACTLY (counselors): the list and the flip CANNOT DRIFT
// WHILE resumeAgent'S CALL TO THIS FUNCTION STANDS. It is one indirection, not
// a law. A twelfth column added to the flip INLINE, bypassing this builder,
// evades both guards at once - the drift test would still parse this
// now-unused builder and agree with itself, and the behavioural test reads
// back only the listed columns, so a destroyed twelfth column is invisible to
// it. Unlikely, because the builder is where the SQL lives; written down
// because "cannot drift" was the claim and this is the honest version of it.
export function resumeFlipSql(): string {
  // Issue #156: the park stamp is CLEARED here, in the same statement that
  // un-closes the row. A resumed lane is not a parked one, and a parked_at
  // left behind would make `hive status` report it parked for the rest of the
  // row's life - the stale-state failure the D4 surface exists to prevent,
  // reintroduced by the tool that was supposed to end it. Both columns move
  // together on purpose: parked_at != '' is what every reader gates on, so a
  // parked_branch surviving alone would be a fact no reader can reach and no
  // writer maintains.
  // Issue #156 D3: resumed_at is stamped HERE, in the same statement, for the
  // same reason session_id is written in launchAgent's own INSERT - a fact
  // that must be true of the row before anything else can observe it. It marks
  // this worker as "resumed, and not yet spoken to", which is what stops the
  // restore turn's own Stop hook being reported as a finish. src/hook.ts
  // clears it on the first `prompt` event.
  return (
    "UPDATE agents SET status = 'running', closed_at = NULL, tmux_target = '', pane_pid = '', " +
    `agent_state = 'unknown', state_changed_at = NULL, ${PARK_STAMP_CLEARED}, ` +
    "resumed_at = datetime('now'), tmux_socket = ?, command = ? " +
    "WHERE id = ? AND status = 'closed'"
  );
}

// tmux_target and pane_pid go back to the DEAD pane the row named before the
// resume, deliberately, rather than being left as the flip's ''. They are as
// dead either way - agent_close/agent_park killed that pane before the row was
// ever closed - and nothing sweeps or probes a closed row, so neither value is
// acted on. Restoring them keeps ONE rule ("the row reads as though this never
// happened") instead of a rule plus a per-column exemption list that the next
// reader has to re-derive.
//
// THE CAS IS THE SAME DISCIPLINE EVERY OTHER LIFECYCLE WRITE IN THIS FILE
// TAKES, AND WITHOUT IT THIS FIX REINTRODUCES ITS OWN DEFECT THROUGH THE RACE
// DOOR (found by this lane's /simplify altitude pass). parkAgentRow,
// releaseParkRow, recordPane and cmdLead's restart CAS all refuse to write a
// row whose state has moved since the caller decided it was theirs; the
// pre-374 revert took no predicate either, but it wrote TWO columns, and this
// one writes eleven. The reachable sequence is the one recordPane already
// exists for (.claude/rules/tmux-and-panes.md): the flip commits running with
// tmux_target='', a concurrent agent_park reads targetLiveProbe('') as FALSE
// rather than null, its own CAS compares '' against '' and MATCHES, and the
// row goes closed+parked mid-resume. If placeAgentPane or upsertActor then
// throws - the contention case, which is exactly when that park is likeliest -
// an unpredicated restore overwrites the park the lead just performed and got
// a receipt for. For a row that was not parked before, that clears parked_at
// outright: this todo's own defect, reintroduced by its own fix.
//
// SO THE PREDICATE IS THE STATE THE FLIP LEFT, and `changes === 0` means
// another writer owns this row now and it must be left alone. Losing it cannot
// strand a row 'running' with no pane: it is lost either to a status that is no
// longer 'running' (someone closed or parked it, so the row is already retired)
// or to a tmux_target that is no longer '' (only recordPane writes one, and it
// runs after paneUp is true, where this function is never reached).
//
// THAT ENUMERATION IS ABOUT LOSING THE CAS, AND IT IS NOT THE WHOLE STORY -
// THE THIRD OUTCOME IS MATCHING WHEN IT SHOULD NOT (counselors; two seats found
// this independently and one reproduced it in an in-memory table). The
// predicate names a LIFECYCLE PHASE, not a particular resume attempt, and the
// flip's sentinel state recurs:
//   resume A flips to running/''; a concurrent agent_park wins its own CAS
//   through the recorded ''-against-'' door; resume B finds the row closed and
//   flips it again, producing BYTE-IDENTICALLY the state A's CAS tests for; A
//   then fails pre-pane and restores A's snapshot over B's flip - silently
//   destroying the park that the concurrent caller holds a RETURNING receipt
//   for.
// This is the shape decisions/2026-08-11-recordpane-guards-the-row-not-the-
// caller.md names, one turn further on: the sentinel that makes a guard work is
// not a nonce, so it cannot tell MY flip from ANOTHER flip.
//
// ACCEPTED AS A RESIDUAL RATHER THAN FIXED HERE, deliberately and with the
// lead's call on it. What a real fix takes: a PER-ATTEMPT token on the row, so
// the restore can name its own flip. resumed_at cannot serve - it is
// datetime('now'), whole seconds, and this whole window is sub-second - so it
// means a generation column, which means a migration, which is larger than
// this lane and would land after both of its review rounds are spent. What
// makes that acceptable meanwhile: it needs THREE lifecycle calls on one row
// inside A's flip-to-failure window, and B does not proceed on the corrupted
// row - it aborts loudly at recordPane, kills its pane and throws. The cost is
// P's park stamp, and P is a caller that has already been told its park
// succeeded.
//
// ONE MORE THING "the row reads as though the resume was never attempted" DOES
// NOT COVER, and it is pre-existing rather than introduced here. Tmux side
// effects do not roll back (.claude/rules/store-and-datadir.md says so of
// withWindowClaim), and claimInitialWindow's rename-window runs AFTER
// respawn-pane has already launched the command - so a TmuxTimeoutError there
// throws with paneUp still false, the row is restored, and a live `claude
// --resume` on that session id keeps running unrecorded. main's revert had the
// identical gap. WHAT THIS BRANCH CHANGES is that the restored row now
// ADVERTISES the resume call in `hive status`, where main's amnesiac row did
// not - so a second resume of the same session is more inviting than it was.
// Still the right trade (the alternative is the false obituary), and named here
// so it is not rediscovered as this lane's doing.
function restoreFlippedRow(agentId: number, before: Record<string, string | null>): void {
  db.prepare(
    `UPDATE agents SET ${RESUME_FLIP_COLUMNS.map((c) => `${c} = ?`).join(", ")} ` +
      "WHERE id = ? AND status = 'running' AND tmux_target = ''",
  ).run(...RESUME_FLIP_COLUMNS.map((c) => before[c] ?? null), agentId);
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
  // TODO 374: what the flip is about to destroy, captured while it is still
  // there, and the changes count, returned together rather than smuggled out
  // through a mutable binding - a caller then cannot read `before` without
  // also holding the count that proves the flip happened.
  let flip: { before: Record<string, string | null> | undefined; changes: number };
  // Compiled ABOVE the transaction on purpose. better-sqlite3 does not cache
  // prepared statements, so leaving these inline would hold the store's single
  // machine-wide writer slot for two sqlite3_prepare_v2 calls as well as the
  // two statements - measured at 13.2us held versus 3.0us, i.e. the compile is
  // about four times the work the section exists to do. The absolute number is
  // irrelevant; what matters is that the section's own justification is "two
  // statements and no forks", and this is what makes that literally true.
  const captureBeforeFlip = db.prepare(`SELECT ${RESUME_FLIP_COLUMNS.join(", ")} FROM agents WHERE id = ?`);
  const flipStatement = db.prepare(resumeFlipSql());
  try {
    // TODO 374: the read and the flip are ONE `BEGIN IMMEDIATE` transaction,
    // not two statements. The captured values are the only copy that will
    // exist, and a concurrent releaseParkRow (agent_close abandoning this very
    // park) landing between them would make the revert restore a park a lead
    // deliberately released. `.immediate()` takes the store's single writer
    // slot up front, which is the same borrow withWindowClaim already makes
    // (.claude/rules/store-and-datadir.md). It holds it for two statements and
    // no forks, and it has COMMITTED before placeAgentPane runs - which
    // matters beyond politeness, since withWindowClaim refuses outright when
    // db.inTransaction is already true.
    flip = db
      .transaction(() => ({
        before: captureBeforeFlip.get(spec.agentId) as Record<string, string | null> | undefined,
        changes: flipStatement.run(socket, spec.commandString, spec.agentId).changes,
      }))
      .immediate();
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
  if (flip.changes === 0) {
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
    // THE RACE THIS WHOLE GUARD EXISTS FOR (counselors, all three seats): a
    // concurrent agent_park sees this row's deliberately-empty tmux_target,
    // reads the pane as dead rather than unprobed, and parks it mid-resume.
    // recordPane refuses to write onto the retired row; the pane it would have
    // recorded is killed, so the park's own view - a closed, parked lane with
    // nothing running - becomes true rather than a lie.
    if (!recordPane(spec.agentId, target, socket)) {
      discardOrphanedPane(target);
      throw paneRacedRetirement(spec.agentId);
    }
    return { target, landedInProjectId };
  } catch (e) {
    // launchAgent DELETEs a fresh row on a pre-pane failure; there is no
    // fresh row here to discard, so the equivalent is reverting the flip -
    // a failure before the pane exists must not strand the row 'running'
    // with no pane to back it. Once paneUp is true the row stays 'running'
    // with whatever tmux_target it last recorded, same as launchAgent past
    // its own identical point: the worker is live either way, and closing
    // the row out from under a live pane would be the worse failure.
    //
    // TODO 374: RESTORING THE ROW, NOT JUST ITS STATUS. See restoreFlippedRow.
    // The `flip.before` fallback is unreachable rather than defensive -
    // `flip.changes === 0` throws above this try, and the capture ran in the
    // same transaction as the flip that counted - and it degrades to
    // closeAgentRow rather than to nothing, because a row left 'running' with
    // tmux_target='' is invisible to janitor()'s sweep forever, which is the
    // one outcome worse than an incomplete revert.
    if (!paneUp) {
      if (flip.before) restoreFlippedRow(spec.agentId, flip.before);
      else closeAgentRow(spec.agentId);
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
// TODO 371: WHICH WINDOW IS THIS WORKER'S TO RETITLE, ASKED OF THE WINDOW
// ITSELF. The caller used to answer this with `!isPaneTarget(tmux_target)` -
// a window id meant placement="window" meant "its own window". Every row now
// records a PANE id (see placeAgentPane), so that stand-in is gone, and the
// question it was standing in for was never really "which kind of id is this"
// but "did this worker get a window of its own", i.e. PLACEMENT - which this
// codebase deliberately does not store (the argument against a column is at
// placeAgentPane).
//
// So ask the window. hive names a worker's own window windowTitle(project,
// name) at creation, in both branches that can create one (this file's
// resumeAgent and launchAgent, via placeAgentPane), while a project's SHARED
// window - the one a split-placed worker lands in beside its lead - is named
// for the project alone. Comparing the window's CURRENT name against the
// title this worker's name would produce therefore answers the real question,
// and it composes across repeated renames because the row's name and the
// window's title are updated together.
//
// EVERY MISS FALLS THROUGH TO "DO NOT RETITLE", WHICH IS THE SAFE DIRECTION
// AND IS PINNED (test/agent-names.test.mjs). A window a human renamed, a
// window whose name drifted for any reason at all, and a target tmux cannot
// answer for: none of them are retitled. The cost of a miss is a stale window
// title, and the row is renamed either way, so nothing addressable is
// affected.
//
// THE TITLE ALONE IS NOT ENOUGH, THOUGH, AND TWO COUNSELORS SEATS FOUND THAT
// INDEPENDENTLY. A miss is safe; a false MATCH is not, and a title can match a
// window that is not this worker's. The reachable case is a human renaming the
// PROJECT'S SHARED window - the one holding a lead and several split workers -
// to exactly "<project> - <this worker's name>", after which renaming that
// worker would retitle the shared tab. So the stamp is checked too: a
// project's shared window carries @hive-project-id and a window-placed
// worker's own window deliberately does not (placeAgentPane above,
// test/worker-first-window-stamp.test.mjs), which is precisely the difference
// being asked about. It costs no extra fork - both facts come out of the same
// list-panes format string.
//
// WHAT THAT STILL DOES NOT COVER, recorded rather than left to be
// rediscovered. All three need a window that is hive-owned, unstamped, and
// carrying this exact title, so all three are one wrong tab label and nothing
// else - the row is renamed either way and nothing addressable moves.
//   - Two projects with the SAME display name (only `path` is unique in the
//     projects table) each running a window-placed worker with the same name,
//     one of whose panes has been moved into the other's window.
//   - A window-placed worker's own window OUTLIVING it: closing that worker
//     is now a kill-pane, so a window still holding a split child survives
//     with the dead worker's title on it. A later worker that takes the freed
//     name and lands in that window would retitle it.
//   - Any hive-created window a human has renamed to this exact string.
// The fix for all three is the same ownership stamp described below, which is
// a lane of its own; a longer string comparison cannot reach any of them.
//
// THE ALTERNATIVE THIS ARGUMENT HAS TO MEET IS THE STAMP, NOT THE COLUMN, and
// the first version of this comment only beat the column (/simplify, altitude
// seat). hive already records window-scoped facts as tmux WINDOW OPTIONS -
// @hive-owned, @hive-project-id, @hive-layout - and windowOwner (src/tmux.ts)
// answers the sibling question "whose window is this" exactly that way. A
// stamp has none of a column's costs: per-window, per-spawn, dies with the
// window, no migration. It is the mechanism at this module's own altitude, and
// .claude/rules/tmux-and-panes.md already says it is owed ("does not stamp
// ownership yet"). It is not built here because it needs a DISTINCT key from
// @hive-project-id - configureHiveWindow deliberately passes null for a
// window-placed worker, and re-introducing that stamp is the defect its own
// comment guards against - plus a third argument threaded through both
// window-creating sites. That is a lane of its own, not a line in this one.
//
// WHAT THE NAME CHECK COSTS IN THE MEANTIME, stated rather than left to be
// found. windowTitle's format becomes load-bearing: change it and window
// retitling silently stops everywhere, with no compile error and nothing red
// outside test/agent-names.test.mjs. And drift is ABSORBING rather than
// self-healing - the retitle is best-effort inside a catch, so one swallowed
// failure leaves the row's name and the window's name out of step forever, and
// every later rename reads that as "not ours" and declines a window hive does
// own. A stamp would be idempotent and immune to both. Accepted here because
// the failure direction is a stale label, never a wrong window retitled, and
// because the check it replaces was wrong in the OTHER direction.
//
// list-panes, not display-message: display-message silently answers for some
// other target when the one it is given is dead (see paneWindow and
// targetLiveProbe's own comments).
//
// ONE EXTRA FORK PER LIVE agent_rename, NOT FUSED, and that is deliberate
// rather than an oversight - two places in this codebase fuse exactly this
// kind of pair and say so (targetLiveProbe's "one list-panes call, not two",
// deliverable()'s "no second fork paid for reading .pid"), so a reader will
// look for it here. isLive() collapses its PaneProbe to a boolean at the call
// site, so fusing means widening PaneProbe and threading the probe through
// agent_rename. Measured: ~3.5ms added to a call that already pays 5-7 forks
// and a 300ms ENTER_DELAY_MS sleep, on the rarest tool in the set. The
// plumbing costs more than it buys. Counted, not estimated: a split-placed
// worker goes 5 forks to 6, a window-placed one 6 to 7.
function ownsItsWindow(target: string, expectedTitle: string): boolean {
  try {
    const [name, projectStamp, owned] = tmux(
      "list-panes", "-t", target, "-F", "#{window_name}\t#{@hive-project-id}\t#{@hive-owned}",
    )
      .split("\n")[0]
      .split("\t");
    // Three facts, one fork, and each rules out a different window.
    // @hive-owned=1 is on every window hive creates and on no window a human
    // made (configureHiveWindow, src/tmux.ts), so it rules out a user's own
    // window that happens to carry this title - reachable by naming a window
    // "<project> - <worker>" and moving the pane into it, and the case a name
    // comparison alone cannot see. @hive-project-id being ABSENT rules out a
    // project's shared window, which is the one holding a lead and every split
    // worker. The name is what makes it THIS worker's rather than another
    // window-placed worker's. tmux answers an unset window option as an empty
    // field, so "" is the unstamped case.
    return name === expectedTitle && (projectStamp ?? "") === "" && owned === "1";
  } catch {
    return false;
  }
}

export function renameAgent(
  agent: { id: number; actor_id: string; name: string; tmux_target: string },
  newName: string,
  // The project's name when this worker's tmux window may be retitled, null
  // when it may not - which today means "the caller could not confirm the pane
  // is live". It named a `window` object until todo 371 moved the which-window
  // decision in here; the object conveyed nothing about a window even then.
  projectName: string | null,
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
  // agent.name, not newName: the row as this caller read it is what the
  // window's CURRENT title was built from, and the UPDATE above has already
  // changed the row. The two titles sit adjacent here for that reason.
  if (projectName !== null && ownsItsWindow(agent.tmux_target, windowTitle(projectName, agent.name))) {
    try {
      tmux("rename-window", "-t", agent.tmux_target, windowTitle(projectName, newName));
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
// Issue #156 (todo 353 lane B), D2. The branch a lane was parked on, read at
// PARK TIME because that is the only time it can be read.
//
// Transcript resolution is a pure function of the cwd string (issue #5 D7), so
// a worktree removed while a lane is parked can be recreated at the same path
// and the session resumes - but only if the branch is still known, and once the
// directory is gone there is nowhere left to ask. That asymmetry is the whole
// argument for recording this rather than deriving it on read: deriving it later
// is not a cheaper option, it is an unavailable one. The lead removed a worktree
// out from under a running worker on 2026-08-11, so this is a case that has
// already happened here, not a hypothetical.
//
// The shape of the call mirrors gitPrimaryRoot (src/context.ts) deliberately,
// for its reasons rather than by copying: an argument array (no shell, per
// .claude/rules/tmux-and-panes.md), a bounded timeout because a cwd on a stalled
// network mount blocks git in the kernel, and a swallow-to-empty catch because
// "" is this column's own "no fact recorded" default. PARK MUST NOT FAIL OVER
// THIS - a lane that cannot be parked because git was slow is strictly worse
// than a parked lane with one unrecorded fact, and every other fact park needs
// is already on the row.
//
// A DETACHED HEAD ANSWERS "HEAD", which records nothing a reader could act on,
// so that one case falls through to the short sha - the value that actually
// recreates the checkout. Only reached when detached, so the ordinary lane pays
// one fork, not two.
export function branchAt(cwd: string): string {
  const git = (args: string[]): string | null => {
    try {
      return execFileSync("git", args, {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 2000,
      }).trim();
    } catch {
      return null;
    }
  };
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch === null) return "";
  if (branch !== "HEAD") return branch;
  return git(["rev-parse", "--short", "HEAD"]) ?? "";
}

// PARK IS CLOSE PLUS TWO FACTS, and it deliberately reuses closeAgentRow's own
// conditional-write shape rather than being a second way to close a row: the
// same id + status='running' + tmux_target CAS, for the same reason (a
// concurrent writer recording a fresh pane between the caller's probe and this
// write must not have its row retired on the strength of a probe that is no
// longer true).
//
// One statement, not close-then-update: a park that closed the row and then
// failed to stamp it would leave a lane looking finished when it is paused,
// which is the exact confusion issue #156 exists to remove.
export function parkAgentRow(agentId: number, expectedTmuxTarget: string, branch: string): string | undefined {
  // RETURNING, not a separate SELECT afterward - the same reason
  // src/tools/leases.ts states for its own: the receipt then comes from the
  // exact row this statement wrote, rather than from a re-read that a
  // concurrent writer can have moved in between. undefined is the CAS loss,
  // which is the caller's "nothing was parked" branch.
  return (
    db
      .prepare(
        "UPDATE agents SET status = 'closed', closed_at = datetime('now'), parked_at = datetime('now'), " +
          "parked_branch = ? WHERE id = ? AND status = 'running' AND tmux_target = ? RETURNING parked_at",
      )
      .get(branch, agentId, expectedTmuxTarget) as { parked_at: string } | undefined
  )?.parked_at;
}

// THE PARK STAMP IS TWO COLUMNS AND ONE CONCEPT, so the list of them lives
// here rather than being retyped at each site that clears it. Three writers
// touch it - parkAgentRow above sets it, resumeAgent clears it inside its own
// CAS (which has to stay one statement, so it splices this fragment rather
// than calling the helper), and agent_close's park release calls
// releaseParkRow. Issue #156 itself floated a third park column, and whichever
// one is added next, a release path that forgot it would leave `hive status`
// reporting a stale detail for a lane nobody parked - the "a parked crew goes
// stale" failure this feature exists to end, reintroduced by the release path
// built to prevent it.
export const PARK_STAMP_CLEARED = "parked_at = '', parked_branch = ''";

// THE SAME CAS EVERY OTHER RETIREMENT PATH IN THIS FILE TAKES, and it was the
// one that skipped the discipline (counselors, all three seats). Without the
// predicate: session A reads a parked row, session B resumes it (running, stamp
// cleared, pane live), A's unconditional UPDATE no-ops on the already-cleared
// columns, and A returns `{closed: true, park_released: true}` over a worker
// that is running. closeAgentRow returns a bool for exactly this reason and
// both of its call sites throw "row changed since this call probed it"; so does
// this one now.
export function releaseParkRow(agentId: number): boolean {
  return (
    db
      .prepare(`UPDATE agents SET ${PARK_STAMP_CLEARED} WHERE id = ? AND status = 'closed' AND parked_at != ''`)
      .run(agentId).changes > 0
  );
}

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
