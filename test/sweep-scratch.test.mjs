import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import {
  assertScratchStore,
  clearHiveEnv,
  isolateTmux,
  scratchDirs,
  scratchTmuxServer,
  withEnv,
} from "./helpers.mjs";
import {
  findOrphanShells,
  killPid,
  liveSuiteLockHolder,
  parseEtimeSeconds,
  parsePsRows,
  reapWedgedServer,
} from "../scripts/sweep-scratch.mjs";

// Todo 402. Two populations, two different testing arguments - said here
// rather than left implicit, because the file's own shape is the answer to
// "why does one half get a real end-to-end reap and the other does not".
//
// SHELLS: this development machine carries real, ordinary orphaned login
// shells whenever this file runs (ps holds no fixture boundary), so the
// script's own end-to-end CLI path - which scans the WHOLE process table -
// is never exercised here against `--kill`. Its ENUMERATION is (fixture ps
// rows, no process involved), and its KILL MECHANISM is, directly, against
// one real process this file spawns and owns for exactly that purpose. That
// is the seam test/CLAUDE.md and todo 402 both ask for when the honest
// answer is that the full path cannot be exercised safely.
//
// SCRATCH TMUX SERVERS: the opposite argument applies, because
// orphanScratchServers() is scoped by construction to `hive-tmux-*` sockets
// nothing but hive's own test/dev tooling ever creates, and the age floor
// used below (1h, orphanScratchServers' own production default) safely
// excludes any concurrent sibling lane's own seconds-old scratch socket -
// the identical safety argument test/orphan-tmux-servers.test.mjs already
// rests on. So this half gets the real thing: the actual CLI, `--kill`, a
// real server, and a real verification that the file's OWN live session
// survives the reap.
const { hasTmux } = isolateTmux("the sweep-scratch script tests");
const { dataDir } = scratchDirs();
clearHiveEnv();
process.env.HIVE_DATA_DIR = dataDir;
await assertScratchStore();

const { isOrphanLoginShell } = await import("../dist/ptys.js");
const { sessionName, tmuxSocketPath } = await import("../dist/tmux.js");

const SWEEP_SCRIPT = new URL("../scripts/sweep-scratch.mjs", import.meta.url).pathname;

function runSweep(args, opts = {}) {
  return execFileSync(process.execPath, [SWEEP_SCRIPT, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
    killSignal: "SIGKILL",
    ...opts,
  });
}

describe("parsing (fixture-testable, no process involved)", () => {
  it("parses pid/ppid/etime/tty/comm off a ps(1) line", () => {
    assert.deepEqual(parsePsRows("  1234   1  06:22:44 ttys020  -zsh\n"), [
      { pid: 1234, ppid: 1, etime: "06:22:44", tty: "ttys020", comm: "-zsh" },
    ]);
  });

  it("skips blank lines", () => {
    assert.deepEqual(parsePsRows("\n  \n"), []);
  });

  it("carries a multi-word args= column through as one comm field", () => {
    assert.deepEqual(parsePsRows("42 1 00:01 ttys001 -zsh -c hello\n"), [
      { pid: 42, ppid: 1, etime: "00:01", tty: "ttys001", comm: "-zsh -c hello" },
    ]);
  });

  for (const [etime, seconds] of [
    ["45", 45],
    ["05:28", 328],
    ["06:22:44", 22964],
    ["1-06:22:44", 109364],
  ]) {
    it(`reads etime "${etime}" as ${seconds}s`, () => {
      assert.equal(parseEtimeSeconds(etime), seconds);
    });
  }

  it("answers null for text that is not an etime", () => {
    assert.equal(parseEtimeSeconds("not-a-time"), null);
  });
});

