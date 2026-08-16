import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { clearHiveEnv, isolateTmux, makeFakeClaude, McpClient, scratchDirs, scratchGit } from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("the worktree-install-notice tests");

clearHiveEnv();

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

  const siblingWorktree = join(unitRoot, "sibling-worktree");
  scratchGit(primary, "worktree", "add", "-q", siblingWorktree, "-b", "feature406-sibling");

  const nestedWorktree = join(primary, ".claude", "worktrees", "feature406-nested");
  mkdirSync(join(primary, ".claude", "worktrees"), { recursive: true });
  scratchGit(primary, "worktree", "add", "-q", nestedWorktree, "-b", "feature406-nested");
  const nonGit = mkdtempSync(join(unitRoot, "non-git-"));

  it("is false for the primary checkout's own root", () => {

    assert.equal(isLinkedWorktree(primary), false);
  });

  it("is false for an ordinary subdirectory of the primary checkout", () => {
    assert.equal(isLinkedWorktree(sub), false);
  });

  it("is true for a sibling linked worktree (cut outside the primary checkout)", () => {
    assert.equal(isLinkedWorktree(siblingWorktree), true);
  });

  it("is true for a NESTED linked worktree (cut inside the primary checkout, this project's own layout) - the regression case", () => {

    assert.equal(isLinkedWorktree(nestedWorktree), true);
  });

  it("is false for a directory with no git repo at all", () => {

    assert.equal(isLinkedWorktree(nonGit), false);
  });

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

      process.env.GIT_DIR = join(primary, ".git", "worktrees", basename(siblingWorktree));
      delete process.env.GIT_COMMON_DIR;
      delete process.env.GIT_WORK_TREE;
      assert.equal(isLinkedWorktree(primary), false);
    });

    it("does not misreport a real linked worktree as ordinary when GIT_DIR names the primary's own .git", () => {

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

    assert.equal(worktreeInstallNotice(primary, primary, withInstall), undefined);
  });

  it("says nothing for a linked worktree whose project declares no install command", () => {

    assert.equal(worktreeInstallNotice(worktree, primary, noInstallKey), undefined);
  });

  it("says nothing when hive.yml itself is absent (config is null)", () => {
    assert.equal(worktreeInstallNotice(worktree, primary, null), undefined);
  });

  it("says nothing when vars.install has no non-whitespace characters", () => {

    assert.equal(worktreeInstallNotice(worktree, primary, { vars: { install: "   " } }), undefined);
  });

  it("says nothing when vars.install is the empty string", () => {

    assert.equal(worktreeInstallNotice(worktree, primary, { vars: { install: "" } }), undefined);
  });

  it("trims the declared command before it reaches the receipt", () => {
    assert.equal(
      worktreeInstallNotice(worktree, primary, { vars: { install: "  npm install  " } }),
      "npm install",
    );
  });

  it("says nothing for a linked worktree of a DIFFERENT repo than the one supplying config", () => {

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
