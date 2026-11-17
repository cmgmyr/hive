import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { assertScratchStore, REPO, scratchDirs } from "./helpers.mjs";

const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { db, migrate, MIGRATIONS } = await import("../dist/db.js");
await assertScratchStore();

if (!db.name.startsWith(dirs.dataDir)) throw new Error(`refusing: opened ${db.name}`);

const V30_STORE = join(REPO, "test", "fixtures", "store-v30.sql");

db.exec(readFileSync(V30_STORE, "utf8"));
const projectId = db
  .prepare("INSERT INTO projects (name, path) VALUES (?, ?) RETURNING id")
  .get("v30-fixture", "/tmp/v30-fixture").id;
db.prepare("INSERT OR IGNORE INTO actors (id, name, kind) VALUES ('actor:v30', 'shipped', 'agent')").run();
const agentId = db
  .prepare(
    `INSERT INTO agents (project_id, actor_id, name, tmux_target, command, cwd, kind, status)
     VALUES (?, 'actor:v30', 'shipped', '%1', 'claude', '/tmp/v30-fixture', 'agent', 'running')
     RETURNING id`,
  )
  .get(projectId).id;
const messageId = db
  .prepare(
    `INSERT INTO agent_messages (project_id, from_actor, from_name, to_agent_id, text)
     VALUES (?, 'actor:v30', 'shipped', ?, 'a pointer row written before delivery metadata') RETURNING id`,
  )
  .get(projectId, agentId).id;
const insertWake = db.prepare(
  `INSERT INTO wakes (project_id, owner, body, kind, deliver_actor, deliver_pane, due_at, fired_at, repeat_every_ms, fire_count)
   VALUES (?, 'actor:v30', ?, 'delay', 'actor:v30', '%1', ?, ?, ?, ?) RETURNING id`,
);
const legacyWakeIds = [
  insertWake.get(projectId, "pending one-shot", "2026-11-16 19:00:00", null, null, 0).id,
  insertWake.get(projectId, "fired one-shot", "2026-11-14 19:00:00", "2026-11-14 19:00:01", null, 1).id,
  insertWake.get(projectId, "fired interval", "2026-11-14 19:00:00", "2026-11-14 19:00:01", 86_400_000, 1).id,
];
const beforeWakes = db
  .prepare(`SELECT * FROM wakes WHERE id IN (${legacyWakeIds.map(() => "?").join(",")}) ORDER BY id`)
  .all(...legacyWakeIds);
db.prepare("INSERT INTO leases (project_id, lock_key, owner, expires_at) VALUES (?, 'legacy-migration-lease', 'actor:v30', '2099-01-01 00:00:00')")
  .run(projectId);
const beforeLease = db.prepare("SELECT * FROM leases WHERE project_id = ? AND lock_key = 'legacy-migration-lease'").get(projectId);
const before = {
  message: db.prepare("SELECT * FROM agent_messages WHERE id = ?").get(messageId),
  versions: db.prepare("SELECT MAX(version) AS v FROM migrations").get().v,
  agent: db.prepare("SELECT * FROM agents WHERE id = ?").get(agentId),
};

migrate();

const agentColumns = db.prepare("SELECT name FROM pragma_table_info('agents')").all().map((c) => c.name);

