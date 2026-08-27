import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { isolateTmux, liveAgentRow, makeFakeClaude, McpClient, scratchDirs, sleep } from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("the agent_resume tests");

const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { db } = await import("../dist/db.js");
const { sessionName } = await import("../dist/tmux.js");

let mcp;
let projectId;

before(async () => {
  mcp = new McpClient({
    cwd: dirs.projectDir,
    dataDir: dirs.dataDir,
    env: { HIVE_SPAWN_READY_MS: "1" },
  });
  await mcp.start();
  projectId = (await mcp.call("whoami")).project.id;
});

after(async () => {
  await mcp.close();
  cleanup(sessionName());
});

const fakeClaude = makeFakeClaude(dirs.tmp);

describe("agent_resume", { skip: hasTmux ? false : "tmux is not installed" }, () => {
  it("resumes a closed claude worker onto a fresh pane, reusing the row and actor_id (D2)", async () => {
    await mcp.call("agent_spawn", { name: "resume-me", command: fakeClaude() });
    const beforeStatus = await mcp.call("agent_status", { name: "resume-me" });
    assert.ok(beforeStatus.session_id, "setup bug: spawned claude worker must carry a session id");
    const beforeRow = await liveAgentRow(mcp, "resume-me");
    const beforePanePid = db.prepare("SELECT pane_pid FROM agents WHERE id = ?").get(beforeRow.agent_id).pane_pid;

    await mcp.call("agent_close", { name: "resume-me" });
    const closedRow = (await mcp.call("agent_list", { include_closed: true })).agents.find(
      (a) => a.name === "resume-me",
    );
    assert.equal(closedRow.alive, false);

    const receipt = await mcp.call("agent_resume", { name: "resume-me" });
    assert.equal(receipt.agent_id, beforeRow.agent_id);
    assert.equal(receipt.actor_id, beforeRow.actor_id);
    assert.equal(receipt.resumed_session_id, beforeStatus.session_id);

    const afterRow = await liveAgentRow(mcp, "resume-me");
    assert.equal(afterRow.agent_id, beforeRow.agent_id, "must be the SAME row, not a new one");
    assert.equal(afterRow.actor_id, beforeRow.actor_id, "must be the SAME actor_id, not a new one");

    const row = db.prepare("SELECT status, closed_at, command, pane_pid FROM agents WHERE id = ?").get(beforeRow.agent_id);
    assert.notEqual(row.pane_pid, beforePanePid, "must be a fresh process");
    assert.equal(row.status, "running");
    assert.equal(row.closed_at, null);
    assert.ok(
      row.command.includes(`--resume ${beforeStatus.session_id}`),
      `command should carry --resume: ${row.command}`,
    );

    await mcp.call("agent_close", { name: "resume-me" });
  });

  it("refuses a target that is still running -- findClosedAgent only searches closed rows", async () => {
    await mcp.call("agent_spawn", { name: "resume-running", command: fakeClaude() });
    await liveAgentRow(mcp, "resume-running");

    await assert.rejects(mcp.call("agent_resume", { name: "resume-running" }), /No closed agent matching/);

    await mcp.call("agent_close", { name: "resume-running" });
  });

  it("refuses a closed worker on an unresumable harness -- no session id to resume from (D4)", async () => {
    await mcp.call("agent_spawn", { name: "resume-plain", command: "sleep", extra_args: ["600"] });
    await liveAgentRow(mcp, "resume-plain");
    await mcp.call("agent_close", { name: "resume-plain" });

    await assert.rejects(mcp.call("agent_resume", { name: "resume-plain" }), /does not support resume/);
  });

  it("refuses a closed claude row with no recorded session id (a legacy or never-hooked row)", async () => {
    const id = db
      .prepare(
        `INSERT INTO agents (project_id, actor_id, name, tmux_target, command, cwd, status, kind, session_id)
         VALUES (?, 'agent:resume-legacy', 'resume-legacy', '', 'claude', ?, 'closed', 'agent', '') RETURNING id`,
      )
      .get(projectId, dirs.projectDir).id;

    await assert.rejects(mcp.call("agent_resume", { agent_id: id }), /has no recorded session id/);
  });

  it("refuses a lead target", async () => {
    const id = db
      .prepare(
        `INSERT INTO agents (project_id, actor_id, name, tmux_target, command, cwd, status, kind, session_id)
         VALUES (?, 'lead:resume-guard', 'lead', '', 'claude', ?, 'closed', 'lead', 'some-lead-session') RETURNING id`,
      )
      .get(projectId, dirs.projectDir).id;

    await assert.rejects(mcp.call("agent_resume", { agent_id: id }), /is this project's lead session/);
  });

  it("refuses with a friendly message when a running agent has since taken the closed row's name (D2's own named cost)", async () => {
    await mcp.call("agent_spawn", { name: "resume-collide", command: fakeClaude() });
    await liveAgentRow(mcp, "resume-collide");
    const closedRow = await mcp.call("agent_status", { name: "resume-collide" });
    await mcp.call("agent_close", { name: "resume-collide" });

    await mcp.call("agent_spawn", { name: "resume-collide", command: fakeClaude() });
    await liveAgentRow(mcp, "resume-collide");

    await assert.rejects(mcp.call("agent_resume", { agent_id: closedRow.agent_id }), (e) => {
      assert.match(e.message, new RegExp(`Cannot resume agent ${closedRow.agent_id} \\("resume-collide"\\)`));
      assert.match(e.message, /closed lane is not lost/, "not parked, so the closed wording, not the parked one");
      assert.match(e.message, new RegExp(`retry agent_resume\\(agent_id: ${closedRow.agent_id}\\)`));
      assert.ok(!/Pick another name/.test(e.message), "the old advice is impossible for a resume to act on");
      return true;
    });

    await mcp.call("agent_close", { name: "resume-collide" });
  });

  it("catches a non-ASCII name collision idx_agents_running_name's own COLLATE NOCASE would miss (counselors, opus)", async () => {
    await mcp.call("agent_spawn", { name: "resume-café", command: fakeClaude() });
    await liveAgentRow(mcp, "resume-café");
    const closedRow = await mcp.call("agent_status", { name: "resume-café" });
    await mcp.call("agent_close", { name: "resume-café" });

    await mcp.call("agent_spawn", { name: "RESUME-CAFÉ", command: fakeClaude() });
    await liveAgentRow(mcp, "RESUME-CAFÉ");

    await assert.rejects(
      mcp.call("agent_resume", { agent_id: closedRow.agent_id }),
      new RegExp(`Cannot resume agent ${closedRow.agent_id} \\("resume-café"\\)`),
    );

    await mcp.call("agent_close", { name: "RESUME-CAFÉ" });
  });

  it("names the row PARKED, not merely closed, when a parked lane's own name collides on resume", async () => {
    await mcp.call("agent_spawn", { name: "resume-parked-collide", command: fakeClaude() });
    await liveAgentRow(mcp, "resume-parked-collide");
    const parked = await mcp.call("agent_park", { name: "resume-parked-collide" });

    await mcp.call("agent_spawn", { name: "resume-parked-collide", command: fakeClaude() });
    await liveAgentRow(mcp, "resume-parked-collide");

    await assert.rejects(mcp.call("agent_resume", { agent_id: parked.agent_id }), (e) => {
      assert.match(e.message, new RegExp(`Cannot resume agent ${parked.agent_id} \\("resume-parked-collide"\\)`));
      assert.match(e.message, /parked lane is not lost/, "parked, so the parked wording, not the closed one");
      return true;
    });

    await mcp.call("agent_close", { name: "resume-parked-collide" });
  });

  it("resolves a shared name to the MOST RECENTLY closed row", async () => {
    await mcp.call("agent_spawn", { name: "resume-dup", command: fakeClaude() });
    await liveAgentRow(mcp, "resume-dup");
    await mcp.call("agent_close", { name: "resume-dup" });
    const firstClose = (await mcp.call("agent_list", { include_closed: true })).agents.find(
      (a) => a.name === "resume-dup",
    );

    await mcp.call("agent_spawn", { name: "resume-dup", command: fakeClaude() });
    await liveAgentRow(mcp, "resume-dup");
    await mcp.call("agent_close", { name: "resume-dup" });
    const secondClose = (await mcp.call("agent_list", { include_closed: true })).agents
      .filter((a) => a.name === "resume-dup")
      .sort((a, b) => b.agent_id - a.agent_id)[0];
    assert.notEqual(secondClose.agent_id, firstClose.agent_id, "setup bug: expected two distinct closed rows");

    const receipt = await mcp.call("agent_resume", { name: "resume-dup" });
    assert.equal(receipt.agent_id, secondClose.agent_id, "must resume the most recently closed row, not the first");

    await mcp.call("agent_close", { name: "resume-dup" });
  });

  it("orders by closed_at, not id -- a resumed-then-reclosed LOWER id can be more recent than a HIGHER id (counselors, codex)", async () => {
    await mcp.call("agent_spawn", { name: "resume-inversion", command: fakeClaude() });
    await liveAgentRow(mcp, "resume-inversion");
    const rowA = await mcp.call("agent_status", { name: "resume-inversion" });
    await mcp.call("agent_close", { name: "resume-inversion" });

    await mcp.call("agent_spawn", { name: "resume-inversion", command: fakeClaude() });
    await liveAgentRow(mcp, "resume-inversion");
    const rowB = await mcp.call("agent_status", { name: "resume-inversion" });
    await mcp.call("agent_close", { name: "resume-inversion" });
    assert.ok(rowB.agent_id > rowA.agent_id, "setup bug: B must have the higher agent_id");

    await mcp.call("agent_resume", { agent_id: rowA.agent_id });
    await liveAgentRow(mcp, "resume-inversion");
    await sleep(1100);
    await mcp.call("agent_close", { agent_id: rowA.agent_id });

    const receipt = await mcp.call("agent_resume", { name: "resume-inversion" });
    assert.equal(receipt.agent_id, rowA.agent_id, "must resume A (closed_at more recent), not B (id higher)");

    await mcp.call("agent_close", { agent_id: rowA.agent_id });
  });

  it("prefers a PARKED row over a more recently closed one sharing its name", async () => {
    await mcp.call("agent_spawn", { name: "resume-parked-vs-closed", command: fakeClaude() });
    await liveAgentRow(mcp, "resume-parked-vs-closed");
    const parked = await mcp.call("agent_park", { name: "resume-parked-vs-closed" });

    await sleep(1100);

    await mcp.call("agent_spawn", { name: "resume-parked-vs-closed", command: fakeClaude() });
    await liveAgentRow(mcp, "resume-parked-vs-closed");
    const laterClose = await mcp.call("agent_status", { name: "resume-parked-vs-closed" });
    await mcp.call("agent_close", { name: "resume-parked-vs-closed" });
    assert.ok(laterClose.agent_id !== parked.agent_id, "setup bug: expected two distinct rows");

    const receipt = await mcp.call("agent_resume", { name: "resume-parked-vs-closed" });
    assert.equal(receipt.agent_id, parked.agent_id, "the parked lane, not the more-recently-closed one");
    assert.ok(receipt.was_parked_at, "the receipt itself confirms which row this actually was");

    await mcp.call("agent_close", { agent_id: parked.agent_id });
  });

  it("resumes with the ORIGINAL binary path, not a bare \"claude\" resolved fresh from PATH (counselors, all three seats)", async () => {
    const absoluteClaude = fakeClaude();
    await mcp.call("agent_spawn", { name: "resume-binary", command: absoluteClaude });
    await liveAgentRow(mcp, "resume-binary");
    const beforeRow = await liveAgentRow(mcp, "resume-binary");
    await mcp.call("agent_close", { name: "resume-binary" });

    await mcp.call("agent_resume", { agent_id: beforeRow.agent_id });
    await liveAgentRow(mcp, "resume-binary");

    const row = db.prepare("SELECT command FROM agents WHERE id = ?").get(beforeRow.agent_id);
    assert.ok(
      row.command.startsWith(absoluteClaude),
      `resumed command should keep the original binary path: ${row.command}`,
    );
    assert.ok(row.command.includes("--resume"), `resumed command should carry --resume: ${row.command}`);

    await mcp.call("agent_close", { name: "resume-binary" });
  });

  it("resumes a wrapped command with its FULL PREFIX intact, not just the wrapper's own name (todo 521)", async () => {
    const absoluteClaude = fakeClaude();
    const wrapped = `nice ${absoluteClaude}`;
    await mcp.call("agent_spawn", { name: "resume-wrapped", command: wrapped });
    const beforeRow = await liveAgentRow(mcp, "resume-wrapped");
    await mcp.call("agent_close", { name: "resume-wrapped" });

    await mcp.call("agent_resume", { agent_id: beforeRow.agent_id });
    await liveAgentRow(mcp, "resume-wrapped");

    const row = db.prepare("SELECT command FROM agents WHERE id = ?").get(beforeRow.agent_id);
    assert.ok(
      row.command.startsWith(wrapped),
      `resumed command must keep the wrapper AND the original binary path, not just one token of it: ${row.command}`,
    );
    assert.ok(row.command.includes("--resume"), `resumed command should carry --resume: ${row.command}`);

    await mcp.call("agent_close", { name: "resume-wrapped" });
  });

  it("resets agent_state/state_changed_at on resume, so a wake cannot read a pre-close latch as the fresh worker's current state (counselors, opus)", async () => {
    await mcp.call("agent_spawn", { name: "resume-stale-state", command: fakeClaude() });
    await liveAgentRow(mcp, "resume-stale-state");
    const beforeRow = await liveAgentRow(mcp, "resume-stale-state");
    await mcp.call("agent_close", { name: "resume-stale-state" });

    db.prepare("UPDATE agents SET agent_state = 'idle', state_changed_at = '2020-01-01 00:00:00' WHERE id = ?").run(
      beforeRow.agent_id,
    );

    await mcp.call("agent_resume", { agent_id: beforeRow.agent_id });
    await liveAgentRow(mcp, "resume-stale-state");

    const row = db.prepare("SELECT agent_state, state_changed_at FROM agents WHERE id = ?").get(beforeRow.agent_id);
    assert.equal(row.agent_state, "unknown", "must not carry the pre-close latch onto the resumed row");
    assert.equal(row.state_changed_at, null);

    await mcp.call("agent_close", { name: "resume-stale-state" });
  });
});
