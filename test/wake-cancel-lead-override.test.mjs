import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { isolateTmux, McpClient, scratchDirs } from "./helpers.mjs";

const { cleanup } = isolateTmux("the wake_cancel lead-override tests");
const { dataDir, projectDir } = scratchDirs();
process.env.HIVE_DATA_DIR = dataDir;
const { db } = await import("../dist/db.js");

const WORKER_ACTOR = "agent:wake-cancel-worker";
const LEAD_ACTOR = "lead:wake-cancel-999";

describe("wake_cancel: a running lead may cancel a wake it does not own", () => {
  let workerMcp;
  let leadMcp;
  let projectId;

  before(async () => {
    workerMcp = new McpClient({ cwd: projectDir, dataDir, env: { HIVE_AGENT_ID: WORKER_ACTOR } });
    await workerMcp.start();
    projectId = (await workerMcp.call("whoami")).project.id;

    leadMcp = new McpClient({ cwd: projectDir, dataDir, env: { HIVE_AGENT_ID: LEAD_ACTOR } });
    await leadMcp.start();

    db.prepare(
      `INSERT INTO agents (project_id, actor_id, name, tmux_target, command, cwd, kind, status)
       VALUES (?, ?, 'lead', '', 'claude', ?, 'lead', 'running')`,
    ).run(projectId, LEAD_ACTOR, projectDir);
  });

  after(async () => {
    await workerMcp.close();
    await leadMcp.close();
    cleanup();
  });

  function seedWorkerOwnedWake() {
    return db
      .prepare(
        `INSERT INTO wakes (project_id, owner, body, kind, watch, deliver_actor, deliver_pane, due_at, created_at)
         VALUES (?, ?, 'the worker set this for itself', 'delay', '[]', ?, '%nowhere',
           datetime('now', '+3600 seconds'), datetime('now', '-60 seconds'))
         RETURNING id`,
      )
      .get(projectId, WORKER_ACTOR, WORKER_ACTOR).id;
  }

  it("a running lead cancels a wake owned by a different, unrelated actor", async () => {
    const wakeId = seedWorkerOwnedWake();

    const result = await leadMcp.call("wake_cancel", { wake_id: wakeId });
    assert.equal(result.cancelled, true, "a running lead must be able to cancel any pending wake in the project");

    const row = db.prepare("SELECT cancelled_at FROM wakes WHERE id = ?").get(wakeId);
    assert.ok(row.cancelled_at, "the row itself must actually be cancelled, not just the receipt claiming so");
  });

  it("ownership still applies to everyone else: a non-lead cannot cancel another actor's wake", async () => {
    const wakeId = seedWorkerOwnedWake();
    const otherWorker = new McpClient({
      cwd: projectDir,
      dataDir,
      env: { HIVE_AGENT_ID: "agent:wake-cancel-stranger" },
    });
    await otherWorker.start();
    try {
      const result = await otherWorker.call("wake_cancel", { wake_id: wakeId });
      assert.equal(result.cancelled, false, "a non-lead, non-owner caller must not be able to cancel someone else's wake");
    } finally {
      await otherWorker.close();
    }
  });

  it("the owner itself can still cancel its own wake, unaffected by the lead override", async () => {
    const wakeId = seedWorkerOwnedWake();
    const result = await workerMcp.call("wake_cancel", { wake_id: wakeId });
    assert.equal(result.cancelled, true, "the wake's own owner must still be able to cancel it directly");
  });
});
