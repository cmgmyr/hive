import { getProject } from "./context.js";
import type { ProcessSnapshot } from "./dashboard.js";
import { db } from "./db.js";
import { loadProjectYml } from "./projectYml.js";
import { paneVisibility, projectWindows, rowLive, sessionName } from "./tmux.js";

interface CommandRow {
  name: string;
  tmux_target: string;
  tmux_socket: string;
  created_at: string;
}

// One derivation for every surface that reports where a project's processes are: `hive status`,
// `hive doctor`, and the dashboard. Two tmux window lookups per project, then one per running
// process, and none at all for a project with neither a running command nor a defined one.
export function snapshotProcesses(projectId: number): ProcessSnapshot[] {
  const rows = db
    .prepare(
      `SELECT name, tmux_target, tmux_socket, created_at FROM agents
       WHERE project_id = ? AND status = 'running' AND kind = 'command' ORDER BY created_at`,
    )
    .all(projectId) as CommandRow[];
  const project = getProject(projectId);
  const defined = project ? Object.keys(loadProjectYml(project.path).config?.processes ?? {}) : [];
  if (rows.length === 0 && defined.length === 0) return [];

  const windows = rows.length > 0 ? projectWindows(sessionName(), projectId) : null;
  const running = new Set(rows.map((r) => r.name));
  return [
    ...rows.map((r) => ({
      name: r.name,
      running: true,

      // A row recorded on a socket this process cannot see into reads as unknown, never as a
      // location: the pane id would name whatever holds it on THIS server.
      visibility:
        windows !== null && rowLive(r.tmux_socket, r.tmux_target) === true ? paneVisibility(r.tmux_target, windows) : null,
      startedAt: r.created_at,
    })),
    ...defined
      .filter((name) => !running.has(name))
      .map((name) => ({ name, running: false, visibility: null, startedAt: null })),
  ];
}
