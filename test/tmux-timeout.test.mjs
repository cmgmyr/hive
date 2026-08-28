import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import {
  assertScratchStore,
  clearHiveEnv,
  fakeFailingTmux,
  fakeHangingTmux,
  isolateTmux,
  REPO,
  runCli,
  scratchDirs,
  withEnv,
} from "./helpers.mjs";

isolateTmux("the tmux timeout tests");
const { dataDir } = scratchDirs();

clearHiveEnv();
process.env.HIVE_DATA_DIR = dataDir;
await assertScratchStore();

const { ensureSession, liveTargets, targetLiveProbe, tmux, TmuxError, tmuxSaysNothingThere, TmuxTimeoutError } =
  await import("../dist/tmux.js");

const fakeDir = fakeHangingTmux();

const logDir = mkdtempSync(join(tmpdir(), "hive-tmuxcalls-"));
after(() => {
  rmSync(fakeDir, { recursive: true, force: true });
  rmSync(logDir, { recursive: true, force: true });
});

function caught(fn) {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error("expected a throw, got none");
}

const withFakeTmux = (fn) =>
  withEnv({ PATH: `${fakeDir}:${process.env.PATH}`, HIVE_TMUX_TIMEOUT_MS: "300" }, fn);

describe("a tmux call that never answers", () => {
  it("is refused by tmuxSaysNothingThere BY TYPE, even carrying stderr that matches its pattern", () => {

    const stderr = "no server running on /tmp/tmux-501/default";

    assert.equal(tmuxSaysNothingThere(new TmuxError("tmux list-panes failed", stderr)), true);

    assert.equal(tmuxSaysNothingThere(new TmuxTimeoutError("tmux list-panes timed out", stderr, 10_000)), false);
  });

  it("is still a TmuxError, so every existing catch site keeps working", () => {
    const e = new TmuxTimeoutError("tmux list-panes timed out", "", 10_000);
    assert.ok(e instanceof TmuxError);
    assert.equal(e.name, "TmuxTimeoutError");
    assert.equal(e.notInstalled, false);
  });

  it("throws TmuxTimeoutError from a real, genuinely unanswered call", { timeout: 30_000 }, () => {
    withFakeTmux(() => {
      const started = Date.now();
      const e = caught(() => tmux("list-panes", "-t", "%0"));
      assert.ok(e instanceof TmuxTimeoutError, `expected a TmuxTimeoutError, got ${e}`);

      assert.ok(Date.now() - started < 10_000, "the call returned within the bound");
      assert.equal(e.timeoutMs, 300);
      assert.equal(tmuxSaysNothingThere(e), false);
    });
  });

  it("makes the liveness probes answer null (unknown), never false (gone)", { timeout: 30_000 }, () => {
    withFakeTmux(() => {

      assert.equal(targetLiveProbe("%0").live, null);
      assert.equal(targetLiveProbe("%0").pid, null);
      assert.equal(liveTargets(), null);
    });
  });

  it("stops at quietTmux's own probe rather than reading a timeout as 'no such session'", { timeout: 30_000 }, () => {

    const elapsedMs = [];
    for (let attempt = 1; ; attempt++) {
      const log = join(logDir, `ensure-session-calls-${attempt}`);
      const loggedFake = fakeHangingTmux({ log });
      try {
        const attemptStarted = Date.now();
        const calls = withEnv({ PATH: `${loggedFake}:${process.env.PATH}`, HIVE_TMUX_TIMEOUT_MS: "3000" }, () => {
          const started = Date.now();
          assert.throws(() => ensureSession("hive-timeout-probe", process.cwd(), { bare: true }), TmuxTimeoutError);
          assert.ok(Date.now() - started < 10_000, "the probe returned within its bound");
          return existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];
        });
        elapsedMs.push(Date.now() - attemptStarted);
        if (calls.length === 0 || calls[0] === "") {
          if (attempt < 3) continue;

          assert.fail(
            `the fake's log was never written after ${attempt} attempts (todo 404's fork-loses-the-race case); ` +
              `per-attempt elapsed ms: [${elapsedMs.join(", ")}]`,
          );
        }
        assert.deepEqual(
          calls,
          ["has-session"],
          "a timed-out has-session must throw, not flatten to false and fall through to new-session",
        );
        break;
      } finally {
        rmSync(loggedFake, { recursive: true, force: true });
      }
    }
  });

  it("makes `hive doctor` say so instead of reporting a green, empty world", async () => {

    const fakeDir = fakeHangingTmux({ hangOn: "ls" });
    try {
      const wedged = await runCli(["doctor"], {
        cwd: REPO,
        dataDir,
        env: { PATH: `${fakeDir}:${process.env.PATH}`, HIVE_TMUX_TIMEOUT_MS: "500" },
      });
      assert.match(wedged.stdout, /warn {2}tmux server: tmux did not answer/);
      assert.match(wedged.stdout, /sessions: unknown - tmux did not answer/);
      assert.match(wedged.stdout, /window stamps: unknown - tmux did not answer/);

      assert.doesNotMatch(wedged.stdout, /sessions: none running/);

      const healthy = await runCli(["doctor"], { cwd: REPO, dataDir });
      assert.doesNotMatch(healthy.stdout, /tmux did not answer/);
      assert.match(healthy.stdout, /ok {4}sessions: /);
    } finally {
      rmSync(fakeDir, { recursive: true, force: true });
    }
  });

  it("says unknown for a tmux failure that is not a timeout and not an answer either", async () => {

    const fakeDir = fakeFailingTmux({ failOn: "ls" });
    try {
      const unclassified = await runCli(["doctor"], {
        cwd: REPO,
        dataDir,
        env: { PATH: `${fakeDir}:${process.env.PATH}` },
      });
      assert.match(unclassified.stdout, /warn {2}tmux server: tmux did not answer/);
      assert.match(unclassified.stdout, /sessions: unknown - tmux did not answer/);
      assert.doesNotMatch(unclassified.stdout, /sessions: none running/);

      const answered = fakeFailingTmux({ failOn: "ls", stderr: "no server running on /tmp/tmux-501/default" });
      try {
        const empty = await runCli(["doctor"], {
          cwd: REPO,
          dataDir,
          env: { PATH: `${answered}:${process.env.PATH}` },
        });
        assert.doesNotMatch(empty.stdout, /tmux did not answer/);
        assert.match(empty.stdout, /sessions: none running/);
      } finally {
        rmSync(answered, { recursive: true, force: true });
      }
    } finally {
      rmSync(fakeDir, { recursive: true, force: true });
    }
  });

  it("is reported by execFileSync as code ETIMEDOUT, which is what the classification reads", () => {

    const e = caught(() =>
      execFileSync("sleep", ["5"], { timeout: 200, killSignal: "SIGKILL", stdio: ["ignore", "pipe", "pipe"] }),
    );
    assert.equal(e.code, "ETIMEDOUT");

    const failed = caught(() => execFileSync("sh", ["-c", "exit 3"], { stdio: ["ignore", "pipe", "pipe"] }));
    assert.equal(failed.code, undefined);
    assert.equal(failed.status, 3);
  });
});
