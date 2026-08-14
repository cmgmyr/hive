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

// TODO 387, OPTION (e). agent_spawn used to type a short `[hive]` line into a
// brand-new worker's pane and SUBMIT it (todo 373), creating a real turn hive
// asked for itself. Todo 384 found the actual cost of that turn: if a lead's
// real assignment landed while it was still running, it could be absorbed
// into it as an attachment with no `UserPromptSubmit` to clear the
// suppression, and since the ordinary dispatch shape is brief once and wait
// for the finish, that suppression was OPERATIONALLY PERMANENT for the worker
// it hit - not the "bounded, not permanent" residual todo 373 recorded.
//
// THIS FILE USED TO PIN THE SUPPRESS-THEN-CLEAR MECHANISM (todo 373) AND NOW
// PINS ITS REPLACEMENT: a spawned worker has NO TURN AT ALL until briefed.
// Nothing is typed into its pane, so there is no announcement, no latch to
// stamp, and no window for a real assignment to be absorbed into. The defect
// this file used to reproduce cannot recur structurally, because the turn it
// depended on no longer exists.
//
// EVERYTHING HERE IS REAL where it can be: a real agent_spawn, and for the
// regression case below, real Claude Code payloads (captured off the live
// store) driven through the BUILT dist/hook.js. Nothing hand-writes
// agent_state - .claude/rules/worker-state.md's "enumerate every path that
// can write the value" exists because two full lanes of #24 reasoned from an
// observed value to a presumed writer and neither checked.
const { hasTmux, cleanup } = isolateTmux("the spawn false-finish tests");
const NEEDS_TMUX = { skip: hasTmux ? false : "tmux is not installed" };

const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { db } = await import("../dist/db.js");
const { tick } = await import("../dist/scheduler.js");
const { sessionName } = await import("../dist/tmux.js");

const HOOK = join(DIST, "hook.js");
const payload = (name) => readFileSync(join(REPO, "test", "fixtures", "hook-payloads", name), "utf8");
const STOP_PAYLOAD = payload("stop-idle.json");
// This fixture used to be recognised specially as hive's OWN announcement
// text (isSpawnAnnouncement). It carries no special meaning anymore - reused
// below only as a stand-in for "some real prompt text", to prove the point
// that nothing about ITS CONTENT matters now, only whether hive typed it.
const FORMER_ANNOUNCEMENT_PAYLOAD = payload("prompt-spawn-announcement.json");
const USER_PROMPT_PAYLOAD = payload("prompt-user.json");

const OWNER = "lead:spawn-finish";

let mcp;
let projectId;

