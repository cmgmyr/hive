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

// TODO 373. A FRESHLY SPAWNED WORKER'S ANNOUNCEMENT TURN IS NOT A FINISH.
// agent_spawn types a short `[hive]` line into the new pane and SUBMITS it, so
// the worker answers it, that turn ends, Claude Code fires Stop, and the row
// latches idle before anyone has given that worker a lane. Every surface that
// answers "this worker is idle, act on it" then reports a finish for a worker
// that has been given nothing. Watched live four times in one evening, on
// every worker spawned during a wave, with a standing watch up - which the
// runbook tells every lead to have.
//
// ISSUE #156 CLOSED EXACTLY THIS FOR RESUME AND NOT FOR SPAWN, and
// test/resume-false-finish.test.mjs is this file's sibling: same defect, same
// readers, other door. The spawn half is the worse one, because a resume is a
// deliberate act by a lead who is standing there while a spawn under a
// standing watch is the ordinary dispatch path.
//
// THE ONE THING THAT DOES NOT CARRY OVER FROM THE RESUME HALF, and it is what
// the first case below exists to pin. A resume types NOTHING into the pane, so
// "the first `prompt` event" really is "the first moment anyone gave this
// worker anything". A spawn speaks first, and its announcement IS a real
// UserPromptSubmit: measured on todo 373's own worker, prompt|working at
// 03:49:25, the false stop|idle at 03:49:30, the lead's real assignment at
// 03:49:40. So a latch cleared on the first prompt is cleared BEFORE the idle
// it exists to suppress, and the fix would ship green and do nothing.
//
// EVERYTHING HERE IS REAL: a real agent_spawn, real Claude Code payloads
// (including the announcement one, captured byte-for-byte off the live store)
// driven through the BUILT dist/hook.js, and the real readers. Nothing
// hand-writes agent_state - .claude/rules/worker-state.md's "enumerate every
// path that can write the value" exists because two full lanes of #24 reasoned
// from an observed value to a presumed writer and neither checked.
const { hasTmux, cleanup } = isolateTmux("the spawn false-finish tests");
const NEEDS_TMUX = { skip: hasTmux ? false : "tmux is not installed" };

const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { db } = await import("../dist/db.js");
const { tick } = await import("../dist/scheduler.js");
const { sessionName } = await import("../dist/tmux.js");
const { renderDashboard } = await import("../dist/dashboard.js");
const { paneAnnouncement } = await import("../dist/brief.js");
const { isSpawnAnnouncement } = await import("../dist/firstPrompt.js");

const HOOK = join(DIST, "hook.js");
const payload = (name) => readFileSync(join(REPO, "test", "fixtures", "hook-payloads", name), "utf8");
const STOP_PAYLOAD = payload("stop-idle.json");
const ANNOUNCEMENT_PAYLOAD = payload("prompt-spawn-announcement.json");
const USER_PROMPT_PAYLOAD = payload("prompt-user.json");

// This file's own watch owner, distinct from the sibling file's: both seed a
// dead-paned lead, and an actor id shared between two files sharing a store
// would collide.
const OWNER = "lead:spawn-finish";

let mcp;
let projectId;

before(async () => {
  mcp = new McpClient({ cwd: dirs.projectDir, dataDir: dirs.dataDir, env: { HIVE_SPAWN_READY_MS: "1" } });
  await mcp.start();
  projectId = (await mcp.call("whoami")).project.id;
  // A lead whose pane is deliberately in no snapshot below, so a filed notice
  // is HELD rather than typed at a real terminal.
  seedDeadPaneLead(db, projectId, dirs.projectDir, OWNER);
});

after(async () => {
  await mcp.close();
  cleanup(sessionName());
});

const fakeClaude = makeFakeClaude(dirs.tmp);

// The watch seed and both matchers are test/helpers.mjs's, shared with
// test/resume-false-finish.test.mjs rather than copied: the matchers encode
// the notice FORMAT, and every headline assertion in both files is a silence
// assertion, so a stale copy would go vacuously green against exactly the
// defect these files exist to catch. Their reasoning - why the match is
// anchored, why GONE is excluded, why nothing here counts notices - is on
// them there.
const addStandingWatch = () => seedStandingWatch(db, projectId, OWNER);

// The notice that reported a given worker's finish, for the roster case below,
// which asserts about the REST of that notice's text. Anchored the same way
// the shared matchers are, so it cannot pick a notice that merely names the
// worker in its own roster line.
const noticeReporting = (watchId, name) =>
  standingNoticeBodies(db, watchId).find((body) => new RegExp(`^ {2}${name}: (?!GONE)`, "m").test(body));
const namedInReport = (watchId, name) => namedInStandingReport(db, watchId, name);
const wasReportedAsFinished = (watchId, name) => reportedAsFinished(db, watchId, name);

