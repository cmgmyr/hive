import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";

import { isolateTmux } from "./helpers.mjs";
import {
  DIST_DIR,
  REPO_DIR,
  SRC_DIR,
  checkAxesPresent,
  checkDistBuilt,
  checkDistFresh,
  checkNotDefaultStore,
  checkOwnsInstance,
  checkSocketPathLength,
  checkTmuxTmpDirExists,
  formatEnvBlock,
  killSocket,
  scratchPaths,
} from "../scripts/isolated-hive.mjs";

// scripts/isolated-hive.mjs's own `up`/`down` never touch the ambient tmux
// server -- its scratch TMUX_TMPDIR always comes from a fresh mkdtemp, and
// `down` passes that path explicitly rather than reading the ambient env. But
// this file's own dynamic `../dist/tmux.js` imports trip suite-isolation's
// textual scan regardless, so isolate the same way every other file here does.
const { cleanup: cleanupTmux } = isolateTmux("the isolated-hive script tests");
after(() => cleanupTmux());

const SCRIPT = new URL("../scripts/isolated-hive.mjs", import.meta.url).pathname;

const reEscape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

describe("isolated-hive guards", () => {
  it("refuses when the data dir resolves to hive's default store", async () => {
    const { isDefaultStore, DEFAULT_DATA_DIR } = await import("../dist/dataDir.js");
    assert.match(checkNotDefaultStore(DEFAULT_DATA_DIR, isDefaultStore), /resolves to hive's default store/);
    assert.equal(checkNotDefaultStore(join(tmpdir(), "some-scratch-dir"), isDefaultStore), null);
  });

  it("refuses when either isolation axis is missing", () => {
    assert.match(checkAxesPresent({ dataDir: "/x", tmuxTmpDir: undefined }), /missing TMUX_TMPDIR\b/);
    assert.match(checkAxesPresent({ dataDir: undefined, tmuxTmpDir: "/y" }), /missing HIVE_DATA_DIR\b/);
    assert.match(
      checkAxesPresent({ dataDir: undefined, tmuxTmpDir: undefined }),
      /missing HIVE_DATA_DIR and TMUX_TMPDIR/,
    );
    assert.equal(checkAxesPresent({ dataDir: "/x", tmuxTmpDir: "/y" }), null);
  });

  it("refuses a socket path over the cap, naming the measured length", async () => {
    const { tmuxSocketPath } = await import("../dist/tmux.js");
    // Must actually exist: tmuxSocketPath falls back to the DEFAULT socket
    // for a directory it cannot reach (trap 3), which would make this
    // measure the short default path instead of the long one under test.
    const longDir = mkdtempSync(join(tmpdir(), "hive-iso-test-"));
    const nested = join(longDir, "x".repeat(120));
    mkdirSync(nested);
    try {
      const refusal = checkSocketPathLength(nested, tmuxSocketPath, 100);
      const measured = Number(/(\d+) bytes/.exec(refusal)?.[1]);
      assert.ok(measured > 100, `expected the refusal to name a measured length over 100, got: ${refusal}`);
    } finally {
      rmSync(longDir, { recursive: true, force: true });
    }
  });

  it("accepts a socket path within the cap", async () => {
    const { tmuxSocketPath } = await import("../dist/tmux.js");
    const shortDir = mkdtempSync(join(tmpdir(), "hive-iso-test-"));
    try {
      assert.equal(checkSocketPathLength(shortDir, tmuxSocketPath, 100), null);
    } finally {
      rmSync(shortDir, { recursive: true, force: true });
    }
  });

  it("refuses when TMUX_TMPDIR does not exist, rather than assuming tmux will create it", () => {
    const missing = join(tmpdir(), `hive-iso-missing-${Math.random().toString(36).slice(2)}`);
    assert.match(checkTmuxTmpDirExists(missing), /does not exist/);
  });

  it("accepts an existing TMUX_TMPDIR", () => {
    const dir = mkdtempSync(join(tmpdir(), "hive-iso-test-"));
    try {
      assert.equal(checkTmuxTmpDirExists(dir), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports a missing build as a plain refusal, not a thrown stack", () => {
    assert.match(checkDistBuilt(join(tmpdir(), "definitely-not-a-real-dist-dir")), /no built dist at/);
  });

  it("refuses a dist/ older than src/, naming the fix", () => {
    const scratchDist = mkdtempSync(join(tmpdir(), "hive-iso-test-dist-"));
    try {
      const oldTime = new Date(0);
      for (const f of ["index.js", "cli.js", "dataDir.js", "tmux.js"]) {
        const path = join(scratchDist, f);
        writeFileSync(path, "// stale stand-in\n");
        utimesSync(path, oldTime, oldTime);
      }
      assert.match(checkDistFresh(scratchDist, SRC_DIR), /dist\/ at .* is older than src\/.*npm run build/s);
    } finally {
      rmSync(scratchDist, { recursive: true, force: true });
    }
  });

  it("accepts the real, just-built dist as fresh against its own src", () => {
    assert.equal(checkDistFresh(DIST_DIR, SRC_DIR), null);
  });

  it("names the branch's own dist in the env block, unquoted where shellQuote leaves it bare", async () => {
    const { shellQuote } = await import("../dist/tmux.js");
    const block = formatEnvBlock({ dataDir: "/scratch/data", tmuxTmpDir: "/scratch/tmux", distDir: DIST_DIR }, shellQuote);
    assert.match(block, new RegExp(reEscape(DIST_DIR)));
    assert.match(block, /unset TMUX TMUX_PANE/);
    assert.match(block, /export HIVE_DATA_DIR=\/scratch\/data/);
    assert.match(block, /export TMUX_TMPDIR=\/scratch\/tmux/);
  });

  // down's kill-server path had zero coverage before this: no test ever
  // started a server in a scratch dir, so execFileSync always threw "no
  // server running" into a catch and the real kill line never ran.
  // killSocket separates the DECISION from the ACTION so it is testable
  // without ever starting or stopping a real tmux server (counselors
  // review on PR #48, codex finding 9 / opus's coverage note).
  it("killSocket returns null for the default socket and for a missing tmux dir, without starting a server", async () => {
    const { tmuxSocketPath, privateTmuxSocket } = await import("../dist/tmux.js");
    const deps = { tmuxSocketPath, privateTmuxSocket };
    assert.equal(killSocket({ tmuxTmpDir: "/tmp" }, deps), null, "socket path is empty");
    assert.equal(
      killSocket({ tmuxTmpDir: join(tmpdir(), `hive-iso-missing-${Math.random().toString(36).slice(2)}`) }, deps),
      null,
      "missing tmux dir",
    );
  });

  it("killSocket returns the resolved socket for a genuinely private tmux dir", async () => {
    const { tmuxSocketPath, privateTmuxSocket } = await import("../dist/tmux.js");
    const dir = mkdtempSync(join(tmpdir(), "hive-iso-test-"));
    try {
      const socket = killSocket({ tmuxTmpDir: dir }, { tmuxSocketPath, privateTmuxSocket });
      assert.equal(typeof socket, "string");
      assert.ok(socket.length > 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // checkOwnsInstance is the guard between a stale or hand-edited state file
  // and down doing rm -rf plus kill-server against something it did not
  // create -- the PR's own most dangerous finding. It had zero coverage:
  // deleting the call in cmdDown, or breaking the function to always return
  // null, left every existing test in this file green, because the
  // lifecycle test only ever exercises the happy path where up just wrote a
  // well-formed state file (PR gate re-review).
  it("checkOwnsInstance refuses a state whose paths do not match what up creates for its root", () => {
    const root = mkdtempSync(join(tmpdir(), "hive-iso-test-"));
    try {
      const state = { root, dataDir: "/somewhere/else", tmuxTmpDir: scratchPaths(root).tmuxTmpDir };
      assert.match(checkOwnsInstance(state), /paths do not match what `up` creates/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("checkOwnsInstance refuses a root with matching paths but no hive-isolated marker", () => {
    const root = mkdtempSync(join(tmpdir(), "hive-iso-test-"));
    try {
      assert.match(checkOwnsInstance(scratchPaths(root)), /has no hive-isolated marker/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("checkOwnsInstance accepts a root with matching paths and the marker up writes", () => {
    const root = mkdtempSync(join(tmpdir(), "hive-iso-test-"));
    // The literal name, not the (unexported) MARKER_FILE constant: this is
    // what up actually writes to disk, which is the thing worth pinning.
    writeFileSync(join(root, ".hive-isolated-instance"), "test\n");
    try {
      assert.equal(checkOwnsInstance(scratchPaths(root)), null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("isolated-hive CLI lifecycle", () => {
  // statePath() and the mkdtemp root both go through os.tmpdir(), with no
  // env override, keyed only by a hash of this repo checkout -- so an
  // inherited env makes this suite share ONE state file with a real
  // instance a developer brought up in this same worktree to test the
  // branch by hand (counselors review on PR #48, opus finding 3, "bites
  // ME"). Without this, a second `up` here would refuse for the WRONG
  // reason (colliding with the developer's real instance, not the previous
  // test case's), the assertion would fail, and after()'s unconditional
  // `down` would kill-server the developer's private tmux server and rm -rf
  // their scratch store -- while their workers were still running in it.
  //
  // A SHORT base, not one nested under the real TMPDIR: os.tmpdir() on this
  // machine is already a long /var/folders/... path, and stacking a second
  // mkdtemp under it pushes the socket path past the ~100-byte cap, making
  // `up` refuse for a different wrong reason (trap 2, not test isolation).
  const scratchTmpDir = mkdtempSync("/tmp/hi-");
  after(() => rmSync(scratchTmpDir, { recursive: true, force: true }));

  // spawnSync, not execFileSync: execFileSync only returns stdout on
  // success and throws stderr away entirely unless the process exits
  // non-zero, so a caller asserting on stderr (e.g. up's banner, which
  // lives there even on success) saw undefined for every passing run.
  function run(args) {
    const result = spawnSync(process.execPath, [SCRIPT, ...args], {
      encoding: "utf8",
      env: { ...process.env, TMPDIR: scratchTmpDir },
    });
    return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", code: result.status ?? 1 };
  }

  // A case failing partway through the lifecycle must not strand a scratch
  // tree or a real tmux server for the next run to trip over.
  after(() => run(["down"]));

  it("up creates both scratch dirs; env and down operate on the same instance; down is safe twice", () => {
    const up = run(["up"]);
    assert.equal(up.code, 0, up.stdout);

    const dataDir = /HIVE_DATA_DIR=(\S+)/.exec(up.stdout)?.[1];
    const tmuxTmpDir = /TMUX_TMPDIR=(\S+)/.exec(up.stdout)?.[1];
    assert.ok(dataDir && tmuxTmpDir, up.stdout);
    assert.ok(existsSync(dataDir), "up must create HIVE_DATA_DIR before reporting success");
    assert.ok(existsSync(tmuxTmpDir), "up must create TMUX_TMPDIR itself, never assume tmux will");

    // The exit code alone passes for ANY refusal reason -- an unbuilt dist,
    // a stale dist, a thrown TypeError, a bad argv (test/CLAUDE.md's named
    // false-green shape; counselors review on PR #48, opus finding 8).
    // Assert the actual sentence, which is what distinguishes "already up"
    // from every other way this could fail closed.
    const second = run(["up"]);
    assert.equal(second.code, 1, "a second up must refuse while an instance is already up");
    assert.match(second.stderr, /already up at/);

    const env = run(["env"]);
    assert.equal(env.code, 0, env.stdout);
    assert.match(env.stdout, new RegExp(reEscape(dataDir)));
    assert.match(env.stdout, new RegExp(reEscape(DIST_DIR)));

    const root = dirname(tmuxTmpDir);
    const down = run(["down"]);
    assert.equal(down.code, 0, down.stdout);
    assert.ok(!existsSync(root), "down must remove the whole scratch tree up created, and only that tree");

    const downAgain = run(["down"]);
    assert.equal(downAgain.code, 0, "down must be safe to run twice");
    assert.match(downAgain.stdout, /nothing to tear down/);

    const envAfter = run(["env"]);
    assert.equal(envAfter.code, 1, "env must refuse once the instance has been torn down");
    assert.match(envAfter.stderr, /no instance is up/);
  });

  it("up self-heals a stale state file whose root was removed externally", () => {
    // PR gate re-review, post-merge-readiness pass. The stale case (pointer
    // present, root gone -- external cleanup, a temp reaper, a crashed `up`)
    // used to fall through readState()'s check silently, so this process
    // went on to create a fresh scratch tree and then collided on the "wx"
    // writeState against the SAME surviving file: it reported "another `up`
    // claimed the instance pointer first" when no concurrent run existed,
    // and "try up again" could never work, since every retry hits the
    // identical stale file. up now clears a stale pointer at the same place
    // it already decided the instance is dead, matching down's own
    // !existsSync(state.root) self-heal.
    const first = run(["up"]);
    assert.equal(first.code, 0, first.stdout);
    const firstDataDir = /HIVE_DATA_DIR=(\S+)/.exec(first.stdout)?.[1];
    assert.ok(firstDataDir, first.stdout);

    // External cleanup: the tree is gone, the state file survives.
    rmSync(dirname(firstDataDir), { recursive: true, force: true });

    try {
      const second = run(["up"]);
      assert.equal(second.code, 0, second.stdout);
      assert.match(second.stderr, /isolated hive instance up at/);
      assert.doesNotMatch(
        second.stderr,
        /claimed the instance pointer first/,
        "a stale pointer must self-heal, not be misreported as a concurrent race",
      );

      const secondDataDir = /HIVE_DATA_DIR=(\S+)/.exec(second.stdout)?.[1];
      assert.ok(secondDataDir, second.stdout);
      assert.notEqual(secondDataDir, firstDataDir, "must create a genuinely new root, not reuse the stale one");
    } finally {
      // The self-heal above genuinely succeeds and leaves a live instance,
      // unlike every other case in this describe block, which fails before
      // ever writing state. Leave the shared state file clean for whatever
      // test runs next.
      run(["down"]);
    }
  });

  it("down refuses, and deletes nothing, when the state file names a directory up never created", () => {
    // The wiring half of checkOwnsInstance's coverage: the unit tests above
    // pin the function itself, but deleting the call in cmdDown would leave
    // every one of them passing. This forges a state file at the exact path
    // the spawned script will read (statePath()'s own hash-of-REPO_DIR
    // scheme, replicated here) and asserts down refuses through the real
    // CLI, not just the pure function.
    const tag = createHash("sha256").update(realpathSync(REPO_DIR)).digest("hex").slice(0, 8);
    const forgedStatePath = join(scratchTmpDir, `hive-isolated-instance-${tag}.json`);
    const foreign = mkdtempSync(join(tmpdir(), "hive-iso-foreign-"));
    writeFileSync(
      forgedStatePath,
      JSON.stringify({ root: foreign, dataDir: join(foreign, "data"), tmuxTmpDir: join(foreign, "tmux"), createdAt: "now" }),
    );
    try {
      const result = run(["down"]);
      assert.equal(result.code, 1);
      assert.match(result.stderr, /has no hive-isolated marker/);
      assert.ok(existsSync(foreign), "down must not delete a directory it does not own");
    } finally {
      rmSync(forgedStatePath, { force: true });
      rmSync(foreign, { recursive: true, force: true });
    }
  });

  it("refuses an unknown subcommand, including inherited Object.prototype members", () => {
    // A plain {} lookup table resolves these via the prototype chain and
    // "succeeds" silently; COMMANDS must be null-prototype (or checked with
    // Object.hasOwn) so each of these hits the usage refusal instead.
    for (const bogus of ["bogus", "toString", "constructor", "hasOwnProperty"]) {
      const result = run([bogus]);
      assert.equal(result.code, 1, `expected "${bogus}" to be refused as an unknown subcommand, got exit ${result.code}`);
    }
  });

  // Both pin that a specific guard is actually WIRED into the CLI, not just
  // correct as a standalone function. Deleting checkDistFresh from
  // loadHiveDist's `??` chain, or deleting the whole firstFailure call from
  // cmdUp, left every other test in this file passing: the lifecycle test
  // above only ever runs `up` against a fresh dist and a fresh mkdtemp, so
  // neither guard's pure unit test is evidence about the script calling it
  // (counselors review on PR #48, opus finding 7).
  it("up refuses through the real wiring when the socket path is over the cap", () => {
    const longBase = mkdtempSync("/tmp/hi-long-");
    const longTmpDir = join(longBase, "x".repeat(90));
    mkdirSync(longTmpDir);
    try {
      execFileSync(process.execPath, [SCRIPT, "up"], { encoding: "utf8", env: { ...process.env, TMPDIR: longTmpDir } });
      assert.fail("expected up to refuse due to an over-cap socket path");
    } catch (e) {
      assert.equal(e.status, 1);
      assert.match(e.stderr ?? "", /socket path is \d+ bytes/);
    } finally {
      rmSync(longBase, { recursive: true, force: true });
    }
  });

  it("up refuses through the real wiring when dist is stale", () => {
    // Mutates a real repo file's MTIME, not its content, and restores it in
    // `finally`, so this is repeatable regardless of run order and leaves no
    // trace: content is untouched, so no rebuild is needed afterward.
    const probeFile = join(SRC_DIR, "tmux.ts");
    const before = statSync(probeFile);
    const future = new Date(Date.now() + 60_000);
    utimesSync(probeFile, future, future);
    try {
      const result = run(["up"]);
      assert.equal(result.code, 1, result.stdout);
      assert.match(result.stderr, /is older than src\//);
    } finally {
      utimesSync(probeFile, before.atime, before.mtime);
      run(["down"]); // in case `up` somehow got far enough to leave state
    }
  });

  it("down kills only the private tmux server it created, leaving the ambient/shared one alone", async () => {
    // The lifecycle test above never starts a real tmux server and has no
    // live process during `down`, so its "and only that tree" assertion
    // cannot detect deletion of an additional or substituted tree, and the
    // single most dangerous line in cmdDown -- the actual kill-server exec
    // -- never ran against a live server in any prior test (test
    // false-green audit, counselors review on PR #48). isolateTmux() at
    // this file's top already put the WHOLE FILE on its own private ambient
    // socket, standing in for "the developer's shared session" from
    // cmdDown's point of view: if down ever reached ambient TMUX_TMPDIR by
    // mistake, THIS session -- not some untouched real machine state -- is
    // what would die.
    const { tmuxSocketPath } = await import("../dist/tmux.js");
    const ambientSession = "ambient-guard";
    execFileSync("tmux", ["new-session", "-d", "-s", ambientSession]);
    try {
      const up = run(["up"]);
      assert.equal(up.code, 0, up.stdout);
      const tmuxTmpDir = /TMUX_TMPDIR=(\S+)/.exec(up.stdout)?.[1];
      assert.ok(tmuxTmpDir, up.stdout);
      const scratchSocket = tmuxSocketPath(undefined, tmuxTmpDir);

      execFileSync("tmux", ["new-session", "-d", "-s", "worker-under-test"], {
        env: { ...process.env, TMUX_TMPDIR: tmuxTmpDir },
      });
      // Confirm setup actually landed on the SCRATCH socket, not the
      // ambient one, before trusting the teardown assertion below.
      const beforeList = execFileSync("tmux", ["-S", scratchSocket, "list-sessions"], { encoding: "utf8" });
      assert.match(beforeList, /worker-under-test/);

      // A live session now makes a plain `down` refuse (the finding-2
      // mitigation); --force is the intentional-teardown escape hatch.
      const down = run(["down", "--force"]);
      assert.equal(down.code, 0, down.stdout);

      assert.throws(
        () => execFileSync("tmux", ["-S", scratchSocket, "list-sessions"], { stdio: "pipe" }),
        /./,
        "the private server's session must be reaped, not just its directory removed",
      );

      const ambientList = execFileSync("tmux", ["list-sessions"], { encoding: "utf8" });
      assert.match(ambientList, new RegExp(ambientSession), "the ambient/shared-standin session must survive untouched");
    } finally {
      try {
        execFileSync("tmux", ["kill-session", "-t", `=${ambientSession}`], { stdio: "ignore" });
      } catch {
        // Already gone.
      }
    }
  });
});
