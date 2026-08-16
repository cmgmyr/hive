import type Database from "better-sqlite3";
import SqliteDb from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { errorMessage } from "./result.js";

export const BACKUP_DIRNAME = "backups";
export type BackupReason = "migration" | "hourly" | "manual";

export function backupsDir(dataDir: string): string {
  return join(dataDir, BACKUP_DIRNAME);
}

function timestampPart(now: Date): string {
  return now.toISOString().replace(/[:.]/g, "-");
}

const SQL_DATETIME_FMT = "%Y-%m-%d %H:%M:%f";
const SQL_NOW = `strftime('${SQL_DATETIME_FMT}', 'now')`;

function finalSnapshotName(reason: BackupReason, now: Date, n: number): string {
  const base = `${timestampPart(now)}-${reason}`;
  return n === 0 ? base : `${base}-${n}`;
}

const NAME_PATTERN = /^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)-(migration|hourly|manual)(?:-\d+)?$/;

function parseSnapshotDirName(name: string): { createdAt: Date; reason: BackupReason } | null {
  const m = NAME_PATTERN.exec(name);
  if (!m) return null;
  const iso = m[1].replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, "T$1:$2:$3.$4Z");
  const createdAt = new Date(iso);
  if (Number.isNaN(createdAt.getTime())) return null;
  return { createdAt, reason: m[2] as BackupReason };
}

function dirSizeBytes(path: string): number {
  let total = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const full = join(path, entry.name);
    total += entry.isDirectory() ? dirSizeBytes(full) : statSync(full).size;
  }
  return total;
}

export interface SnapshotRef {
  name: string;
  path: string;
  createdAt: Date;
  reason: BackupReason;
}

export interface SnapshotInfo extends SnapshotRef {
  sizeBytes: number;
}

function listSnapshotRefs(dataDir: string): SnapshotRef[] {
  const dir = backupsDir(dataDir);
  let entries;
  try {

    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => {
      const parsed = parseSnapshotDirName(e.name);
      return parsed ? { name: e.name, path: join(dir, e.name), ...parsed } : null;
    })
    .filter((s): s is SnapshotRef => s !== null)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

export function listSnapshots(dataDir: string): SnapshotInfo[] {
  return listSnapshotRefs(dataDir).map((s) => ({ ...s, sizeBytes: dirSizeBytes(s.path) }));
}

export function totalSizeBytes(snapshots: SnapshotInfo[]): number {
  return snapshots.reduce((sum, s) => sum + s.sizeBytes, 0);
}

export interface BackupResult {
  ok: boolean;
  path?: string;
  error?: string;
}

export function takeSnapshot(
  db: Database.Database,
  dataDir: string,
  reason: BackupReason,
  now: Date = new Date(),
): BackupResult {
  const parent = backupsDir(dataDir);
  const staging = join(parent, `.staging-${randomUUID()}`);
  let completedAt = now;
  try {

    mkdirSync(parent, { recursive: true });
    mkdirSync(staging, { recursive: true });
    db.prepare("VACUUM INTO ?").run(join(staging, "hive.db"));

    completedAt = new Date();
    const profilesSrc = join(dataDir, "profiles");
    if (existsSync(profilesSrc)) {
      cpSync(profilesSrc, join(staging, "profiles"), { recursive: true });
    }
  } catch (e) {
    try {
      rmSync(staging, { recursive: true, force: true });
    } catch {

    }
    return { ok: false, error: errorMessage(e) };
  }

  let metaDb: InstanceType<typeof SqliteDb>;
  try {
    metaDb = new SqliteDb(join(staging, "hive.db"));
  } catch (e) {

    try {
      rmSync(staging, { recursive: true, force: true });
    } catch {

    }
    return { ok: false, error: errorMessage(e) };
  }
  let corruptError: unknown;
  try {
    const iso = completedAt.toISOString();
    metaDb
      .prepare(
        `UPDATE backup_meta SET last_attempt_at = strftime('${SQL_DATETIME_FMT}', ?), last_success_at = strftime('${SQL_DATETIME_FMT}', ?) WHERE id = 1`,
      )
      .run(iso, iso);
  } catch (e) {

    const code = (e as { code?: string }).code;
    if (code === "SQLITE_NOTADB" || code === "SQLITE_CORRUPT") corruptError = e;
  } finally {
    try {
      metaDb.close();
    } catch {

    }
  }
  if (corruptError !== undefined) {
    try {
      rmSync(staging, { recursive: true, force: true });
    } catch {

    }
    return { ok: false, error: errorMessage(corruptError) };
  }

  if (existsSync(join(staging, "hive.db-journal"))) {
    try {
      rmSync(staging, { recursive: true, force: true });
    } catch {

    }
    return { ok: false, error: "a rollback journal survived the snapshot's own backup_meta write" };
  }

  for (let n = 0; n < 1000; n++) {
    const dir = join(parent, finalSnapshotName(reason, now, n));
    try {
      renameSync(staging, dir);
      return { ok: true, path: dir };
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "ENOTEMPTY" && code !== "EEXIST") {
        try {
          rmSync(staging, { recursive: true, force: true });
        } catch {

        }
        return { ok: false, error: errorMessage(e) };
      }

    }
  }
  try {
    rmSync(staging, { recursive: true, force: true });
  } catch {

  }
  return { ok: false, error: `could not claim a snapshot name for ${reason} after 1000 attempts` };
}

