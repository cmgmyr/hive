import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it } from "node:test";

import { assertScratchStore, raceProcesses, REPO, scratchDirs } from "./helpers.mjs";

const DB_JS_URL = pathToFileURL(join(REPO, "dist", "db.js")).href;
const BACKUP_JS_URL = pathToFileURL(join(REPO, "dist", "backup.js")).href;
// A race child runs from a scratch tmp directory with no node_modules above
// it, so the bare specifier "better-sqlite3" would not resolve there; this
// is the same package resolved by absolute path instead.
const BETTER_SQLITE3_URL = pathToFileURL(join(REPO, "node_modules", "better-sqlite3", "lib", "index.js")).href;

// Issue #23. This is the mechanism on its own: no tmux, no server, no CLI.
// db.js resolves its file from HIVE_DATA_DIR at import time; point it at a
// scratch dir before the dynamic import, same as migrations.test.mjs.
const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
// PR #36, B5. This is the most destructive file in the suite: it closes the
// live db connection, replaces hive.db out from under it, and rmSync's
// profiles/. Prove the store is scratch before any of that happens, not
// after, same as every other destructive test file (see state-log.test.mjs).
await assertScratchStore();
const { db, migrate, dataDir } = await import("../dist/db.js");
const {
  backupHealth,
  backupNow,
  backupsDir,
  listSnapshots,
  maybeBackupHourly,
  pruneSnapshots,
  readBackupMeta,
  restoreSnapshot,
  takeSnapshot,
} = await import("../dist/backup.js");

describe("VACUUM INTO vs a naive file copy", () => {
  it("captures rows still sitting in the WAL, which a naive copy misses (the issue's measured case)", () => {
    const dir = join(dirs.tmp, "wal-demo");
    mkdirSync(dir, { recursive: true });
    const src = join(dir, "hive.db");
    const wal = new Database(src);
    wal.pragma("journal_mode = WAL");
    wal.exec("CREATE TABLE t (a INTEGER)");
    for (let i = 0; i < 20; i++) wal.prepare("INSERT INTO t VALUES (?)").run(i);

    const result = takeSnapshot(wal, dir, "manual");
    assert.ok(result.ok, result.error);
    const viaVacuum = new Database(join(result.path, "hive.db"), { readonly: true });
    assert.equal(viaVacuum.prepare("SELECT COUNT(*) AS c FROM t").get().c, 20);

    // The failure this issue exists to prevent: a plain file copy of the
    // WAL-mode main file, read back with a fresh connection.
    const naivePath = join(dir, "naive-copy.db");
    copyFileSync(src, naivePath);
    const naive = new Database(naivePath, { readonly: true });
    assert.throws(() => naive.prepare("SELECT COUNT(*) AS c FROM t").get(), /no such table/);
  });
});

describe("pre-migration snapshots", () => {
  const migrationSnapshotCount = () => listSnapshots(dataDir).filter((s) => s.reason === "migration").length;

  it("takes one on a fresh store, since every migration is pending, and no second one once nothing is newly pending", () => {
    migrate();
    assert.equal(migrationSnapshotCount(), 1);
    migrate();
    assert.equal(migrationSnapshotCount(), 1);
  });

  it("takes another once a migration is pending again", () => {
    // Same rewind trick as migrations.test.mjs, pinned to a specific version
    // number rather than MAX(version): migrations are append-only, so a
    // version number is a stable handle across the next one landing.
    // Version 6 (agent_state_log) is the current last entry. backup_meta is
    // NOT touched here (PR #36, B2): it is bootstrapped unconditionally in
    // migrate(), not created by a MIGRATIONS entry, precisely so rewinding
    // the last real migration can never take it away.
    const AGENT_STATE_LOG_VERSION = 6;
    db.exec("DROP TABLE IF EXISTS agent_state_log");
    db.prepare("DELETE FROM migrations WHERE version = ?").run(AGENT_STATE_LOG_VERSION);
    migrate();
    assert.equal(migrationSnapshotCount(), 2);
    assert.ok(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'agent_state_log'").get(),
      "rewinding the migration must not leave agent_state_log missing after migrate() reapplies it",
    );
  });
});

