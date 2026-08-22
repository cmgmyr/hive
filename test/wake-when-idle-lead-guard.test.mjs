import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import { isolateTmux, makeFakeClaude, McpClient, scratchDirs, seedLeadRow } from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("the wake_when_idle lead guard tests");

const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { db } = await import("../dist/db.js");
const { sessionName } = await import("../dist/tmux.js");

const fakeClaude = makeFakeClaude(dirs.tmp);

describe("wake_when_idle refuses a lead target", { skip: hasTmux ? false : "tmux is not installed" }, () => {
  let mcp;
  let projectId;

  before(async () => {
    mcp = new McpClient({ cwd: dirs.projectDir, dataDir: dirs.dataDir, env: { HIVE_SPAWN_READY_MS: "1000" } });
    await mcp.start();
    projectId = (await mcp.call("whoami")).project.id;
  });

  after(async () => {
    await mcp.close();
    cleanup(sessionName());
  });

  beforeEach(() => {
    db.prepare("DELETE FROM agents WHERE project_id = ? AND kind = 'lead'").run(projectId);
    db.prepare("DELETE FROM timers WHERE project_id = ?").run(projectId);
  });

  const REFUSAL = /wake_when_idle refuses a lead target/;

  it("refuses a lead target addressed by name, and schedules nothing", async () => {
    seedLeadRow(db, projectId, dirs.projectDir);
    const worker = await mcp.call("agent_spawn", { name: "worker-x", command: "sleep", extra_args: ["600"] });

    await assert.rejects(
      mcp.call("wake_when_idle", {
        agents: ["lead"],
        body: "should never be scheduled",
        deliver_to: worker.agent_id,
      }),
      REFUSAL,
    );

    const pending = db.prepare("SELECT COUNT(*) AS n FROM timers WHERE project_id = ?").get(projectId).n;
    assert.equal(pending, 0, "a refused wake_when_idle must not leave a timer row behind");
  });

  it("refuses a lead among several watched agents, not just a lone one", async () => {
    seedLeadRow(db, projectId, dirs.projectDir);
    const worker = await mcp.call("agent_spawn", { name: "worker-a", command: "sleep", extra_args: ["600"] });

    await assert.rejects(
      mcp.call("wake_when_idle", {
        agents: [worker.agent_id, "lead"],
        body: "should never be scheduled",
        deliver_to: worker.agent_id,
      }),
      REFUSAL,
    );

    const pending = db.prepare("SELECT COUNT(*) AS n FROM timers WHERE project_id = ?").get(projectId).n;
    assert.equal(pending, 0, "one lead among several watched agents must still refuse the whole call");
  });

  it("still schedules for an ordinary worker, the accept case for this guard", async () => {
    const worker = await mcp.call("agent_spawn", {
      name: "worker-b",
      command: fakeClaude("sleep 600"),
      extra_args: [],
    });

    const scheduled = await mcp.call("wake_when_idle", {
      agents: [worker.agent_id],
      body: "fine to schedule",
      deliver_to: worker.agent_id,
    });

    assert.ok(scheduled.wake_id, "an ordinary worker must still be watchable");
    const pending = db.prepare("SELECT COUNT(*) AS n FROM timers WHERE project_id = ?").get(projectId).n;
    assert.equal(pending, 1);
  });
});
