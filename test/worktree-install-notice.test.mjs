import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { clearHiveEnv, isolateTmux, makeFakeClaude, McpClient, scratchDirs, scratchGit } from "./helpers.mjs";

// Todo 406, option B only (see plan-406-worktree-backstop / pad 155 for the
// scope cut): agent_spawn's spawn-time backstop for a fresh git worktree
// that hive.yml declares an install command for. Detection only - nothing
// here ever runs vars.install; option A (a `hive worktree` verb that DOES)
// is a separate, larger decision and stays out of this lane.

const { hasTmux, cleanup } = isolateTmux("the worktree-install-notice tests");

clearHiveEnv();
// db.js opens the store in its module body, so HIVE_DATA_DIR must be a
// scratch dir before the first import of anything that reaches it (both
// context.js and tools/agents.js do).
const unitRoot = realpathSync(mkdtempSync(join(tmpdir(), "hive-worktree-notice-unit-")));
process.env.HIVE_DATA_DIR = join(unitRoot, "data");
const { isLinkedWorktree, linkedWorktreePrimaryRoot } = await import("../dist/context.js");
const { worktreeInstallNotice } = await import("../dist/tools/agents.js");
const { migrate } = await import("../dist/db.js");
migrate();

function gitInit(dir) {
  scratchGit(dir, "init", "-q");
  scratchGit(dir, "commit", "-q", "--allow-empty", "-m", "init");
}

describe("isLinkedWorktree: the predicate the backstop keys on", () => {
  const primary = mkdtempSync(join(unitRoot, "primary-"));
  gitInit(primary);
  const sub = join(primary, "sub", "dir");
  mkdirSync(sub, { recursive: true });
  // Not mkdtempSync'd - `git worktree add` requires the target not to exist.
  const siblingWorktree = join(unitRoot, "sibling-worktree");
  scratchGit(primary, "worktree", "add", "-q", siblingWorktree, "-b", "feature406-sibling");
  // THE LAYOUT THIS PROJECT ITSELF USES, AND THE CASE THE FIRST VERSION OF
  // THIS PREDICATE GOT WRONG: a worktree cut INSIDE the primary checkout,
  // at .claude/worktrees/<slug>, exactly like this project's own runbook.
  // A version keyed on "is dir an ancestor-or-self of the primary root"
  // (the sibling-comparison version this lane shipped first, then had to
  // replace) reads this as an ordinary checkout, because the primary root
  // genuinely IS an ancestor of a nested worktree too - that was the actual
  // defect, reproduced here rather than only described.
  const nestedWorktree = join(primary, ".claude", "worktrees", "feature406-nested");
  mkdirSync(join(primary, ".claude", "worktrees"), { recursive: true });
  scratchGit(primary, "worktree", "add", "-q", nestedWorktree, "-b", "feature406-nested");
  const nonGit = mkdtempSync(join(unitRoot, "non-git-"));

  it("is false for the primary checkout's own root", () => {
    // MUTATION: dropping the `dirs.gitDir !== dirs.commonDir` comparison
    // and returning `dirs !== null` alone flips this to true, since an
    // ordinary checkout's git-dir and common-dir both resolve (to the same
    // path, which is exactly what the dropped comparison was checking).
    assert.equal(isLinkedWorktree(primary), false);
  });

  it("is false for an ordinary subdirectory of the primary checkout", () => {
    assert.equal(isLinkedWorktree(sub), false);
  });

  it("is true for a sibling linked worktree (cut outside the primary checkout)", () => {
    assert.equal(isLinkedWorktree(siblingWorktree), true);
  });

  it("is true for a NESTED linked worktree (cut inside the primary checkout, this project's own layout) - the regression case", () => {
    // This is the case that must go red against the version this lane
    // shipped first (49e77ea): that version compared dir's path against
    // gitPrimaryRoot's answer, and the primary root IS an ancestor of a
    // nested worktree, so it read every worktree this project actually
    // creates as "not a worktree" and the notice never fired.
    assert.equal(isLinkedWorktree(nestedWorktree), true);
  });

  it("is false for a directory with no git repo at all", () => {
    // MUTATION: dropping the `dirs !== null &&` guard makes this line read
    // `dirs.gitDir !== dirs.commonDir` unconditionally, which throws a
    // TypeError on `dirs` being null rather than silently misclassifying -
    // this call still fails the test, just via a throw instead of a wrong
    // boolean.
    assert.equal(isLinkedWorktree(nonGit), false);
  });

  // COUNSELORS ROUND, FIX 3. Measured directly (see gitDirs's own comment):
  // `git rev-parse` honours GIT_DIR/GIT_COMMON_DIR/GIT_WORK_TREE over
  // discovery-from-cwd when any is inherited from the calling process. Both
  // directions are real and both are exercised here, not just one.
  describe("is unaffected by ambient GIT_DIR / GIT_COMMON_DIR / GIT_WORK_TREE", () => {
    const savedEnv = {
      GIT_DIR: process.env.GIT_DIR,
      GIT_COMMON_DIR: process.env.GIT_COMMON_DIR,
      GIT_WORK_TREE: process.env.GIT_WORK_TREE,
    };
    after(() => {
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });

    it("does not misreport an ordinary checkout as linked when GIT_DIR names a worktree's own gitdir", () => {
      // MUTATION: dropping the env-stripping in gitDirs makes this pass -
      // measured live: `git -C primary rev-parse --git-dir --git-common-dir`
      // with GIT_DIR set to the worktree's private gitdir prints the
      // worktree's gitdir and the primary's commondir, gitDir !== commonDir,
      // primary misreports as a linked worktree of itself.
      // git names the admin dir under .git/worktrees/ after the worktree's
      // OWN directory basename, not the branch name - measured live.
      process.env.GIT_DIR = join(primary, ".git", "worktrees", basename(siblingWorktree));
      delete process.env.GIT_COMMON_DIR;
      delete process.env.GIT_WORK_TREE;
      assert.equal(isLinkedWorktree(primary), false);
    });

    it("does not misreport a real linked worktree as ordinary when GIT_DIR names the primary's own .git", () => {
      // MUTATION: same as above, opposite direction - measured live: with
      // GIT_DIR set to the primary checkout's own .git, both outputs come
      // back identical regardless of cwd, so a genuine worktree misreports
      // as an ordinary checkout.
      process.env.GIT_DIR = join(primary, ".git");
      delete process.env.GIT_COMMON_DIR;
      delete process.env.GIT_WORK_TREE;
      assert.equal(isLinkedWorktree(siblingWorktree), true);
    });
  });
});