describe("migrate() under real concurrent processes (PR #36, B1)", () => {
  it("does not throw when two fresh processes race the same pending migrations across a pre-migration backup", async () => {
    // A real, separate scratch store: this races two actual OS processes,
    // which sequential calls on one connection cannot substitute for (the
    // first call always finishes before the second's code even runs, so it
    // hides exactly the gap this bug lived in). Both start from a fresh
    // store, so both see every migration pending - the real trigger PR #36
    // reported: several hive processes starting together right after an
    // upgrade, each reading the same "nothing applied yet".
    const raceDirs = scratchDirs();
    const script = `
import { migrate } from ${JSON.stringify(DB_JS_URL)};
migrate();
process.stdout.write(JSON.stringify({ ok: true }));
`;
    const results = await raceProcesses(script, [["a"], ["b"]], { env: { HIVE_DATA_DIR: raceDirs.dataDir } });
    assert.ok(results[0].ok);
    assert.ok(results[1].ok);

    // Both processes must agree on one fully-migrated, uncorrupted store:
    // this is the regression check, since the pre-fix code let the second
    // process re-run already-applied SQL (e.g. CREATE TABLE backup_meta a
    // second time) and throw out of migrate() with nothing to catch it.
    const check = new Database(join(raceDirs.dataDir, "hive.db"));
    const migrationsApplied = check.prepare("SELECT COUNT(*) AS c FROM migrations").get().c;
    assert.ok(migrationsApplied > 0);
    const meta = check.prepare("SELECT * FROM backup_meta WHERE id = 1").get();
    assert.ok(meta, "backup_meta must exist and be queryable after the race");
    check.close();
  });
});

