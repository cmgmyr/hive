// Todo 401. Three lanes ran full suites at once; one got 21 failures and 14
// cancelled, none of them in its own diff - indistinguishable from a real
// regression in the lane whose diff DID cover those files. A written decision
// against concurrent full suites already existed and did not fire, because it
// lived in a paragraph a lead had to remember while doing something else. This
// file is the choke point instead: `scripts/run-tests.mjs` is what `npm test`
// actually is, so a lock here cannot be forgotten or skipped by accident.
//
// NOT hive's OWN LEASES, even though they are the right shape (named,
// project-scoped, TTL'd, self-expiring). Reaching them means this script
// opening the store, and `defaultStoreRefusal()` (src/dataDir.ts, todo 324)
// refuses the default store to any process that is not one of hive's five
// product entry points - this script is not one. `HIVE_ALLOW_DEFAULT_STORE=1`
// exists for a human's one-off script; wiring the test runner to set it would
// blunt a guard whose whole job is keeping test tooling off the live store.
// So: a plain OS lock file, keyed on `git rev-parse --git-common-dir` so every
// worktree of one checkout shares it and a different repo on the same machine
// never collides.
import { execFileSync } from "node:child_process";
import { existsSync, linkSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const LOCK_FILE_NAME = "hive-test-suite.lock";

// The suite itself runs clean in a few minutes. This TTL only fires against a
// LIVE holder that has made no progress in 20 minutes - a genuine wedge - and
// a wedge is the one case a lock must NOT paper over by taking the lock
// anyway: two full suites running at once is exactly the bug this file
// exists to prevent, and a wedged-but-alive pid is not proof the first run is
// safe to duplicate. So a wedge BAILS rather than takes over (see
// acquireSuiteLock below); a genuinely DEAD pid is reclaimed immediately,
// never waiting out this bound.
export const DEFAULT_TTL_MS = 20 * 60 * 1000;
const DEFAULT_POLL_MS = 2000;
const DEFAULT_REPORT_MS = 30 * 1000;

export class SuiteLockTimeoutError extends Error {
  constructor(holder, heldMs, lockPath) {
    super(
      `suite lock held by pid ${holder.pid} (branch ${holder.branch}, worktree ${holder.worktree}) ` +
        `for ${Math.round(heldMs / 1000)}s with no sign of finishing or dying - bailing rather than risk ` +
        // Counselors round 1 (opus): this used to say "delete the lock file"
        // with no path. A dead-pid lock reclaims itself instantly (see
        // isAlive below); the only way to land here is pid reuse, where a
        // human has to intervene, so naming the exact file is the difference
        // between an actionable message and a stuck night.
        `running the full suite twice. If that process is actually gone, delete ${lockPath} and re-run; ` +
        `otherwise HIVE_TEST_NO_LOCK=1 skips this entirely.`,
    );
    this.name = "SuiteLockTimeoutError";
    this.holder = holder;
    this.heldMs = heldMs;
    this.lockPath = lockPath;
  }
}

// Only the directory shape context.ts's gitPrimaryRoot() needs (a genuine
// primary checkout's common dir has basename exactly ".git", not a bare repo
// or a `--separate-git-dir` checkout) matters for PROJECT IDENTITY, which
// this is not: any --git-common-dir output is a directory every worktree of
// this checkout shares and no other checkout does, which is the entire
// requirement here. No edge-case rejection needed.
export function resolveLockPath(cwd = process.cwd()) {
  const commonDir = execFileSync("git", ["rev-parse", "--git-common-dir"], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 2000,
  }).trim();
  // realpathSync, same as context.ts's gitPrimaryRoot and for the same
  // reason: git resolves symlinks in the common-dir it returns from a linked
  // worktree but not always from the primary checkout's own root (measured
  // on macOS - /tmp vs /private/tmp), so the primary-root call and the
  // worktree call disagree about the SAME directory unless both are
  // normalized the same way.
  return join(realpathSync(resolve(cwd, commonDir)), LOCK_FILE_NAME);
}

