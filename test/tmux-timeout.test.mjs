import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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

// Todo 375. tmux() had no timeout, so one wedged tmux server could hang a
// caller forever at 100% CPU (measured: 1h34m of a burning core). Bounding it
// is the easy half. THE HALF THAT DECIDES WHETHER THE FIX IS GOOD OR HARMFUL
// is what a timed-out call MEANS: every liveness path in this project rests on
// `false` (tmux answered, the target is not there) versus `null` (tmux never
// answered), and a timeout read as `false` reaps live workers - the exact
// failure the bound exists to prevent, arriving through the fix for it.
//
// So these tests pin the CLASSIFICATION, not the number.
isolateTmux("the tmux timeout tests");
const { dataDir } = scratchDirs();

clearHiveEnv();
process.env.HIVE_DATA_DIR = dataDir;
await assertScratchStore();

const { ensureSession, liveTargets, targetLiveProbe, tmux, TmuxError, tmuxSaysNothingThere, TmuxTimeoutError } =
  await import("../dist/tmux.js");

// A `tmux` that never answers, which is what a wedged server looks like from
// here (fakeHangingTmux, test/helpers.mjs, carries the `exec sleep` reasoning).
const fakeDir = fakeHangingTmux();
// Somewhere for the call-counting fake below to write its log. Its own
// directory rather than the fake's, so removing the fake cannot take the
// evidence with it.
const logDir = mkdtempSync(join(tmpdir(), "hive-tmuxcalls-"));
after(() => {
  rmSync(fakeDir, { recursive: true, force: true });
  rmSync(logDir, { recursive: true, force: true });
});

// assert.throws() returns nothing, and every assertion here is about the
// error's own fields, so the error itself has to be caught rather than
// matched.
function caught(fn) {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error("expected a throw, got none");
}

// PATH is restored in a finally, and that is load-bearing rather than tidy:
// isolateTmux()'s own exit handler shells out to the REAL tmux to kill this
// file's server, and a fake left on PATH would make that handler wait out its
// own 5s bound and then leave a live server behind.
//
// HIVE_TMUX_TIMEOUT_MS (testing only, and `hive doctor` reports it when set)
// is what keeps this file fast: the production bound is ten seconds, and it
// can only expire in real time.
const withFakeTmux = (fn) =>
  withEnv({ PATH: `${fakeDir}:${process.env.PATH}`, HIVE_TMUX_TIMEOUT_MS: "300" }, fn);