async function fireHook(event, stdin, actorId) {
  // "stop"/"prompt", not the capitalised Claude Code event names: the hook's
  // own argv vocabulary is lower-case (stateFor, src/hook.ts), and a
  // capitalised name falls through to "waiting", which is never idle and would
  // make this whole file quietly prove nothing.
  const { code } = await runNode(HOOK, [event], { dataDir: dirs.dataDir, env: { HIVE_AGENT_ID: actorId }, stdin });
  assert.equal(code, 0, "the hook must exit 0 - a failing hook would prove nothing about state");
}

// The two halves of a fresh worker's first turn, in the order Claude Code
// fires them: hive's own announcement arrives as a UserPromptSubmit, the
// worker answers it, and the turn ends in a Stop.
async function announcementTurn(actorId) {
  await fireHook("prompt", ANNOUNCEMENT_PAYLOAD, actorId);
  await fireHook("stop", STOP_PAYLOAD, actorId);
}

// The lead's real assignment, then the worker finishing it. This is the finish
// that must be reported, or the fix is a mute rather than a suppression.
async function assignmentAndRealFinish(actorId) {
  await fireHook("prompt", USER_PROMPT_PAYLOAD, actorId);
  await fireHook("stop", STOP_PAYLOAD, actorId);
}

async function spawnWorker(name) {
  await mcp.call("agent_spawn", { name, command: fakeClaude() });
  const live = await liveAgentRow(mcp, name);
  const row = db
    .prepare("SELECT id, actor_id, tmux_target, resumed_at FROM agents WHERE id = ?")
    .get(live.agent_id);
  assert.ok(
    row.resumed_at,
    "setup bug: a spawn must stamp the latch in its own INSERT, or nothing below tests the fix",
  );
  return row;
}

const logFor = (actorId) =>
  db
    .prepare("SELECT event, state FROM agent_state_log WHERE actor_id = ? ORDER BY id")
    .all(actorId)
    .map((r) => `${r.event}|${r.state}`);

const latchOf = (id) => db.prepare("SELECT resumed_at FROM agents WHERE id = ?").get(id).resumed_at;

