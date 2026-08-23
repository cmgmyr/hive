import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import { DIST, assertScratchStore, clearHiveEnv, isolateTmux, runNode, scratchDirs } from "./helpers.mjs";

isolateTmux("the hook subagent-latch tests");
const { dataDir } = scratchDirs();

clearHiveEnv();
process.env.HIVE_DATA_DIR = dataDir;
await assertScratchStore();

const { db, migrate } = await import("../dist/db.js");
migrate();

const HOOK = join(DIST, "hook.js");

const project = db
  .prepare("INSERT INTO projects (name, path) VALUES (?, ?) RETURNING id")
  .get("hook-subagent-latch", dataDir).id;

let counter = 0;
function agentRow(seededState) {
  const actorId = `agent:latch-${counter++}`;
  db.prepare(
    `INSERT INTO agents (project_id, actor_id, name, tmux_target, command, cwd, status, kind, agent_state)
     VALUES (?, ?, ?, '%9600', 'codex', '/tmp', 'running', 'agent', ?)`,
  ).run(project, actorId, actorId, seededState);
  return actorId;
}

const stateOf = (actorId) => db.prepare("SELECT agent_state FROM agents WHERE actor_id = ?").get(actorId).agent_state;

const lastLog = (actorId) =>
  db.prepare("SELECT event, state FROM agent_state_log WHERE actor_id = ? ORDER BY id DESC LIMIT 1").get(actorId);

async function runHook(event, payload, actorId) {
  const { code } = await runNode(HOOK, [event], {
    dataDir,
    env: { HIVE_AGENT_ID: actorId },
    stdin: JSON.stringify(payload),
  });
  assert.equal(code, 0, `hook must always exit 0, actor ${actorId}, event ${event}`);
}

// Field names follow the real shape captured in research pad 229 (H2), but the values are synthetic
// placeholders, not a byte-exact capture: unlike the claude Notification/Stop corpus in
// test/fixtures/hook-payloads/, stateFor's "subagent_start"/"subagent_stop" cases read no field from
// either payload at all (they only ever return null - see src/hook.ts), so nothing here pins a field
// shape the way that corpus does. A codex Stop payload never carries background_tasks at all (proven
// structurally absent, not merely empty, in R4/H3) - reproduced here as a key that is simply omitted.
const subagentStart = { hook_event_name: "SubagentStart", session_id: "s1", agent_id: "a1", agent_type: "default" };
const subagentStop = {
  hook_event_name: "SubagentStop",
  session_id: "s1",
  agent_id: "a1",
  agent_type: "default",
  last_assistant_message: "done",
};
const codexStop = { hook_event_name: "Stop", session_id: "s1", stop_hook_active: false };

describe("subagent_start and subagent_stop are log-only - neither forces an agent_state write", () => {
  it("subagent_start leaves agent_state exactly as it was, and logs event=subagent_start state=unchanged", async () => {
    const actorId = agentRow("working");
    await runHook("subagent_start", subagentStart, actorId);
    assert.equal(stateOf(actorId), "working");
    assert.deepEqual(lastLog(actorId), { event: "subagent_start", state: "unchanged" });
  });

  it("subagent_stop leaves agent_state exactly as it was, and logs event=subagent_stop state=unchanged", async () => {
    const actorId = agentRow("idle");
    await runHook("subagent_stop", subagentStop, actorId);
    assert.equal(stateOf(actorId), "idle");
    assert.deepEqual(lastLog(actorId), { event: "subagent_stop", state: "unchanged" });
  });
});

