import { dataDir, db } from "./db.js";
import {
  applyLayout,
  claimInitialWindow,
  DEFAULT_LAYOUT,
  ensureSession,
  sessionName,
  tmux,
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

export function launchAgent(spec: LaunchSpec): { agentId: number; actorId: string; target: string } {
  const info = db
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
  const agentId = Number(info.lastInsertRowid);
  const actorId = `${spec.kind}:${agentId}`;
  try {
    const commandString =
      typeof spec.commandString === "string" ? spec.commandString : spec.commandString({ agentId, actorId });
    db.prepare("UPDATE agents SET actor_id = ?, command = ? WHERE id = ?").run(actorId, commandString, agentId);
    db.prepare(
      `INSERT INTO actors (id, name, kind) VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, last_seen_at = datetime('now')`,
    ).run(actorId, spec.name, spec.kind);

    const session = sessionName(spec.projectId);
    const createdSession = ensureSession(session, spec.projectPath);
    const env =
      spec.kind === "agent"
        ? {
            HIVE_AGENT_ID: actorId,
            HIVE_AGENT_NAME: spec.name,
            HIVE_PROJECT_LOCK: "1",
            HIVE_DATA_DIR: dataDir,
            ...spec.env,
          }
        : spec.env;
    const envFlags = Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);

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
    db.prepare("UPDATE agents SET tmux_target = ? WHERE id = ?").run(target, agentId);
    return { agentId, actorId, target };
  } catch (e) {
    db.prepare("DELETE FROM agents WHERE id = ?").run(agentId);
    throw e;
  }
}

export function closeAgentRow(agentId: number): void {
  db.prepare(
    "UPDATE agents SET status = 'closed', closed_at = datetime('now') WHERE id = ? AND status = 'running'",
  ).run(agentId);
}
