import { db } from "./db.js";

export interface LeaseRow {
  project_id: number;
  lock_key: string;
  owner: string;
  acquired_at: string;
  expires_at: string;
}

export interface LeaseWaitInput {
  max_wait_seconds: number;
  delivery: { actor: string; pane: string };
}

export interface LeaseAcquireResult {
  project_id: number;
  key: string;
  acquired: boolean;
  expires_at?: string;
  extended?: boolean;
  held_by?: string;
  queued?: true;
  position?: number;
}

interface WaiterRow {
  id: number;
  project_id: number;
  lock_key: string;
  actor_id: string;
  agent_id: number;
  ttl_seconds: number;
  max_wait_at: string;
}

interface DeliveryRow {
  project_id: number;
  actor_id: string;
  tmux_target: string;
  status: string;
  parked_at: string;
}

function liveDelivery(agentId: number, projectId: number, actor: string): DeliveryRow | undefined {
  return db.prepare(
    `SELECT project_id, actor_id, tmux_target, status, parked_at FROM agents
     WHERE id = ? AND project_id = ? AND actor_id = ? AND status = 'running' AND parked_at = ''`,
  ).get(agentId, projectId, actor) as DeliveryRow | undefined;
}

function fileWaitWake(projectId: number, actor: string, pane: string, body: string): void {
  db.prepare(
    `INSERT INTO wakes (project_id, owner, body, kind, deliver_actor, deliver_pane, due_at)
     VALUES (?, ?, ?, 'delay', ?, ?, datetime('now'))`,
  ).run(projectId, actor, body, actor, pane);
}

function drainLeaseWaiters(projectId: number, key: string): void {
  db.prepare(
    `DELETE FROM lease_waiters WHERE project_id = ? AND lock_key = ?
       AND NOT EXISTS (SELECT 1 FROM agents a WHERE a.id = lease_waiters.agent_id
         AND a.project_id = lease_waiters.project_id AND a.actor_id = lease_waiters.actor_id
         AND a.status = 'running' AND a.parked_at = '')`,
  ).run(projectId, key);

  const timedOut = db.prepare(
    `DELETE FROM lease_waiters WHERE id IN (
       SELECT id FROM lease_waiters WHERE project_id = ? AND lock_key = ?
         AND max_wait_at <= datetime('now') ORDER BY id
     ) RETURNING id, project_id, lock_key, actor_id, agent_id, ttl_seconds, max_wait_at`,
  ).all(projectId, key) as WaiterRow[];
  for (const waiter of timedOut) {
    const row = liveDelivery(waiter.agent_id, projectId, waiter.actor_id);
    if (row) fileWaitWake(projectId, waiter.actor_id, row.tmux_target, `Gave up waiting for lease ${JSON.stringify(key)}.`);
  }

  db.prepare("DELETE FROM leases WHERE project_id = ? AND lock_key = ? AND expires_at < datetime('now')").run(projectId, key);
  if (readLease(projectId, key)) return;

  for (;;) {
    const waiter = db.prepare(
      "SELECT id, project_id, lock_key, actor_id, agent_id, ttl_seconds, max_wait_at FROM lease_waiters WHERE project_id = ? AND lock_key = ? ORDER BY id LIMIT 1",
    ).get(projectId, key) as WaiterRow | undefined;
    if (!waiter) return;
    const row = liveDelivery(waiter.agent_id, projectId, waiter.actor_id);
    if (!row) {
      db.prepare("DELETE FROM lease_waiters WHERE id = ?").run(waiter.id);
      continue;
    }
    const grant = db.prepare(
      `INSERT INTO leases (project_id, lock_key, owner, expires_at)
       VALUES (?, ?, ?, datetime('now', printf('+%d seconds', ?)))
       ON CONFLICT(project_id, lock_key) DO NOTHING RETURNING expires_at`,
    ).get(projectId, key, waiter.actor_id, waiter.ttl_seconds) as { expires_at: string } | undefined;
    if (!grant) return;
    db.prepare("DELETE FROM lease_waiters WHERE id = ?").run(waiter.id);
    fileWaitWake(projectId, waiter.actor_id, row.tmux_target,
      `Lease ${JSON.stringify(key)} was granted to you until ${grant.expires_at}.\nCheck this deadline before using it.\nCall lease_acquire again before then to extend it.`);
    return;
  }
}

