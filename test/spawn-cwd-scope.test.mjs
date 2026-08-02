import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { McpClient, clearHiveEnv, isolateTmux, liveAgentRow, scratchDirs, scratchGit, until } from "./helpers.mjs";

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
const { findProjectForDir, addProject, listProjects } = await import("../dist/context.js");
const { db, migrate } = await import("../dist/db.js");
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

describe("a worker's project comes from its own agents row, guarded by HIVE_PROJECT_PATH (issue #63, fix round after counselors run 8)", () => {
  // Env-shaped pin, take one, validated only for EXISTENCE never IDENTITY:
  // counselors broke it two ways (id reuse across a rebuilt store; a reused
  // tmux pane inheriting a finished worker's project via pane-scoped `-e`
  // env). The row lookup fixes both - see resolveHomeProject's own comment
  // in src/context.ts for why each of the three cases below resolves the
  // way it does.
  //
  // These simulate the worker side of a spawn directly: a real `agents` row
  // inserted by hand (matching exactly what launchAgent's own INSERT
  // produces), then a McpClient started with the env launchAgent's
  // kind==="agent" branch builds (HIVE_AGENT_ID, HIVE_PROJECT_LOCK,
  // optionally HIVE_PROJECT_PATH) - rather than a real tmux pane. This is
  // the same store this file's top-level `db` already has open, so the
  // insert and the worker's own lookup share one on-disk database exactly
  // the way a real spawn and a real worker do. The actual env launchAgent
  // constructs is covered separately below, by a test that inspects a real
  // spawned process's environment.
  const pinRoot = mkdtempSync(join(unitRoot, "pin63-"));
  let nextAgentId = 950;

  function pinnedProject(name) {
    return addProject(mkdtempSync(join(pinRoot, `${name}-`)), name);
  }

  function unregisteredDir(name) {
    return mkdtempSync(join(pinRoot, `unreg-${name}-`));
  }

  // Mirrors launchAgent's own INSERT (src/spawn.ts) closely enough to stand
  // in for it: same table, same columns that matter here (project_id,
  // actor_id, status).
  function insertAgentsRow(projectId, status) {
    const actorId = `agent:${nextAgentId++}`;
    db.prepare("INSERT INTO actors (id, name, kind) VALUES (?, ?, 'agent')").run(actorId, actorId);
    db.prepare(
      "INSERT INTO agents (project_id, actor_id, name, command, cwd, status) VALUES (?, ?, ?, 'sleep', '/tmp', ?)",
    ).run(projectId, actorId, actorId, status);
    return actorId;
  }

  const pinnedDataDir = join(unitRoot, "data");
  const workerClient = (cwd, env) => new McpClient({ cwd, dataDir: pinnedDataDir, env });
  const todosTitled = (projectId, title) =>
    db.prepare("SELECT id FROM todos WHERE project_id = ? AND title = ?").all(projectId, title);

  it("(m) THE REGRESSION TEST: a worker with a RUNNING agents row resolves to that project, writes state there, and registers no new project", async () => {
    const project = pinnedProject("pin-m");
    const actorId = insertAgentsRow(project.id, "running");
    const projectsBefore = listProjects().length;
    const worker = workerClient(unregisteredDir("m"), {
      HIVE_AGENT_ID: actorId,
      HIVE_AGENT_NAME: actorId,
      HIVE_PROJECT_LOCK: "1",
    });
    await worker.start();
    try {
      await worker.call("todo_create", { title: "written-by-pinned-worker-m" });
    } finally {
      await worker.close();
    }
    // The bug's signature is a new projects row, not a worker that merely
    // "looks right" - assert the count, not just the write's destination.
    assert.equal(listProjects().length, projectsBefore);
    // And the write actually landed in the row's own project, not nowhere
    // and not some other project silently registered for the unregistered
    // cwd.
    assert.equal(todosTitled(project.id, "written-by-pinned-worker-m").length, 1);
  });

  it("(n) control: with NO HIVE_AGENT_ID at all (a lead, or any non-agent-kind process), a session in an unregistered cwd still registers a new project - unaffected by the pin mechanism", async () => {
    // agentProjectPin's guard clause is `if (!actorId || lock !== "1")
    // return null`, so this path never touches the agents table at all.
    // This is what (m) would look like if the row lookup fired for every
    // session rather than only ones with both HIVE_AGENT_ID and
    // HIVE_PROJECT_LOCK set - the answer this file's own history already
    // proved for the env-var version of this pin (issue #63's original
    // reproduction): an unregistered cwd registers.
    const dir = unregisteredDir("n");
    const projectsBefore = listProjects().length;
    const worker = workerClient(dir, {});
    await worker.start();
    let who;
    try {
      who = await worker.call("whoami");
    } finally {
      await worker.close();
    }
    assert.equal(listProjects().length, projectsBefore + 1);
    assert.equal(who.project.path, realpathSync(dir));
  });

  it("(n2) THE LOCK GATE ITSELF: HIVE_AGENT_ID set with NO HIVE_PROJECT_LOCK resolves from cwd and does not fail, even when a RUNNING row exists for that identity elsewhere", async () => {
    // The documented manual-identity pattern (README's Identity section:
    // "Set identity through environment variables when starting a worker
    // session: HIVE_AGENT_ID=worker-1 ... claude") is unlocked and was
    // never meant to carry a project pin - any session may claim an
    // identity without ever going through agent_spawn. Two existing tests
    // elsewhere in the suite (test/store.test.mjs's lease-conflict case,
    // test/todo-cli.test.mjs's actor-attribution case) already exercise
    // this pattern incidentally; this is the one that names the property
    // deliberately, and it is the strongest form of the check: a row DOES
    // exist and DOES name a project, so only the lock gate - not a missing
    // row - can be what stops it from winning.
    const pinnedElsewhere = pinnedProject("pin-n2-elsewhere");
    const actorId = insertAgentsRow(pinnedElsewhere.id, "running");
    const cwdProject = pinnedProject("pin-n2-cwd");
    const worker = workerClient(cwdProject.path, {
      HIVE_AGENT_ID: actorId,
      HIVE_AGENT_NAME: actorId,
      // Deliberately no HIVE_PROJECT_LOCK.
    });
    await worker.start();
    let who;
    try {
      who = await worker.call("whoami");
    } finally {
      await worker.close();
    }
    assert.equal(who.project.id, cwdProject.id);
  });

  it("(o) THE IMPORTANT CASE (codex P2): a missing agents row fails loudly even when the cwd IS a registered project", async () => {
    // Every OTHER bad-pin case in this describe sits in a fresh
    // unregistered directory. An implementation that falls back to cwd
    // whenever detectFromCwd() finds *anything* - not just on a genuinely
    // closed row - would keep every one of those green while silently
    // resolving here. This is the one case built specifically to catch
    // that: the cwd is registered, so a fallback would succeed quietly
    // instead of failing loudly.
    const registered = pinnedProject("pin-o-registered");
    const missingActorId = `agent:${nextAgentId++}`; // never inserted - no matching row
    const worker = workerClient(registered.path, {
      HIVE_AGENT_ID: missingActorId,
      HIVE_AGENT_NAME: missingActorId,
      HIVE_PROJECT_LOCK: "1",
    });
    await worker.start();
    try {
      await assert.rejects(worker.call("todo_list"), (err) => {
        assert.match(err.message, new RegExp(escapeRegex(missingActorId)));
        return true;
      });
    } finally {
      await worker.close();
    }
  });

  it("(o2) a missing-row failure is CACHED, not re-resolved as unset on a second call", async () => {
    // (o) makes exactly one call. Rewriting the cache as `return null`
    // (treating "already failed" the same as "unset") would leave that
    // test green while a real worker's SECOND call fell through and
    // registered its cwd - this calls the tool twice in the same worker and
    // checks the project count only after both.
    const dir = unregisteredDir("o2");
    const missingActorId = `agent:${nextAgentId++}`;
    const projectsBefore = listProjects().length;
    const worker = workerClient(dir, {
      HIVE_AGENT_ID: missingActorId,
      HIVE_AGENT_NAME: missingActorId,
      HIVE_PROJECT_LOCK: "1",
    });
    await worker.start();
    try {
      for (let call = 0; call < 2; call++) {
        await assert.rejects(worker.call("todo_list"), (err) => {
          assert.match(err.message, new RegExp(escapeRegex(missingActorId)));
          return true;
        });
      }
    } finally {
      await worker.close();
    }
    assert.equal(listProjects().length, projectsBefore);
  });

  it("(p) THE HEADLINE REGRESSION TEST: a running row whose project's path disagrees with HIVE_PROJECT_PATH fails loudly, naming both", async () => {
    // The defect the fix round exists to close: a bare id survives a
    // rebuilt store's reissued ids and would silently "agree" with a row
    // that now names a different project. HIVE_PROJECT_PATH is the guard
    // that catches it - a forged/stale path naming a DIFFERENT project than
    // the row actually resolves to, simulating a store swapped underneath a
    // live worker where the row survived but now points somewhere else.
    const real = pinnedProject("pin-p-real");
    const other = pinnedProject("pin-p-other");
    const actorId = insertAgentsRow(real.id, "running");
    const worker = workerClient(unregisteredDir("p"), {
      HIVE_AGENT_ID: actorId,
      HIVE_AGENT_NAME: actorId,
      HIVE_PROJECT_LOCK: "1",
      HIVE_PROJECT_PATH: other.path,
    });
    await worker.start();
    try {
      await assert.rejects(worker.call("todo_list"), (err) => {
        assert.match(err.message, new RegExp(escapeRegex(real.path)));
        assert.match(err.message, new RegExp(escapeRegex(other.path)));
        return true;
      });
    } finally {
      await worker.close();
    }
  });

  it("(q) a CLOSED agents row is treated as unset and falls through to cwd - the property that fixes a reused tmux pane inheriting a finished worker's project", async () => {
    const closed = pinnedProject("pin-q-closed");
    const actorId = insertAgentsRow(closed.id, "closed");
    // A DIFFERENT, freshly registered project as the cwd, so landing there
    // (rather than in the closed row's own project, and rather than a
    // thrown error) is unambiguous proof the closed row was ignored, not
    // consulted and not fatal.
    const reused = pinnedProject("pin-q-reused");
    const worker = workerClient(reused.path, {
      HIVE_AGENT_ID: actorId,
      HIVE_AGENT_NAME: actorId,
      HIVE_PROJECT_LOCK: "1",
    });
    await worker.start();
    try {
      await worker.call("todo_create", { title: "written-after-reuse-q" });
    } finally {
      await worker.close();
    }
    assert.equal(todosTitled(reused.id, "written-after-reuse-q").length, 1);
    assert.equal(todosTitled(closed.id, "written-after-reuse-q").length, 0);
  });

  it("(q2) THE FALSE-CLOSURE DEFECT (counselors run 9, finding 1): a closed row in an UNREGISTERED cwd resolves to the project HIVE_PROJECT_PATH still names, and registers no new project", async () => {
    // (q) proves the reused-pane property by landing in a DIFFERENT,
    // already-registered cwd. This proves the other half: the janitor closes
    // rows on a pane probe, not a process probe (tmux-and-panes.md), so the
    // SAME worker can still be alive in its ORIGINAL unregistered cwd when
    // its row goes closed underneath it. Falling through to (q)'s plain
    // "closed -> cwd" rule here would hit resolveHomeProject's own
    // registration fallback and re-create issue #63's own defect one level
    // up - a stray project, and HIVE_PROJECT_LOCK then locking the worker to
    // it. HIVE_PROJECT_PATH is exactly the fact that stops that: it still
    // names the real project, unlike cwd.
    const project = pinnedProject("pin-q2");
    const actorId = insertAgentsRow(project.id, "closed");
    const projectsBefore = listProjects().length;
    const worker = workerClient(unregisteredDir("q2"), {
      HIVE_AGENT_ID: actorId,
      HIVE_AGENT_NAME: actorId,
      HIVE_PROJECT_LOCK: "1",
      HIVE_PROJECT_PATH: project.path,
    });
    await worker.start();
    try {
      await worker.call("todo_create", { title: "written-after-false-closure-q2" });
    } finally {
      await worker.close();
    }
    assert.equal(listProjects().length, projectsBefore);
    assert.equal(todosTitled(project.id, "written-after-false-closure-q2").length, 1);
  });

  it("(q3) cwd still wins over HIVE_PROJECT_PATH on a closed row when both resolve - the reused-pane property is not shadowed by (q2)'s fallback", async () => {
    // Locks in the order inside the closed-row branch: cwd is checked BEFORE
    // HIVE_PROJECT_PATH. If that order were reversed, a human reusing a
    // closed worker's pane in a DIFFERENT, already-registered repo would land
    // back in the closed worker's project whenever the stale
    // HIVE_PROJECT_PATH happened to still be set - exactly the regression (q)
    // exists to prevent, just with the path guard now also in play.
    const closed = pinnedProject("pin-q3-closed");
    const actorId = insertAgentsRow(closed.id, "closed");
    const reused = pinnedProject("pin-q3-reused");
    const worker = workerClient(reused.path, {
      HIVE_AGENT_ID: actorId,
      HIVE_AGENT_NAME: actorId,
      HIVE_PROJECT_LOCK: "1",
      HIVE_PROJECT_PATH: closed.path,
    });
    await worker.start();
    try {
      await worker.call("todo_create", { title: "written-after-reuse-q3" });
    } finally {
      await worker.close();
    }
    assert.equal(todosTitled(reused.id, "written-after-reuse-q3").length, 1);
    assert.equal(todosTitled(closed.id, "written-after-reuse-q3").length, 0);
  });

  it("(q4) a closed row whose cwd AND whose HIVE_PROJECT_PATH both resolve to nothing fails loudly rather than falling through to registration", async () => {
    // Neither half of (q2)'s fix can answer here: cwd is unregistered (same
    // as (q2)) and the project's own directory is gone from disk (not the
    // FK-cascade case - the row survives, only the path stopped resolving).
    // "never register while HIVE_PROJECT_PATH is set" has to hold even when
    // HIVE_PROJECT_PATH itself is stale, or this is a silent registration
    // path with no test on it at all.
    const project = pinnedProject("pin-q4");
    const actorId = insertAgentsRow(project.id, "closed");
    const goneDir = unregisteredDir("q4-gone");
    rmSync(goneDir, { recursive: true, force: true });
    const projectsBefore = listProjects().length;
    const worker = workerClient(unregisteredDir("q4"), {
      HIVE_AGENT_ID: actorId,
      HIVE_AGENT_NAME: actorId,
      HIVE_PROJECT_LOCK: "1",
      HIVE_PROJECT_PATH: goneDir,
    });
    await worker.start();
    try {
      await assert.rejects(worker.call("todo_list"), (err) => {
        assert.match(err.message, new RegExp(escapeRegex(actorId)));
        assert.match(err.message, new RegExp(escapeRegex(goneDir)));
        return true;
      });
    } finally {
      await worker.close();
    }
    assert.equal(listProjects().length, projectsBefore);
  });

  it("(r) a blank HIVE_PROJECT_PATH is treated as unset, not compared as an empty-string mismatch", async () => {
    const project = pinnedProject("pin-r");
    const actorId = insertAgentsRow(project.id, "running");
    const worker = workerClient(unregisteredDir("r"), {
      HIVE_AGENT_ID: actorId,
      HIVE_AGENT_NAME: actorId,
      HIVE_PROJECT_LOCK: "1",
      HIVE_PROJECT_PATH: "   ",
    });
    await worker.start();
    try {
      const who = await worker.call("whoami");
      assert.equal(who.project.id, project.id);
    } finally {
      await worker.close();
    }
  });

  it("(s) a running, locked pin still refuses a different project's id and still allows its own - the pin does not weaken HIVE_PROJECT_LOCK", async () => {
    // Answers "what fails if the pin is applied but the lock is dropped":
    // were HIVE_PROJECT_LOCK not honoured alongside the row lookup, the
    // first assertion below would see the other project's todo_list
    // succeed instead of being refused.
    const home = pinnedProject("pin-s-home");
    const other = pinnedProject("pin-s-other");
    const actorId = insertAgentsRow(home.id, "running");
    const worker = workerClient(unregisteredDir("s"), {
      HIVE_AGENT_ID: actorId,
      HIVE_AGENT_NAME: actorId,
      HIVE_PROJECT_LOCK: "1",
    });
    await worker.start();
    try {
      await assert.rejects(worker.call("todo_list", { project_id: other.id }), (err) => {
        assert.match(err.message, new RegExp(`locked to project ${home.id}\\b`));
        return true;
      });
      // The home project - the one its row names - is still reachable.
      await worker.call("todo_list", { project_id: home.id });
    } finally {
      await worker.close();
    }
  });
});

