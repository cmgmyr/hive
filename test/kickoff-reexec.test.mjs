import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
  alternateInterpreter,
  firedSessionStart as fired,
  isolateTmux,
  REPO,
  runCli,
  runNode,
  scratchDirs,
  scratchGit as git,
} from "./helpers.mjs";

// hooks.json registers claude-plugin/kickoff.mjs under a bare `node`, which a
// version manager resolves from the session's working directory rather than
// the Node hive was built under (issue #50). This exercises the plugin entry
// point itself, not dist/kickoff.js (kickoff.test.mjs's target), because the
// re-exec has to happen before dist/kickoff.js -> dist/db.js is ever imported.
// It only fires on a genuine ABI mismatch (checkAbi().ok === false), never on
// a bare path difference from the dispatcher's pin -- a healthy interpreter
// whose pin is merely stale must be left alone.
const KICKOFF_MJS = join(REPO, "claude-plugin", "kickoff.mjs");

const { cleanup: cleanupTmux } = isolateTmux("the kickoff re-exec tests");
after(() => cleanupTmux());

const ABI_FAILURE = /^hive: cannot run under this Node\.$/m;

describe("kickoff.mjs re-execs under the dispatcher's pinned interpreter", () => {
  const alt = alternateInterpreter();
  const dirs = scratchDirs();
  const binDir = join(dirs.tmp, "bin");
  const opts = { cwd: dirs.projectDir, dataDir: dirs.dataDir, tmp: dirs.tmp };

  // dispatcher.js reads its exec line back out; writing it by hand rather
  // than through dispatcherScript() would silently drift from the format
  // readDispatcher actually parses. Imported inside a function per
  // test/CLAUDE.md: a static dist/ import hoisted above scratchDirs() picks
  // the store for the whole file, even though dispatcher.js itself is
  // store-free.
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

  it(
    "recovers when started under the wrong interpreter but a dispatcher pins the right one",
    { skip: alt ? false : "no second Node with a different ABI on this machine" },
    async () => {
      await pinDispatcher(process.execPath);
      const { code, stdout, stderr } = await runNode(KICKOFF_MJS, [], {
        ...opts,
        node: alt.path,
        env: { HIVE_BIN_DIR: binDir },
      });
      assert.equal(code, 0, stderr);
      assert.match(fired(stdout).additionalContext, /\[hive\] Project/);
    },
  );

  it(
    "falls through to the unchanged failure when there is no dispatcher to re-exec under",
    { skip: alt ? false : "no second Node with a different ABI on this machine" },
    async () => {
      const { code, stderr } = await runNode(KICKOFF_MJS, [], {
        ...opts,
        node: alt.path,
        env: { HIVE_BIN_DIR: join(dirs.tmp, "no-dispatcher-here") },
      });
      assert.equal(code, 1);
      assert.match(stderr, ABI_FAILURE);
      assert.match(stderr, new RegExp(`NODE_MODULE_VERSION ${alt.modules}`));
    },
  );

  it(
    "falls through to the unchanged failure when the pinned interpreter cannot be executed",
    { skip: alt ? false : "no second Node with a different ABI on this machine" },
    async () => {
      // This cannot distinguish the existsSync(node) guard in kickoff.mjs
      // from spawnSync's own result.error fallback a few lines later: a
      // missing file trips both, they are deliberately redundant, and both
      // converge on identical output by returning without touching
      // process.exit either way. Proven by hand: commenting out the
      // existsSync guard leaves this test passing unchanged. What this pins
      // is the observable contract -- a pinned interpreter that cannot be
      // executed falls through safely rather than crashing or hanging --
      // not which specific guard caught it.
      await pinDispatcher(join(dirs.tmp, "gone-node"));
      const { code, stderr } = await runNode(KICKOFF_MJS, [], {
        ...opts,
        node: alt.path,
        env: { HIVE_BIN_DIR: binDir },
      });
      assert.equal(code, 1);
      assert.match(stderr, ABI_FAILURE);
    },
  );

  it(
    "does not re-exec a second time once the loop guard marker is set",
    { skip: alt ? false : "no second Node with a different ABI on this machine" },
    async () => {
      // A dispatcher pinning a perfectly good interpreter (process.execPath)
      // would normally recover this, per the first test above. With the
      // marker already set, as it would be on a re-exec's own child, the
      // check must refuse to act on it, or a pinned interpreter that also
      // cannot load the addon re-execs into itself forever.
      await pinDispatcher(process.execPath);
      const { code, stderr } = await runNode(KICKOFF_MJS, [], {
        ...opts,
        node: alt.path,
        env: { HIVE_BIN_DIR: binDir, HIVE_KICKOFF_REEXEC: "1" },
      });
      assert.equal(code, 1, "the marker should have suppressed the re-exec that would otherwise have fixed this");
      assert.match(stderr, ABI_FAILURE);
      assert.match(stderr, new RegExp(`NODE_MODULE_VERSION ${alt.modules}`), "still under the wrong interpreter");
    },
  );

  it(
    "does not re-exec when the current interpreter is already healthy, even if the pin is stale",
    { skip: alt ? false : "no second Node with a different ABI on this machine" },
    async () => {
      // The regression this pins: a session running the interpreter that
      // actually built the addon must fire normally even when the dispatcher
      // names some other (here, broken) interpreter. The re-exec exists to
      // fix an ABI mismatch, not to chase the dispatcher's pin for its own
      // sake -- a rebuild that has not been re-pinned yet is an ordinary,
      // common state (the README's own update recipe warns about it), not an
      // exotic one, and it must not cost this session its kickoff.
      await pinDispatcher(alt.path);
      const { code, stdout, stderr } = await runNode(KICKOFF_MJS, [], {
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
    { skip: alt ? false : "no second Node with a different ABI on this machine", timeout: 10_000 },
    async () => {
      // The genuine loop risk, reproduced for real rather than asserted from
      // reasoning: process.execPath always reports the RESOLVED real path of
      // the running interpreter (verified by hand), even when invoked through
      // a symlink. So a dispatcher that pins the *unresolved* alias of the
      // exact interpreter already running mismatches process.execPath on
      // every single hop -- the literal shape of a pin that never converges.
      // Confirmed by hand with the loop guard temporarily disabled: this
      // construction re-execs dozens of times a second until killed. With the
      // guard, it must take exactly one hop and stop, whether or not that hop
      // lands on a healthy interpreter (it does not, here: alias and target
      // are the same broken binary).
      const altReal = realpathSync(alt.path);
      const altAlias = join(dirs.tmp, "alt-node-alias");
      symlinkSync(altReal, altAlias);
      await pinDispatcher(altAlias);
      const { code, stderr } = await runNode(KICKOFF_MJS, [], {
        ...opts,
        node: altReal,
        env: { HIVE_BIN_DIR: binDir },
      });
      assert.equal(code, 1);
      assert.match(stderr, ABI_FAILURE);
      assert.match(stderr, new RegExp(`NODE_MODULE_VERSION ${alt.modules}`));
    },
  );
});

// POSIX single-quoting, unconditional -- src/dispatcher.ts's own shQuote for
// the same reason: this builds a shell command line from paths under
// os.tmpdir(), not one a human types, so a bare operand is the wrong default.
function shQuote(s) {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

describe("kickoff.mjs stays silent on error, per its own contract, even before dist/kickoff.js's own try/catch can run", () => {
  it("does not crash when the working directory was deleted before the hook ran", async () => {
    // process.cwd() throws ENOENT once its directory has been unlinked out
    // from under it, which happens here on purpose (verified by hand: a
    // process that already has a directory open as its cwd keeps running
    // after that directory is removed, but getcwd()/uv_cwd can no longer
    // resolve a path for it). Reproducing that needs the cd and the rm to
    // happen in the SAME shell, in order, before kickoff.mjs starts -- a
    // spawn() with cwd pointed at an already-deleted directory is a
    // different failure (spawn refuses at exec time) and would not exercise
    // this at all.
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
