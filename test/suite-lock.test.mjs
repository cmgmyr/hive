import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { scratchGit } from "./helpers.mjs";

import {
  acquireSuiteLock,
  DEFAULT_TTL_MS,
  isSingleFileTarget,
  noLockRequested,
  releaseSuiteLock,
  resolveLockPath,
  SuiteLockTimeoutError,
  takeover,
} from "../scripts/suite-lock.mjs";

// Todo 401. Three lanes ran full suites at once; this file has to prove the
// four things that keep a lock like this from halting a night rather than
// preventing one, not just that a lock file gets written somewhere.

const unitRoot = mkdtempSync(join(tmpdir(), "hive-suitelock-unit-"));
after(() => rmSync(unitRoot, { recursive: true, force: true }));

function scratchLockDir() {
  const dir = mkdtempSync(join(unitRoot, "lock-"));
  return join(dir, "hive-test-suite.lock");
}

function holder(overrides = {}) {
  return { pid: process.pid, branch: "test-branch", worktree: "/scratch", ...overrides };
}

describe("resolveLockPath", () => {
  it("resolves the SAME path from every worktree of one checkout, and a DIFFERENT path from another repo", () => {
    const repoDir = mkdtempSync(join(unitRoot, "repo-"));
    scratchGit(repoDir, "init", "-b", "main");
    scratchGit(repoDir, "commit", "--allow-empty", "-m", "root", "--no-gpg-sign");

    const worktreeDir = join(unitRoot, "worktree-a");
    scratchGit(repoDir, "worktree", "add", "-b", "side", worktreeDir, "main");

    const fromRoot = resolveLockPath(repoDir);
    const fromWorktree = resolveLockPath(worktreeDir);
    assert.equal(fromWorktree, fromRoot, "a linked worktree must share its primary checkout's lock file");

    const otherRepoDir = mkdtempSync(join(unitRoot, "other-repo-"));
    scratchGit(otherRepoDir, "init", "-b", "main");
    scratchGit(otherRepoDir, "commit", "--allow-empty", "-m", "root", "--no-gpg-sign");
    const fromOtherRepo = resolveLockPath(otherRepoDir);
    assert.notEqual(fromOtherRepo, fromRoot, "an unrelated repo on the same machine must not collide");
  });
});

describe("noLockRequested", () => {
  it("is true only for HIVE_TEST_NO_LOCK=1, exactly", () => {
    assert.equal(noLockRequested({ HIVE_TEST_NO_LOCK: "1" }), true);
    assert.equal(noLockRequested({ HIVE_TEST_NO_LOCK: "true" }), false);
    assert.equal(noLockRequested({}), false);
  });
});

// This has to be separate OS processes, not concurrent promises in one
// process: Node's synchronous fs calls never yield mid-call, so a
// stat-then-create acquire (or a stat-then-remove takeover) never actually
// interleaves against ANOTHER promise in the same process - there is no
// event-loop turn between the two steps for a second promise to run in. Two
// real processes are scheduled by the kernel independently, which is the
// only way this repo can exercise the TOCTOU windows `wx`/`link` close, and
// it is also what "two processes racing for the lock" (todo 401) literally
// describes.
const suiteLockUrl = new URL("../scripts/suite-lock.mjs", import.meta.url).href;

function writeRaceWorker(path, holdMs) {
  // releasedAt is measured AFTER lock.release(), not before (counselors
  // round 1, fable-5): measuring it before release() means a false
  // acquisition landing during the gap between the timestamp and the actual
  // release call is invisible to the overlap check below. Over-approximating
  // the hold window is the safe direction for an assertion whose whole job
  // is proving windows never overlap.
  writeFileSync(
    path,
    `import { acquireSuiteLock } from ${JSON.stringify(suiteLockUrl)};\n` +
      `import { writeFileSync } from "node:fs";\n` +
      `const [, , lockPath, resultPath] = process.argv;\n` +
      `const lock = await acquireSuiteLock({\n` +
      `  lockPath,\n` +
      `  holder: { pid: process.pid, branch: "race-worker", worktree: "/race" },\n` +
      // ttlMs bounded (counselors round 2, opus): without this, a real
      // regression that produces an unreclaimable lock turns this test into
      // a silent 20-minute CI stall instead of a fast, readable failure. 30s
      // against a 150ms hold leaves no legitimate case anywhere near it.
      `  ttlMs: 30000,\n` +
      `  pollIntervalMs: 5,\n` +
      `  reportIntervalMs: 60000,\n` +
      `});\n` +
      `const acquiredAt = Date.now();\n` +
      `await new Promise((r) => setTimeout(r, ${holdMs}));\n` +
      `lock.release();\n` +
      `const releasedAt = Date.now();\n` +
      `writeFileSync(resultPath, JSON.stringify({ pid: process.pid, acquiredAt, releasedAt }));\n`,
  );
}

