import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import { isolateTmux, makeFakeClaude, McpClient, scratchDirs } from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("the wake_when_idle supersede tests");

const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { db } = await import("../dist/db.js");
const { sessionName } = await import("../dist/tmux.js");

const fakeClaude = makeFakeClaude(dirs.tmp);

describe("wake_when_idle supersedes the same owner's older one-shot", { skip: hasTmux ? false : "tmux is not installed" }, () => {
  let mcp;
  let projectId;
  let actorId;
  let w1;
  let w2;

  before(async () => {
    mcp = new McpClient({ cwd: dirs.projectDir, dataDir: dirs.dataDir, env: { HIVE_SPAWN_READY_MS: "1000" } });
    await mcp.start();
    const who = await mcp.call("whoami");
    projectId = who.project.id;
    actorId = who.actor_id;
    w1 = (await mcp.call("agent_spawn", { name: "sup-w1", command: fakeClaude("sleep 600"), extra_args: [] })).agent_id;
    w2 = (await mcp.call("agent_spawn", { name: "sup-w2", command: fakeClaude("sleep 600"), extra_args: [] })).agent_id;
  });

  after(async () => {
    await mcp.close();
    cleanup(sessionName());
  });

  beforeEach(() => {
    db.prepare("DELETE FROM wakes WHERE project_id = ?").run(projectId);
  });

  const arm = (agents, body = "b", mode = "any") =>
    mcp.call("wake_when_idle", { agents, body, mode, deliver_to: w1 });
  const row = (id) => db.prepare("SELECT cancelled_at, fired_at, held_at FROM wakes WHERE id = ?").get(id);

  it("cancels a held older wake with the same set and names it in the new receipt", async () => {
    const a = await arm([w1]);
    db.prepare("UPDATE wakes SET held_at = datetime('now'), held_reason = 'held' WHERE id = ?").run(a.wake_id);
    const b = await arm([w1], "fresh body");
    assert.deepEqual(b.superseded, [a.wake_id]);
    assert.notEqual(row(a.wake_id).cancelled_at, null);
    assert.equal(row(b.wake_id).cancelled_at, null);
    const live = db
      .prepare("SELECT COUNT(*) AS n FROM wakes WHERE project_id = ? AND cancelled_at IS NULL AND fired_at IS NULL")
      .get(projectId).n;
    assert.equal(live, 1, "only the new wake may remain pending");
  });

  it("matches the watched set regardless of order", async () => {
    const a = await arm([w1, w2]);
    const b = await arm([w2, w1]);
    assert.deepEqual(b.superseded, [a.wake_id]);
  });

  it("leaves an older wake with a different watched set alone and omits superseded", async () => {
    const a = await arm([w1]);
    const b = await arm([w1, w2]);
    assert.equal(row(a.wake_id).cancelled_at, null);
    assert.equal("superseded" in b, false);
  });

  it("leaves a standing watch with the same set untouched", async () => {
    const a = await arm([w1]);
    db.prepare("UPDATE wakes SET watch_scope = 'project' WHERE id = ?").run(a.wake_id);
    const b = await arm([w1]);
    assert.equal(row(a.wake_id).cancelled_at, null);
    assert.equal("superseded" in b, false);
  });

  it("leaves another owner's wake untouched", async () => {
    const a = await arm([w1]);
    db.prepare("INSERT OR IGNORE INTO actors (id, name, kind) VALUES ('agent:424242', 'other', 'agent')").run();
    db.prepare("UPDATE wakes SET owner = 'agent:424242' WHERE id = ?").run(a.wake_id);
    assert.notEqual(actorId, "agent:424242");
    const b = await arm([w1]);
    assert.equal(row(a.wake_id).cancelled_at, null);
    assert.equal("superseded" in b, false);
  });

  it("leaves an already fired wake untouched", async () => {
    const a = await arm([w1]);
    db.prepare("UPDATE wakes SET fired_at = datetime('now') WHERE id = ?").run(a.wake_id);
    const b = await arm([w1]);
    assert.equal(row(a.wake_id).cancelled_at, null);
    assert.equal("superseded" in b, false);
  });

  it("leaves a wake bound for a different deliver target untouched", async () => {
    const a = await arm([w1]);
    const b = await mcp.call("wake_when_idle", { agents: [w1], body: "b", deliver_to: w2 });
    assert.equal(row(a.wake_id).cancelled_at, null);
    assert.equal("superseded" in b, false);
  });
});
