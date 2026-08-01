import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { McpClient, clearHiveEnv, isolateTmux, liveAgentRow, scratchDirs } from "./helpers.mjs";

// Issue: agent_spawn resolves the worker's PROJECT from the spawner (or an
// explicit project_id) and never looks at args.cwd, but the worker itself
// resolves its own scope from its OWN cwd at runtime. A cwd naming another
// registered project's tree produces a worker whose brief names one project
// and whose actual scope is a different one (todo 136). The fix is a
// refusal, not a re-resolution: resolving the label from cwd would make
// agent_spawn a new cross-project write path. Most of this file's cases sit
// above launchAgent, before any tmux call, so they spawn no worker -
// isolateTmux is paired anyway per test/CLAUDE.md, since McpClient's server
// can reach tmux through other tools, and the allow-path case at the bottom
// genuinely does spawn one.
const { hasTmux, cleanup } = isolateTmux("the spawn-cwd scope tests");
// sessionName tags itself from HIVE_DATA_DIR at call time (read live, not at
// import), so it is safe to import here and call later once this process's
// HIVE_DATA_DIR is pointed at whichever scratch store actually spawned the
// session being cleaned up.
const { sessionName } = await import("../dist/tmux.js");

clearHiveEnv();
// db.js opens the store in its module body (src/db.ts), so HIVE_DATA_DIR has
// to be a scratch dir before the first import of anything that reaches it.
// A sibling directory, not one of the project fixtures below: the store and
// the projects it tracks are different things, and mixing them would make
// the store's own directory look like a project's subdirectory by accident.
const unitRoot = realpathSync(mkdtempSync(join(tmpdir(), "hive-scope-unit-")));
process.env.HIVE_DATA_DIR = join(unitRoot, "data");
const { findProjectForDir, addProject } = await import("../dist/context.js");
const { migrate } = await import("../dist/db.js");
migrate();

// Shared by every case below that asserts on an error message: a path built
// by mkdtempSync's prefix argument literally contains that prefix, so
// matching a bare project name against the whole message can pass "by
// construction" even when the code stopped naming the project at all -
// counselors' T2. Escaping and anchoring the name next to its id is what
// makes the assertion mean something the path cannot also supply.
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const namedAs = (project) => new RegExp(`"${escapeRegex(project.name)}" \\(id ${project.id}\\)`);

describe("findProjectForDir: the resolution rule the guard is built on", () => {
  const projA = mkdtempSync(join(unitRoot, "projA-"));
  const worktree = join(projA, "wt", "feature");
  mkdirSync(worktree, { recursive: true });
  const unregistered = mkdtempSync(join(unitRoot, "scratch-"));

  const registered = addProject(projA, "projA");

  it("(a) resolves a project's own root to itself", () => {
    assert.equal(findProjectForDir(projA)?.id, registered.id);
  });

  it("(b) resolves a subdirectory under a registered project to that project", () => {
    // No .git here, so this exercises matchRegistered's prefix match rather
    // than gitPrimaryRoot - the ordinary "worktree under the project root"
    // case the pad calls out as the one that must not regress.
    assert.equal(findProjectForDir(worktree)?.id, registered.id);
  });

  it("(c) returns null for a directory that belongs to no registered project", () => {
    assert.equal(findProjectForDir(unregistered), null);
  });
});

