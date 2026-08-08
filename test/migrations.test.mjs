import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { scratchDirs } from "./helpers.mjs";

// The one path in the name-uniqueness work the rest of the suite cannot see:
// what a store that ALREADY holds duplicate running names does when the
// unique index arrives. Creating that index over violating rows fails, so the
// migration renames the losers first, and a failure here would surface as a
// store that cannot be opened at all.
//
// db.js resolves its file from HIVE_DATA_DIR at import time, so point it at a
// scratch dir before the dynamic import. No tmux, no server, no agents: this
// is the schema on its own.
const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { db, migrate } = await import("../dist/db.js");

const INDEX = "idx_agents_running_name";

// The version in MIGRATIONS that creates INDEX. Pinned by number rather than
// found with MAX(version), which is what this used to do and which quietly
// meant "whatever migration was added most recently". The next migration to
// land broke all three tests here: the rewind forgot THAT version instead,
// migrate() replayed its CREATE TABLE against a table that was still there, and
// the index this file exists to test was never recreated. Migrations are
// append-only, so a version number is a stable handle and MAX is not.
const NAME_INDEX_VERSION = 5;

// Rewind to the state a store was in before that migration existed. It adds
// exactly one index and mutates data, so dropping the index and forgetting the
// version reproduces the old store faithfully. Rewinding beats hand-writing the
// old schema, which would silently drift from db.ts.
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
    // Differs only by case, which the index folds together, so it is a
    // duplicate too even though a plain string comparison says otherwise.
    const shouty = seedAgent(first, "DUP");
    seedAgent(first, "solo");
    // A closed row by a running row's name is not a conflict; the index is
    // partial for exactly this reason.
    seedAgent(first, "solo", "closed");
    // Names are unique per project, not per store.
    seedAgent(second, "dup");

    migrate();

    assert.deepEqual(names(first), [
      "dup:running",
      `dup-${loser}:running`,
      `DUP-${shouty}:running`,
      "solo:running",
      "solo:closed",
    ]);
    // The lowest id keeps the name it was spawned with; a lead's muscle
    // memory for the original worker still lands on the original worker.
    assert.equal(db.prepare("SELECT name FROM agents WHERE id = ?").get(keeper).name, "dup");
    // The other project is untouched: it never violated anything.
    assert.deepEqual(names(second), ["dup:running"]);
  });

  it("leaves the index in place and enforcing", () => {
    const indexed = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?").get(INDEX);
    assert.ok(indexed, `${INDEX} should exist after the migration`);
    assert.throws(() => seedAgent(first, "solo"), /UNIQUE/);
    assert.throws(() => seedAgent(first, "SOLO"), /UNIQUE/);
    // The renamed rows are addressable again rather than colliding forever.
    assert.doesNotThrow(() => seedAgent(first, "dup-fresh"));
  });

  it("is idempotent, so a second open does not rename anything again", () => {
    const before = names(first);
    migrate();
    assert.deepEqual(names(first), before);
  });
});

// Issue #15, counselors round: without this, the suite would pass exactly as
// well if archived_at had been added by EDITING migration 1 and omitting the
// v11 entry entirely - fine for a fresh scratch store (which is all every
// other test here uses), even though every real v10 store would then never
// gain the column at all. This is the append-only invariant itself, pinned.
const ARCHIVED_AT_VERSION = 11;

// Same rewind technique as rewindOneMigration above, applied to an ADD
// COLUMN instead of a CREATE INDEX: drop the column (DROP COLUMN needs
// SQLite 3.35+; better-sqlite3 here bundles 3.53) and forget the version, so
// the next migrate() call replays the exact ALTER TABLE a real v10 store
// would run, rather than a hand-written approximation that could drift from
// db.ts.
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
    // Every other column on the pre-existing row survives untouched - the
    // append-only invariant itself: v11 must be purely additive, not a
    // rewrite of a row's own data.
    assert.equal(after.id, before.id);
    assert.equal(after.title, before.title);
    assert.equal(after.body, before.body);
    assert.equal(after.priority, before.priority);
    assert.equal(after.status, before.status);
    assert.equal(after.created_at, before.created_at);

    // Not MAX(version): that only ever meant "v11 was applied" while v11
    // happened to be the newest migration that existed. Todo 309 added a
    // v12 (dashboard_meta) that this rewind never touches - v12 stays
    // recorded as applied throughout, so MAX(version) reads 12 here
    // regardless of whether v11's own replay worked, and would keep reading
    // as whatever the newest migration is forever after, silently stopping
    // this assertion from checking anything. What the test actually means -
    // v11 itself got applied via its own real replay, not skipped - is a
    // membership check, not a maximum.
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
