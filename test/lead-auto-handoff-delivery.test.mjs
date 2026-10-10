import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";

import { DIST, REPO, assertScratchStore, clearHiveEnv, isolateTmux, runNode, scratchDirs, until } from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("the lead auto-handoff delivery tests");
const { dataDir, tmp } = scratchDirs();
clearHiveEnv();
delete process.env.CLAUDE_CODE_MESSAGING_SOCKET;
process.env.HIVE_DATA_DIR = dataDir;
await assertScratchStore();

const { db, migrate } = await import("../dist/db.js");
const handoff = await import("../dist/leadHandoff.js");
const { tick } = await import("../dist/scheduler.js");
const { sendQuietLeadMessage, retryQuietLeadMessages } = await import("../dist/leadMessageDelivery.js");
const { tmuxSocketPath } = await import("../dist/tmux.js");
migrate();

const HOOK = join(DIST, "hook.js");
const fixture = (name) => JSON.parse(readFileSync(join(REPO, "test", "fixtures", "hook-payloads", name), "utf8"));
const SESSION = fixture("lead-claude-prompt.json").session_id;
const TRANSCRIPT = join(tmp, "lead.jsonl");
const ownSocket = tmuxSocketPath(process.env.TMUX, process.env.TMUX_TMPDIR);
const needsTmux = { skip: hasTmux ? false : "tmux is not installed" };
const BUDGET = { warn: 3, stop: 10, auto_handoff: true };
const sessions = [];
after(() => cleanup(...sessions));

const projectDir = mkdtempSync(join(tmp, "project-"));
writeFileSync(join(projectDir, "hive.yml"), "dashboard: false\n");
const project = db.prepare("INSERT INTO projects (name, path) VALUES ('handoff', ?) RETURNING id").get(projectDir).id;

function turns(n) {
  writeFileSync(
    TRANSCRIPT,
    Array.from({ length: n }, (_, i) => JSON.stringify({ type: "assistant", message: { id: `m${i}`, model: "claude" } })).join("\n") + "\n",
  );
}

let paneCount = 0;
function sinkPane() {
  const session = `lah-${process.pid}-${paneCount++}`;
  const sink = join(tmp, `${session}.sink`);
  writeFileSync(sink, "");
  execFileSync("tmux", ["new-session", "-d", "-s", session, "-x", "200", "-y", "50", `cat > '${sink}'`], { stdio: "ignore" });
  sessions.push(session);
  const [pane, pid] = execFileSync("tmux", ["list-panes", "-t", `=${session}`, "-F", "#{pane_id}\t#{pane_pid}"], { encoding: "utf8" })
    .trim()
    .split("\t");
  return { pane, pid, sink };
}

function seedLead({ pane = "%9800", pid = "4242" } = {}) {
  return db
    .prepare(
      `INSERT INTO agents (project_id, actor_id, name, kind, tmux_target, tmux_socket, pane_pid, command, cwd, status, created_at)
       VALUES (?, 'lead:d', 'lead', 'lead', ?, ?, ?, 'claude', '/tmp', 'running', datetime('now', '-60 seconds')) RETURNING *`,
    )
    .get(project, pane, ownSocket, pid);
}

function seedWorker() {
  return db
    .prepare(
      `INSERT INTO agents (project_id, actor_id, name, kind, tmux_target, pane_pid, command, cwd, status)
       VALUES (?, 'agent:w', 'w', 'agent', '%9801', '1', 'claude', '/tmp', 'running') RETURNING *`,
    )
    .get(project);
}

const payload = (name, extra = {}) => JSON.stringify({ ...fixture(name), session_id: SESSION, transcript_path: TRANSCRIPT, ...extra });
async function hook(event, body) {
  const { code } = await runNode(HOOK, [event], { dataDir, env: { HIVE_AGENT_ID: "lead:d", HIVE_LEAD: "1" }, stdin: body });
  assert.equal(code, 0);
}
const prompt = () => hook("prompt", payload("lead-claude-prompt.json"));
const stop = (name = "lead-claude-stop.json") => hook("stop", payload(name));
const drive = (budget = BUDGET) => handoff.driveLeadHandoff("lead:d", () => budget);
const active = (leadId) => handoff.readActiveHandoff(leadId);
const wake = (id) => db.prepare("SELECT * FROM wakes WHERE id = ?").get(id);
const quietHuman = () => db.prepare("UPDATE lead_turn_state SET human_prompt_at = datetime('now', '-10 minutes')").run();

beforeEach(() =>
  db.exec(
    "DELETE FROM lead_handoffs; DELETE FROM wakes; DELETE FROM agent_messages; DELETE FROM lead_turn_state; DELETE FROM agent_state_log; DELETE FROM leases; DELETE FROM agents;",
  ),
);

