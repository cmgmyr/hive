import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";

import {
  assertScratchStore,
  clearHiveEnv,
  isolateTmux,
  recordScratchTmuxSocket,
  scratchDirs,
  scratchTmuxServer,
  tmuxSocketUnder,
  withEnv,
} from "./helpers.mjs";
import {
  findOrphanShells,
  hasLiveDescendant,
  killPid,
  liveSuiteLockHolder,
  parseEtimeSeconds,
  parsePsRows,
  reapWedgedServer,
} from "../scripts/sweep-scratch.mjs";

const { hasTmux } = isolateTmux("the sweep-scratch script tests");
const { dataDir } = scratchDirs();
clearHiveEnv();
process.env.HIVE_DATA_DIR = dataDir;
await assertScratchStore();

const { isOrphanLoginShell } = await import("../dist/ptys.js");
const { sessionName, tmuxSocketPath } = await import("../dist/tmux.js");

const SWEEP_SCRIPT = new URL("../scripts/sweep-scratch.mjs", import.meta.url).pathname;

const WEDGED_SHELL_IS_SELECTABLE = platform() === "darwin";

function runSweep(args, opts = {}) {
  const { realPsRows = false, ...spawnOpts } = opts;
  const env = { ...process.env, ...(spawnOpts.env ?? {}) };
  if (realPsRows) {
    if (args.includes("--kill")) {
      throw new Error("realPsRows is dry-run only: a --kill sweep here must be handed its own shell population");
    }
    delete env.SWEEP_PS_ROWS_JSON;
  } else if (!env.SWEEP_PS_ROWS_JSON) {
    env.SWEEP_PS_ROWS_JSON = "[]";
  }
  return execFileSync(process.execPath, [SWEEP_SCRIPT, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
    killSignal: "SIGKILL",
    ...spawnOpts,
    env,
  });
}

const nap = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code !== "ESRCH";
  }
}

function ppidOf(pid) {
  try {
    return Number(execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8" }).trim());
  } catch {
    return null;
  }
}

function foreignOrphanLoginShell(cleanups) {
  const binDir = mkdtempSync(join(tmpdir(), "hive-sweep-victim-"));
  const bin = join(binDir, "-hivesweepvictim");
  symlinkSync("/bin/sleep", bin);

  const socketDir = mkdtempSync(join(tmpdir(), "hive-tmux-victim-"));
  const socket = tmuxSocketUnder(realpathSync(socketDir));
  mkdirSync(dirname(socket), { recursive: true });
  recordScratchTmuxSocket(socket);
  cleanups.push({
    reap: () => {
      rmSync(binDir, { recursive: true, force: true });
      rmSync(socketDir, { recursive: true, force: true });
    },
  });

  execFileSync(
    "tmux",
    ["-S", socket, "new-session", "-d", "-s", "victim", `trap '' HUP; exec '${bin}' 600`],
    { stdio: "ignore", timeout: 5000, killSignal: "SIGKILL" },
  );
  const panes = execFileSync("tmux", ["-S", socket, "list-panes", "-s", "-t", "=victim", "-F", "#{pane_pid}"], {
    encoding: "utf8",
    timeout: 5000,
    killSignal: "SIGKILL",
  }).trim();
  assert.notEqual(panes, "", "setup: tmux created no pane for the victim session");
  const pid = Number(panes);
  execFileSync("tmux", ["-S", socket, "kill-session", "-t", "=victim"], {
    stdio: "ignore",
    timeout: 5000,
    killSignal: "SIGKILL",
  });

  for (let i = 0; i < 60 && ppidOf(pid) !== 1; i++) nap(50);
  assert.equal(ppidOf(pid), 1, "setup: the victim must outlive its tmux server as a parentless pty holder");
  return pid;
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
  it("selects only ppid=1, dash-prefixed, pty-holding rows with no live descendant, past the age floor", () => {
    const rows = [
      { pid: 101, ppid: 1, etime: "20:00:00", tty: "ttys001", comm: "-zsh" },
      { pid: 102, ppid: 500, etime: "20:00:00", tty: "ttys002", comm: "-zsh" },
      { pid: 103, ppid: 1, etime: "00:05:00", tty: "ttys003", comm: "-zsh" },
      { pid: 104, ppid: 1, etime: "20:00:00", tty: "ttys004", comm: "zsh" },
      { pid: 105, ppid: 1, etime: "20:00:00", tty: "??", comm: "-zsh" },
      { pid: 106, ppid: 1, etime: "20:00:00", tty: "ttys006", comm: "-zsh" },
      { pid: 107, ppid: 106, etime: "00:01:00", tty: "ttys006", comm: "npm run watch" },
    ];
    const found = findOrphanShells(rows, 12 * 3_600_000, isOrphanLoginShell);
    assert.deepEqual(
      found.map((r) => r.pid),
      [101],
    );
  });

  it("finds nothing in an empty table", () => {
    assert.deepEqual(findOrphanShells([], 0, isOrphanLoginShell), []);
  });
});

