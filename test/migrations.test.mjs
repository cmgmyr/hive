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
