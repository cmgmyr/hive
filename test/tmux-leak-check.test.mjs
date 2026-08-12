import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";

import {
  baseEnv,
  fakeFailingTmux,
  fakeHangingTmux,
  isolateTmux,
  REPO,
  runNode,
  scratchTmuxServer,
  until,
  withEnv,
} from "./helpers.mjs";

// Todo 375 item 3. A leaked test tmux server is silent, so it accumulates
// until something else falls over (todo 294: 227 alive at one point, then
// "fork failed: Device not configured"). `npm test` now asks every socket the
// suite created whether a server is still on it.
//
// A LEAK DETECTOR THAT CANNOT FAIL IS WORSE THAN NONE (test/CLAUDE.md), so
// every case here runs against a DELIBERATELY LEAKED, REAL tmux server, with
// the control being the same socket one teardown later - the thing that
// actually differs, not a query that would throw for a second reason.
isolateTmux("the tmux leak check tests");

const { checkTmuxLeaks, describeLeaks, leakCheckFailed, probeScratchSocket } = await import("../scripts/tmux-leaks.mjs");

const made = [];
function leakedServer() {
  // scratchTmuxServer (test/helpers.mjs) owns the shape, shared with
  // test/orphan-tmux-servers.test.mjs: two hand-copied derivations of
  // <tmpdir>/<prefix>/tmux-<uid>/default both have to stay in step with
  // src/tmux.ts's socketUnder() for either file to be testing anything.
  const server = scratchTmuxServer({ prefix: "hive-tmux-leaktest-", session: "leaked" });
  made.push(server);
  return server.socket;
}

function manifestWith(...sockets) {
  const dir = mkdtempSync(join(tmpdir(), "hive-leakmanifest-"));
  const file = join(dir, "sockets");
  writeFileSync(file, sockets.map((s) => `${s}\n`).join(""));
  made.push({ reap: () => rmSync(dir, { recursive: true, force: true }) });
  return file;
}

after(() => {
  for (const server of made) server.reap();
});

