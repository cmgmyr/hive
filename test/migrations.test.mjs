import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { scratchDirs } from "./helpers.mjs";

const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { db, migrate } = await import("../dist/db.js");

const INDEX = "idx_agents_running_name";

const NAME_INDEX_VERSION = 5;

function rewindOneMigration() {
  migrate();
  assert.ok(
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?").get(INDEX),
    `${INDEX} must exist before the rewind, or NAME_INDEX_VERSION names the wrong migration`,
  );
  db.exec(`DROP INDEX IF EXISTS ${INDEX}`);
  db.prepare("DELETE FROM migrations WHERE version = ?").run(NAME_INDEX_VERSION);
}

function seedProject(path) {
  db.prepare("INSERT INTO projects (name, path) VALUES (?, ?)").run("p", path);
  return db.prepare("SELECT id FROM projects WHERE path = ?").get(path).id;
}

function seedAgent(projectId, name, status = "running") {
  return db
    .prepare(
      `INSERT INTO agents (project_id, actor_id, name, tmux_target, command, cwd, kind, status)
       VALUES (?, '', ?, '', 'sleep 600', '/tmp', 'agent', ?)`,
    )
    .run(projectId, name, status).lastInsertRowid;
}

const names = (projectId) =>
  db
    .prepare("SELECT id, name, status FROM agents WHERE project_id = ? ORDER BY id")
    .all(projectId)
    .map((r) => `${r.name}:${r.status}`);

describe("the running-name unique index arriving on a store that violates it", () => {
  let first;
  let second;

  it("renames the duplicates instead of failing to apply", () => {
    rewindOneMigration();
    first = seedProject("/tmp/one");
    second = seedProject("/tmp/two");

    const keeper = seedAgent(first, "dup");
    const loser = seedAgent(first, "dup");

    const shouty = seedAgent(first, "DUP");
    seedAgent(first, "solo");

    seedAgent(first, "solo", "closed");

    seedAgent(second, "dup");

    migrate();

    assert.deepEqual(names(first), [
      "dup:running",
      `dup-${loser}:running`,
      `DUP-${shouty}:running`,
      "solo:running",
      "solo:closed",
    ]);

    assert.equal(db.prepare("SELECT name FROM agents WHERE id = ?").get(keeper).name, "dup");

    assert.deepEqual(names(second), ["dup:running"]);
  });

  it("leaves the index in place and enforcing", () => {
    const indexed = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?").get(INDEX);
    assert.ok(indexed, `${INDEX} should exist after the migration`);
    assert.throws(() => seedAgent(first, "solo"), /UNIQUE/);
    assert.throws(() => seedAgent(first, "SOLO"), /UNIQUE/);

    assert.doesNotThrow(() => seedAgent(first, "dup-fresh"));
  });

  it("is idempotent, so a second open does not rename anything again", () => {
    const before = names(first);
    migrate();
    assert.deepEqual(names(first), before);
  });
});

const ARCHIVED_AT_VERSION = 11;

function rewindArchivedAt() {
  migrate();
  assert.ok(
    db.prepare("SELECT 1 FROM pragma_table_info('todos') WHERE name = 'archived_at'").get(),
    "todos.archived_at must exist before the rewind, or ARCHIVED_AT_VERSION names the wrong migration",
  );
  db.exec("ALTER TABLE todos DROP COLUMN archived_at");
  db.prepare("DELETE FROM migrations WHERE version = ?").run(ARCHIVED_AT_VERSION);
}

describe("issue #15: archived_at arriving on a v10 store", () => {
  it("adds the column and leaves every existing row's own data untouched", () => {
    rewindArchivedAt();

    const projectId = seedProject("/tmp/archived-at-upgrade");
    db.prepare(
      "INSERT INTO todos (project_id, title, body, priority, status) VALUES (?, ?, ?, ?, ?)",
    ).run(projectId, "pre-existing todo", "written before the upgrade", "high", "in_progress");
    const before = db.prepare("SELECT * FROM todos WHERE project_id = ?").get(projectId);

    migrate();

    const cols = db.prepare("PRAGMA table_info(todos)").all().map((c) => c.name);
    assert.ok(cols.includes("archived_at"), "archived_at must exist after migrating from v10");

    const after = db.prepare("SELECT * FROM todos WHERE project_id = ?").get(projectId);
    assert.equal(after.archived_at, null, "a pre-existing row must read as not-archived, never backfilled");

    assert.equal(after.id, before.id);
    assert.equal(after.title, before.title);
    assert.equal(after.body, before.body);
    assert.equal(after.priority, before.priority);
    assert.equal(after.status, before.status);
    assert.equal(after.created_at, before.created_at);

    assert.ok(
      db.prepare("SELECT 1 FROM migrations WHERE version = ?").get(ARCHIVED_AT_VERSION),
      "the migrations table must record v11 as applied, not skip past it",
    );
  });

  it("is idempotent, so a second open neither drops nor duplicates the column", () => {
    migrate();
    const before = db.prepare("PRAGMA table_info(todos)").all().filter((c) => c.name === "archived_at");
    assert.equal(before.length, 1);
    migrate();
    const after = db.prepare("PRAGMA table_info(todos)").all().filter((c) => c.name === "archived_at");
    assert.equal(after.length, 1);
  });
});
