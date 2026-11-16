import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import {
  assertScratchStore,
  clearHiveEnv,
  isolateTmux,
  liveAgentRow,
  makeFakeClaude,
  McpClient,
  scratchDirs,
} from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("the lease-release tests");
clearHiveEnv();
const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { db } = await import("../dist/db.js");
await assertScratchStore();
const { janitor } = await import("../dist/scheduler.js");
const { closeAgentRowWithLeases } = await import("../dist/spawn.js");
const { sessionName } = await import("../dist/tmux.js");

let mcp;
let projectId;
const fakeClaude = makeFakeClaude(dirs.tmp);
const EMPTY = { panes: new Set(), windows: new Set(), serverAnswered: true };

before(async () => {
  mcp = new McpClient({ cwd: dirs.projectDir, dataDir: dirs.dataDir, env: { HIVE_SPAWN_READY_MS: "1" } });
  await mcp.start();
  projectId = (await mcp.call("whoami")).project.id;
});

after(async () => {
  await mcp.close();
  cleanup(sessionName());
});

async function workerClient(actorId, name) {
  const worker = new McpClient({
    cwd: dirs.projectDir,
    dataDir: dirs.dataDir,
    env: {
      HIVE_AGENT_ID: actorId,
      HIVE_AGENT_NAME: name,
      HIVE_PROJECT_PATH: dirs.projectDir,
      HIVE_PROJECT_LOCK: "1",
    },
  });
  await worker.start();
  return worker;
}

function seedRow(name, kind, actorId, target) {
  db.prepare("INSERT OR IGNORE INTO actors (id, name, kind) VALUES (?, ?, ?)").run(actorId, name, kind);
  return db
    .prepare(
      `INSERT INTO agents (project_id, actor_id, name, tmux_target, tmux_socket, pane_pid, command, cwd,
          status, kind, created_at)
       VALUES (?, ?, ?, ?, '', '4242', 'sleep', ?, 'running', ?, datetime('now', '-60 seconds'))
       RETURNING id`,
    )
    .get(projectId, actorId, name, target, dirs.projectDir, kind).id;
}

function seedLease(project, key, owner) {
  db.prepare("INSERT INTO leases (project_id, lock_key, owner, expires_at) VALUES (?, ?, ?, datetime('now', '+1800 seconds'))")
    .run(project, key, owner);
}

