import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, it } from "node:test";

import { DIST, REPO, assertScratchStore, clearHiveEnv, isolateTmux, runCli, runNode, scratchDirs } from "./helpers.mjs";

isolateTmux("the lead turn state tests");
const { dataDir } = scratchDirs();

clearHiveEnv();
process.env.HIVE_DATA_DIR = dataDir;
await assertScratchStore();

const { db, migrate } = await import("../dist/db.js");
const { firstMessageDigest } = await import("../dist/firstMessage.js");
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

async function hook(event, payload, actor, lead = true, extraEnv = {}) {
  const { code } = await runNode(HOOK, [event], {
    dataDir,
    env: { HIVE_AGENT_ID: actor, HIVE_LEAD: lead ? "1" : "", ...extraEnv },
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

  it("the retired shipped triage text with no launch marker is a real prompt, not hive's own", async () => {
    const lead = seedAgent("lead", "l3");
    const retired =
      "Start with morning triage. Run `hive runbook` for this project's standing process, then " +
      "reconcile the state hive just injected against what is really there (agent_list, todo_list, " +
      "wake_list) and report it in a few lines. Propose today's lanes and confirm them with me before " +
      "dispatching anything.";

    await hook("prompt", withField(PROMPT, "prompt", retired), lead.actor);
    assert.equal(turn(lead.id).state, "working");
    await hook("stop", STOP, lead.actor);
    assert.equal(turn(lead.id).state, "idle");
  });

  it("a custom first message hive put on the command line does not start a turn, and a human prompt still does", async () => {
    const lead = seedAgent("lead", "l3b");
    const custom = "Check the queue and wait for me.";
    const marker = { HIVE_LEAD_FIRST_MESSAGE_SHA: firstMessageDigest(custom) };

    await hook("prompt", withField(PROMPT, "prompt", custom), lead.actor, true, marker);
    await hook("stop", STOP, lead.actor, true, marker);
    assert.equal(turn(lead.id).state, "unknown");
    assert.equal(turn(lead.id).idle_seq, 0);

    await hook("prompt", PROMPT, lead.actor, true, marker);
    assert.equal(turn(lead.id).state, "working");
  });

  it("records session_end after hive's first message so status reads the lead dormant", async () => {
    const lead = seedAgent("lead", "l3d");
    const firstMessage = "Wait for the next task.";
    const marker = { HIVE_LEAD_FIRST_MESSAGE_SHA: firstMessageDigest(firstMessage) };

    await hook("prompt", withField(PROMPT, "prompt", firstMessage), lead.actor, true, marker);
    assert.equal(turn(lead.id).state, "unknown");

    await hook("session_end", withField(CLEAR, "session_id", SESSION), lead.actor, true, marker);

    assert.equal(turn(lead.id).last_event, "session_end");
    const status = await runCli(["status"], { cwd: dataDir, dataDir });
    assert.equal(status.code, 0, status.stderr);
    assert.match(status.stdout, /dormant \(session ended/);
  });

  it("a same-session Stop after SessionEnd preserves dormant status", async () => {
    const lead = seedAgent("lead", "l3e");
    const firstMessage = "Wait for the next task.";
    const marker = { HIVE_LEAD_FIRST_MESSAGE_SHA: firstMessageDigest(firstMessage) };

    await hook("prompt", withField(PROMPT, "prompt", firstMessage), lead.actor, true, marker);
    await hook("session_end", withField(CLEAR, "session_id", SESSION), lead.actor, true, marker);
    await hook("stop", STOP, lead.actor, true, marker);

    assert.equal(turn(lead.id).last_event, "session_end");
    const status = await runCli(["status"], { cwd: dataDir, dataDir });
    assert.equal(status.code, 0, status.stderr);
    assert.match(status.stdout, /dormant \(session ended/);
  });

  it("the same text without hive's launch marker is a real prompt", async () => {
    const lead = seedAgent("lead", "l3c");
    await hook("prompt", withField(PROMPT, "prompt", "Check the queue and wait for me."), lead.actor);
    assert.equal(turn(lead.id).state, "working");
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

  it("the handoff snapshot counts every prompt while working and only human ones as conversation", async () => {
    const lead = seedAgent("lead", "snap1");
    const TASK = fixture("prompt-task-notification.json");
    await hook("prompt", PROMPT, lead.actor);
    await hook("prompt", withField(PROMPT, "prompt", "[hive wake #12] check the board"), lead.actor);
    await hook("prompt", withField(TASK, "session_id", SESSION), lead.actor);
    await hook("prompt", withField(PROMPT, "prompt", "[hive:worker w1] done"), lead.actor);
    const row = turn(lead.id);
    assert.equal(row.state, "working");
    assert.equal(row.prompt_seq, 4);
    assert.equal(row.human_prompt_seq, 1);
    assert.notEqual(row.human_prompt_at, null);
    assert.equal(row.transcript_path, JSON.parse(PROMPT).transcript_path);
    assert.equal(row.stop_prompt_seq, null);
    await hook("stop", STOP, lead.actor);
    assert.equal(turn(lead.id).stop_prompt_seq, 4);
    assert.equal(turn(lead.id).stop_background, "[]");
  });

  it("/clear starts a fresh handoff snapshot for the new session", async () => {
    const lead = seedAgent("lead", "snap2");
    await hook("prompt", PROMPT, lead.actor);
    await hook("stop", STOP, lead.actor);
    await hook("session_end", CLEAR, lead.actor);
    await hook("prompt", PROMPT_AFTER_CLEAR, lead.actor);
    const row = turn(lead.id);
    assert.equal(row.snapshot_session_id, SESSION_AFTER_CLEAR);
    assert.equal(row.prompt_seq, 1);
    assert.equal(row.stop_prompt_seq, null);
    assert.equal(row.stop_background, null);
  });

  it("a late SessionEnd from a superseded session does not reset the new session's turn", async () => {
    const lead = seedAgent("lead", "l13");

    await hook("prompt", PROMPT, lead.actor);
    await hook("prompt", PROMPT_AFTER_CLEAR, lead.actor);
    await hook("session_end", CLEAR, lead.actor);

    assert.equal(turn(lead.id).state, "working");
    assert.equal(turn(lead.id).session_id, SESSION_AFTER_CLEAR);
  });
});

describe("the human-prompt predicate", () => {
  it("isHumanPrompt agrees with conversationHoldsWake's SQL over every hive marker shape", async () => {
    const { humanPromptSql, isHumanPrompt } = await import("../dist/leadState.js");
    const envelope = (name, body) => `<cross-session-message from="x" from-name="${name}">\n${body}\n</cross-session-message>`;
    const samples = [
      "what is the status?",
      "[hive wake #12] check the board",
      "please look at [hive wake #3] again",
      "[hive:worker w1] done",
      "[HIVE:lead other] hi",
      "<task-notification>finished</task-notification>",
      envelope("hive", "[hive:worker w1] [message #4, 20 chars] done"),
      envelope("peer", "[hive:worker w1] [message #4, 20 chars] done"),
      envelope("hive", "a human quoting hive"),
    ];
    const sql = db.prepare(`WITH t(payload) AS (SELECT ?) SELECT (${humanPromptSql("payload")}) AS human FROM t`);
    for (const prompt of samples) {
      const fromSql = sql.get(JSON.stringify({ prompt })).human === 1;
      assert.equal(isHumanPrompt(prompt), fromSql, prompt);
    }
    assert.equal(isHumanPrompt(samples[0]), true, "positive control: a plain prompt is human");
  });
});
