import { getProject } from "./context.js";
import type { ProcessSnapshot } from "./dashboard.js";
import { db } from "./db.js";
import { loadProjectYml } from "./projectYml.js";
import { closeAgentRow, killAgentPane, relayoutAfterPaneLeft } from "./spawn.js";
import {
  cancelCopyMode,
  paneProcessExited,
  paneReissued,
  paneVisibility,
  paneWindow,
  projectWindows,
  rowLive,
  rowLiveProbe,
  sessionName,
  tmux,
} from "./tmux.js";

// One derivation for every surface that reports where a project's processes are: `hive status`,
// `hive doctor`, and the dashboard. Two tmux window lookups per project, then one per running
// process, and none at all for a project with neither a running command nor a defined one.
export function snapshotProcesses(projectId: number): ProcessSnapshot[] {
  const rows = runningCommandRows(projectId);
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

export const COMMAND_KIND = "command";

export const STOP_GRACE_MS = 2000;

// The closed set docs/projects.md's "Lifetime" section is checked against (test/docs.test.mjs):
// every way a hive.yml process can be stopped, named once here and rendered by whoever prints it.
export const STOP_REASONS = {
  byHand: "hive stop",
  leadSessionEnded: "lead session ended",
  leadPaneExited: "lead pane exited",
  previousLead: "left running by a previous lead",
} as const;

export type StopReason = (typeof STOP_REASONS)[keyof typeof STOP_REASONS];

export type StopLeg = "interrupted" | "killed" | "already-gone" | "unreachable" | "still-running";

export interface StoppedProcess {
  name: string;
  leg: StopLeg;
}

export interface StoppableRow {
  id: number;
  project_id: number;
  name: string;
  tmux_target: string;
  tmux_socket: string;
  pane_pid: string;
  created_at: string;
}

const STOPPABLE_COLUMNS = "id, project_id, name, tmux_target, tmux_socket, pane_pid, created_at";

export function runningCommandRows(projectId: number): StoppableRow[] {
  return db
    .prepare(
      `SELECT ${STOPPABLE_COLUMNS} FROM agents
       WHERE project_id = ? AND status = 'running' AND kind = 'command' ORDER BY created_at`,
    )
    .all(projectId) as StoppableRow[];
}

export function runningCommandRow(projectId: number, name: string): StoppableRow | undefined {
  return db
    .prepare(
      `SELECT ${STOPPABLE_COLUMNS} FROM agents
       WHERE project_id = ? AND name = ? AND status = 'running' AND kind = 'command'`,
    )
    .get(projectId, name) as StoppableRow | undefined;
}

export const STOPPING_MARKER_TTL_SECONDS = 30;

export const stoppingMarkerKey = (agentId: number): string => `stopping:${agentId}`;

// Written BEFORE the pane is touched and read by the janitor's sweep. Ordering alone used to carry
// "this process died on its own", and it could not: an interrupted stop left a closed row over a
// live process, invisible to every surface, and the next start doubled it (todo 765, measured).
function markStopping(projectId: number, agentId: number): void {
  try {
    db.prepare(
      `INSERT INTO kv (project_id, key, value, updated_by, expires_at)
       VALUES (?, ?, '"stopping"', 'hive', datetime('now', printf('+%d seconds', ?)))
       ON CONFLICT(project_id, key) DO UPDATE SET
         value = excluded.value, updated_at = datetime('now'), expires_at = excluded.expires_at`,
    ).run(projectId, stoppingMarkerKey(agentId), STOPPING_MARKER_TTL_SECONDS);
  } catch {

  }
}

export function stoppingMarkerLive(projectId: number, agentId: number): boolean {
  try {
    return !!db
      .prepare(
        `SELECT 1 FROM kv WHERE project_id = ? AND key = ?
          AND (expires_at IS NULL OR expires_at >= datetime('now'))`,
      )
      .get(projectId, stoppingMarkerKey(agentId));
  } catch {
    return false;
  }
}

function clearStoppingMarker(projectId: number, agentId: number): void {
  try {
    db.prepare("DELETE FROM kv WHERE project_id = ? AND key = ?").run(projectId, stoppingMarkerKey(agentId));
  } catch {

  }
}

const STOP_POLL_MS = 50;

function waitForPaneToExit(target: string, timeoutMs: number): boolean {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (paneProcessExited(target) === true) return true;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(STOP_POLL_MS, remaining));
  }
}

// The only thing that stops a hive.yml command. kill-pane alone is SIGHUP, which a dev server with
// detached grandchildren survives while still holding its port, so the graceful leg comes first and
// the receipt says which one ended it.
// `reason` is deliberately not read here and is not carried on the receipt: it is a required
// argument so every caller has to declare its trigger from the closed set docs/projects.md is
// checked against, and whichever caller prints it already knows which one it passed.
export function stopProcess(row: StoppableRow, reason: StopReason): StoppedProcess {
  const probe = rowLiveProbe(row.tmux_socket, row.tmux_target);

  // A pane hive cannot see is left alone, row and all: closing the row here would hide a process
  // that is still running from every surface that reports one.
  if (probe.live === null) return { name: row.name, leg: "unreachable" };

  // A reissued pane id belongs to whoever holds it now, so it is never killed - same compare as
  // janitor() and wake delivery.
  if (probe.live === false || paneReissued(row.pane_pid, probe)) {
    closeAgentRow(row.id);
    return { name: row.name, leg: "already-gone" };
  }

  markStopping(row.project_id, row.id);
  const window = paneWindow(row.tmux_target);
  try {

    // In copy mode C-c is `cancel`, not SIGINT, so the graceful leg would silently do nothing to a
    // pane someone scrolled back in. A stop may take that scrollback position: the process is ending.
    cancelCopyMode(row.tmux_target);
    tmux("send-keys", "-t", row.tmux_target, "C-c");
  } catch {

  }
  let leg: StopLeg = "interrupted";
  if (!waitForPaneToExit(row.tmux_target, STOP_GRACE_MS)) {
    try {
      killAgentPane(row.tmux_target);
    } catch {

    }
    leg = waitForPaneToExit(row.tmux_target, STOP_GRACE_MS) ? "killed" : "still-running";
  }

  // The row closes only once the pane is confirmed gone. A stop that did not finish leaves the row
  // RUNNING, so the process stays visible to hive status, hive stop and the janitor.
  if (leg === "still-running") return { name: row.name, leg };
  closeAgentRow(row.id, row.tmux_target);
  clearStoppingMarker(row.project_id, row.id);
  relayoutAfterPaneLeft(window);
  return { name: row.name, leg };
}

export function stopAllProcesses(projectId: number, reason: StopReason): StoppedProcess[] {
  return runningCommandRows(projectId).map((row) => stopProcess(row, reason));
}

export function stopLine(stopped: StoppedProcess): string {
  switch (stopped.leg) {
    case "interrupted":
      return `${stopped.name}: stopped (C-c)`;
    case "killed":
      return `${stopped.name}: stopped (killed after ${STOP_GRACE_MS / 1000}s)`;
    case "already-gone":
      return `${stopped.name}: already gone (nothing was running)`;
    case "unreachable":
      return `${stopped.name}: tmux could not be probed, so hive left it running`;
    case "still-running":
      return `${stopped.name}: still running: its pane survived C-c and kill-pane, so hive left the row open`;
  }
}