describe("worktreeInstallNotice: what the spawn receipt says, and when it says nothing", () => {
  const primary = mkdtempSync(join(unitRoot, "notice-primary-"));
  gitInit(primary);
  const worktree = join(unitRoot, "notice-worktree");
  scratchGit(primary, "worktree", "add", "-q", worktree, "-b", "feature406b");
  // A SECOND, genuinely unrelated repo - fix 2's shape: a linked worktree of
  // THIS repo, so worktreeInstallNotice(worktreeOfOther, primary, ...) must
  // say nothing even though `worktree` above would say something for the
  // identical config, because the config belongs to `primary`, not to
  // whatever repo cwd's own worktree is linked to.
  const otherRepo = mkdtempSync(join(unitRoot, "notice-other-repo-"));
  gitInit(otherRepo);
  const worktreeOfOther = join(unitRoot, "notice-worktree-of-other");
  scratchGit(otherRepo, "worktree", "add", "-q", worktreeOfOther, "-b", "feature406c");
  const withInstall = { vars: { install: "npm install && npm run build" } };
  const noInstallKey = { vars: { repo: "cmgmyr/hive" } };

  it("names the declared command for a linked worktree whose project declares one", () => {
    assert.equal(worktreeInstallNotice(worktree, primary, withInstall), "npm install && npm run build");
  });

  it("says nothing for the primary checkout, even when the project declares an install command", () => {
    // MUTATION: dropping the linkedWorktreePrimaryRoot(cwd) check and
    // returning `install` whenever it is declared fires this on EVERY spawn
    // into the primary checkout too - exactly the noise the plan warns
    // turns the notice into something a lead learns to skip.
    assert.equal(worktreeInstallNotice(primary, primary, withInstall), undefined);
  });

  it("says nothing for a linked worktree whose project declares no install command", () => {
    // MUTATION: reading a different field (e.g. config?.install instead of
    // config?.vars?.install) makes this pass `undefined` through as a
    // truthy-looking value or throws; either way this case stops meaning
    // "declares nothing".
    assert.equal(worktreeInstallNotice(worktree, primary, noInstallKey), undefined);
  });

  it("says nothing when hive.yml itself is absent (config is null)", () => {
    assert.equal(worktreeInstallNotice(worktree, primary, null), undefined);
  });

  // COUNSELORS ROUND, FIX 1 + FIX 4. codex measured `vars: {install: "   "}`
  // shipping a present-but-blank receipt field, and separately measured that
  // the earlier version's "install guard" mutation SURVIVED every existing
  // test: an ABSENT key already reads `undefined` whether or not the guard
  // exists, so nothing before this pinned the guard doing anything. These
  // two cases are what actually depends on it - a value with characters that
  // are all whitespace, or no characters at all - which the guard rejects
  // and an absent key cannot distinguish it from.
  it("says nothing when vars.install has no non-whitespace characters", () => {
    // MUTATION: removing `?.trim()` and the `if (!install)` guard entirely
    // lets "   " flow through unchanged - `!"   "` is false in JS, so a
    // bare truthiness check alone (the pre-fix-1 shape) already shipped this
    // exact string as the receipt field.
    assert.equal(worktreeInstallNotice(worktree, primary, { vars: { install: "   " } }), undefined);
  });

  it("says nothing when vars.install is the empty string", () => {
    // MUTATION (codex's "drop install guard: SURVIVED"): removing the
    // `if (!install) return undefined` guard lets "" flow through to the
    // primaryRoot check and, for a genuinely linked worktree, come out the
    // other side as the return value instead of undefined - unlike an
    // ABSENT key, which reads undefined identically with or without the
    // guard and so cannot catch its removal.
    assert.equal(worktreeInstallNotice(worktree, primary, { vars: { install: "" } }), undefined);
  });

  it("trims the declared command before it reaches the receipt", () => {
    assert.equal(
      worktreeInstallNotice(worktree, primary, { vars: { install: "  npm install  " } }),
      "npm install",
    );
  });

  // COUNSELORS ROUND, FIX 2. cwd is a genuine linked worktree - just not of
  // `primary`, the project supplying `config`. Measured against a real
  // fixture shaped like test/spawn-cwd-scope.test.mjs case (h): a linked
  // worktree of an unrelated repo can resolve to a CONTAINING project for
  // store purposes while its own files belong elsewhere; this asserts the
  // notice does not attribute the containing project's install command to
  // it.
  it("says nothing for a linked worktree of a DIFFERENT repo than the one supplying config", () => {
    // MUTATION: comparing `findProjectForDir(cwd)` instead of
    // `linkedWorktreePrimaryRoot(cwd)` against projectPath does NOT catch
    // this - measured directly against case (h)'s own fixture shape
    // (recorded on todo 406): findProjectForDir resolves a nested foreign
    // worktree to the CONTAINING project by design (project-scoping.md's
    // accepted containment residual), which is the same project supplying
    // config here, so that comparison is true in exactly the case this test
    // exists to catch.
    assert.equal(worktreeInstallNotice(worktreeOfOther, primary, withInstall), undefined);
  });
});

