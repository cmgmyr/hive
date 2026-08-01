import { dataDir, db } from "./db.js";
import {
  applyLayout,
  claimInitialWindow,
  DEFAULT_LAYOUT,
  ensureSession,
  crossServerRefusal,
  sessionName,
  tmux,
  untrustedTmuxServer,
  windowTitle,
  type WindowLayout,
} from "./tmux.js";

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
}

// Where a split-placed worker lands: the caller's own window when the caller
// (usually the lead) lives in this session, else the "lead" window, else the
// session's first window. Everything stays on one screen.
function splitTargetWindow(session: string, leadTitle: string): string {
  const pane = process.env.TMUX_PANE;
  if (pane) {
    try {
      // Echo the pane id back to confirm the target resolved to OUR pane;
      // display-message falls back to a default target when it is gone.
      const info = tmux("display-message", "-p", "-t", pane, "#{pane_id} #{session_name}:#{window_id}");
      const [paneId, window] = info.split(" ");
      if (paneId === pane && window.startsWith(`${session}:`)) return window;
    } catch {
      // Caller is not in tmux; fall through.
    }
  }
  const rows = tmux("list-windows", "-t", `=${session}`, "-F", "#{window_name}\t#{session_name}:#{window_id}")
    .split("\n")
    .map((r) => r.split("\t"));
  return (rows.find(([name]) => name === leadTitle) ?? rows[0])[1];
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

export function launchAgent(spec: LaunchSpec): { agentId: number; actorId: string; target: string } {
  // The write half of the guard in tmux.ts. Refusing to READ liveness off a
  // tmux server this store does not live on is only half a fix while the write
  // path keeps putting that server's pane ids into the store.
  //
  // What a spawn under the bad pair does: sessionName() returns the untagged
  // hive-1 for the default store, ensureSession does not find it on the private
  // server and creates a second one there, and the pane id from that fresh
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
  let info;
  try {
    info = db
      .prepare(
        "INSERT INTO agents (project_id, name, command, cwd, kind, parent_actor_id) VALUES (?, ?, ?, ?, ?, ?)",
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

    const session = sessionName(spec.projectId);
    const createdSession = ensureSession(session, spec.projectPath);
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
        ? {
            ...spec.env,
            HIVE_AGENT_ID: actorId,
            HIVE_AGENT_NAME: spec.name,
            HIVE_PROJECT_LOCK: "1",
            HIVE_PROJECT_PATH: spec.projectPath,
            HIVE_DATA_DIR: dataDir,
            // Issue #27's L4 fix round, DECISION 7b. Never set true here, but
            // never explicitly cleared either, and tmux panes inherit the
            // server's global environment - so a worker launched on a server
            // whose environment happens to carry HIVE_LEAD=1 (nothing
            // reachable sets it that way today) would pass kickoff's === "1"
            // check as if it were the lead. Cheap insurance against a path
            // that does not exist yet rather than one that does.
            HIVE_LEAD: "",
          }
        : spec.env;
    const envFlags = buildEnvFlags(env);

    const title = windowTitle(spec.projectName, spec.name);
    let target: string;
    if (createdSession) {
      const { pane, window } = claimInitialWindow(session, title, spec.cwd, envFlags, commandString);
      target = spec.placement === "split" ? pane : window;
    } else if (spec.placement === "split") {
      const win = splitTargetWindow(session, windowTitle(spec.projectName, "lead"));
      target = tmux(
        "split-window", "-P", "-F", "#{pane_id}",
        "-t", win, "-c", spec.cwd, ...envFlags, commandString,
      );
      applyLayout(win, spec.layout ?? DEFAULT_LAYOUT);
    } else {
      target = tmux(
        "new-window", "-P", "-F", "#{session_name}:#{window_id}",
        "-t", session, "-n", title, "-c", spec.cwd, ...envFlags, commandString,
      );
    }
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
    db.prepare("UPDATE agents SET tmux_target = ? WHERE id = ?").run(target, agentId);
    return { agentId, actorId, target };
  } catch (e) {
    if (paneUp) throw e;
    db.prepare("DELETE FROM agents WHERE id = ?").run(agentId);
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
