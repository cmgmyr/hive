import assert from "node:assert/strict";
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
const before = {
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
    const { model, extra_args: extraArgs, claude_messaging_socket: socket, claude_messaging_pane_pid: socketPid, ...rest } = after;
    assert.deepEqual(rest, before.agent);
    assert.equal(model, null);
    assert.equal(extraArgs, null);
    assert.equal(socket, "");
    assert.equal(socketPid, "");
  });

  it("adds the socket delivery columns to wakes, null on rows written before them", () => {
    const columns = db.prepare("SELECT name FROM pragma_table_info('wakes')").all().map((c) => c.name);
    for (const name of ["delivery_method", "socket_attempt_at", "socket_delivery_note"]) assert.ok(columns.includes(name), name);
  });
});
