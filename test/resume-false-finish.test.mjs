import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import {
  DIST,
  isolateTmux,
  liveAgentRow,
  makeFakeClaude,
  McpClient,
  namedInStandingReport,
  REPO,
  reportedAsFinished,
  runNode,
  scratchDirs,
  seedDeadPaneLead,
  seedStandingWatch,
  standingNoticeBodies,
} from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("the resume false-finish tests");
const NEEDS_TMUX = { skip: hasTmux ? false : "tmux is not installed" };

const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { db } = await import("../dist/db.js");
const { tick } = await import("../dist/scheduler.js");
const { sessionName } = await import("../dist/tmux.js");

const HOOK = join(DIST, "hook.js");
const STOP_PAYLOAD = readFileSync(join(REPO, "test", "fixtures", "hook-payloads", "stop-idle.json"), "utf8");

const OWNER = "lead:false-finish";

let mcp;
let projectId;

before(async () => {
  mcp = new McpClient({ cwd: dirs.projectDir, dataDir: dirs.dataDir, env: { HIVE_SPAWN_READY_MS: "1" } });
  await mcp.start();
  projectId = (await mcp.call("whoami")).project.id;

  seedDeadPaneLead(db, projectId, dirs.projectDir, OWNER);
});

after(async () => {
  await mcp.close();
  cleanup(sessionName());
});

const fakeClaude = makeFakeClaude(dirs.tmp);

const addStandingWatch = () => seedStandingWatch(db, projectId, OWNER);

const namedInReport = (watchId, name) => namedInStandingReport(db, watchId, name);
const wasReportedAsFinished = (watchId, name) => reportedAsFinished(db, watchId, name);

const stateOf = (id) =>
  db.prepare("SELECT agent_state, state_changed_at FROM agents WHERE id = ?").get(id);

async function fireStopHook(actorId) {

  const { code } = await runNode(HOOK, ["stop"], {
    dataDir: dirs.dataDir,
    env: { HIVE_AGENT_ID: actorId },
    stdin: STOP_PAYLOAD,
  });
  assert.equal(code, 0, "the hook must exit 0 - a failing hook would prove nothing about state");
}

async function parkAndResume(name) {
  await mcp.call("agent_spawn", { name, command: fakeClaude() });
  const live = await liveAgentRow(mcp, name);
  const spawned = db.prepare("SELECT actor_id FROM agents WHERE id = ?").get(live.agent_id);

  await firePromptHook(spawned.actor_id);
  assert.equal(
    db.prepare("SELECT resumed_at FROM agents WHERE id = ?").get(live.agent_id).resumed_at,
    "",
    "setup: the assignment must clear the spawn's own latch, or the assertion below cannot be about the resume",
  );

  await mcp.call("agent_park", { name });
  await mcp.call("agent_resume", { name });
  const row = db.prepare("SELECT id, actor_id, tmux_target, resumed_at FROM agents WHERE id = ?").get(live.agent_id);
  assert.ok(row.resumed_at, "setup bug: a resume must stamp resumed_at, or nothing below tests the fix");
  return row;
}

async function firePromptHook(actorId) {
  const { code } = await runNode(HOOK, ["prompt"], {
    dataDir: dirs.dataDir,
    env: { HIVE_AGENT_ID: actorId },
    stdin: readFileSync(join(REPO, "test", "fixtures", "hook-payloads", "prompt-user.json"), "utf8"),
  });
  assert.equal(code, 0);
}