export interface RetentionPolicy {
  keepLast: number;
  keepDailyDays: number;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

export function retentionPolicy(): RetentionPolicy {
  return {
    keepLast: envInt("HIVE_BACKUP_KEEP_LAST", 10),
    keepDailyDays: envInt("HIVE_BACKUP_KEEP_DAILY_DAYS", 7),
  };
}

const STALE_STAGING_MAX_AGE_MS = 60 * 60 * 1000;

function sweepStaleStagingDirs(dataDir: string, maxAgeMs: number = STALE_STAGING_MAX_AGE_MS): void {
  const dir = backupsDir(dataDir);
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  const cutoff = Date.now() - maxAgeMs;
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(".staging-")) continue;
    const full = join(dir, entry.name);
    try {
      if (statSync(full).mtimeMs < cutoff) rmSync(full, { recursive: true, force: true });
    } catch {

    }
  }
}

export function pruneSnapshots(
  dataDir: string,
  policy: RetentionPolicy = retentionPolicy(),
  now: Date = new Date(),
  protect: ReadonlySet<string> = new Set(),
): string[] {
  sweepStaleStagingDirs(dataDir);
  const snapshots = listSnapshotRefs(dataDir);

  const keepLast = Math.max(1, policy.keepLast);
  const keep = new Set<string>(snapshots.slice(0, keepLast).map((s) => s.name));

  for (const name of protect) keep.add(name);

  const cutoff = new Date(now);
  cutoff.setUTCDate(cutoff.getUTCDate() - policy.keepDailyDays);
  const seenDays = new Set<string>();
  for (const s of snapshots) {
    if (s.createdAt < cutoff) continue;
    const day = s.createdAt.toISOString().slice(0, 10);
    if (seenDays.has(day)) continue;
    seenDays.add(day);
    keep.add(s.name);
  }

  const removed: string[] = [];
  for (const s of snapshots) {
    if (keep.has(s.name)) continue;
    rmSync(s.path, { recursive: true, force: true });
    removed.push(s.name);
  }
  return removed;
}

export function backupNow(
  db: Database.Database,
  dataDir: string,
  reason: BackupReason,
  protect: ReadonlySet<string> = new Set(),
): BackupResult {
  const result = takeSnapshot(db, dataDir, reason);
  if (result.ok) {
    try {
      db.prepare(`UPDATE backup_meta SET last_success_at = ${SQL_NOW} WHERE id = 1`).run();
    } catch {

    }
    try {
      pruneSnapshots(dataDir, retentionPolicy(), new Date(), protect);
    } catch {

    }
  } else {
    try {
      db.prepare(`UPDATE backup_meta SET last_error = ?, last_error_at = ${SQL_NOW} WHERE id = 1`).run(
        result.error ?? "unknown error",
      );
    } catch {

    }
  }
  return result;
}

const hourlyClaimStmt = new WeakMap<Database.Database, Database.Statement>();
function claimStatement(db: Database.Database): Database.Statement {
  let stmt = hourlyClaimStmt.get(db);
  if (!stmt) {

    stmt = db.prepare(
      `UPDATE backup_meta SET last_attempt_at = ${SQL_NOW}
       WHERE id = 1 AND (
         last_attempt_at IS NULL
         OR last_attempt_at <= strftime('${SQL_DATETIME_FMT}', 'now', '-1 hours')
         OR last_attempt_at > ${SQL_NOW}
       )`,
    );
    hourlyClaimStmt.set(db, stmt);
  }
  return stmt;
}

export function maybeBackupHourly(db: Database.Database, dataDir: string): void {
  try {
    if (claimStatement(db).run().changes !== 1) return;
    backupNow(db, dataDir, "hourly");
  } catch {

  }
}

export function maybeBackupBeforeMigrations(db: Database.Database, dataDir: string, pendingCount: number): void {
  if (pendingCount <= 0) return;
  try {
    backupNow(db, dataDir, "migration");
  } catch {

  }
}

export interface BackupMetaRow {
  last_attempt_at: string | null;
  last_success_at: string | null;
  last_error: string | null;
  last_error_at: string | null;
}

export function readBackupMeta(db: Database.Database): BackupMetaRow | undefined {
  return db
    .prepare("SELECT last_attempt_at, last_success_at, last_error, last_error_at FROM backup_meta WHERE id = 1")
    .get() as BackupMetaRow | undefined;
}