describe(
  "launchAgent: HIVE_PROJECT_PATH and HIVE_PROJECT_LOCK cannot be overridden by spec.env",
  { skip: hasTmux ? false : "tmux is not installed" },
  () => {
    // Unlike the describe above, this goes straight at launchAgent (real
    // tmux, no MCP layer, and a REAL agents row from launchAgent's own
    // INSERT rather than a hand-inserted one) and inspects a spawned
    // process's ACTUAL environment, so it is the one test in this file that
    // would catch a regression in spawn.ts's env-block ordering
    // specifically - the row-lookup tests above cannot see it, since
    // agent_spawn's own tool never lets a caller supply spec.env in the
    // first place (it is always {}). This exercises launchAgent directly,
    // the way a future caller with a non-empty spec.env would.
    let launchAgent;
    let closeAgentRow;
    let pinProject;
    let envFile;
    let agentId;

    before(async () => {
      ({ launchAgent, closeAgentRow } = await import("../dist/spawn.js"));
      const pinProjectDir = mkdtempSync(join(unitRoot, "pinproj63-"));
      pinProject = addProject(pinProjectDir, "pinproj63");
      const envDumpDir = mkdtempSync(join(unitRoot, "envdump63-"));
      envFile = join(envDumpDir, "out.env");
      const commandString = `sh -c "env > ${envFile}; sleep 30"`;
      const { agentId: id } = launchAgent({
        projectId: pinProject.id,
        projectName: pinProject.name,
        projectPath: pinProject.path,
        name: "pin-clobber-63",
        kind: "agent",
        commandString,
        cwd: pinProject.path,
        // A caller trying to override the worker's own identity and scope -
        // exactly what the ordering fix in spawn.ts (spec.env spreads
        // FIRST) exists to stop. If that ordering regresses, this test
        // reads these bogus values back out of the spawned process's real
        // environment.
        env: { HIVE_PROJECT_PATH: "/tmp/forged-project-path-63", HIVE_PROJECT_LOCK: "0" },
        placement: "window",
        parentActor: "test:pin-clobber-63",
      });
      agentId = id;
    });

    after(() => {
      if (agentId != null) closeAgentRow(agentId);
      cleanup(sessionName(pinProject.id));
    });

    it("delivers the real project path and lock to the spawned process, not the caller-supplied override", async () => {
      let content;
      await until(() => {
        if (!existsSync(envFile)) return false;
        content = readFileSync(envFile, "utf8");
        return content.includes("HIVE_PROJECT_PATH=");
      }, 5000);
      assert.ok(content, `env dump never appeared at ${envFile}`);
      assert.match(content, new RegExp(`HIVE_PROJECT_PATH=${escapeRegex(pinProject.path)}$`, "m"));
      assert.match(content, /^HIVE_PROJECT_LOCK=1$/m);
      assert.doesNotMatch(content, /forged-project-path-63/);
    });

    it("(finding 5) a failure recording tmux_target after the pane already exists does NOT delete the agents row - the worker it already spawned stays reachable by actor_id", async () => {
      // The pane/window is created by respawn-pane/split-window/new-window,
      // not by the tmux_target UPDATE that follows - by the time that UPDATE
      // runs, a real process is already up with HIVE_AGENT_ID naming this
      // row baked into its env. Deleting the row here (the pre-fix rollback)
      // would strand a genuinely running worker whose own agentProjectPin()
      // lookup then finds no row at all and fails loudly for its whole life.
      // Simulates the SQLITE_BUSY class src/db.ts already retries for
      // elsewhere by making the UPDATE throw directly - the class of the
      // error is not what this test is about, only what launchAgent does
      // with it once the pane is already live.
      const dir = mkdtempSync(join(unitRoot, "pin-finding5-"));
      const project = addProject(dir, "pin-finding5");
      const originalPrepare = db.prepare.bind(db);
      db.prepare = (sql) => {
        if (sql === "UPDATE agents SET tmux_target = ?, tmux_socket = ? WHERE id = ?") {
          return {
            run: () => {
              throw new Error("SQLITE_BUSY: simulated for finding 5");
            },
          };
        }
        return originalPrepare(sql);
      };
      try {
        assert.throws(
          () =>
            launchAgent({
              projectId: project.id,
              projectName: project.name,
              projectPath: project.path,
              name: "finding5-worker",
              kind: "agent",
              commandString: "sleep 30",
              cwd: project.path,
              env: {},
              placement: "window",
              parentActor: "test:finding5",
            }),
          /SQLITE_BUSY/,
        );
      } finally {
        db.prepare = originalPrepare;
      }
      const row = originalPrepare("SELECT id, status, tmux_target FROM agents WHERE project_id = ? AND name = ?").get(
        project.id,
        "finding5-worker",
      );
      assert.ok(row, "the agents row must survive a late failure, not be deleted out from under a live pane");
      assert.equal(row.status, "running");
      assert.equal(row.tmux_target, "");
      closeAgentRow(row.id);
      cleanup(sessionName(project.id));
    });
  },
);

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
