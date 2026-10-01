import { backupNow } from "./backup.js";
import { dataDir, db } from "./db.js";
import { LEAD_KIND } from "./spawn.js";
import { liveTargets, rowOwnership, type RowPaneIdentity } from "./tmux.js";

export const PROJECT_OWNER_TABLES = [
  "pads",
  "todos",
  "kv",
  "leases",
  "agents",
  "wakes",
  "command_trust",
] as const;

const COUNTED_TABLES: readonly [string, string][] = [
  ...PROJECT_OWNER_TABLES.map((t): [string, string] => [t, `SELECT COUNT(*) AS n FROM ${t} WHERE project_id = ?`]),
  ["todo_comments", "SELECT COUNT(*) AS n FROM todo_comments WHERE todo_id IN (SELECT id FROM todos WHERE project_id = ?)"],
  ["agent_messages", "SELECT COUNT(*) AS n FROM agent_messages WHERE project_id = ?"],
];

export function projectRowCounts(projectId: number): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const [table, sql] of COUNTED_TABLES) {
    const n = (db.prepare(sql).get(projectId) as { n: number }).n;
    if (n > 0) counts[table] = n;
  }
  return counts;
}

export function formatRowCounts(counts: Record<string, number>): string {
  return Object.entries(counts)
    .map(([table, n]) => `${table}: ${n}`)
    .join(", ");
}

export interface RemovedProject {
  deleted: { id: number; name: string; path: string };
  counts: Record<string, number>;
  snapshot: string | null;
}

function assertNoRunningAgents(projectId: number, name: string): void {
  const running = db
    .prepare("SELECT id, name, kind, tmux_target, tmux_socket, pane_pid FROM agents WHERE project_id = ? AND status = 'running' ORDER BY id")
    .all(projectId) as ({ id: number; name: string; kind: string } & RowPaneIdentity)[];
  if (running.length === 0) return;
  const snapshot = liveTargets();
  const blockers = running
    .map((a) => ({ ...a, ownership: rowOwnership(a, snapshot) }))
    .filter((a) => a.ownership === "live" || a.ownership === "unknown");
  if (blockers.length === 0) return;
  const names = blockers
    .map((a) => `${a.name} (agent ${a.id}, ${a.ownership === "live" ? "owns a live pane" : "pane identity unknown"})`)
    .join(", ");
  const hints: string[] = [];
  const liveLeads = blockers.filter((a) => a.ownership === "live" && a.kind === LEAD_KIND);
  const liveOthers = blockers.filter((a) => a.ownership === "live" && a.kind !== LEAD_KIND);
  const unknown = blockers.filter((a) => a.ownership === "unknown");
  if (liveLeads.length > 0) hints.push("A live lead is stopped or restarted from its own terminal, never retired with row_only.");
  if (liveOthers.length > 0) hints.push("Stop a live worker or command with agent_close first.");
  if (unknown.length > 0) {
    hints.push(
      "A row whose pane cannot be verified is retired explicitly by a human or peer lead through this project's MCP " +
        `tool, ${unknown.map((a) => `agent_close({agent_id: ${a.id}, row_only: true})`).join(", ")}, or run this ` +
        "again from the tmux socket the row was recorded on once its ownership can be verified.",
    );
  }
  throw new Error(`project ${projectId} ("${name}") has running agents: ${names}. Nothing deleted. ${hints.join(" ")}`);
}

const deleteProjectRows = db.transaction(
  (projectId: number, name: string, expected: Record<string, number>, after: () => void): void => {
    assertNoRunningAgents(projectId, name);
    if (JSON.stringify(projectRowCounts(projectId)) !== JSON.stringify(expected)) {
      throw new Error(`project ${projectId} ("${name}") changed while the snapshot was taken; nothing removed, run it again.`);
    }
    db.prepare("DELETE FROM agent_messages WHERE project_id = ?").run(projectId);
    if (db.prepare("DELETE FROM projects WHERE id = ?").run(projectId).changes === 0) {
      throw new Error(`no project ${projectId}.`);
    }
    after();
  },
);

export function removeProject(
  projectId: number,
  opts: { snapshot: boolean; afterSnapshot?: () => void; onRemoved?: (removed: RemovedProject) => void },
): RemovedProject {
  const target = db.prepare("SELECT id, name, path FROM projects WHERE id = ?").get(projectId) as
    | { id: number; name: string; path: string }
    | undefined;
  if (!target) throw new Error(`no project ${projectId}.`);
  assertNoRunningAgents(projectId, target.name);

  const counts = projectRowCounts(projectId);
  let snapshot: string | null = null;
  if (opts.snapshot) {
    const result = backupNow(db, dataDir, "manual");
    if (!result.ok) throw new Error(`could not snapshot the store first, nothing deleted: ${result.error ?? "unknown error"}`);
    snapshot = result.path ?? null;
  }
  opts.afterSnapshot?.();
  const removed = { deleted: { id: target.id, name: target.name, path: target.path }, counts, snapshot };
  deleteProjectRows.immediate(projectId, target.name, counts, () => opts.onRemoved?.(removed));
  return removed;
}