describe("a tmux call that never answers", () => {
  it("is refused by tmuxSaysNothingThere BY TYPE, even carrying stderr that matches its pattern", () => {
    // The stderr fixture is a real tmux wording from NOTHING_THERE's own list.
    const stderr = "no server running on /tmp/tmux-501/default";

    // CONTROL FIRST, and it is what makes the assertion below able to fail.
    // Without it, "a timeout does not read as absence" would pass just as
    // happily against a fixture whose text never matched anything - the
    // assertion-satisfied-by-two-indistinguishable-causes shape in
    // test/CLAUDE.md. This proves the text genuinely IS classified as absence
    // when it arrives on an ordinary TmuxError.
    assert.equal(tmuxSaysNothingThere(new TmuxError("tmux list-panes failed", stderr)), true);

    // THE HEADLINE. Same text, killed call: never answered is not an answer.
    // Red against the pre-fix behaviour, where this error would have been a
    // plain TmuxError carrying that stderr and classified as "gone".
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
      // The bound is a bound: this returns rather than hanging, which is the
      // whole defect. Generous ceiling - what would fail here is not being
      // slow, it is never coming back at all.
      assert.ok(Date.now() - started < 10_000, "the call returned within the bound");
      assert.equal(e.timeoutMs, 300);
      assert.equal(tmuxSaysNothingThere(e), false);
    });
  });

  it("makes the liveness probes answer null (unknown), never false (gone)", { timeout: 30_000 }, () => {
    withFakeTmux(() => {
      // false here is what closes a live worker's row, ends a lane mid-turn,
      // and cancels its pending wakes. null holds everything instead.
      assert.equal(targetLiveProbe("%0").live, null);
      assert.equal(targetLiveProbe("%0").pid, null);
      assert.equal(liveTargets(), null);
    });
  });

  it("stops at quietTmux's own probe rather than reading a timeout as 'no such session'", { timeout: 30_000 }, () => {
    // COUNSELORS ROUND 2, F2, AND THE COMMENT THIS REPLACES DESCRIBED THE
    // BEHAVIOUR THE LANE REMOVED. It said quietTmux answers false on a
    // timeout and falls through to new-session - the pre-/simplify
    // flattening - and the assertion below it could not tell the two apart:
    // new-session times out too, throwing the SAME TYPE inside the SAME
    // bound, so deleting quietTmux's rethrow kept the whole suite green while
    // freeViewSessionName went back to reading every candidate name as FREE
    // against a wedged server. test/CLAUDE.md's shape 7, in the headline file
    // of the lane that cites that catalogue.
    //
    // So this counts the PROBE. With the rethrow, has-session throws and
    // new-session is never reached; without it, both are called. The call log
    // is the only thing that differs.
    const log = join(logDir, "ensure-session-calls");
    const loggedFake = fakeHangingTmux({ log });
    try {
      withEnv({ PATH: `${loggedFake}:${process.env.PATH}`, HIVE_TMUX_TIMEOUT_MS: "300" }, () => {
        const started = Date.now();
        assert.throws(() => ensureSession("hive-timeout-probe", process.cwd()), TmuxTimeoutError);
        assert.ok(Date.now() - started < 10_000, "the probe returned within its bound");
        const calls = readFileSync(log, "utf8").trim().split("\n");
        assert.deepEqual(
          calls,
          ["has-session"],
          "a timed-out has-session must throw, not flatten to false and fall through to new-session",
        );
      });
    } finally {
      rmSync(loggedFake, { recursive: true, force: true });
    }
  });

  it("makes `hive doctor` say so instead of reporting a green, empty world", async () => {
    // PR gate, fix round 1, and the argument the lead overrode me with:
    // doctor does not print "what it could see", it prints `sessions: none
    // running` and `window stamps: no session` as green ok lines, which are
    // ASSERTIONS and are false when tmux never answered. The scenario is this
    // todo's own - the LIVE server wedges - and orphanScratchServers()
    // excludes the live socket by design, so nothing else in the output would
    // have said the server hive is talking to is unreachable.
    //
    // hangOn: "ls" rather than a blanket hang, so `tmux -V` (deliberately
    // unbounded, answered client-side) still returns and the run reaches the
    // read under test.
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
      // The claim that must NOT be made about a server that never answered.
      assert.doesNotMatch(wedged.stdout, /sessions: none running/);

      // CONTROL, on the same machine and the same store: with a tmux that
      // answers, doctor says none of that. Without it, an assertion on a
      // string doctor might never print in any world would pass just as well.
      const healthy = await runCli(["doctor"], { cwd: REPO, dataDir });
      assert.doesNotMatch(healthy.stdout, /tmux did not answer/);
      assert.match(healthy.stdout, /ok {4}sessions: /);
    } finally {
      rmSync(fakeDir, { recursive: true, force: true });
    }
  });

  it("says unknown for a tmux failure that is not a timeout and not an answer either", async () => {
    // COUNSELORS ROUND 2, F3. Fix round 1 taught doctor to say unknown for a
    // TIMEOUT, and wrote the predicate as `!(e instanceof TmuxTimeoutError)`,
    // which covers the timeout SHAPE and leaves the unknown CLASS reading as
    // an answer: EACCES spawning tmux, ENOBUFS, a transient socket error each
    // printed `ok sessions: none running` again. The predicate is
    // tmuxSaysNothingThere now, so it is true for what tmux actually
    // answered and false for everything else.
    //
    // No timeout is involved here at all: the fake exits 1 immediately with
    // text NOTHING_THERE does not match.
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

      // THE CONTROL THAT KEEPS THE PREDICATE FROM BEING "any failure at all":
      // a tmux that ANSWERS "there is no server" is a genuine empty world and
      // must still read as one, or doctor calls every machine with nothing
      // running unknowable.
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
    // The one fact tmux()'s timeout branch rests on, pinned against the real
    // node this suite runs on rather than assumed from documentation: a
    // node upgrade that changed this shape would silently turn every timeout
    // back into an ordinary TmuxError, and every assertion above would still
    // pass because they construct their errors by hand.
    const e = caught(() =>
      execFileSync("sleep", ["5"], { timeout: 200, killSignal: "SIGKILL", stdio: ["ignore", "pipe", "pipe"] }),
    );
    assert.equal(e.code, "ETIMEDOUT");
    // An ordinary non-zero exit carries a status and no code at all, which is
    // what keeps the branch from claiming ordinary failures as timeouts.
    const failed = caught(() => execFileSync("sh", ["-c", "exit 3"], { stdio: ["ignore", "pipe", "pipe"] }));
    assert.equal(failed.code, undefined);
    assert.equal(failed.status, 3);
  });
});