describe("issue #156 D3: a resumed worker's restore turn is not a finish", NEEDS_TMUX, () => {
  it("REPRODUCTION: the restore Stop hook writes a genuine, fresh idle - the defect's premise, measured not assumed", async () => {
    const row = await parkAndResume("ff-premise");

    const afterResume = stateOf(row.id);
    assert.equal(afterResume.agent_state, "unknown", "resumeAgent resets the latch (lane A's counselors fix)");
    assert.equal(afterResume.state_changed_at, null);

    await fireStopHook(row.actor_id);

    const afterStop = stateOf(row.id);
    assert.equal(afterStop.agent_state, "idle", "the restore turn really does end in a Stop hook");
    assert.ok(afterStop.state_changed_at, "with a FRESH transition, which is why a latch reset cannot catch it");

    const log = db
      .prepare("SELECT event, state FROM agent_state_log WHERE actor_id = ? ORDER BY id")
      .all(row.actor_id);
    assert.deepEqual(
      log.map((r) => `${r.event}|${r.state}`).filter((e) => e.startsWith("stop")),
      ["stop|idle"],
      "one stop event, writing idle, with no prompt before it - the worker was never given anything",
    );
  });

  it("a standing watch stays quiet through the restore turn, then reports the REAL finish", async () => {
    const watchId = addStandingWatch();
    const row = await parkAndResume("ff-report");

    const snapshot = { panes: new Set([row.tmux_target]), windows: new Set() };

    await fireStopHook(row.actor_id);
    await tick(snapshot);

    assert.equal(
      wasReportedAsFinished(watchId, "ff-report"),
      false,
      "the restore turn must not be reported as a finish",
    );

    await firePromptHook(row.actor_id);
    assert.equal(
      db.prepare("SELECT resumed_at FROM agents WHERE id = ?").get(row.id).resumed_at,
      "",
      "a prompt is the first moment anyone gave this worker anything, and it lifts the suppression",
    );

    await fireStopHook(row.actor_id);
    await tick(snapshot);
    assert.equal(
      wasReportedAsFinished(watchId, "ff-report"),
      true,
      "the real finish must be reported - suppressing it would be the worse defect",
    );
  });

  it("a one-shot wake_when_idle over a named list gets the same suppression, not just the standing watch", async () => {
    const row = await parkAndResume("ff-oneshot");
    await fireStopHook(row.actor_id);

    const oneShot = db
      .prepare(
        `INSERT INTO timers (project_id, owner, body, kind, watch, deliver_actor, deliver_pane,
           max_wait_at, created_at)
         VALUES (?, 'lead:false-finish', 'one-shot idle', 'idle_any', ?, 'lead:false-finish', '%deadlead',
           datetime('now', '+4 hours'), datetime('now', '-60 seconds')) RETURNING id`,
      )
      .get(projectId, JSON.stringify([row.id])).id;

    const heldAt = () => db.prepare("SELECT held_at FROM timers WHERE id = ?").get(oneShot).held_at;

    const snapshot = { panes: new Set([row.tmux_target]), windows: new Set() };
    await tick(snapshot);
    assert.equal(heldAt(), null, "the restore turn must not make a one-shot idle wake ready either");

    await firePromptHook(row.actor_id);
    await fireStopHook(row.actor_id);
    await tick(snapshot);
    assert.ok(heldAt(), "and the real finish still makes it ready");
  });

  it("wake_when_idle(mode: 'all') does not answer 'Act now' off a restore turn - the third idle reader", async () => {
    const row = await parkAndResume("ff-allmode");
    await fireStopHook(row.actor_id);

    const watch = { agents: [row.id], mode: "all", body: "crew is done", deliver_to: "ff-allmode" };

    const receipt = await mcp.call("wake_when_idle", watch);
    assert.notEqual(
      receipt.status,
      "already_satisfied",
      "a restore turn must not satisfy an idle_all wake before the worker has been given anything",
    );

    if (receipt.wake_id) await mcp.call("wake_cancel", { wake_id: receipt.wake_id });

    await firePromptHook(row.actor_id);
    await fireStopHook(row.actor_id);
    const afterPrompt = await mcp.call("wake_when_idle", watch);
    assert.equal(afterPrompt.status, "already_satisfied", "a real finish still satisfies it immediately");
  });

  it("PARKING a worker is not a death, so a standing watch files no obituary for it", async () => {
    const watchId = addStandingWatch();
    await mcp.call("agent_spawn", { name: "ff-parked", command: fakeClaude() });
    const live = await liveAgentRow(mcp, "ff-parked");

    await mcp.call("agent_park", { name: "ff-parked" });
    await tick({ panes: new Set(), windows: new Set() });

    assert.equal(
      namedInReport(watchId, "ff-parked"),
      false,
      "a deliberate park must not be announced as a death",
    );

    await mcp.call("agent_resume", { name: "ff-parked" });
    assert.equal(
      namedInReport(watchId, "ff-parked"),
      false,
      "and resuming it says nothing either - nothing about this lane was news",
    );
    await mcp.call("agent_close", { name: "ff-parked" });
    assert.ok(live.agent_id);
  });

  it("ABANDONING a park says nothing either - the release must not file the obituary the park suppressed", async () => {
    const watchId = addStandingWatch();
    await mcp.call("agent_spawn", { name: "ff-abandon", command: fakeClaude() });
    const live = await liveAgentRow(mcp, "ff-abandon");

    await mcp.call("agent_park", { name: "ff-abandon" });
    const snapshot = { panes: new Set(), windows: new Set() };
    await tick(snapshot);
    assert.equal(
      namedInReport(watchId, "ff-abandon"),
      false,
      "setup: the park itself is silent, which the test above already pins",
    );

    await mcp.call("agent_close", { agent_id: live.agent_id });
    await tick(snapshot);

    assert.equal(
      namedInReport(watchId, "ff-abandon"),
      false,
      "abandoning a parked lane is a decision, not a death - the lead already knows",
    );
  });

  it("a resumed worker that DIES mid-restore is still reported - only the finish half is suppressed", async () => {
    const watchId = addStandingWatch();
    const row = await parkAndResume("ff-death");

    db.prepare("UPDATE agents SET status = 'closed', closed_at = datetime('now') WHERE id = ?").run(row.id);
    await tick({ panes: new Set(), windows: new Set() });

    assert.ok(
      namedInReport(watchId, "ff-death"),
      "a resumed worker's death is real news even before its first prompt",
    );

    const body = standingNoticeBodies(db, watchId).find((b) => b.includes("ff-death:"));
    assert.match(
      body,
      /ff-death: GONE .* It was never given an assignment, so nothing was in flight\./,
      "a never-briefed worker's obituary must not send the lead looking for branch/todo/pad state",
    );
    assert.doesNotMatch(body, /Check its branch/);
  });

  it("a resumed worker that dies AFTER its restore turn is reported too - the case the title above did not cover", async () => {
    const watchId = addStandingWatch();
    const row = await parkAndResume("ff-death-after-stop");

    await fireStopHook(row.actor_id);
    assert.equal(
      db.prepare("SELECT agent_state FROM agents WHERE id = ?").get(row.id).agent_state,
      "idle",
      "setup bug: the restore turn must have latched idle, or this tests nothing",
    );

    db.prepare("UPDATE agents SET status = 'closed', closed_at = datetime('now') WHERE id = ?").run(row.id);
    await tick({ panes: new Set(), windows: new Set() });

    assert.ok(
      namedInReport(watchId, "ff-death-after-stop"),
      "a death that follows a SUPPRESSED idle is still a death, and nothing else will ever mention it",
    );

    const body = standingNoticeBodies(db, watchId).find((b) => b.includes("ff-death-after-stop:"));
    assert.match(
      body,
      /ff-death-after-stop: GONE .* Check its branch, its todo and any pad it was writing/,
      "a row whose hook DID fire must not get the 'nothing was in flight' claim - hive cannot rule out absorbed work",
    );
  });

  it("suppresses only the resumed worker, never its neighbours in the same crew", async () => {
    const watchId = addStandingWatch();
    const resumed = await parkAndResume("ff-neighbour-resumed");

    await mcp.call("agent_spawn", { name: "ff-neighbour-plain", command: fakeClaude() });
    const plain = await liveAgentRow(mcp, "ff-neighbour-plain");
    const plainRow = db.prepare("SELECT actor_id, tmux_target FROM agents WHERE id = ?").get(plain.agent_id);

    await fireStopHook(resumed.actor_id);
    await firePromptHook(plainRow.actor_id);
    await fireStopHook(plainRow.actor_id);
    await tick({ panes: new Set([resumed.tmux_target, plainRow.tmux_target]), windows: new Set() });

    assert.equal(wasReportedAsFinished(watchId, "ff-neighbour-plain"), true, "a real finish is still news");
    assert.equal(
      namedInReport(watchId, "ff-neighbour-resumed"),
      false,
      "the resumed worker must not appear in the finished block",
    );
  });
});
