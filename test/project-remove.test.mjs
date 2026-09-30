import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { describe, it } from "node:test";
import { assertScratchStore, clearHiveEnv, isolateTmux, scratchDirs } from "./helpers.mjs";

isolateTmux("the project-remove tests");
clearHiveEnv();

const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
await assertScratchStore();
const { db, migrate } = await import("../dist/db.js");
migrate();
const { removeProject, projectRowCounts, PROJECT_OWNER_TABLES } = await import("../dist/projectRemove.js");

function seedProject(name, { agentStatus = "closed" } = {}) {
  const p = db.prepare("INSERT INTO projects (name, path) VALUES (?, ?) RETURNING id").get(name, `/nowhere/${name}`).id;
  db.prepare("INSERT OR IGNORE INTO actors (id, name, kind) VALUES ('actor:rm', 'rm', 'agent')").run();
  db.prepare("INSERT INTO pads (project_id, name) VALUES (?, 'x')").run(p);
  const todo = db.prepare("INSERT INTO todos (project_id, title) VALUES (?, 'x') RETURNING id").get(p).id;
  db.prepare("INSERT INTO todo_comments (todo_id, author, body) VALUES (?, 'actor:rm', 'x')").run(todo);
  db.prepare("INSERT INTO kv (project_id, key, value) VALUES (?, 'k', 'v')").run(p);
  db.prepare("INSERT INTO leases (project_id, lock_key, owner, expires_at) VALUES (?, 'k', 'actor:rm', datetime('now', '+1 day'))").run(p);
  const agent = db
    .prepare("INSERT INTO agents (project_id, name, command, cwd, status) VALUES (?, 'x', 'sleep', '/tmp', ?) RETURNING id")
    .get(p, agentStatus).id;
  const wake = db
    .prepare("INSERT INTO wakes (project_id, owner, body, deliver_actor, deliver_pane) VALUES (?, 'x', 'x', 'x', 'x') RETURNING id")
    .get(p).id;
  db.prepare("INSERT INTO command_trust (project_id, name, config_hash) VALUES (?, 'x', 'x')").run(p);
  db.prepare("INSERT INTO agent_messages (project_id, from_actor, from_name, to_agent_id, text) VALUES (?, 'a', 'a', ?, 'x')").run(p, agent);
  db.prepare("INSERT INTO lead_idle_subscriptions (wake_id, target_project_id, agent_id, pane_pid) VALUES (?, ?, ?, '1')").run(wake, p, agent);
  return p;
}

const naming = (table, col, p) => db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${col} = ?`).get(p).n;

describe("removeProject", () => {
  it("removes a project owning rows in every table, leaves queen_audit, and snapshots first", () => {
    const keep = seedProject("keep");
    const gone = seedProject("gone");
    db.prepare(
      "INSERT INTO queen_audit (actor_id, home_project_id, target_project_id, operation, resource_type, resource_id, summary) VALUES ('q', ?, ?, 'todo_create', 'todo', 1, 's')",
    ).run(keep, gone);

    const counts = projectRowCounts(gone);
    for (const t of [...PROJECT_OWNER_TABLES, "todo_comments", "agent_messages", "lead_idle_subscriptions"]) {
      assert.equal(counts[t], 1, `${t} counted`);
    }

    const out = removeProject(gone, { snapshot: true });
    assert.equal(out.deleted.name, "gone");
    assert.deepEqual(out.counts, counts);
    assert.ok(out.snapshot && existsSync(out.snapshot), "snapshot file exists");

    for (const t of PROJECT_OWNER_TABLES) assert.equal(naming(t, "project_id", gone), 0, t);
    assert.equal(naming("agent_messages", "project_id", gone), 0);
    assert.equal(naming("lead_idle_subscriptions", "target_project_id", gone), 0);
    assert.equal(naming("dashboard_meta", "project_id", gone), 0);
    assert.equal(naming("projects", "id", gone), 0);
    assert.equal(naming("queen_audit", "target_project_id", gone), 1);
    assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0);
    assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
    assert.equal(naming("pads", "project_id", keep), 1, "other project untouched");
    assert.equal(naming("todo_comments", "todo_id", db.prepare("SELECT id FROM todos WHERE project_id = ?").get(keep).id), 1);
  });

  it("refuses a project with a running agent, names it, and deletes nothing", () => {
    const p = seedProject("busy", { agentStatus: "running" });
    assert.throws(() => removeProject(p, { snapshot: false }), /running agents: x \(agent \d+\).*hive doctor/s);
    assert.equal(naming("projects", "id", p), 1);
    assert.equal(naming("todos", "project_id", p), 1);
    assert.equal(naming("agent_messages", "project_id", p), 1);
  });

  it("re-checks running agents inside the delete transaction after the snapshot", () => {
    const p = seedProject("raced-agent");
    assert.throws(
      () => removeProject(p, { snapshot: true, afterSnapshot: () => db.prepare("INSERT INTO agents (project_id, name, command, cwd, status) VALUES (?, 'late', 'sleep', '/tmp', 'running')").run(p) }),
      /running agents: late/,
    );
    assert.equal(naming("projects", "id", p), 1);
    assert.equal(naming("pads", "project_id", p), 1);
  });

  it("aborts when the project's rows changed while the snapshot was taken", () => {
    const p = seedProject("raced-rows");
    assert.throws(
      () => removeProject(p, { snapshot: true, afterSnapshot: () => db.prepare("INSERT INTO todos (project_id, title) VALUES (?, 'late')").run(p) }),
      /changed while the snapshot was taken; nothing removed, run it again/,
    );
    assert.equal(naming("projects", "id", p), 1);
    assert.equal(naming("todos", "project_id", p), 2);
  });

  it("treats a project deleted by someone else mid-removal as no project, with no receipt and no callback", () => {
    const p = db.prepare("INSERT INTO projects (name, path) VALUES ('vanishing', '/nowhere/vanishing') RETURNING id").get().id;
    let called = false;
    assert.throws(
      () => removeProject(p, { snapshot: false, afterSnapshot: () => db.prepare("DELETE FROM projects WHERE id = ?").run(p), onRemoved: () => { called = true; } }),
      new RegExp(`no project ${p}`),
    );
    assert.equal(called, false);
  });

  it("refuses an unknown project id", () => {
    assert.throws(() => removeProject(999999, { snapshot: false }), /no project 999999/);
  });
});