describe("findOrphanShells (selection, reusing isOrphanLoginShell)", () => {
  it("selects only ppid=1, dash-prefixed, pty-holding rows past the age floor", () => {
    const rows = [
      { pid: 1, ppid: 1, etime: "20:00:00", tty: "ttys001", comm: "-zsh" }, // the real orphan
      { pid: 2, ppid: 500, etime: "20:00:00", tty: "ttys002", comm: "-zsh" }, // real parent, not orphaned
      { pid: 3, ppid: 1, etime: "00:05:00", tty: "ttys003", comm: "-zsh" }, // orphaned, too young
      { pid: 4, ppid: 1, etime: "20:00:00", tty: "ttys004", comm: "zsh" }, // no leading dash
      { pid: 5, ppid: 1, etime: "20:00:00", tty: "??", comm: "-zsh" }, // no pty
    ];
    const found = findOrphanShells(rows, 12 * 3_600_000, isOrphanLoginShell);
    assert.deepEqual(
      found.map((r) => r.pid),
      [1],
    );
  });

  it("finds nothing in an empty table", () => {
    assert.deepEqual(findOrphanShells([], 0, isOrphanLoginShell), []);
  });
});

describe("killPid: the real reap mechanism, against a real process this file owns", { skip: hasTmux ? false : "tmux not installed" }, () => {
  // A genuine double-fork orphan: the outer `sh -c` backgrounds a bash whose
  // argv[0] is set to a leading dash via `exec -a`, then exits - reparenting
  // the survivor to launchd/init the instant it does, exactly the population
  // isOrphanLoginShell exists to name. This is the honest fixture: a process
  // that actually IS orphaned, not a synthetic row asserting a property no
  // real process has to hold.
  function spawnOrphan() {
    const pid = Number(
      execFileSync("/bin/sh", [
        "-c",
        "nohup /bin/bash -c 'exec -a -sweeptestorphan sleep 60' >/dev/null 2>&1 & echo $!",
      ], { encoding: "utf8" }).trim(),
    );
    return pid;
  }

  function alive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  const spawned = [];
  after(() => {
    for (const pid of spawned) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  });

  it("SIGTERMs a real orphan and it dies, without needing SIGKILL", async () => {
    const pid = spawnOrphan();
    spawned.push(pid);
    assert.ok(alive(pid), "the orphan must be alive before the test exercises anything");
    const result = await killPid(pid);
    assert.equal(result.alive, false);
    assert.equal(result.escalated, false, "an ordinary sleep must die on SIGTERM, not need escalation");
    assert.equal(alive(pid), false);
  });

  it("is a no-op, not a throw, against a pid that is already gone", async () => {
    const pid = spawnOrphan();
    process.kill(pid, "SIGKILL");
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(alive(pid), false, "setup: the process must already be dead before this assertion");
    const result = await killPid(pid);
    assert.equal(result.alive, false);
    assert.equal(result.escalated, false);
  });
});

// The wedged-server pid fallback (dead-ends/2026-08-11-reaping-a-wedged-
// tmux-server-by-socket-alone.md): its decision - refuse unless lsof names
// EXACTLY one pid for the socket - is what stands between "resolve the live
// pid as well as the live socket" and the pid-list dead-end this whole
// population's safety argument rests on. A genuinely wedged tmux server is
// not something this suite can manufacture safely, so this tests the
// decision against real sockets in the two states it is easy and safe to
// produce: one with no listener at all, and one with exactly one (an
// ordinary, live scratchTmuxServer - not wedged, but identical from lsof's
// side, which is the only thing this function looks at).
describe("reapWedgedServer: the pid-fallback decision, against real sockets", { skip: hasTmux ? false : "tmux not installed" }, () => {
  const made = [];
  after(() => {
    for (const server of made) server.reap();
  });

  it("refuses a socket lsof cannot name a listener for, rather than guessing", () => {
    const dir = mkdtempSync(join(tmpdir(), "hive-tmux-noserver-"));
    const socket = join(dir, "no-such-socket");
    const result = reapWedgedServer(socket, null);
    assert.equal(result.ok, false);
  });

  it("resolves the single real pid for a socket with exactly one listener", () => {
    const server = scratchTmuxServer({ ageHours: 5 });
    made.push(server);
    const result = reapWedgedServer(server.socket, null);
    assert.equal(result.ok, true);
    assert.equal(typeof result.pid, "number");
    // The resolved pid really does own this socket - probed independently
    // via kill(pid, 0) rather than trusted from reapWedgedServer's own claim.
    assert.doesNotThrow(() => process.kill(result.pid, 0));
  });

  it("excludes the caller's own live pid from the candidate set", () => {
    const server = scratchTmuxServer({ ageHours: 5 });
    made.push(server);
    const realPid = reapWedgedServer(server.socket, null).pid;
    // Told the real pid IS the live one: must then refuse, since excluding
    // it leaves zero candidates rather than a wrong guess.
    const result = reapWedgedServer(server.socket, realPid);
    assert.equal(result.ok, false);
  });
});

