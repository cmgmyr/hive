import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { REPO, scratchDirs } from "./helpers.mjs";

const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { db, migrate, MIGRATIONS } = await import("../dist/db.js");

if (!db.name.startsWith(dirs.dataDir)) throw new Error(`refusing: opened ${db.name}`);

const V30_STORE = join(REPO, "test", "fixtures", "store-v30.sql");

db.exec(readFileSync(V30_STORE, "utf8"));
const projectId = db
  .prepare("INSERT INTO projects (name, path) VALUES (?, ?) RETURNING id")
  .get("v30-fixture", "/tmp/v30-fixture").id;
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

  it("ends with agents.model and agents.extra_args", () => {
    assert.ok(agentColumns.includes("model"));
    assert.ok(agentColumns.includes("extra_args"));
  });

  it("creates an empty queen audit table and does not duplicate it on a second migration", () => {
    assert.deepEqual(db.prepare("SELECT * FROM queen_audit").all(), []);
    const columns = db.prepare("SELECT name FROM pragma_table_info('queen_audit')").all().map((c) => c.name);
    assert.deepEqual(columns, ["id", "actor_id", "home_project_id", "target_project_id", "operation", "resource_type", "resource_id", "summary", "created_at"]);
    migrate();
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM migrations").get().n, MIGRATIONS.length);
    assert.deepEqual(db.prepare("SELECT * FROM queen_audit").all(), []);
  });

  it("keeps the pre-existing agent row, reading its new launch-flag columns as null", () => {
    const after = db.prepare("SELECT * FROM agents WHERE id = ?").get(agentId);
    const { model, extra_args: extraArgs, claude_messaging_socket: socket, claude_messaging_pane_pid: socketPid, todo_id: todoId, ...rest } = after;
    assert.deepEqual(rest, before.agent);
    assert.equal(model, null);
    assert.equal(extraArgs, null);
    assert.equal(socket, "");
    assert.equal(socketPid, "");
    assert.equal(todoId, null);
  });

  it("adds the socket delivery columns to wakes, null on rows written before them", () => {
    const columns = db.prepare("SELECT name FROM pragma_table_info('wakes')").all().map((c) => c.name);
    for (const name of ["delivery_method", "socket_attempt_at", "socket_delivery_note", "delivered_by"]) assert.ok(columns.includes(name), name);
  });

  it("appending delivered_by leaves a pre-existing wake unchanged", () => {
    const prior = new Database(join(dirs.dataDir, "pre-delivered-by.db"));
    try {
      prior.pragma("foreign_keys = ON");
      prior.exec("CREATE TABLE migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))");
      for (const [index, migration] of MIGRATIONS.slice(0, -1).entries()) {
        prior.exec(migration);
        prior.prepare("INSERT INTO migrations (version) VALUES (?)").run(index + 1);
      }
      const legacyProject = prior.prepare("INSERT INTO projects (name, path) VALUES ('legacy-wake', '/tmp/legacy-wake') RETURNING id").get().id;
      const legacyWake = prior.prepare(
        `INSERT INTO wakes (project_id, owner, body, kind, watch, deliver_actor, deliver_pane, due_at, fired_at, fire_count)
         VALUES (?, 'user:legacy', 'old wake body', 'delay', '[]', 'user:legacy', '%1', datetime('now'), datetime('now'), 1)
         RETURNING id`,
      ).get(legacyProject).id;
      const beforeWake = prior.prepare("SELECT * FROM wakes WHERE id = ?").get(legacyWake);
      prior.exec(MIGRATIONS.at(-1));
      const afterWake = prior.prepare("SELECT * FROM wakes WHERE id = ?").get(legacyWake);
      assert.deepEqual(
        Object.fromEntries(Object.keys(beforeWake).map((key) => [key, afterWake[key]])),
        beforeWake,
        "the appended column leaves existing wake fields unchanged",
      );
      assert.equal(afterWake.delivered_by, null, "pre-existing wakes have no server identity");
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
