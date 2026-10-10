import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, it } from "node:test";

import { DIST, REPO, assertScratchStore, clearHiveEnv, isolateTmux, runNode, scratchDirs } from "./helpers.mjs";

isolateTmux("the lead auto-handoff state tests");
const { dataDir, tmp } = scratchDirs();

clearHiveEnv();
process.env.HIVE_DATA_DIR = dataDir;
await assertScratchStore();

const { db, migrate } = await import("../dist/db.js");
const handoff = await import("../dist/leadHandoff.js");
const { readLeadSafetySnapshot } = await import("../dist/leadState.js");
const { sendQuietLeadMessage, retryQuietLeadMessages } = await import("../dist/leadMessageDelivery.js");
migrate();

const HOOK = join(DIST, "hook.js");
const fixture = (name) => JSON.parse(readFileSync(join(REPO, "test", "fixtures", "hook-payloads", name), "utf8"));
const SESSION = fixture("lead-claude-prompt.json").session_id;
const TRANSCRIPT = join(tmp, "lead.jsonl");

const project = db.prepare("INSERT INTO projects (name, path) VALUES (?, ?) RETURNING id").get("handoff", dataDir).id;

function writeTranscript(turns) {
  writeFileSync(
    TRANSCRIPT,
    Array.from({ length: turns }, (_, i) => JSON.stringify({ type: "assistant", message: { id: `m${i}`, model: "claude" } })).join("\n") + "\n",
  );
}

function seedLead(command = "claude") {
  const row = db
    .prepare(
      `INSERT INTO agents (project_id, actor_id, name, kind, tmux_target, pane_pid, command, cwd, status)
       VALUES (?, 'lead:h', 'lead', 'lead', '%9800', '4242', ?, '/tmp', 'running') RETURNING *`,
    )
    .get(project, command);
  return row;
}

const payload = (name, extra = {}) => JSON.stringify({ ...fixture(name), session_id: SESSION, transcript_path: TRANSCRIPT, ...extra });

async function hook(event, body) {
  const { code } = await runNode(HOOK, [event], { dataDir, env: { HIVE_AGENT_ID: "lead:h", HIVE_LEAD: "1" }, stdin: body });
  assert.equal(code, 0);
}

async function completedTurn(stopName = "lead-claude-stop.json", stopExtra = {}) {
  await hook("prompt", payload("lead-claude-prompt.json"));
  await hook("stop", payload(stopName, stopExtra));
}

function reset() {
  db.exec("DELETE FROM lead_handoffs; DELETE FROM wakes; DELETE FROM lead_turn_state; DELETE FROM agent_state_log; DELETE FROM agents;");
}

