import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { errorMessage } from "./result.js";

// Automatic snapshots of the store (issue #23). This module takes a `db`
// handle and a `dataDir` as arguments rather than importing db.js, because
// db.ts's migrate() needs to call in here before applying migrations: db.ts
// importing this module while this module imported db.ts back would be a
// real cycle, not a benign one, since db.ts's own top-level statements are
// what this module needs to already have run.

export const BACKUP_DIRNAME = "backups";
export type BackupReason = "migration" | "hourly" | "manual";

export function backupsDir(dataDir: string): string {
  return join(dataDir, BACKUP_DIRNAME);
}

// The directory name IS the record: a sortable timestamp (so newest-first is
// also lexical order) plus the reason, with a disambiguating suffix when two
// candidates collide. No separate manifest file to fall out of sync with it.
function timestampPart(now: Date): string {
  return now.toISOString().replace(/[:.]/g, "-");
}

function finalSnapshotName(reason: BackupReason, now: Date, n: number): string {
  const base = `${timestampPart(now)}-${reason}`;
  return n === 0 ? base : `${base}-${n}`;
}

// Deliberately a directory name, not a row in backup_meta or a sidecar file:
// a store that has been destroyed (the disaster this whole issue is about)
// must still leave its backups listable from the filesystem alone, without
// depending on the very database that may be the thing that got destroyed.
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