describe("todo 373: a spawned worker's announcement turn is not a finish", NEEDS_TMUX, () => {
  it("THE TRAP: hive's own announcement is a real prompt event, and must not lift the suppression", async () => {
    const row = await spawnWorker("sf-premise");

    await fireHook("prompt", ANNOUNCEMENT_PAYLOAD, row.actor_id);
    // THE WHOLE LANE TURNS ON THIS LINE. Mirroring issue #156 exactly - clear
    // on the first `prompt` - clears here, seconds before the idle below, and
    // the fix does nothing. The announcement's own text says "wait for your
    // assignment"; it is hive speaking, not anybody giving this worker a lane.
    assert.ok(latchOf(row.id), "hive's own announcement must not read as somebody giving this worker work");

    await fireHook("stop", STOP_PAYLOAD, row.actor_id);
    const after = db.prepare("SELECT agent_state, state_changed_at FROM agents WHERE id = ?").get(row.id);
    assert.equal(after.agent_state, "idle", "the announcement turn really does end in a Stop hook");
    assert.ok(after.state_changed_at, "with a FRESH transition, which is why no latch reset can catch it");

    // Asserted over the SEQUENCE in agent_state_log, never a sample of
    // agents.agent_state: the row is overwritten in place, and a sample is not
    // evidence about a state machine (worker-state.md, test/CLAUDE.md).
    assert.deepEqual(
      logFor(row.actor_id),
      ["prompt|working", "stop|idle"],
      "prompt then stop, with the prompt being hive's own line - verbatim the live sequence on agent:208",
    );

    // And the real assignment does lift it, which is what makes this a
    // suppression rather than a permanent mute.
    await fireHook("prompt", USER_PROMPT_PAYLOAD, row.actor_id);
    assert.equal(latchOf(row.id), "", "a prompt that is NOT the announcement is somebody giving this worker work");
  });

  it("the announcement hive actually types is the one the hook recognises", () => {
    // The discrimination above is a text match, so its failure mode is silent:
    // reword the announcement and every spawn's false finish comes back with
    // nothing going red. Both directions are pinned here - the line hive
    // builds today, and the line a real spawn was observed sending (the
    // captured fixture this file replays).
    const line = paneAnnouncement({
      name: "sf-format",
      actorId: "agent:1",
      projectName: "hive",
      projectPath: "/tmp/p",
      cwd: "/tmp/p",
    });
    assert.ok(isSpawnAnnouncement(line), "paneAnnouncement must still be recognisable to src/hook.ts");
    assert.ok(
      isSpawnAnnouncement(JSON.parse(ANNOUNCEMENT_PAYLOAD).prompt),
      "and so must the announcement a real spawn was captured sending",
    );
    assert.equal(
      isSpawnAnnouncement(JSON.parse(USER_PROMPT_PAYLOAD).prompt),
      false,
      "an ordinary user prompt must not be mistaken for it, or nothing ever lifts the suppression",
    );
  });

  it("a standing watch stays quiet through the announcement turn, then reports the REAL finish", async () => {
    const watchId = addStandingWatch();
    const row = await spawnWorker("sf-report");
    const snapshot = { panes: new Set([row.tmux_target]), windows: new Set() };

    await announcementTurn(row.actor_id);
    await tick(snapshot);
    // BEFORE THE FIX THIS WAS THE LIVE FAILURE, word for word:
    // "sf-report: idle for 1s, last log event: stop (0s ago)" for a worker
    // that had been given nothing at all.
    assert.equal(
      wasReportedAsFinished(watchId, "sf-report"),
      false,
      "the announcement turn must not be reported as a finish",
    );

    await assignmentAndRealFinish(row.actor_id);
    await tick(snapshot);
    assert.equal(
      wasReportedAsFinished(watchId, "sf-report"),
      true,
      "the real finish must be reported - suppressing it would be the worse defect",
    );
  });

  it("a one-shot wake_when_idle over a named list gets the same suppression", async () => {
    const row = await spawnWorker("sf-oneshot");
    await announcementTurn(row.actor_id);

    // watchedStates (src/scheduler.ts) reads the same row for a one-shot over
    // an explicit list. Fixing only the surface the defect was watched through
    // is this project's single most repeated defect shape.
    const oneShot = db
      .prepare(
        `INSERT INTO timers (project_id, owner, body, kind, watch, deliver_actor, deliver_pane,
           max_wait_at, created_at)
         VALUES (?, ?, 'one-shot idle', 'idle_any', ?, ?, '%deadlead',
           datetime('now', '+4 hours'), datetime('now', '-60 seconds')) RETURNING id`,
      )
      .get(projectId, OWNER, JSON.stringify([row.id]), OWNER).id;

    // ASSERTED ON held_at, NOT fired_at: %deadlead is in no snapshot here, so
    // deliverable() HOLDS this wake and it is never claimed - fired_at stays
    // null whether or not the wake became ready, so asserting on it would pass
    // against both versions of the code. held_at moves only once the wake is
    // READY, which is the decision under test.
    const heldAt = () => db.prepare("SELECT held_at FROM timers WHERE id = ?").get(oneShot).held_at;
    const snapshot = { panes: new Set([row.tmux_target]), windows: new Set() };

    await tick(snapshot);
    assert.equal(heldAt(), null, "the announcement turn must not make a one-shot idle wake ready either");

    await assignmentAndRealFinish(row.actor_id);
    await tick(snapshot);
    assert.ok(heldAt(), "and the real finish still makes it ready");
  });

  it("wake_when_idle(mode: 'all') does not answer 'Act now' off an announcement turn", async () => {
    const row = await spawnWorker("sf-allmode");
    await announcementTurn(row.actor_id);

    // THE READER THAT NEVER REACHES THE SCHEDULER AT ALL. This shortcut is
    // exactly the call a lead makes after spawning a crew: spawn three
    // workers, set one wake on all of them, and be told they are already
    // finished. deliver_to names the worker itself because resolveDelivery
    // runs BEFORE the shortcut and refuses a caller that is not inside tmux,
    // which the test process is not.
    const watch = { agents: [row.id], mode: "all", body: "crew is done", deliver_to: "sf-allmode" };

    const receipt = await mcp.call("wake_when_idle", watch);
    assert.notEqual(
      receipt.status,
      "already_satisfied",
      "an announcement turn must not satisfy an idle_all wake before the worker has been given anything",
    );
    // Scheduled rather than short-circuited, so cancel it: a real pending wake
    // would be delivered by the MCP server's own scheduler during a later test.
    if (receipt.wake_id) await mcp.call("wake_cancel", { wake_id: receipt.wake_id });

    await assignmentAndRealFinish(row.actor_id);
    const afterAssignment = await mcp.call("wake_when_idle", watch);
    assert.equal(afterAssignment.status, "already_satisfied", "a real finish still satisfies it immediately");
  });

  it("the dashboard says so too - todo 366's reader, against a really spawned worker", async () => {
    const row = await spawnWorker("sf-dash");
    await announcementTurn(row.actor_id);

    // renderDashboard is pure (no tmux, no scheduler), so it can be called
    // straight against this store - and here it renders a REAL spawned
    // worker's row rather than a seeded one.
    //
    // ONE OCCURRENCE IS ENOUGH TO ASSERT HERE, and that is a limit of this
    // fixture rather than of the fix. src/dashboard.ts has TWO badge sites and
    // the NOW strip shows only the first NOW_AGENTS_SHOWN running rows; every
    // worker spawned by an earlier case in this file is still running, so
    // sf-dash falls outside that cap and only the In Flight badge can be
    // reached from here. The two-site property is pinned where the row count
    // is controllable: test/dashboard.test.mjs.
    //
    // SCOPED TO THIS WORKER'S OWN <li>, not to the whole page, for the same
    // reason the notice matchers above are anchored: every earlier case in
    // this file leaves a running worker behind, so a page-wide `includes`
    // would answer about the crew rather than about sf-dash.
    const inFlightBadge = (html) => {
      const item = html.split('<li class="agent">').find((chunk) => chunk.includes("sf-dash"));
      assert.ok(item, "setup: the worker must be rendered at all, or the assertion below proves nothing");
      return item.slice(0, item.indexOf("</li>"));
    };

    assert.match(
      inFlightBadge(renderDashboard(projectId)),
      /idle \(no assignment yet\)/,
      "a worker whose only completed turn is its own announcement must not render as a plain green idle",
    );

    await assignmentAndRealFinish(row.actor_id);
    assert.doesNotMatch(
      inFlightBadge(renderDashboard(projectId)),
      /no assignment yet/,
      "and a worker that finished real work renders as a plain idle again",
    );
  });

  it("the notice never says the project is empty while an unbriefed worker is live - the roster counts it", async () => {
    const watchId = addStandingWatch();
    // THE MINIMUM WAVE SHAPE, and it is the ordinary one: spawn the crew, brief
    // them serially. A is assigned and finishes; B was spawned in the same wave
    // and has not been given its lane yet.
    const assigned = await spawnWorker("sf-roster-assigned");
    const unbriefed = await spawnWorker("sf-roster-unbriefed");
    await announcementTurn(unbriefed.actor_id);
    await assignmentAndRealFinish(assigned.actor_id);
    await tick({ panes: new Set([assigned.tmux_target, unbriefed.tmux_target]), windows: new Set() });

    const body = noticeReporting(watchId, "sf-roster-assigned");
    assert.ok(body, "setup: the assigned worker's real finish must be reported, or there is no notice to read");
    // THE COUNSELORS' FINDING, ALL THREE SEATS. Suppressing the unbriefed
    // worker's finish is right; letting the roster then deny it exists is a
    // false statement, not an omission - and it is what a lead reads on a
    // phone, where no dashboard badge is on screen to correct it.
    assert.doesNotMatch(
      body,
      /Nothing else in this project is running right now/,
      "a live, unbriefed worker must stop the notice claiming the project is empty",
    );
    assert.match(
      body,
      /Still going:.*sf-roster-unbriefed \(awaiting first assignment\)/,
      "and it is named as awaiting its first assignment, not as 'idle for 0s'",
    );
  });

  it("a spawned worker that DIES before its first prompt is still reported - only the finish half is suppressed", async () => {
    const watchId = addStandingWatch();
    const row = await spawnWorker("sf-death");
    await announcementTurn(row.actor_id);

    // THE PAIRED INVARIANT, and the reason this lane widened one column rather
    // than adding a second. standingGoneRows excludes a closed row whose state
    // is 'idle' on the premise "idle means it finished and this watch already
    // said so" - which a suppression falsifies. Its clause is a WHERE clause
    // and cannot call the predicate, so a second column would have meant
    // remembering an OR here, in a string; the same column keeps both halves
    // in step with no edit. Before #156's own fix, the equivalent worker was
    // silent in BOTH halves, which is the worst outcome available.
    db.prepare("UPDATE agents SET status = 'closed', closed_at = datetime('now') WHERE id = ?").run(row.id);
    await tick({ panes: new Set(), windows: new Set() });

    assert.ok(
      namedInReport(watchId, "sf-death"),
      "a spawned worker's death is real news even before its first assignment",
    );
  });

  it("suppresses only the un-assigned worker, never a neighbour in the same crew", async () => {
    const watchId = addStandingWatch();
    const fresh = await spawnWorker("sf-neighbour-fresh");
    const working = await spawnWorker("sf-neighbour-working");

    // The neighbour has been given its lane and finishes it; the fresh worker
    // has only answered hive's own line. Both end a turn in the same tick.
    await assignmentAndRealFinish(working.actor_id);
    await announcementTurn(fresh.actor_id);
    await tick({ panes: new Set([fresh.tmux_target, working.tmux_target]), windows: new Set() });

    assert.equal(wasReportedAsFinished(watchId, "sf-neighbour-working"), true, "a real finish is still news");
    assert.equal(
      namedInReport(watchId, "sf-neighbour-fresh"),
      false,
      "the un-assigned worker must not appear in the finished block",
    );
  });
});
