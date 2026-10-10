import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import Database from "better-sqlite3";

import { assertScratchStore, clearHiveEnv, scratchDirs } from "./helpers.mjs";

const { dataDir } = scratchDirs();

clearHiveEnv();
process.env.HIVE_DATA_DIR = dataDir;
await assertScratchStore();

const { db, migrate, MIGRATIONS } = await import("../dist/db.js");
const { handoffHoldsWake } = await import("../dist/leadHandoff.js");
migrate();

const TRIGGER = "fence_handoff_held_claim";
const FALLBACK = "pty-after-socket-timeout";

// cc6d3a7 (hive 1.10.0) claim statements, verbatim from src/scheduler.ts except the dropped evidence subqueries.
const OLD_ONE_SHOT = `UPDATE wakes SET fired_at = datetime('now'), fire_count = fire_count + 1
       WHERE id = ? AND due_at IS ? AND body IS ? AND repeat_every_ms IS ?
         AND fired_at IS NULL AND cancelled_at IS NULL`;
const OLD_REPEATING = `UPDATE wakes SET due_at = datetime('now', printf('+%d seconds', ?)),
         fired_at = datetime('now'), fire_count = fire_count + 1,
         typed_at = NULL, confirmed_at = NULL, held_at = NULL, held_reason = NULL, typed_busy = NULL,
         typed_seen = NULL, first_held_at = NULL,
         socket_attempt_at = NULL, socket_delivery_note = NULL, delivery_method = NULL, delivered_by = NULL
       WHERE id = ? AND due_at IS ? AND body IS ? AND repeat_every_ms IS ? AND cancelled_at IS NULL
         AND fire_count = ?
       RETURNING fire_count, fired_at`;
const OLD_FALLBACK = `UPDATE wakes SET delivery_method = ?, delivered_by = ?
            WHERE id = ? AND delivery_method = 'socket' AND confirmed_at IS NULL AND typed_at IS NULL AND cancelled_at IS NULL`;
const OLD_REPEATING_FALLBACK = `UPDATE wakes SET delivery_method = ?, delivered_by = ?
          WHERE id = ? AND fire_count = ? AND delivery_method = 'socket-repeating'
            AND socket_attempt_at IS NOT NULL AND confirmed_at IS NULL AND typed_at IS NULL AND cancelled_at IS NULL
            AND fired_at IS NOT NULL AND socket_attempt_at >= fired_at`;
const OLD_RECORD_TYPED = `UPDATE wakes SET typed_at = strftime('%Y-%m-%d %H:%M:%f', 'now'), typed_busy = ?,
         typed_seen = ?, first_held_at = ?, held_at = NULL, held_reason = NULL, delivery_method = ?, delivered_by = ?,
         confirmed_at = CASE WHEN socket_attempt_at IS NULL THEN NULL ELSE confirmed_at END
       WHERE id = ? AND (? IS NULL OR fire_count = ?)`;

const oneShot = (conn, w) => conn.prepare(OLD_ONE_SHOT).run(w.id, w.due_at, w.body, w.repeat_every_ms);
const repeating = (conn, w) =>
  conn.prepare(OLD_REPEATING).get(60, w.id, w.due_at, w.body, w.repeat_every_ms, w.fire_count);
const fallback = (conn, w) => conn.prepare(OLD_FALLBACK).run(FALLBACK, "old", w.id);
const repeatingFallback = (conn, w) => conn.prepare(OLD_REPEATING_FALLBACK).run(FALLBACK, "old", w.id, w.fire_count);

const project = db.prepare("INSERT INTO projects (name, path) VALUES (?, ?) RETURNING id").get("fence", dataDir).id;

function seedAgent(actor, kind, status = "running") {
  return db
    .prepare(
      `INSERT INTO agents (project_id, actor_id, name, kind, tmux_target, pane_pid, command, cwd, status)
       VALUES (?, ?, ?, ?, '%9801', '4243', 'claude', '/tmp', ?) RETURNING id`,
    )
    .get(project, actor, actor, kind, status).id;
}

function seedWake(actor, extra = {}) {
  const { repeat_every_ms = null, delivery_method = null, socket_attempt_at = null } = extra;
  return db
    .prepare(
      `INSERT INTO wakes (project_id, owner, body, kind, deliver_actor, deliver_pane, due_at, repeat_every_ms,
                          delivery_method, socket_attempt_at, fired_at)
       VALUES (?, 'x', 'body', 'delay', ?, '%9801', datetime('now', '-1 minute'), ?, ?, ?,
               CASE WHEN ? IS NULL THEN NULL ELSE datetime('now', '-1 second') END)
       RETURNING *`,
    )
    .get(project, actor, repeat_every_ms, delivery_method, socket_attempt_at, socket_attempt_at);
}

let leadId;

