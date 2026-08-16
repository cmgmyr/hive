import assert from "node:assert/strict";
import { join } from "node:path";
import { beforeEach, describe, it } from "node:test";

import { DIST, assertScratchStore, clearHiveEnv, isolateTmux, runNode, scratchDirs } from "./helpers.mjs";

isolateTmux("the state-log tests");
const { dataDir } = scratchDirs();

clearHiveEnv();
process.env.HIVE_DATA_DIR = dataDir;

await assertScratchStore();

const { db, migrate } = await import("../dist/db.js");
const { tick } = await import("../dist/scheduler.js");
migrate();

const HOOK = join(DIST, "hook.js");

const project = db
  .prepare("INSERT INTO projects (name, path) VALUES (?, ?) RETURNING id")
  .get("state-log-test", dataDir).id;

function agentRow(name, state = "unknown") {
  return db
    .prepare(
      `INSERT INTO agents (project_id, actor_id, name, tmux_target, command, cwd, status, agent_state)
       VALUES (?, ?, ?, '%9600', 'claude', '/tmp', 'running', ?) RETURNING id`,
    )
    .get(project, `agent:${name}`, name, state).id;
}

const stateOf = (id) => db.prepare("SELECT agent_state FROM agents WHERE id = ?").get(id).agent_state;

const logFor = (actorId) =>
  db.prepare("SELECT * FROM agent_state_log WHERE actor_id = ? ORDER BY id").all(actorId);

async function runHook(event, payload, actorId) {
  const { code } = await runNode(HOOK, [event], {
    dataDir,
    env: { HIVE_AGENT_ID: actorId },
    stdin: payload ?? "",
  });
  return code;
}

const stopPayload = (tasks) =>
  JSON.stringify({ hook_event_name: "Stop", stop_hook_active: false, background_tasks: tasks });

const RUNNING_SUBAGENT = { id: "af205d5098bf85bc2", type: "subagent", status: "running" };

const IDLE_NOTIFICATION = JSON.stringify({
  hook_event_name: "Notification",
  message: "Claude is waiting for your input",
  notification_type: "idle_prompt",
});

function reset() {
  db.exec("DELETE FROM agent_state_log; DELETE FROM agents;");
}

