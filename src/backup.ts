import type Database from "better-sqlite3";
import SqliteDb from "better-sqlite3";
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

// Issue #39/#41 half C: every read OR write of "the current moment" against
// backup_meta uses this, not plain datetime('now'). datetime('now')
// truncates to whole seconds, so a failure and a success inside the same
// second used to write identical strings and become unorderable - the
// original #39 report. Upgrading only the WRITES to millisecond resolution
// while leaving comparisons on second-resolution datetime('now') would trade
// that bug for a subtler one: a freshly-written millisecond-resolution
// last_attempt_at compared against a same-tick datetime('now') lexically
// reads as "greater than now" whenever the two share an integer second,
// which is the ordinary case for a claim checked moments after it was made,
// not a rare one - verified against a real SQLite connection before writing
// this. Both sides need the same resolution, so every occurrence of "now"
// touching this table, read or write, goes through this one format string.
// Multiple uses of it inside a single statement evaluate to the identical
// value (also verified), so mixing it into both the SET and the WHERE of one
// UPDATE is safe. Sites that need "now" offset by a modifier (a lookback
// window, a staleness threshold) build their own strftime(...) call from
// this constant rather than duplicating the format literal a second time.
const SQL_DATETIME_FMT = "%Y-%m-%d %H:%M:%f";
const SQL_NOW = `strftime('${SQL_DATETIME_FMT}', 'now')`;

