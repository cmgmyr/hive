import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, it } from "node:test";

import { DIST, REPO, assertScratchStore, clearHiveEnv, isolateTmux, runNode, scratchDirs } from "./helpers.mjs";

isolateTmux("the lead turn state tests");
const { dataDir } = scratchDirs();

clearHiveEnv();
process.env.HIVE_DATA_DIR = dataDir;
await assertScratchStore();

const { db, migrate } = await import("../dist/db.js");
const { TRIAGE_MESSAGE } = await import("../dist/kickoff.js");
migrate();

const HOOK = join(DIST, "hook.js");
const fixture = (name) => readFileSync(join(REPO, "test", "fixtures", "hook-payloads", name), "utf8");
const PROMPT = fixture("lead-claude-prompt.json");
const STOP = fixture("lead-claude-stop.json");
const CLEAR = fixture("lead-claude-session-end-clear.json");
const PROMPT_AFTER_CLEAR = fixture("lead-claude-prompt-after-clear.json");
const STOP_AFTER_CLEAR = fixture("lead-claude-stop-after-clear.json");
const SESSION = JSON.parse(PROMPT).session_id;
const SESSION_AFTER_CLEAR = JSON.parse(PROMPT_AFTER_CLEAR).session_id;

const withField = (payload, field, value) => JSON.stringify({ ...JSON.parse(payload), [field]: value });

const project = db.prepare("INSERT INTO projects (name, path) VALUES (?, ?) RETURNING id").get("lead-turn", dataDir).id;

function seedAgent(kind, name, panePid = "4242", state = "unknown") {
  const actor = `${kind === "lead" ? "lead" : "agent"}:${name}`;
  const id = db
    .prepare(
      `INSERT INTO agents (project_id, actor_id, name, kind, tmux_target, pane_pid, command, cwd, status, agent_state)
       VALUES (?, ?, ?, ?, '%9700', ?, 'claude', '/tmp', 'running', ?) RETURNING id`,
    )
    .get(project, actor, name, kind, panePid, state).id;
  return { id, actor };
}

const turn = (id) => db.prepare("SELECT * FROM lead_turn_state WHERE agent_id = ?").get(id);

async function hook(event, payload, actor, lead = true) {
  const { code } = await runNode(HOOK, [event], {
    dataDir,
    env: { HIVE_AGENT_ID: actor, HIVE_LEAD: lead ? "1" : "" },
    stdin: payload,
  });
  assert.equal(code, 0);
}

function reset() {
  db.exec("DELETE FROM lead_turn_state; DELETE FROM agent_state_log; DELETE FROM agents;");
}