// Pulled out of run-tests.mjs so the escape hatch is one testable function
// rather than an inline env check nothing exercises directly.
export function noLockRequested(env = process.env) {
  return env.HIVE_TEST_NO_LOCK === "1";
}

// Pulled out of run-tests.mjs for the same reason. Counselors round 1 (all
// three seats): "any positional argument means the caller named a cheap
// target" was wrong - `npm test -- test/` is one positional argument and
// runs the WHOLE suite. Only a single, explicit `.test.mjs` file is cheap
// enough to skip the lock; a directory, several files, or a flag's own
// value landing here as a false positional all take it instead.
// Counselors round 2 (codex): a suffix check alone still misreads a flag's
// OWN value as a target when that value happens to end in `.test.mjs` -
// `npm test -- --test-reporter-destination report.test.mjs` reads `named`,
// classifies `report.test.mjs` as cheap, and skips the lock while node
// --test actually falls back to full discovery. `existsFn` (real fs.existsSync
// by default, injectable for the unit test below) closes the realistic case:
// an unwritten report-destination path does not exist yet, so it no longer
// passes as a real target.
export function isSingleFileTarget(positionalArgs, cwd = process.cwd(), existsFn = existsSync) {
  return (
    positionalArgs.length === 1 &&
    positionalArgs[0].endsWith(".test.mjs") &&
    existsFn(resolve(cwd, positionalArgs[0]))
  );
}

export function currentHolder(cwd = process.cwd()) {
  const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 2000,
  }).trim();
  return { pid: process.pid, branch, worktree: cwd };
}

// ESRCH is the only thing `process.kill(pid, 0)` returns that PROVES the pid
// is gone. Any other outcome (alive, or EPERM - alive but owned by someone
// else) has to be treated as alive: the same rule test/CLAUDE.md already
// states for a leaked tmux socket probe - a holder is a survivor unless
// something actually proved it dead.
// Exported for scripts/sweep-scratch.mjs (todo 402): before reaping a live
// scratch tmux server, it needs the identical "is the recorded holder still
// alive" answer this file's own takeover logic rests on, not a second
// hand-copied kill(pid, 0) that could drift from the ESRCH-vs-EPERM
// distinction the comment below argues for.
export function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code !== "ESRCH";
  }
}

// Returns { record, raw } so a caller that decides to take over can verify,
// after the fact, that the file it removed was still the exact bytes it
// inspected (see takeover() below) - or null if the file is genuinely gone.
// Exported for scripts/sweep-scratch.mjs (todo 402), for the same reason as
// isAlive above - the corrupt/non-numeric-pid handling here is exactly what
// a second reader needs too, not something safe to re-derive independently.
export function readHolder(lockPath) {
  let raw;
  try {
    raw = readFileSync(lockPath, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return null; // freed between our EEXIST and this read
    throw err;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { record: { corrupt: true }, raw };
  }
  // Counselors round 1: a lock file whose content parses but isn't a real
  // holder record (JSON `null`, an array, a bare number) must not read as
  // "freed" the way a genuinely missing file does above - `existing === null`
  // is the ENOENT branch's signal to retry with no wait, and JSON.parse(
  // "null") === null would fall into that same branch and spin a tight,
  // sleepless, TTL-free loop against a file it can never remove.
  // Counselors round 2 (opus): a record with no NUMERIC pid is worse than
  // corrupt - isAlive() cannot disprove it (process.kill(undefined, 0)
  // throws something other than ESRCH, which this file's own isAlive reads
  // as "alive"), so it would wait out the full TTL rather than reclaiming
  // promptly. Reachable from a partial write further up the chain (see
  // run-tests.mjs); treat it the same as any other unusable record.
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed) || typeof parsed.pid !== "number") {
    return { record: { corrupt: true }, raw };
  }
  return { record: parsed, raw };
}

