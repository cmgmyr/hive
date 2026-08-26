import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import {
  isolateTmux,
  liveAgentRow,
  makeFakeClaude,
  McpClient,
  scratchDirs,
  scratchGit,
  seedLeadRow,
} from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("the agent_park tests");

const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { db } = await import("../dist/db.js");
const { sessionName, targetLive } = await import("../dist/tmux.js");
const { releaseParkRow } = await import("../dist/spawn.js");

let mcp;
let projectId;

const git = (...args) => scratchGit(dirs.projectDir, ...args);

before(async () => {
  git("init", "-b", "park-branch");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  git("commit", "--allow-empty", "-m", "root", "--no-gpg-sign");

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

const rowOf = (id) =>
  db.prepare("SELECT status, closed_at, parked_at, parked_branch FROM agents WHERE id = ?").get(id);

describe("agent_park", { skip: hasTmux ? false : "tmux is not installed" }, () => {
  it("parks a running claude worker: the row is closed AND stamped, and the branch is recorded", async () => {
    await mcp.call("agent_spawn", { name: "park-one", command: fakeClaude() });
    const live = await liveAgentRow(mcp, "park-one");

    const receipt = await mcp.call("agent_park", { name: "park-one" });
    assert.equal(receipt.parked, true);
    assert.equal(receipt.parked_branch, "park-branch");

    assert.equal(
      targetLive(live.tmux_target),
      false,
      "parking must actually end the pane, not just stamp the row",
    );

    const row = rowOf(live.agent_id);
    assert.equal(row.status, "closed", "a parked row must be CLOSED, not a third status value");
    assert.ok(row.closed_at, "a parked row still carries closed_at like any other closed row");
    assert.ok(row.parked_at, "parked_at is what tells a paused lane from a finished one");
    assert.equal(row.parked_branch, "park-branch");
  });

  it("hands back a board line carrying the branch, the cwd and the resume call", async () => {
    await mcp.call("agent_spawn", { name: "park-board", command: fakeClaude() });
    const live = await liveAgentRow(mcp, "park-board");

    const receipt = await mcp.call("agent_park", { name: "park-board" });

    assert.match(receipt.board_line, /^PARKED \d{4}-\d{2}-\d{2}/);
    assert.match(receipt.board_line, /park-board/);
    assert.match(receipt.board_line, /branch park-branch/);
    assert.ok(receipt.board_line.includes(dirs.projectDir), "the cwd is what makes the transcript resolvable");
    assert.match(receipt.board_line, new RegExp(`agent_resume\\(agent_id: ${live.agent_id}\\)`));
  });

  it("names the lane's todos on the board line, derived from todo_comments rather than a parameter (D2)", async () => {
    await mcp.call("agent_spawn", { name: "park-todos", command: fakeClaude() });
    const live = await liveAgentRow(mcp, "park-todos");
    const todo = await mcp.call("todo_create", { title: "the lane's own todo" });
    const otherProjectNoise = await mcp.call("todo_create", { title: "a todo nobody commented on" });

    db.prepare("INSERT INTO todo_comments (todo_id, author, body) VALUES (?, ?, 'worked on it')").run(
      todo.todo_id,
      live.actor_id,
    );

    const receipt = await mcp.call("agent_park", { name: "park-todos" });
    assert.deepEqual(receipt.todo_ids, [todo.todo_id]);
    assert.match(receipt.board_line, new RegExp(`todos ${todo.todo_id}`));
    assert.ok(
      !receipt.board_line.includes(`todos ${otherProjectNoise.todo_id}`),
      "only todos this actor actually commented on",
    );
  });

  it("refuses a worker on an unresumable harness rather than promising a resume that cannot happen", async () => {
    await mcp.call("agent_spawn", { name: "park-plain", command: "sleep", extra_args: ["600"] });
    const live = await liveAgentRow(mcp, "park-plain");

    await assert.rejects(mcp.call("agent_park", { name: "park-plain" }), /does not support resume/);

    assert.equal(rowOf(live.agent_id).status, "running");
    assert.equal(targetLive(live.tmux_target), true, "a refused park must leave the pane alone");
    await mcp.call("agent_close", { name: "park-plain" });
  });

  it("refuses a claude row with no recorded session id - the refusal belongs at 18:00, not at 09:00", async () => {
    const id = db
      .prepare(
        `INSERT INTO agents (project_id, actor_id, name, tmux_target, command, cwd, status, kind, session_id)
         VALUES (?, 'agent:park-legacy', 'park-legacy', '', 'claude', ?, 'running', 'agent', '') RETURNING id`,
      )
      .get(projectId, dirs.projectDir).id;

    await assert.rejects(mcp.call("agent_park", { agent_id: id }), /no recorded session id/);
    assert.equal(rowOf(id).parked_at, "", "a refused park must leave no stamp behind");

    db.prepare("DELETE FROM agents WHERE id = ?").run(id);
  });

  it("refuses a lead target - a parked lead would be a state with no way out of it", async () => {

    const id = seedLeadRow(db, projectId, dirs.projectDir);

    await assert.rejects(mcp.call("agent_park", { agent_id: id }), /is this project's lead session/);
    assert.equal(rowOf(id).parked_at, "");

    db.prepare("DELETE FROM agents WHERE id = ?").run(id);
  });

  it("refuses to park a worker whose worktree is already gone - park may not promise what resume will refuse", async () => {
    await mcp.call("agent_spawn", { name: "park-nocwd", command: fakeClaude() });
    const live = await liveAgentRow(mcp, "park-nocwd");

    const gone = `${dirs.projectDir}-park-nocwd-removed`;
    assert.ok(!existsSync(gone), "setup bug: the missing-cwd path must really be missing");
    db.prepare("UPDATE agents SET cwd = ? WHERE id = ?").run(gone, live.agent_id);

    await assert.rejects(mcp.call("agent_park", { name: "park-nocwd" }), /working directory is already gone/);
    const row = rowOf(live.agent_id);
    assert.equal(row.status, "running", "a refused park must leave the row alone");
    assert.equal(row.parked_at, "");
    assert.equal(targetLive(live.tmux_target), true, "and the pane alone - the comment claims both");

    db.prepare("UPDATE agents SET cwd = ? WHERE id = ?").run(dirs.projectDir, live.agent_id);
    await mcp.call("agent_close", { name: "park-nocwd" });
  });

  it("tells a next-morning lead its lane is PARKED, not that it should spawn a replacement", async () => {
    await mcp.call("agent_spawn", { name: "park-namehint", command: fakeClaude() });
    const live = await liveAgentRow(mcp, "park-namehint");
    await mcp.call("agent_park", { name: "park-namehint" });

    await assert.rejects(mcp.call("agent_status", { name: "park-namehint" }), (e) => {
      assert.match(e.message, /is PARKED/);
      assert.match(e.message, new RegExp(`agent_resume\\(agent_id: ${live.agent_id}\\)`));
      assert.ok(!/Spawn a new worker/.test(e.message), "must not advise replacing a lane that is waiting");
      return true;
    });
  });

  it("the park release refuses a row a concurrent resume already took back, rather than reporting it closed", async () => {
    await mcp.call("agent_spawn", { name: "park-releaserace", command: fakeClaude() });
    const live = await liveAgentRow(mcp, "park-releaserace");
    await mcp.call("agent_park", { name: "park-releaserace" });

    assert.equal(releaseParkRow(live.agent_id), true, "the ordinary case still releases");

    await mcp.call("agent_resume", { name: "park-releaserace" });
    assert.equal(
      releaseParkRow(live.agent_id),
      false,
      "a row that is running again must not be reported as released",
    );
    assert.equal(rowOf(live.agent_id).status, "running");

    await mcp.call("agent_close", { name: "park-releaserace" });
  });

  it("agent_resume clears the park stamp, so a resumed lane stops reporting as parked", async () => {
    await mcp.call("agent_spawn", { name: "park-cycle", command: fakeClaude() });
    const live = await liveAgentRow(mcp, "park-cycle");
    await mcp.call("agent_park", { name: "park-cycle" });
    assert.ok(rowOf(live.agent_id).parked_at, "setup bug: the park must have stamped the row");

    const receipt = await mcp.call("agent_resume", { name: "park-cycle" });
    assert.ok(receipt.was_parked_at, "the receipt tells a parked resume from an ordinary one");

    const row = rowOf(live.agent_id);
    assert.equal(row.status, "running");
    assert.equal(row.parked_at, "", "resume must clear the stamp");
    assert.equal(row.parked_branch, "", "both columns move together - parked_at is what every reader gates on");

    await mcp.call("agent_close", { name: "park-cycle" });
  });

  it("agent_close on a PARKED row releases the stamp, so an abandoned park cannot go stale forever", async () => {
    await mcp.call("agent_spawn", { name: "park-abandon", command: fakeClaude() });
    const live = await liveAgentRow(mcp, "park-abandon");
    await mcp.call("agent_park", { name: "park-abandon" });

    const receipt = await mcp.call("agent_close", { agent_id: live.agent_id });
    assert.equal(receipt.park_released, true);

    const row = rowOf(live.agent_id);
    assert.equal(row.status, "closed", "the row ends up exactly where an ordinary close leaves one");
    assert.equal(row.parked_at, "");
  });

  it("agent_resume refuses a removed worktree and names the git command that rebuilds it", async () => {
    await mcp.call("agent_spawn", { name: "park-gone", command: fakeClaude() });
    const live = await liveAgentRow(mcp, "park-gone");
    await mcp.call("agent_park", { name: "park-gone" });

    const gone = `${dirs.projectDir}-removed-worktree`;
    assert.ok(!existsSync(gone), "setup bug: the missing-cwd path must really be missing");
    db.prepare("UPDATE agents SET cwd = ? WHERE id = ?").run(gone, live.agent_id);

    await assert.rejects(mcp.call("agent_resume", { agent_id: live.agent_id }), (e) => {
      assert.match(e.message, /working directory is gone/);

      assert.ok(e.message.includes(`git worktree add ${gone} park-branch`), e.message);
      assert.match(e.message, /park-branch/, "the recorded branch is what makes the remedy actionable");
      assert.ok(!/posix_spawn|\/bin\/sh/.test(e.message), "must not surface as an ENOENT naming a binary");
      return true;
    });

    db.prepare("UPDATE agents SET cwd = ? WHERE id = ?").run(dirs.projectDir, live.agent_id);
  });

  it("reports parked:true, not a denial, when a concurrent agent_park already parked the row first", async () => {
    await mcp.call("agent_spawn", { name: "park-already-parked", command: fakeClaude() });
    const live = await liveAgentRow(mcp, "park-already-parked");

    db.prepare(
      `UPDATE agents SET status = 'closed', closed_at = datetime('now'), parked_at = datetime('now'),
         parked_branch = 'raced-in-by-a-concurrent-park' WHERE id = ?`,
    ).run(live.agent_id);

    const receipt = await mcp.call("agent_park", { agent_id: live.agent_id });
    assert.equal(receipt.parked, true, "the row IS parked - just not by this call");
    assert.equal(receipt.parked_branch, "raced-in-by-a-concurrent-park", "the racer's branch, not this call's own");
    assert.match(receipt.note, /Already parked by a concurrent agent_park/);
    assert.ok(receipt.board_line, "the board line is still owed - the caller still needs it to resume the lane");
  });

  it("refuses honestly when an ordinary agent_close, not a park, already retired the row", async () => {
    await mcp.call("agent_spawn", { name: "park-already-closed", command: fakeClaude() });
    const live = await liveAgentRow(mcp, "park-already-closed");

    db.prepare("UPDATE agents SET status = 'closed', closed_at = datetime('now') WHERE id = ?").run(live.agent_id);

    await assert.rejects(mcp.call("agent_park", { agent_id: live.agent_id }), (e) => {
      assert.match(e.message, /was closed by someone else, not parked/);
      assert.match(e.message, /no recorded branch through this call/);
      return true;
    });
    assert.equal(rowOf(live.agent_id).parked_at, "", "the row really is unparked - the refusal did not lie either");
  });

  it("agent_list(include_closed) reports a parked lane as parked and an ordinary close as not", async () => {
    await mcp.call("agent_spawn", { name: "park-listed", command: fakeClaude() });
    await liveAgentRow(mcp, "park-listed");
    await mcp.call("agent_park", { name: "park-listed" });

    await mcp.call("agent_spawn", { name: "park-notlisted", command: fakeClaude() });
    await liveAgentRow(mcp, "park-notlisted");
    await mcp.call("agent_close", { name: "park-notlisted" });

    const agents = (await mcp.call("agent_list", { include_closed: true })).agents;
    const parked = agents.find((a) => a.name === "park-listed");
    const closed = agents.find((a) => a.name === "park-notlisted");

    assert.equal(parked.status, "closed");
    assert.equal(closed.status, "closed");
    assert.ok(parked.parked_at, "a parked lane says so");
    assert.equal(parked.parked_branch, "park-branch");
    assert.equal(closed.parked_at, undefined, "an ordinary close carries no park field at all");
  });
});