describe("lead auto-handoff state", () => {
  beforeEach(reset);

  it("only an opted-in Claude lead arms turn-budget handoff", async () => {
    const lead = seedLead();
    writeTranscript(5);
    await completedTurn();
    const on = { warn: 3, stop: 10, auto_handoff: true };
    const armed = handoff.handoffEligibility(lead, on);
    assert.equal(armed.eligible, true, JSON.stringify(armed));
    assert.equal(armed.reason, "warn");
    assert.equal(armed.turns, 5);
    assert.deepEqual(armed.epoch, { pane_pid: "4242", session_id: SESSION });
    assert.equal(handoff.handoffEligibility(lead, { ...on, stop: 5 }).reason, "stop");

    assert.equal(handoff.handoffEligibility(lead, { warn: 3, stop: 10 }).eligible, false);
    assert.equal(handoff.handoffEligibility(lead, { ...on, auto_handoff: false }).eligible, false);
    assert.equal(handoff.handoffEligibility(lead, null).eligible, false);
    assert.equal(handoff.handoffEligibility({ ...lead, command: "codex" }, on).eligible, false);
    assert.equal(handoff.handoffEligibility({ ...lead, pane_pid: "9999" }, on).eligible, false);
    assert.equal(handoff.handoffEligibility(lead, { ...on, warn: 6, stop: 10 }).eligible, false);
    writeFileSync(TRANSCRIPT, "");
    db.prepare("UPDATE lead_turn_state SET transcript_path = ? WHERE agent_id = ?").run(join(tmp, "missing.jsonl"), lead.id);
    assert.match(handoff.handoffEligibility(lead, on).why, /turn count is unavailable/);
  });

  it("two schedulers arm one epoch and one request wake", async () => {
    const lead = seedLead();
    const script = join(tmp, "arm.mjs");
    writeFileSync(
      script,
      `const h = await import(${JSON.stringify(join(DIST, "leadHandoff.js"))});
       const lead = JSON.parse(process.argv[2]);
       const ids = new Set();
       for (let i = 0; i < 25; i++) {
         const r = h.armHandoffRequest({ lead, ownerActor: lead.actor_id, reason: "warn",
           epoch: { pane_pid: "4242", session_id: "s-1" }, requestBody: (id) => "handoff request #" + id });
         ids.add(r.requestId);
       }
       console.log(JSON.stringify([...ids]));`,
    );
    const runs = await Promise.all([0, 1, 2].map(() => runNode(script, [JSON.stringify(lead)], { dataDir })));
    for (const run of runs) assert.equal(run.code, 0, run.stderr);
    const seen = new Set(runs.flatMap((run) => JSON.parse(run.stdout)));
    const rows = db.prepare("SELECT * FROM lead_handoffs").all();
    assert.equal(rows.length, 1);
    assert.deepEqual([...seen], [rows[0].id]);
    const wakes = db.prepare("SELECT * FROM wakes").all();
    assert.equal(wakes.length, 1);
    assert.equal(rows[0].request_wake_id, wakes[0].id);
    assert.equal(wakes[0].due_at, null);
    assert.equal(wakes[0].deliver_actor, "lead:h");
    assert.equal(wakes[0].body, `handoff request #${rows[0].id}`);
  });

  it("idle lead with a live shell, monitor, subagent or unknown task cannot respawn", async () => {
    seedLead();
    const lead = db.prepare("SELECT * FROM agents").get();
    const veto = () => handoff.backgroundVeto(readLeadSafetySnapshot(lead.id));

    await completedTurn();
    assert.equal(veto(), null, "positive control: a clean completed turn is safe");

    await completedTurn("stop-shell-running.json");
    assert.match(veto(), /background task.*shell/);
    await completedTurn("stop-monitors-running.json");
    assert.match(veto(), /monitor/);
    await completedTurn("lead-claude-stop.json", { background_tasks: [{ type: "telepathy", status: "running" }] });
    assert.match(veto(), /telepathy/);

    await completedTurn("stop-subagents-running.json");
    db.prepare("UPDATE agent_state_log SET created_at = datetime('now', '-2 hours')").run();
    assert.match(veto(), /subagent/, "a live subagent in the Stop payload vetoes, with no latch expiry");

    const noEvidence = { ...fixture("lead-claude-stop.json"), session_id: SESSION, transcript_path: TRANSCRIPT };
    delete noEvidence.background_tasks;
    await hook("prompt", payload("lead-claude-prompt.json"));
    await hook("stop", JSON.stringify(noEvidence));
    assert.match(veto(), /no background-task evidence/);

    await completedTurn();
    await hook("prompt", payload("lead-claude-prompt.json"));
    assert.match(veto(), /a turn started after the last completed one/);
  });

  it("failed wind-down releases delivery without a retry loop", () => {
    const lead = seedLead();
    const arm = () =>
      handoff.armHandoffRequest({
        lead, ownerActor: "lead:h", reason: "stop", epoch: { pane_pid: "4242", session_id: "s-1" }, requestBody: () => "req",
      });
    const first = arm();
    assert.equal(first.created, true);
    const gate = handoff.readHandoffGate(lead.id);
    assert.equal(gate.requestId, first.requestId);
    assert.equal(gate.holdAutomation, true);
    assert.equal(handoff.casHandoff(first.requestId, ["grace"], { state: "respawning" }), false);
    assert.equal(handoff.readHandoff(first.requestId).state, "wind_down");

    assert.equal(handoff.failHandoff(first.requestId, "config disabled"), true);
    assert.equal(handoff.readHandoffGate(lead.id), null);
    const row = handoff.readHandoff(first.requestId);
    assert.equal(row.state, "failed");
    assert.equal(row.failure, "config disabled");
    assert.notEqual(db.prepare("SELECT cancelled_at FROM wakes WHERE id = ?").get(row.request_wake_id).cancelled_at, null);

    assert.deepEqual(arm(), { requestId: first.requestId, created: false });
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM wakes").get().n, 1);
    assert.equal(handoff.failHandoff(first.requestId, "again"), false);
  });

  it("pass escalation holds from the request on only after the first pass", () => {
    const lead = seedLead();
    const { requestId } = handoff.armHandoffRequest({
      lead, ownerActor: "lead:h", reason: "warn", epoch: { pane_pid: "4242", session_id: "s-1" }, requestBody: () => "req",
    });
    assert.equal(handoff.readHandoffGate(lead.id).holdAutomation, false);
    handoff.casHandoff(requestId, ["pending"], { state: "requested" });
    assert.equal(handoff.readHandoffGate(lead.id).holdAutomation, false);
    handoff.casHandoff(requestId, ["requested"], { state: "grace" });
    assert.equal(handoff.readHandoffGate(lead.id).holdAutomation, true);
    handoff.casHandoff(requestId, ["grace"], { state: "postponed" });
    assert.equal(handoff.readHandoffGate(lead.id).holdAutomation, false);
    handoff.casHandoff(requestId, ["postponed"], { state: "requested", pass: 2 });
    assert.equal(handoff.readHandoffGate(lead.id).holdAutomation, true);
    handoff.casHandoff(requestId, ["requested"], { hold_released_at: "2026-10-09 00:00:00" });
    assert.equal(handoff.readHandoffGate(lead.id).holdAutomation, false);
  });
});