function seedHandoff(leadAgentId, over = {}) {
  const row = {
    state: "grace",
    reason: "warn",
    pass: 1,
    hold_released_at: null,
    request_wake_id: null,
    updated_at: null,
    ...over,
  };
  db.prepare("DELETE FROM lead_handoffs").run();
  db.prepare(
    `INSERT INTO lead_handoffs (project_id, lead_agent_id, pane_target, predecessor_pane_pid, predecessor_session_id,
       reason, state, pass, request_wake_id, hold_released_at, updated_at)
     VALUES (?, ?, '%9801', '4243', 'sess', ?, ?, ?, ?, ?, COALESCE(?, strftime('%Y-%m-%d %H:%M:%f', 'now')))`,
  ).run(project, leadAgentId, row.reason, row.state, row.pass, row.request_wake_id, row.hold_released_at, row.updated_at);
}

const wakeRow = (id) => db.prepare("SELECT * FROM wakes WHERE id = ?").get(id);

beforeEach(() => {
  db.exec("DELETE FROM lead_handoffs; DELETE FROM wakes; DELETE FROM agents;");
  leadId = seedAgent("lead:fence", "lead");
});

describe("the handoff hold fence in the store", () => {
  it("a 1.10.0 one-shot claim of a held lead wake changes no row", () => {
    seedHandoff(leadId, { state: "grace" });
    const wake = seedWake("lead:fence");
    assert.equal(oneShot(db, wake).changes, 0);
    assert.equal(wakeRow(wake.id).fired_at, null);
    assert.equal(wakeRow(wake.id).fire_count, 0);
  });

  it("a 1.10.0 repeating claim of a held lead wake returns no row", () => {
    seedHandoff(leadId, { state: "grace" });
    const wake = seedWake("lead:fence", { repeat_every_ms: 60000 });
    assert.equal(repeating(db, wake), undefined);
    const after = wakeRow(wake.id);
    assert.equal(after.fire_count, 0);
    assert.equal(after.due_at, wake.due_at);
  });

  it("a 1.10.0 socket fallback claim of a held lead wake changes no row", () => {
    seedHandoff(leadId, { state: "grace" });
    const wake = seedWake("lead:fence", { delivery_method: "socket", socket_attempt_at: "x" });
    assert.equal(fallback(db, wake).changes, 0);
    assert.equal(wakeRow(wake.id).delivery_method, "socket");

    const repeatingWake = seedWake("lead:fence", { repeat_every_ms: 60000, delivery_method: "socket-repeating", socket_attempt_at: "9999" });
    assert.equal(repeatingFallback(db, repeatingWake).changes, 0);
    assert.equal(wakeRow(repeatingWake.id).delivery_method, "socket-repeating");
  });

  it("a connection that prepared its claim before the fence existed is still fenced", () => {
    const trigger = MIGRATIONS.find((sql) => sql.includes(`CREATE TRIGGER ${TRIGGER}`));
    assert.ok(trigger, "the fence migration is in MIGRATIONS");
    const other = new Database(db.name);
    try {
      db.exec(`DROP TRIGGER ${TRIGGER}`);
      const wake = seedWake("lead:fence");
      seedHandoff(leadId, { state: "grace" });
      const claim = other.prepare(OLD_ONE_SHOT);
      const args = [wake.id, wake.due_at, wake.body, wake.repeat_every_ms];
      assert.equal(claim.run(...args).changes, 1, "control: with no trigger the held wake is claimed");
      db.prepare("UPDATE wakes SET fired_at = NULL, fire_count = 0 WHERE id = ?").run(wake.id);

      db.exec(trigger);
      assert.equal(claim.run(...args).changes, 0, "the already-prepared statement is fenced");
      assert.equal(wakeRow(wake.id).fired_at, null);
    } finally {
      other.close();
      const present = db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'trigger' AND name = ?").get(TRIGGER);
      if (!present) db.exec(trigger);
    }
  });

  it("the current request wake is claimable during the hold", () => {
    const request = seedWake("lead:fence");
    seedHandoff(leadId, { state: "grace", request_wake_id: request.id });
    assert.equal(oneShot(db, request).changes, 1);
    const other = seedWake("lead:fence");
    assert.equal(oneShot(db, other).changes, 0, "any other wake to the same lead stays fenced");
  });

  it("recording a typed delivery is not fenced during a hold", () => {
    seedHandoff(leadId, { state: "grace" });
    const wake = seedWake("lead:fence", { delivery_method: "socket", socket_attempt_at: "x" });
    const typed = db.prepare(OLD_RECORD_TYPED).run(0, "seen", null, FALLBACK, "old", wake.id, null, null);
    assert.equal(typed.changes, 1);
    const after = wakeRow(wake.id);
    assert.equal(after.delivery_method, FALLBACK);
    assert.notEqual(after.typed_at, null);
  });

  it("a worker wake, another lead's wake and a raw-pane wake are claimable during a lead's hold", () => {
    db.exec("DELETE FROM lead_handoffs; DELETE FROM wakes; DELETE FROM agents;");
    seedAgent("worker:fence", "agent");
    seedAgent("lead:other", "lead");
    leadId = seedAgent("lead:fence", "lead");
    seedHandoff(leadId, { state: "grace" });
    assert.equal(oneShot(db, seedWake("worker:fence")).changes, 1);
    assert.equal(oneShot(db, seedWake("lead:other")).changes, 1);
    assert.equal(oneShot(db, seedWake("raw:no-agents-row")).changes, 1);
    assert.equal(oneShot(db, seedWake("lead:fence")).changes, 0, "the held lead's own wake stays fenced");
  });

  it("a held lead wake is claimable again once the handoff completes", () => {
    seedHandoff(leadId, { state: "grace" });
    const wake = seedWake("lead:fence");
    assert.equal(oneShot(db, wake).changes, 0);
    db.prepare("UPDATE lead_handoffs SET state = 'completed'").run();
    assert.equal(oneShot(db, wake).changes, 1);
    assert.notEqual(wakeRow(wake.id).fired_at, null);
  });

  it("a holding row untouched for an hour no longer fences", () => {
    seedHandoff(leadId, { state: "grace", updated_at: "2000-01-01 00:00:00.000" });
    assert.equal(oneShot(db, seedWake("lead:fence")).changes, 1);
    db.prepare("UPDATE lead_handoffs SET updated_at = strftime('%Y-%m-%d %H:%M:%f', 'now', '-3000 seconds')").run();
    assert.equal(oneShot(db, seedWake("lead:fence")).changes, 0, "a hold 3000 s old still fences");
    db.prepare("UPDATE lead_handoffs SET updated_at = strftime('%Y-%m-%d %H:%M:%f', 'now', '-3700 seconds')").run();
    assert.equal(oneShot(db, seedWake("lead:fence")).changes, 1, "a hold 3700 s old does not");
  });

  it("the fence trigger raises IGNORE and nothing else", () => {
    const { sql } = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?").get(TRIGGER);
    assert.match(sql, /RAISE\(IGNORE\)/);
    assert.doesNotMatch(sql, /RAISE\(\s*(ABORT|FAIL|ROLLBACK)/i);
    const body = sql.slice(sql.indexOf("BEGIN"));
    assert.equal(body.replace(/\s+/g, " ").trim(), "BEGIN SELECT RAISE(IGNORE); END");
  });

  it("the fence does not throw with no agents row, two agents rows for one actor, or no handoff row", () => {
    const noAgent = seedWake("lead:nobody");
    assert.equal(oneShot(db, noAgent).changes, 1);

    seedHandoff(leadId, { state: "grace" });
    const stopped = seedAgent("lead:fence", "lead", "closed");
    assert.ok(stopped > leadId);
    const wake = seedWake("lead:fence");
    assert.equal(oneShot(db, wake).changes, 0, "the running row wins over the newer closed row");

    db.prepare("UPDATE agents SET status = 'closed' WHERE id = ?").run(leadId);
    db.prepare("UPDATE agents SET status = 'running' WHERE id = ?").run(stopped);
    assert.equal(oneShot(db, wake).changes, 1, "the closed-then-running pick has no handoff of its own");
  });
});

describe("the store fence agrees with handoffHoldsWake on every handoff state", () => {
  const STATES = ["pending", "wind_down", "requested", "grace", "postponed", "respawning", "started", "completed", "failed", "ambiguous"];

  it("agrees over every state x pass x reason x hold_released_at x request-wake combination", () => {
    const disagreements = [];
    let fenced = 0;
    let passed = 0;
    for (const state of STATES)
      for (const pass of [1, 2, 3, 4])
        for (const reason of ["warn", "stop"])
          for (const released of [null, "2026-01-01 00:00:00.000"])
            for (const isRequest of [false, true]) {
              const wake = seedWake("lead:fence");
              seedHandoff(leadId, {
                state,
                pass,
                reason,
                hold_released_at: released,
                request_wake_id: isRequest ? wake.id : null,
              });
              const expected = handoffHoldsWake(wake.id, leadId);
              const actual = oneShot(db, wake).changes === 0;
              if (actual) fenced += 1;
              else passed += 1;
              if (expected !== actual) {
                disagreements.push(`${state} pass=${pass} reason=${reason} released=${released !== null} request=${isRequest}: JS ${expected}, store ${actual}`);
              }
              db.prepare("DELETE FROM wakes WHERE id = ?").run(wake.id);
            }
    assert.deepEqual(disagreements, []);
    assert.ok(fenced > 20 && passed > 20, `the grid must exercise both outcomes (fenced ${fenced}, passed ${passed})`);
  });
});