function runRaceWorkers(workerFile, lockPath, count) {
  return Promise.all(
    Array.from({ length: count }, (_, i) => {
      const resultPath = join(unitRoot, `race-result-${Math.random().toString(36).slice(2)}-${i}.json`);
      return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [workerFile, lockPath, resultPath], { stdio: "ignore" });
        child.on("error", reject);
        child.on("exit", (code) => {
          if (code !== 0) {
            reject(new Error(`race worker ${i} exited ${code}`));
            return;
          }
          resolve(JSON.parse(readFileSync(resultPath, "utf8")));
        });
      });
    }),
  );
}

function assertNoOverlap(results) {
  for (let a = 0; a < results.length; a++) {
    for (let b = a + 1; b < results.length; b++) {
      const overlap = results[a].acquiredAt < results[b].releasedAt && results[b].acquiredAt < results[a].releasedAt;
      assert.ok(
        !overlap,
        `pid ${results[a].pid} and pid ${results[b].pid} both held the lock at once: ${JSON.stringify(results)}`,
      );
    }
  }
}

describe("acquireSuiteLock: atomic acquire, across REAL processes", () => {
  it("never lets two separate processes hold the lock at once, starting from no lock", async () => {
    const lockPath = scratchLockDir();
    const workerFile = join(unitRoot, "race-worker-fresh.mjs");
    writeRaceWorker(workerFile, 150);
    assertNoOverlap(await runRaceWorkers(workerFile, lockPath, 5));
  });

  // Counselors round 1 (all three seats): the test above starts with NO lock
  // file, so every loser sees a live holder and waits - the takeover branch
  // (dead-pid, corrupt, invalid-startedAt) is never raced across processes,
  // only exercised single-process above. That gap hid a real bug: the
  // original `unlinkSync`-based takeover let two waiters who both read the
  // same stale holder both "win" - one unlinks the OTHER's freshly-written,
  // live lock. Seeding a dead-pid lock and racing every worker against the
  // TAKEOVER path closes that gap.
  it("never lets two separate processes hold the lock at once, racing a TAKEOVER of a dead holder", async () => {
    const lockPath = scratchLockDir();
    const dead = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: dead.pid, branch: "corpse", worktree: "/gone", startedAt: new Date().toISOString() }),
    );

    const workerFile = join(unitRoot, "race-worker-takeover.mjs");
    writeRaceWorker(workerFile, 150);
    // MEASURED against the unlinkSync-based takeover this replaced: this
    // test caught the double-hold 1 run in 13 (5 and 10 workers both tried;
    // more workers did not raise the rate - node's own process-startup time
    // staggers arrivals enough to swamp the race window more than added
    // contenders close it). This is a real, low-probability window, not a
    // flake: the mechanism is proven by that one catch plus the takeover fix
    // itself being a standard atomic-rename pattern, not by this test's
    // catch rate. Kept as regression coverage for the path, not as a
    // reliable single-run detector - do not tune worker count expecting a
    // higher strike rate; it was tried and did not move the needle.
    assertNoOverlap(await runRaceWorkers(workerFile, lockPath, 5));
  });
});

