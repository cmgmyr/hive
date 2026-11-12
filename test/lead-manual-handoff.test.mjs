import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { describe, it } from "node:test";
import { scratchDirs } from "./helpers.mjs";

const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { db, MIGRATIONS } = await import("../dist/db.js");
if (!db.name.startsWith(dirs.dataDir)) throw new Error(`refusing: opened ${db.name}`);

function v48() {
  const prior = new Database(":memory:");
  prior.pragma("foreign_keys = ON");
  for (const migration of MIGRATIONS.slice(0, 48)) prior.exec(migration);
  const project = prior.prepare("INSERT INTO projects (name, path) VALUES ('handoff-migration', '/tmp/handoff-migration') RETURNING id").get().id;
  const rows = [];
  for (const [i, reason] of ["warn", "stop"].entries()) {
    const actor = `lead:migrate-${i}`;
    const lead = prior.prepare(
      `INSERT INTO agents (project_id, actor_id, name, kind, command, cwd) VALUES (?, ?, ?, 'lead', 'claude', '/tmp/handoff-migration') RETURNING id`,
    ).get(project, actor, actor).id;
    const values = Object.fromEntries(prior.prepare("PRAGMA table_info(lead_handoffs)").all().map((column) => [
      column.name, column.type === "INTEGER" ? 20 + i : `preserved-${column.name}-${i}`,
    ]));
    Object.assign(values, {
      id: 50 + i, project_id: project, lead_agent_id: lead, reason, request_reason: reason, state: "grace",
      grace_started_at: "2099-01-01 00:00:00", hold_released_at: null, updated_at: "2026-01-01 00:00:00",
    });
    const keys = Object.keys(values);
    prior.prepare(`INSERT INTO lead_handoffs (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`).run(...Object.values(values));
    rows.push(prior.prepare("SELECT * FROM lead_handoffs WHERE id = ?").get(values.id));
  }
  return { prior, project, rows };
}

function upgrade(prior) {
  assert.equal(typeof MIGRATIONS[48], "string", "migration 49 must be appended");
  prior.transaction(() => prior.exec(MIGRATIONS[48])).immediate();
}

const schemaObjects = (prior) => prior.prepare(
  "SELECT name, sql FROM sqlite_master WHERE name IN ('idx_lead_handoffs_epoch', 'idx_lead_handoffs_active', 'fence_handoff_held_claim') ORDER BY name",
).all();

describe("manual handoff migration 49", () => {
  it("preserves every column of warn and stop rows and the original indexes and fence", () => {
    const { prior, rows } = v48();
    try {
      const objects = schemaObjects(prior);
      assert.equal(objects.length, 3);
      upgrade(prior);
      assert.deepEqual(prior.prepare("SELECT * FROM lead_handoffs ORDER BY id").all(), rows);
      assert.deepEqual(schemaObjects(prior), objects);
      assert.deepEqual(prior.pragma("foreign_key_check"), []);
    } finally {
      prior.close();
    }
  });

  it("keeps active and epoch uniqueness and fences wake claims after the rebuild", () => {
    const { prior, project, rows } = v48();
    try {
      upgrade(prior);
      const first = rows[0];
      const insert = prior.prepare(`INSERT INTO lead_handoffs (project_id, lead_agent_id, pane_target, predecessor_pane_pid, predecessor_session_id, reason, state)
        VALUES (?, ?, '%1', ?, ?, 'manual', ?)`);
      assert.throws(() => insert.run(project, first.lead_agent_id, "new-pid", "new-session", "requested"), /UNIQUE constraint failed: lead_handoffs.lead_agent_id/);
      assert.throws(() => insert.run(project, first.lead_agent_id, first.predecessor_pane_pid, first.predecessor_session_id, "completed"), /UNIQUE constraint failed: lead_handoffs.project_id/);
      const actor = prior.prepare("SELECT actor_id FROM agents WHERE id = ?").get(first.lead_agent_id).actor_id;
      const wake = prior.prepare("INSERT INTO wakes (project_id, owner, body, kind, deliver_actor, deliver_pane) VALUES (?, ?, 'held', 'delay', ?, '%1') RETURNING id").get(project, actor, actor).id;
      assert.equal(prior.prepare("UPDATE wakes SET fire_count = fire_count + 1 WHERE id = ?").run(wake).changes, 0);
      assert.equal(prior.prepare("SELECT fire_count FROM wakes WHERE id = ?").get(wake).fire_count, 0);
      prior.prepare("UPDATE lead_handoffs SET state = 'completed' WHERE id = ?").run(first.id);
      assert.equal(prior.prepare("UPDATE wakes SET fire_count = fire_count + 1 WHERE id = ?").run(wake).changes, 1);
    } finally {
      prior.close();
    }
  });

  it("accepts manual in both reason columns and preserves the allocated id high-water mark", () => {
    const { prior, rows } = v48();
    try {
      prior.prepare("UPDATE sqlite_sequence SET seq = 900 WHERE name = 'lead_handoffs'").run();
      upgrade(prior);
      prior.prepare("UPDATE lead_handoffs SET state = 'completed' WHERE id = ?").run(rows[0].id);
      const inserted = prior.prepare(`INSERT INTO lead_handoffs (project_id, lead_agent_id, pane_target, predecessor_pane_pid, predecessor_session_id, reason, request_reason, state)
        VALUES (?, ?, '%1', 'manual-pid', 'manual-session', 'manual', 'manual', 'requested') RETURNING *`).get(rows[0].project_id, rows[0].lead_agent_id);
      assert.equal(inserted.id, 901);
      assert.equal(inserted.reason, "manual");
      assert.equal(inserted.request_reason, "manual");
      assert.equal(inserted.request_wake_id, null);
    } finally {
      prior.close();
    }
  });
});
