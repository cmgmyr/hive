import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, it } from "node:test";

import { assertScratchStore, clearHiveEnv, isolateTmux, McpClient, runCli, scratchDirs } from "./helpers.mjs";

isolateTmux("the worker recovery tests");
clearHiveEnv();

const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
await assertScratchStore();

const { db, migrate } = await import("../dist/db.js");
const { janitor } = await import("../dist/scheduler.js");
const { codexHomeDir } = await import("../dist/codexHome.js");
const { markWorkerRetirementIntent } = await import("../dist/workerRecovery.js");
const { parkAgentRow } = await import("../dist/spawn.js");
migrate();

const projectId = db
  .prepare("INSERT INTO projects (name, path) VALUES (?, ?) RETURNING id")
  .get("worker-recovery", dirs.projectDir).id;
const EMPTY = { panes: new Set(), windows: new Set(), serverAnswered: true };

beforeEach(() => db.prepare("DELETE FROM agents").run());

function seedWorker(name, { codexHome = "", pane = "%8001", created = "-60 seconds" } = {}) {
  return db
    .prepare(
      `INSERT INTO agents (project_id, actor_id, name, tmux_target, tmux_socket, pane_pid, command, cwd,
          status, kind, codex_home, created_at)
       VALUES (?, ?, ?, ?, '', '4242', 'codex', ?, 'running', 'agent', ?, datetime('now', ?))
       RETURNING id`,
    )
    .get(projectId, `agent:${name}`, name, pane, join(dirs.tmp, name), codexHome, created).id;
}

describe("crash recovery records only a conclusive loss of the recorded worker pane", () => {
  it("marks the lost worker pending without a project config gate", () => {
    const id = seedWorker("crashed");

    const result = janitor(EMPTY);

    const row = db.prepare("SELECT status, recovery_state, closed_at FROM agents WHERE id = ?").get(id);
    assert.equal(result.closed_agents, 1);
    assert.equal(row.status, "closed");
    assert.equal(row.recovery_state, "pending");
    assert.ok(row.closed_at, "the loss timestamp also starts the retention window");
  });

  it("does not infer a loss when the tmux probe did not answer", () => {
    const id = seedWorker("unknown");

    const result = janitor(null);

    const row = db.prepare("SELECT status, recovery_state FROM agents WHERE id = ?").get(id);
    assert.equal(result.probed, false);
    assert.equal(row.status, "running");
    assert.equal(row.recovery_state, "");
  });

  it("a close intent written before a kill keeps the sweep from calling it a crash", () => {
    const id = seedWorker("deliberate");
    const identity = { tmux_target: "%8001", tmux_socket: "", pane_pid: "4242" };
    assert.equal(markWorkerRetirementIntent(id, identity), true);

    const result = janitor(EMPTY);

    const row = db.prepare("SELECT status, recovery_state FROM agents WHERE id = ?").get(id);
    assert.equal(result.closed_agents, 1);
    assert.equal(row.status, "closed");
    assert.equal(row.recovery_state, "excluded");
  });

  it("the park row transition keeps its intent excluded", () => {
    const id = seedWorker("parked");
    const identity = { tmux_target: "%8001", tmux_socket: "", pane_pid: "4242" };
    assert.equal(markWorkerRetirementIntent(id, identity), true);

    assert.ok(parkAgentRow(id, identity, "main"));

    const row = db.prepare("SELECT status, recovery_state, parked_at, parked_branch FROM agents WHERE id = ?").get(id);
    assert.equal(row.status, "closed");
    assert.equal(row.recovery_state, "excluded");
    assert.ok(row.parked_at);
    assert.equal(row.parked_branch, "main");
  });
});

describe("a pending crash keeps its Codex home for seven days across server processes", () => {
  it("survives a fresh CLI process, then the janitor reaps it after seven days", async () => {
    const homeKey = "crashed-home-7d";
    mkdirSync(codexHomeDir(homeKey), { recursive: true });
    writeFileSync(join(codexHomeDir(homeKey), "marker"), "retained");
    const id = seedWorker("codex-crashed", { codexHome: homeKey, pane: "%8002" });

    janitor(EMPTY);
    assert.equal(db.prepare("SELECT recovery_state FROM agents WHERE id = ?").get(id).recovery_state, "pending");

    const freshServer = await runCli(["status"], {
      cwd: dirs.projectDir,
      dataDir: dirs.dataDir,
      tmp: dirs.tmp,
      env: { TMUX_TMPDIR: process.env.TMUX_TMPDIR, CLAUDE_CONFIG_DIR: join(dirs.tmp, "claude-config") },
    });
    assert.equal(freshServer.code, 0, freshServer.stderr);
    assert.equal(existsSync(codexHomeDir(homeKey)), true, "a restarted process must preserve the resumable home");
    assert.equal(db.prepare("SELECT codex_home FROM agents WHERE id = ?").get(id).codex_home, homeKey);

    db.prepare("UPDATE agents SET closed_at = datetime('now', '-8 days') WHERE id = ?").run(id);
    assert.equal(janitor(EMPTY).reaped_codex_homes, 1);
    assert.equal(existsSync(codexHomeDir(homeKey)), false);
    assert.equal(db.prepare("SELECT codex_home FROM agents WHERE id = ?").get(id).codex_home, "");
  });

  it("agent_close abandons a pending crash and releases its Codex home", async () => {
    const homeKey = "crashed-home-abandoned";
    mkdirSync(codexHomeDir(homeKey), { recursive: true });
    writeFileSync(join(codexHomeDir(homeKey), "marker"), "release");
    const id = db
      .prepare(
        `INSERT INTO agents (project_id, actor_id, name, tmux_target, tmux_socket, pane_pid, command, cwd,
            status, kind, codex_home, recovery_state, closed_at)
         VALUES (?, 'agent:abandon', 'abandon', '', '', '', 'codex', ?, 'closed', 'agent', ?, 'pending', datetime('now'))
         RETURNING id`,
      )
      .get(projectId, dirs.projectDir, homeKey).id;
    const mcp = new McpClient({
      cwd: dirs.projectDir,
      dataDir: dirs.dataDir,
      env: { TMUX_TMPDIR: process.env.TMUX_TMPDIR },
    });
    await mcp.start();
    try {
      const result = await mcp.call("agent_close", { agent_id: id });
      const row = db.prepare("SELECT recovery_state, codex_home FROM agents WHERE id = ?").get(id);
      assert.equal(result.closed, true);
      assert.equal(row.recovery_state, "excluded");
      assert.equal(row.codex_home, "");
      assert.equal(existsSync(codexHomeDir(homeKey)), false);
    } finally {
      await mcp.close();
    }
  });
});
