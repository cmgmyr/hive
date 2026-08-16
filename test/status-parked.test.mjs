import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { assertScratchStore, clearHiveEnv, isolateTmux, runCli, scratchDirs } from "./helpers.mjs";

isolateTmux("the hive status parked-lane tests");

const { dataDir, projectDir } = scratchDirs();
clearHiveEnv();
process.env.HIVE_DATA_DIR = dataDir;
await assertScratchStore();

const { db, migrate } = await import("../dist/db.js");
migrate();

let projectCount = 0;
function seedProject() {

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

    assert.match(out.stdout, /parked {2}status-paused/);
    assert.ok(!out.stdout.includes("status-done"), "a finished lane is not a parked one");
  });

  it("says '(unrecorded)' rather than printing an empty branch column", async () => {
    const project = seedProject();
    const tmp = scratchDirs().tmp;
    seedParked(project, "status-nobranch", { branch: "" });

    const out = await runCli(["status"], { cwd: projectDir, dataDir, tmp });
    assert.equal(out.code, 0, out.stderr);

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