// KNOWN RESIDUAL, deliberately deferred (PR #42). During a rolling upgrade, an
// already-running OLD server keeps executing second-resolution code (plain
// datetime('now')) until it is restarted, while a NEW server in the same store
// writes millisecond-resolution values through SQL_NOW above. A
// second-resolution string sorts as the EARLIEST point in its second (a shorter
// same-prefix string compares smaller), so an OLD writer's failure at, say,
// .900 stores "...:00" and can lose an ordering comparison to a NEW writer's
// earlier success at .100 - the deliberate >= tie-break in backupHealth no
// longer helps once the two strings are no longer equal (the ORDERING case).
// The same mismatch can make an OLD server's future-skew check
// (claimStatement's third disjunct) misjudge a NEW server's millisecond value
// as being in the future, double-firing the hourly claim (the FUTURE-SKEW
// case). Both are OLD code reading NEW data: nothing this branch writes can fix
// a process still running old code, since the only value an old reader orders
// correctly is a second-resolution one - the very thing #39 exists to move away
// from. Both are bounded (the future-skew case costs one extra backup per
// hourly claim for the length of the upgrade window and settles on its own once
// every server restarts; the ordering case needs two writers in the same
// second, one of them stale) and every hive session already restarts to pick up
// a new dist. The SAFE direction - a second-resolution value read by the NEW
// code - is pinned by a test (a recent second-resolution last_attempt_at must
// not be misjudged as future); the unsafe direction needs an old process
// actually running old code, which this branch cannot reproduce.

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
// complete (PR #36, folding in an earlier same-issue fix): a directory under
// backups/ with a real timestamp name is never anything but a finished
// snapshot, by construction, for two reasons at once.
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
// (the same fix that gave pruneSnapshots its own `now` parameter, PR #36) so a
// test can force two real racing processes onto the IDENTICAL candidate name
// deterministically, rather than hoping two independently-started processes
// happen to land in the same millisecond (they often do - see the comment above
// pruneSnapshots' cousin logic - but "often" is not "always", and this needs
// "always" to be a real regression test rather than an occasionally-quiet one).
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
    // Creating the parent has to be inside this try too, not just the
    // staging directory: a corrupted "backups" path (a plain file where a
    // directory belongs, e.g. from a prior disk-full mid-write) must still
    // come back as a BackupResult, not a throw past this function's
    // contract - a caller like backupNow relies on that to record
    // last_error at all.
    mkdirSync(parent, { recursive: true });
    mkdirSync(staging, { recursive: true });
    db.prepare("VACUUM INTO ?").run(join(staging, "hive.db"));
    // Captured HERE, after the vacuum returns (a subtle timing bug found in PR
    // #42's review, missed by everyone including the lead), never from `now`
    // above (the function's START time, still reserved below for the directory
    // NAME, which the deterministic race fixture above needs). Every session
    // runs its own server against the SAME store, so two writers is the normal
    // case, not a contrived one: a DIFFERENT server can write a failure onto
    // the LIVE row while this vacuum is still running, and VACUUM INTO reads
    // whatever is committed at the moment it executes - if that failure landed
    // before the vacuum's read, it is already inside the staged copy's own
    // last_error_at. Stamping last_success_at with `now` (the start time,
    // captured BEFORE the vacuum) could then be OLDER than an error the copy
    // itself already contains, so restoring a perfectly good snapshot would
    // report another server's already-resolved failure as current. completedAt
    // is captured strictly after the vacuum's read, on this same process's
    // clock, so it is guaranteed to be >= anything the vacuum could have seen:
    // same machine, same clock, and completion necessarily happens after
    // whatever the vacuum read.
    completedAt = new Date();
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

  // Issue #41: write this snapshot's OWN backup_meta row into the staged copy,
  // before it becomes a real snapshot by renaming. The live store's backup_meta
  // records history as of the moment BEFORE this backup, since backupNow's
  // success UPDATE runs after takeSnapshot returns - so a restored snapshot
  // that only ever carried the live row's copy would always understate its own
  // backup history by exactly one backup. Writing last_success_at here instead
  // is safe for a structural reason, not a timing coincidence: takeSnapshot
  // only renames a COMPLETE copy into backups/ (see the staging-then-rename
  // comment above), so a snapshot asserting "a backup succeeded at my own
  // timestamp" is proven by its own existence, not by anyone's bookkeeping.
  // Doing the equivalent write against the LIVE store before the vacuum would
  // be wrong: if the vacuum then failed, the live store would claim a success
  // that never happened.
  //
  // last_error/last_error_at are deliberately left untouched, not cleared:
  // a restore of a snapshot taken while a real failure was still the most
  // recent event must keep that failure readable, same as backupNow never
  // clearing them on the live row. A later success timestamp in front of it
  // is what turns backupHealth's verdict, not deleting the evidence - the
  // "a state that corrects itself still has to be readable" rule CLAUDE.md
  // already states for agent_state_log.
  //
  // No guardAbi()/pragma sequence here, unlike db.ts's connection to the
  // live store: those exist for the one long-lived shared connection every
  // caller in the process depends on. This one is private, single-writer,
  // and already-VACUUMed - open, one UPDATE, close - so there is nothing
  // for a busy_timeout or an explicit journal_mode to protect against.
  //
  // The value is bound as an ISO string and formatted BY SQLite itself
  // (strftime, the same SQL_DATETIME_FMT every other write in this module
  // uses), not by a JS-side reimplementation of that format - there used to be
  // a separate sqliteDatetime() JS helper here, kept in sync with
  // SQL_DATETIME_FMT only by a comment, and nothing would have caught the two
  // drifting apart (a snapshot-written timestamp silently stopping being
  // orderable against a SQL-written one is exactly what half C exists to
  // prevent). Deleted; this is the only format literal in the module now, used
  // everywhere, never duplicated.
  //
  // Three checks (PR #42) share this one open connection, in the order
  // an operator would ask them: can the copy even be opened as a database;
  // does the write itself prove it is corrupt; and does a rollback journal
  // survive the write. Best-effort still governs everything EXCEPT proof the
  // copy is broken: a snapshot with a stale or missing meta row beats no
  // snapshot, but a snapshot that cannot even be read is not a snapshot.
  let metaDb: InstanceType<typeof SqliteDb>;
  try {
    metaDb = new SqliteDb(join(staging, "hive.db"));
  } catch (e) {
    // A failure to even OPEN the staged copy as a database is itself
    // proof the copy is unusable. Fail the snapshot rather than publish it.
    try {
      rmSync(staging, { recursive: true, force: true });
    } catch {
      // Best effort; see the comment on the earlier cleanup above.
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
    // Half A is the FIRST thing this module has ever opened a vacuum's
    // output as a database, so NOTADB/CORRUPT here is the first integrity
    // signal that has ever existed for it. A truncated or short-written
    // VACUUM INTO can open fine (sqlite3_open reads no page, confirmed
    // against a real garbage file before writing this) and only throw once
    // something actually reads one - exactly this UPDATE. Fail the snapshot
    // in exactly this case, and ONLY this case: everything else here stays
    // best-effort (a 0-changes UPDATE, a missing backup_meta table, EMFILE,
    // a permissions problem say nothing about whether the COPY itself is
    // restorable), deliberately narrow, because widening this to "any error
    // fails the backup" would let an unrelated open failure destroy an
    // otherwise-good snapshot, which is a worse bug than the one this fixes.
    const code = (e as { code?: string }).code;
    if (code === "SQLITE_NOTADB" || code === "SQLITE_CORRUPT") corruptError = e;
  } finally {
    try {
      metaDb.close();
    } catch {
      // Best-effort; a close failure that leaves a rollback journal behind
      // is caught by the journal check below, which is what actually protects a
      // caller of this snapshot - not this close() call succeeding.
    }
  }
  if (corruptError !== undefined) {
    try {
      rmSync(staging, { recursive: true, force: true });
    } catch {
      // Best effort; see the comment on the earlier cleanup above.
    }
    return { ok: false, error: errorMessage(corruptError) };
  }

  // Half A is the first write ever made to a staged snapshot, so
  // hive.db-journal exists for the duration of the UPDATE above. If the
  // UPDATE or metaDb.close() failed in a way this function swallowed, the
  // journal can still be on disk when the rename below publishes the
  // directory - and restoreSnapshot copies hive.db ALONE, so a database that
  // needs its journal to roll back would be installed without it. Checked
  // here, not deleted: deleting a journal a database still needs is how you
  // corrupt it, not how you protect against it.
  if (existsSync(join(staging, "hive.db-journal"))) {
    try {
      rmSync(staging, { recursive: true, force: true });
    } catch {
      // Best effort; see the comment on the earlier cleanup above.
    }
    return { ok: false, error: "a rollback journal survived the snapshot's own backup_meta write" };
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
// parameter (PR #36) so a test can pin retention's day-boundary logic to a
// fixed instant instead of reading the clock. A test that computed its own fake
// snapshots relative to a local `now` while this function computed its cutoff
// from a SEPARATE `new Date()` at call time was really two clocks that happened
// to agree in one part of the day and disagree in another: whether "12 hours
// ago" falls on the same UTC calendar date as "now" flips exactly at 12:00Z, so
// the same test failed or passed depending on when it happened to run, and
// adjusting the fake offsets would only have moved the flip to a different hour
// rather than removing it. A staging directory (see takeSnapshot's
// staging-then-rename fix) that is still older than this when retention runs is
// orphaned: a SIGKILL or power loss mid-VACUUM leaves one behind forever, since
// nothing else ever looks at it - parseSnapshotDirName rejects the name on
// purpose, so it is invisible to listing, restore, and this very function's own
// keep/prune logic. Left alone, orphans accumulate and can fill the disk,
// silently, in the direction of making every LATER backup fail too (PR #36).
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
  // Floored at 1 (PR #36): HIVE_BACKUP_KEEP_LAST=0 combined with
  // KEEP_DAILY_DAYS=0 would otherwise delete every snapshot, including the one
  // backupNow just created two statements ago, on every single backup, forever,
  // with doctor still reporting success. A retention policy can empty itself
  // down to nothing, never down to a store with no backups at all.
  const keepLast = Math.max(1, policy.keepLast);
  const keep = new Set<string>(snapshots.slice(0, keepLast).map((s) => s.name));
  // cmdRestore's pre-restore backup calls backupNow with the RESTORE TARGET
  // named here, so retention can never delete the one snapshot the operator
  // just confirmed. Without this, ten same-day snapshots plus the default
  // keepLast=10 meant taking an eleventh (the pre-restore backup itself) pruned
  // the oldest - which, if that was the operator's chosen target,
  // restoreSnapshot would then report as not existing. The headline feature
  // deleting the thing it was just asked to restore is not a corner case worth
  // leaving open.
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
// (PR #36): a failure in any one must not skip the others, which a
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
// `protect` (PR #36) is passed straight through to pruneSnapshots: a
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
      db.prepare(`UPDATE backup_meta SET last_success_at = ${SQL_NOW} WHERE id = 1`).run();
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
      db.prepare(`UPDATE backup_meta SET last_error = ?, last_error_at = ${SQL_NOW} WHERE id = 1`).run(
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
    // The third disjunct is from PR #36: a future last_attempt_at (clock
    // skew on wake from sleep, or a restored snapshot carrying one) would
    // otherwise wedge every hourly backup for as long as the skew lasts,
    // silently, since nothing else ever moves this value backward. Claiming
    // whenever the stored value is not a sane recent past is what a clock
    // jumping in either direction should do: fail open toward taking a
    // backup, not toward silently taking none.
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
// but only because takeSnapshot's staging-then-rename claim gives each
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
// (PR #36).
//
// Group 1 redesign (PR #42 review): the previous shape judged freshness and
// "has one ever succeeded" from last_success_at on the row, with one
// special-cased branch (half B) that consulted the DISK instead, but only for
// the optimistic case. That is the same bug this whole issue is about, worn as
// this PR's own clothes: a 59-day-old snapshot with success NULL read as ok
// ("restorable"), while the SAME snapshot with success recorded read as FAIL
// ("more than 7 day(s) old") - the LESS-informed state reported healthier, and
// the false ok applied exactly when no session had ever run a backup, i.e.
// forever, which is worse than the false FAIL it replaced (self-limiting: the
// next hourly claim fixed it within the hour).
//
// The fix judges health on the evidence that is actually strongest - the
// snapshots on disk - and uses the row for what only the row knows. A
// snapshot's own existence proves a backup completed at its own timestamp; it
// needs no corroboration from backup_meta, the same argument half A already
// relies on for a snapshot's OWN row. So freshness comes from the newest
// RESTORABLE snapshot's own directory timestamp, not last_success_at, and needs
// no special case for a null or stale row: an ancient snapshot fails whether or
// not a success was ever recorded, and a fresh one is healthy for the same
// reason. What only the row knows is last_error/last_error_at: a FAILED attempt
// leaves no snapshot, so the disk is silent about it. A snapshot NEWER than the
// recorded error is proof a backup completed after that failure - resolving it,
// the same "existence proves completion" argument - while a snapshot at or
// before the error is not proof of anything, and that store must still FAIL:
// this is the same principle the `!newest` check below applies - a real current
// failure can never read as ok, it does not relax it.
export function backupHealth(db: Database.Database, dataDir: string): BackupHealth {
  // A non-finding from PR #42's review: `meta` undefined (readBackupMeta finds
  // no row - unreachable through migrate(), which bootstraps it
  // unconditionally) used to reach the old null-success branch and read as ok.
  // The Group 1 redesign makes this moot rather than needing its own guard:
  // `meta?.last_error_at != null` is false when meta is undefined, so an absent
  // row simply contributes no error evidence and health falls through to
  // judging freshness from `newest` alone - no special branch added for a state
  // that cannot occur.
  const meta = readBackupMeta(db);
  const snapshots = listSnapshots(dataDir);
  const summary = `${snapshots.length} snapshot(s), ${formatBytes(totalSizeBytes(snapshots))} total`;

  // A directory's NAME matching NAME_PATTERN is not proof it is restorable -
  // listSnapshotRefs never opens it. An interrupted pruneSnapshots rmSync, or a
  // partial hand `cp` install, can leave a timestamp-named directory with no
  // hive.db inside; naming it as restorable here converts a broken store into
  // an explicit positive claim, and `hive restore` would then die with ENOENT
  // trying to act on it. Checked HERE, not inside
  // listSnapshotRefs/listSnapshots: retention still has to see a junk directory
  // as a snapshot name to sweep it, or it never gets cleaned up.
  const newest = snapshots.find((s) => existsSync(join(s.path, "hive.db")));

  // Generalized (PR #36): `newest` is undefined both when snapshots.length ===
  // 0 and when every listed directory is junk. Either way there is nothing on
  // disk an operator can restore from, which is the same point stated one level
  // more general than "zero snapshots".
  if (!newest) {
    return { ok: false, message: `${summary}, nothing to restore from` };
  }

  // Formatted BY SQLite itself, not by a JS-side reimplementation of
  // SQL_DATETIME_FMT - see the comment on the staged write in takeSnapshot for
  // why that used to be two independent copies of the format literal, kept in
  // sync only by a comment nothing enforced.
  const dirAt = (
    db.prepare(`SELECT strftime('${SQL_DATETIME_FMT}', ?) AS ts`).get(newest.createdAt.toISOString()) as {
      ts: string;
    }
  ).ts;

  // Found while implementing this redesign, not in the pad: the directory name
  // is the snapshot's START time (`now` in takeSnapshot, captured BEFORE the
  // VACUUM INTO, deliberately - the deterministic race fixture needs it fixed
  // for the race test), not its completion. Reproduced: seed a live-row failure
  // timed to land DURING a simulated long vacuum (after the directory-name
  // `now` but before the snapshot's own row is written), take the snapshot, and
  // it reports FAIL "last attempt failed" even though the snapshot's OWN row
  // (last_success_at, completedAt's own completion time - captured strictly
  // after the vacuum returns, guaranteed >= anything the vacuum's read could
  // have seen) proves that exact failure was resolved. A large VACUUM INTO can
  // run long enough for a DIFFERENT server to record a failure in the window
  // between the two, and the directory name alone cannot see past it.
  //
  // Fix: take the LATER of the directory name and the snapshot's own
  // last_success_at, never the row alone. MAX, not "prefer the row", because
  // the row is not always trustworthy - that is the Group 1 redesign's whole
  // point, and it is still true here: a pre-half-A or hand-copied snapshot's
  // row can show an OLDER backup's success (one-behind, the original #41 bug)
  // or be NULL. A row like that is SMALLER than the directory name, so MAX
  // correctly ignores it and falls back to the directory name - the same case
  // the restorability check above and the null-success case already rely on
  // this function not trusting the row at all. A post-half-A row is never
  // smaller than the directory name (the completedAt timing above guarantees
  // completedAt >= the function's start time), so MAX correctly picks it up
  // whenever it is genuinely more precise, which is exactly the
  // concurrent-writer case above.
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
    // Best-effort; dirAt is still correct for a snapshot whose own row
    // cannot be read.
  }

  // >=, not >: issue #39 - every backup_meta write is millisecond-resolution
  // now (SQL_NOW above), but a tie is still possible on a store fast enough
  // to record both events in the same millisecond, or a system clock whose
  // real resolution is coarser than the milliseconds it reports. A tie still
  // cannot prove the failure resolved, so it reads as still-failed - the
  // conservative side, matching this function's whole reason to exist (do
  // not let a success hide a failure).
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

  // Stage-and-rename here too (PR #36), not rmSync-then-cpSync: that was the
  // exact remove-then-copy shape the comment two lines up rejects for hive.db,
  // just for profiles/ instead. A failure mid-cpSync used to leave the user's
  // overrides gone and a partial tree in their place. A directory rename cannot
  // atomically REPLACE a non-empty one the way it can an empty one (renameSync
  // throws ENOTEMPTY, same as the disambiguation retry in takeSnapshot's
  // staging-then-rename fix), so this is two renames rather than one: move the
  // live profiles/ aside, move the newly-staged one into place, then remove the
  // old one. Each step is atomic on its own; the narrow window between the two
  // renames is "profiles/ briefly absent, profiles.old/ present", which is
  // recoverable by hand and strictly better than a directory left
  // half-overwritten by an interrupted copy.
  const liveProfiles = join(dataDir, "profiles");
  const stagingProfiles = `${liveProfiles}.restoring`;
  const oldProfiles = `${liveProfiles}.old`;
  // An unconditional rmSync of oldProfiles used to destroy the one rollback
  // copy a PRIOR crashed restore left behind. If that crash landed between the
  // two renames below - live moved aside, staged one not yet installed -
  // profiles.old/ is not garbage, it is the only surviving copy of the user's
  // overrides, and liveProfiles is missing precisely because of that. Recover
  // it back into place first, establishing that a good profiles/ exists again,
  // before this function ever deletes anything named .old.
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