describe("a store at the v30 head shipped before todo 920, opened by this build", () => {
  it("starts from the v30 fixture, not an empty or already-current store", () => {
    assert.equal(before.versions, 30);
    assert.ok(!("model" in before.agent));
  });

  it("migrates forward to this build's head and records every version once", () => {
    const versions = db.prepare("SELECT version FROM migrations ORDER BY version").all().map((r) => r.version);
    assert.deepEqual(versions, MIGRATIONS.map((_, i) => i + 1));
  });

  it("adds a per-agent usage-limit episode table without modifying worker state columns", () => {
    assert.deepEqual(db.prepare("SELECT * FROM agent_usage_limits").all(), []);
    const columns = db.prepare("SELECT name FROM pragma_table_info('agent_usage_limits')").all().map((c) => c.name);
    assert.deepEqual(columns, [
      "agent_id", "project_id", "harness", "pane_pid", "session_id", "signal_key", "observed_at",
      "reset_at", "expires_at", "released_at", "continue_claimed_at",
    ]);
    assert.ok(db.prepare("SELECT agent_state FROM agents WHERE id = ?").get(agentId));
    assert.deepEqual(db.prepare("SELECT * FROM agent_state_log WHERE actor_id = 'agent:v30'").all(), []);
  });

  it("ends with agents.model, agents.extra_args, nullable pane_started_at and an empty recovery marker", () => {
    assert.ok(agentColumns.includes("model"));
    assert.ok(agentColumns.includes("extra_args"));
    const paneStartedAt = db.prepare("PRAGMA table_info(agents)").all().find((column) => column.name === "pane_started_at");
    assert.ok(paneStartedAt);
    assert.equal(paneStartedAt.notnull, 0);
    const recoveryState = db.prepare("PRAGMA table_info('agents')").all().find((column) => column.name === "recovery_state");
    assert.ok(recoveryState);
    assert.equal(recoveryState.notnull, 1);
    assert.equal(db.prepare("SELECT recovery_state FROM agents WHERE id = ?").get(agentId).recovery_state, "");
  });

  it("creates an empty queen audit table and does not duplicate it on a second migration", () => {
    assert.deepEqual(db.prepare("SELECT * FROM queen_audit").all(), []);
    const columns = db.prepare("SELECT name FROM pragma_table_info('queen_audit')").all().map((c) => c.name);
    assert.deepEqual(columns, ["id", "actor_id", "home_project_id", "target_project_id", "operation", "resource_type", "resource_id", "summary", "created_at", "outcome", "problem"]);
    migrate();
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM migrations").get().n, MIGRATIONS.length);
    assert.deepEqual(db.prepare("SELECT * FROM queen_audit").all(), []);
  });

  it("migration 51 adds an empty unique FIFO queue and preserves legacy leases and wakes", () => {
    assert.deepEqual(db.prepare("SELECT * FROM lease_waiters").all(), []);
    const columns = db.prepare("SELECT name FROM pragma_table_info('lease_waiters') ORDER BY cid").all().map((c) => c.name);
    assert.deepEqual(columns, ["id", "project_id", "lock_key", "actor_id", "agent_id", "ttl_seconds", "queued_at", "max_wait_at"]);
    assert.deepEqual(db.prepare("SELECT * FROM leases WHERE project_id = ? AND lock_key = 'legacy-migration-lease'").get(projectId), beforeLease);
    const afterWakes = db.prepare(`SELECT * FROM wakes WHERE id IN (${legacyWakeIds.map(() => "?").join(",")}) ORDER BY id`).all(...legacyWakeIds);
    assert.deepEqual(afterWakes.map((row) => Object.fromEntries(Object.keys(beforeWakes[0]).map((key) => [key, row[key]]))), beforeWakes);
    const insertWaiter = db.prepare("INSERT INTO lease_waiters (project_id, lock_key, actor_id, agent_id, ttl_seconds, max_wait_at) VALUES (?, 'dup', 'actor:v30', ?, 10, datetime('now', '+1 hour'))");
    insertWaiter.run(projectId, agentId);
    assert.throws(() => insertWaiter.run(projectId, agentId), /UNIQUE constraint failed/);
  });

  it("adds an empty questions table whose pending refs are unique and whose other states are not", () => {
    assert.deepEqual(db.prepare("SELECT * FROM questions").all(), []);
    const insert = db.prepare(
      `INSERT INTO questions (project_id, asker, kind, question, header, default_answer, ref_kind, ref_number, state, updated_by)
       VALUES (?, 'actor:v30', 'free_text', 'q', 'h', 'd', 'todo', 7, ?, 'actor:v30')`,
    );
    insert.run(projectId, "pending");
    assert.throws(() => insert.run(projectId, "pending"), /UNIQUE/);
    insert.run(projectId, "defaulted");
    insert.run(projectId, "defaulted");
    migrate();
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM questions").get().n, 3, "a second migration leaves question rows alone");
    db.prepare("DELETE FROM questions").run();
  });

  it("keeps the pre-existing agent row, reading its new launch-flag columns as null", () => {
    const after = db.prepare("SELECT * FROM agents WHERE id = ?").get(agentId);
    const {
      model,
      extra_args: extraArgs,
      claude_messaging_socket: socket,
      claude_messaging_pane_pid: socketPid,
      todo_id: todoId,
      pane_started_at: paneStartedAt,
      recovery_state: recoveryState,
      forked_from_agent_id: forkedFromAgentId,
      forked_from_session_id: forkedFromSessionId,
      ...rest
    } = after;
    assert.deepEqual(rest, before.agent);
    assert.equal(model, null);
    assert.equal(extraArgs, null);
    assert.equal(socket, "");
    assert.equal(socketPid, "");
    assert.equal(todoId, null);
    assert.equal(paneStartedAt, null);
    assert.equal(recoveryState, "");
    assert.equal(forkedFromAgentId, null);
    assert.equal(forkedFromSessionId, "");
  });

  it("adds the socket delivery columns to wakes, null on rows written before them", () => {
    const columns = db.prepare("SELECT name FROM pragma_table_info('wakes')").all().map((c) => c.name);
    for (const name of ["delivery_method", "socket_attempt_at", "socket_delivery_note", "delivered_by"]) assert.ok(columns.includes(name), name);
  });

  it("migration 50 preserves v30 pending and fired wake rows with null clock fields", () => {
    const afterWakes = db
      .prepare(`SELECT * FROM wakes WHERE id IN (${legacyWakeIds.map(() => "?").join(",")}) ORDER BY id`)
      .all(...legacyWakeIds);
    assert.deepEqual(
      afterWakes.map((row) => Object.fromEntries(Object.keys(beforeWakes[0]).map((key) => [key, row[key]]))),
      beforeWakes,
    );
    assert.deepEqual(afterWakes.map(({ clock_at, clock_zone, clock_repeat }) => [clock_at, clock_zone, clock_repeat]), [
      [null, null, null],
      [null, null, null],
      [null, null, null],
    ]);
    migrate();
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM migrations").get().n, MIGRATIONS.length);
    assert.deepEqual(
      db.prepare(`SELECT * FROM wakes WHERE id IN (${legacyWakeIds.map(() => "?").join(",")}) ORDER BY id`).all(...legacyWakeIds),
      afterWakes,
    );
  });

  it("migration 48 adds lineage columns without changing pre-existing agent data", () => {
    const prior = new Database(join(dirs.dataDir, "pre-fork-lineage.db"));
    try {
      prior.pragma("foreign_keys = ON");
      prior.exec("CREATE TABLE migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))");
      for (const [index, migration] of MIGRATIONS.slice(0, 47).entries()) {
        prior.exec(migration);
        prior.prepare("INSERT INTO migrations (version) VALUES (?)").run(index + 1);
      }
      const legacyProject = prior.prepare("INSERT INTO projects (name, path) VALUES ('legacy-fork', '/tmp/legacy-fork') RETURNING id").get().id;
      const legacyAgent = prior.prepare(
        `INSERT INTO agents (project_id, actor_id, name, command, cwd, kind, session_id)
         VALUES (?, 'agent:legacy', 'legacy', 'claude', '/tmp/legacy-fork', 'agent', 'legacy-session') RETURNING id`,
      ).get(legacyProject).id;
      const beforeAgent = prior.prepare("SELECT * FROM agents WHERE id = ?").get(legacyAgent);
      prior.exec(MIGRATIONS[47]);
      const afterAgent = prior.prepare("SELECT * FROM agents WHERE id = ?").get(legacyAgent);
      const { forked_from_agent_id: forkedFromAgentId, forked_from_session_id: forkedFromSessionId, ...rest } = afterAgent;
      assert.deepEqual(
        rest,
        beforeAgent,
        "the appended lineage columns leave every existing agent field unchanged",
      );
      assert.equal(forkedFromAgentId, null);
      assert.equal(forkedFromSessionId, "");
    } finally {
      prior.close();
    }
  });

  it("delivery columns migrate forward as null without changing existing message text", () => {
    const after = db.prepare("SELECT * FROM agent_messages WHERE id = ?").get(messageId);
    const fields = ["delivery_status", "delivery_method", "socket_attempt_at", "confirmed_at", "fallback_claimed_at",
      "typed_at", "delivery_note", "target_identity", "sender_tag"];
    const rest = { ...after };
    for (const field of fields) {
      assert.ok(field in after, field);
      assert.equal(after[field], null, field);
      delete rest[field];
    }
    assert.deepEqual(rest, before.message);
  });
});
