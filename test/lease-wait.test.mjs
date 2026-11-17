import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { assertScratchStore, clearHiveEnv, scratchDirs } from "./helpers.mjs";

const { dataDir } = scratchDirs();
clearHiveEnv();
process.env.HIVE_DATA_DIR = dataDir;
const { db, migrate } = await import("../dist/db.js");
await assertScratchStore();
const {
  acquireLease,
  maintainLeaseWaiters,
  readLease,
  releaseLease,
} = await import("../dist/leaseStore.js");
migrate();

const project = (name) => db.prepare("INSERT INTO projects (name, path) VALUES (?, ?) RETURNING id")
  .get(name, `/tmp/${name}`).id;
const waiter = (projectId, actorId, pane, name = actorId) => {
  db.prepare("INSERT INTO actors (id, name, kind, tmux_pane) VALUES (?, ?, 'agent', ?)").run(actorId, name, pane);
  return db.prepare(
    `INSERT INTO agents (project_id, actor_id, name, tmux_target, command, cwd, kind, status)
     VALUES (?, ?, ?, ?, 'claude', '/tmp', 'agent', 'running') RETURNING id`,
  ).get(projectId, actorId, name, pane).id;
};
const queue = (projectId, key, actorId, agentId, ttl, maxWait = 3600) => {
  const pane = db.prepare("SELECT tmux_target FROM agents WHERE id = ?").get(agentId).tmux_target;
  return acquireLease(projectId, key, actorId, ttl, { max_wait_seconds: maxWait, delivery: { actor: actorId, pane } });
};
const wakes = (projectId, actorId) => db.prepare(
  "SELECT * FROM wakes WHERE project_id = ? AND deliver_actor = ? ORDER BY id",
).all(projectId, actorId);

