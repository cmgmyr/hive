import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { isolateTmux, liveAgentRow, makeFakeClaude, McpClient, scratchDirs } from "./helpers.mjs";

// Todo 369, measured live tearing down issue #156's own lane: agent_close
// kills the pane, then takes closeAgentRow's conditional close (id +
// status='running' + tmux_target). When that CAS loses, the row already says
// what actually happened - closed by someone else (the caller's real
// question, and the pane this call itself killed is still dead either way),
// or running again on a fresh pane (the only case that deserves a refusal).
// The old message claimed "Nothing was closed" unconditionally, which was
// FALSE for the case that was actually measured: this call's own kill-pane
// cannot be undone by a lost CAS.
//
// The real race (a concurrent writer landing between findAgent's SELECT and
// closeAgentRow's UPDATE) has no reliable hook to interject on -
// test/close-agent-row-target-guard.test.mjs's own header explains why. What
// IS reproducible through the real MCP surface is a row that is ALREADY
// retired by the time this call reads it: findAgent's agent_id branch does
// not filter by status, so a caller targeting by id reaches the identical
// lost-CAS code path whether the row became inconsistent a millisecond ago
// or was already that way when the call started. Same code, same report.
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

    // Stands in for a concurrent closer (the janitor, or another agent_close)
    // that retired this row before this call ever reached its own write -
    // the same lost-CAS code path a genuinely concurrent close would hit.
    // DELIBERATELY the row only - the pane is left genuinely ALIVE, which is
    // exactly what the counselors fix round below is about.
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

    // Counselors (all three seats, same commit as this test). isLive returns
    // false WITHOUT ever probing tmux whenever agent.status !== "running",
    // so the FIRST version of this note claimed "this call found the pane
    // already dead" here - false, since no probe ever happened, and this
    // line proves it: the pane is still genuinely ALIVE, because nothing in
    // this test ever killed it. The note must say it never checked, not
    // that it checked and found the pane dead.
    assert.match(receipt.note, /never checked the pane - it may still be running/);
    assert.equal(targetLive(live.tmux_target), true, "the pane really is still alive - the note must not deny it");

    // Real state, not just the receipt (test/CLAUDE.md's own rule: a receipt
    // is the handler's claim about itself).
    assert.equal(db.prepare("SELECT status FROM agents WHERE id = ?").get(live.agent_id).status, "closed");

    // Cleanup: the pane this test deliberately left alive. Restore the row
    // to 'running' (matching the pane's real state) so the real agent_close
    // path - probe, kill, CAS - actually tears it down, rather than leaving
    // an orphan for isolateTmux's own exit-time leak report to catch.
    db.prepare("UPDATE agents SET status = 'running' WHERE id = ?").run(live.agent_id);
    await mcp.call("agent_close", { agent_id: live.agent_id });
  });

  // The lost-CAS branch above also carries a `report.parked` case for
  // "already retired as a park" - but agent_close cannot reach it through
  // this file's own pre-mutation trick the way the unparked case above does.
  // findAgent(agent_id) reads the row ONCE, and agent_close's pre-existing
  // "if (agent.status === 'closed' && agent.parked_at)" gate (the park
  // ABANDONMENT path, tested below and in agent-park.test.mjs's own file)
  // runs against that same read, before isLive or closeAgentRow are ever
  // reached - so a row that is ALREADY closed+parked at the moment this call
  // starts takes that path instead, correctly, and never reaches the CAS at
  // all. The lost-CAS "parked" branch is only reachable through a genuine
  // race (read running, kill, LOSE the write to a concurrent agent_park that
  // completes in between) - the identical class of race
  // test/close-agent-row-target-guard.test.mjs's own header explains has no
  // hook to interject on through the live MCP surface. Its classification is
  // pinned by construction instead, in test/lost-cas-report.test.mjs's
  // "reads a closed row carrying a park stamp as retired AND parked".
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
