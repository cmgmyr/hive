import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
  alternateInterpreter,
  classicAddonFixture,
  firedSessionStart as fired,
  isolateTmux,
  REPO,
  runCli,
  runNode,
  scratchDirs,
  scratchGit as git,
  writeScratchAddon,
} from "./helpers.mjs";

const KICKOFF_MJS = join(REPO, "claude-plugin", "kickoff.mjs");

const { cleanup: cleanupTmux } = isolateTmux("the kickoff re-exec tests");
after(() => cleanupTmux());

const ABI_FAILURE = /^hive: cannot run under this Node\.$/m;

describe("kickoff.mjs re-execs under the dispatcher's pinned interpreter", () => {
  const alt = alternateInterpreter();
  const matchingFixture = classicAddonFixture({ matches: true });
  const SKIP =
    alt && matchingFixture
      ? false
      : alt
        ? `no pre-N-API better-sqlite3 fixture for ${process.platform}-${process.arch} ABI ${process.versions.modules} - add one (see test/fixtures/native-addon-abi/README.md) or this coverage is silently gone`
        : "no second Node with a different ABI on this machine";
  const dirs = scratchDirs();
  const binDir = join(dirs.tmp, "bin");
  const opts = { cwd: dirs.projectDir, dataDir: dirs.dataDir, tmp: dirs.tmp };

  const scratch = SKIP
    ? null
    : writeScratchAddon(join(dirs.tmp, "scratch-addon"), { prebuild: matchingFixture, classic: true });

  async function pinDispatcher(node) {
    const { dispatcherScript, cliPath } = await import("../dist/dispatcher.js");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, "hive"), dispatcherScript(node, cliPath()));
  }

  before(async () => {
    git(dirs.projectDir, "init", "-q", "-b", "main");
    git(dirs.projectDir, "commit", "-q", "--allow-empty", "-m", "root");
    writeFileSync(join(dirs.projectDir, "hive.yml"), "profile: orchestration\n");
    const init = await runCli(["init"], opts);
    assert.equal(init.code, 0, init.stderr);
  });

  it("recovers when started under the wrong interpreter but a dispatcher pins the right one", { skip: SKIP }, async () => {
    await pinDispatcher(process.execPath);
    const { code, stdout, stderr } = await runNode(scratch.kickoffMjs, [], {
      ...opts,
      node: alt.path,
      env: { HIVE_BIN_DIR: binDir },
    });
    assert.equal(code, 0, stderr);
    assert.match(fired(stdout).additionalContext, /\[hive\] Project/);
  });

  it("falls through to the unchanged failure when there is no dispatcher to re-exec under", { skip: SKIP }, async () => {
    const { code, stderr } = await runNode(scratch.kickoffMjs, [], {
      ...opts,
      node: alt.path,
      env: { HIVE_BIN_DIR: join(dirs.tmp, "no-dispatcher-here") },
    });
    assert.equal(code, 1);
    assert.match(stderr, ABI_FAILURE);
    assert.match(stderr, new RegExp(`NODE_MODULE_VERSION ${alt.modules}`));
  });

  it(
    "falls through to the unchanged failure when the pinned interpreter cannot be executed",
    { skip: SKIP },
    async () => {

      const gone = join(dirs.tmp, "gone-node");
      await pinDispatcher(gone);
      const { code, stderr } = await runNode(scratch.kickoffMjs, [], {
        ...opts,
        node: alt.path,
        env: { HIVE_BIN_DIR: binDir },
      });
      assert.equal(code, 1);
      assert.match(stderr, ABI_FAILURE);

      assert.doesNotMatch(stderr, /^\[hive\]/m, "kickoff itself says nothing on this branch");

      assert.match(stderr, new RegExp(`dispatcher pins ${gone}, which is not on disk`));
    },
  );

  it("does not re-exec a second time once the loop guard marker is set", { skip: SKIP }, async () => {

    await pinDispatcher(process.execPath);
    const { code, stderr } = await runNode(scratch.kickoffMjs, [], {
      ...opts,
      node: alt.path,
      env: { HIVE_BIN_DIR: binDir, HIVE_KICKOFF_REEXEC: "1" },
    });
    assert.equal(code, 1, "the marker should have suppressed the re-exec that would otherwise have fixed this");
    assert.match(stderr, ABI_FAILURE);
    assert.match(stderr, new RegExp(`NODE_MODULE_VERSION ${alt.modules}`), "still under the wrong interpreter");
  });

  it(
    "does not re-exec when the current interpreter is already healthy, even if the pin is stale",
    { skip: SKIP },
    async () => {

      await pinDispatcher(alt.path);
      const { code, stdout, stderr } = await runNode(scratch.kickoffMjs, [], {
        ...opts,
        node: process.execPath,
        env: { HIVE_BIN_DIR: binDir },
      });
      assert.equal(code, 0, stderr);
      assert.match(fired(stdout).additionalContext, /\[hive\] Project/);
    },
  );

  it(
    "terminates in one hop instead of hanging when the current interpreter AND the pin are both broken",
    { skip: SKIP, timeout: 10_000 },
    async () => {

      const altReal = realpathSync(alt.path);
      const altAlias = join(dirs.tmp, "alt-node-alias");
      symlinkSync(altReal, altAlias);
      await pinDispatcher(altAlias);
      const { code, stderr } = await runNode(scratch.kickoffMjs, [], {
        ...opts,
        node: altReal,
        env: { HIVE_BIN_DIR: binDir },
      });
      assert.equal(code, 1);
      assert.match(stderr, ABI_FAILURE);
      assert.match(stderr, new RegExp(`NODE_MODULE_VERSION ${alt.modules}`));
    },
  );

  it(
    "re-execs for a LEAD session, which carries HIVE_AGENT_ID like a worker but must still fire",
    { skip: alt ? false : "no second Node with a different ABI on this machine" },
    async () => {

      await pinDispatcher(process.execPath);
      const { code, stdout, stderr } = await runNode(KICKOFF_MJS, [], {
        ...opts,
        node: alt.path,
        env: { HIVE_BIN_DIR: binDir, HIVE_AGENT_ID: "lead:1", HIVE_LEAD: "1" },
      });
      assert.equal(code, 0, stderr);
      assert.match(fired(stdout).additionalContext, /\[hive\] Project/);
    },
  );

  it(
    "does not re-exec for a WORKER session, which dist/kickoff.js declines before it can reach the store",
    { skip: alt ? false : "no second Node with a different ABI on this machine" },
    async () => {

      const sentinel = join(dirs.tmp, "worker-reexec-happened");
      const recordingNode = join(dirs.tmp, "recording-node");
      writeFileSync(recordingNode, `#!/bin/sh\ntouch ${shQuote(sentinel)}\nexit 3\n`, { mode: 0o755 });
      await pinDispatcher(recordingNode);
      const { code, stdout, stderr } = await runNode(KICKOFF_MJS, [], {
        ...opts,
        node: alt.path,
        env: { HIVE_BIN_DIR: binDir, HIVE_AGENT_ID: "agent:7" },
      });
      assert.equal(
        existsSync(sentinel),
        false,
        "a worker session paid for the dispatcher read and re-exec that its own gate exists to skip",
      );
      assert.equal(code, 0, stderr);
      assert.equal(stdout, "", "a worker gets its brief from agent_spawn, never from this hook");
    },
  );
});

function shQuote(s) {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

describe("kickoff.mjs stays silent on error, per its own contract, even before dist/kickoff.js's own try/catch can run", () => {
  it("does not crash when the working directory was deleted before the hook ran", async () => {

    const dirs = scratchDirs();
    const doomed = join(dirs.tmp, "doomed");
    mkdirSync(doomed, { recursive: true });
    const { code, stdout, stderr } = await new Promise((resolve) => {
      const child = spawn(
        "sh",
        [
          "-c",
          `cd ${shQuote(doomed)} && rm -rf ${shQuote(doomed)} && exec ${shQuote(process.execPath)} ${shQuote(KICKOFF_MJS)}`,
        ],
        {
          env: {
            ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("HIVE_"))),
            HIVE_DATA_DIR: dirs.dataDir,
            HIVE_AUTO_ATTACH: "0",
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let out = "";
      let err = "";
      child.stdout.on("data", (c) => (out += c));
      child.stderr.on("data", (c) => (err += c));
      child.on("exit", (exitCode) => resolve({ code: exitCode, stdout: out, stderr: err }));
    });
    assert.equal(code, 0, stderr);
    assert.equal(stdout, "", "the required silence: nothing on stdout, no stack trace on stderr, exit 0");
  });
});