// Write-then-link, not create-then-write. `open(lockPath, "wx")` followed by
// a second write() syscall is exclusive but NOT content-atomic: a reader can
// open lockPath in the window between its creation and its write landing and
// see an empty or partial file, which readHolder() below has to treat as
// corrupt - and corrupt takes over immediately (a lock whose content cannot
// be trusted is the anonymous-holder failure this file exists to avoid).
// MEASURED: five real processes racing this test's own cross-process race
// test hit that exact window and one took over a lock a live holder still
// held, mid-hold - a false takeover, not a missed one. Writing the full
// content to a per-process temp file first, then `link()`ing it into place,
// keeps both properties: link() is exclusive the same way open(wx) is
// (EEXIST if lockPath is already there), and because the temp file is
// already complete before the link exists, lockPath itself is never
// observable in a partial state.
function writeLockFile(lockPath, holder) {
  const tmpPath = `${lockPath}.tmp-${process.pid}`;
  writeFileSync(tmpPath, JSON.stringify(holder, null, 2));
  try {
    linkSync(tmpPath, lockPath);
  } finally {
    unlinkSync(tmpPath);
  }
}

// Overwrites a lock file we already, exclusively hold - used only by
// updateHolderPid above. renameSync (not link) on purpose: unlike creation,
// this has no exclusivity requirement, since only the current holder ever
// calls it, so an atomic REPLACE is what's needed, not an atomic CREATE.
function overwriteLockFile(lockPath, holder) {
  const tmpPath = `${lockPath}.tmp-${process.pid}`;
  writeFileSync(tmpPath, JSON.stringify(holder, null, 2));
  renameSync(tmpPath, lockPath);
}

