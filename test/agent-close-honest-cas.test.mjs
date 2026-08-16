import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { isolateTmux, liveAgentRow, makeFakeClaude, McpClient, scratchDirs } from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("the agent_close honest-report tests");

const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { db } = await import("../dist/db.js");
const { sessionName, targetLive } = await import("../dist/tmux.js");

let mcp;

before(async () => {
  mcp = new McpClient({ cwd: dirs.projectDir, dataDir: dirs.dataDir, env: { HIVE_SPAWN_READY_MS: "1" } });
  await mcp.start();
});

after(async () => {
  await mcp.close();
  cleanup(sessionName());
});

const fakeClaude = makeFakeClaude(dirs.tmp);

describe("agent_close's lost-CAS report", { skip: hasTmux ? false : "tmux is not installed" }, () => {
  it("reports closed:true, not a denial, when someone else already closed the row first", async () => {
    await mcp.call("agent_spawn", { name: "close-already-closed", command: fakeClaude() });
    const live = await liveAgentRow(mcp, "close-already-closed");

    db.prepare("UPDATE agents SET status = 'closed', closed_at = datetime('now') WHERE id = ?").run(live.agent_id);

    const receipt = await mcp.call("agent_close", { agent_id: live.agent_id });
    assert.equal(receipt.closed, true, "the end state IS closed - the old bug denied this outright");
    assert.equal(receipt.parked, undefined, "an ordinary close carries no park field");
    assert.match(receipt.note, /Already closed by someone else/);
    assert.doesNotMatch(
      receipt.note,
      /janitor, which reaped the pane this call itself just killed/,
      "this call's own probe read the row as already closed, so isLive short-circuited to false and it never touched the pane - crediting itself with a kill it did not do would be the identical dishonesty this fix exists to remove",
    );

    assert.match(receipt.note, /never checked the pane - it may still be running/);
    assert.equal(targetLive(live.tmux_target), true, "the pane really is still alive - the note must not deny it");

    assert.equal(db.prepare("SELECT status FROM agents WHERE id = ?").get(live.agent_id).status, "closed");

    db.prepare("UPDATE agents SET status = 'running' WHERE id = ?").run(live.agent_id);
    await mcp.call("agent_close", { agent_id: live.agent_id });
  });

  it("the park-abandonment gate, not the lost-CAS branch, is what a pre-parked row actually hits", async () => {
    await mcp.call("agent_spawn", { name: "close-already-parked", command: fakeClaude() });
    const live = await liveAgentRow(mcp, "close-already-parked");

    db.prepare(
      `UPDATE agents SET status = 'closed', closed_at = datetime('now'), parked_at = datetime('now'),
         parked_branch = 'raced-in-by-a-concurrent-park' WHERE id = ?`,
    ).run(live.agent_id);

    const receipt = await mcp.call("agent_close", { agent_id: live.agent_id });
    assert.equal(receipt.closed, true);
    assert.equal(receipt.park_released, true, "the pre-existing abandon-a-park path, not the lost-CAS report");
    assert.equal(receipt.parked, undefined, "that field belongs to the lost-CAS branch this call never reaches");
  });
});
