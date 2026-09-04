import { execFileSync } from "node:child_process";
import { reapCodexHome } from "./codexHome.js";
import { dataDir, db } from "./db.js";
import {
  applyLayout,
  claimInitialWindow,
  createWindow,
  DEFAULT_LAYOUT,
  ensureSession,
  crossServerRefusal,
  findProcessesWindow,
  findProjectWindow,
  panePid,
  paneWindow,
  PROCESSES_LAYOUT,
  processesPaneTitle,
  processesWindowName,
  retainOnExitArgs,
  rowLive,
  sessionName,
  setPaneTitle,
  makeProcessesWindow,
  tmux,
  tmuxSocketPath,
  untrustedTmuxServer,
  waitForPaneEstablished,
  windowOwner,
  windowTitle,
  type WindowLayout,
} from "./tmux.js";

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

export interface LaunchSpec {
  projectId: number;
  projectName: string;
  projectPath: string;
  name: string;
  kind: "agent" | "command";

  commandString: string | ((ids: { agentId: number; actorId: string }) => string);
  cwd: string;
  env: Record<string, string>;

  // "processes" is reachable only from a hive.yml `visible: false` command (startYmlCommand);
  // agent_spawn's own enum stays "split" | "window", so no worker or lead can be placed this way.
  placement: "split" | "window" | "processes";

  layout?: WindowLayout;
  parentActor: string;

  sessionId?: string;

  // The codexHome.ts key, if this worker needs a per-worker CODEX_HOME (harness.needsHome). Written
  // into the SAME INSERT that creates the row, before ensureCodexHome's mkdirSync ever runs - see
  // reapCodexHomeForClosedAgent below for why that ordering is load-bearing for reaping.
  codexHome?: string;

  // Chained atomically into the pane's own creation call (never a follow-up), so a command that
  // exits during the caller's own readiness wait leaves its final screen readable instead of being
  // torn down with the rest of the window. The caller owns turning it back off (or capturing and
  // killing) once that wait resolves; see agents.ts's agent_spawn handler.
  retainOnExit?: boolean;
}

export function splitTargetWindow(session: string, projectId: number, parentActor: string): string | null {

  const parent = db
    .prepare("SELECT tmux_target, tmux_socket FROM agents WHERE actor_id = ? AND status = 'running' ORDER BY id DESC LIMIT 1")
    .get(parentActor) as { tmux_target: string; tmux_socket: string } | undefined;
  if (parent && rowLive(parent.tmux_socket, parent.tmux_target) === true) {
    const window = paneWindow(parent.tmux_target);

    if (window) return `${session}:${window.split(":")[1]}`;
  }
  return findProjectWindow(session, projectId) ?? null;
}

export function buildEnvFlags(env: Record<string, string>): string[] {
  return Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
}

function agentIdentityEnv(actorId: string, name: string, projectPath: string): Record<string, string> {
  return {
    HIVE_AGENT_ID: actorId,
    HIVE_AGENT_NAME: name,
    HIVE_PROJECT_LOCK: "1",
    HIVE_PROJECT_PATH: projectPath,
    HIVE_DATA_DIR: dataDir,

    HIVE_LEAD: "",
  };
}

function recordPane(agentId: number, target: string, socket: string): boolean {
  return (
    db
      .prepare(
        "UPDATE agents SET tmux_target = ?, tmux_socket = ?, pane_pid = ? WHERE id = ? AND status = 'running'",
      )
      .run(target, socket, panePid(target), agentId).changes > 0
  );
}

export function discardOrphanedPane(target: string): void {
  try {
    waitForPaneEstablished(target);
    tmux("kill-pane", "-t", target);
  } catch {

  }
}

const paneRacedRetirement = (agentId: number) =>
  new Error(
    `Agent ${agentId}'s row was retired (closed or parked) while its pane was being created, so the pane was ` +
      "discarded rather than recorded against a row that is no longer running. Nothing is left running for it. " +
      "Re-read the row with agent_status and resume or spawn again if that was not what you intended.",
  );

