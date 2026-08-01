import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { McpClient, clearHiveEnv, isolateTmux, liveAgentRow, scratchDirs, scratchGit } from "./helpers.mjs";

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

describe("findProjectForDir: git-root vs a registered ancestor (issue #62)", () => {
  // The defect this pins: matchRegistered(dir) used to return as soon as it
  // hit, so a registered project that is a path ANCESTOR of dir shadowed
  // gitPrimaryRoot outright. A linked worktree sitting outside its own repo
  // checkout, but still under some broader registered project (e.g. a
  // home-directory project), resolved to that broader ancestor instead of
  // its own repo. These fixtures use a REAL linked git worktree - (b) above
  // has no .git in it and stays green even if gitPrimaryRoot is deleted
  // outright, which is why this defect survived a whole lane.
  const gitInit = (dir) => {
    scratchGit(dir, "init", "-q");
    scratchGit(dir, "commit", "-q", "--allow-empty", "-m", "init");
  };

  const ancestorDir = mkdtempSync(join(unitRoot, "ancestor62-"));
  const ancestor = addProject(ancestorDir, "ancestor62");

  // The worked example from the issue: the repo lives inside the ancestor's
  // tree, and its linked worktree sits at a sibling path also inside the
  // ancestor's tree but outside the repo checkout itself.
  const repoDir = join(ancestorDir, "repo");
  mkdirSync(repoDir, { recursive: true });
  gitInit(repoDir);
  const repo = addProject(repoDir, "repo62");
  const worktreeDir = join(ancestorDir, "wt-outside-repo");
  scratchGit(repoDir, "worktree", "add", "-q", worktreeDir, "-b", "feature62");
  // A subdirectory of the worktree, not just its top level - the shape a
  // real session actually sits in, and untouched by every fixture until
  // this one, all of which asserted only at a worktree's root.
  const worktreeSubdir = join(worktreeDir, "src", "deep");
  mkdirSync(worktreeSubdir, { recursive: true });

  it("(g) acceptance: a linked worktree outside its repo, under a registered ancestor, resolves to the repo's project - not the ancestor", () => {
    // Fails if the new git-preferred branch is taken NEVER (the old, buggy
    // behaviour): matchRegistered(worktreeDir) hits the ancestor first and
    // gitPrimaryRoot is never consulted, so this would return ancestor.id.
    assert.equal(findProjectForDir(worktreeDir)?.id, repo.id);
    assert.equal(findProjectForDir(worktreeSubdir)?.id, repo.id);
  });

  // Control: a linked worktree of an UNRELATED repo (registered as its own
  // project, but not nested under the ancestor at all) sitting inside the
  // ancestor's tree resolves to the ancestor, not the unrelated repo. This is
  // the cross-tree case the rule decides deliberately: the git-root project's
  // path is neither equal to, nor nested under, the direct match's path, so
  // containment says no and the direct match stands.
  const unrelatedRepoDir = mkdtempSync(join(unitRoot, "unrelated62-"));
  gitInit(unrelatedRepoDir);
  const unrelatedRepo = addProject(unrelatedRepoDir, "unrelated62");
  const wtInsideAncestor = join(ancestorDir, "wt-of-unrelated");
  scratchGit(unrelatedRepoDir, "worktree", "add", "-q", wtInsideAncestor, "-b", "feature62b");

  it("(h) control: a linked worktree of an unrelated repo, sitting inside a registered ancestor, resolves to the ancestor - not the unrelated repo", () => {
    // Fails if the new git-preferred branch is taken ALWAYS (ignoring
    // containment): gitPrimaryRoot(wtInsideAncestor) resolves into
    // unrelatedRepoDir, which is not under ancestorDir, so an unconditional
    // git-wins rule would pick unrelatedRepo instead of the ancestor.
    assert.notEqual(unrelatedRepo.id, ancestor.id);
    // This case is supposed to kill a length-based "prefer longer path"
    // rule too, but only does so as long as unrelatedRepoDir's path is
    // longer than ancestorDir's - true today because "unrelated62-" is one
    // character longer than "ancestor62-", by accident of naming, not by
    // anything this test asserts. Pin the precondition so a rename that
    // silently reverses the lengths fails loudly here instead of letting a
    // length-based rule pass this case unnoticed.
    assert.ok(unrelatedRepoDir.length > ancestorDir.length);
    assert.equal(findProjectForDir(wtInsideAncestor)?.id, ancestor.id);
  });

  // Control: a `git init --separate-git-dir=X` checkout (not a worktree),
  // not separately registered, living inside the ancestor's tree resolves to
  // the ancestor unchanged - the no-op-for-ordinary-checkouts property
  // asserted here rather than only argued in the code comment.
  //
  // This REPLACES an earlier version of this case that used a plain nested
  // checkout with no --separate-git-dir. That version could not fail for
  // ANY variant of the resolution rule: an ordinary checkout's git root is
  // an ancestor of dir by construction, so the direct-match scan and the
  // git-root scan land on the SAME registered project regardless of which
  // one the rule prefers - false-green shape 7 (test/CLAUDE.md), and this
  // repo's second time shipping it.
  //
  // The external gitdir is placed INSIDE a project registered UNDER the
  // ancestor (decoyDir, not just anywhere unregistered) so that the OLD,
  // buggy endsWith(".git") check produces a DIFFERENT, wrong, but still
  // real answer rather than accidentally falling back to the right one: an
  // external gitdir under an unregistered directory resolves to `null` and
  // falls through to `direct` regardless of the basename check, which does
  // not discriminate anything. Verified by hand before relying on it - see
  // todo 142.
  const decoyDir = join(ancestorDir, "decoy-under-ancestor");
  mkdirSync(decoyDir, { recursive: true });
  const decoy = addProject(decoyDir, "decoy62");
  const sepGitDirCheckout = join(ancestorDir, "sep-git-dir-checkout");
  mkdirSync(sepGitDirCheckout);
  const externalGitDir = join(decoyDir, "sepgitdir62.git");
  scratchGit(sepGitDirCheckout, "init", "-q", `--separate-git-dir=${externalGitDir}`);
  scratchGit(sepGitDirCheckout, "commit", "-q", "--allow-empty", "-m", "init");

  it("(i) control: a --separate-git-dir checkout under a registered ancestor, not separately registered, is unchanged by this rule", () => {
    // Fails under the old endsWith(".git") check (group B's regression pin):
    // --git-common-dir here is externalGitDir, which ends in ".git" but is
    // not sepGitDirCheckout's own .git and is not an ancestor of it. The
    // pre-fix code would dirname() it to decoyDir - a DIFFERENT registered
    // project nested under the ancestor, so the old containment check would
    // accept it as "more specific" and wrongly return decoy.id instead of
    // ancestor.id.
    assert.notEqual(decoy.id, ancestor.id);
    assert.equal(findProjectForDir(sepGitDirCheckout)?.id, ancestor.id);
  });

  // Control: a directory belonging to no registered project, even one with a
  // git repo of its own, still returns null.
  const unownedRepoDir = mkdtempSync(join(unitRoot, "unowned62-"));
  gitInit(unownedRepoDir);

  it("(j) control: a directory belonging to no registered project still returns null, even with a git repo of its own", () => {
    assert.equal(findProjectForDir(unownedRepoDir), null);
  });

  // Control: the `!direct` half of detectFromDir's git-preference check.
  // Every other case in this describe block has a non-null `direct` - (g),
  // (h) and (i) all sit under the registered ancestor - except (j), where
  // `direct` AND the git match are both null, so the disjunct is never
  // actually reached. Deleting `!direct ||` and every other case here still
  // passes; this is the only one that needs it: a repo's linked worktree
  // placed somewhere NO project is registered at all, where `direct` is
  // null but the git match is not.
  const orphanScratch = mkdtempSync(join(unitRoot, "orphan62-"));
  const orphanRepoDir = join(orphanScratch, "repo");
  mkdirSync(orphanRepoDir, { recursive: true });
  gitInit(orphanRepoDir);
  const orphanRepo = addProject(orphanRepoDir, "orphanrepo62");
  // Not mkdtempSync'd - `git worktree add` requires the target not to exist.
  const orphanWorktreeDir = join(orphanScratch, "wt");
  scratchGit(orphanRepoDir, "worktree", "add", "-q", orphanWorktreeDir, "-b", "feature-orphan62");

  it("(k) control: a linked worktree of a registered repo, placed where nothing else is registered, resolves to the repo (the null-direct branch)", () => {
    assert.equal(findProjectForDir(orphanWorktreeDir)?.id, orphanRepo.id);
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

  it("(l) refuses a cwd that is a linked worktree of a DIFFERENT project nested under the caller's own project - the new refusal issue #62 introduces", async () => {
    // Before issue #62's fix, a linked worktree outside its own repo but
    // still under some broader registered project (here, the caller's own
    // project A - dirs.projectDir) resolved to A, the SAME project as the
    // caller, so agent_spawn allowed it: both sides agreed. After the fix,
    // findProjectForDir(cwd) correctly resolves the worktree to the more
    // specific nested repo project instead of A, so this spawn is now
    // refused where it used to be allowed. That is correct under strict
    // scoping (CLAUDE.md's first invariant), but it is a new user-facing
    // failure this lane introduces, and nothing pinned it before this case:
    // (d) and (e) both refuse on a directly registered path, never on a
    // worktree.
    const nestedRepoDir = join(dirs.projectDir, "nested-repo");
    mkdirSync(nestedRepoDir, { recursive: true });
    scratchGit(nestedRepoDir, "init", "-q");
    scratchGit(nestedRepoDir, "commit", "-q", "--allow-empty", "-m", "init");
    const nestedRepo = await mcp.call("project_add", { path: nestedRepoDir, name: "nestedRepo62" });
    const nestedWorktreeDir = join(dirs.projectDir, "nested-repo-worktree");
    scratchGit(nestedRepoDir, "worktree", "add", "-q", nestedWorktreeDir, "-b", "feature-nested62");

    await assert.rejects(mcp.call("agent_spawn", { cwd: nestedWorktreeDir }), (err) => {
      assert.match(err.message, new RegExp(escapeRegex(nestedWorktreeDir)));
      assert.match(err.message, namedAs(projA));
      assert.match(err.message, namedAs(nestedRepo));
      assert.match(err.message, new RegExp(`project_id: ${nestedRepo.id}\\b`));
      return true;
    });
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
