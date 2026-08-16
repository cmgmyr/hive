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

const BETTER_SQLITE3_URL = pathToFileURL(join(REPO, "node_modules", "better-sqlite3", "lib", "index.js")).href;

const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;

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

    const raceDirs = scratchDirs();
    const script = `
import { migrate } from ${JSON.stringify(DB_JS_URL)};
migrate();
process.stdout.write(JSON.stringify({ ok: true }));
`;
    const results = await raceProcesses(script, [["a"], ["b"]], { env: { HIVE_DATA_DIR: raceDirs.dataDir } });
    assert.ok(results[0].ok);
    assert.ok(results[1].ok);

    const check = new Database(join(raceDirs.dataDir, "hive.db"));
    const migrationsApplied = check.prepare("SELECT COUNT(*) AS c FROM migrations").get().c;
    assert.ok(migrationsApplied > 0);
    const meta = check.prepare("SELECT * FROM backup_meta WHERE id = 1").get();
    assert.ok(meta, "backup_meta must exist and be queryable after the race");
    check.close();
  });
});

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

    const raceDirs = scratchDirs();
    const dbPath = join(raceDirs.dataDir, "hive.db");

    await raceProcesses(
      `import { migrate } from ${JSON.stringify(DB_JS_URL)};\nmigrate();\nprocess.stdout.write(JSON.stringify({ ok: true }));\n`,
      [["bootstrap"]],
      { env: { HIVE_DATA_DIR: raceDirs.dataDir } },
    );

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

    const a = new Database(join(results[0].path, "hive.db"), { readonly: true });
    const b = new Database(join(results[1].path, "hive.db"), { readonly: true });
    const markers = [a.prepare("SELECT a FROM t").get().a, b.prepare("SELECT a FROM t").get().a].sort();
    assert.deepEqual(markers, [1, 2]);
    a.close();
    b.close();
  });
});

describe("issue #41 half A: a snapshot's own backup_meta records its own success", () => {
  it("writes last_attempt_at and last_success_at into the snapshot itself, not just the live row", () => {
    rmSync(backupsDir(dataDir), { recursive: true, force: true });

    db.prepare(
      "UPDATE backup_meta SET last_attempt_at = NULL, last_success_at = NULL, last_error = 'stale on the live row', last_error_at = datetime('now', '-1 hours') WHERE id = 1",
    ).run();

    const now = new Date("2026-03-15T00:30:00.123Z");
    const result = takeSnapshot(db, dataDir, "manual", now);
    assert.ok(result.ok, result.error);

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

    assert.equal(meta.last_error, "stale on the live row");
    assert.ok(meta.last_error_at, "a prior failure recorded before this snapshot must remain readable inside it");

    assert.equal(readBackupMeta(db).last_success_at, null);

    const files = readdirSync(result.path);
    assert.ok(!files.includes("hive.db-wal"), "no -wal file must survive in the snapshot directory");
    assert.ok(!files.includes("hive.db-shm"), "no -shm file must survive in the snapshot directory");
  });
});