describe("the run-level tmux leak check", () => {
  it("goes red against a deliberately leaked server, and green once it is reaped", () => {
    const socket = leakedServer();
    const manifest = manifestWith(socket);

    const red = checkTmuxLeaks(manifest);
    assert.equal(red.checked, 1);
    assert.equal(red.leaks.length, 1, "a live server on a socket the suite created is a leak");
    assert.equal(red.leaks[0].socket, socket);
    assert.equal(red.leaks[0].state, "live");
    assert.deepEqual(red.leaks[0].sessions, ["leaked"]);

    // THE CONTROL, and it is the one that makes this file mean anything: the
    // IDENTICAL manifest and the IDENTICAL socket path, one teardown later.
    // Todo 294's own positive control failed exactly here - it asserted that
    // querying the socket throws, which is also true when the socket FILE is
    // gone, so it passed with the kill removed entirely.
    made.find((server) => server.socket === socket).reap();
    const green = checkTmuxLeaks(manifest);
    assert.equal(green.checked, 1);
    assert.deepEqual(green.leaks, [], "a reaped server must read clean on the same manifest");
  });

  it("counts a server that does not answer as a leak, not as clean", () => {
    // The wedged case. It is the one an unbounded check cannot report at all,
    // because it hangs instead - so it is also the one worth proving is not
    // silently classified as "gone".
    const socket = leakedServer();
    const fakeDir = fakeHangingTmux();
    try {
      withEnv({ PATH: `${fakeDir}:${process.env.PATH}` }, () => {
        const started = Date.now();
        const probe = probeScratchSocket(socket, { timeoutMs: 300 });
        assert.equal(probe.state, "wedged");
        assert.ok(Date.now() - started < 5000, "the probe is bounded, or the check hangs the run it reports on");
      });
    } finally {
      rmSync(fakeDir, { recursive: true, force: true });
    }
  });

  it("counts a probe that could not RUN as unknown, never as gone", () => {
    // COUNSELORS ROUND 2, F5. Every non-ETIMEDOUT failure used to classify as
    // "gone", which includes EAGAIN and EMFILE - process and fd exhaustion,
    // the exact state this detector exists to catch. The sequence the codex
    // seat named: kill-server fails, the survivor probe then fails to SPAWN,
    // the handler calls it gone and deletes the socket directory, and the
    // run-level check finds no socket and reports clean. An unknown result
    // manufactures the one gap this script already admits to having.
    const socket = leakedServer();
    const fakeDir = fakeFailingTmux();
    const manifest = manifestWith(socket);
    try {
      withEnv({ PATH: `${fakeDir}:${process.env.PATH}` }, () => {
        const probe = probeScratchSocket(socket, { timeoutMs: 2000 });
        assert.equal(probe.state, "unknown", "a probe that could not run proves nothing about the server");
        assert.match(probe.reason, /operation not permitted/);

        const result = checkTmuxLeaks(manifest);
        assert.equal(result.leaks.length, 1, "an unknown socket is not a clean one");
        assert.equal(result.leaks[0].state, "unknown");
        assert.equal(leakCheckFailed(result), true);
        assert.match(describeLeaks(result).join("\n"), /UNKNOWN \(the probe itself failed/);
      });
    } finally {
      rmSync(fakeDir, { recursive: true, force: true });
    }

    // THE CONTROL, and it is the whole difficulty of this fix: tmux's own
    // answer must still read as gone, or every ordinary clean run goes red.
    // "no server running on <path>" is what a REAPED socket answers, because
    // kill-server does not unlink the socket file.
    const answering = fakeFailingTmux({ stderr: `no server running on ${socket}` });
    try {
      withEnv({ PATH: `${answering}:${process.env.PATH}` }, () => {
        assert.equal(probeScratchSocket(socket, { timeoutMs: 2000 }).state, "gone");
        assert.deepEqual(checkTmuxLeaks(manifest).leaks, []);
      });
    } finally {
      rmSync(answering, { recursive: true, force: true });
    }

    // And the second control, for the machine with no tmux at all: every
    // socket in the manifest would read unknown and fail an otherwise clean
    // run, since isolateTmux records its socket before it checks for tmux.
    withEnv({ PATH: dirname(process.execPath) }, () => {
      assert.equal(probeScratchSocket(socket, { timeoutMs: 2000 }).state, "gone");
    });
  });

  it("settles and re-probes an unknown, so one transient fork failure is not a red run", () => {
    // PR GATE, on the code fix round 2 wrote. F5 gave isolateTmux's exit
    // handler a settle-and-retry for an inconclusive reading and this
    // run-level gate did not inherit it, so a SINGLE unknown failed the whole
    // `npm test`. The scenario is the one F5's own argument describes: ~120
    // sockets probed in sequence, one fork each, immediately after a
    // `node --test` run whose processes are still being reaped - one EAGAIN in
    // that burst and a clean run goes red. A false red, which is precisely
    // why it is a fix and not an accept: a detector that cries wolf gets
    // deleted.
    //
    // The server here is genuinely REAPED before the check runs, so the
    // retry's answer is the truth rather than a fixture's opinion; the fake
    // only injects the transient failure on the FIRST call and passes
    // everything after it through to the real tmux.
    const socket = leakedServer();
    made.find((server) => server.socket === socket).reap();

    const dir = mkdtempSync(join(tmpdir(), "hive-flakyprobe-"));
    made.push({ reap: () => rmSync(dir, { recursive: true, force: true }) });
    const counter = join(dir, "calls");
    const real = execFileSync("which", ["tmux"], { encoding: "utf8" }).trim();
    writeFileSync(
      join(dir, "tmux"),
      `#!/bin/sh\n` +
        `n=$(cat ${JSON.stringify(counter)} 2>/dev/null || echo 0)\n` +
        `n=$((n+1))\n` +
        `echo "$n" > ${JSON.stringify(counter)}\n` +
        // EAGAIN's own wording, and NOT one NOTHING_THERE matches - a fork
        // that never ran says nothing about the server.
        `if [ "$n" = "1" ]; then printf '%s\\n' "tmux: resource temporarily unavailable" >&2; exit 1; fi\n` +
        `exec ${real} "$@"\n`,
      { mode: 0o755 },
    );

    const manifest = manifestWith(socket);
    withEnv({ PATH: `${dir}:${process.env.PATH}` }, () => {
      const result = checkTmuxLeaks(manifest);
      assert.deepEqual(result.leaks, [], "one transient probe failure must not fail the run");
      assert.equal(result.checked, 1);
    });
    // THE DISCRIMINATOR: two calls, not one. Without it, a check that somehow
    // probed nothing at all would satisfy the assertion above just as well.
    assert.equal(readFileSync(counter, "utf8").trim(), "2", "the unknown must have been re-probed exactly once");

    // The retry does NOT rescue a persistent unknown - that case is the test
    // above ("counts a probe that could not RUN as unknown"), whose fake fails
    // every call and still fails the run.
  });

  it("keeps the socket directory when the exit handler's probe could not run", async () => {
    // The same finding at the destructive end. This handler DELETES the
    // directory on "gone", and that directory holds the socket file backing a
    // live server's own listener - removing it is what made todo 294's leaks
    // unreachable forever. Both arms run the identical child; only the PATH
    // the exit handler resolves tmux on differs.
    const dir = mkdtempSync(join(tmpdir(), "hive-leakmanifest-"));
    made.push({ reap: () => rmSync(dir, { recursive: true, force: true }) });
    const script = join(dir, "unknown-probe.mjs");
    writeFileSync(
      script,
      `import { execFileSync } from "node:child_process";\n` +
        `import { join } from "node:path";\n` +
        `import { isolateTmux } from ${JSON.stringify(join(REPO, "test", "helpers.mjs"))};\n` +
        `isolateTmux("a file whose survivor probe cannot run");\n` +
        `const socket = join(process.env.TMUX_TMPDIR, \`tmux-\${process.getuid()}\`, "default");\n` +
        // Through TMUX_TMPDIR, the way every real test file makes its server:
        // tmux creates the uid directory itself that way, and does NOT create
        // the parent of a `-S` path (measured - it prints "error creating"
        // and exits 0, so a -S here would leave no socket at all and this
        // test would silently exercise nothing).
        `execFileSync("tmux", ["new-session", "-d", "-s", "unknown", "sleep", "300"],\n` +
        `  { stdio: "ignore", timeout: 5000 });\n` +
        `console.log(JSON.stringify({ dir: process.env.TMUX_TMPDIR, socket }));\n` +
        // Prepending AFTER the server exists, so only the exit handler's own
        // calls resolve to the fake: kill-server fails, and the probe that
        // verifies it fails the same way.
        `if (process.env.HIVE_TEST_FAKE_TMUX) process.env.PATH = process.env.HIVE_TEST_FAKE_TMUX + ":" + process.env.PATH;\n`,
    );

    const fakeDir = fakeFailingTmux();
    try {
      const blind = await runNode(script, [], { cwd: REPO, env: { HIVE_TEST_FAKE_TMUX: fakeDir } });
      const { dir: scratchDir, socket } = JSON.parse(blind.stdout.trim());
      try {
        assert.equal(blind.code, 1, blind.stdout + blind.stderr);
        assert.match(blind.stderr, /could not be probed/);
        assert.equal(existsSync(scratchDir), true, "an unproven kill must not take the socket file with it");
        // Read from tmux, not from the handler's words: the server this test
        // is protecting really is still there.
        const sessions = execFileSync("tmux", ["-S", socket, "list-sessions", "-F", "#{session_name}"], {
          encoding: "utf8",
          timeout: 5000,
        }).trim();
        assert.equal(sessions, "unknown");
      } finally {
        try {
          // kill-session, not the other verb: test/suite-isolation.test.mjs
          // forbids that one by name in any test file, and tmux's own
          // `exit-empty on` takes the server down with its last session -
          // the same reasoning scratchTmuxServer's reap() carries.
          execFileSync("tmux", ["-S", socket, "kill-session", "-t", "=unknown"], {
            stdio: "ignore",
            timeout: 5000,
          });
        } catch {
          // Already gone.
        }
        rmSync(scratchDir, { recursive: true, force: true });
      }

      // THE CONTROL: the identical child with the real tmux on PATH kills its
      // own server, gets a real ANSWER back, and removes the directory.
      // Without it, "the directory survived" would pass against a handler
      // that never cleans up at all.
      //
      // Both arms exit 1 - this one for the todo 294 report, since the child
      // leaves a session it never threaded through cleanup() - so the exit
      // code is not the discriminator here. The DIRECTORY is, and so is which
      // sentence the handler printed.
      const seeing = await runNode(script, [], { cwd: REPO });
      const { dir: cleanDir } = JSON.parse(seeing.stdout.trim());
      assert.match(seeing.stderr, /left tmux session\(s\) behind/);
      assert.doesNotMatch(seeing.stderr, /could not be probed/);
      assert.equal(existsSync(cleanDir), false, `a probe that ANSWERED must still clean up, left ${cleanDir}`);
    } finally {
      rmSync(fakeDir, { recursive: true, force: true });
    }
  });

  it("does not go red for a socket that never had a server", () => {
    // A detector that fires on debris nobody caused gets ignored, then
    // removed. The manifest names sockets the suite created; one whose server
    // was never started, or whose directory is already gone, is clean.
    const manifest = manifestWith(join(tmpdir(), "hive-tmux-never-existed", "tmux-0", "default"));
    const result = checkTmuxLeaks(manifest);
    assert.equal(result.checked, 1);
    assert.deepEqual(result.leaks, []);
  });

  it("still runs the check when the wrapper itself is signalled", { timeout: 60_000 }, async () => {
    // COUNSELORS ROUND 2, F8. The wrapper installed no signal handlers, so a
    // supervisor signalling IT rather than the process group killed it before
    // the check ran - and CI sets cancel-in-progress: true. The wrapper's own
    // header argues it exists BECAUSE a killed run is the one most likely to
    // have leaked, so this was the script failing its own stated reason.
    //
    // End to end through the real wrapper, against a real leaked server: the
    // target file starts one, says so, and then sleeps until it is killed.
    // A default-disposition SIGTERM runs no exit handlers in that child
    // (measured, todo 375 comment 899), so nothing but the manifest can name
    // what it left.
    const dir = mkdtempSync(join(tmpdir(), "hive-leakmanifest-"));
    made.push({ reap: () => rmSync(dir, { recursive: true, force: true }) });
    const marker = join(dir, "socket-path");
    const target = join(dir, "killed.test.mjs");
    writeFileSync(
      target,
      `import { test } from "node:test";\n` +
        `import { execFileSync } from "node:child_process";\n` +
        `import { writeFileSync } from "node:fs";\n` +
        `import { isolateTmux, tmuxSocketUnder } from ${JSON.stringify(join(REPO, "test", "helpers.mjs"))};\n` +
        `isolateTmux("a run that gets killed");\n` +
        `test("starts a server and waits to be killed", { timeout: 120000 }, async () => {\n` +
        `  execFileSync("tmux", ["new-session", "-d", "-s", "killed-run", "sleep", "300"], { stdio: "ignore" });\n` +
        `  writeFileSync(${JSON.stringify(marker)}, tmuxSocketUnder(process.env.TMUX_TMPDIR));\n` +
        `  await new Promise((resolve) => setTimeout(resolve, 60000));\n` +
        `});\n`,
    );

    // NODE_TEST_CONTEXT has to go, and finding out why is worth recording:
    // node --test REFUSES TO RUN FILES when it sees that variable inherited
    // from the test process that spawned it ("run() is being called
    // recursively within a test file. skipping running files"), so the target
    // silently never runs and the wrapper reports "nothing to check" on a run
    // that did nothing. HIVE_DATA_DIR is set even though this fixture never
    // touches the store, because dropping NODE_TEST_CONTEXT also drops
    // storeDir()'s refusal of the real ~/.hive (test/CLAUDE.md).
    const env = { ...baseEnv(), HIVE_DATA_DIR: join(dir, "data") };
    delete env.NODE_TEST_CONTEXT;
    const wrapper = spawn(process.execPath, [join(REPO, "scripts", "run-tests.mjs"), target], {
      cwd: REPO,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    wrapper.stdout.on("data", (c) => (out += c));
    wrapper.stderr.on("data", (c) => (out += c));
    // The server has to exist before the signal, or this measures a race
    // rather than the handler.
    assert.equal(await until(() => existsSync(marker), 30_000), true, `the target file never started its server:\n${out}`);
    const socket = readFileSync(marker, "utf8").trim();
    try {
      wrapper.kill("SIGTERM");
      const code = await new Promise((resolve) => wrapper.on("exit", resolve));
      assert.notEqual(code, 0, out);
      assert.match(out, /tmux leak check FAILED/, out);
      assert.ok(out.includes(socket), `the leaked socket must be named:\n${out}`);
    } finally {
      try {
        execFileSync("tmux", ["-S", socket, "kill-session", "-t", "=killed-run"], {
          stdio: "ignore",
          timeout: 5000,
        });
      } catch {
        // Already gone.
      }
      rmSync(dirname(dirname(socket)), { recursive: true, force: true });
    }
  });

  it("reports a missing manifest rather than a clean run", () => {
    // No manifest means no test file called isolateTmux(), which cannot be
    // true of this suite - so it is a failure of the check itself, not a
    // green run. Without this branch, breaking the wiring below would report
    // "no leaks" forever.
    const result = checkTmuxLeaks(join(tmpdir(), "hive-leakmanifest-absent", "sockets"));
    assert.equal(result.manifestMissing, true);
    assert.equal(result.checked, 0);
  });

  it("fails a FULL run with no manifest, and passes a NAMED one", () => {
    // PR gate, fix round 1, both directions. The full file list is built by
    // scripts/run-tests.mjs itself, and test/CLAUDE.md requires every
    // hive-reaching file in it to call isolateTmux() - so no manifest there
    // means the wiring broke and the check silently stopped covering
    // anything. A NAMED target is the caller's list, and plenty of
    // legitimate targets never touch tmux: `npm test -- test/db.test.mjs`
    // exited 1 with "tmux leak check FAILED" on a clean pass.
    const missing = { checked: 0, leaks: [], manifestMissing: true };
    assert.equal(leakCheckFailed(missing, { requireManifest: true }), true);
    assert.equal(leakCheckFailed(missing, { requireManifest: false }), false);

    // A REAL leak is a failure either way - the relaxation is about the
    // manifest's absence, never about what a manifest that exists reported.
    const leaked = { checked: 1, leaks: [{ socket: "/x", state: "live", sessions: ["a"] }], manifestMissing: false };
    assert.equal(leakCheckFailed(leaked, { requireManifest: false }), true);
  });

  it("exits 0 for a named target that never touches tmux", async () => {
    // The gate's own repro, end to end through the real wrapper. Only this
    // direction is affordable here: proving the FULL-run direction the same
    // way means running the entire suite inside the suite, so its verdict is
    // pinned at the boundary above instead.
    const dir = mkdtempSync(join(tmpdir(), "hive-leakmanifest-"));
    made.push({ reap: () => rmSync(dir, { recursive: true, force: true }) });
    const target = join(dir, "no-tmux.test.mjs");
    writeFileSync(target, `import { test } from "node:test";\ntest("touches no tmux", () => {});\n`);
    // NODE_TEST_CONTEXT undefined: inherited from this test process, node
    // --test skips running the file entirely and prints a recursion warning,
    // so the wrapper's "nothing to check" line would have been produced by a
    // run that never happened. Found while writing the signal test below.
    const { code, stdout } = await runNode(join(REPO, "scripts", "run-tests.mjs"), [target], {
      cwd: REPO,
      env: { NODE_TEST_CONTEXT: undefined },
    });
    assert.equal(code, 0, stdout);
    assert.match(stdout, /pass 1/, `the target must actually have run:\n${stdout}`);
    assert.match(stdout, /nothing to check: the named target\(s\) never isolated a tmux server/);
    assert.doesNotMatch(stdout, /tmux leak check FAILED/);
  });

  it("removes its scratch directory even when no server was ever started on the socket", async () => {
    // PR gate, fix round 1. The survivor check is gated on the socket FILE
    // existing (a file whose tmux never ran cannot have left a server), and
    // the first shape of that gate was an early `return` sitting above the
    // rmSync - so every file that calls isolateTmux() without creating a
    // session leaked its scratch directory on every run. test/CLAUDE.md
    // requires that call of every hive-reaching file, and plenty of them
    // never issue a new-session (test/wire-surface.test.mjs among them), so
    // this is the common path, not an exotic one.
    const dir = mkdtempSync(join(tmpdir(), "hive-leakmanifest-"));
    made.push({ reap: () => rmSync(dir, { recursive: true, force: true }) });
    const script = join(dir, "no-server.mjs");
    writeFileSync(
      script,
      `import { isolateTmux } from ${JSON.stringify(join(REPO, "test", "helpers.mjs"))};\n` +
        `isolateTmux("a file that never starts a server");\n` +
        // The directory under test is the one isolateTmux just made, so the
        // child names it rather than the parent guessing at a mkdtemp suffix.
        `console.log(process.env.TMUX_TMPDIR);\n`,
    );
    const { code, stdout } = await runNode(script, [], { cwd: REPO });
    assert.equal(code, 0);
    const scratchDir = stdout.trim();
    assert.match(scratchDir, /hive-tmux-/);
    assert.equal(existsSync(scratchDir), false, `isolateTmux left ${scratchDir} behind`);
  });

  it("is fed by isolateTmux, which records its socket the moment it is created", async () => {
    // END TO END over the wiring, because everything above tests the checker
    // against a manifest this file wrote by hand. If isolateTmux stopped
    // appending, every assertion above would still pass and the real run
    // would check nothing at all.
    const dir = mkdtempSync(join(tmpdir(), "hive-leakmanifest-"));
    made.push({ reap: () => rmSync(dir, { recursive: true, force: true }) });
    const manifest = join(dir, "sockets");
    const script = join(dir, "isolate.mjs");
    writeFileSync(
      script,
      `import { isolateTmux } from ${JSON.stringify(join(REPO, "test", "helpers.mjs"))};\n` +
        `isolateTmux("a probe of the manifest wiring");\n`,
    );
    const { code } = await runNode(script, [], {
      cwd: REPO,
      env: { HIVE_TMUX_LEAK_MANIFEST: manifest },
    });
    assert.equal(code, 0);
    const recorded = readFileSync(manifest, "utf8").trim().split("\n");
    assert.equal(recorded.length, 1);
    assert.match(recorded[0], /hive-tmux-.*\/tmux-\d+\/default$/);
  });

  it("records a SECOND, bespoke socket when the file registers it", async () => {
    // Counselors round 2 (F6). isolateTmux appends only the file's own
    // socket, and four files start a server on a bespoke TMUX_TMPDIR of their
    // own - those were invisible to this check AND to the ps guard, which
    // says in its own header that it cannot see two of them. They call
    // recordScratchTmuxSocket now; this pins that the call actually reaches
    // the manifest, since the four call sites themselves assert nothing about
    // it.
    const dir = mkdtempSync(join(tmpdir(), "hive-leakmanifest-"));
    made.push({ reap: () => rmSync(dir, { recursive: true, force: true }) });
    const manifest = join(dir, "sockets");
    const script = join(dir, "second-socket.mjs");
    writeFileSync(
      script,
      `import { isolateTmux, recordScratchTmuxSocket, tmuxSocketUnder } from ${JSON.stringify(join(REPO, "test", "helpers.mjs"))};\n` +
        `isolateTmux("a file with a second server of its own");\n` +
        `recordScratchTmuxSocket(tmuxSocketUnder("/tmp/hive-bespoke-server"));\n`,
    );
    const { code } = await runNode(script, [], { cwd: REPO, env: { HIVE_TMUX_LEAK_MANIFEST: manifest } });
    assert.equal(code, 0);
    const recorded = readFileSync(manifest, "utf8").trim().split("\n");
    assert.equal(recorded.length, 2, "the file's own socket AND the one it registered");
    assert.ok(
      recorded.some((line) => line === `/tmp/hive-bespoke-server/tmux-${process.getuid()}/default`),
      `expected the bespoke socket in:\n${recorded.join("\n")}`,
    );
  });

  it("still records the socket when the file cleared HIVE_* first", async () => {
    // Counselors round 2. clearHiveEnv() deletes EVERY HIVE_* key, the
    // manifest variable included, and isolateTmux used to read that variable
    // at call time - so a file calling them in this order dropped its own
    // socket from the manifest, and the run still reported every socket it
    // did receive as "all gone". Latent when it was found (no file violates
    // the order today), which is exactly why nothing would have caught the
    // first one that did.
    const dir = mkdtempSync(join(tmpdir(), "hive-leakmanifest-"));
    made.push({ reap: () => rmSync(dir, { recursive: true, force: true }) });
    const manifest = join(dir, "sockets");
    const script = join(dir, "clear-then-isolate.mjs");
    writeFileSync(
      script,
      `import { clearHiveEnv, isolateTmux } from ${JSON.stringify(join(REPO, "test", "helpers.mjs"))};\n` +
        // The order that used to lose the socket. Red against a call-time
        // read of process.env, green against the module-scope capture.
        `clearHiveEnv();\n` +
        `isolateTmux("a file that clears the environment first");\n`,
    );
    const { code } = await runNode(script, [], { cwd: REPO, env: { HIVE_TMUX_LEAK_MANIFEST: manifest } });
    assert.equal(code, 0);
    const recorded = readFileSync(manifest, "utf8").trim().split("\n");
    assert.equal(recorded.length, 1, "clearHiveEnv() must not be able to drop a socket from the manifest");
    assert.match(recorded[0], /hive-tmux-.*\/tmux-\d+\/default$/);
  });
});
