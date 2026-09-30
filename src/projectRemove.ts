import { backupNow } from "./backup.js";
import { dataDir, db } from "./db.js";

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
  ["lead_idle_subscriptions", "SELECT COUNT(*) AS n FROM lead_idle_subscriptions WHERE target_project_id = ?"],
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

const deleteProjectRows = db.transaction((projectId: number): void => {
  db.prepare("DELETE FROM agent_messages WHERE project_id = ?").run(projectId);
  db.prepare("DELETE FROM lead_idle_subscriptions WHERE target_project_id = ?").run(projectId);
  db.prepare("DELETE FROM projects WHERE id = ?").run(projectId);
});

export function removeProject(projectId: number, opts: { snapshot: boolean }): RemovedProject {
  const target = db.prepare("SELECT id, name, path FROM projects WHERE id = ?").get(projectId) as
    | { id: number; name: string; path: string }
    | undefined;
  if (!target) throw new Error(`no project ${projectId}.`);

  const running = db
    .prepare("SELECT id, name FROM agents WHERE project_id = ? AND status = 'running' ORDER BY id")
    .all(projectId) as { id: number; name: string }[];
  if (running.length > 0) {
    const names = running.map((a) => `${a.name} (agent ${a.id})`).join(", ");
    throw new Error(
      `project ${projectId} ("${target.name}") has running agents: ${names}. Nothing deleted. Run hive doctor to close rows whose panes are gone, or agent_close them.`,
    );
  }

  const counts = projectRowCounts(projectId);
  let snapshot: string | null = null;
  if (opts.snapshot) {
    const result = backupNow(db, dataDir, "manual");
    if (!result.ok) throw new Error(`could not snapshot the store first, nothing deleted: ${result.error ?? "unknown error"}`);
    snapshot = result.path ?? null;
  }
  deleteProjectRows.immediate(projectId);
  return { deleted: { id: target.id, name: target.name, path: target.path }, counts, snapshot };
}