export interface BackupHealth {
  ok: boolean;
  message: string;
}

export function backupHealth(db: Database.Database, dataDir: string): BackupHealth {

  const meta = readBackupMeta(db);
  const snapshots = listSnapshots(dataDir);
  const summary = `${snapshots.length} snapshot(s), ${formatBytes(totalSizeBytes(snapshots))} total`;

  const newest = snapshots.find((s) => existsSync(join(s.path, "hive.db")));

  if (!newest) {
    return { ok: false, message: `${summary}, nothing to restore from` };
  }

  const dirAt = (
    db.prepare(`SELECT strftime('${SQL_DATETIME_FMT}', ?) AS ts`).get(newest.createdAt.toISOString()) as {
      ts: string;
    }
  ).ts;

  let newestAt = dirAt;
  try {
    const snapDb = new SqliteDb(join(newest.path, "hive.db"), { readonly: true });
    try {
      const row = snapDb.prepare("SELECT last_success_at FROM backup_meta WHERE id = 1").get() as
        | { last_success_at: string | null }
        | undefined;
      if (row?.last_success_at != null && row.last_success_at > newestAt) newestAt = row.last_success_at;
    } finally {
      snapDb.close();
    }
  } catch {

  }

  const failedMostRecently = meta?.last_error_at != null && meta.last_error_at >= newestAt;
  if (failedMostRecently) {
    return { ok: false, message: `${summary}, last attempt failed at ${meta!.last_error_at}: ${meta!.last_error}` };
  }

  const staleDays = envInt("HIVE_BACKUP_STALE_DAYS", 7);
  const stale = (
    db
      .prepare(`SELECT (? <= strftime('${SQL_DATETIME_FMT}', 'now', ?)) AS stale`)
      .get(newestAt, `-${staleDays} days`) as { stale: number }
  ).stale;
  if (stale) {
    return {
      ok: false,
      message: `${summary}, last success ${newestAt} is more than ${staleDays} day(s) old`,
    };
  }
  return { ok: true, message: `${summary}, last success ${newestAt}` };
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  const units = ["K", "M", "G"];
  let value = n / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)}${units[unit]}`;
}

export interface RestorePreview {
  snapshot: SnapshotInfo;
  hasProfiles: boolean;
  currentDbPath: string;
  currentDbExists: boolean;
  currentDbSizeBytes: number;
}

export function findSnapshot(dataDir: string, name: string): SnapshotRef | undefined {
  return listSnapshotRefs(dataDir).find((s) => s.name === name);
}

export function previewRestore(dataDir: string, name: string): RestorePreview {
  const ref = findSnapshot(dataDir, name);
  if (!ref) {
    const available = listSnapshotRefs(dataDir);
    throw new Error(
      available.length === 0
        ? `No snapshot named "${name}" (there are no backups in ${backupsDir(dataDir)} yet).`
        : `No snapshot named "${name}". Available: ${available.map((s) => s.name).join(", ")}`,
    );
  }

  const snapshot: SnapshotInfo = { ...ref, sizeBytes: dirSizeBytes(ref.path) };
  const currentDbPath = join(dataDir, "hive.db");
  const currentDbExists = existsSync(currentDbPath);
  return {
    snapshot,
    hasProfiles: existsSync(join(ref.path, "profiles")),
    currentDbPath,
    currentDbExists,
    currentDbSizeBytes: currentDbExists ? statSync(currentDbPath).size : 0,
  };
}

export function restoreSnapshot(dataDir: string, name: string): { restoredProfiles: boolean } {
  const preview = previewRestore(dataDir, name);

  const tmpDbPath = `${preview.currentDbPath}.restoring`;
  cpSync(join(preview.snapshot.path, "hive.db"), tmpDbPath);
  renameSync(tmpDbPath, preview.currentDbPath);

  for (const suffix of ["-wal", "-shm"]) {
    rmSync(preview.currentDbPath + suffix, { force: true });
  }

  const liveProfiles = join(dataDir, "profiles");
  const stagingProfiles = `${liveProfiles}.restoring`;
  const oldProfiles = `${liveProfiles}.old`;

  if (existsSync(oldProfiles) && !existsSync(liveProfiles)) {
    renameSync(oldProfiles, liveProfiles);
  }

  const restoredProfiles = preview.hasProfiles;
  if (restoredProfiles) {

    rmSync(stagingProfiles, { recursive: true, force: true });
    rmSync(oldProfiles, { recursive: true, force: true });
    cpSync(join(preview.snapshot.path, "profiles"), stagingProfiles, { recursive: true });
    if (existsSync(liveProfiles)) renameSync(liveProfiles, oldProfiles);
    renameSync(stagingProfiles, liveProfiles);
    rmSync(oldProfiles, { recursive: true, force: true });
  }
  return { restoredProfiles };
}