describe("agent_spawn refuses a cwd belonging to a different project", () => {
  const dirs = scratchDirs();
  let mcp;
  let projA;
  let projB;

  before(async () => {
    mcp = new McpClient({ cwd: dirs.projectDir, dataDir: dirs.dataDir });
    await mcp.start();
    projA = (await mcp.call("whoami")).project;
    const otherRoot = mkdtempSync(join(dirs.tmp, "projB-"));
    projB = await mcp.call("project_add", { path: otherRoot, name: "projB" });
  });

  after(async () => {
    await mcp.close();
    cleanup();
  });

  it("(d) refuses, naming both projects, the cwd, and how to do it deliberately", async () => {
    await assert.rejects(mcp.call("agent_spawn", { cwd: projB.path }), (err) => {
      assert.match(err.message, new RegExp(escapeRegex(projB.path)));
      assert.match(err.message, namedAs(projA));
      assert.match(err.message, namedAs(projB));
      assert.match(err.message, new RegExp(`project_id: ${projB.id}\\b`));
      return true;
    });
  });

  it("(e) registers no project and spawns no worker, in either project", async () => {
    const projectsBefore = (await mcp.call("project_list")).projects.length;

    // Asserted on the refusal itself, not only on what never happened
    // downstream: launchAgent deletes its own agents row on a failed spawn,
    // so "no agents row" alone is also true if the guard were removed
    // entirely and the pane just failed to come up for an unrelated reason
    // (counselors' P2-5). Naming both projects ties this failure to the
    // guard specifically.
    await assert.rejects(mcp.call("agent_spawn", { cwd: projB.path }), (err) => {
      assert.match(err.message, namedAs(projA));
      assert.match(err.message, namedAs(projB));
      return true;
    });

    // Non-registering, the load-bearing part: a guard that registers a new
    // project as a side effect of checking one would create rows for every
    // scratch directory anyone spawns into.
    assert.equal((await mcp.call("project_list")).projects.length, projectsBefore);
    // The refusal happens above launchAgent's INSERT: no half-built pane, no
    // agents row, in either project.
    assert.deepEqual((await mcp.call("agent_list")).agents, []);
    assert.deepEqual(
      (await mcp.call("agent_list", { project_id: projB.id })).agents,
      [],
    );
  });

  it("(f) tells a locked caller it cannot spawn outside its project, not to pass project_id", async () => {
    // A worker's project_id is not this session's to override: every worker
    // runs with HIVE_PROJECT_LOCK=1 (src/spawn.ts), and assertAccessible
    // refuses any project_id but the home one under it. Telling a locked
    // caller to "pass project_id" would just trade one refusal for another
    // (counselors' C2/P2-3).
    const lockedMcp = new McpClient({
      cwd: dirs.projectDir,
      dataDir: dirs.dataDir,
      env: { HIVE_PROJECT_LOCK: "1" },
    });
    await lockedMcp.start();
    try {
      await assert.rejects(lockedMcp.call("agent_spawn", { cwd: projB.path }), (err) => {
        assert.match(err.message, namedAs(projA));
        assert.match(err.message, namedAs(projB));
        assert.match(err.message, new RegExp(`locked to project ${projA.id}\\b`));
        assert.doesNotMatch(err.message, /Pass project_id/);
        return true;
      });
    } finally {
      await lockedMcp.close();
    }
  });
});

describe(
  "agent_spawn allows a cwd inside the caller's own project",
  { skip: hasTmux ? false : "tmux is not installed" },
  () => {
    // The ordinary case this whole guard exists not to break, and the one no
    // other case in this file exercises: every case above spawns nothing (a
    // refusal) or nothing at all (the resolver unit tests), so mutating the
    // guard's condition to refuse EVERY explicit cwd left them all green
    // while an everyday worktree spawn - the kind this project's own lanes
    // run constantly - would break completely. This is the negative control
    // for that (counselors' T1).
    const dirs = scratchDirs();
    let mcp;
    let projectId;

    before(async () => {
      mcp = new McpClient({ cwd: dirs.projectDir, dataDir: dirs.dataDir });
      await mcp.start();
      projectId = (await mcp.call("whoami")).project.id;
    });

    after(async () => {
      await mcp.close();
      // sessionName reads HIVE_DATA_DIR at call time; point it at this
      // describe's own store just for this lookup so cleanup targets the
      // session this describe actually created.
      process.env.HIVE_DATA_DIR = dirs.dataDir;
      cleanup(sessionName(projectId));
    });

    it("spawns a live worker when cwd is a subdirectory of the caller's own project", async () => {
      const worktree = join(dirs.projectDir, "worktrees", "lane-a");
      mkdirSync(worktree, { recursive: true });
      const receipt = await mcp.call("agent_spawn", {
        name: "same-project",
        command: "sleep",
        extra_args: ["600"],
        cwd: worktree,
      });
      assert.equal(receipt.name, "same-project");
      await liveAgentRow(mcp, "same-project");
      await mcp.call("agent_close", { name: "same-project" });
    });
  },
);
