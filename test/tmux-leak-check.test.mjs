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

isolateTmux("the tmux leak check tests");

const { checkTmuxLeaks, describeLeaks, leakCheckFailed, probeScratchSocket } = await import("../scripts/tmux-leaks.mjs");

const made = [];
function leakedServer() {

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

    made.find((server) => server.socket === socket).reap();
    const green = checkTmuxLeaks(manifest);
    assert.equal(green.checked, 1);
    assert.deepEqual(green.leaks, [], "a reaped server must read clean on the same manifest");
  });

  it("counts a server that does not answer as a leak, not as clean", () => {

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

    const answering = fakeFailingTmux({ stderr: `no server running on ${socket}` });
    try {
      withEnv({ PATH: `${answering}:${process.env.PATH}` }, () => {
        assert.equal(probeScratchSocket(socket, { timeoutMs: 2000 }).state, "gone");
        assert.deepEqual(checkTmuxLeaks(manifest).leaks, []);
      });
    } finally {
      rmSync(answering, { recursive: true, force: true });
    }

    withEnv({ PATH: dirname(process.execPath) }, () => {
      assert.equal(probeScratchSocket(socket, { timeoutMs: 2000 }).state, "gone");
    });
  });

  it("settles and re-probes an unknown, so one transient fork failure is not a red run", () => {

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

    assert.equal(readFileSync(counter, "utf8").trim(), "2", "the unknown must have been re-probed exactly once");

  });

  it("keeps the socket directory when the exit handler's probe could not run", async () => {

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

        `execFileSync("tmux", ["new-session", "-d", "-s", "unknown", "sleep", "300"],\n` +
        `  { stdio: "ignore", timeout: 5000 });\n` +
        `console.log(JSON.stringify({ dir: process.env.TMUX_TMPDIR, socket }));\n` +

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

        const sessions = execFileSync("tmux", ["-S", socket, "list-sessions", "-F", "#{session_name}"], {
          encoding: "utf8",
          timeout: 5000,
        }).trim();
        assert.equal(sessions, "unknown");
      } finally {
        try {

          execFileSync("tmux", ["-S", socket, "kill-session", "-t", "=unknown"], {
            stdio: "ignore",
            timeout: 5000,
          });
        } catch {

        }
        rmSync(scratchDir, { recursive: true, force: true });
      }

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

    const manifest = manifestWith(join(tmpdir(), "hive-tmux-never-existed", "tmux-0", "default"));
    const result = checkTmuxLeaks(manifest);
    assert.equal(result.checked, 1);
    assert.deepEqual(result.leaks, []);
  });

  it("still runs the check when the wrapper itself is signalled", { timeout: 60_000 }, async () => {

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

      }
      rmSync(dirname(dirname(socket)), { recursive: true, force: true });
    }
  });

  it("reports a missing manifest rather than a clean run", () => {

    const result = checkTmuxLeaks(join(tmpdir(), "hive-leakmanifest-absent", "sockets"));
    assert.equal(result.manifestMissing, true);
    assert.equal(result.checked, 0);
  });

  it("fails a FULL run with no manifest, and passes a NAMED one", () => {

    const missing = { checked: 0, leaks: [], manifestMissing: true };
    assert.equal(leakCheckFailed(missing, { requireManifest: true }), true);
    assert.equal(leakCheckFailed(missing, { requireManifest: false }), false);

    const leaked = { checked: 1, leaks: [{ socket: "/x", state: "live", sessions: ["a"] }], manifestMissing: false };
    assert.equal(leakCheckFailed(leaked, { requireManifest: false }), true);
  });

  it("exits 0 for a named target that never touches tmux", async () => {

    const dir = mkdtempSync(join(tmpdir(), "hive-leakmanifest-"));
    made.push({ reap: () => rmSync(dir, { recursive: true, force: true }) });
    const target = join(dir, "no-tmux.test.mjs");
    writeFileSync(target, `import { test } from "node:test";\ntest("touches no tmux", () => {});\n`);

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

    const dir = mkdtempSync(join(tmpdir(), "hive-leakmanifest-"));
    made.push({ reap: () => rmSync(dir, { recursive: true, force: true }) });
    const script = join(dir, "no-server.mjs");
    writeFileSync(
      script,
      `import { isolateTmux } from ${JSON.stringify(join(REPO, "test", "helpers.mjs"))};\n` +
        `isolateTmux("a file that never starts a server");\n` +

        `console.log(process.env.TMUX_TMPDIR);\n`,
    );
    const { code, stdout } = await runNode(script, [], { cwd: REPO });
    assert.equal(code, 0);
    const scratchDir = stdout.trim();
    assert.match(scratchDir, /hive-tmux-/);
    assert.equal(existsSync(scratchDir), false, `isolateTmux left ${scratchDir} behind`);
  });

  it("is fed by isolateTmux, which records its socket the moment it is created", async () => {

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

    const dir = mkdtempSync(join(tmpdir(), "hive-leakmanifest-"));
    made.push({ reap: () => rmSync(dir, { recursive: true, force: true }) });
    const manifest = join(dir, "sockets");
    const script = join(dir, "clear-then-isolate.mjs");
    writeFileSync(
      script,
      `import { clearHiveEnv, isolateTmux } from ${JSON.stringify(join(REPO, "test", "helpers.mjs"))};\n` +

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