before(async () => {
  // agent_spawn still waits for the pane before returning (fix round 1,
  // finding 1: the wait outlives the announcement it was added for). The
  // plain fakeClaude() shell below never renders anything recognisable as
  // ready, so without a short ceiling every spawn in this file would burn
  // the full default wait for no reason - none of these cases are about
  // readiness, only about whether anything gets typed.
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

const addStandingWatch = () => seedStandingWatch(db, projectId, OWNER);

const noticeReporting = (watchId, name) =>
  standingNoticeBodies(db, watchId).find((body) => new RegExp(`^ {2}${name}: (?!GONE)`, "m").test(body));
const namedInReport = (watchId, name) => namedInStandingReport(db, watchId, name);
const wasReportedAsFinished = (watchId, name) => reportedAsFinished(db, watchId, name);

async function fireHook(event, stdin, actorId) {
  const { code } = await runNode(HOOK, [event], { dataDir: dirs.dataDir, env: { HIVE_AGENT_ID: actorId }, stdin });
  assert.equal(code, 0, "the hook must exit 0 - a failing hook would prove nothing about state");
}

async function spawnWorker(name) {
  const receipt = await mcp.call("agent_spawn", { name, command: fakeClaude() });
  const live = await liveAgentRow(mcp, name);
  const row = db
    .prepare("SELECT id, actor_id, tmux_target, resumed_at, agent_state FROM agents WHERE id = ?")
    .get(live.agent_id);
  return { row, receipt };
}

const logFor = (actorId) =>
  db.prepare("SELECT event, state FROM agent_state_log WHERE actor_id = ? ORDER BY id").all(actorId);

describe("todo 387: a spawned worker has no turn at all until briefed", NEEDS_TMUX, () => {
  it("nothing is typed into the pane, and the row carries no trace of a turn", async () => {
    const { row, receipt } = await spawnWorker("sf-no-turn");

    assert.equal(row.resumed_at, "", "launchAgent must not stamp resumed_at anymore - only resumeAgent's flip does");
    assert.equal(row.agent_state, "unknown", "no hook has fired, so the row's state is still its default");
    assert.deepEqual(logFor(row.actor_id), [], "no hook event of any kind - hive gave this worker nothing to react to");

    // The receipt's own shape: `ready` still reports whether the pane took
    // the terminal (fix round 1, finding 1 restored the wait behind it), but
    // nothing about its value gates any typing anymore - false here (the
    // 1ms ceiling above times out against a fakeClaude that renders nothing)
    // proves that on its own, not "ready and therefore untyped".
    assert.equal(typeof receipt.ready, "boolean");
    assert.equal(receipt.ready, false);
    assert.match(receipt.note, /never became ready/);
    assert.equal(receipt.tail, undefined, "no dialog fixture here, so there is nothing to name");
    assert.ok(receipt.brief_path, "the brief itself still rides the system prompt");

    const { output } = await mcp.call("agent_output", { name: "sf-no-turn" });
    assert.doesNotMatch(output, /\[hive\]/, "nothing hive typed should be on screen");
  });

  it("the standing watch shows an unbriefed worker without claiming the project is empty", async () => {
    const watchId = addStandingWatch();
    // THE MINIMUM WAVE SHAPE (mirrors the old file's own case): spawn the
    // crew, give one its real assignment, leave the other untouched.
    const assigned = await spawnWorker("sf-roster-assigned");
    const unbriefed = await spawnWorker("sf-roster-unbriefed");
    await fireHook("prompt", USER_PROMPT_PAYLOAD, assigned.row.actor_id);
    await fireHook("stop", STOP_PAYLOAD, assigned.row.actor_id);
    await tick({
      panes: new Set([assigned.row.tmux_target, unbriefed.row.tmux_target]),
      windows: new Set(),
    });

    const body = noticeReporting(watchId, "sf-roster-assigned");
    assert.ok(body, "setup: the assigned worker's real finish must be reported, or there is no notice to read");
    // agent_state defaults to 'unknown', which already satisfies the roster's
    // own `agent_state != 'idle'` filter - so an unbriefed worker under (e)
    // was never the silent-crew hazard todo 366/384 found for the old spawn
    // shape (where the announcement's own Stop latched a false 'idle'). It is
    // simply a worker whose state channel has nothing to say yet, and the
    // roster says so rather than denying it exists.
    assert.doesNotMatch(
      body,
      /Nothing else in this project is running right now/,
      "a live, unbriefed worker must stop the notice claiming the project is empty",
    );
    assert.match(body, /Still going:.*sf-roster-unbriefed/, "and it is named in the roster, honestly labelled");
  });

  it("a spawned worker that dies before ever being given anything is still reported", async () => {
    const watchId = addStandingWatch();
    const { row } = await spawnWorker("sf-death-unbriefed");

    db.prepare("UPDATE agents SET status = 'closed', closed_at = datetime('now') WHERE id = ?").run(row.id);
    await tick({ panes: new Set(), windows: new Set() });

    assert.ok(
      namedInReport(watchId, "sf-death-unbriefed"),
      "a spawned worker's death is real news even before its first assignment - " +
        "agent_state stays 'unknown', which standingGoneRows' != 'idle' clause already catches",
    );
    const body = standingNoticeBodies(db, watchId).find((b) => b.includes("sf-death-unbriefed:"));
    assert.match(
      body,
      /sf-death-unbriefed: GONE .* It was never given an assignment, so nothing was in flight\./,
      "a claude worker whose hook never fired at all gets the airtight message (todo 384 comment 944)",
    );
  });

  it("a never-touched worker with NO state channel does not get the airtight claim (fix round 1, finding 4)", async () => {
    const watchId = addStandingWatch();
    // A bash worker is kind='agent' (agent_spawn's own allowlist) but fires
    // no hooks at all - reportsAgentStateLog is false for it, same gate
    // reportUnbriefedWorkers already uses. Its state_changed_at is NULL
    // forever, exactly like a genuinely untouched claude worker's - the only
    // thing that tells them apart is whether hive can see this row's state
    // at all, and "never given an assignment, so nothing was in flight" is a
    // claim hive has no standing to make about a row it cannot observe.
    await mcp.call("agent_spawn", { name: "sf-bash-never-touched", command: "bash" });
    const live = await liveAgentRow(mcp, "sf-bash-never-touched");
    db.prepare("UPDATE agents SET status = 'closed', closed_at = datetime('now') WHERE id = ?").run(live.agent_id);
    await tick({ panes: new Set(), windows: new Set() });

    // Anchored to THIS worker's own line, not the whole body - sf-death-
    // unbriefed (the previous case) is a real claude worker in the SAME
    // notice and correctly DOES carry "never given an assignment" on its
    // own line, so a blanket doesNotMatch on the full body would fail for
    // the wrong reason. See resume-false-finish.test.mjs's matching case for
    // the same note.
    const body = standingNoticeBodies(db, watchId).find((b) => b.includes("sf-bash-never-touched:"));
    assert.match(
      body,
      /sf-bash-never-touched: GONE .* Check its branch, its todo and any pad it was writing/,
      "a row with no state channel must fall back to the honest 'go check' sentence, not the airtight claim",
    );
  });

  it("a real assignment is the worker's first and only turn, and its finish is reported", async () => {
    const watchId = addStandingWatch();
    const { row } = await spawnWorker("sf-real-first-turn");
    const snapshot = { panes: new Set([row.tmux_target]), windows: new Set() };

    await fireHook("prompt", USER_PROMPT_PAYLOAD, row.actor_id);
    await fireHook("stop", STOP_PAYLOAD, row.actor_id);
    await tick(snapshot);

    assert.equal(
      wasReportedAsFinished(watchId, "sf-real-first-turn"),
      true,
      "the worker's first turn is a real assignment, so its finish is real news",
    );
  });
});

describe("todo 384's regression: nothing suppresses an assignment landing immediately after spawn", NEEDS_TMUX, () => {
  // THE FAILING TEST, RED AGAINST THE BUILD BEFORE THIS COMMIT. Before todo
  // 387, launchAgent's INSERT stamped resumed_at at spawn and src/hook.ts
  // excepted hive's own announcement prompt from clearing it
  // (isSpawnAnnouncement). Replaying that exact sequence - a prompt event
  // carrying hive's former announcement text, then a stop - reproduced todo
  // 384's defect: the latch stayed set through it (the announcement's own
  // prompt did not count as "given something"), so the worker's real work
  // inside that same absorbed turn was suppressed, permanently, because the
  // ordinary dispatch shape never sends a second message to clear it.
  //
  // AFTER TODO 387, THE SAME SEQUENCE PROVES THE OPPOSITE, AND FOR THE RIGHT
  // REASON: launchAgent no longer stamps resumed_at at all, and hook.ts no
  // longer excepts any particular prompt text - every prompt a spawned worker
  // gets is a real one. So this fixture's text carries no special meaning
  // anymore; replaying it is simply replaying "some prompt, then a stop", and
  // the standing watch must report the finish because there is nothing left
  // to suppress it.
  it("a spawn immediately followed by an assignment - the two-for-two reproduction shape - reports the finish", async () => {
    const watchId = addStandingWatch();
    const { row } = await spawnWorker("sf-immediate-send");
    const snapshot = { panes: new Set([row.tmux_target]), windows: new Set() };

    await fireHook("prompt", FORMER_ANNOUNCEMENT_PAYLOAD, row.actor_id);
    await fireHook("stop", STOP_PAYLOAD, row.actor_id);
    await tick(snapshot);

    assert.equal(
      wasReportedAsFinished(watchId, "sf-immediate-send"),
      true,
      "todo 384: an assignment landing in the window right after spawn must not be suppressed - " +
        "this is the exact reproduction shape (spawn, then send, in the same tool block)",
    );
  });
});
