import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { after, before, describe, it } from "node:test";

import { assertScratchStore, clearHiveEnv, isolateTmux, scratchDirs } from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("the backup/tick containment test");
const { dataDir, projectDir } = scratchDirs();

clearHiveEnv();
process.env.HIVE_DATA_DIR = dataDir;

await assertScratchStore();

const { db, migrate } = await import("../dist/db.js");
const { tick } = await import("../dist/scheduler.js");
const { backupsDir } = await import("../dist/backup.js");
migrate();

const session = `hive-backup-tick-${process.pid}`;
let pane;

before(() => {
  if (!hasTmux) return;
  execFileSync("tmux", ["new-session", "-d", "-s", session, "sleep 600"], { stdio: "ignore" });
  pane = execFileSync("tmux", ["list-panes", "-t", `=${session}`, "-F", "#{pane_id}"], { encoding: "utf8" })
    .trim()
    .split("\n")[0];
});

after(() => cleanup(session));

describe("tick() delivers a due wake-up even when the backup path is broken", () => {
  it("fires the timer and records the backup failure, in the same tick", async () => {
    if (!hasTmux) return;

    const project = db
      .prepare("INSERT INTO projects (name, path) VALUES (?, ?) RETURNING id")
      .get("backup-tick-test", projectDir).id;
    const timerId = db
      .prepare(
        `INSERT INTO wakes (project_id, owner, body, kind, watch, deliver_actor, deliver_pane,
           due_at, created_at)
         VALUES (?, 'user:test', 'wake body', 'delay', '[]', 'user:test', ?,
           datetime('now', '-5 seconds'), datetime('now', '-60 seconds'))
         RETURNING id`,
      )
      .get(project, pane).id;

    db.prepare(
      "UPDATE backup_meta SET last_attempt_at = NULL, last_success_at = NULL, last_error = NULL, last_error_at = NULL WHERE id = 1",
    ).run();
    const backupsPath = backupsDir(dataDir);
    rmSync(backupsPath, { recursive: true, force: true });
    writeFileSync(backupsPath, "not a directory");

    await tick();

    const row = db.prepare("SELECT fired_at FROM wakes WHERE id = ?").get(timerId);
    assert.ok(row.fired_at, "a due wake-up must still fire when the backup path is broken");

    const meta = db.prepare("SELECT last_error FROM backup_meta WHERE id = 1").get();
    assert.ok(meta.last_error, "the backup attempt in this tick must have genuinely failed, not been skipped");

    rmSync(backupsPath, { force: true });
  });
});