// The suite-lock guard, found by the lead running the script against a real
// concurrently-running suite: it offered up that suite's own live scratch
// socket, because orphanScratchServers() only ever excludes THIS process's
// own live socket, never a sibling's. `lockPath` is always a throwaway file
// here, never the real shared one - see liveSuiteLockHolder's own comment
// for why writing to the real path from a test would race whatever lane is
// actually running a suite on this machine right now.
describe("liveSuiteLockHolder: the decision, against a throwaway lock file", () => {
  function tempLockPath() {
    return join(mkdtempSync(join(tmpdir(), "hive-sweep-lock-test-")), "hive-test-suite.lock");
  }

  it("answers null when no lock file exists at all", () => {
    assert.equal(liveSuiteLockHolder(tempLockPath()), null);
  });

  it("answers the record when the recorded pid is genuinely alive", () => {
    const lockPath = tempLockPath();
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, branch: "test-branch", worktree: "/test" }));
    const holder = liveSuiteLockHolder(lockPath);
    assert.equal(holder?.pid, process.pid);
    assert.equal(holder?.branch, "test-branch");
  });

  it("answers null when the recorded pid is genuinely dead", () => {
    const dead = spawnSync("/bin/sh", ["-c", "exit 0"]).pid;
    const lockPath = tempLockPath();
    writeFileSync(lockPath, JSON.stringify({ pid: dead, branch: "test-branch", worktree: "/test" }));
    assert.equal(liveSuiteLockHolder(lockPath), null);
  });

  it("answers null for a corrupt or unusable lock file, never throws", () => {
    const lockPath = tempLockPath();
    writeFileSync(lockPath, "not json");
    assert.equal(liveSuiteLockHolder(lockPath), null);
  });
});

