import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import { isolateTmux, McpClient, scratchDirs, seedLeadRow } from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("the agent_rename lead guard tests");

const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { db } = await import("../dist/db.js");
const { sessionName } = await import("../dist/tmux.js");

describe("agent_rename refuses the lead", { skip: hasTmux ? false : "tmux is not installed" }, () => {
  let mcp;
  let projectId;

  before(async () => {
    mcp = new McpClient({ cwd: dirs.projectDir, dataDir: dirs.dataDir });
    await mcp.start();
    projectId = (await mcp.call("whoami")).project.id;
  });

  after(async () => {
    await mcp.close();
    cleanup(sessionName());
  });

  beforeEach(() => {
    db.prepare("DELETE FROM agents WHERE project_id = ? AND kind = 'lead'").run(projectId);
  });

  it("refuses to rename a kind='lead' row addressed by name, and leaves it unchanged", async () => {
    const leadId = seedLeadRow(db, projectId, dirs.projectDir);

    await assert.rejects(mcp.call("agent_rename", { name: "lead", new_name: "not-lead" }), /lead/i);

    const row = db.prepare("SELECT name FROM agents WHERE id = ?").get(leadId);
    assert.equal(row.name, "lead", "a refused rename must not touch the row");
  });

  it("refuses to rename a kind='lead' row addressed by agent_id too", async () => {
    const leadId = seedLeadRow(db, projectId, dirs.projectDir);

    await assert.rejects(mcp.call("agent_rename", { agent_id: leadId, new_name: "not-lead" }), /lead/i);

    assert.equal(db.prepare("SELECT name FROM agents WHERE id = ?").get(leadId).name, "lead");
  });

  it("still renames an ordinary worker, the accept case for this guard", async () => {
    await mcp.call("agent_spawn", { name: "ordinary-worker", command: "sleep", extra_args: ["600"] });

    const renamed = await mcp.call("agent_rename", { name: "ordinary-worker", new_name: "renamed-worker" });

    assert.equal(renamed.name, "renamed-worker");
    assert.equal(
      db.prepare("SELECT status FROM agents WHERE project_id = ? AND name = ?").get(projectId, "renamed-worker")
        .status,
      "running",
    );
  });
});
