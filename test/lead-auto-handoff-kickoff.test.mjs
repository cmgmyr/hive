import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, it } from "node:test";

import { DIST, KICKOFF, REPO, assertScratchStore, clearHiveEnv, isolateTmux, runNode, scratchDirs } from "./helpers.mjs";

isolateTmux("the lead auto-handoff kickoff tests");
const { dataDir, projectDir, tmp } = scratchDirs();
clearHiveEnv();
process.env.HIVE_DATA_DIR = dataDir;
await assertScratchStore();

const { db, migrate } = await import("../dist/db.js");
const handoff = await import("../dist/leadHandoff.js");
migrate();

const HOOK = join(DIST, "hook.js");
const fixture = (name) => JSON.parse(readFileSync(join(REPO, "test", "fixtures", "hook-payloads", name), "utf8"));
const PREDECESSOR = "predecessor-session";
const SUCCESSOR = fixture("lead-claude-prompt.json").session_id;
const project = db.prepare("INSERT INTO projects (name, path) VALUES ('kick', ?) RETURNING id").get(projectDir).id;
const BIG = handoff.HANDOFF_HEADINGS.map((h) => `${h}\nnone`).join("\n\n") + "\n" + "x".repeat(15_000) + "\nTAIL-MARKER";

function seed({ padContent = BIG } = {}) {
  const lead = db
    .prepare(
      `INSERT INTO agents (project_id, actor_id, name, kind, tmux_target, pane_pid, command, cwd, status)
       VALUES (?, 'lead:k', 'lead', 'lead', '%1', '200', 'claude', ?, 'running') RETURNING *`,
    )
    .get(project, projectDir);
  db.prepare(
    `INSERT INTO agents (project_id, actor_id, name, kind, tmux_target, pane_pid, command, cwd, status, agent_state)
     VALUES (?, 'agent:k1', 'k1', 'agent', '%2', '300', 'claude', ?, 'running', 'working')`,
  ).run(project, projectDir);
  const pad = db.prepare("INSERT INTO pads (project_id, name, content) VALUES (?, 'hive-lead-handoff', ?) RETURNING id, revision").get(project, padContent);
  const id = db
    .prepare(
      `INSERT INTO lead_handoffs (project_id, lead_agent_id, pane_target, predecessor_pane_pid, predecessor_session_id, reason, state,
         pass, pad_id, pad_revision, pad_length, pad_sha256, respawn_claimed_at, predecessor_turns, successor_pane_pid, started_at)
       VALUES (?, ?, '%1', '100', ?, 'stop', 'started', 2, ?, ?, ?, ?, datetime('now'), 612, '200', datetime('now')) RETURNING id`,
    )
    .get(project, lead.id, PREDECESSOR, pad.id, pad.revision, padContent.length, createHash("sha256").update(padContent).digest("hex")).id;
  return { lead, pad, id };
}

const kickoff = (env) => runNode(KICKOFF, [], { cwd: projectDir, dataDir, tmp, env });
const contextOf = (stdout) => JSON.parse(stdout).hookSpecificOutput.additionalContext;
async function hook(event, body) {
  const { code } = await runNode(HOOK, [event], { dataDir, env: { HIVE_AGENT_ID: "lead:k", HIVE_LEAD: "1" }, stdin: JSON.stringify(body) });
  assert.equal(code, 0);
}
const prompt = (session) => hook("prompt", { ...fixture("lead-claude-prompt.json"), session_id: session });
const stop = (session, name = "lead-claude-stop.json") => hook("stop", { ...fixture(name), session_id: session });
const pad = (id) => db.prepare("SELECT archived, revision FROM pads WHERE id = ?").get(id);

beforeEach(() => db.exec("DELETE FROM lead_handoffs; DELETE FROM pads; DELETE FROM lead_turn_state; DELETE FROM agent_state_log; DELETE FROM agents; DELETE FROM wakes;"));