describe("acquireSuiteLock: dead-pid takeover", () => {
  it("reclaims a lock file whose recorded pid is gone, without waiting out the TTL", async () => {
    const lockPath = scratchLockDir();
    const dead = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
    const deadPid = dead.pid;
    assert.ok(deadPid > 0, "need a real pid that has already exited");

    writeFileSync(
      lockPath,
      JSON.stringify({ pid: deadPid, branch: "corpse", worktree: "/gone", startedAt: new Date().toISOString() }),
    );

    const start = Date.now();
    const lock = await acquireSuiteLock({
      lockPath,
      holder: holder(),
      ttlMs: DEFAULT_TTL_MS,
      pollIntervalMs: 5,
    });
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 2000, `dead-pid takeover must be near-instant, took ${elapsed}ms`);

    const written = JSON.parse(readFileSync(lockPath, "utf8"));
    assert.equal(written.pid, process.pid);
    lock.release();
    assert.equal(existsSync(lockPath), false, "release must actually remove the file it owns");
  });

  it("takes over a lock file that is not valid JSON", async () => {
    const lockPath = scratchLockDir();
    writeFileSync(lockPath, "not json");

    const lock = await acquireSuiteLock({ lockPath, holder: holder(), pollIntervalMs: 5 });
    lock.release();
  });

  // Split from the "not json" case above (counselors round 1, opus): that
  // one exercises only the JSON.parse-throws branch of readHolder(), never
  // the separate "parsed but not a real holder record" branch - dead
  // alternation, test/CLAUDE.md shape 1.
  it("takes over a lock file with valid JSON but no valid start time", async () => {
    const lockPath = scratchLockDir();
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, branch: "x", worktree: "/y", startedAt: "not-a-date" }));

    const lock = await acquireSuiteLock({ lockPath, holder: holder(), pollIntervalMs: 5 });
    lock.release();
  });

  it("takes over a lock file whose content is valid JSON `null`, rather than reading it as freed and spinning", async () => {
    const lockPath = scratchLockDir();
    writeFileSync(lockPath, "null");

    const start = Date.now();
    const lock = await acquireSuiteLock({ lockPath, holder: holder(), pollIntervalMs: 5 });
    assert.ok(Date.now() - start < 2000, "a null-content lock must take over promptly, not spin");
    lock.release();
  });
});