describe("the subagent latch, rekeyed to SubagentStart/SubagentStop for a harness whose Stop payload never carries background_tasks", () => {
  it("a stop with no background_tasks key at all, and no subagent_start ever recorded, reports idle - the ordinary case", async () => {
    const actorId = agentRow("working");
    await runHook("stop", codexStop, actorId);
    assert.equal(stateOf(actorId), "idle");
  });

  it("a stop with no background_tasks key reports working, not idle, while the most recent subagent_start has no later subagent_stop", async () => {
    const actorId = agentRow("working");
    await runHook("subagent_start", subagentStart, actorId);

    await runHook("stop", codexStop, actorId);
    assert.equal(stateOf(actorId), "working", "a live subagent must withhold idle even with no background_tasks field to read");
    assert.deepEqual(lastLog(actorId), { event: "stop", state: "working" });
  });

  it("reports idle again once subagent_stop has closed the open subagent_start", async () => {
    const actorId = agentRow("working");
    await runHook("subagent_start", subagentStart, actorId);
    await runHook("stop", codexStop, actorId);
    assert.equal(stateOf(actorId), "working");

    await runHook("subagent_stop", subagentStop, actorId);
    await runHook("stop", codexStop, actorId);
    assert.equal(stateOf(actorId), "idle");
    assert.deepEqual(lastLog(actorId), { event: "stop", state: "idle" });
  });
});

// Inserted directly rather than through runHook: these three tests need to put the log row in a
// state runHook alone cannot reach - backdated past the latch's own bound, or removed outright.
function insertSubagentRow(actorId, event, agentId, { ageSeconds = 0 } = {}) {
  db.prepare(
    `INSERT INTO agent_state_log (actor_id, event, state, payload, created_at)
     VALUES (?, ?, 'unchanged', ?, datetime('now', ?))`,
  ).run(
    actorId,
    event,
    JSON.stringify({ hook_event_name: event === "subagent_start" ? "SubagentStart" : "SubagentStop", agent_id: agentId }),
    `-${ageSeconds} seconds`,
  );
}

describe("the latch is bounded and per-subagent, not a single newest-row toggle (todo 525 review findings 1, 2, 10)", () => {
  it("a subagent_start with no matching subagent_stop does not withhold idle forever - it ages out past SUBAGENT_LATCH_MAX_AGE_SECONDS (a crashed/killed subagent)", async () => {
    const actorId = agentRow("working");
    insertSubagentRow(actorId, "subagent_start", "crashed-subagent", { ageSeconds: 20 * 60 });

    await runHook("stop", codexStop, actorId);
    assert.equal(
      stateOf(actorId),
      "idle",
      "an unmatched subagent_start older than the bound must release the latch, or a crashed subagent sticks this worker at working forever",
    );
  });

  it("a second, still-open subagent is not closed by a different subagent's stop (concurrent subagents, tracked per agent_id)", async () => {
    const actorId = agentRow("working");
    await runHook("subagent_start", { ...subagentStart, agent_id: "agent-a" }, actorId);
    await runHook("subagent_start", { ...subagentStart, agent_id: "agent-b" }, actorId);
    await runHook("subagent_stop", { ...subagentStop, agent_id: "agent-a" }, actorId);

    await runHook("stop", codexStop, actorId);
    assert.equal(
      stateOf(actorId),
      "working",
      "agent-b never stopped - a newest-row-only latch wrongly reads agent-a's stop as closing the whole latch",
    );
  });

  it("evidence removed from the log (retention eviction) reads the same as evidence that simply aged out - an accepted residual, not a new failure mode", async () => {
    const actorId = agentRow("working");
    await runHook("subagent_start", { ...subagentStart, agent_id: "evicted-subagent" }, actorId);
    db.prepare("DELETE FROM agent_state_log WHERE actor_id = ? AND event = 'subagent_start'").run(actorId);

    await runHook("stop", codexStop, actorId);
    assert.equal(
      stateOf(actorId),
      "idle",
      "with the only evidence of the open subagent gone, hive cannot distinguish this from 'never started' - " +
        "the same limit the age bound above already accepts, not a separate gap",
    );
  });
});

describe("an event stateFor has no case for does nothing, rather than asserting a state it does not have", () => {
  it("leaves agent_state untouched, and logs the argv event name with state=unchanged - was 'waiting', proven indistinguishable from a real notify payload's own fallback (research pad 229, TEST 3 vs TEST 4)", async () => {
    const actorId = agentRow("working");
    await runHook("session_start", { hook_event_name: "SessionStart", session_id: "s1" }, actorId);
    assert.equal(stateOf(actorId), "working");
    assert.deepEqual(lastLog(actorId), { event: "session_start", state: "unchanged" });
  });
});
