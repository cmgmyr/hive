import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { McpClient, clearHiveEnv, isolateTmux, liveAgentRow, scratchDirs, scratchGit, until } from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("the spawn-cwd scope tests");

const { sessionName } = await import("../dist/tmux.js");

clearHiveEnv();

const unitRoot = realpathSync(mkdtempSync(join(tmpdir(), "hive-scope-unit-")));
process.env.HIVE_DATA_DIR = join(unitRoot, "data");
const { findProjectForDir, addProject, listProjects } = await import("../dist/context.js");
const { db, migrate } = await import("../dist/db.js");
migrate();

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

    assert.equal(findProjectForDir(worktree)?.id, registered.id);
  });

  it("(c) returns null for a directory that belongs to no registered project", () => {
    assert.equal(findProjectForDir(unregistered), null);
  });
});

describe("findProjectForDir: git-root vs a registered ancestor (issue #62)", () => {

  const gitInit = (dir) => {
    scratchGit(dir, "init", "-q");
    scratchGit(dir, "commit", "-q", "--allow-empty", "-m", "init");
  };

  const ancestorDir = mkdtempSync(join(unitRoot, "ancestor62-"));
  const ancestor = addProject(ancestorDir, "ancestor62");

  const repoDir = join(ancestorDir, "repo");
  mkdirSync(repoDir, { recursive: true });
  gitInit(repoDir);
  const repo = addProject(repoDir, "repo62");
  const worktreeDir = join(ancestorDir, "wt-outside-repo");
  scratchGit(repoDir, "worktree", "add", "-q", worktreeDir, "-b", "feature62");

  const worktreeSubdir = join(worktreeDir, "src", "deep");
  mkdirSync(worktreeSubdir, { recursive: true });

  it("(g) acceptance: a linked worktree outside its repo, under a registered ancestor, resolves to the repo's project - not the ancestor", () => {

    assert.equal(findProjectForDir(worktreeDir)?.id, repo.id);
    assert.equal(findProjectForDir(worktreeSubdir)?.id, repo.id);
  });

  const unrelatedRepoDir = mkdtempSync(join(unitRoot, "unrelated62-"));
  gitInit(unrelatedRepoDir);
  const unrelatedRepo = addProject(unrelatedRepoDir, "unrelated62");
  const wtInsideAncestor = join(ancestorDir, "wt-of-unrelated");
  scratchGit(unrelatedRepoDir, "worktree", "add", "-q", wtInsideAncestor, "-b", "feature62b");

  it("(h) control: a linked worktree of an unrelated repo, sitting inside a registered ancestor, resolves to the ancestor - not the unrelated repo", () => {

    assert.notEqual(unrelatedRepo.id, ancestor.id);

    assert.ok(unrelatedRepoDir.length > ancestorDir.length);
    assert.equal(findProjectForDir(wtInsideAncestor)?.id, ancestor.id);
  });

  const decoyDir = join(ancestorDir, "decoy-under-ancestor");
  mkdirSync(decoyDir, { recursive: true });
  const decoy = addProject(decoyDir, "decoy62");
  const sepGitDirCheckout = join(ancestorDir, "sep-git-dir-checkout");
  mkdirSync(sepGitDirCheckout);
  const externalGitDir = join(decoyDir, "sepgitdir62.git");
  scratchGit(sepGitDirCheckout, "init", "-q", `--separate-git-dir=${externalGitDir}`);
  scratchGit(sepGitDirCheckout, "commit", "-q", "--allow-empty", "-m", "init");

  it("(i) control: a --separate-git-dir checkout under a registered ancestor, not separately registered, is unchanged by this rule", () => {

    assert.notEqual(decoy.id, ancestor.id);
    assert.equal(findProjectForDir(sepGitDirCheckout)?.id, ancestor.id);
  });

  const unownedRepoDir = mkdtempSync(join(unitRoot, "unowned62-"));
  gitInit(unownedRepoDir);

  it("(j) control: a directory belonging to no registered project still returns null, even with a git repo of its own", () => {
    assert.equal(findProjectForDir(unownedRepoDir), null);
  });

  const orphanScratch = mkdtempSync(join(unitRoot, "orphan62-"));
  const orphanRepoDir = join(orphanScratch, "repo");
  mkdirSync(orphanRepoDir, { recursive: true });
  gitInit(orphanRepoDir);
  const orphanRepo = addProject(orphanRepoDir, "orphanrepo62");

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

    await assert.rejects(mcp.call("agent_spawn", { cwd: projB.path }), (err) => {
      assert.match(err.message, namedAs(projA));
      assert.match(err.message, namedAs(projB));
      return true;
    });

    assert.equal((await mcp.call("project_list")).projects.length, projectsBefore);

    assert.deepEqual((await mcp.call("agent_list")).agents, []);
    assert.deepEqual(
      (await mcp.call("agent_list", { project_id: projB.id })).agents,
      [],
    );
  });

  it("(f) tells a locked caller it cannot spawn outside its project, not to pass project_id", async () => {

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

  const pinRoot = mkdtempSync(join(unitRoot, "pin63-"));
  let nextAgentId = 950;

  function pinnedProject(name) {
    return addProject(mkdtempSync(join(pinRoot, `${name}-`)), name);
  }

  function unregisteredDir(name) {
    return mkdtempSync(join(pinRoot, `unreg-${name}-`));
  }

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

    assert.equal(listProjects().length, projectsBefore);

    assert.equal(todosTitled(project.id, "written-by-pinned-worker-m").length, 1);
  });

  it("(n) control: with NO HIVE_AGENT_ID at all (a lead, or any non-agent-kind process), a session in an unregistered cwd still registers a new project - unaffected by the pin mechanism", async () => {

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

    const pinnedElsewhere = pinnedProject("pin-n2-elsewhere");
    const actorId = insertAgentsRow(pinnedElsewhere.id, "running");
    const cwdProject = pinnedProject("pin-n2-cwd");
    const worker = workerClient(cwdProject.path, {
      HIVE_AGENT_ID: actorId,
      HIVE_AGENT_NAME: actorId,

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

    const registered = pinnedProject("pin-o-registered");
    const missingActorId = `agent:${nextAgentId++}`;
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

        env: { HIVE_PROJECT_PATH: "/tmp/forged-project-path-63", HIVE_PROJECT_LOCK: "0" },
        placement: "window",
        parentActor: "test:pin-clobber-63",
      });
      agentId = id;
    });

    after(() => {
      if (agentId != null) closeAgentRow(agentId);
      cleanup(sessionName());
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

      const dir = mkdtempSync(join(unitRoot, "pin-finding5-"));
      const project = addProject(dir, "pin-finding5");
      const originalPrepare = db.prepare.bind(db);
      db.prepare = (sql) => {

        if (sql.startsWith("UPDATE agents SET tmux_target = ?, tmux_socket = ?, pane_pid = ?")) {
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
      cleanup(sessionName());
    });
  },
);

describe(
  "agent_spawn allows a cwd inside the caller's own project",
  { skip: hasTmux ? false : "tmux is not installed" },
  () => {

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

      process.env.HIVE_DATA_DIR = dirs.dataDir;
      cleanup(sessionName());
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
