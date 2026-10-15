import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { isolateTmux, resolvedTmuxSocket, tmux, until } from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("the harness tmux kill tests");
const skip = hasTmux ? false : "tmux is not installed";

const isAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code !== "ESRCH";
  }
};

const startSession = (name) => tmux("new-session", "-d", "-s", name, "sleep", "600");
const serverPid = () => Number(tmux("display-message", "-p", "#{pid}"));

describe("a harness kill that empties the private server waits for that server to exit", () => {
  it("cleanup() on a socket with no server starts none", { skip }, () => {
    cleanup(`hive-harness-never-${process.pid}`);
    assert.equal(existsSync(resolvedTmuxSocket()), false);
  });

  it("cleanup() of the last session returns only after the server pid is gone", { skip }, () => {
    const session = `hive-harness-last-${process.pid}`;
    startSession(session);
    const pid = serverPid();
    cleanup(session);
    assert.equal(isAlive(pid), false, `server ${pid} still running when cleanup() returned`);
  });

  it("tmux('kill-session') of the last session returns only after the server pid is gone", { skip }, () => {
    const session = `hive-harness-helper-${process.pid}`;
    startSession(session);
    const pid = serverPid();
    tmux("kill-session", "-t", `=${session}`);
    assert.equal(isAlive(pid), false, `server ${pid} still running when tmux() returned`);
  });

  it("cleanup() of one of two sessions returns at once and leaves the server answering", { skip }, () => {
    const [kept, killed] = [`hive-harness-kept-${process.pid}`, `hive-harness-gone-${process.pid}`];
    startSession(kept);
    startSession(killed);
    const pid = serverPid();
    const started = Date.now();
    cleanup(killed);
    assert.ok(Date.now() - started < 2000, "a kill that leaves sessions behind must not wait for an exit");
    assert.equal(isAlive(pid), true);
    assert.deepEqual(tmux("list-sessions", "-F", "#{session_name}").split("\n"), [kept]);
    cleanup(kept);
    assert.equal(isAlive(pid), false);
  });

  it("cleanup() throws a named error when the emptied server is held up past the bound", { skip }, async () => {
    const session = `hive-harness-held-${process.pid}`;
    const flags = mkdtempSync(join(tmpdir(), "hive-harness-hold-"));
    const [ready, release] = [join(flags, "ready"), join(flags, "release")];
    startSession(session);
    const pid = serverPid();
    const socket = resolvedTmuxSocket();
    const job = `touch '${ready}'; while [ ! -e '${release}' ]; do sleep 0.05; done`;
    const holder = spawn("tmux", ["-S", socket, "run-shell", job], { stdio: "ignore" });
    try {
      assert.ok(await until(() => existsSync(ready), 5000), "the holding run-shell job never started");
      assert.throws(() => cleanup(session), /had not exited/);
      assert.equal(isAlive(pid), true, "the held server must still be running when the bound error is thrown");
    } finally {
      writeFileSync(release, "");
      await until(() => holder.exitCode !== null, 5000);
      rmSync(flags, { recursive: true, force: true });
    }
    assert.ok(await until(() => !isAlive(pid), 5000), "releasing the job must let the emptied server exit");
  });
});