describe("lease waiter transactions", () => {
  it("owner release grants B with B's TTL and one wake while C remains first", () => {
    const p = project("lease-wait-release");
    const b = waiter(p, "agent:wait-b", "%b");
    const c = waiter(p, "agent:wait-c", "%c");
    db.prepare("INSERT INTO actors (id, name) VALUES ('agent:wait-a', 'A')").run();
    assert.ok(acquireLease(p, "db:dev", "agent:wait-a", 120).acquired);
    assert.equal(queue(p, "db:dev", "agent:wait-b", b, 31).position, 1);
    assert.equal(queue(p, "db:dev", "agent:wait-c", c, 79).position, 2);

    assert.deepEqual(releaseLease(p, "db:dev", "agent:wait-a"), { released: true });
    const lease = readLease(p, "db:dev");
    assert.equal(lease.owner, "agent:wait-b");
    assert.equal(lease.expires_at, db.prepare("SELECT datetime(acquired_at, '+31 seconds') AS expiry FROM leases WHERE project_id = ? AND lock_key = ?").get(p, "db:dev").expiry);
    assert.equal(wakes(p, "agent:wait-b").length, 1);
    assert.match(wakes(p, "agent:wait-b")[0].body, /was granted to you until/);
    assert.match(wakes(p, "agent:wait-b")[0].body, /Call lease_acquire again before then to extend it\./);
    assert.equal(db.prepare("SELECT actor_id FROM lease_waiters WHERE project_id = ? AND lock_key = ? ORDER BY id").all(p, "db:dev")[0].actor_id, "agent:wait-c");
  });

  it("maintenance preserves unexpired holders and skips expired and closed waiters", () => {
    const p = project("lease-wait-maintenance");
    const closed = waiter(p, "agent:wait-closed", "%closed");
    const live = waiter(p, "agent:wait-live", "%live");
    db.prepare("INSERT INTO actors (id, name) VALUES ('agent:wait-held', 'held')").run();
    acquireLease(p, "held", "agent:wait-held", 90);
    queue(p, "held", "agent:wait-live", live, 44);
    db.prepare("UPDATE agents SET status = 'closed', closed_at = datetime('now') WHERE id = ?").run(closed);
    db.prepare("INSERT INTO lease_waiters (project_id, lock_key, actor_id, agent_id, ttl_seconds, max_wait_at) VALUES (?, 'held', 'agent:wait-closed', ?, 50, datetime('now', '+20 seconds'))").run(p, closed);
    maintainLeaseWaiters();
    assert.equal(readLease(p, "held").owner, "agent:wait-held");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM lease_waiters WHERE project_id = ? AND lock_key = 'held'").get(p).n, 1);
    assert.equal(wakes(p, "agent:wait-closed").length, 0);
  });

  it("max wait expires once with one give-up wake and no grant", () => {
    const p = project("lease-wait-timeout");
    const agentId = waiter(p, "agent:wait-timeout", "%timeout");
    db.prepare("INSERT INTO actors (id, name) VALUES ('agent:wait-expiring-holder', 'holder')").run();
    acquireLease(p, "timeout", "agent:wait-expiring-holder", 120);
    queue(p, "timeout", "agent:wait-timeout", agentId, 20);
    db.prepare("UPDATE lease_waiters SET max_wait_at = datetime('now', '-1 second') WHERE project_id = ? AND lock_key = 'timeout'").run(p);
    maintainLeaseWaiters();
    maintainLeaseWaiters();
    assert.equal(readLease(p, "timeout").owner, "agent:wait-expiring-holder");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM lease_waiters WHERE project_id = ? AND lock_key = 'timeout'").get(p).n, 0);
    assert.equal(wakes(p, "agent:wait-timeout").length, 1);
    assert.match(wakes(p, "agent:wait-timeout")[0].body, /Gave up waiting for lease/);
  });

  it("deadline expiry wins over a simultaneous release", () => {
    const p = project("lease-wait-deadline-release");
    const b = waiter(p, "agent:deadline-b", "%deadline-b");
    const c = waiter(p, "agent:deadline-c", "%deadline-c");
    db.prepare("INSERT INTO actors (id, name) VALUES ('agent:deadline-holder', 'holder')").run();
    acquireLease(p, "deadline", "agent:deadline-holder", 120);
    queue(p, "deadline", "agent:deadline-b", b, 30);
    queue(p, "deadline", "agent:deadline-c", c, 60);
    db.prepare("UPDATE lease_waiters SET max_wait_at = datetime('now', '-1 second') WHERE project_id = ? AND actor_id = 'agent:deadline-b'").run(p);

    releaseLease(p, "deadline", "agent:deadline-holder");
    assert.equal(readLease(p, "deadline").owner, "agent:deadline-c");
    assert.equal(wakes(p, "agent:deadline-b").length, 1);
    assert.match(wakes(p, "agent:deadline-b")[0].body, /Gave up waiting/);
    assert.equal(wakes(p, "agent:deadline-c").length, 1);
  });

  it("cancelled and retired waiters never receive timeout wakes", () => {
    const p = project("lease-wait-cancel-timeout");
    const b = waiter(p, "agent:cancel-timeout-b", "%cancel-timeout-b");
    const c = waiter(p, "agent:cancel-timeout-c", "%cancel-timeout-c");
    db.prepare("INSERT INTO actors (id, name) VALUES ('agent:cancel-timeout-holder', 'holder')").run();
    acquireLease(p, "cancel", "agent:cancel-timeout-holder", 120);
    queue(p, "cancel", "agent:cancel-timeout-b", b, 30);
    queue(p, "cancel", "agent:cancel-timeout-c", c, 30);
    releaseLease(p, "cancel", "agent:cancel-timeout-b");
    db.prepare("UPDATE agents SET parked_at = datetime('now') WHERE id = ?").run(c);
    db.prepare("UPDATE lease_waiters SET max_wait_at = datetime('now', '-1 second') WHERE project_id = ?").run(p);
    maintainLeaseWaiters();
    assert.equal(wakes(p, "agent:cancel-timeout-b").length, 0);
    assert.equal(wakes(p, "agent:cancel-timeout-c").length, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM lease_waiters WHERE project_id = ?").get(p).n, 0);
  });

  it("wait queues remain independent across projects actors and empty keys", () => {
    const p1 = project("lease-wait-scope-one");
    const p2 = project("lease-wait-scope-two");
    const a = waiter(p1, "agent:scope-a", "%a");
    const b = waiter(p2, "agent:scope-b", "%b");
    db.prepare("INSERT INTO actors (id, name) VALUES ('agent:scope-holder', 'holder')").run();
    acquireLease(p1, "", "agent:scope-holder", 120);
    acquireLease(p2, "", "agent:scope-holder", 120);
    queue(p1, "", "agent:scope-a", a, 30);
    queue(p2, "", "agent:scope-b", b, 30);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM lease_waiters WHERE lock_key = ''").get().n, 2);
    releaseLease(p1, "", "agent:scope-holder");
    assert.equal(readLease(p1, "").owner, "agent:scope-a");
    assert.equal(readLease(p2, "").owner, "agent:scope-holder");
    assert.equal(wakes(p1, "agent:scope-a").length, 1);
    assert.equal(wakes(p2, "agent:scope-b").length, 0);
  });

  it("failed wake insertion rolls back release grant and timeout", () => {
    const p = project("lease-wait-rollback");
    const b = waiter(p, "agent:rollback-b", "%rollback");
    db.prepare("INSERT INTO actors (id, name) VALUES ('agent:rollback-a', 'A')").run();
    acquireLease(p, "rollback", "agent:rollback-a", 120);
    queue(p, "rollback", "agent:rollback-b", b, 30);
    db.exec("CREATE TRIGGER fail_lease_wait_wake BEFORE INSERT ON wakes BEGIN SELECT RAISE(ABORT, 'test wake failure'); END");
    assert.throws(() => releaseLease(p, "rollback", "agent:rollback-a"), /test wake failure/);
    assert.equal(readLease(p, "rollback").owner, "agent:rollback-a");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM lease_waiters WHERE project_id = ? AND lock_key = 'rollback'").get(p).n, 1);
    assert.equal(wakes(p, "agent:rollback-b").length, 0);

    db.prepare("UPDATE lease_waiters SET max_wait_at = datetime('now', '-1 second') WHERE project_id = ? AND lock_key = 'rollback'").run(p);
    assert.throws(() => maintainLeaseWaiters(p), /test wake failure/);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM lease_waiters WHERE project_id = ? AND lock_key = 'rollback'").get(p).n, 1);
    assert.equal(wakes(p, "agent:rollback-b").length, 0);
    db.exec("DROP TRIGGER fail_lease_wait_wake");
  });
});