describe("lead auto-handoff hold lifetime", () => {
  beforeEach(reset);

  it("respawning and ambiguous hold until released, and started holds through boot", () => {
    const lead = seedLead();
    const { requestId } = handoff.armHandoffRequest({
      lead, ownerActor: "lead:h", reason: "stop", epoch: { pane_pid: "4242", session_id: "s-1" }, requestBody: () => "req",
    });
    for (const state of ["respawning", "ambiguous"]) {
      db.prepare("UPDATE lead_handoffs SET state = ?, hold_released_at = NULL WHERE id = ?").run(state, requestId);
      assert.equal(handoff.readHandoffGate(lead.id).holdAutomation, true, state);
      db.prepare("UPDATE lead_handoffs SET hold_released_at = datetime('now') WHERE id = ?").run(requestId);
      assert.equal(handoff.readHandoffGate(lead.id).holdAutomation, false, `${state} after release`);
    }
    db.prepare("UPDATE lead_handoffs SET state = 'started', hold_released_at = NULL WHERE id = ?").run(requestId);
    assert.equal(handoff.readHandoffGate(lead.id).holdAutomation, true);
  });

  it("startup and stale hooks do not release a started hold, and the successor's first completed turn does", async () => {
    const lead = seedLead();
    writeTranscript(5);
    const { requestId } = handoff.armHandoffRequest({
      lead, ownerActor: "lead:h", reason: "stop", epoch: { pane_pid: "4242", session_id: SESSION }, requestBody: () => "req",
    });
    db.prepare("UPDATE lead_handoffs SET state = 'started', successor_pane_pid = '4242', started_at = datetime('now') WHERE id = ?").run(requestId);
    const held = (step) => {
      assert.equal(handoff.readHandoff(requestId).state, "started", step);
      assert.equal(handoff.readHandoffGate(lead.id)?.holdAutomation, true, step);
    };
    held("exec");

    const SUCCESSOR = "successor-session";
    await hook("session_start", payload("lead-claude-prompt.json", { session_id: SUCCESSOR, hook_event_name: "SessionStart", source: "startup" }));
    held("SessionStart");

    await completedTurn();
    held("a predecessor-session prompt and Stop");

    await hook("stop", payload("lead-claude-stop.json", { session_id: SUCCESSOR }));
    held("a successor Stop with no prompt");

    await hook("prompt", payload("lead-claude-prompt.json", { session_id: SUCCESSOR }));
    held("a successor prompt with its turn still running");

    await hook("stop", payload("lead-claude-stop.json", { session_id: SUCCESSOR }));
    assert.equal(handoff.readHandoff(requestId).state, "completed");
    assert.equal(handoff.readHandoffGate(lead.id), null);
  });

  it("a started handoff holds a worker's message to the lead", async () => {
    const lead = seedLead();
    db.prepare(
      `INSERT INTO agents (project_id, actor_id, name, kind, tmux_target, pane_pid, command, cwd, status)
       VALUES (?, 'agent:w', 'w', 'agent', '%9801', '1', 'claude', '/tmp', 'running')`,
    ).run(project);
    const { requestId } = handoff.armHandoffRequest({
      lead, ownerActor: "lead:h", reason: "stop", epoch: { pane_pid: "100", session_id: "s-1" }, requestBody: () => "req",
    });
    db.prepare("UPDATE lead_handoffs SET state = 'started', successor_pane_pid = '4242', started_at = datetime('now') WHERE id = ?").run(requestId);
    try {
      const receipt = await sendQuietLeadMessage({ projectId: project, fromActor: "agent:w", target: lead, text: "held through started", submit: true });
      assert.equal(receipt?.pending, true, JSON.stringify(receipt));
      assert.match(receipt.note, /handing off/);
      await retryQuietLeadMessages(null);
      assert.equal(db.prepare("SELECT delivery_status FROM agent_messages WHERE id = ?").get(receipt.message_id).delivery_status, "fallback-pending");
    } finally {
      db.exec("DELETE FROM agent_messages");
    }
  });

  it("a never-ready successor is named from started_at, then released at the ceiling", () => {
    const lead = seedLead();
    const budget = () => ({ warn: 3, stop: 10, auto_handoff: true });
    const { requestId } = handoff.armHandoffRequest({
      lead, ownerActor: "lead:h", reason: "stop", epoch: { pane_pid: "100", session_id: "s-1" }, requestBody: () => "req",
    });
    db.prepare(
      `UPDATE lead_handoffs SET state = 'started', successor_pane_pid = '4242', blocked_reason = 'a stale grace reason',
         started_at = strftime('%Y-%m-%d %H:%M:%f', 'now', '-14 minutes') WHERE id = ?`,
    ).run(requestId);
    const wake = db
      .prepare("INSERT INTO wakes (project_id, owner, body, kind, deliver_actor, deliver_pane, due_at) VALUES (?, 'x', 'roster', 'delay', 'lead:h', '%9800', datetime('now', '-1 minute')) RETURNING id")
      .get(project).id;
    const claim = () => db.prepare("UPDATE wakes SET fired_at = datetime('now'), fire_count = fire_count + 1 WHERE id = ? AND fired_at IS NULL").run(wake).changes;

    handoff.driveLeadHandoff("lead:h", budget);
    assert.equal(handoff.readHandoff(requestId).blocked_reason, "a stale grace reason", "14 minutes after started_at is not yet named");
    assert.equal(handoff.handoffStatusSegment(lead.id), "handoff started");

    db.prepare("UPDATE lead_handoffs SET started_at = strftime('%Y-%m-%d %H:%M:%f', 'now', '-16 minutes') WHERE id = ?").run(requestId);
    handoff.driveLeadHandoff("lead:h", budget);
    const named = handoff.readHandoff(requestId);
    assert.equal(named.state, "started");
    assert.equal(named.blocked_reason, handoff.SUCCESSOR_NOT_READY);
    assert.equal(handoff.handoffStatusSegment(lead.id), `handoff started: ${handoff.SUCCESSOR_NOT_READY}`);
    assert.equal(handoff.readHandoffGate(lead.id).holdAutomation, true);
    assert.equal(claim(), 0, "the store fence still refuses the claim once the reason is named");

    db.prepare("UPDATE lead_handoffs SET updated_at = strftime('%Y-%m-%d %H:%M:%f', 'now', '-3601 seconds') WHERE id = ?").run(requestId);
    assert.equal(handoff.readHandoffGate(lead.id).holdAutomation, false);
    assert.equal(claim(), 1, "past the ceiling the held wake is claimable");
  });

  it("a started row that inherited a released respawn hold reads as started, not blocked, while it holds", () => {
    const lead = seedLead();
    const { requestId } = handoff.armHandoffRequest({
      lead, ownerActor: "lead:h", reason: "stop", epoch: { pane_pid: "100", session_id: "s-1" }, requestBody: () => "req",
    });
    db.prepare(
      `UPDATE lead_handoffs SET state = 'started', successor_pane_pid = '4242', started_at = datetime('now'),
         hold_released_at = datetime('now', '-1 minute'), blocked_reason = 'the respawn never settled' WHERE id = ?`,
    ).run(requestId);
    assert.equal(handoff.readHandoffGate(lead.id).holdAutomation, true);
    assert.equal(handoff.handoffStatusSegment(lead.id), "handoff started");
    db.prepare("UPDATE lead_handoffs SET blocked_reason = ? WHERE id = ?").run(handoff.SUCCESSOR_NOT_READY, requestId);
    assert.equal(handoff.handoffStatusSegment(lead.id), `handoff started: ${handoff.SUCCESSOR_NOT_READY}`);
  });

  it("the successor's injection says held deliveries arrive once its first turn ends", () => {
    const lead = seedLead();
    const { requestId } = handoff.armHandoffRequest({
      lead, ownerActor: "lead:h", reason: "stop", epoch: { pane_pid: "100", session_id: "s-1" }, requestBody: () => "req",
    });
    const padId = db.prepare("INSERT INTO pads (project_id, name, content) VALUES (?, ?, 'pad body') RETURNING id").get(project, handoff.HANDOFF_PAD_NAME).id;
    db.prepare("UPDATE lead_handoffs SET state = 'started', successor_pane_pid = '4242', pad_id = ?, started_at = datetime('now') WHERE id = ?").run(padId, requestId);
    try {
      const text = handoff.handoffInjection("lead:h");
      assert.match(text, /Held for the handoff and delivered to you once your first turn ends: 0 wake\(s\), 0 message\(s\)\./);
      assert.doesNotMatch(text, /released to you now/);
    } finally {
      db.prepare("DELETE FROM pads WHERE id = ?").run(padId);
    }
  });

  it("a completed handoff records its hold release and clears blocked_reason", async () => {
    for (const padCase of ["archived", "edited"]) {
      reset();
      const lead = seedLead();
      const { requestId } = handoff.armHandoffRequest({
        lead, ownerActor: "lead:h", reason: "stop", epoch: { pane_pid: "100", session_id: "s-1" }, requestBody: () => "req",
      });
      const content = "pad body";
      const pad = db.prepare("INSERT INTO pads (project_id, name, content) VALUES (?, ?, ?) RETURNING id, revision").get(project, handoff.HANDOFF_PAD_NAME, content);
      const sha = createHash("sha256").update(padCase === "archived" ? content : "other body").digest("hex");
      db.prepare(
        `UPDATE lead_handoffs SET state = 'started', successor_pane_pid = '4242', started_at = datetime('now'),
           predecessor_session_id = 'old-session', blocked_reason = ?, pad_id = ?, pad_revision = ?, pad_length = ?, pad_sha256 = ? WHERE id = ?`,
      ).run(handoff.SUCCESSOR_NOT_READY, pad.id, pad.revision, content.length, sha, requestId);

      await completedTurn();

      const row = handoff.readHandoff(requestId);
      assert.equal(row.state, "completed", padCase);
      assert.ok(row.completed_at, padCase);
      assert.equal(row.hold_released_at, row.completed_at, padCase);
      assert.equal(row.blocked_reason, null, padCase);
      assert.equal(row.failure === null, padCase === "archived", padCase);
    }
  });

  it("a grace whose owner process is dead fails and releases its holds", async () => {
    const lead = seedLead();
    writeTranscript(5);
    await completedTurn();
    const { requestId } = handoff.armHandoffRequest({
      lead, ownerActor: "lead:h", reason: "warn", epoch: { pane_pid: "4242", session_id: SESSION }, requestBody: () => "req",
    });
    db.prepare(
      "UPDATE lead_handoffs SET state = 'grace', attempt = 1, owner_token = 't', owner_pid = 2147483646, grace_seconds = 120, grace_started_at = datetime('now') WHERE id = ?",
    ).run(requestId);
    assert.equal(handoff.readHandoffGate(lead.id).holdAutomation, true);
    handoff.driveLeadHandoff("lead:h", () => ({ warn: 3, stop: 10, auto_handoff: true }));
    const row = handoff.readHandoff(requestId);
    assert.equal(row.state, "failed");
    assert.match(row.failure, /grace owner process died/);
    assert.equal(handoff.readHandoffGate(lead.id), null);
  });
});
