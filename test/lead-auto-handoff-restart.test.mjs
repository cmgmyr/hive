import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";

import { DIST, REPO, assertScratchStore, clearHiveEnv, isolateTmux, runCli, runNode, scratchDirs, until } from "./helpers.mjs";

const { dataDir, tmp } = scratchDirs();
const fakeBin = join(tmp, "bin");
mkdirSync(fakeBin);
const launched = join(tmp, "launched.txt");
writeFileSync(
  join(fakeBin, "claude"),
  `#!/bin/sh\necho "$$ $*" >> '${launched}'\nexec sleep 600\n`,
);
chmodSync(join(fakeBin, "claude"), 0o755);
process.env.PATH = `${fakeBin}:${process.env.PATH}`;

const { hasTmux, cleanup } = isolateTmux("the lead auto-handoff restart tests");
clearHiveEnv();
process.env.HIVE_DATA_DIR = dataDir;
await assertScratchStore();

const { db, migrate } = await import("../dist/db.js");
const handoff = await import("../dist/leadHandoff.js");
const { tmuxSocketPath } = await import("../dist/tmux.js");
migrate();

const HOOK = join(DIST, "hook.js");
const PANES = join(REPO, "test", "fixtures", "panes");
const fixture = (name) => JSON.parse(readFileSync(join(REPO, "test", "fixtures", "hook-payloads", name), "utf8"));
const SESSION = fixture("lead-claude-prompt.json").session_id;
const TRANSCRIPT = join(tmp, "lead.jsonl");
const ownSocket = tmuxSocketPath(process.env.TMUX, process.env.TMUX_TMPDIR);
const needsTmux = { skip: hasTmux ? false : "tmux is not installed" };
const sessions = [];
after(() => cleanup(...sessions));

const projectDir = mkdtempSync(join(tmp, "project-"));
writeFileSync(join(projectDir, "hive.yml"), "dashboard: false\nlead_turn_budget: {warn: 3, stop: 10, auto_handoff: true}\n");
const project = db.prepare("INSERT INTO projects (name, path) VALUES ('restart', ?) RETURNING id").get(projectDir).id;
writeFileSync(
  TRANSCRIPT,
  Array.from({ length: 5 }, (_, i) => JSON.stringify({ type: "assistant", message: { id: `m${i}`, model: "claude" } })).join("\n") + "\n",
);

const PAD = handoff.HANDOFF_HEADINGS.map((h) => `${h}\nnone`).join("\n\n");
const alive = (pid) => {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
};
const panePid = (pane) => execFileSync("tmux", ["display-message", "-p", "-t", pane, "#{pane_pid}"], { encoding: "utf8" }).trim();

let paneCount = 0;
function leadPane() {
  const session = `lar-${process.pid}-${paneCount++}`;
  const flag = join(tmp, `${session}.flag`);
  const script = `cat '${join(PANES, "ready-idle.txt")}'; while [ ! -f '${flag}' ]; do sleep 0.05; done; clear; cat '${join(PANES, "real-input.txt")}'; exec sleep 600`;
  execFileSync("tmux", ["new-session", "-d", "-s", session, "-x", "200", "-y", "50", script], { stdio: "ignore" });
  sessions.push(session);
  const pane = execFileSync("tmux", ["list-panes", "-t", `=${session}`, "-F", "#{pane_id}"], { encoding: "utf8" }).trim();
  return { pane, pid: panePid(pane), typeIntoBox: () => writeFileSync(flag, "") };
}

const payload = (name, extra = {}) => JSON.stringify({ ...fixture(name), session_id: SESSION, transcript_path: TRANSCRIPT, ...extra });
async function hook(event, body, env = {}) {
  const { code } = await runNode(HOOK, [event], { dataDir, env: { HIVE_AGENT_ID: "lead:r", HIVE_LEAD: "1", ...env }, stdin: body });
  assert.equal(code, 0);
}

async function readyLead({ stop = "lead-claude-stop.json" } = {}) {
  const pane = leadPane();
  const lead = db
    .prepare(
      `INSERT INTO agents (project_id, actor_id, name, kind, tmux_target, tmux_socket, pane_pid, command, cwd, status)
       VALUES (?, 'lead:r', 'lead', 'lead', ?, ?, ?, 'claude', ?, 'running') RETURNING *`,
    )
    .get(project, pane.pane, ownSocket, pane.pid, projectDir);
  await hook("prompt", payload("lead-claude-prompt.json"));
  await hook("stop", payload(stop));
  db.exec("UPDATE lead_turn_state SET human_prompt_at = datetime('now', '-10 minutes'); UPDATE agent_state_log SET created_at = datetime('now', '-10 minutes')");
  const { requestId } = handoff.armHandoffRequest({
    lead, ownerActor: "lead:r", reason: "warn", epoch: { pane_pid: pane.pid, session_id: SESSION }, requestBody: () => "req",
  });
  handoff.casHandoff(requestId, ["pending"], { state: "requested", request_reason: "warn" });
  const padRow = db
    .prepare(`INSERT INTO pads (project_id, name, content) VALUES (?, 'hive-lead-handoff', ?) RETURNING id, revision`)
    .get(project, PAD);
  return { pane, lead, requestId, padId: padRow.id, revision: padRow.revision };
}

