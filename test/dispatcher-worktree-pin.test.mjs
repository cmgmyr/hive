import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
  failureCount,
  isolateTmux,
  promotedCount,
  runNode,
  scratchDirs,
  scratchGit as git,
  warningCount,
  writeScratchAddon,
} from "./helpers.mjs";

const { cleanup: cleanupTmux } = isolateTmux("the dispatcher worktree-pin tests");
after(() => cleanupTmux());

let realAddon;
async function addonForScratch() {
  if (!realAddon) {
    const { checkAbi } = await import("../dist/abi.js");
    realAddon = checkAbi().addon;
  }
  return { prebuild: realAddon };
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function binFirstEnv(binDir) {
  return { HIVE_BIN_DIR: binDir, PATH: `${binDir}:${dirname(process.execPath)}:/usr/bin:/bin` };
}

function makeLinkedWorktree(tmp) {
  const mainRepo = join(tmp, "main-repo");
  mkdirSync(mainRepo, { recursive: true });
  git(mainRepo, "init", "-q", "-b", "main");
  git(mainRepo, "commit", "-q", "--allow-empty", "-m", "root");
  const worktreeDir = join(tmp, "linked-worktree");
  git(mainRepo, "worktree", "add", "-q", worktreeDir, "-b", "wt-branch");
  return worktreeDir;
}

function makeDurableCheckout(tmp) {
  const root = join(tmp, "durable-checkout");
  mkdirSync(root, { recursive: true });
  git(root, "init", "-q", "-b", "main");
  git(root, "commit", "-q", "--allow-empty", "-m", "root");
  return root;
}

function makeGitSubmodule(tmp) {
  const inner = join(tmp, "inner-repo");
  mkdirSync(inner, { recursive: true });
  git(inner, "init", "-q", "-b", "main");
  git(inner, "commit", "-q", "--allow-empty", "-m", "inner root");

  const outer = join(tmp, "outer-repo");
  mkdirSync(outer, { recursive: true });
  git(outer, "init", "-q", "-b", "main");
  git(outer, "commit", "-q", "--allow-empty", "-m", "outer root");
  git(outer, "-c", "protocol.file.allow=always", "submodule", "add", "-q", inner, "subdir");
  return join(outer, "subdir");
}

describe("linkedWorktreePin", () => {
  let linkedWorktreePin;
  const dirs = scratchDirs();

  before(async () => {
    ({ linkedWorktreePin } = await import("../dist/dispatcher.js"));
  });

  it("is the tell for a real linked git worktree: a .git file whose gitdir targets .git/worktrees/", () => {
    const mainRepo = join(dirs.tmp, "main-repo");
    const worktreeDir = makeLinkedWorktree(dirs.tmp);
    const cli = join(worktreeDir, "dist", "cli.js");
    mkdirSync(join(worktreeDir, "dist"), { recursive: true });
    writeFileSync(cli, "// stand-in\n");
    assert.deepEqual(linkedWorktreePin(cli), { linked: true, via: "git-file", durableRoot: mainRepo });
  });

  it("does not misclassify the durable checkout, whose .git is a directory", () => {
    const root = makeDurableCheckout(dirs.tmp);
    const cli = join(root, "dist", "cli.js");
    mkdirSync(join(root, "dist"), { recursive: true });
    writeFileSync(cli, "// stand-in\n");
    assert.deepEqual(linkedWorktreePin(cli), { linked: false, via: null, durableRoot: null });
  });

  it("does not misclassify a git submodule, whose .git is also a regular file", () => {
    const submoduleDir = makeGitSubmodule(dirs.tmp);
    const cli = join(submoduleDir, "dist", "cli.js");
    mkdirSync(join(submoduleDir, "dist"), { recursive: true });
    writeFileSync(cli, "// stand-in\n");
    assert.deepEqual(
      linkedWorktreePin(cli),
      { linked: false, via: null, durableRoot: null },
      "a submodule's .git file targets .git/modules/<name>, never .git/worktrees/<name> - being a FILE is not enough",
    );
  });

  it("does not misclassify a .git file with no parseable gitdir line", () => {
    const root = join(dirs.tmp, "garbage-git-file");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, ".git"), "not a real gitdir pointer\n");
    const cli = join(root, "dist", "cli.js");
    mkdirSync(join(root, "dist"), { recursive: true });
    writeFileSync(cli, "// stand-in\n");
    assert.deepEqual(linkedWorktreePin(cli), { linked: false, via: null, durableRoot: null });
  });

  it("does not misclassify a path that merely LOOKS worktree-like by name but is not one", () => {
    const root = join(dirs.tmp, ".agents", "worktrees", "not-really-a-worktree");
    const cli = join(root, "dist", "cli.js");
    mkdirSync(join(root, "dist"), { recursive: true });
    writeFileSync(cli, "// stand-in\n");
    assert.deepEqual(
      linkedWorktreePin(cli),
      { linked: false, via: null, durableRoot: null },
      "an existing path is judged by its real .git, never by a path fragment that happens to match",
    );
  });

  it("falls back to the path fragment only once the target no longer exists", () => {
    const gone = join(dirs.tmp, "some-repo", ".agents", "worktrees", "torn-down-lane", "dist", "cli.js");
    assert.deepEqual(linkedWorktreePin(gone), { linked: true, via: "path-fragment", durableRoot: null });
  });

  it("reports not-linked for an ordinary deleted path with no worktree fragment in it", () => {
    const gone = join(dirs.tmp, "somewhere-else", "dist", "cli.js");
    assert.deepEqual(linkedWorktreePin(gone), { linked: false, via: null, durableRoot: null });
  });
});

