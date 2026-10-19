import { db } from "./db.js";

export interface LeaseRow {
  project_id: number;
  lock_key: string;
  owner: string;
  acquired_at: string;
  expires_at: string;
}

export function purgeExpiredLeases(projectId: number, key?: string): void {
  if (key === undefined) {
    db.prepare("DELETE FROM leases WHERE project_id = ? AND expires_at < datetime('now')").run(projectId);
    return;
  }
  db.prepare("DELETE FROM leases WHERE project_id = ? AND lock_key = ? AND expires_at < datetime('now')").run(projectId, key);
}

export function insertLease(projectId: number, key: string, actor: string, ttlSeconds: number): { expires_at: string } | undefined {
  return db
    .prepare(
      `INSERT INTO leases (project_id, lock_key, owner, expires_at)
       VALUES (?, ?, ?, datetime('now', printf('+%d seconds', ?)))
       ON CONFLICT(project_id, lock_key) DO NOTHING
       RETURNING expires_at`,
    )
    .get(projectId, key, actor, ttlSeconds) as { expires_at: string } | undefined;
}

export function readLease(projectId: number, key: string): LeaseRow | undefined {
  return db.prepare("SELECT * FROM leases WHERE project_id = ? AND lock_key = ?").get(projectId, key) as
    | LeaseRow
    | undefined;
}

export function extendOwnedLease(projectId: number, key: string, actor: string, ttlSeconds: number): boolean {
  const info = db
    .prepare(
      `UPDATE leases SET expires_at = datetime('now', printf('+%d seconds', ?))
       WHERE project_id = ? AND lock_key = ? AND owner = ?`,
    )
    .run(ttlSeconds, projectId, key, actor);
  return info.changes > 0;
}

export function releaseOwnedLease(projectId: number, key: string, actor: string): boolean {
  return db
    .prepare("DELETE FROM leases WHERE project_id = ? AND lock_key = ? AND owner = ?")
    .run(projectId, key, actor).changes > 0;
}

export function paneLeaseKey(socket: string, pane: string): string {
  return `wake-pane:${socket}:${pane}`;
}

export const PANE_LEASE_TTL_SECONDS = 6;
export const PANE_LEASE_SETTLE_MS = 500;

export function tryAcquirePaneLease(
  projectId: number,
  socket: string,
  pane: string,
  actor: { id: string; name: string; kind: "agent" | "scheduler" },
): string | null {
  try {
    db.prepare("INSERT OR IGNORE INTO actors (id, name, kind) VALUES (?, ?, ?)").run(actor.id, actor.name, actor.kind);
    const key = paneLeaseKey(socket, pane);
    purgeExpiredLeases(projectId, key);
    return insertLease(projectId, key, actor.id, PANE_LEASE_TTL_SECONDS)?.expires_at ?? null;
  } catch {
    return null;
  }
}

export function releasePaneLease(projectId: number, socket: string, pane: string, expiresAt: string): void {
  try {
    db.prepare("DELETE FROM leases WHERE project_id = ? AND lock_key = ? AND expires_at = ?").run(
      projectId,
      paneLeaseKey(socket, pane),
      expiresAt,
    );
  } catch {

  }
}
