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

// Issue #156's REAL DEFECT, D3. A resumed worker fires a Stop hook the moment
// its restore turn ends, and a standing watch reports that as "finished"
// BEFORE the worker has been given its assignment. Observed live twice; a lead
// that trusts the wake tears down a worker that never started.
//
// THIS FILE IS THE REPRODUCTION AND THE FIX IN ONE PLACE, and the reproduction
// half is why it can be trusted. Every step below is REAL: a real spawn, a real
// agent_park, a real agent_resume, and a real Claude Code Stop payload driven
// through the BUILT dist/hook.js (test/fixtures/hook-payloads/stop-idle.json,
// copied byte-for-byte off the live store). Nothing hand-writes agent_state,
// which is the whole point - .claude/rules/worker-state.md's "enumerate every
// path that can write the value" exists because two full lanes of #24 reasoned
// from an observed value to a presumed writer and neither checked.
//
// WHY THIS IS NOT THE STALE-IDLE DEFECT LANE A ALREADY FIXED. resumeAgent's
// flip resets agent_state to 'unknown' and state_changed_at to NULL, which
// closed the case where a PRE-CLOSE latch survived the resume and satisfied
// standingIdleRows on the first tick. This defect is the opposite: the idle
// here is GENUINE and FRESH, written by a real Stop hook seconds after the
// resume, so that reset cannot touch it and idleIsAFreshTransition is correctly
// true for it. A fix aimed at the latch would look right and do nothing.
const { hasTmux, cleanup } = isolateTmux("the resume false-finish tests");
const NEEDS_TMUX = { skip: hasTmux ? false : "tmux is not installed" };

const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { db } = await import("../dist/db.js");
const { tick } = await import("../dist/scheduler.js");
const { sessionName } = await import("../dist/tmux.js");

const HOOK = join(DIST, "hook.js");
const STOP_PAYLOAD = readFileSync(join(REPO, "test", "fixtures", "hook-payloads", "stop-idle.json"), "utf8");

// This file's own watch owner, distinct from the spawn sibling's: both seed a
// dead-paned lead, and an actor id shared between two files sharing a store
// would collide.
const OWNER = "lead:false-finish";

let mcp;
let projectId;

before(async () => {
  mcp = new McpClient({ cwd: dirs.projectDir, dataDir: dirs.dataDir, env: { HIVE_SPAWN_READY_MS: "1" } });
  await mcp.start();
  projectId = (await mcp.call("whoami")).project.id;
  // The watch's owner is a lead whose pane is deliberately NOT in any snapshot
  // below. A filed notice is a real due-now timer, so the next tick tries to
  // deliver it, and delivery types at a terminal; a lead-owned wake whose pane
  // is not live is HELD rather than typed (deliverable()'s lead exemption), so
  // these cases reach the code under test and stop short of a real paste. The
  // method is test/standing-watch.test.mjs's, for its reasons.
  seedDeadPaneLead(db, projectId, dirs.projectDir, OWNER);
});

after(async () => {
  await mcp.close();
  cleanup(sessionName());
});

const fakeClaude = makeFakeClaude(dirs.tmp);

// A standing watch over the project, seeded directly rather than through
// wake_when_idle so its owner is the dead-paned lead above.
const addStandingWatch = () => seedStandingWatch(db, projectId, OWNER);

// EVERY ASSERTION BELOW IS OVER NOTICE CONTENT, NEVER OVER A ROW COUNT, and
// that is a correctness requirement of this harness rather than a style choice.
// This file needs an McpClient (only the real tools can park and resume) AND an
// in-process tick(), and the MCP server starts a scheduler of its OWN on a
// 3000ms interval (startScheduler, src/index.ts) against this same store. So a
// SECOND, real tick can land inside any test here at any moment, with a REAL
// tmux snapshot rather than the synthetic one passed below - which sees every
// leftover worker from earlier tests in this file, several of which are
// legitimately idle and reportable. A `notices.length === 1` assertion is
// therefore a coin flip on machine load, and it failed exactly that way: green
// run after run in isolation, then red once under a full `npm test` where the
// concurrent files stretch a test past a 3s boundary.
//
// Counting was also the WRONG QUESTION. What every case here is about is
// whether a particular worker is named as finished, so asking that directly is
// both robust and more precise - and it stays red under mutation, since an
// unsuppressed restore turn puts that name in SOME notice regardless of how
// many notices exist.
//
// test/standing-watch.test.mjs can count because it has no MCP server at all -
// it drives tick() inside runFixture children. Do not copy its counting
// assertions here without also removing the server.
// BOTH MATCHERS ARE test/helpers.mjs's NOW, shared with the spawn-side sibling
// rather than copied into it (/simplify, two seats): they encode the notice
// FORMAT, and both files' headline assertions are silence assertions, so a
// stale second copy would answer false for every worker and go vacuously
// green. Why the match is anchored, and why GONE is excluded, is written where
// they live.
const namedInReport = (watchId, name) => namedInStandingReport(db, watchId, name);
const wasReportedAsFinished = (watchId, name) => reportedAsFinished(db, watchId, name);