describe("acquireSuiteLock: live holder within TTL", () => {
  it("waits for a live, non-expired holder rather than taking over", async () => {
    const lockPath = scratchLockDir();
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: process.pid, branch: "other-lane", worktree: "/elsewhere", startedAt: new Date().toISOString() }),
    );

    let waited = false;
    const acquirePromise = acquireSuiteLock({
      lockPath,
      holder: holder(),
      ttlMs: 500,
      pollIntervalMs: 20,
      reportIntervalMs: 10_000,
    }).then(
      (lock) => {
        assert.ok(waited, "must wait for the live holder before ever acquiring");
        lock.release();
        return "acquired";
      },
      (err) => {
        throw err;
      },
    );

    await new Promise((r) => setTimeout(r, 60));
    waited = true;
    rmSync(lockPath); // the "other lane" finishes and releases
    assert.equal(await acquirePromise, "acquired");
  });

  it("bails with SuiteLockTimeoutError, bounded, when the live holder outlasts the TTL - the wait can never hang", async () => {
    const lockPath = scratchLockDir();
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: process.pid, branch: "wedged-lane", worktree: "/stuck", startedAt: new Date().toISOString() }),
    );

    const start = Date.now();
    await assert.rejects(
      acquireSuiteLock({ lockPath, holder: holder(), ttlMs: 150, pollIntervalMs: 20, reportIntervalMs: 10_000 }),
      SuiteLockTimeoutError,
    );
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 2000, `bounded wait must not hang - a CI machine with no contention must never see this path stall, took ${elapsed}ms`);
  });

  // Counselors round 1 (opus): the original version of this test only
  // re-asserted noLockRequested() itself, which stays green even if
  // run-tests.mjs's OWN wiring is deleted or broken - it pinned nothing
  // about the wrapper. This reads the wrapper's real source instead, the
  // same way suite-isolation.test.mjs pins tmux wiring by reading source
  // rather than by running the whole suite recursively.
  it("run-tests.mjs actually checks noLockRequested() before acquiring, for both lock-gated branches", () => {
    const source = readFileSync(new URL("../scripts/run-tests.mjs", import.meta.url), "utf8");
    const noLockCall = source.indexOf("noLockRequested()");
    const acquireCall = source.indexOf("acquireSuiteLock(");
    assert.notEqual(noLockCall, -1, "run-tests.mjs must call noLockRequested()");
    assert.notEqual(acquireCall, -1, "run-tests.mjs must call acquireSuiteLock()");
    assert.ok(noLockCall < acquireCall, "the escape-hatch check must be wired ahead of the acquire call, not after it");
  });

  // Counselors round 2 (fable-5): fix 3 (updateHolderPid) and the release()
  // call in the exit handler had NOTHING pinning their call sites - deleting
  // either stayed green under every test above, since those only exercise
  // the functions in isolation. Ordering matters for both: updateHolderPid
  // is only correct once child.pid exists, and release() has to run from
  // the SAME handler the manifest cleanup already relies on for every exit
  // path (normal, failure, forwarded signal).
  it("run-tests.mjs wires updateHolderPid after spawn() and release() inside the exit handler", () => {
    const source = readFileSync(new URL("../scripts/run-tests.mjs", import.meta.url), "utf8");
    const spawnCall = source.indexOf("spawn(process.execPath");
    const updateCall = source.indexOf("updateHolderPid(child.pid)");
    const exitHandler = source.indexOf('child.on("exit"');
    // Search FROM the exit handler on, not the first occurrence overall:
    // the child "error" handler added alongside it also calls release(),
    // for a different, earlier failure path, and that occurrence sits
    // before "exit" in the source.
    const releaseCallInExitHandler = source.indexOf("suiteLock?.release()", exitHandler);
    assert.notEqual(spawnCall, -1);
    assert.notEqual(updateCall, -1, "run-tests.mjs must call updateHolderPid(child.pid)");
    assert.notEqual(exitHandler, -1);
    assert.notEqual(releaseCallInExitHandler, -1, "run-tests.mjs must call suiteLock.release() inside the exit handler");
    assert.ok(spawnCall < updateCall, "updateHolderPid must be wired after spawn(), not before");
  });
});

describe("isSingleFileTarget", () => {
  // Counselors round 1 (all three seats): the shape that broke the original
  // "any positional arg is cheap" rule. existsFn is injected (a fake
  // set, not real fs.existsSync) so this stays a unit test rather than
  // depending on real files under test/.
  const exists = (...realPaths) => (path) => realPaths.includes(path);

  it("is true only for exactly one .test.mjs file that actually exists", () => {
    const existsFn = exists("/repo/test/foo.test.mjs");
    assert.equal(isSingleFileTarget(["test/foo.test.mjs"], "/repo", existsFn), true);
    assert.equal(isSingleFileTarget([], "/repo", existsFn), false, "no target is the full run, not cheap");
    assert.equal(isSingleFileTarget(["test/"], "/repo", existsFn), false, "a directory runs everything under it");
    assert.equal(
      isSingleFileTarget(["test/a.test.mjs", "test/b.test.mjs"], "/repo", existsFn),
      false,
      "more than one file",
    );
    assert.equal(
      isSingleFileTarget(["foo"], "/repo", existsFn),
      false,
      "a flag's own value misread as a target, e.g. --test-name-pattern foo",
    );
  });

  // Counselors round 2 (codex): a suffix match alone still misreads a
  // flag's own value as a cheap target when it happens to end in
  // `.test.mjs` but was never meant as one, e.g.
  // `--test-reporter-destination report.test.mjs` - that destination path
  // does not exist yet, which is exactly what existsFn now catches.
  it("rejects a .test.mjs-suffixed value that is not a real file", () => {
    const existsFn = exists(); // nothing exists
    assert.equal(isSingleFileTarget(["report.test.mjs"], "/repo", existsFn), false);
  });
});

