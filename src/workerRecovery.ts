import { db } from "./db.js";
import type { RowPaneIdentity } from "./tmux.js";

export const WORKER_RECOVERY_RETENTION_SECONDS = 7 * 24 * 60 * 60;

export function markWorkerRetirementIntent(agentId: number, expected: RowPaneIdentity): boolean {
  return (
    db
      .prepare(
        `UPDATE agents SET recovery_state = 'excluded'
          WHERE id = ? AND kind = 'agent' AND status IN ('running', 'closed')
            AND tmux_target = ? AND tmux_socket = ? AND pane_pid = ?`,
      )
      .run(agentId, expected.tmux_target, expected.tmux_socket, expected.pane_pid).changes > 0
  );
}

export function markWorkerLost(agentId: number, expected: RowPaneIdentity): boolean {
  return (
    db
      .prepare(
        `UPDATE agents SET status = 'closed', closed_at = datetime('now'), recovery_state = 'pending'
          WHERE id = ? AND kind = 'agent' AND status = 'running' AND recovery_state != 'excluded'
            AND tmux_target = ? AND tmux_socket = ? AND pane_pid = ?`,
      )
      .run(agentId, expected.tmux_target, expected.tmux_socket, expected.pane_pid).changes > 0
  );
}