describe("hive setup refuses to pin a linked worktree's dist", () => {
  const dirs = scratchDirs();
  const binDir = join(dirs.tmp, "bin");
  const mainRepo = join(dirs.tmp, "main-repo");
  const opts = { cwd: dirs.projectDir, dataDir: dirs.dataDir, tmp: dirs.tmp };
  let scratch;

  before(async () => {
    const worktreeDir = makeLinkedWorktree(dirs.tmp);
    scratch = writeScratchAddon(worktreeDir, await addonForScratch());
  });

  it("refuses without --force, naming an absolute interpreter and the durable checkout's own cli.js", async () => {
    const { code, stdout } = await runNode(scratch.cli, ["setup", "--dir", binDir], opts);
    assert.equal(code, 1, stdout);
    assert.match(stdout, /is inside a linked git worktree/);
    assert.match(stdout, /refusing to pin `hive` to it without --force/);
    assert.doesNotMatch(stdout, /: node dist\/cli\.js setup/, "the repair must name an interpreter, not a bare `node`");
    assert.doesNotMatch(stdout, /^ *hive setup$/m, "the fix must not route through the shim it just refused to write");

    const repair = /Repair from the durable checkout instead: "([^"]+)" "([^"]+)" setup/.exec(stdout);
    assert.ok(repair, `should print a quoted repair command:\n${stdout}`);
    assert.ok(repair[1].startsWith("/"), `interpreter should be absolute: ${repair[1]}`);
    assert.equal(
      repair[2],
      join(mainRepo, "dist", "cli.js"),
      "should name the durable checkout's own cli.js, resolved from the worktree's .git, not the worktree's",
    );
    assert.throws(() => readFileSync(join(binDir, "hive"), "utf8"), "must not have written a dispatcher");
  });

  it("--force overrides the refusal and pins it anyway", async () => {
    const { code, stdout } = await runNode(scratch.cli, ["setup", "--dir", binDir, "--force"], opts);
    assert.equal(code, 0, stdout);
    const script = readFileSync(join(binDir, "hive"), "utf8");
    assert.ok(script.includes(scratch.cli), `dispatcher should pin the worktree cli anyway:\n${script}`);
  });
});

describe("hive setup and doctor do not treat a git submodule's dist as a worktree", () => {
  const dirs = scratchDirs();
  const binDir = join(dirs.tmp, "bin");
  const opts = { cwd: dirs.projectDir, dataDir: dirs.dataDir, tmp: dirs.tmp };
  let scratch;

  before(async () => {
    const submoduleDir = makeGitSubmodule(dirs.tmp);
    scratch = writeScratchAddon(submoduleDir, await addonForScratch());
  });

  it("setup pins it unforced, same as any other durable checkout", async () => {
    const { code, stdout } = await runNode(scratch.cli, ["setup", "--dir", binDir], opts);
    assert.equal(code, 0, stdout);
    assert.doesNotMatch(stdout, /linked git worktree/);
    const script = readFileSync(join(binDir, "hive"), "utf8");
    assert.ok(script.includes(scratch.cli));
  });

  it("doctor does not warn for that pin", async () => {
    const { stdout } = await runNode(scratch.cli, ["doctor"], { ...opts, env: binFirstEnv(binDir) });
    assert.doesNotMatch(stdout, /warn {2}dispatcher/, stdout);
  });
});

describe("hive setup pins a durable checkout's dist exactly as before", () => {
  const dirs = scratchDirs();
  const binDir = join(dirs.tmp, "bin");
  const opts = { cwd: dirs.projectDir, dataDir: dirs.dataDir, tmp: dirs.tmp };
  let scratch;

  before(async () => {
    const root = makeDurableCheckout(dirs.tmp);
    scratch = writeScratchAddon(root, await addonForScratch());
  });

  it("pins unforced, with the ordinary success output", async () => {
    const { code, stdout } = await runNode(scratch.cli, ["setup", "--dir", binDir], opts);
    assert.equal(code, 0, stdout);
    assert.match(stdout, /^Wrote /m);
    assert.doesNotMatch(stdout, /linked git worktree/);
    const script = readFileSync(join(binDir, "hive"), "utf8");
    assert.ok(script.includes(scratch.cli));
  });

  it("doctor stays green for that pin", async () => {
    const { stdout } = await runNode(scratch.cli, ["doctor"], { ...opts, env: binFirstEnv(binDir) });
    assert.doesNotMatch(stdout, /warn {2}dispatcher/, stdout);
  });
});

