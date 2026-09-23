import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { storeDir } from "./dataDir.js";
import { versionInfo } from "./version.js";

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_FILE = "update-check.json";
const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)$/;

export interface UpdateCheck {
  current: string;
  latest: string | null;
  status: "newer" | "current" | "unknown";
  reason: string | null;
  checkedAt: string | null;
}

type CacheRecord = { checked_at: string; latest: string | null; error: string | null };

function currentVersion(): string {
  return versionInfo().line.match(/^hive\s+(\S+)/)?.[1] ?? "0.0.0";
}

function compareVersions(current: string, latest: string): "newer" | "current" | "unknown" {
  const currentMatch = VERSION_RE.exec(current);
  const latestMatch = VERSION_RE.exec(latest);
  if (!currentMatch || !latestMatch) return "unknown";
  for (let i = 1; i <= 3; i += 1) {
    const difference = Number(latestMatch[i]) - Number(currentMatch[i]);
    if (difference > 0) return "newer";
    if (difference < 0) return "current";
  }
  return "current";
}

function fromCache(record: CacheRecord): UpdateCheck {
  const current = currentVersion();
  if (record.error !== null) {
    return { current, latest: null, status: "unknown", reason: record.error, checkedAt: record.checked_at };
  }
  const latest = typeof record.latest === "string" ? record.latest : null;
  const status = latest === null ? "unknown" : compareVersions(current, latest);
  return {
    current,
    latest,
    status,
    reason: status === "unknown" ? "unparseable version" : null,
    checkedAt: record.checked_at,
  };
}

function cachePath(): string {
  return join(storeDir(), CACHE_FILE);
}

export function readCachedUpdate(): UpdateCheck | null {
  try {
    const raw = JSON.parse(readFileSync(cachePath(), "utf8")) as Partial<CacheRecord>;
    if (typeof raw.checked_at !== "string" || (typeof raw.latest !== "string" && raw.latest !== null) || (typeof raw.error !== "string" && raw.error !== null)) {
      return null;
    }
    return fromCache({ checked_at: raw.checked_at, latest: raw.latest, error: raw.error });
  } catch {
    return null;
  }
}

function writeCache(result: UpdateCheck): void {
  const dir = storeDir();
  mkdirSync(dir, { recursive: true });
  const path = cachePath();
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify({ checked_at: result.checkedAt, latest: result.latest, error: result.reason }));
  renameSync(temporary, path);
}

export function refreshUpdate(): UpdateCheck {
  const current = currentVersion();
  const checkedAt = new Date().toISOString();
  let latest: string | null = null;
  let reason: string | null = null;
  if (process.env.HIVE_NO_UPDATE_CHECK === "1") {
    reason = "disabled (HIVE_NO_UPDATE_CHECK)";
  } else {
    try {
      latest = execFileSync("npm", ["view", "@cmgmyr/hive", "version"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 5000,
      }).trim();
      if (!VERSION_RE.test(latest) || !VERSION_RE.test(current)) reason = "unparseable version";
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      reason = code === "ENOENT" ? "npm not found" : code === "ETIMEDOUT" ? "timed out" : "offline or npm failed";
    }
  }
  const status = reason === null && latest !== null ? compareVersions(current, latest) : "unknown";
  const result: UpdateCheck = { current, latest, status, reason, checkedAt };
  writeCache(result);
  return result;
}

export function cacheIsStale(update: UpdateCheck | null, now = Date.now()): boolean {
  if (!update?.checkedAt) return true;
  const checked = Date.parse(update.checkedAt);
  return !Number.isFinite(checked) || now - checked >= CACHE_TTL_MS;
}

export function updateLine(update: UpdateCheck): string {
  if (update.status === "newer" && update.latest) {
    return `update available: hive ${update.latest} (you have ${update.current}); run: npm install -g @cmgmyr/hive@latest && hive setup`;
  }
  if (update.status === "current") return `up to date: hive ${update.current} is the latest on npm`;
  return `update check: unknown (${update.reason ?? "offline or npm failed"})`;
}

export function shouldAutoRefresh(): boolean {
  return process.stdout.isTTY === true && !process.env.CI && process.env.HIVE_NO_UPDATE_CHECK !== "1";
}