function removeLockFile(lockPath) {
  try {
    unlinkSync(lockPath);
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
}

// renameSync ALONE is NOT sufficient here, and round 1's version of this
// comment was wrong about that (counselors round 2, all three seats
// independently found the same ABA hole in round 1's fix). rename() only
// requires its SOURCE PATH to exist - it does not check that what is there
// is still the stale file that was read. Two waiters A and B racing the
// same stale holder:
//   A: rename(lockPath -> A's parked) succeeds; A verifies, recreates -
//      lockPath now holds A's fresh, LIVE lock.
//   B, only now scheduled: rename(lockPath -> B's parked) ALSO succeeds -
//      the source path still exists, it is just A's live lock now, not the
//      stale one B decided to steal. Round 1's fix stopped there and both
//      A and B believed they held the lock - the identical double-hold,
//      reached one step later.
// The fix is CONTENT verification, not just path existence: after the
// rename, compare the parked file's raw bytes against what was read before
// deciding to steal. A match proves nothing changed underneath; the steal is
// genuine. A mismatch means the stolen file was already live and DIFFERENT -
// link (not rename) it back, exclusively, so a THIRD process that has
// already recreated lockPath in that gap correctly wins over the restore
// rather than being clobbered by it.
//
// ACCEPTED RESIDUAL (counselors round 2, opus): between the mismatch rename
// and the restore link, lockPath is briefly, genuinely empty, and a THIRD
// process doing an ordinary fresh acquire there is indistinguishable from
// the legitimate case - it can create a lock while A is still actually
// running, producing a double-hold through this narrower door instead.
// Closing that needs a real OS-level advisory lock (flock), which Node core
// does not expose. Reaching it requires an already-exceptional state (a
// dead/stale/corrupt lock, itself only produced by a crash) PLUS landing in
// a sub-millisecond restore window - orders of magnitude narrower than the
// bug this fixes. This is the correct stopping point without reaching for a
// dependency, not an oversight.
// Exported so the mismatch/restore branch below can be tested
// DETERMINISTICALLY. The cross-process race test only reaches it
// probabilistically (~1 in 13 runs, per the takeover-race test's own
// comment) - a regression that drops the restore, or flips the `!==`, could
// stay green on most CI runs without a direct test forcing the branch.
export function takeover(lockPath, reason, expectedRaw) {
  const parkedPath = `${lockPath}.stale-${process.pid}`;
  try {
    renameSync(lockPath, parkedPath);
  } catch (err) {
    if (err.code === "ENOENT") return; // someone else already reclaimed it
    throw err;
  }

  let stolenRaw;
  try {
    stolenRaw = readFileSync(parkedPath, "utf8");
  } catch {
    stolenRaw = null; // shouldn't happen; treated as a mismatch below, the safe direction
  }

  if (stolenRaw !== expectedRaw) {
    try {
      linkSync(parkedPath, lockPath); // exclusive: loses cleanly to a third process's fresh lock
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
    }
    removeLockFile(parkedPath);
    return;
  }

  console.log(`[suite-lock] ${reason}; taking over ${lockPath}`);
  removeLockFile(parkedPath);
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Waits for an exclusive full-suite lock at lockPath, writing `holder`
// (pid/branch/worktree) once acquired. Returns { release() }. Throws
// SuiteLockTimeoutError if a live, non-expired holder is still there after
// ttlMs - see the TTL comment above for why that bails instead of taking
// over. `now`/`wait` are injectable so the race and timeout tests below run
// in milliseconds instead of minutes.
export async function acquireSuiteLock({
  lockPath,
  holder,
  ttlMs = DEFAULT_TTL_MS,
  pollIntervalMs = DEFAULT_POLL_MS,
  reportIntervalMs = DEFAULT_REPORT_MS,
  now = Date.now,
  wait = defaultSleep,
}) {
  let lastReport = 0;
  for (;;) {
    try {
      const startedAtIso = new Date(now()).toISOString();
      writeLockFile(lockPath, { ...holder, startedAt: startedAtIso });
      let ownerPid = holder.pid;
      return {
        release: () => releaseSuiteLock(lockPath, ownerPid),
        // Counselors round 1 (codex): the lock is acquired before the
        // wrapper spawns the process that actually runs the suite, so a
        // liveness check against holder.pid alone watches the SUPERVISOR,
        // not the resource-holding work. A SIGKILL to the wrapper specifically
        // (uncatchable, so it cannot release) leaves the still-running child
        // behind a lock that now reads as dead pid and gets reclaimed
        // instantly - a false takeover while the original suite is still
        // running. The caller repoints the recorded pid at the real worker
        // once it exists; overwriteLockFile keeps the ORIGINAL startedAt so
        // this does not reset the TTL clock, and ownerPid is updated in the
        // closure so release() still recognizes its own lock afterward.
        updateHolderPid: (pid) => {
          ownerPid = pid;
          overwriteLockFile(lockPath, { ...holder, pid, startedAt: startedAtIso });
        },
      };
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
    }

    const found = readHolder(lockPath);
    if (found === null) continue; // freed since the EEXIST above; retry now
    const { record: existing, raw } = found;

    if (existing.corrupt) {
      takeover(lockPath, "lock file was unreadable or invalid", raw);
      continue;
    }

    if (!isAlive(existing.pid)) {
      takeover(lockPath, `holder pid ${existing.pid} is gone`, raw);
      continue;
    }

    const startedAt = Date.parse(existing.startedAt);
    if (!Number.isFinite(startedAt)) {
      takeover(lockPath, "lock file has no valid start time", raw);
      continue;
    }

    const heldMs = now() - startedAt;
    if (heldMs > ttlMs) {
      throw new SuiteLockTimeoutError(existing, heldMs, lockPath);
    }

    if (now() - lastReport >= reportIntervalMs) {
      console.log(
        `[suite-lock] waiting: full suite locked by pid ${existing.pid} ` +
          `(branch ${existing.branch}, worktree ${existing.worktree}), held ${Math.round(heldMs / 1000)}s`,
      );
      lastReport = now();
    }

    await wait(pollIntervalMs);
  }
}

export function releaseSuiteLock(lockPath, ownerPid) {
  const found = readHolder(lockPath);
  const existing = found?.record;
  // Not ours to remove: something already took it over (dead-pid reclaim, or
  // a corrupt-file takeover) while we still thought we held it.
  if (existing && !existing.corrupt && existing.pid !== ownerPid) return;
  removeLockFile(lockPath);
}