// A one-off two-script race, unlike raceProcesses: this needs one process
// HOLDING the write lock while a DIFFERENT script tries to migrate, not two
// copies of the same script. Written to a scratch file the same way
// raceProcesses does internally, so no shared helper needs to change shape
// for a single asymmetric case.
function runNodeScript(scriptSource, args, env, tmp) {
  const scriptPath = join(tmp, `script-${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(scriptPath, scriptSource);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      env: { ...process.env, HIVE_AUTO_ATTACH: "0", ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    child.on("exit", (code) => {
      if (code !== 0) return reject(new Error(`script exited ${code}: ${err || out}`));
      try {
        resolve(JSON.parse(out));
      } catch {
        reject(new Error(`script produced non-JSON stdout: ${out}`));
      }
    });
  });
}

describe("migrate() holding its own against a lock held longer than one busy_timeout (PR #36, C1)", () => {
  it("retries the migration transaction instead of throwing SQLITE_BUSY", async () => {
    // C1 on B1's own fix: BEGIN IMMEDIATE still only waited on the 5s
    // busy_timeout. A migration slow enough to run past it - plausible
    // applying several at once, exactly what an upgrade on a second machine
    // does - left .immediate() throwing SQLITE_BUSY straight out of
    // migrate(), the identical failure B1 removed, reached a different way.
    const raceDirs = scratchDirs();
    const dbPath = join(raceDirs.dataDir, "hive.db");

    // Bootstrap first so the store and its schema already exist; this test
    // is about contending for the write lock, not about applying migrations.
    await raceProcesses(
      `import { migrate } from ${JSON.stringify(DB_JS_URL)};\nmigrate();\nprocess.stdout.write(JSON.stringify({ ok: true }));\n`,
      [["bootstrap"]],
      { env: { HIVE_DATA_DIR: raceDirs.dataDir } },
    );

    // Holder grabs BEGIN IMMEDIATE first and keeps it for 6.5s - longer
    // than one 5s busy_timeout window. The migrator starts waiting on the
    // lock well before the holder releases it, so succeeding REQUIRES a
    // second attempt; a single .immediate() call throws once its own
    // busy_timeout expires, seconds before the holder lets go.
    const holderScript = `
import Database from ${JSON.stringify(BETTER_SQLITE3_URL)};
const [dbPath, holdMs] = process.argv.slice(2);
const db = new Database(dbPath);
db.pragma("busy_timeout = 5000");
db.exec("BEGIN IMMEDIATE");
const until = Date.now() + Number(holdMs);
while (Date.now() < until) {}
db.exec("COMMIT");
process.stdout.write(JSON.stringify({ ok: true }));
`;
    const migratorScript = `
import { migrate } from ${JSON.stringify(DB_JS_URL)};
const [waitMs] = process.argv.slice(2);
const until = Date.now() + Number(waitMs);
while (Date.now() < until) {}
migrate();
process.stdout.write(JSON.stringify({ ok: true }));
`;
    const results = await Promise.all([
      runNodeScript(holderScript, [dbPath, "6500"], {}, raceDirs.tmp),
      runNodeScript(migratorScript, ["500"], { HIVE_DATA_DIR: raceDirs.dataDir }, raceDirs.tmp),
    ]);
    assert.ok(results[0].ok, "the lock holder must complete normally");
    assert.ok(results[1].ok, "migrate() must succeed via retry, not throw SQLITE_BUSY");
  });
});

// PR #36, B3 (folds in an earlier fix for the same directory-name race).
// Sequential calls, even on separate connections, cannot reproduce this:
// takeSnapshot's own candidate-name search only advances past n=0 when a
// name is ALREADY taken, so two calls in a row on one process just find the
// second slot free and never collide. The actual bug needed two racers
// computing the SAME candidate at the SAME instant, which needs real,
// separately-scheduled processes - and, to make it deterministic rather
// than hoping for a millisecond coincidence, an identical forced `now`.
describe("takeSnapshot under real concurrent processes racing the identical name (PR #36, B3)", () => {
  it("never lets a losing claim destroy the winning one's completed snapshot", async () => {
    const raceDirs = scratchDirs();
    const now = new Date().toISOString();
    const race = `
import Database from ${JSON.stringify(BETTER_SQLITE3_URL)};
import { takeSnapshot } from ${JSON.stringify(BACKUP_JS_URL)};
const [dataDir, dbPath, marker, nowIso] = process.argv.slice(2);
const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.exec("CREATE TABLE t (a INTEGER)");
db.prepare("INSERT INTO t VALUES (?)").run(Number(marker));
const result = takeSnapshot(db, dataDir, "manual", new Date(nowIso));
process.stdout.write(JSON.stringify(result));
`;
    const results = await raceProcesses(race, [
      [raceDirs.dataDir, join(raceDirs.tmp, "racer-a.db"), "1", now],
      [raceDirs.dataDir, join(raceDirs.tmp, "racer-b.db"), "2", now],
    ]);
    assert.ok(results[0].ok, results[0].error);
    assert.ok(results[1].ok, results[1].error);
    assert.notEqual(results[0].path, results[1].path, "two colliding claims must land in different directories");

    // The regression: BOTH completed snapshots must still exist and be
    // readable, each with its own marker row. Against the pre-fix
    // check-then-mkdirSync(recursive) code, the loser's failure handler
    // would rmSync the winner's directory out from under it - this reads
    // both back with fresh connections, not just checking a path exists.
    const a = new Database(join(results[0].path, "hive.db"), { readonly: true });
    const b = new Database(join(results[1].path, "hive.db"), { readonly: true });
    const markers = [a.prepare("SELECT a FROM t").get().a, b.prepare("SELECT a FROM t").get().a].sort();
    assert.deepEqual(markers, [1, 2]);
    a.close();
    b.close();
  });
});

// PR #36, C3: last_success_at is a historical record, not proof anything is
// still on disk. Deleting backups/ right after a real success used to leave
// doctor reporting "All good" over an empty directory.
describe("backupHealth reports unhealthy when there is nothing to restore from (PR #36, C3)", () => {
  it("fails even when last_success_at is fresh, if backups/ is actually empty", () => {
    rmSync(backupsDir(dataDir), { recursive: true, force: true });
    db.prepare(
      "UPDATE backup_meta SET last_attempt_at = datetime('now'), last_success_at = datetime('now'), last_error = NULL, last_error_at = NULL WHERE id = 1",
    ).run();
    const health = backupHealth(db, dataDir);
    assert.equal(health.ok, false, "a fresh last_success_at with zero snapshots on disk must not read as healthy");
    assert.match(health.message, /nothing to restore from/);
  });
});

describe("hourly claim: one instance backs up, not every instance every tick", () => {
  it("claims and backs up when last_attempt_at is null or old", () => {
    db.prepare(
      "UPDATE backup_meta SET last_attempt_at = NULL, last_success_at = NULL, last_error = NULL, last_error_at = NULL WHERE id = 1",
    ).run();
    const before = listSnapshots(dataDir).filter((s) => s.reason === "hourly").length;

    maybeBackupHourly(db, dataDir);
    assert.equal(listSnapshots(dataDir).filter((s) => s.reason === "hourly").length, before + 1);
    const meta = readBackupMeta(db);
    assert.ok(meta.last_attempt_at);
    assert.ok(meta.last_success_at);
  });

  it("claims again once the rate limit window has passed", () => {
    db.prepare("UPDATE backup_meta SET last_attempt_at = datetime('now', '-2 hours') WHERE id = 1").run();
    const before = listSnapshots(dataDir).filter((s) => s.reason === "hourly").length;
    maybeBackupHourly(db, dataDir);
    assert.equal(listSnapshots(dataDir).filter((s) => s.reason === "hourly").length, before + 1);
  });

  // PR #36, B7: a future last_attempt_at (clock skew, or a restored snapshot
  // carrying one) must not wedge the claim shut for as long as the skew
  // lasts. The guard fails open toward taking a backup.
  it("claims when last_attempt_at is in the future (clock skew)", () => {
    db.prepare("UPDATE backup_meta SET last_attempt_at = datetime('now', '+2 hours') WHERE id = 1").run();
    const before = listSnapshots(dataDir).filter((s) => s.reason === "hourly").length;
    maybeBackupHourly(db, dataDir);
    assert.equal(listSnapshots(dataDir).filter((s) => s.reason === "hourly").length, before + 1);
  });

  it("records last_error and last_error_at, and does not stop hive, when a backup fails", () => {
    db.prepare("UPDATE backup_meta SET last_attempt_at = datetime('now', '-2 hours') WHERE id = 1").run();
    const realBackups = backupsDir(dataDir);
    // Force takeSnapshot to fail: make the backups directory a file, so
    // mkdirSync(parent, {recursive:true}) for the staging directory throws.
    rmSync(realBackups, { recursive: true, force: true });
    writeFileSync(realBackups, "not a directory");
    maybeBackupHourly(db, dataDir);
    const meta = readBackupMeta(db);
    assert.ok(meta.last_error, "last_error should be recorded when the snapshot itself fails");
    assert.ok(meta.last_error_at, "last_error_at should be recorded alongside it");
    assert.equal(backupHealth(db, dataDir).ok, false, "a failed most recent attempt must fail doctor's check");

    // Recovery (PR #36, B9): fix the fault and let a later attempt succeed.
    // last_error/last_error_at must NOT be cleared - the evidence that a
    // backup failed at some point must survive a later success, the same
    // "a state that corrects itself still has to be readable afterwards"
    // rule agent_state_log exists for (see CLAUDE.md, issue #24).
    //
    // last_error_at is backdated here: datetime('now') is second-granularity
    // and this whole test runs in under a millisecond, so the upcoming
    // success could otherwise land in the SAME second as the failure above,
    // and backupHealth's tie-break (see its comment) treats that as still
    // failed - correctly, but it would make this specific assertion flaky
    // rather than pinning the genuinely-recovered case it exists to check.
    rmSync(realBackups, { force: true });
    db.prepare(
      "UPDATE backup_meta SET last_attempt_at = datetime('now', '-2 hours'), last_error_at = datetime('now', '-10 seconds') WHERE id = 1",
    ).run();
    maybeBackupHourly(db, dataDir);
    const recovered = readBackupMeta(db);
    assert.ok(recovered.last_error, "the earlier failure must still be on the row");
    assert.ok(
      recovered.last_success_at > recovered.last_error_at,
      "a success after the recorded failure must be visible as more recent",
    );
    assert.equal(backupHealth(db, dataDir).ok, true, "a success more recent than the last failure must pass doctor's check");
  });
});

// PR #36, B4: the previous version of this test called maybeBackupHourly
// twice sequentially on ONE connection. Sequential calls on one connection
// cannot reproduce a check-then-act race - the first call always finishes
// (including its own UPDATE) before the second's code runs at all - so a
// hypothetical SELECT-then-UPDATE implementation would have passed that
// test exactly as well as the atomic UPDATE actually shipped. Real,
// separately-scheduled processes are what a "does not double-fire" claim
// has to survive; this also holds regardless of how the two processes
// happen to interleave, since the second one - whenever it runs - re-reads
// last_attempt_at fresh and finds it claimed either way.
describe("hourly claim under real concurrent processes (PR #36, B4)", () => {
  it("lets exactly one of two racing processes take the hourly backup", async () => {
    const raceDirs = scratchDirs();
    const setup = `
import { db, migrate } from ${JSON.stringify(DB_JS_URL)};
migrate();
db.prepare(
  "UPDATE backup_meta SET last_attempt_at = NULL, last_success_at = NULL, last_error = NULL, last_error_at = NULL WHERE id = 1",
).run();
process.stdout.write(JSON.stringify({ ok: true }));
`;
    await raceProcesses(setup, [["setup"]], { env: { HIVE_DATA_DIR: raceDirs.dataDir } });

    const race = `
import { db, dataDir } from ${JSON.stringify(DB_JS_URL)};
import { maybeBackupHourly } from ${JSON.stringify(BACKUP_JS_URL)};
maybeBackupHourly(db, dataDir);
process.stdout.write(JSON.stringify({ ok: true }));
`;
    const results = await raceProcesses(race, [["a"], ["b"]], { env: { HIVE_DATA_DIR: raceDirs.dataDir } });
    assert.ok(results[0].ok && results[1].ok);

    const hourlySnapshots = listSnapshots(raceDirs.dataDir).filter((s) => s.reason === "hourly");
    assert.equal(hourlySnapshots.length, 1, "exactly one of the two racing processes should have backed up");
  });
});

describe("retention", () => {
  function fakeSnapshot(date, reason) {
    const name = `${date.toISOString().replace(/[:.]/g, "-")}-${reason}`;
    const dir = join(backupsDir(dataDir), name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "hive.db"), "fake content for size accounting");
    return name;
  }

  it("keeps the last N plus one per day within the window, and deletes the rest", () => {
    rmSync(backupsDir(dataDir), { recursive: true, force: true });
    // Fixed, not read from the clock (PR #36, B6): the previous version used
    // `new Date()` for both the fake snapshots AND (separately, inside
    // pruneSnapshots, at call time) the retention cutoff. Those are two
    // different instants that happen to agree on which calendar date "12
    // hours ago" falls on for most of the day and disagree right at
    // 12:00Z, so the test passed or failed depending on what time it
    // happened to run - and adjusting the fake offsets would only move the
    // flip to a different hour, not remove it. A fixed instant, threaded
    // into pruneSnapshots as its `now`, makes both sides agree always.
    const now = new Date("2026-03-15T00:30:00.000Z");
    const daysAgo = (n) => new Date(now.getTime() - n * 24 * 60 * 60 * 1000);

    // Ten recent snapshots, same day, all within "last N".
    const recent = Array.from({ length: 10 }, (_, i) => fakeSnapshot(new Date(now.getTime() - i * 60_000), "hourly"));
    // One older snapshot per day for 10 days back, outside "last N" but some
    // inside the daily-retention window.
    const daily = Array.from({ length: 10 }, (_, i) => fakeSnapshot(daysAgo(i + 0.5), "hourly"));

    const removed = pruneSnapshots(dataDir, { keepLast: 10, keepDailyDays: 7 }, now);
    const remainingNames = new Set(listSnapshots(dataDir).map((s) => s.name));

    for (const name of recent) assert.ok(remainingNames.has(name), `${name} is within keepLast and must survive`);
    for (let i = 0; i < 7; i++) assert.ok(remainingNames.has(daily[i]), `${daily[i]} is within the daily window and must survive`);
    for (let i = 7; i < 10; i++) assert.ok(!remainingNames.has(daily[i]), `${daily[i]} is outside both policies and must be pruned`);
    assert.equal(removed.length, 3);
  });

  // PR #36, B8: a misconfigured policy must never be able to delete every
  // snapshot, including the one backupNow just created.
  it("never prunes below one snapshot, even with keepLast and keepDailyDays both zero", () => {
    rmSync(backupsDir(dataDir), { recursive: true, force: true });
    const now = new Date("2026-03-15T00:30:00.000Z");
    fakeSnapshot(new Date(now.getTime() - 5 * 60_000), "hourly");
    fakeSnapshot(new Date(now.getTime() - 3 * 60_000), "hourly");
    const newest = fakeSnapshot(now, "hourly");

    pruneSnapshots(dataDir, { keepLast: 0, keepDailyDays: 0 }, now);
    const remaining = listSnapshots(dataDir);
    assert.equal(remaining.length, 1, "at least one snapshot must always survive");
    assert.equal(remaining[0].name, newest, "the one kept must be the newest, not an arbitrary survivor");
  });

  // PR #36, C2: cmdRestore's pre-restore backup names its restore TARGET as
  // `protect`, precisely so retention can never be the thing that deletes
  // the snapshot the operator just confirmed. This pins the mechanism
  // directly: an old snapshot, protected, must survive a policy that would
  // otherwise evict it on both counts (outside keepLast, outside the daily
  // window).
  it("never prunes an explicitly protected snapshot, even when the policy alone would evict it", () => {
    rmSync(backupsDir(dataDir), { recursive: true, force: true });
    const now = new Date("2026-03-15T00:30:00.000Z");
    const target = fakeSnapshot(new Date(now.getTime() - 20 * 24 * 60 * 60 * 1000), "hourly");
    for (let i = 0; i < 9; i++) fakeSnapshot(new Date(now.getTime() - i * 60_000), "hourly");

    pruneSnapshots(dataDir, { keepLast: 1, keepDailyDays: 0 }, now, new Set([target]));
    const remainingNames = new Set(listSnapshots(dataDir).map((s) => s.name));
    assert.ok(remainingNames.has(target), "a protected snapshot must survive even outside every retention window");
  });

  // PR #36, C4: a SIGKILL during a large VACUUM INTO leaves a .staging-*
  // directory that listSnapshotRefs and retention both ignore forever
  // (parseSnapshotDirName rejects the name on purpose), so it could fill
  // the disk and make every later backup fail. Retention now sweeps them,
  // bounded by age so a genuinely still-running backup's own staging
  // directory is never mistaken for abandoned.
  it("sweeps an orphaned staging directory older than an hour, but leaves a recent one alone", () => {
    rmSync(backupsDir(dataDir), { recursive: true, force: true });
    const dir = backupsDir(dataDir);
    const stale = join(dir, ".staging-stale");
    const recent = join(dir, ".staging-recent");
    mkdirSync(stale, { recursive: true });
    mkdirSync(recent, { recursive: true });
    writeFileSync(join(stale, "hive.db"), "orphaned by a crash");
    writeFileSync(join(recent, "hive.db"), "a backup that may still be running");
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(stale, twoHoursAgo, twoHoursAgo);

    pruneSnapshots(dataDir);
    assert.ok(!existsSync(stale), "an orphaned staging directory older than an hour must be swept");
    assert.ok(existsSync(recent), "a recent staging directory must be left alone: it may still be in use");
  });
});

describe("restore: write rows, destroy them, restore, read them back", () => {
  it("recovers a project's pads and todos after they are deleted from the live store", () => {
    // Self-contained: start from an empty backups/ rather than depending on
    // what earlier describes left behind (retention's synthetic snapshots).
    rmSync(backupsDir(dataDir), { recursive: true, force: true });
    db.prepare("INSERT INTO projects (name, path) VALUES ('restore-test', '/tmp/restore-test-project')").run();
    const projectId = db.prepare("SELECT id FROM projects WHERE path = '/tmp/restore-test-project'").get().id;
    db.prepare("INSERT INTO scratchpads (project_id, name, content) VALUES (?, 'plan', 'do not lose this')").run(
      projectId,
    );
    db.prepare("INSERT INTO todos (project_id, title) VALUES (?, 'recoverable todo')").run(projectId);

    const backup = backupNow(db, dataDir, "manual");
    assert.ok(backup.ok, backup.error);
    const snapshotName = listSnapshots(dataDir)[0].name;

    // Destroy: the exact disaster class this issue exists to survive (#22's
    // wrong-store DELETE, or any other data loss).
    db.prepare("DELETE FROM scratchpads WHERE project_id = ?").run(projectId);
    db.prepare("DELETE FROM todos WHERE project_id = ?").run(projectId);
    db.prepare("DELETE FROM projects WHERE id = ?").run(projectId);
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM projects WHERE id = ?").get(projectId).c, 0);

    // The live connection has to close before its file gets replaced.
    db.close();
    const { restoredProfiles } = restoreSnapshot(dataDir, snapshotName);
    assert.equal(restoredProfiles, false);

    // Read back with a fresh connection: this is the "reads the rows back"
    // half, not a check that a file merely appeared.
    const restored = new Database(join(dataDir, "hive.db"));
    const project = restored.prepare("SELECT * FROM projects WHERE path = '/tmp/restore-test-project'").get();
    assert.ok(project, "the deleted project must be back after restore");
    const pad = restored.prepare("SELECT * FROM scratchpads WHERE project_id = ?").get(project.id);
    assert.equal(pad.content, "do not lose this");
    const todo = restored.prepare("SELECT * FROM todos WHERE project_id = ?").get(project.id);
    assert.equal(todo.title, "recoverable todo");
    restored.close();
  });

  // PR #36, S3: profiles/ used to be restored with rmSync-then-cpSync, the
  // exact remove-then-copy shape the comment above restoreSnapshot rejects
  // for hive.db, just for profiles/ instead. A failure mid-copy used to
  // leave the user's overrides gone and a partial tree in their place.
  it("stages and swaps profiles/ atomically, replacing old content rather than merging with it", () => {
    rmSync(backupsDir(dataDir), { recursive: true, force: true });
    const profilesDir = join(dataDir, "profiles");
    rmSync(profilesDir, { recursive: true, force: true });
    mkdirSync(join(profilesDir, "orchestration"), { recursive: true });
    writeFileSync(join(profilesDir, "orchestration", "posture.md"), "original posture");

    // A connection of this test's own, independent of the shared `db` used
    // elsewhere in this file: this test closes its connection to restore
    // (restoreSnapshot's own requirement), and the shared `db` must stay
    // open for whatever else in this file still needs it.
    const localDb = new Database(join(dataDir, "hive.db"));
    const backup = backupNow(localDb, dataDir, "manual");
    assert.ok(backup.ok, backup.error);
    const snapshotName = listSnapshots(dataDir)[0].name;

    // Change the live profile after the snapshot, and add a file that must
    // NOT survive restore - proving this is a full swap, not a merge.
    writeFileSync(join(profilesDir, "orchestration", "posture.md"), "changed after the backup");
    writeFileSync(join(profilesDir, "orchestration", "extra.md"), "must not survive restore");

    localDb.close();
    const { restoredProfiles } = restoreSnapshot(dataDir, snapshotName);
    assert.equal(restoredProfiles, true);

    assert.equal(
      readFileSync(join(profilesDir, "orchestration", "posture.md"), "utf8"),
      "original posture",
      "restore must bring back the snapshot's content, not the live edit made after it",
    );
    assert.ok(
      !existsSync(join(profilesDir, "orchestration", "extra.md")),
      "a file added after the backup must not survive a full restore",
    );
    // No staging or set-aside-old directories left behind on success.
    assert.ok(!existsSync(`${profilesDir}.restoring`));
    assert.ok(!existsSync(`${profilesDir}.old`));
  });

  // PR #36, C5: a prior crash between the two renames leaves profiles.old/
  // as the only surviving copy and live profiles/ missing. Restoring a
  // snapshot that has NO profile data of its own must still recover that
  // copy - not silently skip recovery just because this particular restore
  // was not going to touch profiles/ anyway.
  it("recovers a crashed prior restore's profiles.old/ even when this restore's own snapshot has no profiles", () => {
    rmSync(backupsDir(dataDir), { recursive: true, force: true });
    const profilesDir = join(dataDir, "profiles");
    rmSync(profilesDir, { recursive: true, force: true });
    rmSync(`${profilesDir}.old`, { recursive: true, force: true });
    rmSync(`${profilesDir}.restoring`, { recursive: true, force: true });

    // A snapshot with no profiles/ of its own (the live store has none at
    // backup time).
    const localDb = new Database(join(dataDir, "hive.db"));
    const backup = backupNow(localDb, dataDir, "manual");
    assert.ok(backup.ok, backup.error);
    const snapshotName = listSnapshots(dataDir)[0].name;

    // Simulate the crash: profiles.old/ holds the only surviving copy,
    // live profiles/ is missing, exactly the state a crash between the two
    // renames in restoreSnapshot leaves behind.
    mkdirSync(join(`${profilesDir}.old`, "orchestration"), { recursive: true });
    writeFileSync(join(`${profilesDir}.old`, "orchestration", "posture.md"), "rollback copy from before the crash");

    localDb.close();
    const { restoredProfiles } = restoreSnapshot(dataDir, snapshotName);
    assert.equal(restoredProfiles, false, "this snapshot carries no profile data of its own");
    assert.equal(
      readFileSync(join(profilesDir, "orchestration", "posture.md"), "utf8"),
      "rollback copy from before the crash",
      "the crashed prior restore's rollback copy must be recovered into profiles/, not deleted",
    );
    assert.ok(!existsSync(`${profilesDir}.old`), "the recovered copy must have been moved, not left behind");
  });
});
