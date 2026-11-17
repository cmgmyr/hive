import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { assertScratchStore, isolateTmux, liveAgentRow, makeFakeClaude, McpClient, raceProcesses, REPO, scratchDirs, until } from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("lease wait scheduler");
const NEEDS_TMUX = { skip: hasTmux ? false : "tmux is not installed" };
const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { db } = await import("../dist/db.js");
const { sessionName } = await import("../dist/tmux.js");
const { tick } = await import("../dist/scheduler.js");
const SINK = join(dirs.tmp, "lease-wait-scheduler-sink.log");
const OWNER = "user:lease-wait-scheduler";
const serverEnv = { HIVE_AGENT_ID: OWNER, HIVE_SPAWN_READY_MS: "2000", HIVE_SCHEDULER_INTERVAL_MS: "60000" };
const fakeClaude = makeFakeClaude(dirs.tmp);

let lead;
let projectId;
const workers = new Map();

before(async () => {
  lead = new McpClient({ cwd: dirs.projectDir, dataDir: dirs.dataDir, env: serverEnv });
  await lead.start();
  projectId = (await lead.call("whoami")).project.id;
  await assertScratchStore();
  if (hasTmux) execFileSync("tmux", ["new-session", "-d", "-s", sessionName(), "-x", "220", "-y", "50", "-c", dirs.projectDir]);
});

after(async () => {
  for (const item of workers.values()) await item.client.close();
  await lead.close();
  cleanup(sessionName());
});

async function ensureWorker(suffix) {
  if (workers.has(suffix)) return workers.get(suffix);
  const sink = join(dirs.tmp, `lease-wait-${suffix}.log`);
  writeFileSync(sink, "");
  const spawned = await lead.call("agent_spawn", {
    name: `lease-wait-${suffix}`,
    command: fakeClaude(`cat >> '${sink}'`),
    extra_args: [],
    placement: "window",
  });
  const row = await liveAgentRow(lead, `lease-wait-${suffix}`);
  const client = new McpClient({ cwd: dirs.projectDir, dataDir: dirs.dataDir, env: { HIVE_AGENT_ID: row.actor_id, HIVE_SCHEDULER_INTERVAL_MS: "60000" } });
  await client.start();
  const result = { agentId: spawned.agent_id, actor: row.actor_id, pane: row.tmux_target, client, sink };
  workers.set(suffix, result);
  return result;
}

function lease(project, key) {
  return db.prepare("SELECT * FROM leases WHERE project_id = ? AND lock_key = ?").get(project, key);
}

function waiterCount(project, key) {
  return db.prepare("SELECT COUNT(*) AS n FROM lease_waiters WHERE project_id = ? AND lock_key = ?").get(project, key).n;
}

function wakeRows(project, actor) {
  return db.prepare("SELECT * FROM wakes WHERE project_id = ? AND deliver_actor = ? ORDER BY id").all(project, actor);
}

async function runTickProcesses(count = 2) {
  const schedulerPath = join(REPO, "dist", "scheduler.js");
  const source = `import { tick } from ${JSON.stringify(schedulerPath)}; await tick(); process.stdout.write(JSON.stringify({ ok: true }));`;
  return raceProcesses(source, Array.from({ length: count }, () => []), {
    env: { HIVE_DATA_DIR: dirs.dataDir, HIVE_SCHEDULER_INTERVAL_MS: "60000" },
  });
}