const stateOf = (id) =>
  db.prepare("SELECT agent_state, state_changed_at FROM agents WHERE id = ?").get(id);

// The restore turn ending: a real Stop hook, for the resumed worker's own
// actor_id, carrying a payload Claude Code has actually been observed sending.
async function fireStopHook(actorId) {
  // "stop", not "Stop": the hook's own argv vocabulary is lower-case
  // (stateFor, src/hook.ts), and the capitalised Claude Code event name falls
  // through its default branch to "waiting" - a value that is never idle and
  // would have made this whole file quietly prove nothing.
  const { code } = await runNode(HOOK, ["stop"], {
    dataDir: dirs.dataDir,
    env: { HIVE_AGENT_ID: actorId },
    stdin: STOP_PAYLOAD,
  });
  assert.equal(code, 0, "the hook must exit 0 - a failing hook would prove nothing about state");
}

// Park and resume a fresh worker, returning its row. The full real path: the
// worker carries a session id from its own spawn (--session-id, issue #154),
// agent_park stamps the row, agent_resume reuses it.
async function parkAndResume(name) {
  await mcp.call("agent_spawn", { name, command: fakeClaude() });
  const live = await liveAgentRow(mcp, name);
  const spawned = db.prepare("SELECT actor_id FROM agents WHERE id = ?").get(live.agent_id);

  // THE WORKER IS GIVEN ITS LANE BEFORE IT IS PARKED, matching the real-world
  // shape: a park follows work. Todo 387 removed the reason this used to be
  // LOAD-BEARING (counselors F2, two seats) - launchAgent no longer stamps
  // resumed_at at spawn, so resumed_at is already '' before this prompt ever
  // fires, and the assertion below would hold with or without it. Kept for
  // the realism rather than deleted: a worker that was truly never spoken to
  // before a park is a different, narrower case than this file's subject
  // (issue #156's resume defect), and test/spawn-false-finish.test.mjs pins
  // that one - a spawned worker has no turn at all until briefed.
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

// A real UserPromptSubmit - the assignment finally arriving. This is the one
// event that clears the suppression, and driving it through the built hook
// rather than writing the column is what makes the clearing half real too.
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

    // Straight after the resume the row is exactly where a fresh spawn starts:
    // no claim about liveness until a real hook event makes one. This is lane
    // A's reset, and proving it here is what separates the two defects.
    const afterResume = stateOf(row.id);
    assert.equal(afterResume.agent_state, "unknown", "resumeAgent resets the latch (lane A's counselors fix)");
    assert.equal(afterResume.state_changed_at, null);

    await fireStopHook(row.actor_id);

    // And now the row says idle, freshly, with nothing having asked the worker
    // to do anything. THAT is the defect's premise: not a stale value, a true
    // one about a turn nobody wanted.
    const afterStop = stateOf(row.id);
    assert.equal(afterStop.agent_state, "idle", "the restore turn really does end in a Stop hook");
    assert.ok(afterStop.state_changed_at, "with a FRESH transition, which is why a latch reset cannot catch it");

    // Asserted over agent_state_log, never over a sample of agents.agent_state:
    // a sample is not evidence about a state machine (worker-state.md,
    // test/CLAUDE.md), and this row is overwritten in place.
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

    // A synthetic AliveSnapshot carrying the resumed worker's REAL pane, the
    // method test/scheduler.test.mjs established. The lead's %deadlead is
    // absent, so any notice is held rather than typed.
    const snapshot = { panes: new Set([row.tmux_target]), windows: new Set() };

    await fireStopHook(row.actor_id);
    await tick(snapshot);
    // BEFORE THE FIX THIS WAS 1, and the notice read the way the issue records
    // it: "t348-fixround: idle for 1s, last log event: stop (0s ago)" for a
    // worker that had not been given its assignment yet.
    assert.equal(
      wasReportedAsFinished(watchId, "ff-report"),
      false,
      "the restore turn must not be reported as a finish",
    );

    // THE OTHER HALF, AND THE ONE THAT MAKES THIS A SUPPRESSION RATHER THAN A
    // MUTE. The assignment arrives as a real user turn, the worker works, and
    // the finish after that is genuine news the lead is waiting on.
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

    // The defect was OBSERVED through a standing watch, but watchedStates
    // reads the same row for a one-shot over an explicit list. Fixing only the
    // half that was observed is how a defect ships twice.
    const oneShot = db
      .prepare(
        `INSERT INTO timers (project_id, owner, body, kind, watch, deliver_actor, deliver_pane,
           max_wait_at, created_at)
         VALUES (?, 'lead:false-finish', 'one-shot idle', 'idle_any', ?, 'lead:false-finish', '%deadlead',
           datetime('now', '+4 hours'), datetime('now', '-60 seconds')) RETURNING id`,
      )
      .get(projectId, JSON.stringify([row.id])).id;

    // ASSERTED ON held_at, NOT fired_at, and the reason is worth stating so a
    // later reader does not "fix" it back. maybeFireIdle decides `ready` and
    // then consults deliverable(), which HOLDS a lead-owned wake whose pane is
    // not live (HELD_REASON_LEAD_PANE_DEAD) - and %deadlead is deliberately
    // absent from every snapshot in this file, so no case here ever types at a
    // terminal. A held wake is never claimed, so fired_at stays null whether
    // the wake became ready or not, and asserting on it would pass against
    // both versions of the code. held_at moves only once the wake is READY,
    // which is precisely the decision under test.
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

    // THIS READER WAS MISSED ON THIS LANE'S FIRST PASS and is the reason the
    // predicate moved into stateProvenance.ts. wake_when_idle's mode="all"
    // shortcut reads agents.agent_state directly and returns before any
    // scheduler code runs, so the two fixes in src/scheduler.ts did nothing
    // for it: a lead that resumes a crew and immediately sets a mode="all"
    // wake was told every worker was already finished.
    // deliver_to names the worker itself: resolveDelivery runs BEFORE the
    // already_satisfied shortcut and refuses a caller that is not inside tmux,
    // which the test process is not. Its own pane is the one target here that
    // is guaranteed to exist, and the fake claude behind it does nothing with
    // what lands there.
    const watch = { agents: [row.id], mode: "all", body: "crew is done", deliver_to: "ff-allmode" };

    const receipt = await mcp.call("wake_when_idle", watch);
    assert.notEqual(
      receipt.status,
      "already_satisfied",
      "a restore turn must not satisfy an idle_all wake before the worker has been given anything",
    );
    // Scheduled rather than short-circuited, so cancel it: a real pending wake
    // left behind would be delivered by the MCP server's own scheduler during
    // a later test in this file.
    if (receipt.wake_id) await mcp.call("wake_cancel", { wake_id: receipt.wake_id });

    // And the shortcut still works for a worker that really has finished, or
    // this would be a mute rather than a suppression.
    await firePromptHook(row.actor_id);
    await fireStopHook(row.actor_id);
    const afterPrompt = await mcp.call("wake_when_idle", watch);
    assert.equal(afterPrompt.status, "already_satisfied", "a real finish still satisfies it immediately");
  });

  it("PARKING a worker is not a death, so a standing watch files no obituary for it", async () => {
    const watchId = addStandingWatch();
    await mcp.call("agent_spawn", { name: "ff-parked", command: fakeClaude() });
    const live = await liveAgentRow(mcp, "ff-parked");

    // A parked row is status='closed' with agent_state 'working' or 'unknown',
    // which is byte-for-byte what standingGoneRows was built to report: a
    // worker frozen mid-work with no terminal left to read. So every park used
    // to file one false obituary - "hive last read it as unknown ... check its
    // branch, its todo and any pad it was writing" - about a lane the lead had
    // just deliberately paused. At 18:00 with a crew of four, that is four.
    await mcp.call("agent_park", { name: "ff-parked" });
    await tick({ panes: new Set(), windows: new Set() });

    assert.equal(
      namedInReport(watchId, "ff-parked"),
      false,
      "a deliberate park must not be announced as a death",
    );

    // FOUND AS A FLAKE, WHICH IS WHY THE WINDOW IS NAMED HERE: the MCP
    // server runs its own 3s scheduler, and it sometimes ticked in the few
    // hundred milliseconds between the park and the resume in the tests below.
    // That read as test cross-talk and was the product.
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

    // THE ONE LINE THE TEST ABOVE STOPS SHORT OF. agent_close on a parked row
    // RELEASES the stamp: parked_at goes back to '' and nothing else on the
    // row moves - not closed_at, not agent_state. So on the very next tick the
    // row satisfies every clause of standingGoneRows again (closed, state
    // still 'working' or 'unknown', parked_at now '', closed_at not null), and
    // the episode is still unreported BECAUSE THE PARK SUPPRESSION WAS A
    // FILTER RATHER THAN A CLAIM - no cursor row was ever written for it.
    //
    // The lead abandons a lane at 09:00 and is told the worker DIED, with last
    // night's timestamp and instructions to go excavate its branch. That is
    // verbatim the failure the park exclusion exists to prevent, displaced by
    // one call.
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

    // The case that makes watching from outside worth doing at all is a turn
    // that dies mid-response: precisely the worker that cannot report itself.
    // Suppressing that alongside the restore turn would trade one silent
    // failure for a worse one.
    db.prepare("UPDATE agents SET status = 'closed', closed_at = datetime('now') WHERE id = ?").run(row.id);
    await tick({ panes: new Set(), windows: new Set() });

    assert.ok(
      namedInReport(watchId, "ff-death"),
      "a resumed worker's death is real news even before its first prompt",
    );

    // Todo 384 comment 944. hive knows resumed_at was still set when this row
    // closed, which means it was never given anything - so the ordinary
    // obituary's "check its branch, its todo and any pad it was writing" is
    // advice to go excavate work that cannot exist. Same row, same query,
    // different sentence.
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

    // COUNSELORS FOUND THIS AND THE TEST ABOVE IS WHY IT WAS MISSED: that one
    // kills the worker while agent_state is still 'unknown', so it never
    // touches the interesting shape. Here the restore turn ENDS first, which
    // freezes agent_state at 'idle' - and standingGoneRows excludes 'idle' on
    // the premise that an idle worker's finish "has already been reported".
    // The suppression is exactly what makes that premise false. Before the
    // fix, this worker was silent in BOTH halves: no finish (suppressed) and
    // no obituary (excluded as already-reported), forever.
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

    // FIX ROUND 1, FINDING 4. This is the exact row the reviewer named: a
    // resumed worker whose restore turn ENDED (state_changed_at is set by
    // that real Stop hook) while resumed_at is STILL set, because nothing
    // ever sent it a real assignment to clear the latch. hive cannot tell
    // from here whether that Stop was the restore alone or a restore that
    // absorbed a real assignment landing in the same busy window (the exact
    // shape #156 added the gone disjunct to report) - so it must NOT claim
    // "nothing was in flight" about a row it cannot see into. The first
    // version of this fix got this wrong, claiming resumed_at alone was
    // proof enough.
    // Anchored to THIS worker's own line, not the whole (batched) body: the
    // notice above also reports ff-parked/ff-abandon/ff-death from earlier
    // cases in this file, and they correctly DO carry "never given an
    // assignment" on their own lines - a blanket doesNotMatch on the full
    // body would fail for the wrong reason. The positive match below is
    // sufficient on its own: a GONE line carries exactly one of the two
    // sentences, never both, so proving it is the branch/todo/pad one
    // already proves it is not the other.
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

    // Both end a turn in the same tick. One is a restore turn, one is a real
    // finish by a worker that was never parked.
    //
    // THE NEIGHBOUR IS GIVEN ITS ASSIGNMENT FIRST - realism, not a load-
    // bearing requirement anymore. Todo 373 once made a plain spawn carry the
    // same suppression a resume does; todo 387 removed that (a fresh worker's
    // pane gets no turn at all until briefed, so there is nothing to suppress
    // even without the prompt below). Kept as the true-to-life control shape:
    // a real finish reported alongside a suppressed restore turn, in the same
    // tick.
    await fireStopHook(resumed.actor_id);
    await firePromptHook(plainRow.actor_id);
    await fireStopHook(plainRow.actor_id);
    await tick({ panes: new Set([resumed.tmux_target, plainRow.tmux_target]), windows: new Set() });

    // The whole case in two lines: the never-parked neighbour's finish is
    // news, the resumed worker's restore turn is not, and both ended a turn in
    // the same tick.
    assert.equal(wasReportedAsFinished(watchId, "ff-neighbour-plain"), true, "a real finish is still news");
    assert.equal(
      namedInReport(watchId, "ff-neighbour-resumed"),
      false,
      "the resumed worker must not appear in the finished block",
    );
  });
});