describe("lead auto-handoff successor start", () => {
  it("starting lead receives full handoff beyond the digest budget", async () => {
    const { pad: p } = seed();
    const lead = await kickoff({ HIVE_AGENT_ID: "lead:k", HIVE_LEAD: "1" });
    assert.equal(lead.code, 0, lead.stderr);
    const text = contextOf(lead.stdout);
    assert.ok(lead.stdout.length > 15_000, "longer than the 10,000-character digest budget");
    assert.ok(text.includes("TAIL-MARKER"), "the pad's last line arrives, so nothing was cut");
    assert.match(text, new RegExp(`LEAD HANDOFF: pad "hive-lead-handoff" #${p.id} revision ${p.revision}`));
    assert.match(text, /Handed off by session predecessor-session at turn 612 \(stop, pass 2\)/);
    assert.match(text, /Workers: k1 \[working\]/);
    assert.match(text, /missing from the handoff/);

    const worker = await kickoff({ HIVE_AGENT_ID: "agent:k1" });
    assert.ok(!worker.stdout.includes("LEAD HANDOFF"), "a worker gets no handoff");
    const plain = await kickoff({});
    assert.ok(!plain.stdout.includes("LEAD HANDOFF"), "a session hive did not start as a lead gets none");
  });

  it("a reserved-name pad no handoff delivered injects nothing", async () => {
    const { id } = seed();
    db.prepare("DELETE FROM lead_handoffs WHERE id = ?").run(id);
    const lead = await kickoff({ HIVE_AGENT_ID: "lead:k", HIVE_LEAD: "1" });
    assert.ok(!lead.stdout.includes("LEAD HANDOFF"));
  });

  it("the successor's appended gaps note still archives the delivered pad", async () => {
    const { pad: p, id } = seed({ padContent: "IN FLIGHT\nnone" });
    db.prepare("UPDATE pads SET content = content || char(10) || 'missing from the handoff: none', revision = revision + 1, updated_at = datetime('now') WHERE id = ?").run(p.id);
    await prompt(SUCCESSOR);
    await stop(SUCCESSOR);
    assert.equal(handoff.readHandoff(id).state, "completed");
    assert.equal(pad(p.id).archived, 1);
  });

  it("only successor first completed turn archives its delivered pad, even with a monitor or shell left running", async () => {
    const { pad: p, id } = seed({ padContent: "IN FLIGHT\nnone" });
    await prompt(PREDECESSOR);
    await stop(PREDECESSOR);
    assert.equal(handoff.readHandoff(id).state, "started", "a late predecessor Stop completes nothing");

    await stop(SUCCESSOR);
    assert.equal(pad(p.id).archived, 0, "a startup-only Stop is not a completed turn");
    await prompt(SUCCESSOR);
    await stop(SUCCESSOR, "stop-shell-running.json");
    const done = handoff.readHandoff(id);
    assert.equal(done.state, "completed");
    assert.equal(done.successor_session_id, SUCCESSOR);
    assert.equal(done.delivered_pad_revision, p.revision);
    assert.equal(pad(p.id).archived, 1);
    assert.match(handoff.handoffStatusSegment(done.lead_agent_id), /^handed off \d+s ago$/);
    assert.equal(handoff.readHandoffGate(done.lead_agent_id), null, "holds release on completion");
  });

  it("an edited delivered text completes the handoff but stays active", async () => {
    const { pad: p, id } = seed({ padContent: "IN FLIGHT\nnone" });
    db.prepare("UPDATE pads SET content = 'IN FLIGHT' || char(10) || 'rewritten', revision = revision + 1, updated_at = datetime('now') WHERE id = ?").run(p.id);
    await prompt(SUCCESSOR);
    await stop(SUCCESSOR);
    assert.equal(handoff.readHandoff(id).state, "completed");
    assert.equal(pad(p.id).archived, 0);
    assert.match(handoff.readHandoff(id).failure, /left active/);
  });
});