describe("lease wait scheduler", { skip: hasTmux ? false : "tmux is not installed" }, () => {
  it("expiry alone grants C with one wake after B's grant expires", NEEDS_TMUX, async () => {
    const b = await ensureWorker("expiry-b");
    const c = await ensureWorker("expiry-c");
    writeFileSync(b.sink, "");
    writeFileSync(c.sink, "");
    await lead.call("lease_acquire", { key: "expire:db", ttl_seconds: 120 });
    await b.client.call("lease_acquire", { key: "expire:db", ttl_seconds: 30, wait: true });
    await c.client.call("lease_acquire", { key: "expire:db", ttl_seconds: 60, wait: true });
    assert.equal((await lead.call("lease_release", { key: "expire:db" })).released, true);
    await tick();
    assert.equal(lease(projectId, "expire:db").owner, b.actor);
    assert.equal(wakeRows(projectId, b.actor).length, 1);
    await until(() => readFileSync(b.sink, "utf8").includes("Call lease_acquire again before then to extend it."), 5000);
    assert.equal((await c.client.call("lease_acquire", { key: "expire:db", ttl_seconds: 60, wait: true })).position, 1);
    db.prepare("UPDATE leases SET expires_at = datetime('now', '-1 second') WHERE project_id = ? AND lock_key = 'expire:db'").run(projectId);
    await runTickProcesses();
    assert.equal(lease(projectId, "expire:db").owner, c.actor);
    assert.equal(wakeRows(projectId, c.actor).length, 1);
    await until(() => readFileSync(c.sink, "utf8").includes("Call lease_acquire again before then to extend it."), 5000);
    assert.equal(waiterCount(projectId, "expire:db"), 0);
    assert.equal(readFileSync(b.sink, "utf8").split("Call lease_acquire again before then to extend it.").length - 1, 1);
    assert.equal(readFileSync(c.sink, "utf8").split("Call lease_acquire again before then to extend it.").length - 1, 1);
  });

  it("two scheduler processes grant an expired lease once", NEEDS_TMUX, async () => {
    const b = await ensureWorker("race-b");
    const sink = b.sink;
    writeFileSync(sink, "");
    await lead.call("lease_acquire", { key: "race:expired", ttl_seconds: 120 });
    await b.client.call("lease_acquire", { key: "race:expired", ttl_seconds: 60, wait: true });
    db.prepare("UPDATE leases SET expires_at = datetime('now', '-1 second') WHERE project_id = ? AND lock_key = 'race:expired'").run(projectId);
    await runTickProcesses();
    await until(() => readFileSync(sink, "utf8").includes('Lease "race:expired" was granted'), 5000);
    await new Promise((resolve) => setTimeout(resolve, 350));
    assert.equal(lease(projectId, "race:expired").owner, b.actor);
    assert.equal(waiterCount(projectId, "race:expired"), 0);
    assert.equal(wakeRows(projectId, b.actor).filter((wake) => wake.body.includes("race:expired")).length, 1);
    const wake = wakeRows(projectId, b.actor).find((row) => row.body.includes("race:expired"));
    assert.equal(wake.fire_count, 1);
    assert.equal(readFileSync(sink, "utf8").split("race:expired").length - 1, 1);
  });

  it("two scheduler processes time out one waiter once", NEEDS_TMUX, async () => {
    const b = await ensureWorker("timeout-race-b");
    writeFileSync(b.sink, "");
    await lead.call("lease_acquire", { key: "race:timeout", ttl_seconds: 120 });
    await b.client.call("lease_acquire", { key: "race:timeout", ttl_seconds: 60, wait: true, max_wait_seconds: 30 });
    db.prepare("UPDATE lease_waiters SET max_wait_at = datetime('now', '-1 second') WHERE project_id = ? AND lock_key = 'race:timeout'").run(projectId);
    await runTickProcesses();
    const timeouts = wakeRows(projectId, b.actor).filter((wake) => wake.body.includes("Gave up waiting for lease") && wake.body.includes("race:timeout"));
    assert.equal(timeouts.length, 1);
    assert.equal(timeouts[0].fire_count, 1);
    assert.equal(waiterCount(projectId, "race:timeout"), 0);
    assert.equal(lease(projectId, "race:timeout").owner, OWNER);
    assert.equal(readFileSync(b.sink, "utf8").split("Gave up waiting for lease").length - 1, 1);
  });

  it("two processes racing release and expiry grant only one waiter and insert one wake", NEEDS_TMUX, async () => {
    const b = await ensureWorker("release-race-b");
    await lead.call("lease_acquire", { key: "race:release", ttl_seconds: 120 });
    await b.client.call("lease_acquire", { key: "race:release", ttl_seconds: 70, wait: true });
    db.prepare("UPDATE leases SET expires_at = datetime('now', '-1 second') WHERE project_id = ? AND lock_key = 'race:release'").run(projectId);
    const leaseStore = join(REPO, "dist", "leaseStore.js");
    const schedulerPath = join(REPO, "dist", "scheduler.js");
    const source = `import { tick } from ${JSON.stringify(schedulerPath)}; import { releaseLease } from ${JSON.stringify(leaseStore)}; if (process.argv[2] === 'tick') await tick(); else releaseLease(${projectId}, 'race:release', ${JSON.stringify(OWNER)}); process.stdout.write(JSON.stringify({ ok: true }));`;
    await raceProcesses(source, [["tick"], ["release"]], { env: { HIVE_DATA_DIR: dirs.dataDir, HIVE_SCHEDULER_INTERVAL_MS: "60000" } });
    assert.equal(lease(projectId, "race:release").owner, b.actor);
    assert.equal(waiterCount(projectId, "race:release"), 0);
    assert.equal(wakeRows(projectId, b.actor).filter((wake) => wake.body.includes("race:release")).length, 1);
  });

  it("worker retirement racing a tick grants the next waiter once", NEEDS_TMUX, async () => {
    const retiring = await ensureWorker("retire-race-a");
    const c = await ensureWorker("retire-race-c");
    await retiring.client.call("lease_acquire", { key: "retire:key", ttl_seconds: 120 });
    await lead.call("lease_acquire", { key: "retire:other", ttl_seconds: 120 });
    await retiring.client.call("lease_acquire", { key: "retire:other", ttl_seconds: 90, wait: true });
    await c.client.call("lease_acquire", { key: "retire:key", ttl_seconds: 60, wait: true });
    const schedulerPath = join(REPO, "dist", "scheduler.js");
    const spawnPath = join(REPO, "dist", "spawn.js");
    const source = `import { tick } from ${JSON.stringify(schedulerPath)}; import { closeAgentRowWithLeases } from ${JSON.stringify(spawnPath)}; if (process.argv[2] === 'tick') await tick(); else closeAgentRowWithLeases(${retiring.agentId}); process.stdout.write(JSON.stringify({ ok: true }));`;
    await raceProcesses(source, [["tick"], ["retire"]], { env: { HIVE_DATA_DIR: dirs.dataDir, HIVE_SCHEDULER_INTERVAL_MS: "60000" } });
    assert.equal(db.prepare("SELECT status FROM agents WHERE id = ?").get(retiring.agentId).status, "closed");
    assert.equal(lease(projectId, "retire:key").owner, c.actor);
    assert.equal(waiterCount(projectId, "retire:key"), 0);
    assert.equal(wakeRows(projectId, c.actor).filter((wake) => wake.body.includes("retire:key")).length, 1);
    assert.equal(waiterCount(projectId, "retire:other"), 0);
  });

  it("a failing lease maintenance pass does not starve ordinary wakes", NEEDS_TMUX, async () => {
    const b = await ensureWorker("isolation-b");
    const wake = await lead.call("wake_set", { delay_seconds: 1, body: "LEASE-WAIT-ISOLATION", deliver_to: b.agentId });
    db.prepare("UPDATE wakes SET due_at = datetime('now', '-1 second') WHERE id = ?").run(wake.wake_id);
    const other = await lead.call("lease_acquire", { key: "isolation:key", ttl_seconds: 120 });
    assert.equal(other.acquired, true);
    await b.client.call("lease_acquire", { key: "isolation:key", ttl_seconds: 30, wait: true, max_wait_seconds: 10 });
    db.prepare("UPDATE lease_waiters SET max_wait_at = datetime('now', '-1 second') WHERE project_id = ? AND lock_key = 'isolation:key'").run(projectId);
    db.exec("CREATE TRIGGER fail_timeout_wake BEFORE INSERT ON wakes WHEN NEW.body LIKE 'Gave up waiting for lease %' BEGIN SELECT RAISE(ABORT, 'timeout wake failure'); END");
    try {
      await tick();
      await until(() => readFileSync(b.sink, "utf8").includes("LEASE-WAIT-ISOLATION"), 5000);
      assert.equal(db.prepare("SELECT fire_count FROM wakes WHERE id = ?").get(wake.wake_id).fire_count, 1);
      assert.equal(waiterCount(projectId, "isolation:key"), 1);
    } finally {
      db.exec("DROP TRIGGER fail_timeout_wake");
    }
  });

  it("a held grant wake retains one row and delivers its deadline once after copy mode clears", NEEDS_TMUX, async () => {
    const b = await ensureWorker("copy-b");
    const held = await lead.call("lease_acquire", { key: "copy:key", ttl_seconds: 120 });
    assert.equal(held.acquired, true);
    await b.client.call("lease_acquire", { key: "copy:key", ttl_seconds: 60, wait: true });
    execFileSync("tmux", ["copy-mode", "-t", b.pane]);
    await lead.call("lease_release", { key: "copy:key" });
    const wake = wakeRows(projectId, b.actor).find((row) => row.body.includes("copy:key"));
    assert.ok(wake);
    await tick();
    assert.equal(db.prepare("SELECT fire_count, typed_at FROM wakes WHERE id = ?").get(wake.id).fire_count, 0);
    execFileSync("tmux", ["send-keys", "-t", b.pane, "-X", "cancel"]);
    await tick();
    await until(() => readFileSync(b.sink, "utf8").includes("Call lease_acquire again before then to extend it."), 5000);
    await new Promise((resolve) => setTimeout(resolve, 350));
    const row = db.prepare("SELECT fire_count, typed_at FROM wakes WHERE id = ?").get(wake.id);
    assert.equal(row.fire_count, 1);
    assert.ok(row.typed_at);
    assert.equal(readFileSync(b.sink, "utf8").split("Call lease_acquire again before then to extend it.").length - 1, 1);
  });
});