describe("the sweep CLI end to end, against a real scratch tmux server", { skip: hasTmux ? false : "tmux not installed" }, () => {
  const made = [];
  const orphanPids = [];
  after(() => {
    for (const server of made) server.reap();
    // Safety net only - the one test that spawns an orphan asserts it is
    // already gone; this covers an assertion failure interrupting that test
    // before it gets the chance to observe that.
    for (const pid of orphanPids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  });

  it("dry run by default: reports the candidate and kills nothing", () => {
    const server = scratchTmuxServer({ ageHours: 5 });
    made.push(server);
    const socket = server.socket;

    const out = runSweep(["--age-hours=1"]);
    assert.match(out, new RegExp(socket.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(out, /DRY RUN: nothing was killed/);

    // CONTROL: still answers after a dry run. Without this, "reported" could
    // just as easily mean "reported because it is already gone".
    execFileSync("tmux", ["-S", socket, "list-sessions"], { stdio: "ignore", timeout: 5000, killSignal: "SIGKILL" });
  });

  it("--kill reaps a real orphaned server, and the file's own live session survives every step", () => {
    // The file's OWN live session, on its OWN isolated socket - not the
    // orphan's. If the reap ever touched the wrong socket, this is what
    // would go missing.
    const liveSocket = tmuxSocketPath(process.env.TMUX, process.env.TMUX_TMPDIR);
    const session = sessionName();
    execFileSync("tmux", ["-S", liveSocket, "new-session", "-d", "-s", session, "sleep", "300"], {
      stdio: "ignore",
      timeout: 5000,
      killSignal: "SIGKILL",
    });

    const before = execFileSync("tmux", ["-S", liveSocket, "list-panes", "-s", "-t", session, "-F", "#{pane_id}"], {
      encoding: "utf8",
    }).trim();
    assert.notEqual(before, "", "setup: the live session must have a real pane before the reap runs");

    const server = scratchTmuxServer({ ageHours: 5 });
    made.push(server);

    // A nonexistent lock path, not the default: when this test runs as PART
    // of a real `npm test`, the real suite lock IS held - by the very run
    // this test is inside - and this test is about the reap mechanism, not
    // the guard (that has its own describe block below). Found by running
    // this file inside a real full suite rather than standalone: the guard
    // fired against its own test suite and this test failed for the right
    // reason, just the wrong test.
    const noLock = join(mkdtempSync(join(tmpdir(), "hive-sweep-nolock-")), "hive-test-suite.lock");
    const out = runSweep(["--age-hours=1", "--kill"], { env: { ...process.env, SWEEP_SUITE_LOCK_PATH: noLock } });
    assert.match(out, /killed/);

    // THE HEADLINE: the orphan is actually gone, probed directly rather than
    // trusted from the script's own stdout.
    assert.throws(
      () => execFileSync("tmux", ["-S", server.socket, "list-sessions"], { stdio: "ignore", timeout: 5000, killSignal: "SIGKILL" }),
      /./,
      "the reaped server must no longer answer",
    );

    // THE CONTROL THAT MAKES THE HEADLINE MEAN SOMETHING: the live session's
    // panes are byte-identical to the snapshot taken before the reap.
    const after_ = execFileSync("tmux", ["-S", liveSocket, "list-panes", "-s", "-t", session, "-F", "#{pane_id}"], {
      encoding: "utf8",
    }).trim();
    assert.equal(after_, before);

    execFileSync("tmux", ["-S", liveSocket, "kill-session", "-t", `=${session}`], { stdio: "ignore" });
  });

  it("the suite-lock guard: a live holder blocks the server reap but not the shell reap", () => {
    const lockPath = join(mkdtempSync(join(tmpdir(), "hive-sweep-lock-test-")), "hive-test-suite.lock");
    // The test runner's own pid - genuinely alive for the whole test, no
    // fixture process needed to keep it that way.
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, branch: "sibling-lane", worktree: "/sibling" }));

    const server = scratchTmuxServer({ ageHours: 5 });
    made.push(server);

    const orphanPid = Number(
      execFileSync("/bin/sh", [
        "-c",
        "nohup /bin/bash -c 'exec -a -sweeptestorphan sleep 60' >/dev/null 2>&1 & echo $!",
      ], { encoding: "utf8" }).trim(),
    );
    orphanPids.push(orphanPid);

    // SWEEP_PS_ROWS_JSON, not a real scan: this machine carries real,
    // unrelated orphaned shells (90 of them the day this was written), and
    // scanning the whole process table would catch every one of those too.
    // This closes the shell candidate set to exactly the one row this test
    // owns. The etime is FICTIONAL (the real process is seconds old) -
    // findOrphanShells only compares it against the floor below, already
    // covered on real values by its own describe block above; the kill
    // still lands on the real pid, so the mechanism under test is real.
    // age-hours stays at a REALISTIC floor (1h, not 0) for the same reason
    // the etime is faked rather than the floor lowered: orphanScratchServers
    // scans the WHOLE shared tmpdir for hive-tmux-* sockets, so a floor of 0
    // would also offer up any OTHER concurrently-running test file's own
    // fresh scratch socket - reproduced once while writing this, against
    // test/tmux-leak-check.test.mjs's own fixtures running in parallel.
    const shellRow = { pid: orphanPid, ppid: 1, etime: "02:00:00", tty: "ttys999", comm: "-sweeptestorphan" };
    const out = runSweep(["--age-hours=1", "--kill"], {
      env: { ...process.env, SWEEP_SUITE_LOCK_PATH: lockPath, SWEEP_PS_ROWS_JSON: JSON.stringify([shellRow]) },
    });
    assert.match(out, new RegExp(`suite lock is held by pid ${process.pid}`));
    // Not an exact count: orphanScratchServers scans the whole shared
    // tmpdir, so under a real `npm test` run other concurrently-running
    // test files' own 5h-backdated fixtures can legitimately appear
    // alongside this one. The count is not what this test is about; the
    // probe below, against the specific socket this test made, is.
    assert.match(out, /skipping \d+ scratch tmux server/);

    // THE HEADLINE: the server the lock is meant to protect is still there.
    execFileSync("tmux", ["-S", server.socket, "list-sessions"], { stdio: "ignore", timeout: 5000, killSignal: "SIGKILL" });

    // THE CONTROL THAT MAKES THE SCOPE CLAIM MEAN SOMETHING: the shell reap
    // was NOT also blocked - only the destructive half the lock exists for.
    // isAlive rather than a try/catch around assert.fail: the two throw
    // shapes (ESRCH vs. an assertion) must not be caught by the same catch,
    // or a genuine failure here reads as an unrelated ERR_ASSERTION mismatch
    // instead of the real one.
    let orphanAlive = true;
    try {
      process.kill(orphanPid, 0);
    } catch (e) {
      orphanAlive = e.code !== "ESRCH";
    }
    assert.equal(orphanAlive, false, "the orphan shell should have been reaped despite the suite lock being held");
  });

  it("the suite-lock guard: names the holder in a dry run too, before --kill is even decided", () => {
    const lockPath = join(mkdtempSync(join(tmpdir(), "hive-sweep-lock-test-")), "hive-test-suite.lock");
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, branch: "sibling-lane", worktree: "/sibling" }));
    const server = scratchTmuxServer({ ageHours: 5 });
    made.push(server);

    const out = runSweep(["--age-hours=1"], { env: { ...process.env, SWEEP_SUITE_LOCK_PATH: lockPath } });
    assert.match(out, new RegExp(`suite lock is held by pid ${process.pid}`));
    assert.match(out, /DRY RUN: nothing was killed/);
  });

  it("the empty-list guard: --kill against a floor nothing clears touches no tmux socket at all", () => {
    const server = scratchTmuxServer({ ageHours: 0 }); // too fresh for any realistic floor
    made.push(server);
    const socket = server.socket;

    const out = runSweep(["--age-hours=1000", "--kill"]);
    assert.match(out, /old scratch tmux servers \(age >= 1000h\): 0/);
    assert.doesNotMatch(out, /reaping\.\.\./);

    // The fresh server the floor was supposed to exclude is still there.
    execFileSync("tmux", ["-S", socket, "list-sessions"], { stdio: "ignore", timeout: 5000, killSignal: "SIGKILL" });
  });

  it("is safe on a machine with no live hive session at all - no crash, nothing treated as fair game", () => {
    // A private socket with no session ever created on it: sessionName()
    // resolves to a real tag, but livePaneIds() finds nothing there. This
    // must read as "nothing to verify", never as "no live session, so
    // anything found is safe to kill" - the guard the empty-list test above
    // covers is about candidates, this one is about the live-session check
    // itself degrading safely.
    // A real, empty directory - never handed to tmux, so no server has ever
    // listened on the socket path it resolves to.
    const emptyDir = mkdtempSync(join(tmpdir(), "sweep-test-empty-tmux-tmpdir-"));
    withEnv({ TMUX_TMPDIR: emptyDir }, () => {
      const out = runSweep(["--age-hours=1000"]);
      assert.match(out, /DRY RUN: nothing was killed/);
    });
  });
});