export function acquireLease(
  projectId: number,
  key: string,
  actor: string,
  ttlSeconds: number,
  wait?: LeaseWaitInput,
): LeaseAcquireResult {
  const acquire = db.transaction((): LeaseAcquireResult => {
    if (!wait) {
      const queued = db.prepare("SELECT 1 FROM lease_waiters WHERE project_id = ? AND lock_key = ? LIMIT 1")
        .get(projectId, key);
      const expired = db.prepare("SELECT 1 FROM leases WHERE project_id = ? AND lock_key = ? AND expires_at < datetime('now')")
        .get(projectId, key);
      if (queued && expired) drainLeaseWaiters(projectId, key);
      else purgeExpiredLeases(projectId, key);
      const inserted = insertLease(projectId, key, actor, ttlSeconds);
      if (inserted) return { project_id: projectId, key, acquired: true, expires_at: inserted.expires_at };
      const current = readLease(projectId, key)!;
      if (current.owner === actor && extendOwnedLease(projectId, key, actor, ttlSeconds)) {
        return { project_id: projectId, key, acquired: true, extended: true, expires_at: readLease(projectId, key)!.expires_at };
      }
      return { project_id: projectId, key, acquired: false, held_by: current.owner, expires_at: current.expires_at };
    }

    const delivery = liveDeliveryByActor(projectId, wait.delivery.actor, wait.delivery.pane);
    if (!delivery) throw new Error("You must be a session an answer can be woken back to");
    drainLeaseWaiters(projectId, key);
    const current = readLease(projectId, key);
    if (!current || current.owner === actor) {
      if (current && extendOwnedLease(projectId, key, actor, ttlSeconds)) {
        return { project_id: projectId, key, acquired: true, extended: true, expires_at: readLease(projectId, key)!.expires_at };
      }
      const inserted = insertLease(projectId, key, actor, ttlSeconds);
      if (inserted) return { project_id: projectId, key, acquired: true, expires_at: inserted.expires_at };
    }
    const own = db.prepare(
      "SELECT id FROM lease_waiters WHERE project_id = ? AND lock_key = ? AND actor_id = ?",
    ).get(projectId, key, actor) as { id: number } | undefined;
    if (!own) {
      db.prepare(
        `INSERT INTO lease_waiters (project_id, lock_key, actor_id, agent_id, ttl_seconds, max_wait_at)
         VALUES (?, ?, ?, ?, ?, datetime('now', printf('+%d seconds', ?)))`,
      ).run(projectId, key, actor, delivery.id, ttlSeconds, wait.max_wait_seconds);
    }
    const waiter = db.prepare(
      "SELECT id FROM lease_waiters WHERE project_id = ? AND lock_key = ? AND actor_id = ?",
    ).get(projectId, key, actor) as { id: number };
    const position = db.prepare(
      "SELECT COUNT(*) AS n FROM lease_waiters WHERE project_id = ? AND lock_key = ? AND id <= ? AND max_wait_at > datetime('now')",
    ).get(projectId, key, waiter.id) as { n: number };
    const holder = readLease(projectId, key);
    return { project_id: projectId, key, acquired: false, queued: true, position: position.n, held_by: holder?.owner, expires_at: holder?.expires_at };
  });
  return acquire.immediate();
}

function liveDeliveryByActor(projectId: number, actor: string, pane: string): (DeliveryRow & { id: number }) | undefined {
  return db.prepare(
    `SELECT id, project_id, actor_id, tmux_target, status, parked_at FROM agents
     WHERE project_id = ? AND actor_id = ? AND tmux_target = ? AND status = 'running' AND parked_at = ''`,
  ).get(projectId, actor, pane) as (DeliveryRow & { id: number }) | undefined;
}

export function releaseLease(projectId: number, key: string, actor: string): { released: boolean; left_queue?: true } {
  const release = db.transaction(() => {
    if (releaseOwnedLease(projectId, key, actor)) {
      drainLeaseWaiters(projectId, key);
      return { released: true };
    }
    const removed = db.prepare("DELETE FROM lease_waiters WHERE project_id = ? AND lock_key = ? AND actor_id = ?")
      .run(projectId, key, actor).changes > 0;
    return removed ? { released: false, left_queue: true as const } : { released: false };
  });
  return release.immediate();
}

export function maintainLeaseWaiters(projectId?: number): void {
  const maintenance = db.transaction(() => {
    const keys = db.prepare(
      `SELECT DISTINCT project_id, lock_key FROM lease_waiters
       WHERE (? IS NULL OR project_id = ?) ORDER BY project_id, lock_key`,
    ).all(projectId ?? null, projectId ?? null) as Array<{ project_id: number; lock_key: string }>;
    for (const row of keys) drainLeaseWaiters(row.project_id, row.lock_key);
  });
  maintenance.immediate();
}

export function cancelWorkerLeaseWaits(agentId: number): void {
  db.prepare("DELETE FROM lease_waiters WHERE agent_id = ?").run(agentId);
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

export function releaseWorkerLeases(agentId: number): string[] {
  const agent = db
    .prepare("SELECT project_id, actor_id FROM agents WHERE id = ? AND kind = 'agent' AND actor_id != ''")
    .get(agentId) as { project_id: number; actor_id: string } | undefined;
  if (!agent) return [];

  cancelWorkerLeaseWaits(agentId);

  const rows = db
    .prepare(
      "DELETE FROM leases WHERE project_id = ? AND owner = ? AND lock_key NOT LIKE 'wake-pane:%' RETURNING lock_key",
    )
    .all(agent.project_id, agent.actor_id) as Array<{ lock_key: string }>;
  const keys = rows.map((row) => row.lock_key).sort();
  for (const key of keys) drainLeaseWaiters(agent.project_id, key);
  return keys;
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
