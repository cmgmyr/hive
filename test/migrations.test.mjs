import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { scratchDirs } from "./helpers.mjs";

const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { db, migrate, MIGRATIONS } = await import("../dist/db.js");

if (!db.name.startsWith(dirs.dataDir)) throw new Error(`refusing: opened ${db.name}`);

const LAST_INHERITED_NAME_VERSION = 27;

const objectSql = (type, name) =>
  db.prepare("SELECT sql FROM sqlite_master WHERE type = ? AND name = ?").get(type, name)?.sql ?? null;

const objectNames = (type) =>
  db
    .prepare("SELECT name FROM sqlite_master WHERE type = ? ORDER BY name")
    .all(type)
    .map((r) => r.name);

const appliedVersions = () =>
  db.prepare("SELECT COUNT(*) AS n FROM migrations").get().n;

function seedInheritedNameFixture() {
  db.exec(`CREATE TABLE IF NOT EXISTS migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  MIGRATIONS.slice(0, LAST_INHERITED_NAME_VERSION).forEach((sql, i) => {
    db.exec(sql);
    db.prepare("INSERT INTO migrations (version) VALUES (?)").run(i + 1);
  });

  assert.ok(
    objectSql("table", "scratchpads"),
    "MIGRATIONS.slice(0, LAST_INHERITED_NAME_VERSION) must end on the last schema that still names scratchpads",
  );
  assert.equal(
    objectSql("table", "pads"),
    null,
    "LAST_INHERITED_NAME_VERSION must name a version before the rename migration, not after it",
  );

  const projectId = db
    .prepare("INSERT INTO projects (name, path) VALUES (?, ?) RETURNING id")
    .get("rename-fixture", "/tmp/rename-fixture").id;
  db.prepare("INSERT INTO actors (id, name, kind) VALUES (?, ?, ?)").run(
    "actor:rename",
    "rename-fixture",
    "agent",
  );

  const pad = (name, content, revision, tags, archived, updatedBy) =>
    db
      .prepare(
        `INSERT INTO scratchpads (project_id, name, content, revision, tags, archived, updated_by, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
      )
      .get(projectId, name, content, revision, tags, archived, updatedBy, `2020-01-0${revision} 00:00:0${revision}`);

  const pads = [
    pad("alpha", "alpha body", 3, '["one"]', 0, "actor:rename"),
    pad("beta", "beta body", 7, '["two","three"]', 0, "lead:1"),
    pad("alpha", "archived alpha body", 2, "[]", 1, null),
  ];

  const leases = [
    db
      .prepare(
        `INSERT INTO locks (project_id, lock_key, owner, acquired_at, expires_at)
         VALUES (?, ?, ?, ?, ?) RETURNING *`,
      )
      .get(projectId, "file:src/db.ts", "actor:rename", "2020-02-01 00:00:00", "2099-01-01 00:00:00"),
    db
      .prepare(
        `INSERT INTO locks (project_id, lock_key, owner, acquired_at, expires_at)
         VALUES (?, ?, ?, ?, ?) RETURNING *`,
      )
      .get(projectId, "area:docs", "actor:rename", "2020-02-02 00:00:00", "2099-02-02 00:00:00"),
  ];

  const agentId = db
    .prepare(
      `INSERT INTO agents (project_id, actor_id, name, tmux_target, command, cwd, kind, status)
       VALUES (?, 'actor:rename', 'watched', '%1', 'claude', '/tmp/rename-fixture', 'agent', 'running')
       RETURNING id`,
    )
    .get(projectId).id;

  const wake = (body, kind, parent, dueAt) =>
    db
      .prepare(
        `INSERT INTO timers (project_id, owner, body, kind, watch, deliver_actor, deliver_pane,
                             due_at, parent_timer_id, fire_count)
         VALUES (?, 'actor:rename', ?, ?, '[]', 'actor:rename', '%1', ?, ?, ?) RETURNING *`,
      )
      .get(projectId, body, kind, dueAt, parent, parent === null ? 4 : 0);

  const parentWake = wake("parent body", "idle_all", null, "2099-03-01 00:00:00");
  const childWake = wake("child body", "delay", parentWake.id, "2099-03-02 00:00:00");
  const noticeWake = wake("notice body", "delay", null, "2099-03-03 00:00:00");

  const idleNotice = db
    .prepare(
      `INSERT INTO wake_idle_notices (timer_id, agent_id, condition, episode, notice_timer_id, notified_at)
       VALUES (?, ?, 'idle', 'ep-1', ?, '2020-03-01 00:00:00') RETURNING *`,
    )
    .get(parentWake.id, agentId, noticeWake.id);

  const blockNotice = db
    .prepare(
      `INSERT INTO wake_block_notices (timer_id, agent_id, blocked_since, notified_at)
       VALUES (?, ?, '2020-03-02 00:00:00', '2020-03-03 00:00:00') RETURNING *`,
    )
    .get(childWake.id, agentId);

  return {
    projectId,
    agentId,
    pads,
    leases,
    wakes: [parentWake, childWake, noticeWake],
    idleNotice,
    blockNotice,
  };
}

const fixture = seedInheritedNameFixture();

migrate();

const upgraded = {
  versions: appliedVersions(),
  tables: objectNames("table"),
  indexes: objectNames("index"),
  triggers: objectNames("trigger"),
  pads: db.prepare("SELECT * FROM pads ORDER BY id").all(),
  leases: db.prepare("SELECT * FROM leases ORDER BY lock_key").all(),
  wakes: db.prepare("SELECT * FROM wakes ORDER BY id").all(),
  idleNotices: db.prepare("SELECT * FROM wake_idle_notices").all(),
  blockNotices: db.prepare("SELECT * FROM wake_block_notices").all(),
  columns: (table) => db.prepare(`SELECT name FROM pragma_table_info(?)`).all(table).map((c) => c.name),
  foreignKeyViolations: db.prepare("PRAGMA foreign_key_check").all(),
};

migrate();

const reopened = {
  versions: appliedVersions(),
  pads: db.prepare("SELECT * FROM pads ORDER BY id").all(),
  wakes: db.prepare("SELECT * FROM wakes ORDER BY id").all(),
};

describe("a v27 store, whose tables still carry the inherited names, opened by this build", () => {
  it("renames scratchpads to pads and leaves no table under the old name", () => {
    assert.ok(upgraded.tables.includes("pads"));
    assert.ok(!upgraded.tables.includes("scratchpads"));
  });

  it("carries every pad row across with its own content, revision, tags, archived flag and stamps", () => {
    assert.equal(upgraded.pads.length, fixture.pads.length);
    for (const before of fixture.pads) {
      const after = upgraded.pads.find((r) => r.id === before.id);
      assert.deepEqual(after, before);
    }
  });

  it("recreates the two pad indexes under the new name with the same columns and partial predicate", () => {
    assert.ok(!upgraded.indexes.includes("idx_scratchpads_project"));
    assert.ok(!upgraded.indexes.includes("idx_scratchpads_active_name"));
    assert.match(objectSql("index", "idx_pads_project"), /ON pads\(project_id, archived, name\)/);
    assert.match(objectSql("index", "idx_pads_active_name"), /UNIQUE INDEX/);
    assert.match(objectSql("index", "idx_pads_active_name"), /ON pads\(project_id, name\)\s+WHERE archived = 0/);
  });

  it("still refuses a second active pad under a name another active pad already holds", () => {
    assert.throws(
      () =>
        db
          .prepare("INSERT INTO pads (project_id, name, content) VALUES (?, ?, ?)")
          .run(fixture.projectId, "alpha", "duplicate"),
      /UNIQUE/,
    );
  });

  it("recreates the content guard under the new name and leaves none under the old one", () => {
    assert.ok(!upgraded.triggers.includes("guard_scratchpads_content_update"));
    assert.ok(upgraded.triggers.includes("guard_pads_content_update"));
    assert.match(objectSql("trigger", "guard_pads_content_update"), /BEFORE UPDATE ON pads/);
    assert.match(objectSql("trigger", "guard_pads_content_update"), /pads\.content/);
  });

  it("aborts a content update that leaves updated_at unstamped and admits one that stamps it", () => {
    const target = fixture.pads[0].id;
    assert.throws(
      () => db.prepare("UPDATE pads SET content = ? WHERE id = ?").run("unstamped", target),
      /leaves updated_at unchanged/,
    );
    assert.equal(db.prepare("SELECT content FROM pads WHERE id = ?").get(target).content, "alpha body");

    db.prepare("UPDATE pads SET content = ?, updated_at = datetime('now') WHERE id = ?").run("stamped", target);
    assert.equal(db.prepare("SELECT content FROM pads WHERE id = ?").get(target).content, "stamped");
  });

  it("renames locks to leases, keeps lock_key, and carries every lease row across with its owner and stamps", () => {
    assert.ok(upgraded.tables.includes("leases"));
    assert.ok(!upgraded.tables.includes("locks"));
    assert.deepEqual(
      upgraded.leases,
      [...fixture.leases].sort((a, b) => a.lock_key.localeCompare(b.lock_key)),
    );
  });

  it("renames timers to wakes and carries every wake row across with its body, kind, due time and fire count", () => {
    assert.ok(upgraded.tables.includes("wakes"));
    assert.ok(!upgraded.tables.includes("timers"));
    assert.equal(upgraded.wakes.length, fixture.wakes.length);
    for (const before of fixture.wakes) {
      const after = upgraded.wakes.find((r) => r.id === before.id);
      const { parent_timer_id: parent, ...rest } = before;
      assert.deepEqual(after, { ...rest, parent_wake_id: parent });
    }
  });

  it("renames every column that points at a wake, including notice_timer_id, which the objective's list omitted", () => {
    assert.deepEqual(
      upgraded.columns("wakes").filter((c) => /timer/.test(c)),
      [],
    );
    assert.ok(upgraded.columns("wakes").includes("parent_wake_id"));
    assert.deepEqual(upgraded.columns("wake_idle_notices").filter((c) => /timer/.test(c)), []);
    assert.ok(upgraded.columns("wake_idle_notices").includes("wake_id"));
    assert.ok(upgraded.columns("wake_idle_notices").includes("notice_wake_id"));
    assert.deepEqual(upgraded.columns("wake_block_notices").filter((c) => /timer/.test(c)), []);
    assert.ok(upgraded.columns("wake_block_notices").includes("wake_id"));
  });

  it("keeps each notice pointing at the same wake and agent it was written against", () => {
    assert.equal(upgraded.idleNotices.length, 1);
    assert.deepEqual(upgraded.idleNotices[0], {
      wake_id: fixture.idleNotice.timer_id,
      agent_id: fixture.idleNotice.agent_id,
      condition: fixture.idleNotice.condition,
      episode: fixture.idleNotice.episode,
      notice_wake_id: fixture.idleNotice.notice_timer_id,
      notified_at: fixture.idleNotice.notified_at,
    });
    assert.equal(upgraded.blockNotices.length, 1);
    assert.deepEqual(upgraded.blockNotices[0], {
      wake_id: fixture.blockNotice.timer_id,
      agent_id: fixture.blockNotice.agent_id,
      blocked_since: fixture.blockNotice.blocked_since,
      notified_at: fixture.blockNotice.notified_at,
    });
  });

  it("recreates the two wake indexes under the new name with the same columns and partial predicates", () => {
    assert.ok(!upgraded.indexes.includes("idx_timers_active"));
    assert.ok(!upgraded.indexes.includes("idx_timers_parent"));
    assert.match(objectSql("index", "idx_wakes_active"), /ON wakes\(project_id, kind\)\s+WHERE cancelled_at IS NULL/);
    assert.match(
      objectSql("index", "idx_wakes_parent"),
      /ON wakes\(parent_wake_id\) WHERE parent_wake_id IS NOT NULL/,
    );
  });

  it("leaves no live table, index, trigger or column still carrying an inherited name", () => {
    const live = db
      .prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'")
      .all();
    const offenders = live.filter((o) => /\b(scratchpads|locks|timers)\b|_timer_id\b|\btimer_id\b/.test(o.sql ?? o.name));
    assert.deepEqual(offenders, []);
  });

  it("leaves no foreign key pointing at a table that no longer exists under its old name", () => {
    assert.deepEqual(upgraded.foreignKeyViolations, []);
  });

  it("records the rename once, so a second open applies nothing and rewrites no row", () => {
    assert.equal(reopened.versions, upgraded.versions);
    assert.equal(upgraded.versions, MIGRATIONS.length);
    assert.deepEqual(reopened.pads, upgraded.pads);
    assert.deepEqual(reopened.wakes, upgraded.wakes);
  });
});

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