describe("issue #41 Group 2: half A's correctness", () => {

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

  it("still publishes the snapshot when the staged copy opens fine but has no backup_meta table", () => {
    rmSync(backupsDir(dataDir), { recursive: true, force: true });
    const fakeDb = {
      prepare: () => ({
        run: (path) => writeFileSync(path, ""),
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

describe("issue #41 Group 1: backupHealth trusts the disk, not the row, for freshness", () => {
  it("reports ok, using the snapshot's own timestamp, when success is NULL but a fresh snapshot exists on disk", () => {
    rmSync(backupsDir(dataDir), { recursive: true, force: true });
    const backup = backupNow(db, dataDir, "manual");
    assert.ok(backup.ok, backup.error);
    const snapshotCreatedAt = listSnapshots(dataDir)[0].createdAt;

    db.prepare("UPDATE backup_meta SET last_success_at = NULL WHERE id = 1").run();

    const health = backupHealth(db, dataDir);
    assert.equal(
      health.ok,
      true,
      "a store with a fresh restorable snapshot must not FAIL just because success was never recorded",
    );

    const reportedAt = health.message.match(/last success (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?)/);
    assert.ok(reportedAt, "the verdict must be based on the snapshot's own timestamp, not the missing row");
    const reportedAtMs = new Date(reportedAt[1].replace(" ", "T") + "Z").getTime();
    assert.ok(
      reportedAtMs >= snapshotCreatedAt.getTime() && reportedAtMs <= Date.now(),
      "the reported timestamp must fall between the snapshot's own creation and now, proving it came from disk rather than the missing row",
    );
  });

  it("still FAILs when last_success_at is NULL and there are zero snapshots", () => {
    rmSync(backupsDir(dataDir), { recursive: true, force: true });
    db.prepare("UPDATE backup_meta SET last_success_at = NULL WHERE id = 1").run();
    const health = backupHealth(db, dataDir);
    assert.equal(health.ok, false, "zero snapshots must still FAIL regardless of last_success_at");
    assert.match(health.message, /nothing to restore from/);
  });

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

  it("a snapshot's own row proves recovery from a failure the directory name alone cannot see", () => {
    rmSync(backupsDir(dataDir), { recursive: true, force: true });
    const localDb = new Database(join(dataDir, "hive.db"));

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

  it("does not name a junk directory (no hive.db inside) as restorable (G1d)", () => {
    rmSync(backupsDir(dataDir), { recursive: true, force: true });
    const junkName = `${new Date().toISOString().replace(/[:.]/g, "-")}-manual`;
    const junkDir = join(backupsDir(dataDir), junkName);
    mkdirSync(junkDir, { recursive: true });
    writeFileSync(join(junkDir, "profiles-only-no-db"), "not a hive.db");

    assert.equal(listSnapshots(dataDir).length, 1, "listSnapshots must still see the junk directory by name");

    const health = backupHealth(db, dataDir);
    assert.equal(health.ok, false, "a directory with no hive.db inside must not be named as restorable");
    assert.match(health.message, /nothing to restore from/);
  });

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

describe("issue #39/#41 half C: millisecond resolution orders events inside the same second", () => {

  const recentSecond = () => new Date().toISOString().slice(0, 19).replace("T", " ");

  const pinnedNow = (sec) => new Date(`${sec.replace(" ", "T")}.000Z`);
  it("a snapshot's own row, later in the SAME second than a recorded failure, resolves it - not tied", () => {
    rmSync(backupsDir(dataDir), { recursive: true, force: true });
    const localDb = new Database(join(dataDir, "hive.db"));
    const sec = recentSecond();

    localDb.prepare("UPDATE backup_meta SET last_error = 'transient', last_error_at = ? WHERE id = 1").run(
      `${sec}.100`,
    );

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

  it("a real failure followed by a real success, one millisecond apart, still order correctly in the same second", () => {
    rmSync(backupsDir(dataDir), { recursive: true, force: true });
    const localDb = new Database(join(dataDir, "hive.db"));
    localDb.prepare(
      "UPDATE backup_meta SET last_attempt_at = NULL, last_success_at = NULL, last_error = NULL, last_error_at = NULL WHERE id = 1",
    ).run();

    const realBackups = backupsDir(dataDir);
    writeFileSync(realBackups, "not a directory");
    const failed = backupNow(localDb, dataDir, "manual");
    assert.equal(failed.ok, false);
    rmSync(realBackups, { force: true });

    const until = Date.now() + 2;
    while (Date.now() < until) {

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

  it("claims when last_attempt_at is in the future (clock skew)", () => {
    db.prepare("UPDATE backup_meta SET last_attempt_at = datetime('now', '+2 hours') WHERE id = 1").run();
    const before = listSnapshots(dataDir).filter((s) => s.reason === "hourly").length;
    maybeBackupHourly(db, dataDir);
    assert.equal(listSnapshots(dataDir).filter((s) => s.reason === "hourly").length, before + 1);
  });

  it("records last_error and last_error_at, and does not stop hive, when a backup fails", () => {
    db.prepare("UPDATE backup_meta SET last_attempt_at = datetime('now', '-2 hours') WHERE id = 1").run();
    const realBackups = backupsDir(dataDir);

    rmSync(realBackups, { recursive: true, force: true });
    writeFileSync(realBackups, "not a directory");
    maybeBackupHourly(db, dataDir);
    const meta = readBackupMeta(db);
    assert.ok(meta.last_error, "last_error should be recorded when the snapshot itself fails");
    assert.ok(meta.last_error_at, "last_error_at should be recorded alongside it");

    assert.equal(backupHealth(db, dataDir).ok, false, "no restorable snapshot plus a recorded failure must fail doctor's check");

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

    const now = new Date("2026-03-15T00:30:00.000Z");
    const daysAgo = (n) => new Date(now.getTime() - n * 24 * 60 * 60 * 1000);

    const recent = Array.from({ length: 10 }, (_, i) => fakeSnapshot(new Date(now.getTime() - i * 60_000), "hourly"));

    const daily = Array.from({ length: 10 }, (_, i) => fakeSnapshot(daysAgo(i + 0.5), "hourly"));

    const removed = pruneSnapshots(dataDir, { keepLast: 10, keepDailyDays: 7 }, now);
    const remainingNames = new Set(listSnapshots(dataDir).map((s) => s.name));

    for (const name of recent) assert.ok(remainingNames.has(name), `${name} is within keepLast and must survive`);
    for (let i = 0; i < 7; i++) assert.ok(remainingNames.has(daily[i]), `${daily[i]} is within the daily window and must survive`);
    for (let i = 7; i < 10; i++) assert.ok(!remainingNames.has(daily[i]), `${daily[i]} is outside both policies and must be pruned`);
    assert.equal(removed.length, 3);
  });

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

  it("never prunes an explicitly protected snapshot, even when the policy alone would evict it", () => {
    rmSync(backupsDir(dataDir), { recursive: true, force: true });
    const now = new Date("2026-03-15T00:30:00.000Z");
    const target = fakeSnapshot(new Date(now.getTime() - 20 * 24 * 60 * 60 * 1000), "hourly");
    for (let i = 0; i < 9; i++) fakeSnapshot(new Date(now.getTime() - i * 60_000), "hourly");

    pruneSnapshots(dataDir, { keepLast: 1, keepDailyDays: 0 }, now, new Set([target]));
    const remainingNames = new Set(listSnapshots(dataDir).map((s) => s.name));
    assert.ok(remainingNames.has(target), "a protected snapshot must survive even outside every retention window");
  });

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

    db.prepare("DELETE FROM scratchpads WHERE project_id = ?").run(projectId);
    db.prepare("DELETE FROM todos WHERE project_id = ?").run(projectId);
    db.prepare("DELETE FROM projects WHERE id = ?").run(projectId);
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM projects WHERE id = ?").get(projectId).c, 0);

    db.close();
    const { restoredProfiles } = restoreSnapshot(dataDir, snapshotName);
    assert.equal(restoredProfiles, false);

    const restored = new Database(join(dataDir, "hive.db"));
    const project = restored.prepare("SELECT * FROM projects WHERE path = '/tmp/restore-test-project'").get();
    assert.ok(project, "the deleted project must be back after restore");
    const pad = restored.prepare("SELECT * FROM scratchpads WHERE project_id = ?").get(project.id);
    assert.equal(pad.content, "do not lose this");
    const todo = restored.prepare("SELECT * FROM todos WHERE project_id = ?").get(project.id);
    assert.equal(todo.title, "recoverable todo");
    restored.close();
  });

  it("stages and swaps profiles/ atomically, replacing old content rather than merging with it", () => {
    rmSync(backupsDir(dataDir), { recursive: true, force: true });
    const profilesDir = join(dataDir, "profiles");
    rmSync(profilesDir, { recursive: true, force: true });
    mkdirSync(join(profilesDir, "orchestration"), { recursive: true });
    writeFileSync(join(profilesDir, "orchestration", "posture.md"), "original posture");

    const localDb = new Database(join(dataDir, "hive.db"));
    const backup = backupNow(localDb, dataDir, "manual");
    assert.ok(backup.ok, backup.error);
    const snapshotName = listSnapshots(dataDir)[0].name;

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

    assert.ok(!existsSync(`${profilesDir}.restoring`));
    assert.ok(!existsSync(`${profilesDir}.old`));
  });

  it("recovers a crashed prior restore's profiles.old/ even when this restore's own snapshot has no profiles", () => {
    rmSync(backupsDir(dataDir), { recursive: true, force: true });
    const profilesDir = join(dataDir, "profiles");
    rmSync(profilesDir, { recursive: true, force: true });
    rmSync(`${profilesDir}.old`, { recursive: true, force: true });
    rmSync(`${profilesDir}.restoring`, { recursive: true, force: true });

    const localDb = new Database(join(dataDir, "hive.db"));
    const backup = backupNow(localDb, dataDir, "manual");
    assert.ok(backup.ok, backup.error);
    const snapshotName = listSnapshots(dataDir)[0].name;

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

describe("issue #41 round trip: all three restore verdicts pinned end to end", () => {
  it("case 1: restoring a store's first-ever snapshot writes a real success into the row, and reads healthy", () => {
    rmSync(backupsDir(dataDir), { recursive: true, force: true });
    const localDb = new Database(join(dataDir, "hive.db"));

    localDb.prepare(
      "UPDATE backup_meta SET last_attempt_at = NULL, last_success_at = NULL, last_error = NULL, last_error_at = NULL WHERE id = 1",
    ).run();
    const backup = backupNow(localDb, dataDir, "manual");
    assert.ok(backup.ok, backup.error);
    const snapshotName = listSnapshots(dataDir)[0].name;

    localDb
      .prepare(
        "UPDATE backup_meta SET last_success_at = NULL, last_attempt_at = NULL, last_error = 'poison', last_error_at = strftime('%Y-%m-%d %H:%M:%f', 'now') WHERE id = 1",
      )
      .run();

    localDb.close();
    restoreSnapshot(dataDir, snapshotName);

    const restored = new Database(join(dataDir, "hive.db"));

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

    const backup = backupNow(localDb, dataDir, "manual");
    assert.ok(backup.ok, backup.error);
    const snapshot = listSnapshots(dataDir)[0];

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

    localDb.prepare(
      "UPDATE backup_meta SET last_attempt_at = datetime('now', '-1 hours'), last_success_at = NULL, last_error = 'disk full', last_error_at = datetime('now', '-10 seconds') WHERE id = 1",
    ).run();

    const backup = backupNow(localDb, dataDir, "manual");
    assert.ok(backup.ok, backup.error);
    const snapshotName = listSnapshots(dataDir)[0].name;

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
