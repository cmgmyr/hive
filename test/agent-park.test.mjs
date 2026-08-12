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

// Issue #156 (todo 353 lane B). agent_park fills .claude/rules/tool-contract.md's
// RETIRE cell for agents - soft, reversible, still readable by id - where
// agent_close is Remove. A parked lane is a CLOSED row with parked_at set, never
// a third `status` value (D1: `status` is branched on in the janitor's sweeps,
// isLive, requireNameFree, idx_agents_running_name, agent_list, standingIdleRows
// and `hive status`, and an additive column is ignored by all of them by
// construction).
//
// EVERY ASSERTION HERE READS THE ROW OR THE COMMAND'S OWN OUTPUT, never only a
// receipt: a receipt is the handler's claim about itself, and this suite has
// already shipped a green run over a handler that returned {sent: true} without
// delivering anything (.claude/rules/tmux-and-panes.md).
const { hasTmux, cleanup } = isolateTmux("the agent_park tests");

const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { db } = await import("../dist/db.js");
const { sessionName, targetLive } = await import("../dist/tmux.js");
const { releaseParkRow } = await import("../dist/spawn.js");

let mcp;
let projectId;

// A REAL GIT CHECKOUT, because parked_branch is read with real `git rev-parse`
// and a fixture that stubbed it would prove nothing about the one fact this
// column exists to capture. Initialised on the project dir itself so the spawn
// stays inside the project hive resolved (.claude/rules/project-scoping.md);
// -b names the branch explicitly rather than depending on whatever this
// machine's init.defaultBranch happens to be, which is exactly the kind of
// one-machine assumption CI catches late.
// scratchGit, not a local execFileSync: it also neutralises a developer's
// global core.hooksPath, and the commit below runs inside before(), so a
// husky-style global hook would take the whole file down rather than one case.
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

    // THE PANE, READ BACK, and this assertion is the reason the file's header
    // claim is true rather than aspirational. Counselors (all three seats)
    // found that removing `if (live) killAgentPane(...)` from agent_park left
    // this entire file green: every other assertion here is a row or a
    // receipt, resume creates a fresh pane regardless of whether the old one
    // died, and isolateTmux's exit handler reports leftover SESSIONS, not
    // panes. So every park would have leaked a running claude nothing tracks,
    // with a green suite - the {sent: true} shape .claude/rules/tmux-and-
    // panes.md names by name and this file's own header disclaims.
    assert.equal(
      targetLive(live.tmux_target),
      false,
      "parking must actually end the pane, not just stamp the row",
    );

    // The ROW, not the receipt. A parked lane must be indistinguishable from
    // an ordinary close to every consumer that gates on `status` - that is
    // D1's whole argument - and distinguishable to anything that reads
    // parked_at.
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

    // The board line is the deliverable half of issue #156 ("anything the lead
    // has to remember to write down is a thing that gets skipped at 18:00 on a
    // Friday"), so it is asserted on content rather than on existence: a cold-
    // boot session needs which lane, on which branch, where, and the one call
    // that brings it back.
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

    // Written by the WORKER's actor_id, which is what a real lane produces by
    // following the runbook - the point of deriving rather than asking the
    // lead to pass it.
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

  it("refuses a non-claude worker rather than promising a resume that cannot happen", async () => {
    await mcp.call("agent_spawn", { name: "park-plain", command: "sleep", extra_args: ["600"] });
    const live = await liveAgentRow(mcp, "park-plain");

    await assert.rejects(mcp.call("agent_park", { name: "park-plain" }), /not a claude worker/);

    // REFUSED MEANS NOTHING HAPPENED. The pane must still be up and the row
    // still running - a park that killed the pane and then declined to stamp
    // the row would be the worst of both. Both halves asserted, because the
    // comment claimed both and only one was checked (counselors).
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
    // seedLeadRow, the shared fixture for exactly this shape (agent_rename and
    // wake_when_idle's lead guards use it). Its empty session_id does not
    // weaken the case: park's lead refusal runs before the session_id check.
    const id = seedLeadRow(db, projectId, dirs.projectDir);

    await assert.rejects(mcp.call("agent_park", { agent_id: id }), /is this project's lead session/);
    assert.equal(rowOf(id).parked_at, "");

    db.prepare("DELETE FROM agents WHERE id = ?").run(id);
  });

  it("refuses to park a worker whose worktree is already gone - park may not promise what resume will refuse", async () => {
    await mcp.call("agent_spawn", { name: "park-nocwd", command: fakeClaude() });
    const live = await liveAgentRow(mcp, "park-nocwd");

    // The case parked_branch exists for, reached from the wrong end. Without
    // this refusal the park SUCCEEDS and marks the lane resumable, branchAt has
    // nothing to read so it records '', and next morning agent_resume declines
    // with advice saying agent_park would have recorded a branch - which it did
    // run, and could not. The lead removed a worktree out from under a running
    // worker on 2026-08-11, so this is not hypothetical.
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

    // The message a lead hits FIRST the next morning, reaching for the worker
    // by the name it knows. It used to say "is closed. Spawn a new worker" -
    // the exact confusion issue #156 was filed about, produced by the feature
    // built to end it (counselors).
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

    // releaseParkRow directly, because the interleaving counselors named lives
    // INSIDE one agent_close call - findAgent reads the parked row, a
    // concurrent agent_resume flips it running and clears the stamp, and only
    // then does the release run. Driving agent_close from outside cannot
    // produce that ordering: by the time the resume has landed, findAgent sees
    // a RUNNING row and correctly takes the ordinary close path instead. The
    // guard is the write, so the write is what this tests.
    assert.equal(releaseParkRow(live.agent_id), true, "the ordinary case still releases");

    // Now the state the race leaves: running, stamp already cleared. An
    // unconditional UPDATE no-ops here and its caller answered
    // {closed: true, park_released: true} over a live worker.
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

    // The stale-state failure D4 exists to prevent, reached from inside the
    // feature: a parked_at left behind would make `hive status` report this
    // lane parked for the rest of the row's life.
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

    // The cwd is rewritten to a path that never existed rather than deleting
    // the real project dir out from under the running MCP server, which would
    // take the rest of this file with it. The condition under test is
    // existsSync(cwd) either way.
    const gone = `${dirs.projectDir}-removed-worktree`;
    assert.ok(!existsSync(gone), "setup bug: the missing-cwd path must really be missing");
    db.prepare("UPDATE agents SET cwd = ? WHERE id = ?").run(gone, live.agent_id);

    // The remedy has to be REACHABLE. Without parked_branch this could only
    // say "the directory is gone"; the whole return on that column is that the
    // error carries the line that fixes it. And it must not surface as Node's
    // own ENOENT, which names the BINARY rather than the missing cwd
    // (.claude/sessions/common-issues/enoent-names-the-binary-when-the-cwd-is-gone.md).
    await assert.rejects(mcp.call("agent_resume", { agent_id: live.agent_id }), (e) => {
      assert.match(e.message, /working directory is gone/);
      // One alternative, not two: the second used to subsume the first, so the
      // test did not actually pin that the RECORDED cwd reaches the command.
      assert.ok(e.message.includes(`git worktree add ${gone} park-branch`), e.message);
      assert.match(e.message, /park-branch/, "the recorded branch is what makes the remedy actionable");
      assert.ok(!/posix_spawn|\/bin\/sh/.test(e.message), "must not surface as an ENOENT naming a binary");
      return true;
    });

    db.prepare("UPDATE agents SET cwd = ? WHERE id = ?").run(dirs.projectDir, live.agent_id);
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

    // The distinction the issue says a next-morning lead cannot make today:
    // `closed` currently means both "this lane is done" and "this lane is
    // paused".
    assert.equal(parked.status, "closed");
    assert.equal(closed.status, "closed");
    assert.ok(parked.parked_at, "a parked lane says so");
    assert.equal(parked.parked_branch, "park-branch");
    assert.equal(closed.parked_at, undefined, "an ordinary close carries no park field at all");
  });
});
