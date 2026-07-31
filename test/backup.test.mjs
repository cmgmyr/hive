import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
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

// Issue #41 half A: a snapshot's backup_meta used to record the store's
// history as of the moment BEFORE that snapshot's own completion, so a
// restored store always understated its backup history by exactly one
// backup. takeSnapshot now writes this snapshot's own success into the
// STAGED copy, before the rename - provable from the snapshot alone.
describe("issue #41 half A: a snapshot's own backup_meta records its own success", () => {
  it("writes last_attempt_at and last_success_at into the snapshot itself, not just the live row", () => {
    rmSync(backupsDir(dataDir), { recursive: true, force: true });
    // The live row is left deliberately stale (no success, a real prior
    // failure) so the assertions below can only be explained by half A's own
    // write landing inside the snapshot - not by this test accidentally
    // reading through to what the live row already says.
    db.prepare(
      "UPDATE backup_meta SET last_attempt_at = NULL, last_success_at = NULL, last_error = 'stale on the live row', last_error_at = datetime('now', '-1 hours') WHERE id = 1",
    ).run();

    // A fixed `now` well in the past: G2a (PR #42 review) means the row is
    // stamped with the VACUUM's actual completion time, not this `now` (`now`
    // stays reserved for the directory NAME, the deterministic race fixture
    // B6 needs) - so the assertions below check `>=`, not `===`, against it.
    const now = new Date("2026-03-15T00:30:00.123Z");
    const result = takeSnapshot(db, dataDir, "manual", now);
    assert.ok(result.ok, result.error);

    // The snapshot's OWN content, read with its own connection - a test that
    // only checked the live store could not see this bug at all.
    const snapshotDb = new Database(join(result.path, "hive.db"), { readonly: true });
    const meta = snapshotDb.prepare("SELECT * FROM backup_meta WHERE id = 1").get();
    snapshotDb.close();
    const nowStr = "2026-03-15 00:30:00.123";
    assert.ok(
      meta.last_attempt_at >= nowStr,
      "the snapshot's attempt time must be at or after the vacuum started, never before (G2a: completion time, not start time)",
    );
    assert.ok(
      meta.last_success_at >= nowStr,
      "the snapshot must prove its own success by its own row, stamped no earlier than the vacuum started",
    );
    assert.match(
      meta.last_success_at,
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/,
      "still millisecond resolution after G2a's rewrite to a completion timestamp",
    );
    // last_error/last_error_at must survive untouched: a real prior failure
    // stays readable after a later success, the same rule agent_state_log
    // exists for (CLAUDE.md, issue #24) - deleting it here would be that
    // mistake rebuilt one function over.
    assert.equal(meta.last_error, "stale on the live row");
    assert.ok(meta.last_error_at, "a prior failure recorded before this snapshot must remain readable inside it");

    // Confirms the write really landed in the STAGED copy: this test called
    // takeSnapshot directly (not backupNow), so the live row this connection
    // still has open must be untouched.
    assert.equal(readBackupMeta(db).last_success_at, null);

    // No stray -wal/-shm sidecar in the finished snapshot directory: VACUUM
    // INTO resets journal mode away from WAL, and the connection used to
    // write this row never sets it either. G3e (PR #42 review): these two
    // checks alone cannot fail - a clean close() removes both regardless of
    // journal mode, so every path where they could survive is a path where
    // close() itself failed, which a plain existsSync after the fact cannot
    // distinguish from "never created". The sidecar this connection can
    // actually leave behind, on a rollback journal mode, is -journal; see
    // the "issue #41 Group 2" describe block below for that check (G2c) and
    // an honest statement of what it does and does not prove.
    const files = readdirSync(result.path);
    assert.ok(!files.includes("hive.db-wal"), "no -wal file must survive in the snapshot directory");
    assert.ok(!files.includes("hive.db-shm"), "no -shm file must survive in the snapshot directory");
  });
});

