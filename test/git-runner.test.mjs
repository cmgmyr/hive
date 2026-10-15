import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { isolateTmux } from "./helpers.mjs";

const root = mkdtempSync(join(tmpdir(), "hive-git-runner-"));
process.env.HIVE_DATA_DIR = join(root, "data");
const { cleanup } = isolateTmux("the git runner tests");
after(() => cleanup());
const { gitOut } = await import("../dist/git.js");
const { branchAt } = await import("../dist/spawn.js");

function repository(root, name, branch) {
  const cwd = join(root, name);
  mkdirSync(cwd);
  execFileSync("git", ["init", "-q", "-b", branch], { cwd });
  execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@test", "commit", "-q", "--allow-empty", "-m", "root"], { cwd });
  return cwd;
}

after(() => rmSync(root, { recursive: true, force: true }));

describe("gitOut", () => {
  it("returns null when a git command fails", () => {
    assert.equal(gitOut(root, ["not-a-git-command"]), null);
  });

  it("strips ambient GIT_* repository overrides", () => {
    const expected = repository(root, "expected", "expected-branch");
    const stranger = repository(root, "stranger", "stranger-branch");
    const original = Object.fromEntries(["GIT_DIR", "GIT_COMMON_DIR", "GIT_WORK_TREE"].map((key) => [key, process.env[key]]));
    process.env.GIT_DIR = join(stranger, ".git");
    process.env.GIT_COMMON_DIR = join(stranger, ".git");
    process.env.GIT_WORK_TREE = stranger;
    try {
      assert.equal(gitOut(expected, ["rev-parse", "--abbrev-ref", "HEAD"]), "expected-branch");
    } finally {
      for (const [key, value] of Object.entries(original)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("branchAt reads the worktree branch when GIT_DIR points at another repository", () => {
    const expected = repository(root, "branch-at", "worktree-branch");
    const stranger = repository(root, "branch-at-stranger", "stranger-branch");
    const original = process.env.GIT_DIR;
    process.env.GIT_DIR = join(stranger, ".git");
    try {
      assert.equal(branchAt(expected), "worktree-branch");
    } finally {
      if (original === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = original;
    }
  });
});