describe("a lead's turn state comes from its own hooks", () => {
  beforeEach(reset);

  it("a real lead prompt reads working and its Stop reads idle once, with idle_seq counting the turn", async () => {
    const lead = seedAgent("lead", "l1");

    await hook("prompt", PROMPT, lead.actor);
    assert.equal(turn(lead.id).state, "working");
    assert.equal(turn(lead.id).session_id, SESSION);
    assert.equal(turn(lead.id).pane_pid, "4242");

    await hook("stop", STOP, lead.actor);
    assert.equal(turn(lead.id).state, "idle");
    assert.equal(turn(lead.id).idle_seq, 1);

    await hook("stop", STOP, lead.actor);
    assert.equal(turn(lead.id).idle_seq, 1, "a second Stop with no prompt between is not a second turn ending");
  });

  it("a Stop before any prompt in a session records unknown and never counts as a turn ending", async () => {
    const lead = seedAgent("lead", "l2");

    await hook("stop", STOP, lead.actor);

    const row = turn(lead.id);
    assert.ok(row, "the hook must record the session it saw, or an inert hook passes this test");
    assert.equal(row.state, "unknown");
    assert.equal(row.session_id, SESSION);
    assert.equal(row.idle_seq, 0);
  });

  it("hive's own triage prompt does not start a turn, so the triage Stop is not a turn ending", async () => {
    const lead = seedAgent("lead", "l3");

    await hook("prompt", withField(PROMPT, "prompt", TRIAGE_MESSAGE), lead.actor);
    await hook("stop", STOP, lead.actor);

    assert.equal(turn(lead.id).state, "unknown");
    assert.equal(turn(lead.id).idle_seq, 0);

    await hook("prompt", PROMPT, lead.actor);
    assert.equal(turn(lead.id).state, "working", "a human prompt after triage still starts a turn");
  });

  it("/clear resets the turn and the next session's own prompt and Stop count under the new session", async () => {
    const lead = seedAgent("lead", "l4");

    await hook("prompt", PROMPT, lead.actor);
    await hook("stop", STOP, lead.actor);
    await hook("session_end", CLEAR, lead.actor);
    assert.equal(turn(lead.id).state, "unknown");

    await hook("stop", STOP_AFTER_CLEAR, lead.actor);
    assert.equal(turn(lead.id).idle_seq, 1, "a Stop in the new session before any prompt there is not a turn ending");
    assert.equal(turn(lead.id).session_id, SESSION_AFTER_CLEAR);

    await hook("prompt", PROMPT_AFTER_CLEAR, lead.actor);
    await hook("stop", STOP_AFTER_CLEAR, lead.actor);
    assert.equal(turn(lead.id).state, "idle");
    assert.equal(turn(lead.id).idle_seq, 2, "idle_seq never resets, so a watch baseline stays comparable");
  });

  it("a Stop from a session other than the working one resets to unknown instead of reading idle", async () => {
    const lead = seedAgent("lead", "l5");

    await hook("prompt", PROMPT, lead.actor);
    await hook("stop", STOP_AFTER_CLEAR, lead.actor);

    assert.equal(turn(lead.id).state, "unknown");
    assert.equal(turn(lead.id).idle_seq, 0);
  });

  it("a restarted lead (new pane pid on the same row) resets to unknown, so its first Stop is not a turn ending", async () => {
    const lead = seedAgent("lead", "l6");

    await hook("prompt", PROMPT, lead.actor);
    db.prepare("UPDATE agents SET pane_pid = '5353' WHERE id = ?").run(lead.id);
    await hook("stop", STOP, lead.actor);

    assert.equal(turn(lead.id).state, "unknown");
    assert.equal(turn(lead.id).pane_pid, "5353");
    assert.equal(turn(lead.id).idle_seq, 0);
  });

  it("a Stop with a live background subagent keeps the lead working", async () => {
    const lead = seedAgent("lead", "l7");
    const running = withField(STOP, "background_tasks", [{ id: "a1", type: "subagent", status: "running" }]);

    await hook("prompt", PROMPT, lead.actor);
    await hook("stop", running, lead.actor);
    assert.equal(turn(lead.id).state, "working");

    await hook("stop", STOP, lead.actor);
    assert.equal(turn(lead.id).state, "idle");
  });

  it("a payload with no session_id, or no JSON at all, changes nothing", async () => {
    const lead = seedAgent("lead", "l8");
    await hook("prompt", PROMPT, lead.actor);

    await hook("stop", withField(STOP, "session_id", undefined), lead.actor);
    await hook("stop", "not json", lead.actor);

    assert.equal(turn(lead.id).state, "working");
    assert.equal(turn(lead.id).idle_seq, 0);
  });

  it("writes nothing for a closed lead row, a worker, or a lead pane without HIVE_LEAD", async () => {
    const closed = seedAgent("lead", "l9");
    db.prepare("UPDATE agents SET status = 'closed' WHERE id = ?").run(closed.id);
    const worker = seedAgent("agent", "w1");
    const unflagged = seedAgent("lead", "l10");

    await hook("prompt", PROMPT, closed.actor);
    await hook("prompt", PROMPT, worker.actor);
    await hook("prompt", PROMPT, unflagged.actor, false);

    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM lead_turn_state").get().n, 0);
    assert.equal(db.prepare("SELECT agent_state FROM agents WHERE id = ?").get(worker.id).agent_state, "working");
  });

  it("keeps agents.agent_state untouched for a lead while its turn state moves", async () => {
    const lead = seedAgent("lead", "l11", "4242", "working");

    await hook("prompt", PROMPT, lead.actor);
    await hook("stop", STOP, lead.actor);

    assert.equal(turn(lead.id).state, "idle");
    assert.equal(db.prepare("SELECT agent_state FROM agents WHERE id = ?").get(lead.id).agent_state, "working");
  });

  it("still records the turn when agent_state_log cannot be written", async () => {
    const lead = seedAgent("lead", "l12");
    db.exec("ALTER TABLE agent_state_log RENAME TO agent_state_log_away");
    try {
      await hook("prompt", PROMPT, lead.actor);
    } finally {
      db.exec("ALTER TABLE agent_state_log_away RENAME TO agent_state_log");
    }
    assert.equal(turn(lead.id).state, "working");
  });
});