const command = (ctx, overrides = {}, env = {}) =>
  runCli(
    ["lead-handoff", "--request", String(ctx.requestId), "--pad", String(overrides.pad ?? ctx.padId), "--revision", String(overrides.revision ?? ctx.revision)],
    { cwd: projectDir, dataDir, env: { HIVE_AGENT_ID: "lead:r", HIVE_LEAD: "1", TMUX_PANE: ctx.pane.pane, ...env } },
  );
const row = (id) => handoff.readHandoff(id);
const endGrace = (id) => db.prepare("UPDATE lead_handoffs SET grace_started_at = datetime('now', '-10 minutes') WHERE id = ?").run(id);

beforeEach(() => db.exec("DELETE FROM lead_handoffs; DELETE FROM wakes; DELETE FROM pads; DELETE FROM lead_turn_state; DELETE FROM agent_state_log; DELETE FROM agents;"));

describe("lead auto-handoff restart", () => {
  it("handoff command arms one owner only for its persisted epoch pad", needsTmux, async () => {
    const ctx = await readyLead();
    assert.match((await command(ctx, { revision: 7 })).stderr, /revision 1, not 7/);
    assert.match((await command(ctx, {}, { HIVE_LEAD: "" })).stderr, /only a running lead/);
    assert.match((await command(ctx, {}, { TMUX_PANE: "%999" })).stderr, /lead's own recorded pane/);
    db.prepare("UPDATE pads SET content = ?, updated_at = datetime('now') WHERE id = ?").run(PAD.replace("VERIFY ON ARRIVAL", "VERIFY"), ctx.padId);
    const noHeading = await command(ctx);
    assert.equal(noHeading.code, 1);
    assert.match(noHeading.stderr, /missing these headings.*VERIFY ON ARRIVAL/);
    assert.equal(row(ctx.requestId).state, "requested");

    db.prepare("UPDATE pads SET content = ?, updated_at = datetime('now') WHERE id = ?").run(PAD, ctx.padId);
    db.prepare("UPDATE lead_handoffs SET reason = 'stop' WHERE id = ?").run(ctx.requestId);
    const ok = await command(ctx);
    assert.equal(ok.code, 0, ok.stderr);
    assert.match(ok.stdout, /Handoff #\d+ armed \(attempt 1/);
    const armed = row(ctx.requestId);
    assert.equal(armed.state, "grace");
    assert.equal(armed.grace_seconds, 120, "the grace the warn request announced survives a stop upgrade");
    assert.equal(armed.pad_revision, 1);
    assert.equal(armed.predecessor_turns, 5);
    assert.ok(await until(() => row(ctx.requestId).owner_pid !== null && alive(row(ctx.requestId).owner_pid), 3000));
    assert.match((await command(ctx)).stderr, /is grace, not waiting/);

    const owner = row(ctx.requestId).owner_pid;
    handoff.failHandoff(ctx.requestId, "test over", ["grace"]);
    assert.ok(await until(() => !alive(owner), 5000), "a fenced grace owner exits");
    assert.ok(alive(ctx.pane.pid));
  });

  it("human input postpones grace without cancelling the handoff epoch", needsTmux, async () => {
    const ctx = await readyLead();
    assert.equal((await command(ctx)).code, 0);
    await until(() => row(ctx.requestId).owner_pid !== null, 3000);
    const owner = row(ctx.requestId).owner_pid;
    await hook("prompt", payload("lead-claude-prompt.json"));
    const postponed = row(ctx.requestId);
    assert.equal(postponed.state, "postponed");
    assert.equal(postponed.pass, 2);
    assert.ok(await until(() => !alive(owner), 5000));
    assert.ok(alive(ctx.pane.pid));

    await hook("stop", payload("lead-claude-stop.json"));
    handoff.casHandoff(ctx.requestId, ["postponed"], { state: "requested" });
    assert.match((await command(ctx)).stderr, /refresh the pad/);
    db.prepare("UPDATE pads SET content = content || ' ', revision = revision + 1, updated_at = datetime('now') WHERE id = ?").run(ctx.padId);
    db.exec("UPDATE lead_turn_state SET human_prompt_at = datetime('now', '-10 minutes')");
    assert.equal((await command(ctx, { revision: 2 })).code, 0);
    ctx.pane.typeIntoBox();
    endGrace(ctx.requestId);
    assert.ok(await until(() => row(ctx.requestId).state === "postponed", 8000));
    assert.match(row(ctx.requestId).blocked_reason, /unsubmitted text/);
    assert.equal(row(ctx.requestId).pass, 3);
    assert.ok(alive(ctx.pane.pid), "the predecessor survives an override");
  });

  it("postponed handoff fences its old owner", needsTmux, async () => {
    const ctx = await readyLead();
    assert.equal((await command(ctx)).code, 0);
    await until(() => row(ctx.requestId).owner_pid !== null, 3000);
    const { owner_token: oldToken } = row(ctx.requestId);
    await hook("prompt", payload("lead-claude-prompt.json"));
    await hook("stop", payload("lead-claude-stop.json"));
    handoff.casHandoff(ctx.requestId, ["postponed"], { state: "grace", owner_token: "new-owner", attempt: 2, grace_started_at: "2000-01-01 00:00:00" });
    db.exec("UPDATE lead_turn_state SET human_prompt_at = datetime('now', '-10 minutes')");
    const stale = await runCli(["lead-handoff-grace", "--request", String(ctx.requestId), "--attempt", "1", "--token", oldToken], {
      cwd: projectDir, dataDir, env: { HIVE_AGENT_ID: "lead:r", HIVE_LEAD: "1" },
    });
    assert.equal(stale.code, 0);
    assert.equal(row(ctx.requestId).state, "grace");
    assert.equal(panePid(ctx.pane.pane), ctx.pane.pid);
  });

  it("grace owner respawns once and refuses changed or unknown ownership", needsTmux, async () => {
    const ctx = await readyLead({ stop: "stop-shell-running.json" });
    const worker = db
      .prepare(
        `INSERT INTO agents (project_id, actor_id, name, kind, tmux_target, pane_pid, command, cwd, status, parent_actor_id)
         VALUES (?, 'agent:crew', 'crew', 'agent', '%4242', '1', 'claude', '/tmp', 'running', 'lead:r') RETURNING id`,
      )
      .get(project).id;
    const watch = db
      .prepare(
        `INSERT INTO wakes (project_id, owner, body, kind, watch, deliver_actor, deliver_pane)
         VALUES (?, 'lead:r', 'crew finished', 'idle_any', '["crew"]', 'lead:r', ?) RETURNING id`,
      )
      .get(project, ctx.pane.pane).id;
    assert.equal((await command(ctx)).code, 0);
    endGrace(ctx.requestId);
    assert.ok(await until(() => /shell/.test(row(ctx.requestId).blocked_reason ?? ""), 8000));
    assert.equal(row(ctx.requestId).state, "grace");
    assert.ok(alive(ctx.pane.pid), "live background work vetoes the respawn");

    await hook("prompt", payload("lead-claude-prompt.json", { prompt: "[hive wake #1] notice" }));
    await hook("stop", payload("lead-claude-stop.json"));
    assert.ok(await until(() => row(ctx.requestId).state === "started", 10000), JSON.stringify(row(ctx.requestId)));
    const started = row(ctx.requestId);
    assert.ok(await until(() => existsSync(launched) && readFileSync(launched, "utf8").includes("Took over from session"), 5000));
    const record = readFileSync(launched, "utf8");
    const successorPid = record.split(" ")[0];
    assert.equal(panePid(ctx.pane.pane), successorPid, "the shell exec'd claude in the same pane process");
    assert.equal(started.successor_pane_pid, successorPid);
    assert.equal(db.prepare("SELECT pane_pid FROM agents WHERE id = ?").get(ctx.lead.id).pane_pid, successorPid);
    assert.ok(record.includes("--settings"));
    assert.ok(await until(() => !alive(ctx.pane.pid), 3000), "the predecessor process is gone");
    const crew = db.prepare("SELECT status, parent_actor_id FROM agents WHERE id = ?").get(worker);
    assert.deepEqual({ ...crew }, { status: "running", parent_actor_id: "lead:r" }, "the crew and its parent link survive");
    const standing = db.prepare("SELECT cancelled_at, deliver_actor FROM wakes WHERE id = ?").get(watch);
    assert.deepEqual({ ...standing }, { cancelled_at: null, deliver_actor: "lead:r" }, "the standing watch survives on the same lead row");
    assert.equal(readFileSync(launched, "utf8").split("Took over from session").length - 1, 1, "respawned exactly once");

    db.exec("DELETE FROM lead_handoffs; DELETE FROM agents; DELETE FROM lead_turn_state; DELETE FROM pads;");
    const moved = await readyLead();
    assert.equal((await command(moved)).code, 0);
    db.prepare("UPDATE agents SET pane_pid = '1' WHERE id = ?").run(moved.lead.id);
    endGrace(moved.requestId);
    assert.ok(await until(() => row(moved.requestId).state === "failed", 8000));
    assert.match(row(moved.requestId).failure, /no longer names the pane/);
    assert.equal(panePid(moved.pane.pane), moved.pane.pid, "a changed owner leaves the pane untouched");
  });

  it("a pass-2 grace waits out its human-quiet window before respawning", needsTmux, async () => {
    const ctx = await readyLead();
    db.prepare("UPDATE lead_handoffs SET pass = 2 WHERE id = ?").run(ctx.requestId);
    db.exec("UPDATE lead_turn_state SET human_prompt_at = datetime('now', '-100 seconds')");
    assert.equal((await command(ctx)).code, 0);
    assert.equal(row(ctx.requestId).grace_seconds, 90);
    endGrace(ctx.requestId);
    assert.ok(await until(() => /human prompt arrived in the last 150 s/.test(row(ctx.requestId).blocked_reason ?? ""), 8000));
    assert.equal(row(ctx.requestId).state, "grace");
    assert.equal(panePid(ctx.pane.pane), ctx.pane.pid);
    const owner = row(ctx.requestId).owner_pid;
    handoff.failHandoff(ctx.requestId, "test over", ["grace"]);
    assert.ok(await until(() => !alive(owner), 5000));
  });

  it("ambiguous respawn cannot kill a successor on retry", needsTmux, async () => {
    const ctx = await readyLead();
    assert.equal((await command(ctx)).code, 0);
    await until(() => row(ctx.requestId).owner_pid !== null, 3000);
    const owner = row(ctx.requestId).owner_pid;
    const token = row(ctx.requestId).owner_token;
    handoff.casHandoff(ctx.requestId, ["grace"], { state: "ambiguous", failure: "simulated timeout" });
    assert.ok(await until(() => !alive(owner), 5000));
    const retry = await runCli(["lead-handoff-grace", "--request", String(ctx.requestId), "--attempt", "1", "--token", token], {
      cwd: projectDir, dataDir, env: { HIVE_AGENT_ID: "lead:r", HIVE_LEAD: "1" },
    });
    assert.equal(retry.code, 0);
    assert.equal(panePid(ctx.pane.pane), ctx.pane.pid, "no second kill");
    handoff.driveLeadHandoff("lead:r", () => ({ warn: 3, stop: 10, auto_handoff: true }));
    assert.equal(row(ctx.requestId).state, "ambiguous");
    assert.equal(handoff.readHandoffGate(ctx.lead.id).holdAutomation, true, "the delivery fence stays up");
  });

  it("handoff fences predecessor exit but retains successor cleanup", async () => {
    const lead = db
      .prepare(
        `INSERT INTO agents (project_id, actor_id, name, kind, tmux_target, pane_pid, command, cwd, status)
         VALUES (?, 'lead:r', 'lead', 'lead', '%1', '200', 'claude', '/tmp', 'running') RETURNING *`,
      )
      .get(project);
    const proc = () =>
      db
        .prepare(
          `INSERT INTO agents (project_id, actor_id, name, kind, tmux_target, pane_pid, command, cwd, status)
           VALUES (?, 'cmd:dev', 'dev', 'command', '%77777', '1', 'sleep', '/tmp', 'running') RETURNING id`,
        )
        .get(project).id;
    const procId = proc();
    db.prepare(
      `INSERT INTO lead_handoffs (project_id, lead_agent_id, pane_target, predecessor_pane_pid, predecessor_session_id, reason, state,
         successor_pane_pid) VALUES (?, ?, '%1', '100', ?, 'warn', 'started', '200')`,
    ).run(project, lead.id, SESSION);
    const end = JSON.stringify({ ...fixture("session-end-prompt-input-exit.json"), session_id: SESSION });
    await hook("session_end", end);
    assert.equal(db.prepare("SELECT status FROM agents WHERE id = ?").get(procId).status, "running", "predecessor exit stops nothing");
    await hook("session_end", JSON.stringify({ ...fixture("session-end-prompt-input-exit.json"), session_id: "successor-session" }));
    assert.notEqual(db.prepare("SELECT status FROM agents WHERE id = ?").get(procId).status, "running", "a genuine successor exit still cleans up");
  });
});