describe("hasLiveDescendant", () => {
  it("is true when another row's ppid points at this pid", () => {
    const rows = [
      { pid: 6, ppid: 1, etime: "20:00:00", tty: "ttys006", comm: "-zsh" },
      { pid: 7, ppid: 6, etime: "00:01:00", tty: "ttys006", comm: "npm run watch" },
    ];
    assert.equal(hasLiveDescendant(6, rows), true);
  });

  it("is false when no row's ppid points at this pid", () => {
    const rows = [{ pid: 1, ppid: 1, etime: "20:00:00", tty: "ttys001", comm: "-zsh" }];
    assert.equal(hasLiveDescendant(1, rows), false);
  });

  it("is false against an empty table", () => {
    assert.equal(hasLiveDescendant(1, []), false);
  });
});

describe("killPid: the real reap mechanism, against a real process this file owns", { skip: hasTmux ? false : "tmux not installed" }, () => {

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

    assert.doesNotThrow(() => process.kill(result.pid, 0));
  });

  it("excludes the caller's own live pid from the candidate set", () => {
    const server = scratchTmuxServer({ ageHours: 5 });
    made.push(server);
    const realPid = reapWedgedServer(server.socket, null).pid;

    const result = reapWedgedServer(server.socket, realPid);
    assert.equal(result.ok, false);
  });
});

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

describe("the sweep CLI reaps the shell population it is handed, never the machine's", () => {
  const made = [];
  after(() => {
    for (const dir of made) rmSync(dir, { recursive: true, force: true });
  });

  function psOffering(row) {
    const dir = mkdtempSync(join(tmpdir(), "hive-sweep-fake-ps-"));
    made.push(dir);
    writeFileSync(join(dir, "ps"), `#!/bin/sh\necho "${row}"\n`, { mode: 0o755 });
    return dir;
  }

  it("a --kill sweep started from this file reports no shell at all, though ps offers one that qualifies", () => {
    const dead = spawnSync("/bin/sh", ["-c", "exit 0"]).pid;
    const fakePs = psOffering(`  ${dead}       1       20:00:00 ttys999  -fakeorphanshell`);
    const noServersHere = mkdtempSync(join(tmpdir(), "hive-sweep-no-servers-"));
    made.push(noServersHere);
    const env = { ...process.env, PATH: `${fakePs}:${process.env.PATH}`, TMPDIR: noServersHere };

    const offered = runSweep(["--age-hours=1"], { realPsRows: true, env });
    assert.match(
      offered,
      /-fakeorphanshell/,
      "setup: the offered row must be selectable by the real predicate, or the assertion below proves nothing",
    );

    const out = runSweep(["--age-hours=1", "--kill"], { env });
    assert.match(out, /orphaned login shells \(age >= 1h\): 0/);
    assert.doesNotMatch(out, /-fakeorphanshell/);
    assert.doesNotMatch(out, new RegExp(`pid ${dead}\\s`));
  });
});