// Newest first, matching how every caller wants to read them (retention,
// `hive backups`, restore's "most recent" default). No size here: sizing is
// a recursive directory walk per snapshot (dirSizeBytes below), and most
// callers - retention, and finding one snapshot by name - only need the
// name/path/reason/createdAt this returns. listSnapshots below adds size for
// the callers that actually display it.
function listSnapshotRefs(dataDir: string): SnapshotRef[] {
  const dir = backupsDir(dataDir);
  let entries;
  try {
    // Not existsSync-then-readdirSync: existsSync is true for a PATH that
    // exists as a plain file too (takeSnapshot's own failure mode when disk
    // or permissions turn "backups" into something that is not a directory),
    // and readdirSync on that throws ENOTDIR. listSnapshots backs
    // backupHealth, which doctor calls specifically to report when
    // something is broken - it must not itself throw for that same reason.
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

// The sized, display-ready listing for `hive backups` and `hive doctor`.
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

// The one thing this issue is about: VACUUM INTO, never a file copy. hive
// runs in WAL mode, so hive.db on disk is not a complete database -
// committed rows can sit in the WAL until a checkpoint. VACUUM INTO produces
// a consistent snapshot from a live database with concurrent writers, which
// is exactly hive's situation (every session runs its own server, and the
// scheduler ticks every 3 seconds in each one). A naive fs.copyFile of
// hive.db has measured this store missing more than half its rows; see the
// issue body and test/backup.test.mjs for the reproduction.
//
// Built in a private staging directory and renamed into place only once
// complete (PR #36, B3, folding in an earlier same-issue fix): a directory
// under backups/ with a real timestamp name is never anything but a
// finished snapshot, by construction, for two reasons at once.
//
// First, durability: a large VACUUM INTO takes real time, and writing
// straight to the final name meant a SIGKILL or power loss mid-write left an
// apparently-valid, actually-truncated directory sitting in backups/
// forever - `hive restore` would install it over the live store with no way
// to tell it was incomplete.
//
// Second, the exact race this issue was reopened for: staging directory
// NAMES are random (randomUUID), so two racing calls can never collide on
// the STAGING path, and the FINAL name is claimed with renameSync, which
// atomically replaces an EMPTY directory but throws ENOTEMPTY/EEXIST against
// a non-empty one - there is no window where two processes can both believe
// a name is free the way there was with an existsSync check followed by a
// separate mkdirSync(dir, {recursive:true}) (which does not throw on an
// existing directory): that let two processes both proceed to VACUUM INTO
// the same path, and the loser's failure handler rmSync'd the winner's
// already-completed snapshot out from under it. A loser here retries the
// next disambiguated name instead, and its cleanup only ever removes its own
// private staging directory - never anything a name search could not have
// invented itself.
// `now` defaults to the real clock for every real caller; it is a parameter
// (mirroring pruneSnapshots, PR #36, B6's fix) so a test can force two real
// racing processes onto the IDENTICAL candidate name deterministically,
// rather than hoping two independently-started processes happen to land in
// the same millisecond (they often do - see the comment above pruneSnapshots'
// cousin logic - but "often" is not "always", and this needs "always" to be
// a real regression test rather than an occasionally-quiet one).
export function takeSnapshot(
  db: Database.Database,
  dataDir: string,
  reason: BackupReason,
  now: Date = new Date(),
): BackupResult {
  const parent = backupsDir(dataDir);
  const staging = join(parent, `.staging-${randomUUID()}`);
  try {
    // Creating the parent has to be inside this try too, not just the
    // staging directory: a corrupted "backups" path (a plain file where a
    // directory belongs, e.g. from a prior disk-full mid-write) must still
    // come back as a BackupResult, not a throw past this function's
    // contract - a caller like backupNow relies on that to record
    // last_error at all.
    mkdirSync(parent, { recursive: true });
    mkdirSync(staging, { recursive: true });
    db.prepare("VACUUM INTO ?").run(join(staging, "hive.db"));
    const profilesSrc = join(dataDir, "profiles");
    if (existsSync(profilesSrc)) {
      cpSync(profilesSrc, join(staging, "profiles"), { recursive: true });
    }
  } catch (e) {
    try {
      rmSync(staging, { recursive: true, force: true });
    } catch {
      // Best effort; an orphaned staging directory is a disk-space problem
      // for a human to notice, not a correctness one - it can never be
      // listed, restored, or mistaken for a real snapshot (parseSnapshotDirName
      // rejects the name), which is the property that matters here.
    }
    return { ok: false, error: errorMessage(e) };
  }

  // 1000 attempts is not a real limit, it is a refusal to spin forever: this
  // only advances past n=0 when the final name is already taken, and a
  // thousand processes racing the identical millisecond+reason is not a
  // case worth serving silently.
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
          // See above.
        }
        return { ok: false, error: errorMessage(e) };
      }
      // Name taken; the next iteration tries the next disambiguated one.
    }
  }
  try {
    rmSync(staging, { recursive: true, force: true });
  } catch {
    // See above.
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

// Issue's suggested default: last 10, plus one per day for a week.
// Configurable because "snapshots are ~470K on a store of this age and will
// grow" is a bet on how one project's store grows, not a universal constant.
export function retentionPolicy(): RetentionPolicy {
  return {
    keepLast: envInt("HIVE_BACKUP_KEEP_LAST", 10),
    keepDailyDays: envInt("HIVE_BACKUP_KEEP_DAILY_DAYS", 7),
  };
}

// Deletes everything outside the policy and returns the names removed.
// Snapshots are read newest-first, so "the newest one seen for a given day"
// falls out of a single pass with a Set rather than needing a second sort.
// `now` defaults to the real clock for every real caller; it exists as a
// parameter (PR #36, B6) so a test can pin retention's day-boundary logic to
// a fixed instant instead of reading the clock. A test that computed its own
// fake snapshots relative to a local `now` while this function computed its
// cutoff from a SEPARATE `new Date()` at call time was really two clocks
// that happened to agree in one part of the day and disagree in another:
// whether "12 hours ago" falls on the same UTC calendar date as "now" flips
// exactly at 12:00Z, so the same test failed or passed depending on when it
// happened to run, and adjusting the fake offsets would only have moved the
// flip to a different hour rather than removing it.
// A staging directory (see takeSnapshot's B3 fix) that is still older than
// this when retention runs is orphaned: a SIGKILL or power loss mid-VACUUM
// leaves one behind forever, since nothing else ever looks at it -
// parseSnapshotDirName rejects the name on purpose, so it is invisible to
// listing, restore, and this very function's own keep/prune logic. Left
// alone, orphans accumulate and can fill the disk, silently, in the
// direction of making every LATER backup fail too (PR #36, C4).
//
// An hour, not the length of a real VACUUM INTO: a directory's mtime only
// moves when an entry is added or removed inside it (hive.db's own
// creation, then profiles/'s), not while SQLite continues writing into a
// file it already created - so a slow-but-genuinely-still-running backup
// can show an mtime several minutes old well before it is orphaned. An hour
// is generous enough that no real backup is ever mistaken for abandoned,
// while still reclaiming a crash's leftovers within a bounded time instead
// of never.
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
      // Gone already (another instance's retention won the race), or
      // unreadable; either way there is nothing more for this pass to do.
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
  // Floored at 1 (PR #36, B8): HIVE_BACKUP_KEEP_LAST=0 combined with
  // KEEP_DAILY_DAYS=0 would otherwise delete every snapshot, including the
  // one backupNow just created two statements ago, on every single backup,
  // forever, with doctor still reporting success. A retention policy can
  // empty itself down to nothing, never down to a store with no backups at
  // all.
  const keepLast = Math.max(1, policy.keepLast);
  const keep = new Set<string>(snapshots.slice(0, keepLast).map((s) => s.name));
  // Second counselors pass, C2: cmdRestore's pre-restore backup calls
  // backupNow with the RESTORE TARGET named here, so retention can never
  // delete the one snapshot the operator just confirmed. Without this, ten
  // same-day snapshots plus the default keepLast=10 meant taking an
  // eleventh (the pre-restore backup itself) pruned the oldest - which, if
  // that was the operator's chosen target, restoreSnapshot would then
  // report as not existing. The headline feature deleting the thing it was
  // just asked to restore is not a corner case worth leaving open.
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

// Takes a snapshot and records the result on the store-global backup_meta
// row. Three independently-caught steps, not one try around all of them
// (PR #36, B2/B9): a failure in any one must not skip the others, which a
// shared try did - on a fresh store, backup_meta could briefly not exist
// yet (db.ts now bootstraps it unconditionally so that specific case cannot
// happen any more, but the independence is worth keeping regardless, since
// pruneSnapshots failing for an unrelated reason - a permissions error on
// rmSync, say - must not un-succeed a backup that already completed).
//
// Success never clears last_error/last_error_at. A backup that fails at
// 10:00 and succeeds at 11:00 is still a store that failed once; clearing
// the evidence on the next success is the exact "a state that corrects
// itself still has to be readable afterwards" mistake CLAUDE.md already
// names agent_state_log against (issue #24). backupHealth below compares
// last_error_at to last_success_at to tell "has recovered" from "is still
// failing" without deleting either timestamp.
//
// `protect` (PR #36, C2) is passed straight through to pruneSnapshots: a
// caller taking this backup FOR a specific purpose - cmdRestore backing up
// the live store right before overwriting it - names the snapshot it is
// about to restore FROM, so retention can never be the thing that deletes
// the very snapshot the operator just confirmed.
export function backupNow(
  db: Database.Database,
  dataDir: string,
  reason: BackupReason,
  protect: ReadonlySet<string> = new Set(),
): BackupResult {
  const result = takeSnapshot(db, dataDir, reason);
  if (result.ok) {
    try {
      db.prepare("UPDATE backup_meta SET last_success_at = datetime('now') WHERE id = 1").run();
    } catch {
      // Bookkeeping is not the backup; the snapshot already succeeded.
    }
    try {
      pruneSnapshots(dataDir, retentionPolicy(), new Date(), protect);
    } catch {
      // Retention failing must not un-succeed a completed backup.
    }
  } else {
    try {
      db.prepare("UPDATE backup_meta SET last_error = ?, last_error_at = datetime('now') WHERE id = 1").run(
        result.error ?? "unknown error",
      );
    } catch {
      // Bookkeeping is not the backup; the caller still gets result.error.
    }
  }
  return result;
}

// Prepared once per db instance rather than on every call: this runs from
// the scheduler's 3-second tick, so an ordinary hour is ~1200 calls that
// (almost always) do nothing but this one UPDATE. Keyed by the db object,
// not a module-level singleton, because tests in this file open several
// independent Database instances in one process - a statement prepared
// against one is unusable (and unsafe to reuse) against another.
const hourlyClaimStmt = new WeakMap<Database.Database, Database.Statement>();
function claimStatement(db: Database.Database): Database.Statement {
  let stmt = hourlyClaimStmt.get(db);
  if (!stmt) {
    // The third disjunct is PR #36's B7: a future last_attempt_at (clock
    // skew on wake from sleep, or a restored snapshot carrying one) would
    // otherwise wedge every hourly backup for as long as the skew lasts,
    // silently, since nothing else ever moves this value backward. Claiming
    // whenever the stored value is not a sane recent past is what a clock
    // jumping in either direction should do: fail open toward taking a
    // backup, not toward silently taking none.
    stmt = db.prepare(
      `UPDATE backup_meta SET last_attempt_at = datetime('now')
       WHERE id = 1 AND (
         last_attempt_at IS NULL
         OR last_attempt_at <= datetime('now', '-1 hours')
         OR last_attempt_at > datetime('now')
       )`,
    );
    hourlyClaimStmt.set(db, stmt);
  }
  return stmt;
}

// Called from the scheduler tick. Rate-limited to once an hour across every
// concurrent server instance by reusing the wake-up claim shape: an atomic
// conditional UPDATE where only the instance whose update reports
// changes === 1 proceeds. Never throws: the scheduler must not go down over
// a backup, same rule as everything else it runs.
export function maybeBackupHourly(db: Database.Database, dataDir: string): void {
  try {
    if (claimStatement(db).run().changes !== 1) return;
    backupNow(db, dataDir, "hourly");
  } catch {
    // The scheduler must never throw.
  }
}

// Called from db.ts's migrate(), above the loop that applies MIGRATIONS.
// pendingCount is MIGRATIONS.length - applied.size: a schema change is the
// classic irreversible moment, and the check costs nothing when there is
// nothing pending. No claim on backup_meta needed here the way the hourly
// path has one: two processes racing to apply the same first migration both
// see it pending and both call backupNow, which is wasteful, not wrong -
// but only because takeSnapshot's staging-then-rename claim (B3) gives each
// one its own snapshot even when they land on the identical candidate name,
// which per its own comment is the common case, not the rare one. Before
// that fix this exact reasoning was the bug (PR #36): a second concurrency
// mechanism looked unnecessary because the race looked survivable, when the
// shared directory name meant it was destructive instead. It is genuinely
// survivable now, so a second claim here would only be spending complexity
// to avoid a wasted disk write, which is not worth it once per hive upgrade.
export function maybeBackupBeforeMigrations(db: Database.Database, dataDir: string, pendingCount: number): void {
  if (pendingCount <= 0) return;
  try {
    backupNow(db, dataDir, "migration");
  } catch {
    // A failing backup must never block a migration.
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

// The single place that decides whether the backup feature itself is
// healthy, so `hive doctor` renders a decision rather than making one
// (PR #36, B2/B9). Three ways to fail, checked in the order a human would
// ask them: did the most recent attempt fail (compared by timestamp, not by
// last_error being merely non-null, since success no longer clears it); has
// one ever succeeded at all; and has too long passed since the last one -
// both "never succeeded" and "succeeded 40 days ago" have to fail doctor,
// not just the first.
export function backupHealth(db: Database.Database, dataDir: string): BackupHealth {
  const meta = readBackupMeta(db);
  const snapshots = listSnapshots(dataDir);
  const summary = `${snapshots.length} snapshot(s), ${formatBytes(totalSizeBytes(snapshots))} total`;

  // Second counselors pass, C3: last_success_at is a historical record, not
  // proof anything is still on disk. Deleting backups/ right after a real
  // success left last_success_at fresh while there was nothing left to
  // restore from, and doctor reported "All good" - the same
  // trust-the-metadata-not-reality shape B2 already existed to remove for
  // the pre-migration path, now for this function's own answer.
  if (snapshots.length === 0) {
    return { ok: false, message: `${summary}, nothing to restore from` };
  }

  // >=, not >: datetime('now') is second-granularity, so a failure and a
  // later success can share one timestamp string on a store busy enough to
  // do both in the same second. A tie cannot prove the failure resolved, so
  // it reads as still-failed - the conservative side, matching this
  // function's whole reason to exist (do not let a success hide a failure).
  const failedMostRecently =
    meta?.last_error_at != null && (meta.last_success_at == null || meta.last_error_at >= meta.last_success_at);
  if (failedMostRecently) {
    return { ok: false, message: `${summary}, last attempt failed at ${meta!.last_error_at}: ${meta!.last_error}` };
  }
  if (meta?.last_success_at == null) {
    return { ok: false, message: `${summary}, no successful backup has ever completed` };
  }

  const staleDays = envInt("HIVE_BACKUP_STALE_DAYS", 7);
  const stale = (
    db
      .prepare("SELECT (last_success_at <= datetime('now', ?)) AS stale FROM backup_meta WHERE id = 1")
      .get(`-${staleDays} days`) as { stale: number }
  ).stale;
  if (stale) {
    return {
      ok: false,
      message: `${summary}, last success ${meta.last_success_at} is more than ${staleDays} day(s) old`,
    };
  }
  return { ok: true, message: `${summary}, last success ${meta.last_success_at}` };
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
  // Sized here, for this one match, rather than by findSnapshot: sizing is a
  // recursive walk, and pruneSnapshots and this lookup both run far more
  // often than a human looks at a size.
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

// Overwrites the live store's hive.db and profiles/ with a snapshot's copies.
// Callers MUST close their `db` handle before calling this: the file is
// about to be replaced out from under it, and a still-open better-sqlite3
// connection has its own -wal/-shm state that would otherwise race the
// files being removed here.
export function restoreSnapshot(dataDir: string, name: string): { restoredProfiles: boolean } {
  const preview = previewRestore(dataDir, name);

  // Copy-to-temp then rename, not remove-then-copy: this module exists
  // because a naive copy of a live db can be wrong, and a naive replace of
  // one is the same class of mistake in the other direction. A crash between
  // an rmSync and a cpSync would leave no hive.db at all; renameSync is
  // atomic on the same filesystem, so there is no instant where the store is
  // both no-longer-old and not-yet-new.
  const tmpDbPath = `${preview.currentDbPath}.restoring`;
  cpSync(join(preview.snapshot.path, "hive.db"), tmpDbPath);
  renameSync(tmpDbPath, preview.currentDbPath);
  // Stale sidecars from the pre-restore db are for a file that no longer
  // exists under this name; drop them once the rename lands so nothing tries
  // to replay them against the restored one.
  for (const suffix of ["-wal", "-shm"]) {
    rmSync(preview.currentDbPath + suffix, { force: true });
  }

  // Stage-and-rename here too (PR #36, S3), not rmSync-then-cpSync: that was
  // the exact remove-then-copy shape the comment two lines up rejects for
  // hive.db, just for profiles/ instead. A failure mid-cpSync used to leave
  // the user's overrides gone and a partial tree in their place. A directory
  // rename cannot atomically REPLACE a non-empty one the way it can an empty
  // one (renameSync throws ENOTEMPTY, same as the disambiguation retry in
  // takeSnapshot's B3 fix), so this is two renames rather than one: move the
  // live profiles/ aside, move the newly-staged one into place, then remove
  // the old one. Each step is atomic on its own; the narrow window between
  // the two renames is "profiles/ briefly absent, profiles.old/ present",
  // which is recoverable by hand and strictly better than a directory left
  // half-overwritten by an interrupted copy.
  const liveProfiles = join(dataDir, "profiles");
  const stagingProfiles = `${liveProfiles}.restoring`;
  const oldProfiles = `${liveProfiles}.old`;
  // Second counselors pass, C5. An unconditional rmSync of oldProfiles used
  // to destroy the one rollback copy a PRIOR crashed restore left behind.
  // If that crash landed between the two renames below - live moved aside,
  // staged one not yet installed - profiles.old/ is not garbage, it is the
  // only surviving copy of the user's overrides, and liveProfiles is
  // missing precisely because of that. Recover it back into place first,
  // establishing that a good profiles/ exists again, before this function
  // ever deletes anything named .old.
  //
  // Unconditional on preview.hasProfiles, deliberately, unlike the rest of
  // this block: a prior crash can leave this exact signature regardless of
  // whether the snapshot THIS call is restoring happens to carry its own
  // profile data. Gating recovery on hasProfiles would silently skip it
  // whenever someone restores an early or profile-less snapshot while a
  // crash recovery is still pending, leaving profiles/ missing even though
  // profiles.old/ had everything needed to bring it back.
  if (existsSync(oldProfiles) && !existsSync(liveProfiles)) {
    renameSync(oldProfiles, liveProfiles);
  }

  const restoredProfiles = preview.hasProfiles;
  if (restoredProfiles) {
    // If liveProfiles already exists here, no prior crash was in the state
    // above, and oldProfiles (if present at all) is ordinary leftover from a
    // completed run's cleanup that did not finish - safe to discard
    // unconditionally, which this rmSync still does.
    rmSync(stagingProfiles, { recursive: true, force: true });
    rmSync(oldProfiles, { recursive: true, force: true });
    cpSync(join(preview.snapshot.path, "profiles"), stagingProfiles, { recursive: true });
    if (existsSync(liveProfiles)) renameSync(liveProfiles, oldProfiles);
    renameSync(stagingProfiles, liveProfiles);
    rmSync(oldProfiles, { recursive: true, force: true });
  }
  return { restoredProfiles };
}
