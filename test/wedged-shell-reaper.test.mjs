import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import {
  describeWedgedReap,
  newlyWedged,
  orphanShellRows,
  reapWedged,
  stillOrphanLoginShells,
} from "../scripts/wedged-shells.mjs";
import { REPO } from "./helpers.mjs";

const scratchDirs = [];
const strays = [];

after(() => {
  for (const pid of strays) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {

    }
  }
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

function scratchDir() {
  const dir = mkdtempSync(join(tmpdir(), "hive-reaper-"));
  scratchDirs.push(dir);
  return dir;
}

function psRowsFile(rows) {
  const path = join(scratchDir(), "ps-rows.json");
  writeFileSync(path, JSON.stringify(rows));
  return path;
}

function wedgedShell({ pid, etime = "00:00", tty = "ttys042" }) {
  return { pid, ppid: 1, etime, tty, comm: "-zsh" };
}

async function rowsFrom(rows) {
  process.env.HIVE_REAP_PS_ROWS_FILE = psRowsFile(rows);
  try {
    return await orphanShellRows();
  } finally {
    delete process.env.HIVE_REAP_PS_ROWS_FILE;
  }
}

async function unkillableChild() {
  const child = spawn("/bin/sh", ["-c", 'trap "" TERM; echo trapped; sleep 60'], {
    stdio: ["ignore", "pipe", "ignore"],
    detached: true,
  });
  strays.push(child.pid);
  await new Promise((resolve, reject) => {
    child.stdout.on("data", (chunk) => (String(chunk).includes("trapped") ? resolve() : null));
    child.on("exit", () => reject(new Error("the SIGTERM-ignoring fixture exited before it could trap anything")));
  });
  child.stdout.destroy();
  child.unref();
  return child;
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("the bracket the wedged-shell reaper kills by", () => {
  it("spares an orphan login shell that was already there, while reaping one of the same shape that was not", async () => {
    const survivor = wedgedShell({ pid: 4242, etime: "00:03" });
    const created = wedgedShell({ pid: 4343, etime: "00:03" });

    const before = await rowsFrom([survivor]);
    assert.deepEqual(
      before.rows.map((r) => r.pid),
      [4242],
      "the pre-existing shell must reach the before-set, or this test proves nothing: an empty " +
        "before-set spares nothing and the assertion below would pass with the bracket removed",
    );

    const after = await rowsFrom([survivor, created]);
    const doomed = newlyWedged(new Set(before.rows.map((r) => r.pid)), after.rows, { maxAgeMs: 60_000 });

    assert.deepEqual(
      doomed.map((r) => r.pid),
      [4343],
      "only the pid this run added may be reaped",
    );
  });

  it("spares an orphan older than the run, which is what stops a reused pid being killed", async () => {
    const reusedPid = wedgedShell({ pid: 5151, etime: "04:11:07" });
    const after = await rowsFrom([reusedPid]);
    assert.equal(after.rows.length, 1, "the fixture row must survive the orphan filter for the age check to be the reason");

    assert.deepEqual(newlyWedged(new Set(), after.rows, { maxAgeMs: 60_000 }), []);
    assert.deepEqual(
      newlyWedged(new Set(), after.rows, { maxAgeMs: 5 * 3_600_000 }).map((r) => r.pid),
      [5151],
      "the same row is reapable under a run long enough to have created it, so the age ceiling is what excluded it",
    );
  });

  it("does not count a login shell that is running something as an orphan to reap", async () => {
    const shell = wedgedShell({ pid: 6161 });
    const child = { pid: 6162, ppid: 6161, etime: "00:01", tty: "ttys042", comm: "vim" };

    assert.deepEqual((await rowsFrom([shell])).rows.map((r) => r.pid), [6161], "alone, this shell is reapable");
    assert.deepEqual((await rowsFrom([shell, child])).rows, [], "with a live child it must not be");
  });

  it("does not count a shell holding no pty as an orphan to reap", async () => {
    assert.deepEqual((await rowsFrom([{ ...wedgedShell({ pid: 7171 }), tty: "??" }])).rows, []);
  });

  it("does not count a shell whose parent is still alive as an orphan to reap", async () => {
    assert.deepEqual((await rowsFrom([{ ...wedgedShell({ pid: 7272 }), ppid: 900 }])).rows, []);
  });

  it("treats an age it cannot parse as older than the run rather than as age zero", async () => {
    const unreadable = await rowsFrom([wedgedShell({ pid: 8181, etime: "an-hour-ish" })]);
    assert.equal(unreadable.rows.length, 1, "the row must reach the ceiling for the ceiling to be what rejects it");
    assert.deepEqual(newlyWedged(new Set(), unreadable.rows, { maxAgeMs: 10 * 3_600_000 }), []);

    const readable = await rowsFrom([wedgedShell({ pid: 8181, etime: "00:02" })]);
    assert.deepEqual(
      newlyWedged(new Set(), readable.rows, { maxAgeMs: 10 * 3_600_000 }).map((r) => r.pid),
      [8181],
      "the identical row with a readable age is reapable, so the etime is what decided it",
    );
  });
});

describe("what the reaper re-checks at the moment it signals", () => {
  it("drops a bracketed pid that has stopped being an orphan login shell since the snapshot", async () => {
    const doomed = (await rowsFrom([wedgedShell({ pid: 9191 }), wedgedShell({ pid: 9292 })])).rows;
    assert.equal(doomed.length, 2);

    process.env.HIVE_REAP_PS_ROWS_FILE = psRowsFile([{ ...wedgedShell({ pid: 9191 }), ppid: 700 }, wedgedShell({ pid: 9292 })]);
    try {
      const still = await stillOrphanLoginShells(doomed);
      assert.deepEqual(
        still.rows.map((r) => r.pid),
        [9292],
        "9191 is no longer ppid 1, so the signal must not reach it; 9292 still is, so it must",
      );
    } finally {
      delete process.env.HIVE_REAP_PS_ROWS_FILE;
    }
  });
});

describe("what the reaper does to the processes it selected", () => {
  it("escalates to SIGKILL a shell that ignores SIGTERM, and says so", async () => {
    const child = await unkillableChild();
    const result = await reapWedged([{ ...wedgedShell({ pid: child.pid }), ageMs: 1000 }], { budgetMs: 10_000 });

    assert.deepEqual(result.survived, []);
    assert.equal(result.reaped.length, 1);
    assert.equal(result.reaped[0].escalated, true, "SIGTERM is trapped in this fixture, so only SIGKILL can have ended it");
    assert.equal(alive(child.pid), false);
    assert.match(describeWedgedReap({ ...result, bracketed: 0 })[0], /only on SIGKILL/);
  });

  it("counts a pid that had already gone apart from the ones it reaped, so the count stays a measurement", async () => {
    const child = spawn("/bin/sh", ["-c", "exit 0"], { stdio: "ignore" });
    await new Promise((resolve) => child.on("exit", resolve));

    const result = await reapWedged([{ ...wedgedShell({ pid: child.pid }), ageMs: 1000 }]);
    assert.deepEqual(result.survived, []);
    assert.deepEqual(result.reaped, [], "nothing was killed here, so nothing may be reported as killed");
    assert.equal(result.alreadyGone.length, 1);

    const line = describeWedgedReap({ ...result, bracketed: 0 })[0];
    assert.match(line, /reaped 0 orphaned login shell/);
    assert.match(line, /1 had already gone before the reaper signalled/);
  });

  it("does not report a run as having created no orphans when the kill-moment re-check spared some", () => {
    const none = describeWedgedReap({ bracketed: 3, droppedByRecheck: 0, reaped: [], survived: [], alreadyGone: [] })[0];
    const dropped = describeWedgedReap({ bracketed: 3, droppedByRecheck: 2, reaped: [], survived: [], alreadyGone: [] })[0];

    assert.match(none, /nothing to reap: this run created no orphaned login shells/);
    assert.doesNotMatch(dropped, /created no orphaned login shells/, "it created some; the re-check is why none died");
    assert.match(dropped, /2 bracketed pid\(s\) had stopped being orphaned login shells/);
  });
});

describe("the reaper inside a run of the suite runner", () => {
  // A run reaps only while it holds the suite lock. `lock: true` gives the nested runner a
  // scratch repository of its own so it takes a lock nothing else contends; `lock: false`
  // passes one file, which is a single-file target and the shape every nested run-tests
  // spawn in this suite already has.
  const fixtureRun = async ({ outcome, rowsPath, lock, extraEnv = {} }) => {
    const dir = scratchDir();
    const body = (name) =>
      `import { test } from "node:test";\n` +
      `import { writeFileSync } from "node:fs";\n` +
      (rowsPath ? `writeFileSync(${JSON.stringify(rowsPath.after)}, ${JSON.stringify(rowsPath.rows)});\n` : "") +
      `test(${JSON.stringify(name)}, () => { if (${outcome === "fail"}) throw new Error("deliberate"); });\n`;

    const targets = [join(dir, "reaper-fixture.test.mjs")];
    writeFileSync(targets[0], body("fixture"));
    let cwd = REPO;
    if (lock) {
      targets.push(join(dir, "reaper-fixture-two.test.mjs"));
      writeFileSync(targets[1], body("fixture two"));
      cwd = dir;
      execFileSync("git", ["init", "-q"], { cwd });
      execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "--no-gpg-sign", "-m", "lock root"], { cwd });
    }

    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    delete env.NODE_TEST_WORKER_ID;
    delete env.HIVE_TEST_NO_REAP;
    Object.assign(env, extraEnv);

    return await new Promise((resolve) => {
      const run = spawn(process.execPath, [join(REPO, "scripts", "run-tests.mjs"), ...targets], {
        cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      run.stdout.on("data", (c) => (stdout += c));
      run.stderr.on("data", (c) => (stderr += c));
      run.on("exit", (code) => resolve({ code, stdout, stderr }));
    });
  };

  it("kills a shell that appeared during the run, and leaves the passing run's exit code at 0", async () => {
    const child = await unkillableChild();
    const rowsPath = { after: join(scratchDir(), "ps-rows.json"), rows: JSON.stringify([wedgedShell({ pid: child.pid })]) };
    writeFileSync(rowsPath.after, JSON.stringify([]));

    const { code, stdout, stderr } = await fixtureRun({
      outcome: "pass",
      rowsPath,
      lock: true,
      extraEnv: { HIVE_REAP_PS_ROWS_FILE: rowsPath.after },
    });

    assert.match(stdout, /wedged-shell reaper: reaped 1 orphaned login shell/, `stdout: ${stdout}\nstderr: ${stderr}`);
    assert.equal(alive(child.pid), false, "the reaper must actually have killed it, not just reported it");
    assert.equal(code, 0);
  });

  it("reports the reap without rescuing a run whose tests failed", async () => {
    const child = await unkillableChild();
    const rowsPath = { after: join(scratchDir(), "ps-rows.json"), rows: JSON.stringify([wedgedShell({ pid: child.pid })]) };
    writeFileSync(rowsPath.after, JSON.stringify([]));

    const { code, stdout } = await fixtureRun({
      outcome: "fail",
      rowsPath,
      lock: true,
      extraEnv: { HIVE_REAP_PS_ROWS_FILE: rowsPath.after },
    });

    assert.match(stdout, /wedged-shell reaper: reaped 1 orphaned login shell/);
    assert.equal(alive(child.pid), false);
    assert.notEqual(code, 0, "a failing suite must stay failed");
  });

  it("does not reap when it does not hold the suite lock, which is what makes every nested run-tests in this suite harmless", async () => {
    const child = await unkillableChild();
    const rowsPath = { after: join(scratchDir(), "ps-rows.json"), rows: JSON.stringify([wedgedShell({ pid: child.pid })]) };
    writeFileSync(rowsPath.after, JSON.stringify([]));

    const { code, stdout } = await fixtureRun({
      outcome: "pass",
      rowsPath,
      lock: false,
      extraEnv: { HIVE_REAP_PS_ROWS_FILE: rowsPath.after },
    });

    assert.match(stdout, /wedged-shell reaper: skipped: this run does not hold the suite lock/, stdout);
    assert.equal(
      alive(child.pid),
      true,
      "an orphan-shaped process this run would otherwise have reaped must survive a lockless run",
    );
    assert.equal(code, 0);
  });

  it("leaves the shell alone under HIVE_TEST_NO_REAP=1, which is how a wedge measurement keeps its own signal", async () => {
    const child = await unkillableChild();
    const rowsPath = { after: join(scratchDir(), "ps-rows.json"), rows: JSON.stringify([wedgedShell({ pid: child.pid })]) };
    writeFileSync(rowsPath.after, JSON.stringify([]));

    const { code, stdout } = await fixtureRun({
      outcome: "pass",
      rowsPath,
      lock: true,
      extraEnv: { HIVE_REAP_PS_ROWS_FILE: rowsPath.after, HIVE_TEST_NO_REAP: "1" },
    });

    assert.match(
      stdout,
      /wedged-shell reaper: skipped: HIVE_TEST_NO_REAP=1/,
      "this run HOLDS the lock, so the opt-out is the only thing that can be skipping the reap",
    );
    assert.equal(alive(child.pid), true, "the opt-out is worthless if the shell dies anyway");
    assert.equal(code, 0);
  });
});
