import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { assertScratchStore, clearHiveEnv, isolateTmux, runCli, scratchDirs } from "./helpers.mjs";

// Issue #156, D4. A PARKED LANE IS LIVE STATE WITH NO RUNNING PROCESS, so it is
// invisible to every other query on `hive status`: the agents block is
// status='running' and a parked row is closed. The issue's own reason for this
// surface is that "a parked crew that only exists on the board goes stale the
// first time someone forgets", and the board is the one thing here no code
// maintains.
//
// No tmux is needed to make a parked row - it is closed, and the CLI reads it
// out of the store - but `hive status` calls janitor(), which does reach tmux,
// so this file isolates like every other file that can (test/CLAUDE.md).
isolateTmux("the hive status parked-lane tests");

const { dataDir, projectDir } = scratchDirs();
clearHiveEnv();
process.env.HIVE_DATA_DIR = dataDir;
await assertScratchStore();

const { db, migrate } = await import("../dist/db.js");
migrate();

let projectCount = 0;
function seedProject() {
  // projects.path is UNIQUE, so each test seeds its own.
  return db
    .prepare("INSERT INTO projects (name, path) VALUES ('status-parked-test', ?) RETURNING id")
    .get(`${projectDir}-${projectCount++}`).id;
}

function seedParked(projectId, name, { branch = "issue-156-park-resume", cwd = "/tmp/some-worktree" } = {}) {
  return db
    .prepare(
      `INSERT INTO agents (project_id, actor_id, name, tmux_target, command, cwd, status, kind,
         session_id, closed_at, parked_at, parked_branch)
       VALUES (?, ?, ?, '', 'claude', ?, 'closed', 'agent', 'a-session',
         datetime('now'), datetime('now'), ?) RETURNING id`,
    )
    .get(projectId, `agent:${name}`, name, cwd, branch).id;
}

describe("issue #156: `hive status` shows parked lanes", () => {
  it("prints a project whose ONLY content is a parked lane, with the branch, the cwd and the resume call", async () => {
    const project = seedProject();
    const tmp = scratchDirs().tmp;

    // THE BASELINE MATTERS AS MUCH AS THE RESULT. A project with no running
    // agents, no open todos and no pending wakes is skipped entirely by
    // cmdStatus's own `continue`, so without the parked count added to that
    // condition this whole surface would be unreachable for exactly the
    // project it exists for: an end-of-day crew, parked, with nothing else
    // running. Proving the empty case prints nothing first is what makes the
    // second assertion mean something.
    const empty = await runCli(["status"], { cwd: projectDir, dataDir, tmp });
    assert.equal(empty.code, 0, empty.stderr);
    assert.ok(!empty.stdout.includes("status-parked-test"), "setup bug: an empty project must print nothing");

    const id = seedParked(project, "t156-park-resume");

    const withParked = await runCli(["status"], { cwd: projectDir, dataDir, tmp });
    assert.equal(withParked.code, 0, withParked.stderr);
    assert.match(withParked.stdout, /parked {2}t156-park-resume/, "the lane is named and labelled parked");
    assert.match(withParked.stdout, /branch issue-156-park-resume/, "the branch is what recreates a removed worktree");
    assert.match(withParked.stdout, /\/tmp\/some-worktree/, "the cwd is where it goes");
    assert.match(
      withParked.stdout,
      new RegExp(`resume: agent_resume\\(agent_id: ${id}\\)`),
      "the one call that brings it back, so nothing has to be remembered",
    );
  });

  it("does not report an ordinarily closed worker as parked", async () => {
    const project = seedProject();
    const tmp = scratchDirs().tmp;

    db.prepare(
      `INSERT INTO agents (project_id, actor_id, name, tmux_target, command, cwd, status, kind, closed_at)
       VALUES (?, 'agent:status-done', 'status-done', '', 'claude', '/tmp/x', 'closed', 'agent', datetime('now'))`,
    ).run(project);
    seedParked(project, "status-paused");

    const out = await runCli(["status"], { cwd: projectDir, dataDir, tmp });
    assert.equal(out.code, 0, out.stderr);
    // The whole distinction issue #156 is about: `closed` today means both
    // "this lane is done" and "this lane is paused".
    assert.match(out.stdout, /parked {2}status-paused/);
    assert.ok(!out.stdout.includes("status-done"), "a finished lane is not a parked one");
  });

  it("says '(unrecorded)' rather than printing an empty branch column", async () => {
    const project = seedProject();
    const tmp = scratchDirs().tmp;
    seedParked(project, "status-nobranch", { branch: "" });

    const out = await runCli(["status"], { cwd: projectDir, dataDir, tmp });
    assert.equal(out.code, 0, out.stderr);
    // '' is this column's "no fact recorded" default (the convention
    // tmux_socket, pane_pid and session_id already set); printing it raw would
    // read as a blank branch NAME rather than as an absent fact.
    assert.match(out.stdout, /branch \(unrecorded\)/);
  });

  it("orders oldest first, so a lane parked weeks ago reads as the anomaly it is", async () => {
    const project = seedProject();
    const tmp = scratchDirs().tmp;

    const recent = seedParked(project, "parked-last-night");
    const old = seedParked(project, "parked-weeks-ago");
    db.prepare("UPDATE agents SET parked_at = datetime('now', '-21 days') WHERE id = ?").run(old);

    const out = await runCli(["status"], { cwd: projectDir, dataDir, tmp });
    assert.equal(out.code, 0, out.stderr);
    assert.ok(
      out.stdout.indexOf("parked-weeks-ago") < out.stdout.indexOf("parked-last-night"),
      "the stale one has to be the first thing read, not buried under last night's",
    );
    assert.ok(out.stdout.includes(`agent_id: ${recent}`), "and both are still listed");
  });
});