export function asNameClash(e: unknown, name: string): unknown {
  const err = e as { code?: string; message?: string };
  const message = err.message ?? "";
  if (
    err.code === "SQLITE_CONSTRAINT_UNIQUE" &&
    (message.includes("agents.name") || message.includes("idx_agents_running_name"))
  ) {

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

export const LEAD_KIND = "lead";
export const LEAD_ACTOR_PREFIX = `${LEAD_KIND}:`;
export const isLeadActorId = (actorId: string): boolean => actorId.startsWith(LEAD_ACTOR_PREFIX);
export const mintLeadActorId = (agentId: number): string => `${LEAD_ACTOR_PREFIX}${agentId}`;

export const isRunningLeadActor = (actorId: string): boolean =>
  !!db.prepare("SELECT 1 FROM agents WHERE actor_id = ? AND kind = ? AND status = 'running'").get(actorId, LEAD_KIND);

export const LEAD_NAME = LEAD_KIND;
export const isReservedAgentName = (name: string): boolean => name.toLowerCase() === LEAD_NAME;

export function upsertActor(actorId: string, name: string, kind: string): void {
  db.prepare(
    `INSERT INTO actors (id, name, kind) VALUES (?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, last_seen_at = datetime('now')`,
  ).run(actorId, name, kind);
}

function placeAgentPane(
  session: string,
  spec: Pick<
    LaunchSpec,
    | "projectId"
    | "projectName"
    | "projectPath"
    | "name"
    | "cwd"
    | "placement"
    | "layout"
    | "parentActor"
    | "retainOnExit"
  >,
  envFlags: string[],
  commandString: string,
  title: string,
): { target: string; landedInProjectId: number | null; layoutApplied: boolean; inProcessesWindow: boolean } {
  let landedInProjectId: number | null = null;
  let layoutApplied = false;
  let inProcessesWindow = false;
  const target = withWindowClaim((): string => {

    const windowName = spec.placement === "split" ? spec.projectName : title;
    const windowOwnerId = spec.placement === "split" ? spec.projectId : null;
    const started = ensureSession(session, spec.cwd, { envFlags, command: commandString });
    if (started.created) {

      // Deliberate for placement "processes" too: this pane IS the new session's initial window, so it
      // takes that window rather than a tile. The caller reports it; `hive hide` moves it in later.
      return claimInitialWindow(started, windowName, windowOwnerId).pane;
    }
    const splitInto = (window: string, layout: WindowLayout): string => {
      const pane = tmux(
        "split-window", "-d", "-P", "-F", "#{pane_id}",
        "-t", window, "-c", spec.cwd, ...envFlags, commandString,
        ...(spec.retainOnExit ? retainOnExitArgs(window) : []),
      );
      applyLayout(window, layout);
      layoutApplied = true;
      return pane;
    };
    if (spec.placement === "processes") {
      let pane: string;
      const existing = findProcessesWindow(session, spec.projectId);
      if (existing) {
        pane = splitInto(existing, PROCESSES_LAYOUT);
      } else {
        const made = createWindow(
          session, processesWindowName(spec.projectName), spec.cwd, envFlags, commandString, null, true,
          spec.retainOnExit ?? false,
        );
        makeProcessesWindow(made.window, spec.projectId);
        pane = made.pane;
      }
      setPaneTitle(pane, processesPaneTitle(spec.projectName, spec.name));
      inProcessesWindow = true;
      return pane;
    }
    if (spec.placement === "split") {
      const found = splitTargetWindow(session, spec.projectId, spec.parentActor);
      if (found) {
        const pane = splitInto(found, spec.layout ?? DEFAULT_LAYOUT);
        const owner = windowOwner(found);
        if (owner !== null && owner !== spec.projectId) landedInProjectId = owner;
        return pane;
      }
    }
    return createWindow(
      session, windowName, spec.cwd, envFlags, commandString, windowOwnerId, true,
      spec.retainOnExit ?? false,
    ).pane;
  });
  return { target, landedInProjectId, layoutApplied, inProcessesWindow };
}

export function launchAgent(spec: LaunchSpec): {
  agentId: number;
  actorId: string;
  target: string;
  landedInProjectId: number | null;
  layoutApplied: boolean;
  inProcessesWindow: boolean;
} {

  if (untrustedTmuxServer()) throw crossServerRefusal("spawn");

  const socket = tmuxSocketPath(process.env.TMUX, process.env.TMUX_TMPDIR);
  let info;
  try {
    info = db
      .prepare(

        "INSERT INTO agents (project_id, name, command, cwd, kind, parent_actor_id, tmux_socket, session_id, codex_home) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        spec.projectId,
        spec.name,

        typeof spec.commandString === "string" ? spec.commandString : "",
        spec.cwd,
        spec.kind,
        spec.parentActor,
        socket,
        spec.sessionId ?? "",
        spec.codexHome ?? "",
      );
  } catch (e) {

    throw asNameClash(e, spec.name);
  }
  const agentId = Number(info.lastInsertRowid);
  const actorId = `${spec.kind}:${agentId}`;

  let paneUp = false;
  try {
    const commandString =
      typeof spec.commandString === "string" ? spec.commandString : spec.commandString({ agentId, actorId });
    db.prepare("UPDATE agents SET actor_id = ?, command = ? WHERE id = ?").run(actorId, commandString, agentId);
    upsertActor(actorId, spec.name, spec.kind);

    const session = sessionName();

    const env =
      spec.kind === "agent"
        ? { ...spec.env, ...agentIdentityEnv(actorId, spec.name, spec.projectPath) }
        : spec.env;
    const envFlags = buildEnvFlags(env);

    const title = windowTitle(spec.projectName, spec.name);

    const { target, landedInProjectId, layoutApplied, inProcessesWindow } = placeAgentPane(
      session, spec, envFlags, commandString, title,
    );
    paneUp = true;

    if (!recordPane(agentId, target, socket)) {
      discardOrphanedPane(target);
      throw paneRacedRetirement(agentId);
    }
    return { agentId, actorId, target, landedInProjectId, layoutApplied, inProcessesWindow };
  } catch (e) {
    if (paneUp) throw e;
    db.prepare("DELETE FROM agents WHERE id = ?").run(agentId);
    throw e;
  }
}

export interface ResumeSpec {
  agentId: number;
  actorId: string;
  name: string;
  projectId: number;
  projectName: string;
  projectPath: string;
  cwd: string;

  commandString: string;
  placement: "split" | "window";
  layout?: WindowLayout;
  parentActor: string;

  // Merged under agentIdentityEnv the same way launchAgent merges spec.env (:245-248) - claude's
  // resume never needed this, so it defaulted to none; a codex resume needs CODEX_HOME pointed at
  // the worker's surviving per-worker home (todo 563).
  env?: Record<string, string>;
}

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

export function resumeFlipSql(): string {

  return (
    "UPDATE agents SET status = 'running', closed_at = NULL, tmux_target = '', pane_pid = '', " +
    `agent_state = 'unknown', state_changed_at = NULL, ${PARK_STAMP_CLEARED}, ` +
    "resumed_at = datetime('now'), tmux_socket = ?, command = ? " +
    "WHERE id = ? AND status = 'closed'"
  );
}

function restoreFlippedRow(agentId: number, before: Record<string, string | null>): void {
  db.prepare(
    `UPDATE agents SET ${RESUME_FLIP_COLUMNS.map((c) => `${c} = ?`).join(", ")} ` +
      "WHERE id = ? AND status = 'running' AND tmux_target = ''",
  ).run(...RESUME_FLIP_COLUMNS.map((c) => before[c] ?? null), agentId);
}

export function resumeAgent(
  spec: ResumeSpec,
): { target: string; landedInProjectId: number | null } {

  if (untrustedTmuxServer()) throw crossServerRefusal("resume");
  const socket = tmuxSocketPath(process.env.TMUX, process.env.TMUX_TMPDIR);

  let flip: { before: Record<string, string | null> | undefined; changes: number };

  const captureBeforeFlip = db.prepare(`SELECT ${RESUME_FLIP_COLUMNS.join(", ")} FROM agents WHERE id = ?`);
  const flipStatement = db.prepare(resumeFlipSql());
  try {

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

    upsertActor(spec.actorId, spec.name, "agent");

    const envFlags = buildEnvFlags({
      ...spec.env,
      ...agentIdentityEnv(spec.actorId, spec.name, spec.projectPath),
    });
    const session = sessionName();
    const title = windowTitle(spec.projectName, spec.name);
    const { target, landedInProjectId } = placeAgentPane(session, spec, envFlags, spec.commandString, title);
    paneUp = true;

    if (!recordPane(spec.agentId, target, socket)) {
      discardOrphanedPane(target);
      throw paneRacedRetirement(spec.agentId);
    }
    return { target, landedInProjectId };
  } catch (e) {

    if (!paneUp) {
      if (flip.before) restoreFlippedRow(spec.agentId, flip.before);
      else closeAgentRow(spec.agentId);
    }
    throw e;
  }
}

function ownsItsWindow(target: string, expectedTitle: string): boolean {
  try {
    const [name, projectStamp, owned] = tmux(
      "list-panes", "-t", target, "-F", "#{window_name}\t#{@hive-project-id}\t#{@hive-owned}",
    )
      .split("\n")[0]
      .split("\t");

    return name === expectedTitle && (projectStamp ?? "") === "" && owned === "1";
  } catch {
    return false;
  }
}

export function renameAgent(
  agent: { id: number; actor_id: string; name: string; tmux_target: string },
  newName: string,

  projectName: string | null,
): void {
  try {
    db.transaction(() => {
      db.prepare("UPDATE agents SET name = ? WHERE id = ?").run(newName, agent.id);
      db.prepare("UPDATE actors SET name = ? WHERE id = ?").run(newName, agent.actor_id);
    })();
  } catch (e) {

    throw asNameClash(e, newName);
  }

  if (projectName !== null && ownsItsWindow(agent.tmux_target, windowTitle(projectName, agent.name))) {
    try {
      tmux("rename-window", "-t", agent.tmux_target, windowTitle(projectName, newName));
    } catch {

    }
  }
}

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

export function parkAgentRow(agentId: number, expectedTmuxTarget: string, branch: string): string | undefined {

  return (
    db
      .prepare(
        "UPDATE agents SET status = 'closed', closed_at = datetime('now'), parked_at = datetime('now'), " +
          "parked_branch = ? WHERE id = ? AND status = 'running' AND tmux_target = ? RETURNING parked_at",
      )
      .get(branch, agentId, expectedTmuxTarget) as { parked_at: string } | undefined
  )?.parked_at;
}

export const PARK_STAMP_CLEARED = "parked_at = '', parked_branch = ''";

export function releaseParkRow(agentId: number): boolean {
  return (
    db
      .prepare(`UPDATE agents SET ${PARK_STAMP_CLEARED} WHERE id = ? AND status = 'closed' AND parked_at != ''`)
      .run(agentId).changes > 0
  );
}

// Row status alone is not the orphan test: a PARKED row is `status = 'closed'` too
// (parkAgentRow above), and agent_park expects to resume it, cold-cache and all. `parked_at = ''`
// is named explicitly rather than left to fall out of "closed" incidentally: codex can now be
// parked too (harnessFor("codex").supportsResume, todo 563), exactly as this predicate already
// assumed some non-claude harness eventually would - deriving the exclusion from harness capability
// instead would have made this reap query's correctness depend on a table this file does not own.
//
// No conditional-UPDATE claim guards this, unlike closeAgentRow's "the conditional UPDATE is the
// claim" - a deliberate difference, not a gap. That pattern earns its keep against an OBSERVABLE
// side effect: a wake fired twice types into a pane twice. A reap has none - two instances racing
// the same directory produce one deleted directory (rmSync's force:true swallows ENOENT even mid
// recursive delete, not just on the top-level path), and the loser's `codex_home` update just
// matches zero rows. Deleted twice is deleted once, so there is nothing here for a claim to arbitrate.
//
// rmSync runs before the clear, not after: if it throws (permissions, a mid-delete race), codex_home
// stays set and this row is picked up again - by the next agent_close call, or by the janitor's own
// backstop sweep - rather than the failure being silently swallowed by a claim that already fired.
// The column IS the retry token; that is the guard here, it is just not shaped like a CAS.
// Both callers wrap this, so a failure here costs a retry, never the close or the sweep it runs inside.
export function reapCodexHomeForClosedAgent(agentId: number, codexHome: string): void {
  reapCodexHome(codexHome);
  db.prepare("UPDATE agents SET codex_home = '' WHERE id = ? AND codex_home = ?").run(agentId, codexHome);
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
