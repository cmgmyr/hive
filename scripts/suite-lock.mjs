import { execFileSync } from "node:child_process";
import { existsSync, linkSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const LOCK_FILE_NAME = "hive-test-suite.lock";

export const DEFAULT_TTL_MS = 20 * 60 * 1000;
const DEFAULT_POLL_MS = 2000;
const DEFAULT_REPORT_MS = 30 * 1000;

export class SuiteLockTimeoutError extends Error {
  constructor(holder, heldMs, lockPath) {
    super(
      `suite lock held by pid ${holder.pid} (branch ${holder.branch}, worktree ${holder.worktree}) ` +
        `for ${Math.round(heldMs / 1000)}s with no sign of finishing or dying - bailing rather than risk ` +

        `running the full suite twice. If that process is actually gone, delete ${lockPath} and re-run; ` +
        `otherwise HIVE_TEST_NO_LOCK=1 skips this entirely.`,
    );
    this.name = "SuiteLockTimeoutError";
    this.holder = holder;
    this.heldMs = heldMs;
    this.lockPath = lockPath;
  }
}

export function resolveLockPath(cwd = process.cwd()) {
  const commonDir = execFileSync("git", ["rev-parse", "--git-common-dir"], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 2000,
  }).trim();

  return join(realpathSync(resolve(cwd, commonDir)), LOCK_FILE_NAME);
}

export function noLockRequested(env = process.env) {
  return env.HIVE_TEST_NO_LOCK === "1";
}

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

export function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code !== "ESRCH";
  }
}

export function readHolder(lockPath) {
  let raw;
  try {
    raw = readFileSync(lockPath, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { record: { corrupt: true }, raw };
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed) || typeof parsed.pid !== "number") {
    return { record: { corrupt: true }, raw };
  }
  return { record: parsed, raw };
}

function writeLockFile(lockPath, holder) {
  const tmpPath = `${lockPath}.tmp-${process.pid}`;
  writeFileSync(tmpPath, JSON.stringify(holder, null, 2));
  try {
    linkSync(tmpPath, lockPath);
  } finally {
    unlinkSync(tmpPath);
  }
}

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

export function takeover(lockPath, reason, expectedRaw) {
  const parkedPath = `${lockPath}.stale-${process.pid}`;
  try {
    renameSync(lockPath, parkedPath);
  } catch (err) {
    if (err.code === "ENOENT") return;
    throw err;
  }

  let stolenRaw;
  try {
    stolenRaw = readFileSync(parkedPath, "utf8");
  } catch {
    stolenRaw = null;
  }

  if (stolenRaw !== expectedRaw) {
    try {
      linkSync(parkedPath, lockPath);
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

        updateHolderPid: (pid) => {
          ownerPid = pid;
          overwriteLockFile(lockPath, { ...holder, pid, startedAt: startedAtIso });
        },
      };
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
    }

    const found = readHolder(lockPath);
    if (found === null) continue;
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

  if (existing && !existing.corrupt && existing.pid !== ownerPid) return;
  removeLockFile(lockPath);
}