describe("the sweep CLI end to end, against a real scratch tmux server", { skip: hasTmux ? false : "tmux not installed" }, () => {
  const made = [];
  const orphanPids = [];
  after(() => {
    for (const server of made) server.reap();

    for (const pid of orphanPids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {

      }
    }
  });

  it("dry run by default: reports the candidate and kills nothing", () => {
    const server = scratchTmuxServer({ ageHours: 5 });
    made.push(server);
    const socket = server.socket;

    const out = runSweep(["--age-hours=1"], { realPsRows: true });
    assert.match(out, new RegExp(socket.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(out, /orphaned login shells \(age >= 1h\)/);
    assert.match(out, /DRY RUN: nothing was killed/);

    execFileSync("tmux", ["-S", socket, "list-sessions"], { stdio: "ignore", timeout: 5000, killSignal: "SIGKILL" });
  });

  it("--kill reaps a real orphaned server, and the file's own live session survives every step", () => {

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

    const noLock = join(mkdtempSync(join(tmpdir(), "hive-sweep-nolock-")), "hive-test-suite.lock");
    const out = runSweep(["--age-hours=1", "--kill"], { env: { ...process.env, SWEEP_SUITE_LOCK_PATH: noLock } });
    assert.match(out, /killed/);

    assert.throws(
      () => execFileSync("tmux", ["-S", server.socket, "list-sessions"], { stdio: "ignore", timeout: 5000, killSignal: "SIGKILL" }),
      /./,
      "the reaped server must no longer answer",
    );

    const after_ = execFileSync("tmux", ["-S", liveSocket, "list-panes", "-s", "-t", session, "-F", "#{pane_id}"], {
      encoding: "utf8",
    }).trim();
    assert.equal(after_, before);

    execFileSync("tmux", ["-S", liveSocket, "kill-session", "-t", `=${session}`], { stdio: "ignore" });
  });

  it("--kill is handed its shell population, so an orphan login shell this file does not own survives a zero-hour floor", {
    skip: WEDGED_SHELL_IS_SELECTABLE
      ? false
      : "linux reports tty '?' for a shell whose pty master has closed, so findOrphanShells drops this population "
        + "before the name test and scripts/sweep-scratch.mjs cannot select it there at all (todo 372 comment 1411, "
        + "todo 472). The guard itself is pinned on every platform by the handed-population test in this file.",
  }, () => {
    const lockPath = join(mkdtempSync(join(tmpdir(), "hive-sweep-lock-test-")), "hive-test-suite.lock");
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, branch: "this-file", worktree: "/this-file" }));

    const protectedServer = scratchTmuxServer({ ageHours: 5 });
    made.push(protectedServer);

    const victim = foreignOrphanLoginShell(made);
    orphanPids.push(victim);

    const selectable = runSweep(["--age-hours=0"], { realPsRows: true });
    assert.match(
      selectable,
      new RegExp(`pid ${victim}\\s`),
      "setup: the real predicate must select this process, or the assertions below prove nothing",
    );
    assert.match(
      selectable,
      new RegExp(protectedServer.socket.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      "setup: a scratch server the kill run must not consider has to be visible to a sweep that can see it",
    );

    const noServersHere = mkdtempSync(join(tmpdir(), "hive-sweep-no-servers-"));
    made.push({ reap: () => rmSync(noServersHere, { recursive: true, force: true }) });
    const out = runSweep(["--age-hours=0", "--kill"], {
      env: { ...process.env, SWEEP_SUITE_LOCK_PATH: lockPath, TMPDIR: noServersHere },
    });
    assert.doesNotMatch(out, new RegExp(`pid ${victim}\\s`));
    assert.equal(isAlive(victim), true, "a --kill sweep from this file reaped a process the file does not own");

    assert.match(
      out,
      /old scratch tmux servers \(age >= 0h\): 0/,
      "the kill run must consider no scratch server at all, while one that qualifies exists outside its TMPDIR",
    );
    execFileSync("tmux", ["-S", protectedServer.socket, "list-sessions"], {
      stdio: "ignore",
      timeout: 5000,
      killSignal: "SIGKILL",
    });
  });

  it("the suite-lock guard: a live holder blocks the server reap but not the shell reap", () => {
    const lockPath = join(mkdtempSync(join(tmpdir(), "hive-sweep-lock-test-")), "hive-test-suite.lock");

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

    const shellRow = { pid: orphanPid, ppid: 1, etime: "02:00:00", tty: "ttys999", comm: "-sweeptestorphan" };
    const out = runSweep(["--age-hours=1", "--kill"], {
      env: { ...process.env, SWEEP_SUITE_LOCK_PATH: lockPath, SWEEP_PS_ROWS_JSON: JSON.stringify([shellRow]) },
    });
    assert.match(out, new RegExp(`suite lock is held by pid ${process.pid}`));

    assert.match(out, /skipping \d+ scratch tmux server/);

    execFileSync("tmux", ["-S", server.socket, "list-sessions"], { stdio: "ignore", timeout: 5000, killSignal: "SIGKILL" });

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
    const server = scratchTmuxServer({ ageHours: 0 });
    made.push(server);
    const socket = server.socket;

    const out = runSweep(["--age-hours=1000", "--kill"]);
    assert.match(out, /old scratch tmux servers \(age >= 1000h\): 0/);
    assert.doesNotMatch(out, /reaping\.\.\./);

    execFileSync("tmux", ["-S", socket, "list-sessions"], { stdio: "ignore", timeout: 5000, killSignal: "SIGKILL" });
  });

  it("is safe on a machine with no live hive session at all - no crash, nothing treated as fair game", () => {

    const emptyDir = mkdtempSync(join(tmpdir(), "sweep-test-empty-tmux-tmpdir-"));
    withEnv({ TMUX_TMPDIR: emptyDir }, () => {
      const out = runSweep(["--age-hours=1000"]);
      assert.match(out, /DRY RUN: nothing was killed/);
    });
  });
});
