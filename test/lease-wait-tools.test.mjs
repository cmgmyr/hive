import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { after, before, describe, it } from "node:test";

import { assertScratchStore, isolateTmux, makeFakeClaude, McpClient, scratchDirs } from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("lease wait tools");
const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { db } = await import("../dist/db.js");
const { sessionName } = await import("../dist/tmux.js");

describe("lease wait tools", { skip: hasTmux ? false : "tmux is not installed" }, () => {
  let clients = [];
  let projectId;
  const actors = ["agent:lease-wait-a", "agent:lease-wait-b", "agent:lease-wait-c"];

  const caller = (actor, index) => {
    const fake = makeFakeClaude(dirs.tmp);
    const pane = execFileSync("tmux", [
      "new-window", "-P", "-F", "#{pane_id}", "-t", `=${sessionName()}`, "-c", dirs.projectDir,
      fake("sleep 600"),
    ]).toString().trim();
    const panePid = execFileSync("tmux", ["display-message", "-p", "-t", pane, "#{pane_pid}"]).toString().trim();
    db.prepare("INSERT OR IGNORE INTO actors (id, name, kind) VALUES (?, ?, 'agent')").run(actor, actor);
    db.prepare(
      `INSERT INTO agents (project_id, actor_id, name, tmux_target, pane_pid, command, cwd, kind, status)
       VALUES (?, ?, ?, ?, ?, 'claude', ?, 'agent', 'running')`,
    ).run(projectId, actor, `lease-wait-${index}`, pane, panePid, dirs.projectDir);
    const mcp = new McpClient({ cwd: dirs.projectDir, dataDir: dirs.dataDir, env: { HIVE_AGENT_ID: actor } });
    clients.push(mcp);
    return mcp;
  };

  before(async () => {
    execFileSync("tmux", ["new-session", "-d", "-s", sessionName(), "-x", "220", "-y", "50", "-c", dirs.projectDir]);
    const bootstrap = new McpClient({ cwd: dirs.projectDir, dataDir: dirs.dataDir });
    clients.push(bootstrap);
    await bootstrap.start();
    projectId = (await bootstrap.call("whoami")).project.id;
    await assertScratchStore();
    for (let i = 0; i < actors.length; i++) await caller(actors[i], i).start();
  });

  after(async () => {
    await Promise.all(clients.map((mcp) => mcp.close()));
    cleanup(sessionName());
  });

  it("held wait calls queue B before C with requested TTLs and deadlines", async () => {
    assert.equal((await clients[1].call("lease_acquire", { key: "db:dev", ttl_seconds: 90 })).acquired, true);
    const b = await clients[2].call("lease_acquire", { key: "db:dev", ttl_seconds: 31, wait: true, max_wait_seconds: 600 });
    const c = await clients[3].call("lease_acquire", { key: "db:dev", ttl_seconds: 79, wait: true });
    assert.deepEqual({ acquired: b.acquired, queued: b.queued, position: b.position }, { acquired: false, queued: true, position: 1 });
    assert.deepEqual({ acquired: c.acquired, queued: c.queued, position: c.position }, { acquired: false, queued: true, position: 2 });
    const rows = db.prepare("SELECT actor_id, ttl_seconds, max_wait_at FROM lease_waiters WHERE project_id = ? AND lock_key = ? ORDER BY id").all(projectId, "db:dev");
    assert.deepEqual(rows.map((r) => [r.actor_id, r.ttl_seconds]), [[actors[1], 31], [actors[2], 79]]);
    assert.ok(Date.parse(`${rows[0].max_wait_at.replace(" ", "T")}Z`) > Date.now());
    assert.ok(rows[0].max_wait_at < db.prepare("SELECT datetime('now', '+3601 seconds') AS at").get().at);
  });

  it("repeat wait calls preserve the original queue entry and report its current position", async () => {
    const before = db.prepare("SELECT id, ttl_seconds, max_wait_at FROM lease_waiters WHERE project_id = ? AND lock_key = ? AND actor_id = ?").get(projectId, "db:dev", actors[1]);
    const result = await clients[2].call("lease_acquire", { key: "db:dev", ttl_seconds: 999, wait: true, max_wait_seconds: 3 });
    const after = db.prepare("SELECT id, ttl_seconds, max_wait_at FROM lease_waiters WHERE project_id = ? AND lock_key = ? AND actor_id = ?").get(projectId, "db:dev", actors[1]);
    assert.equal(result.position, 1);
    assert.deepEqual(after, before);
  });

  it("an owner calling wait true extends without queuing", async () => {
    const before = db.prepare("SELECT expires_at FROM leases WHERE project_id = ? AND lock_key = ?").get(projectId, "db:dev").expires_at;
    const result = await clients[1].call("lease_acquire", { key: "db:dev", ttl_seconds: 180, wait: true });
    assert.equal(result.acquired, true);
    assert.equal(result.extended, true);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM lease_waiters WHERE project_id = ? AND lock_key = ? AND actor_id = ?").get(projectId, "db:dev", actors[0]).n, 0);
    assert.notEqual(db.prepare("SELECT expires_at FROM leases WHERE project_id = ? AND lock_key = ?").get(projectId, "db:dev").expires_at, before);
  });

  it("lease release cancels only the caller's queued key", async () => {
    const result = await clients[2].call("lease_release", { key: "db:dev" });
    assert.deepEqual(result, { project_id: projectId, key: "db:dev", released: false, left_queue: true });
    assert.equal(db.prepare("SELECT actor_id FROM lease_waiters WHERE project_id = ? AND lock_key = ? ORDER BY id").all(projectId, "db:dev")[0].actor_id, actors[2]);
    assert.equal((await clients[3].call("lease_acquire", { key: "db:dev", ttl_seconds: 79, wait: true })).position, 1);
    assert.deepEqual(await clients[2].call("lease_release", { key: "db:dev" }), { project_id: projectId, key: "db:dev", released: false });
  });

  it("omitting wait and wait false preserve every legacy lease receipt", async () => {
    const inserted = await clients[2].call("lease_acquire", { key: "legacy:insert", ttl_seconds: 45 });
    assert.deepEqual(Object.keys(inserted), ["project_id", "key", "acquired", "expires_at"]);
    assert.equal(inserted.expires_at, db.prepare("SELECT expires_at FROM leases WHERE project_id = ? AND lock_key = 'legacy:insert'").get(projectId).expires_at);

    const extended = await clients[2].call("lease_acquire", { key: "legacy:insert", ttl_seconds: 60, wait: false });
    assert.deepEqual(extended, { project_id: projectId, key: "legacy:insert", acquired: true, extended: true });
    assert.deepEqual(Object.keys(extended), ["project_id", "key", "acquired", "extended"]);

    const denied = await clients[3].call("lease_acquire", { key: "legacy:insert", ttl_seconds: 60 });
    assert.deepEqual(Object.keys(denied), ["project_id", "key", "acquired", "held_by", "expires_at"]);
    assert.equal(denied.acquired, false);
    assert.equal(denied.held_by, actors[1]);

    assert.deepEqual(await clients[3].call("lease_release", { key: "legacy:missing" }), { project_id: projectId, key: "legacy:missing", released: false });
    assert.deepEqual(await clients[2].call("lease_release", { key: "legacy:insert" }), { project_id: projectId, key: "legacy:insert", released: true });
  });

  it("invalid wait arguments and internal pane keys fail without writes", async () => {
    const before = {
      leases: db.prepare("SELECT COUNT(*) AS n FROM leases WHERE project_id = ?").get(projectId).n,
      waiters: db.prepare("SELECT COUNT(*) AS n FROM lease_waiters WHERE project_id = ?").get(projectId).n,
      wakes: db.prepare("SELECT COUNT(*) AS n FROM wakes WHERE project_id = ?").get(projectId).n,
    };
    await assert.rejects(clients[2].call("lease_acquire", { key: "invalid", ttl_seconds: 10, max_wait_seconds: 30 }), /requires wait:true/);
    await assert.rejects(clients[2].call("lease_acquire", { key: "wake-pane:test", ttl_seconds: 10, wait: true }), /internal wake-pane/);
    await assert.rejects(clients[2].call("lease_acquire", { key: "invalid", ttl_seconds: 10, wait: true, max_wait_seconds: 0 }), /max_wait_seconds|positive/);
    assert.deepEqual({
      leases: db.prepare("SELECT COUNT(*) AS n FROM leases WHERE project_id = ?").get(projectId).n,
      waiters: db.prepare("SELECT COUNT(*) AS n FROM lease_waiters WHERE project_id = ?").get(projectId).n,
      wakes: db.prepare("SELECT COUNT(*) AS n FROM wakes WHERE project_id = ?").get(projectId).n,
    }, before);
  });

  it("wait true refuses rowless closed unclassifiable and unknown targets without writes", async () => {
    const cases = [
      { actor: "agent:wait-rowless", pane: "%wait-rowless", row: false, command: "claude" },
      { actor: "agent:wait-closed", pane: "%wait-closed", row: true, status: "closed", command: "claude" },
      { actor: "agent:wait-shell", pane: "%wait-shell", row: true, status: "running", command: "sleep 600" },
      { actor: "agent:wait-unknown", pane: "%99999", row: true, status: "running", command: "claude" },
    ];
    for (const item of cases) {
      db.prepare("INSERT OR IGNORE INTO actors (id, name, kind) VALUES (?, ?, 'agent')").run(item.actor, item.actor);
      if (item.row) db.prepare(
        `INSERT INTO agents (project_id, actor_id, name, tmux_target, command, cwd, kind, status)
         VALUES (?, ?, ?, ?, ?, ?, 'agent', ?)`,
      ).run(projectId, item.actor, item.actor, item.pane, item.command, dirs.projectDir, item.status);
      const client = new McpClient({ cwd: dirs.projectDir, dataDir: dirs.dataDir, env: { HIVE_AGENT_ID: item.actor, TMUX_PANE: item.pane } });
      clients.push(client);
      await client.start();
      const before = db.prepare("SELECT COUNT(*) AS n FROM lease_waiters WHERE project_id = ?").get(projectId).n;
      await assert.rejects(client.call("lease_acquire", { key: `safe:${item.actor}`, ttl_seconds: 10, wait: true }), undefined, item.actor);
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM lease_waiters WHERE project_id = ?").get(projectId).n, before);
    }
  });
});