describe("worker lease release", { skip: hasTmux ? false : "tmux is not installed" }, () => {
  it("agent_close releases sorted worker leases and preserves other scopes and wake-pane leases", async () => {
    await mcp.call("agent_spawn", { name: "lease-close", command: fakeClaude() });
    const live = await liveAgentRow(mcp, "lease-close");
    const worker = await workerClient(live.actor_id, live.name);
    try {
      assert.equal((await worker.call("lease_acquire", { key: "zeta", ttl_seconds: 1800 })).acquired, true);
      assert.equal((await worker.call("lease_acquire", { key: "db:dev", ttl_seconds: 1800 })).acquired, true);
      const paneLease = `wake-pane:${live.tmux_socket}:${live.tmux_target}`;
      assert.equal((await worker.call("lease_acquire", { key: paneLease, ttl_seconds: 1800 })).acquired, true);
      assert.equal((await mcp.call("lease_acquire", { key: "other-actor", ttl_seconds: 1800 })).acquired, true);
      assert.equal((await mcp.call("lease_acquire", { key: "lead-only", ttl_seconds: 1800 })).acquired, true);

      const foreign = db.prepare("INSERT INTO projects (name, path) VALUES (?, ?) RETURNING id")
        .get("lease-release-foreign", `${dirs.projectDir}-foreign`).id;
      seedLease(foreign, "foreign-project", live.actor_id);

      const lostRace = closeAgentRowWithLeases(live.agent_id, {
        tmux_target: `${live.tmux_target}-wrong`,
        tmux_socket: live.tmux_socket,
        pane_pid: live.pane_pid,
      });
      assert.deepEqual(lostRace, { closed: false, released_leases: [] });
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM leases WHERE owner = ? AND project_id = ?")
        .get(live.actor_id, projectId).count, 3, "a failed close CAS must release nothing");

      const receipt = await mcp.call("agent_close", { name: live.name });
      assert.deepEqual(receipt.released_leases, ["db:dev", "zeta"]);
      assert.equal(db.prepare("SELECT 1 FROM leases WHERE project_id = ? AND lock_key = ?").get(projectId, paneLease) != null, true);
      assert.equal(db.prepare("SELECT 1 FROM leases WHERE project_id = ? AND lock_key = ?").get(projectId, "other-actor") != null, true);
      assert.equal(db.prepare("SELECT 1 FROM leases WHERE project_id = ? AND lock_key = ?").get(projectId, "lead-only") != null, true);
      assert.equal(db.prepare("SELECT 1 FROM leases WHERE project_id = ? AND lock_key = ?").get(foreign, "foreign-project") != null, true);
      assert.equal((await mcp.call("lease_acquire", { key: "db:dev", ttl_seconds: 1800 })).acquired, true);
    } finally {
      await worker.close();
    }
  });

  it("agent_close omits released_leases when the worker owns no leases", async () => {
    await mcp.call("agent_spawn", { name: "lease-empty", command: fakeClaude() });
    const live = await liveAgentRow(mcp, "lease-empty");

    const receipt = await mcp.call("agent_close", { name: live.name });

    assert.equal(Object.hasOwn(receipt, "released_leases"), false);
  });

  it("agent_park releases leases and a resumed worker can acquire the same key again", async () => {
    await mcp.call("agent_spawn", { name: "lease-park", command: fakeClaude() });
    const live = await liveAgentRow(mcp, "lease-park");
    const worker = await workerClient(live.actor_id, live.name);
    try {
      assert.equal((await worker.call("lease_acquire", { key: "park:db", ttl_seconds: 1800 })).acquired, true);
      const receipt = await mcp.call("agent_park", { name: live.name });
      assert.deepEqual(receipt.released_leases, ["park:db"]);
    } finally {
      await worker.close();
    }

    await mcp.call("agent_resume", { agent_id: live.agent_id });
    const resumed = await workerClient(live.actor_id, live.name);
    try {
      assert.equal((await resumed.call("lease_acquire", { key: "park:db", ttl_seconds: 1800 })).acquired, true);
    } finally {
      await resumed.close();
      await mcp.call("agent_close", { agent_id: live.agent_id });
    }
  });

  it("the janitor releases leases when it marks a dead worker lost", async () => {
    const id = seedRow("lease-dead", "agent", "agent:lease-dead", "%98765");
    seedLease(projectId, "dead:db", "agent:lease-dead");

    const result = janitor(EMPTY);

    assert.equal(result.closed_agents, 1);
    assert.equal(db.prepare("SELECT status, recovery_state FROM agents WHERE id = ?").get(id).recovery_state, "pending");
    assert.equal(db.prepare("SELECT 1 FROM leases WHERE project_id = ? AND lock_key = ?").get(projectId, "dead:db"), undefined);
    assert.equal((await mcp.call("lease_acquire", { key: "dead:db", ttl_seconds: 1800 })).acquired, true);
  });

  it("closing lead and command rows preserves their leases", () => {
    const leadId = seedRow("lease-lead", "lead", "lead:lease-lead", "%98766");
    const commandId = seedRow("lease-command", "command", "agent:lease-command", "%98767");
    seedLease(projectId, "lead-key", "lead:lease-lead");
    seedLease(projectId, "command-key", "agent:lease-command");

    assert.equal(closeAgentRowWithLeases(leadId).closed, true);
    assert.equal(closeAgentRowWithLeases(commandId).closed, true);
    assert.ok(db.prepare("SELECT 1 FROM leases WHERE project_id = ? AND lock_key = ?").get(projectId, "lead-key"));
    assert.ok(db.prepare("SELECT 1 FROM leases WHERE project_id = ? AND lock_key = ?").get(projectId, "command-key"));
  });
});