describe("every hook invocation appends a row nothing ever overwrites", () => {
  beforeEach(reset);

  it("records the event, the state it decided and the payload verbatim", async () => {
    const agent = agentRow("recorded");

    await runHook("stop", stopPayload([RUNNING_SUBAGENT]), "agent:recorded");

    const rows = logFor("agent:recorded");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].event, "stop", "which of stateFor's three branches ran is the whole question");
    assert.equal(rows[0].state, "working");
    assert.equal(rows[0].payload, stopPayload([RUNNING_SUBAGENT]), "stored raw, byte for byte");
    assert.equal(stateOf(agent), "working", "and the agents row is still written");
  });

  it("keeps a state that was overwritten two events later", async () => {

    const agent = agentRow("self-correcting", "working");

    await runHook("stop", stopPayload([]), "agent:self-correcting");
    await runHook("prompt", JSON.stringify({ prompt: "task-notification" }), "agent:self-correcting");

    assert.equal(stateOf(agent), "working", "the live row has already forgotten");

    const rows = logFor("agent:self-correcting");
    assert.deepEqual(
      rows.map((r) => [r.event, r.state]),
      [
        ["stop", "idle"],
        ["prompt", "working"],
      ],
      "the log remembers the idle, and remembers which event wrote it",
    );
  });

  it("orders rows within the same second, which is where this bug lives", async () => {

    const actor = "agent:same-second";
    agentRow("same-second");

    await runHook("stop", stopPayload([RUNNING_SUBAGENT]), actor);
    await runHook("notify", IDLE_NOTIFICATION, actor);
    await runHook("prompt", "{}", actor);

    const rows = logFor(actor);
    assert.equal(rows.length, 3);
    assert.deepEqual(rows.map((r) => r.event), ["stop", "notify", "prompt"]);
    assert.ok(
      rows.every((r) => /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/.test(r.created_at)),
      `created_at must carry milliseconds; got ${JSON.stringify(rows.map((r) => r.created_at))}`,
    );
    assert.ok(rows[0].id < rows[1].id && rows[1].id < rows[2].id);
  });

  it("truncates a huge payload and says that it did", async () => {

    const actor = "agent:huge";
    agentRow("huge");
    const prompt = "x".repeat(50_000);

    await runHook("prompt", JSON.stringify({ prompt }), actor);

    const [row] = logFor(actor);
    assert.ok(row.payload.length < 11_000, `payload should be capped; got ${row.payload.length}`);
    assert.match(row.payload, /\[hive: truncated at 10000 bytes\]/);
    assert.match(row.payload, /^\{"prompt":"x+/, "and it keeps the START of the payload");
  });

  it("records an unreadable payload rather than skipping the event", async () => {

    const actor = "agent:garbage";
    agentRow("garbage");

    await runHook("stop", "this is not json", actor);
    await runHook("stop", "", actor);

    const rows = logFor(actor);
    assert.deepEqual(rows.map((r) => [r.event, r.state, r.payload]), [
      ["stop", "idle", "this is not json"],
      ["stop", "idle", ""],
    ]);
  });

  it("writes nothing when there is no agent to attribute it to", async () => {
    const { code } = await runNode(HOOK, ["stop"], { dataDir, env: {}, stdin: stopPayload([]) });

    assert.equal(code, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM agent_state_log").get().n, 0);
  });

  it("never logs a state it failed to write", async () => {

    const actor = "agent:order-pinned";
    agentRow("order-pinned", "working");
    db.exec("ALTER TABLE agents RENAME TO agents_hidden");
    let code;
    try {
      code = await runHook("stop", stopPayload([]), actor);
    } finally {
      db.exec("ALTER TABLE agents_hidden RENAME TO agents");
    }

    assert.equal(code, 0, "a hook must always exit 0");
    assert.deepEqual(logFor(actor), [], "no state was written, so nothing may claim one was");
  });

  it("never lets a broken log cost the state write", async () => {

    const agent = agentRow("log-broken", "idle");
    db.exec("ALTER TABLE agent_state_log RENAME TO agent_state_log_hidden");
    let code;
    let state;
    try {
      code = await runHook("stop", stopPayload([RUNNING_SUBAGENT]), "agent:log-broken");
      state = stateOf(agent);
    } finally {
      db.exec("ALTER TABLE agent_state_log_hidden RENAME TO agent_state_log");
    }

    assert.equal(code, 0, "a hook must always exit 0");
    assert.equal(state, "working", "the agents row is written even with nowhere to log it");
  });
});

describe("retention keeps an append-only table from growing without bound", () => {
  beforeEach(reset);

  const seed = (createdAt, id) =>
    db
      .prepare(
        `INSERT INTO agent_state_log (${id ? "id, " : ""}actor_id, event, state, payload, created_at)
         VALUES (${id ? "?, " : ""}'agent:x', 'stop', 'idle', '{}', ?)`,
      )
      .run(...(id ? [id, createdAt] : [createdAt]));

  const count = () => db.prepare("SELECT COUNT(*) AS n FROM agent_state_log").get().n;

  it("drops rows past the retention window and keeps the rest", async () => {
    seed("2020-01-01 00:00:00.000");
    seed("2020-06-01 00:00:00.000");
    const fresh = db.prepare("SELECT datetime('now') AS t").get().t;
    seed(fresh);

    await tick(null);

    assert.equal(count(), 1, "only the fresh row survives");
  });

  it("still prunes when tmux cannot be probed at all", async () => {
    seed("2020-01-01 00:00:00.000");

    await tick(null);

    assert.equal(count(), 0);
  });

  it("caps the table by row count even when every row is recent", async () => {
    const now = db.prepare("SELECT strftime('%Y-%m-%d %H:%M:%f', 'now') AS t").get().t;

    seed(now, 1);
    seed(now, 2);
    seed(now, 30_000);

    await tick(null);

    const left = db.prepare("SELECT id FROM agent_state_log ORDER BY id").all().map((r) => r.id);
    assert.deepEqual(left, [30_000], "everything more than LOG_MAX_ROWS behind the head goes");
  });

  it("leaves a table that is inside both bounds completely alone", async () => {
    const now = db.prepare("SELECT strftime('%Y-%m-%d %H:%M:%f', 'now') AS t").get().t;
    seed(now, 1);
    seed(now, 2);

    await tick(null);

    assert.equal(count(), 2);
  });
});