describe(
  "agent_spawn's receipt: the backstop wired end to end",
  { skip: hasTmux ? false : "tmux is not installed" },
  () => {
    const dirs = scratchDirs();
    const fakeClaude = makeFakeClaude(dirs.tmp);
    let mcp;
    let session;

    before(async () => {
      gitInit(dirs.projectDir);
      writeFileSync(join(dirs.projectDir, "hive.yml"), "vars:\n  install: npm install && npm run build\n");
      mcp = new McpClient({
        cwd: dirs.projectDir,
        dataDir: dirs.dataDir,
        env: { HIVE_SPAWN_READY_MS: "500" },
      });
      await mcp.start();
      // sessionName() tags itself from HIVE_DATA_DIR read live at call time,
      // not this process's own store (still pointed at unitRoot/data above,
      // used only by the two describes that import dist/ modules directly)
      // - it has to name the SPAWNED server's own store for cleanup to find
      // the right session.
      const { sessionName } = await import("../dist/tmux.js");
      const savedDataDir = process.env.HIVE_DATA_DIR;
      process.env.HIVE_DATA_DIR = dirs.dataDir;
      session = sessionName();
      process.env.HIVE_DATA_DIR = savedDataDir;
    });

    after(async () => {
      await mcp.close();
      cleanup(session);
    });

    it("names the declared command when cwd is a fresh, sibling worktree", async () => {
      const worktreeDir = join(dirs.tmp, "wt-fresh");
      scratchGit(dirs.projectDir, "worktree", "add", "-q", worktreeDir, "-b", "wt-fresh-406");
      const receipt = await mcp.call("agent_spawn", {
        name: "wt-fresh-worker",
        command: fakeClaude("sleep 600"),
        cwd: worktreeDir,
      });
      assert.equal(receipt.worktree_install, "npm install && npm run build");
    });

    it("names the declared command when cwd is a NESTED worktree - this project's own .claude/worktrees/<slug> layout", async () => {
      const nestedDir = join(dirs.projectDir, ".claude", "worktrees", "wt-nested-406");
      mkdirSync(join(dirs.projectDir, ".claude", "worktrees"), { recursive: true });
      scratchGit(dirs.projectDir, "worktree", "add", "-q", nestedDir, "-b", "wt-nested-406");
      const receipt = await mcp.call("agent_spawn", {
        name: "wt-nested-worker",
        command: fakeClaude("sleep 600"),
        cwd: nestedDir,
      });
      assert.equal(receipt.worktree_install, "npm install && npm run build");
    });

    it("says nothing when cwd is the primary checkout (spawn still succeeds)", async () => {
      const receipt = await mcp.call("agent_spawn", {
        name: "primary-worker",
        command: fakeClaude("sleep 600"),
      });
      assert.equal(receipt.worktree_install, undefined);
      assert.equal(typeof receipt.agent_id, "number");
    });

    it("says nothing for a worktree whose project declares no install command", async () => {
      const bareRepo = mkdtempSync(join(dirs.tmp, "bare-repo-"));
      gitInit(bareRepo);
      // No hive.yml at all. project_add registers it deliberately, so the
      // cross-project cwd guard (src/tools/agents.ts) is satisfied by
      // project_id rather than by this test tripping over an unrelated
      // refusal.
      const bareProject = await mcp.call("project_add", { path: bareRepo, name: "bare406" });
      const bareWorktree = join(dirs.tmp, "bare-worktree");
      scratchGit(bareRepo, "worktree", "add", "-q", bareWorktree, "-b", "bare-wt-406");
      const receipt = await mcp.call("agent_spawn", {
        name: "bare-worker",
        command: fakeClaude("sleep 600"),
        cwd: bareWorktree,
        project_id: bareProject.id,
      });
      assert.equal(receipt.worktree_install, undefined);
    });

    // COUNSELORS ROUND, FIX 2, END TO END. The exact motivating shape: a
    // linked worktree of an UNRELATED repo nested inside the spawning
    // project's own directory tree, no project_id override - matching
    // test/spawn-cwd-scope.test.mjs case (h)'s precondition
    // (findProjectForDir resolves the nested foreign worktree to the
    // CONTAINING project, dirs.projectDir here). Before fix 2 this printed
    // dirs.projectDir's own `npm install && npm run build` for a cwd whose
    // real files are a different repo entirely.
    it("says nothing for a linked worktree of an unrelated repo nested inside the spawning project's own tree", async () => {
      const otherRepoDir = mkdtempSync(join(dirs.tmp, "other-repo-"));
      gitInit(otherRepoDir);
      await mcp.call("project_add", { path: otherRepoDir, name: "other406" });
      const nestedForeignWorktree = join(dirs.projectDir, "wt-of-other-406");
      scratchGit(otherRepoDir, "worktree", "add", "-q", nestedForeignWorktree, "-b", "wt-of-other-406");
      const receipt = await mcp.call("agent_spawn", {
        name: "foreign-nested-worker",
        command: fakeClaude("sleep 600"),
        cwd: nestedForeignWorktree,
      });
      assert.equal(receipt.worktree_install, undefined);
    });
  },
);