describe("acquireSuiteLock: updateHolderPid", () => {
  // Counselors round 1 (codex): the lock is acquired before run-tests.mjs
  // spawns the process that actually runs the suite, so a liveness check
  // against the original holder pid watches the SUPERVISOR, not the
  // resource-holding work. A SIGKILL to the wrapper alone would leave the
  // still-running child behind a lock that reads as dead and gets reclaimed
  // instantly. updateHolderPid repoints the recorded pid once the real
  // worker exists, without resetting the TTL clock.
  it("repoints the recorded pid without changing startedAt, and release() still recognizes its own lock", async () => {
    const lockPath = scratchLockDir();
    const lock = await acquireSuiteLock({ lockPath, holder: holder({ pid: 424242 }), pollIntervalMs: 5 });
    const before = JSON.parse(readFileSync(lockPath, "utf8"));
    assert.equal(before.pid, 424242);

    await new Promise((r) => setTimeout(r, 20));
    lock.updateHolderPid(process.pid);
    const after = JSON.parse(readFileSync(lockPath, "utf8"));
    assert.equal(after.pid, process.pid, "pid must be repointed at the real worker");
    assert.equal(after.startedAt, before.startedAt, "updating the pid must not reset the TTL clock");

    lock.release();
    assert.equal(existsSync(lockPath), false, "release() must still remove the lock after its pid was repointed");
  });
});

describe("takeover: content verification (deterministic, not raced)", () => {
  // PR gate finding on this PR: the cross-process race test only reaches
  // the mismatch/restore branch probabilistically (~1 in 13 runs), so a
  // regression there could stay green on most CI runs. These call
  // takeover() directly with a deliberately wrong `expectedRaw` to force
  // both branches every time, deterministically.
  it("restores a live lock it accidentally stole, unchanged, when the content no longer matches what was read", () => {
    const lockPath = scratchLockDir();
    const liveContent = JSON.stringify({ pid: process.pid, branch: "live", worktree: "/x", startedAt: new Date().toISOString() });
    writeFileSync(lockPath, liveContent);

    takeover(lockPath, "test: forced stale decision", "content that no longer matches what is on disk");

    assert.equal(readFileSync(lockPath, "utf8"), liveContent, "the live lock must be restored byte-for-byte");
  });

  it("takes over cleanly when the content still matches exactly what was read", () => {
    const lockPath = scratchLockDir();
    const staleContent = JSON.stringify({ pid: 999999, branch: "dead", worktree: "/y", startedAt: new Date().toISOString() });
    writeFileSync(lockPath, staleContent);

    takeover(lockPath, "test: matching stale content", staleContent);

    assert.equal(existsSync(lockPath), false, "a genuine takeover must remove the stale file");
  });

  // PR gate finding (second round): a third test here claimed to pin the
  // documented accepted-residual EEXIST branch (a third process recreating
  // lockPath between the restore's rename and its own linkSync) but never
  // actually reached it - nothing in a single synchronous takeover() call
  // can recreate lockPath mid-call without real concurrent processes, so
  // `assert.doesNotThrow` passed identically whether that branch existed,
  // was deleted, or had its condition inverted. Removed rather than kept as
  // a test that cannot fail in the direction that matters (test/CLAUDE.md).
  // The residual itself stays documented in the code comment above
  // takeover(), which is the honest claim: an accepted, narrow, un-testable-
  // without-real-processes edge case, not a guaranteed property to pin.
});

describe("releaseSuiteLock", () => {
  it("does not delete a lock file that was taken over by someone else", () => {
    const lockPath = scratchLockDir();
    writeFileSync(lockPath, JSON.stringify({ pid: 999999, branch: "us", worktree: "/x", startedAt: new Date().toISOString() }));

    // Simulate a takeover happening between our write and our release.
    writeFileSync(lockPath, JSON.stringify({ pid: 111111, branch: "new-owner", worktree: "/y", startedAt: new Date().toISOString() }));

    releaseSuiteLock(lockPath, 999999);
    const stillThere = JSON.parse(readFileSync(lockPath, "utf8"));
    assert.equal(stillThere.pid, 111111, "release must not remove a lock it no longer owns");
  });

  it("is a no-op when the file is already gone", () => {
    const lockPath = scratchLockDir();
    assert.doesNotThrow(() => releaseSuiteLock(lockPath, process.pid));
  });
});