describe("hive doctor flags a shim pinned to a linked worktree", () => {
  const dirs = scratchDirs();
  const binDir = join(dirs.tmp, "bin");
  const mainRepo = join(dirs.tmp, "main-repo");
  const opts = { cwd: dirs.projectDir, dataDir: dirs.dataDir, tmp: dirs.tmp };
  let scratch;
  let plain;
  let strict;

  before(async () => {
    const worktreeDir = makeLinkedWorktree(dirs.tmp);
    scratch = writeScratchAddon(worktreeDir, await addonForScratch());
    mkdirSync(binDir, { recursive: true });
    const { dispatcherScript } = await import("../dist/dispatcher.js");
    writeFileSync(join(binDir, "hive"), dispatcherScript(process.execPath, scratch.cli), { mode: 0o755 });

    const env = binFirstEnv(binDir);
    plain = await runNode(scratch.cli, ["doctor"], { ...opts, env });
    strict = await runNode(scratch.cli, ["doctor", "--strict"], { ...opts, env });
  });

  it("warns, naming the worktree path and an absolute repair, and does not report all clear", () => {
    assert.match(plain.stdout, /warn {2}dispatcher: pinned to a linked git worktree.*: .*linked-worktree/);
    assert.doesNotMatch(plain.stdout, /: node dist\/cli\.js setup/, "the repair must name an interpreter, not a bare `node`");
    assert.match(
      plain.stdout,
      new RegExp(
        `Re-pin from the durable checkout instead: "${escapeRegex(process.execPath)}" "${escapeRegex(join(mainRepo, "dist", "cli.js"))}" setup`,
      ),
    );
    assert.ok(warningCount(plain.stdout) >= 1, plain.stdout);
  });

  it("gates under --strict, per the four-dispatcher-warns default", () => {
    assert.equal(promotedCount(strict.stdout), 1, strict.stdout);
    assert.equal(failureCount(strict.stdout), failureCount(plain.stdout) + 1, strict.stdout);

    assert.equal(strict.code === 0, failureCount(strict.stdout) === 0, strict.stdout);
    assert.equal(plain.code === 0, failureCount(plain.stdout) === 0, plain.stdout);
  });
});

describe("hive doctor flags a shim whose target no longer exists", () => {
  const dirs = scratchDirs();
  const binDir = join(dirs.tmp, "bin");
  const opts = { cwd: dirs.projectDir, dataDir: dirs.dataDir, tmp: dirs.tmp };
  let scratch;
  let survivorCli;
  let plain;
  let strict;

  before(async () => {

    const addonOpts = await addonForScratch();
    const worktreeDir = makeLinkedWorktree(dirs.tmp);
    scratch = writeScratchAddon(worktreeDir, addonOpts);
    survivorCli = writeScratchAddon(join(dirs.tmp, "survivor"), addonOpts).cli;

    mkdirSync(binDir, { recursive: true });
    const { dispatcherScript } = await import("../dist/dispatcher.js");
    writeFileSync(join(binDir, "hive"), dispatcherScript(process.execPath, scratch.cli), { mode: 0o755 });

    rmSync(worktreeDir, { recursive: true, force: true });

    const env = binFirstEnv(binDir);
    plain = await runNode(survivorCli, ["doctor"], { ...opts, env });
    strict = await runNode(survivorCli, ["doctor", "--strict"], { ...opts, env });
  });

  it("names the observed post-teardown MODULE_NOT_FOUND state as gone, not as a build mismatch", () => {
    assert.match(plain.stdout, new RegExp(`warn {2}dispatcher: the checkout it pins is gone: ${escapeRegex(scratch.cli)}`));
    assert.doesNotMatch(plain.stdout, /pinned to a different build/);
    assert.doesNotMatch(plain.stdout, /: node dist\/cli\.js setup/, "the repair must name an interpreter, not a bare `node`");
    assert.match(
      plain.stdout,
      new RegExp(`Re-pin from a durable checkout that still exists: "${escapeRegex(process.execPath)}" <durable checkout>/dist/cli\\.js setup`),
    );
  });

  it("gates under --strict too", () => {
    assert.equal(promotedCount(strict.stdout), 1, strict.stdout);
    assert.equal(failureCount(strict.stdout), failureCount(plain.stdout) + 1, strict.stdout);
  });
});