describe("lead auto-handoff delivery", () => {
  it("warn requests handoff only after a known quiet lead turn", async () => {
    const lead = seedLead();
    turns(5);
    await prompt();
    drive({ warn: 3, stop: 10 });
    assert.equal(active(lead.id), null, "no auto_handoff key: no request");

    drive();
    let row = active(lead.id);
    assert.equal(row.state, "pending", "armed at warn while the lead is still working");
    assert.equal(wake(row.request_wake_id).due_at, null);

    await stop();
    drive();
    assert.equal(active(lead.id).state, "pending", "a human prompt in the last 5 minutes keeps it waiting");

    quietHuman();
    const other = db
      .prepare(
        `INSERT INTO wakes (project_id, owner, body, kind, deliver_actor, deliver_pane, due_at, fired_at)
         VALUES (?, 'lead:d', 'worker finished', 'delay', 'lead:d', '%9800', datetime('now'), datetime('now')) RETURNING id`,
      )
      .get(project).id;
    drive();
    assert.equal(active(lead.id).state, "pending", "an automated delivery in the last 120 s keeps it waiting");

    db.prepare("UPDATE wakes SET fired_at = datetime('now', '-10 minutes'), due_at = datetime('now', '-10 minutes') WHERE id = ?").run(other);
    const worker = seedWorker();
    db.prepare(
      `INSERT INTO agent_messages (project_id, from_actor, from_name, to_agent_id, text, delivery_status, created_at)
       VALUES (?, ?, 'w', ?, 'hi', 'socket-pending', datetime('now', '-10 minutes'))`,
    ).run(project, worker.actor_id, lead.id);
    drive();
    assert.equal(active(lead.id).state, "pending", "a socket post still in flight keeps it waiting");

    db.exec("UPDATE agent_messages SET delivery_status = 'complete'");
    drive();
    row = active(lead.id);
    assert.equal(row.state, "requested");
    const request = wake(row.request_wake_id);
    assert.notEqual(request.due_at, null);
    assert.match(request.body, new RegExp(`^hive lead handoff request #${row.id} \\(pass 1, warn budget, 5 turns\\)`));
    for (const heading of handoff.HANDOFF_HEADINGS) assert.ok(request.body.includes(heading), heading);
    assert.match(request.body, new RegExp(`hive lead-handoff --request ${row.id} --pad <pad id> --revision <revision>`));
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM wakes WHERE body LIKE 'hive lead handoff request #%'").get().n, 1);
  });

  it("stop holds automation and keeps the warn request and human turn", async () => {
    const lead = seedLead();
    turns(5);
    await prompt();
    drive();
    const warned = active(lead.id);
    assert.equal(handoff.readHandoffGate(lead.id).holdAutomation, false, "a warn pass holds nothing before grace");

    turns(12);
    drive();
    const stopped = active(lead.id);
    assert.equal(stopped.id, warned.id);
    assert.equal(stopped.reason, "stop");
    assert.equal(stopped.state, "wind_down");
    assert.equal(stopped.request_wake_id, warned.request_wake_id);
    assert.equal(handoff.readHandoffGate(lead.id).holdAutomation, true);

    const ordinary = db
      .prepare(
        `INSERT INTO wakes (project_id, owner, body, kind, deliver_actor, deliver_pane, due_at)
         VALUES (?, 'agent:w', 'finish notice', 'delay', 'lead:d', '%9800', datetime('now', '-2 hours')) RETURNING id`,
      )
      .get(project).id;
    await tick(null);
    const held = wake(ordinary);
    assert.equal(held.fired_at, null);
    assert.equal(held.cancelled_at, null, "held, never aged out or cancelled for the handoff");
    assert.equal(held.held_reason, handoff.HELD_REASON_HANDOFF);

    const before = db.prepare("SELECT human_prompt_seq FROM lead_turn_state").get().human_prompt_seq;
    await prompt();
    const after = db.prepare("SELECT human_prompt_seq, state FROM lead_turn_state").get();
    assert.equal(after.human_prompt_seq, before + 1);
    assert.equal(after.state, "working", "a human prompt still starts a turn at stop");
    assert.equal(active(lead.id).id, warned.id);
  });

  it("a pass without a quiet moment escalates, live background work never does, and a stop hold releases at 15 minutes", async () => {
    const lead = seedLead();
    turns(5);
    await prompt();
    drive();
    const row = active(lead.id);
    db.prepare("UPDATE lead_handoffs SET pass_started_at = datetime('now', '-11 minutes') WHERE id = ?").run(row.id);
    drive();
    assert.equal(handoff.readHandoff(row.id).pass, 2);

    await stop();
    drive();
    const second = handoff.readHandoff(row.id);
    assert.equal(second.state, "requested", "from pass 2 the request goes at the next ordinary idle, human prompt or not");
    assert.equal(handoff.readHandoffGate(lead.id).holdAutomation, true, "pass 2 holds from the request on");

    db.exec("DELETE FROM lead_handoffs; DELETE FROM wakes;");
    turns(12);
    await prompt();
    await stop("stop-shell-running.json");
    drive();
    const blocked = active(lead.id);
    assert.equal(blocked.state, "wind_down");
    db.prepare("UPDATE lead_handoffs SET pass_started_at = datetime('now', '-11 minutes') WHERE id = ?").run(blocked.id);
    drive();
    assert.equal(handoff.readHandoff(blocked.id).pass, 1, "live background work never escalates");
    assert.equal(handoff.readHandoffGate(lead.id).holdAutomation, true);
    db.prepare("UPDATE lead_handoffs SET hold_since = datetime('now', '-16 minutes') WHERE id = ?").run(blocked.id);
    drive();
    const released = handoff.readHandoff(blocked.id);
    assert.notEqual(released.hold_released_at, null);
    assert.match(released.blocked_reason, /shell/);
    assert.equal(handoff.readHandoffGate(lead.id).holdAutomation, false);
    assert.equal(released.state, "wind_down", "the epoch stays armed; only the hold is released");
  });

  it("postponed handoff requests a fresh attempt wake at its next quiet moment", async () => {
    const lead = seedLead();
    turns(5);
    await prompt();
    await stop();
    quietHuman();
    drive();
    const first = active(lead.id);
    assert.equal(first.state, "requested");
    db.prepare("UPDATE wakes SET fired_at = datetime('now', '-10 minutes') WHERE id = ?").run(first.request_wake_id);
    handoff.casHandoff(first.id, ["requested"], { state: "postponed", pass: 2 });
    drive();
    const second = active(lead.id);
    assert.equal(second.state, "requested");
    assert.notEqual(second.request_wake_id, first.request_wake_id);
    assert.match(wake(second.request_wake_id).body, /\(pass 2,/);
  });

  it("failing the epoch on a session change releases the hold without a re-request", async () => {
    const lead = seedLead();
    turns(12);
    await prompt();
    drive();
    const row = active(lead.id);
    assert.equal(handoff.readHandoffGate(lead.id).holdAutomation, true);
    db.prepare("UPDATE agents SET pane_pid = '5151' WHERE id = ?").run(lead.id);
    drive();
    assert.equal(handoff.readHandoff(row.id).state, "failed");
    assert.match(handoff.readHandoff(row.id).failure, /pane or session changed/);
    assert.equal(handoff.readHandoffGate(lead.id), null);
    assert.notEqual(wake(row.request_wake_id).cancelled_at, null);
  });

  it("held wakes and messages reach the handed-off successor once and never the predecessor", needsTmux, async () => {
    const sink = sinkPane();
    const lead = seedLead({ pane: sink.pane, pid: sink.pid });
    const worker = seedWorker();
    turns(12);
    await prompt();
    drive();
    const row = active(lead.id);
    assert.equal(handoff.readHandoffGate(lead.id).holdAutomation, true);
    db.exec("UPDATE agent_state_log SET created_at = datetime('now', '-10 minutes')");

    const receipt = await sendQuietLeadMessage({
      projectId: project, fromActor: worker.actor_id, target: db.prepare("SELECT * FROM agents WHERE id = ?").get(lead.id),
      text: "held for the successor", submit: true,
    });
    assert.equal(receipt.sent, false);
    assert.equal(receipt.pending, true);
    assert.match(receipt.note, /handing off/);
    const notice = db
      .prepare(
        `INSERT INTO wakes (project_id, owner, body, kind, deliver_actor, deliver_pane, due_at)
         VALUES (?, 'agent:w', 'crew notice', 'delay', 'lead:d', ?, datetime('now')) RETURNING id`,
      )
      .get(project, sink.pane).id;
    await tick();
    await retryQuietLeadMessages(null);
    assert.equal(readFileSync(sink.sink, "utf8"), "", "nothing typed into the predecessor during the hold");
    assert.equal(wake(notice).fired_at, null);
    assert.equal(wake(notice).held_reason, handoff.HELD_REASON_HANDOFF);

    const successorSink = join(tmp, "successor.sink");
    writeFileSync(successorSink, "");
    execFileSync("tmux", ["respawn-pane", "-k", "-t", sink.pane, `cat > '${successorSink}'`], { stdio: "ignore" });
    const pid = execFileSync("tmux", ["display-message", "-p", "-t", sink.pane, "#{pane_pid}"], { encoding: "utf8" }).trim();
    db.prepare("UPDATE agents SET pane_pid = ? WHERE id = ?").run(pid, lead.id);
    handoff.casHandoff(row.id, ["wind_down"], { state: "completed", successor_pane_pid: pid });

    for (let i = 0; i < 3; i++) {
      await tick();
      await retryQuietLeadMessages(null);
    }
    assert.ok(await until(() => readFileSync(successorSink, "utf8").includes("crew notice"), 3000));
    const typed = readFileSync(successorSink, "utf8");
    assert.equal(typed.split("held for the successor").length - 1, 1);
    assert.equal(typed.split("crew notice").length - 1, 1);
    assert.equal(db.prepare("SELECT delivery_status FROM agent_messages").get().delivery_status, "complete");
  });
});