// Issue #41 Group 2 (PR #42 review, counselors G2a/G2b/G2c): three defects
// in half A's own write, none caught by the round-trip tests above.
describe("issue #41 Group 2: half A's correctness", () => {
  // G2b. A truncated or short-written VACUUM INTO output can open FINE
  // (sqlite3_open reads no page - confirmed against a real garbage file
  // before writing this test) and only throw once something actually reads
  // a page, which half A's own UPDATE is the first thing in this module to
  // do. That NOTADB/CORRUPT is proof the copy is unrestorable and must fail
  // the snapshot, not be swallowed as ordinary bookkeeping noise.
  //
  // Exercised through the real public API, not by reaching into takeSnapshot
  // internals: `db` is only ever used for one call, `db.prepare("VACUUM INTO
  // ?").run(path)`, so a fake object satisfying just that shape can make a
  // "vacuum" write garbage to the target path instead of doing a real one.
  it("fails the snapshot when the staged copy will not open as a database, instead of publishing it", () => {
    rmSync(backupsDir(dataDir), { recursive: true, force: true });
    const fakeDb = {
      prepare: () => ({
        run: (path) => writeFileSync(path, "not a real sqlite database, just garbage bytes padded out"),
      }),
    };
    const result = takeSnapshot(fakeDb, dataDir, "manual");
    assert.equal(result.ok, false, "a snapshot whose staged copy will not open as a database must not be published");
    assert.match(result.error, /database/i);
    assert.equal(listSnapshots(dataDir).length, 0, "no directory must be renamed into backups/ for a corrupt copy");
  });

  // The other half of G2b's "keep it narrow" instruction: a missing
  // backup_meta table (a valid, empty SQLite file - confirmed this throws
  // SQLITE_ERROR "no such table", NOT NOTADB/CORRUPT, before writing this
  // test) says nothing about whether the COPY is restorable. It must still
  // be published; widening the G2b catch to "any error fails the backup"
  // would let this destroy an otherwise-good snapshot, a worse bug than the
  // one G2b fixes.
  it("still publishes the snapshot when the staged copy opens fine but has no backup_meta table", () => {
    rmSync(backupsDir(dataDir), { recursive: true, force: true });
    const fakeDb = {
      prepare: () => ({
        run: (path) => writeFileSync(path, ""), // a valid, empty SQLite database
      }),
    };
    const result = takeSnapshot(fakeDb, dataDir, "manual");
    assert.equal(
      result.ok,
      true,
      "a missing backup_meta table is a bookkeeping gap, not proof the copy is unrestorable - it must not fail the snapshot",
    );
    assert.equal(listSnapshots(dataDir).length, 1);
  });

  // G2c regression pin, and an honest statement of its limits (the pad's own
  // instruction: say what it would take for a test to pass while the
  // behaviour is broken). This pins the HAPPY path only: a normal write
  // followed by a clean close() never leaves a -journal sidecar. It does
  // NOT independently force the scenario G2c's runtime check actually
  // guards against - a hard interrupt (crash or power loss) mid-write,
  // which would need to kill the process at a specific sub-millisecond
  // point inside a single UPDATE statement, not reproducible deterministically
  // from a unit test. The runtime check in takeSnapshot is what protects
  // against that; this test only protects against a future change (e.g.
  // switching this connection to WAL or PERSIST journal mode) silently
  // starting to leave a journal behind on the ordinary path.
  it("a normal snapshot never leaves a rollback journal sidecar behind (happy-path pin, see comment)", () => {
    rmSync(backupsDir(dataDir), { recursive: true, force: true });
    const result = takeSnapshot(db, dataDir, "manual");
    assert.ok(result.ok, result.error);
    assert.ok(
      !existsSync(join(result.path, "hive.db-journal")),
      "no -journal file must survive in a published snapshot",
    );
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

// Issue #41 Group 1 redesign (PR #42 review, G1a-G1d): backupHealth now
// judges freshness and "has a backup succeeded" from the snapshots on disk,
// not from last_success_at, and reserves the row for what only the row
// knows (a recorded error). This replaces the earlier half B branch, which
// trusted the disk for the optimistic case only.
describe("issue #41 Group 1: backupHealth trusts the disk, not the row, for freshness", () => {
  it("reports ok, using the snapshot's own timestamp, when success is NULL but a fresh snapshot exists on disk", () => {
    rmSync(backupsDir(dataDir), { recursive: true, force: true });
    const backup = backupNow(db, dataDir, "manual");
    assert.ok(backup.ok, backup.error);
    const snapshotCreatedAt = listSnapshots(dataDir)[0].createdAt;

    // Simulate a pre-half-A snapshot restored onto the live store, or one
    // installed by hand with cp: a real, fresh, restorable snapshot sits in
    // backups/, but last_success_at reads NULL because the row is missing or
    // stale. This must read healthy because the SNAPSHOT is fresh, not
    // because of anything the row says.
    db.prepare("UPDATE backup_meta SET last_success_at = NULL WHERE id = 1").run();

    const health = backupHealth(db, dataDir);
    assert.equal(
      health.ok,
      true,
      "a store with a fresh restorable snapshot must not FAIL just because success was never recorded",
    );
    // Reuses the same "last success <ts>" wording as every other ok verdict
    // (the pad: do not invent a second phrasing for the same condition), now
    // sourced from the snapshot's own directory timestamp rather than the
    // (NULL) row.
    assert.ok(
      health.message.includes(snapshotCreatedAt.toISOString().slice(0, 19).replace("T", " ")),
      "the verdict must be based on the snapshot's own timestamp, not the missing row",
    );
  });

  // C3's case, generalized rather than relaxed: zero snapshots must still
  // FAIL regardless of what the row says.
  it("still FAILs when last_success_at is NULL and there are zero snapshots", () => {
    rmSync(backupsDir(dataDir), { recursive: true, force: true });
    db.prepare("UPDATE backup_meta SET last_success_at = NULL WHERE id = 1").run();
    const health = backupHealth(db, dataDir);
    assert.equal(health.ok, false, "zero snapshots must still FAIL regardless of last_success_at");
    assert.match(health.message, /nothing to restore from/);
  });

  // G1a, the exact asymmetry the lead reproduced against a scratch store: an
  // OLD but still-listed snapshot with success NULL used to read healthier
  // than the identical snapshot with success recorded, because only the
  // null branch ever consulted the disk. Under the redesign both must FAIL,
  // since neither reads last_success_at from the LIVE row at all any more -
  // freshness comes from MAX(the snapshot's own directory name, the
  // SNAPSHOT'S OWN row's last_success_at), never the live row.
  //
  // The SNAPSHOT's own row has to be poisoned too, not just the live row:
  // takeSnapshot's G2a write always uses the REAL clock for last_success_at
  // (deliberately - completedAt can never be older than the vacuum it
  // measures), so passing an ancient `now` only ages the DIRECTORY name.
  // A genuinely 59-day-old snapshot would have its OWN row agree with its
  // directory (both captured 59 days ago, in the same real operation); a
  // test simulating "old" has to make the same two values agree by hand.
  it("an OLD snapshot still FAILs as stale whether or not a success was ever recorded (G1a)", () => {
    rmSync(backupsDir(dataDir), { recursive: true, force: true });
    const localDb = new Database(join(dataDir, "hive.db"));
    const ancient = new Date(Date.now() - 59 * 24 * 60 * 60 * 1000);
    const ancientStr = ancient.toISOString().slice(0, 23).replace("T", " ");
    const result = takeSnapshot(localDb, dataDir, "manual", ancient);
    assert.ok(result.ok, result.error);

    const poisonSnapshotRow = (successAt) => {
      const snapDb = new Database(join(result.path, "hive.db"));
      snapDb.prepare("UPDATE backup_meta SET last_success_at = ? WHERE id = 1").run(successAt);
      snapDb.close();
    };

    poisonSnapshotRow(null);
    localDb.prepare("UPDATE backup_meta SET last_success_at = NULL, last_error_at = NULL WHERE id = 1").run();
    const withNullSuccess = backupHealth(localDb, dataDir);
    assert.equal(withNullSuccess.ok, false, "an ancient snapshot with no recorded success must still read as stale");
    assert.match(withNullSuccess.message, /more than \d+ day\(s\) old/);

    poisonSnapshotRow(ancientStr);
    localDb.prepare("UPDATE backup_meta SET last_success_at = ?, last_error_at = NULL WHERE id = 1").run(ancientStr);
    const withRecordedSuccess = backupHealth(localDb, dataDir);
    assert.equal(
      withRecordedSuccess.ok,
      false,
      "the SAME ancient snapshot, now WITH a recorded success, must not read healthier than it did without one",
    );
    assert.match(withRecordedSuccess.message, /more than \d+ day\(s\) old/);
    localDb.close();
  });

  // Found while implementing this redesign, not in the pad. The directory
  // name is the snapshot's START time (captured before VACUUM INTO,
  // deliberately - B6 needs it fixed for the race test), not its
  // completion. Reproduced concretely before writing this fix: a live-row
  // failure timed to land DURING a simulated long vacuum - after the
  // directory name's `now` but before the snapshot's own row is written -
  // used to make backupHealth report FAIL even though the snapshot's own
  // row (G2a's real completion time, always captured after the vacuum
  // returns) proves that exact failure was resolved. A large VACUUM INTO
  // can run long enough for a DIFFERENT server to record a failure in that
  // window, and the directory name alone cannot see past it - the fix takes
  // MAX(directory name, the snapshot's own row) rather than the directory
  // name alone.
  it("a snapshot's own row proves recovery from a failure the directory name alone cannot see", () => {
    rmSync(backupsDir(dataDir), { recursive: true, force: true });
    const localDb = new Database(join(dataDir, "hive.db"));
    // Simulates a vacuum that has been running for 2 seconds: the directory
    // name is 2 seconds old. A different server's failure lands 1 second
    // ago - after the directory name's `now`, but before this snapshot's
    // own row gets written (which always uses the REAL completion time).
    const vacuumStart = new Date(Date.now() - 2000);
    localDb
      .prepare(
        "UPDATE backup_meta SET last_error = 'concurrent failure', last_error_at = datetime('now', '-1 seconds') WHERE id = 1",
      )
      .run();

    const result = takeSnapshot(localDb, dataDir, "manual", vacuumStart);
    assert.ok(result.ok, result.error);

    const health = backupHealth(localDb, dataDir);
    assert.equal(
      health.ok,
      true,
      "the snapshot's own completion time must prove the concurrent failure was resolved, even though the directory name alone (captured before the vacuum) is older than that failure",
    );
    localDb.close();
  });

  // G1d: a directory whose name matches the pattern but has no hive.db
  // inside (an interrupted prune, or a partial hand `cp`) must not be named
  // as restorable. listSnapshots must still SEE it (retention needs to sweep
  // it), but backupHealth must not point an operator at it.
  it("does not name a junk directory (no hive.db inside) as restorable (G1d)", () => {
    rmSync(backupsDir(dataDir), { recursive: true, force: true });
    const junkName = `${new Date().toISOString().replace(/[:.]/g, "-")}-manual`;
    const junkDir = join(backupsDir(dataDir), junkName);
    mkdirSync(junkDir, { recursive: true });
    writeFileSync(join(junkDir, "profiles-only-no-db"), "not a hive.db");

    // Confirms listSnapshots still sees it by name (retention's contract) -
    // the fix scopes restorability to backupHealth, not to listing.
    assert.equal(listSnapshots(dataDir).length, 1, "listSnapshots must still see the junk directory by name");

    const health = backupHealth(db, dataDir);
    assert.equal(health.ok, false, "a directory with no hive.db inside must not be named as restorable");
    assert.match(health.message, /nothing to restore from/);
  });

  // G3d, re-derived against the redesign: the branch ORDER is what makes
  // this correct, and nothing else pins it. A real, more-recent-than-any-
  // snapshot failure must still FAIL doctor even though a restorable
  // snapshot exists - checking "is there a snapshot" before "did the most
  // recent attempt fail" would report ok on a store whose backups are
  // failing right now.
  it("a real failure more recent than the newest snapshot still FAILs, even though a snapshot exists (G3d)", () => {
    rmSync(backupsDir(dataDir), { recursive: true, force: true });
    const localDb = new Database(join(dataDir, "hive.db"));
    localDb
      .prepare(
        "UPDATE backup_meta SET last_attempt_at = NULL, last_success_at = NULL, last_error = NULL, last_error_at = NULL WHERE id = 1",
      )
      .run();
    const first = backupNow(localDb, dataDir, "manual");
    assert.ok(first.ok, first.error);

    // A NEW failure, strictly after the snapshot just taken. Delegates every
    // other statement to the real connection so backupNow's own error
    // bookkeeping still lands on the live row; only "VACUUM INTO" fails.
    const vacuumFailsDb = {
      prepare(sql) {
        if (sql.includes("VACUUM INTO")) {
          return {
            run() {
              throw new Error("simulated vacuum failure");
            },
          };
        }
        return localDb.prepare(sql);
      },
    };
    const failed = backupNow(vacuumFailsDb, dataDir, "manual");
    assert.equal(failed.ok, false);

    const health = backupHealth(localDb, dataDir);
    assert.equal(
      health.ok,
      false,
      "a real failure more recent than the newest restorable snapshot must FAIL doctor's check",
    );
    localDb.close();
  });
});

// Issue #39/#41 half C: backup_meta timestamps are now millisecond-resolution
// (SQL_NOW in src/backup.ts), specifically so a failure and a success inside
// the same wall-clock second can be ordered. At second resolution these two
// events used to write identical strings and be unorderable - the original
// #39 report.
describe("issue #39/#41 half C: millisecond resolution orders events inside the same second", () => {
  // The shared second has to be a REAL recent one, not a fixed past date:
  // backupHealth's staleness check (last N days) would otherwise fail these
  // for being too old, which is a different branch than the tie-break this
  // describe block exists to pin.
  const recentSecond = () => new Date().toISOString().slice(0, 19).replace("T", " ");

  // G3c (PR #42 review): the first version of these two tests hand-wrote
  // BOTH last_error_at and last_success_at as fixtures and asserted
  // backupHealth's verdict, so the only code they actually touched was the
  // pre-existing JS >= comparison - reverting SQL_NOW to plain datetime('now')
  // everywhere still left them green. They also predate Group 1's redesign,
  // under which backupHealth compares last_error_at against
  // MAX(the newest snapshot's directory name, that snapshot's OWN
  // last_success_at) rather than the live row's last_success_at at all.
  //
  // These two pin the snapshot's own row DIRECTLY, rather than relying on
  // takeSnapshot's injected `now` to control the comparison value: `now`
  // only sets the directory name, and the MAX means the real, uncontrolled
  // completedAt (G2a - always the actual clock, however long the vacuum
  // takes) can pull the comparison value later than intended. Measured
  // while writing this: under load, from the rest of the suite running,
  // completedAt landed past the injected .900 boundary and flipped one of
  // these from failed to resolved. Poisoning the row directly removes that
  // dependency on real timing.
  //
  // Todo 102(a), 2026-07-30: pinning the row closed only HALF of it, and the
  // other half made the second test below flake at ~7% (4 failures in 60
  // full-suite runs; 3 in 25 the day before). MAX(directory name, own row)
  // has two uncontrolled inputs, not one. Pinning the row LOW - which the
  // second test must do, since it needs the failure to be the later event -
  // means the row loses the MAX and the DIRECTORY NAME becomes the
  // comparison value. That name comes from takeSnapshot's `now`, which
  // defaults to the real clock (src/backup.ts:199, formatted at :26), read
  // after recentSecond() has already fixed `sec`. Under load the gap grows
  // past the leftover milliseconds before the hardcoded .900 and the failure
  // reads as resolved. So `now` IS injected below, and both inputs to the
  // MAX are controlled. The first test never flaked because a late name only
  // pushes it further toward its expected true; that asymmetry is why this
  // survived the fix above. Product code is correct in every observed run.
  const pinnedNow = (sec) => new Date(`${sec.replace(" ", "T")}.000Z`);
  it("a snapshot's own row, later in the SAME second than a recorded failure, resolves it - not tied", () => {
    rmSync(backupsDir(dataDir), { recursive: true, force: true });
    const localDb = new Database(join(dataDir, "hive.db"));
    const sec = recentSecond();
    // A real failure recorded earlier in this second.
    localDb.prepare("UPDATE backup_meta SET last_error = 'transient', last_error_at = ? WHERE id = 1").run(
      `${sec}.100`,
    );
    // A snapshot whose OWN row is pinned to land LATER in the exact same
    // second: at second resolution these would have been indistinguishable
    // and tied - the original #39 report.
    const result = takeSnapshot(localDb, dataDir, "manual");
    assert.ok(result.ok, result.error);
    const snapDb = new Database(join(result.path, "hive.db"));
    snapDb.prepare("UPDATE backup_meta SET last_success_at = ? WHERE id = 1").run(`${sec}.900`);
    snapDb.close();

    const health = backupHealth(localDb, dataDir);
    assert.equal(
      health.ok,
      true,
      "a snapshot genuinely later in the same second than the last failure must read as recovered",
    );
    assert.equal(readBackupMeta(localDb).last_error, "transient", "the earlier failure must still be on the row");
    localDb.close();
  });

  it("a failure recorded later in the SAME second than the newest snapshot's own row still reads as failed", () => {
    rmSync(backupsDir(dataDir), { recursive: true, force: true });
    const localDb = new Database(join(dataDir, "hive.db"));
    const sec = recentSecond();
    // The .000 name loses the MAX to the .100 row below, so the comparison
    // value is pinned at .100 regardless of how long this takes to run.
    const result = takeSnapshot(localDb, dataDir, "manual", pinnedNow(sec));
    assert.ok(result.ok, result.error);
    const snapDb = new Database(join(result.path, "hive.db"));
    snapDb.prepare("UPDATE backup_meta SET last_success_at = ? WHERE id = 1").run(`${sec}.100`);
    snapDb.close();

    localDb.prepare("UPDATE backup_meta SET last_error = 'still broken', last_error_at = ? WHERE id = 1").run(
      `${sec}.900`,
    );
    const health = backupHealth(localDb, dataDir);
    assert.equal(
      health.ok,
      false,
      "a failure genuinely later in the same second than the newest snapshot's own row must still read as failed",
    );
    localDb.close();
  });

  // G3c's other ask: drive at least one of these through REAL writes, not
  // hand-typed fixtures, so SQL_NOW itself is actually exercised on both
  // sides. Measured while writing this test: two real backupNow calls with
  // truly no delay between them can land in the IDENTICAL millisecond on
  // this hardware (both writes read 658 in one run), which the >= tie-break
  // correctly reads as still-failed - the conservative, intended behaviour,
  // but it means "back-to-back" alone does not reliably exercise the
  // orderable case this test exists to pin. A short busy-wait guarantees a
  // different millisecond while staying overwhelmingly likely to remain in
  // the same wall-clock SECOND, which is the actual case under test.
  it("a real failure followed by a real success, one millisecond apart, still order correctly in the same second", () => {
    rmSync(backupsDir(dataDir), { recursive: true, force: true });
    const localDb = new Database(join(dataDir, "hive.db"));
    localDb.prepare(
      "UPDATE backup_meta SET last_attempt_at = NULL, last_success_at = NULL, last_error = NULL, last_error_at = NULL WHERE id = 1",
    ).run();

    // A REAL forced failure (backups/ is a plain file) through backupNow's
    // own SQL_NOW write.
    const realBackups = backupsDir(dataDir);
    writeFileSync(realBackups, "not a directory");
    const failed = backupNow(localDb, dataDir, "manual");
    assert.equal(failed.ok, false);
    rmSync(realBackups, { force: true });

    const until = Date.now() + 2;
    while (Date.now() < until) {
      // Guarantee at least one millisecond has elapsed - see the comment
      // above this test.
    }
    const succeeded = backupNow(localDb, dataDir, "manual");
    assert.ok(succeeded.ok, succeeded.error);

    const meta = readBackupMeta(localDb);
    assert.ok(meta.last_error, "the failure must have been recorded");
    assert.equal(
      backupHealth(localDb, dataDir).ok,
      true,
      "a real success after a real failure must read as recovered, even one millisecond apart in the same wall-clock second",
    );
    localDb.close();
  });

  it("real writes from the hourly claim path, and a real forced failure, both actually carry millisecond resolution", () => {
    db.prepare(
      "UPDATE backup_meta SET last_attempt_at = NULL, last_success_at = NULL, last_error = NULL, last_error_at = NULL WHERE id = 1",
    ).run();
    maybeBackupHourly(db, dataDir);
    const meta = readBackupMeta(db);
    const msFormat = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/;
    assert.match(meta.last_attempt_at, msFormat, "last_attempt_at must carry millisecond resolution, not just seconds");
    assert.match(meta.last_success_at, msFormat, "last_success_at must carry millisecond resolution, not just seconds");

    // G3c: the earlier version of this test never checked last_error_at's
    // OWN format, so leaving its write on plain datetime('now') would have
    // kept the suite green while a same-second failure-after-success stayed
    // misordered.
    db.prepare("UPDATE backup_meta SET last_attempt_at = datetime('now', '-2 hours') WHERE id = 1").run();
    const realBackups = backupsDir(dataDir);
    rmSync(realBackups, { recursive: true, force: true });
    writeFileSync(realBackups, "not a directory");
    maybeBackupHourly(db, dataDir);
    assert.match(readBackupMeta(db).last_error_at, msFormat, "last_error_at must carry millisecond resolution too");
    rmSync(realBackups, { force: true });
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
    // At this point backups/ is a plain file, not a directory, so there is
    // no restorable snapshot at all - this hits the same "nothing to
    // restore from" branch as the zero-snapshot case (C3), not specifically
    // the failedMostRecently branch. Group 1's "a real failure more recent
    // than the newest snapshot still FAILs" case (G3d, above) is what pins
    // failedMostRecently directly, with a real snapshot present.
    assert.equal(backupHealth(db, dataDir).ok, false, "no restorable snapshot plus a recorded failure must fail doctor's check");

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

  // D1/D2 regression pin (PR #42 review, deliberately deferred - see the
  // comment on SQL_NOW): during a rolling upgrade, an OLD server still
  // running second-resolution code can write a last_attempt_at with no
  // millisecond component. This is the SAFE direction of that residual - a
  // second-resolution value read by the NEW (millisecond-aware) code - and
  // it is the only direction testable from this branch: the unsafe
  // direction needs an OLD process actually running old code, which nothing
  // here can reproduce. A second-resolution value inside the CURRENT second
  // must not be misjudged as "in the future" by claimStatement's third
  // disjunct, which would double-fire the hourly claim.
  it("a recent second-resolution last_attempt_at is not misjudged as future by the millisecond-aware claim", () => {
    const secondOnly = new Date().toISOString().slice(0, 19).replace("T", " ");
    db.prepare("UPDATE backup_meta SET last_attempt_at = ? WHERE id = 1").run(secondOnly);
    const before = listSnapshots(dataDir).filter((s) => s.reason === "hourly").length;
    maybeBackupHourly(db, dataDir);
    assert.equal(
      listSnapshots(dataDir).filter((s) => s.reason === "hourly").length,
      before,
      "a recent second-resolution last_attempt_at must not be misread as future just because it lacks a millisecond component - no claim, and no extra backup, should result",
    );
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

// Issue #41 round trip: halves A/B/C and Groups 1/2 unit-tested their own
// function in isolation above. This describe block is the thing the issue
// was actually filed about - a REAL restoreSnapshot() call, then
// backupHealth read against the store that restore left behind - for all
// three verdicts the one defect produced. Each test opens its own local
// connection rather than the shared top-level `db` module import: the last
// describe block above already closed it, and restoreSnapshot needs the
// file free anyway.
//
// G3a/G3b (PR #42 review): the first version of these three tests could not
// fail. Case 1 asserted only health.ok, and half B's OLD null-success branch
// also returned ok, so the test named for half A passed while pinning half
// B instead. And none of the three proved they were reading RESTORED state:
// each called backupNow and restored immediately, so the LIVE row was
// already in the asserted shape before restoreSnapshot ever ran - a
// no-op restoreSnapshot would have passed all three. Every test below now
// POISONS the live row (or, for case 2, the SNAPSHOT's own row) between
// taking the backup and restoring it, to a value the assertions below would
// fail against - so passing requires the restore to have genuinely replaced
// that content, not merely left an already-correct row untouched - and
// reads the actual ROW content, not only backupHealth's boolean verdict.
describe("issue #41 round trip: all three restore verdicts pinned end to end", () => {
  it("case 1: restoring a store's first-ever snapshot writes a real success into the row, and reads healthy", () => {
    rmSync(backupsDir(dataDir), { recursive: true, force: true });
    const localDb = new Database(join(dataDir, "hive.db"));
    // Genuinely first-ever: no success recorded before this backup at all.
    localDb.prepare(
      "UPDATE backup_meta SET last_attempt_at = NULL, last_success_at = NULL, last_error = NULL, last_error_at = NULL WHERE id = 1",
    ).run();
    const backup = backupNow(localDb, dataDir, "manual");
    assert.ok(backup.ok, backup.error);
    const snapshotName = listSnapshots(dataDir)[0].name;

    // G3b: poison the LIVE row AFTER taking the backup, BEFORE restoring.
    // If restoreSnapshot were a no-op, a fresh read below would see this.
    localDb
      .prepare(
        "UPDATE backup_meta SET last_success_at = NULL, last_attempt_at = NULL, last_error = 'poison', last_error_at = strftime('%Y-%m-%d %H:%M:%f', 'now') WHERE id = 1",
      )
      .run();

    localDb.close();
    restoreSnapshot(dataDir, snapshotName);

    const restored = new Database(join(dataDir, "hive.db"));

    // G3a: read the ROW, not just the verdict. Under Group 1's redesign,
    // backupHealth judges freshness from the snapshot's own DIRECTORY
    // timestamp, not from last_success_at - so a healthy verdict alone no
    // longer proves half A's write happened at all; it would read healthy
    // purely because the snapshot file is fresh and restorable, regardless
    // of what its row says. This asserts half A's actual contract directly.
    const meta = readBackupMeta(restored);
    assert.ok(meta.last_success_at, "half A must have written a real success into the snapshot's own row");
    assert.notEqual(
      meta.last_error,
      "poison",
      "the restored row must be the snapshot's OWN content, not the poisoned live row - proving a real restore happened",
    );

    const health = backupHealth(restored, dataDir);
    assert.equal(
      health.ok,
      true,
      "restoring the store's first-ever snapshot must read healthy right away - half A's own success write, not a wait for the next hourly claim to self-heal",
    );
    restored.close();
  });

  it("case 2: a snapshot's own row can only push freshness LATER than its directory name, never earlier (G1b)", () => {
    rmSync(backupsDir(dataDir), { recursive: true, force: true });
    const localDb = new Database(join(dataDir, "hive.db"));
    localDb.prepare(
      "UPDATE backup_meta SET last_attempt_at = NULL, last_success_at = NULL, last_error = NULL, last_error_at = NULL WHERE id = 1",
    ).run();
    // A real, fresh snapshot, taken right now.
    const backup = backupNow(localDb, dataDir, "manual");
    assert.ok(backup.ok, backup.error);
    const snapshot = listSnapshots(dataDir)[0];

    // Poison the SNAPSHOT'S OWN row directly, not the live row: simulate a
    // row that is OLDER than the directory itself is fresh - the general
    // shape of a pre-half-A or hand-copied snapshot (G1b), where the row
    // reflects an earlier backup's success (or none at all). backupHealth
    // takes MAX(directory name, the snapshot's own row) - never the row
    // alone - specifically so a row like this one, which is SMALLER than
    // the directory name, cannot drag a fresh snapshot down to stale.
    const snapDb = new Database(join(snapshot.path, "hive.db"));
    const ancient = "2020-01-01 00:00:00.000";
    snapDb.prepare("UPDATE backup_meta SET last_success_at = ?, last_attempt_at = ? WHERE id = 1").run(
      ancient,
      ancient,
    );
    snapDb.close();

    localDb.close();
    restoreSnapshot(dataDir, snapshot.name);

    const restored = new Database(join(dataDir, "hive.db"));
    // G3b: proves the restore actually happened - if restoreSnapshot were a
    // no-op, the live row would still show the FRESH value backupNow just
    // wrote above, not this poisoned ancient one.
    assert.equal(
      readBackupMeta(restored).last_success_at,
      ancient,
      "the restored row must be the snapshot's poisoned copy, proving a real restore happened",
    );

    const health = backupHealth(restored, dataDir);
    assert.equal(
      health.ok,
      true,
      "a freshly-taken snapshot must read healthy from its directory name, even though its own row claims an OLDER (ancient) success",
    );
    assert.doesNotMatch(health.message, /more than \d+ day\(s\) old/);
    restored.close();
  });

  it("case 3: restoring a snapshot taken after a resolved failure does not resurrect that failure as the current verdict", () => {
    rmSync(backupsDir(dataDir), { recursive: true, force: true });
    const localDb = new Database(join(dataDir, "hive.db"));
    // Seeded explicitly, per the plan: last_error_at newer than
    // last_success_at will not arise on its own. This is a real failure that
    // has not been resolved on the live row yet when the snapshot is taken.
    localDb.prepare(
      "UPDATE backup_meta SET last_attempt_at = datetime('now', '-1 hours'), last_success_at = NULL, last_error = 'disk full', last_error_at = datetime('now', '-10 seconds') WHERE id = 1",
    ).run();

    // Taken now, after the failure: half A writes THIS snapshot's own
    // success at its own (later, real completion - G2a) timestamp into the
    // staged copy, while last_error/last_error_at pass through untouched
    // from the live row at vacuum time - proving the failure resolves
    // inside the snapshot without being erased.
    const backup = backupNow(localDb, dataDir, "manual");
    assert.ok(backup.ok, backup.error);
    const snapshotName = listSnapshots(dataDir)[0].name;

    // G3b: poison the LIVE row AFTER taking the snapshot, BEFORE restoring -
    // a FRESH, unresolved-looking failure that a real restore must wipe out.
    localDb
      .prepare(
        "UPDATE backup_meta SET last_error = 'poison', last_error_at = strftime('%Y-%m-%d %H:%M:%f', 'now'), last_success_at = NULL WHERE id = 1",
      )
      .run();

    localDb.close();
    restoreSnapshot(dataDir, snapshotName);

    const restored = new Database(join(dataDir, "hive.db"));
    const meta = readBackupMeta(restored);
    assert.equal(
      meta.last_error,
      "disk full",
      "the restored row must be the snapshot's own content ('disk full'), not the poison - proving a real restore happened",
    );
    assert.ok(meta.last_error_at, "the earlier failure's timestamp must still be readable after restore");

    const health = backupHealth(restored, dataDir);
    assert.equal(
      health.ok,
      true,
      "a snapshot taken after a real failure was resolved must not resurrect that failure as the current verdict",
    );
    restored.close();
  });
});
