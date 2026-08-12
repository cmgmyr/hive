import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  UPSERT_ACTOR_SQL_PREFIX,
  clearHiveEnv,
  isolateTmux,
  namedInStandingReport,
  scratchDirs,
  seedDeadPaneLead,
  seedStandingWatch,
} from "./helpers.mjs";

// TODO 374. resumeAgent's flip un-closes a parked row in ONE statement that
// also clears the park stamp, and its pre-pane failure path used to put back
// status and closed_at AND NOTHING ELSE. So a resume that died before its pane
// came up left a row that was closed again with parked_at/parked_branch
// cleared, resumed_at stamped, agent_state reset to 'unknown' and a brand-new
// closed_at. The revert restored the row's LIFECYCLE and destroyed the facts
// the row existed to carry.
//
// TWO CONSEQUENCES, AND THIS FILE PINS BOTH, because the second is not the one
// the todo was filed for and is the worse of the two:
//   1. THE LANE STOPS READING AS PARKED. `hive status` no longer prints the
//      resume call for it, agent_resume's parked-row name preference (todo
//      364) no longer applies, and parked_branch - the fact that rebuilds a
//      removed worktree - is gone.
//   2. A STANDING WATCH FILES AN OBITUARY FOR IT. The reverted row satisfies
//      every clause of standingGoneRows (src/scheduler.ts), so the lead is
//      told that worker DIED and to go and excavate its branch, about a lane
//      sitting safe on disk exactly where it was parked. Verbatim the failure
//      markGoneReported exists to prevent for a deliberate park release,
//      reached through the door that lane did not walk.
//
// HOW THE FAILURE PATH IS REACHED, and it is the whole difficulty of testing
// this: the catch under test only runs when something throws BETWEEN the flip
// and paneUp = true. Every case here makes upsertActor's own INSERT throw,
// which is the method test/resume-actor-upsert-failure.test.mjs established
// for this exact gap, and the realistic failure with it - SQLITE_BUSY past
// busy_timeout under contention with a concurrent withWindowClaim holder.
// Nothing reaches tmux on that path, so no case here forks a pane.
//
// EVERY ASSERTION IS ON THE ROW, OR ON A STANDING WATCH'S NOTICE CONTENT,
// NEVER ON "resumeAgent threw". Asserting the throw passes against both
// versions - the pre-fix code throws the same error for the same reason - and
// the deciding fact is what is left behind.
//
// THE SILENCE ASSERTIONS ARE BACKED BY A POSITIVE CONTROL IN THE SAME TEST,
// which is what stops this file going vacuously green if the seeded watch ever
// stops being able to report anything at all. `namedInStandingReport` and
// `seedStandingWatch` are the suite's shared helpers rather than a private
// copy of the same SQL, for the reason their own header gives.
//
// BOTH WATCH ORDERINGS ARE COVERED, and which one a case builds is the whole
// question of whether its silence means anything - the fourth case works that
// out in full and is the place to read. Short version: a watch created BEFORE
// the row closed has no gone-cursor for it (the park and idle exclusions are
// FILTERS, so nothing is ever recorded while they hold), and that is the state
// the defect fires in; a watch created AFTER has one, and the fourth case
// builds that instead.
//
// THE MUTATIONS THESE DIE AGAINST, each run rather than reasoned about, with
// the case it actually killed:
//   - the pre-374 revert (status/closed_at only) -> the column case and both
//     obituary cases.
//   - dropping agent_state from RESUME_FLIP_COLUMNS -> the column case, the
//     ordinary-row obituary case, and the drift guard.
//   - dropping parked_branch -> the column case and the drift guard.
//   - dropping closed_at -> five of the six, including the seeded-cursor case,
//     which is built so that the episode key is the ONLY thing suppressing it.
//   - removing the revert's CAS -> the concurrent-park case.
const { hasTmux } = isolateTmux("the resume-revert restore tests");
clearHiveEnv();

const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;

const { db, migrate } = await import("../dist/db.js");
migrate();
const { addProject } = await import("../dist/context.js");
const { RESUME_FLIP_COLUMNS, parkAgentRow, resumeAgent, resumeFlipSql } = await import("../dist/spawn.js");
const { seedGoneCursor, tick } = await import("../dist/scheduler.js");

const project = addProject(dirs.projectDir, "rr");
const OWNER = "lead:rr";
seedDeadPaneLead(db, project.id, dirs.projectDir, OWNER);

// The snapshot is deliberately EMPTY, so the watch owner's own pane is not
// live: a filed notice is a real due-now timer, and the next tick would try to
// deliver it. A lead-owned wake whose pane is not live is HELD rather than
// typed, so these cases reach the code under test and stop short of typing at
// a terminal. Same method, and same reason, as test/standing-watch.test.mjs.
const SNAPSHOT = { panes: new Set(), windows: new Set() };

// Every flip-written column carries a DISTINCTIVE value, so a restore that
// writes a plausible-looking default instead of the recorded one still fails.
// created_at is old enough that janitor()'s settle window never applies to it.
const SEEDED = {
  status: "closed",
  closed_at: "2026-08-11 18:00:00",
  tmux_target: "%77",
  pane_pid: "4242",
  agent_state: "working",
  state_changed_at: "2026-08-11 17:59:00",
  parked_at: "2026-08-11 18:00:00",
  parked_branch: "todo-374-park-restore",
  resumed_at: "",
  tmux_socket: "/tmp/rr-socket/default",
  command: "claude --name rr",
};

let seq = 0;
function closedWorker(over = {}) {
  const row = { ...SEEDED, ...over };
  const name = `rr-${(seq += 1)}`;
  const id = db
    .prepare(
      `INSERT INTO agents (project_id, actor_id, name, cwd, kind, session_id, created_at,
          status, closed_at, tmux_target, pane_pid, agent_state, state_changed_at,
          parked_at, parked_branch, resumed_at, tmux_socket, command)
        VALUES (?, ?, ?, ?, 'agent', 'fake-session-id', datetime('now', '-300 seconds'),
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    )
    .get(
      project.id,
      `agent:${name}`,
      name,
      dirs.projectDir,
      row.status,
      row.closed_at,
      row.tmux_target,
      row.pane_pid,
      row.agent_state,
      row.state_changed_at,
      row.parked_at,
      row.parked_branch,
      row.resumed_at,
      row.tmux_socket,
      row.command,
    ).id;
  return { id, name };
}

// THE FAILURE INJECTION. upsertActor's INSERT runs inside resumeAgent's
// paneUp-guarded try and BEFORE placeAgentPane, so throwing there enters the
// catch with paneUp still false and no tmux fork attempted. `duringFailure`
// runs while the row is mid-resume - flipped to running with tmux_target='' -
// which is the only moment a concurrent writer's race can be staged.
//
// IT ASSERTS THE PATCH FIRED. If the intercepted literal ever stops matching,
// the patch silently never fires and resumeAgent SUCCEEDS against a real tmux
// fork, which would look exactly like a passing test.
function failedResume(agentId, name, duringFailure = () => {}) {
  const originalPrepare = db.prepare.bind(db);
  let threw = null;
  db.prepare = (sql) => {
    if (sql.startsWith(UPSERT_ACTOR_SQL_PREFIX)) {
      return {
        run: () => {
          duringFailure();
          throw new Error("SQLITE_BUSY: simulated pre-pane failure (todo 374)");
        },
      };
    }
    return originalPrepare(sql);
  };
  try {
    resumeAgent({
      agentId,
      actorId: `agent:${name}`,
      name,
      projectId: project.id,
      projectName: project.name,
      projectPath: project.path,
      cwd: dirs.projectDir,
      commandString: "claude --resume fake-session-id",
      placement: "window",
      parentActor: "test:rr",
    });
  } catch (e) {
    threw = String(e?.message);
  } finally {
    db.prepare = originalPrepare;
  }
  assert.match(
    threw ?? "",
    /SQLITE_BUSY/,
    "the injected failure never fired, so nothing was tested - check upsertActor's SQL literal",
  );
}

const rowNow = (id, columns) => db.prepare(`SELECT ${columns.join(", ")} FROM agents WHERE id = ?`).get(id);

describe(
  "a resume that fails before its pane comes up restores the row it flipped",
  { skip: hasTmux ? false : "tmux is not installed" },
  () => {
    it("puts back every column the flip wrote, not just status and closed_at", () => {
      const { id, name } = closedWorker();
      const before = rowNow(id, RESUME_FLIP_COLUMNS);

      failedResume(id, name);

      const after = rowNow(id, RESUME_FLIP_COLUMNS);
      // Against the SEEDED values, not only against `before`: `before` is read
      // out of the same row, so it would agree with a restore that wrote back
      // whatever it happened to find. These are the values this test chose.
      assert.equal(after.status, "closed", "a failed resume must not strand the row running");
      assert.equal(after.parked_at, SEEDED.parked_at, "the park stamp is what makes the lane findable");
      assert.equal(after.parked_branch, SEEDED.parked_branch, "parked_branch is what rebuilds a removed worktree");
      assert.equal(after.closed_at, SEEDED.closed_at, "a fresh closed_at invents a death that never happened");
      assert.equal(after.agent_state, SEEDED.agent_state, "agent_state decides standingGoneRows' idle exclusion");
      assert.equal(after.resumed_at, "", "the resume did not happen, so the latch it stamps must not survive");
      assert.deepEqual(after, before, "the revert is the flip's exact inverse: no column left changed");
      // A `deepEqual(Object.keys(after), RESUME_FLIP_COLUMNS)` used to sit here
      // and was DELETED rather than kept with a caveat: `after` is SELECTed
      // from that same list, so both sides shrink together and the assertion
      // cannot fail. It read as a coverage guarantee it never gave. What
      // actually holds the list to the flip is the drift guard below, and what
      // holds the VALUES is the literals above - both of which fail for real.
    });

    it("does not let a standing watch file an obituary for the parked lane it failed to pick up", async () => {
      const { id, name } = closedWorker();
      const watchId = seedStandingWatch(db, project.id, OWNER);

      // CONTROL. While the lane reads parked, the watch is silent about it -
      // standingGoneRows' own park exclusion.
      await tick(SNAPSHOT);
      assert.equal(
        namedInStandingReport(db, watchId, name),
        false,
        "control: a parked lane is not a death, so the watch must be silent about it",
      );

      failedResume(id, name);
      await tick(SNAPSHOT);

      assert.equal(rowNow(id, ["parked_at"]).parked_at, SEEDED.parked_at, "the park stamp is what the exclusion reads");
      assert.equal(
        namedInStandingReport(db, watchId, name),
        false,
        "a failed resume must not turn a parked lane into a death notice telling the lead to excavate its branch",
      );

      // POSITIVE CONTROL, AND IT IS WHAT STOPS THE TWO SILENCES ABOVE BEING
      // VACUOUS. Release the park by hand and tick again: same watch, same
      // row, same query - and now it DOES report. So the silence came from the
      // restored park stamp rather than from a watch that could never speak.
      db.prepare("UPDATE agents SET parked_at = '', parked_branch = '' WHERE id = ?").run(id);
      await tick(SNAPSHOT);
      assert.equal(
        namedInStandingReport(db, watchId, name),
        true,
        "positive control: with the park stamp gone this watch reports the row, so the silences above are real",
      );
    });

    it("does not let a standing watch file an obituary for an ordinary row that closed from idle", async () => {
      // THE SECOND DOOR, AND PARK IS NOT INVOLVED. A row that finished, went
      // idle and was closed is excluded from standingGoneRows by `agent_state
      // != 'idle'`. The flip resets agent_state to 'unknown', so a revert that
      // restores the park stamp and nothing else still hands that row to the
      // gone query. Restoring the park columns alone passes the case above and
      // fails this one.
      const { id, name } = closedWorker({ agent_state: "idle", parked_at: "", parked_branch: "" });
      const watchId = seedStandingWatch(db, project.id, OWNER);

      await tick(SNAPSHOT);
      assert.equal(
        namedInStandingReport(db, watchId, name),
        false,
        "control: a close from idle was already reported, so this watch is silent about it",
      );

      failedResume(id, name);
      await tick(SNAPSHOT);

      assert.equal(rowNow(id, ["agent_state"]).agent_state, "idle", "the idle exclusion is what keeps it out");
      assert.equal(
        namedInStandingReport(db, watchId, name),
        false,
        "a failed resume must not re-report a finish this watch had already accounted for",
      );

      // The same positive control, for the same reason: prove this watch can
      // speak about this row at all.
      db.prepare("UPDATE agents SET agent_state = 'working' WHERE id = ?").run(id);
      await tick(SNAPSHOT);
      assert.equal(
        namedInStandingReport(db, watchId, name),
        true,
        "positive control: with the idle exclusion gone this watch reports the row",
      );
    });

    it("stays silent for a watch created the supported way, whose own gone-cursor is seeded", async () => {
      // THE ADJUDICATION, WORKED OUT AGAINST THE CODE AND WRITTEN DOWN HERE SO
      // THE NEXT READER DOES NOT RE-DERIVE IT. Two counselors seats disagreed
      // about whether the two cases above test a real standing-watch state,
      // because `wake_when_idle` creates a watch and calls seedGoneCursor in
      // ONE transaction (src/tools/wakes.ts) while `seedStandingWatch` inserts
      // only the timer.
      //
      // THE ANSWER IS THAT BOTH ORDERINGS ARE REAL, AND THEY ARE DIFFERENT
      // STATES. seedGoneCursor seeds only rows that are ALREADY CLOSED when
      // the watch is created, so:
      //   WATCH CREATED BEFORE THE CLOSE - the ordinary case, and the ONLY one
      //     the defect needs. The lead has a standing watch up, parks the crew
      //     in the evening, and resumes in the morning. No cursor exists for
      //     that row, and not because the helper is convenient: while the lane
      //     sat parked, standingGoneRows' park exclusion is a FILTER and never
      //     wrote one (its own comment says so). The cases above build exactly
      //     that state.
      //   WATCH CREATED AFTER THE CLOSE - this case. A cursor DOES exist, keyed
      //     on the row's closed_at as the episode.
      // So the cases above are faithful, and this one covers the ordering they
      // do not. It also pins something no other case does: `closed_at`'s OWN
      // role in RESUME_FLIP_COLUMNS, ISOLATED. The row here is deliberately
      // NEITHER parked NOR idle, so neither of the two exclusions the other
      // cases rest on applies - the seeded cursor is the only thing keeping
      // this watch quiet, and the cursor is keyed on the row's closed_at as the
      // episode. So a revert that stamps a FRESH closed_at, which is exactly
      // what the pre-374 one did, makes an accounted-for death look like new
      // news. Dropping closed_at from the restore list turns this case red on
      // its own, which is the point of building it this way.
      const { id, name } = closedWorker({ agent_state: "working", parked_at: "", parked_branch: "" });
      const watchId = seedStandingWatch(db, project.id, OWNER);
      seedGoneCursor(watchId, project.id);

      // CONTROL, AND IT PROVES THE CURSOR IS REAL AND ACTIVE. This row passes
      // every other clause of standingGoneRows - closed, not parked, not idle -
      // so silence here is the cursor doing its job and nothing else.
      await tick(SNAPSHOT);
      assert.equal(
        namedInStandingReport(db, watchId, name),
        false,
        "control: the seeded cursor is what suppresses this row, since no other exclusion applies to it",
      );

      failedResume(id, name);
      await tick(SNAPSHOT);
      assert.equal(rowNow(id, ["closed_at"]).closed_at, SEEDED.closed_at, "the episode key must survive the revert");
      assert.equal(
        namedInStandingReport(db, watchId, name),
        false,
        "a failed resume must not re-open a death this watch had already accounted for",
      );

      // A FRESH closed_at IS A NEW EPISODE and the cursor no longer covers it -
      // precisely what main's revert stamped on every failed resume.
      db.prepare("UPDATE agents SET closed_at = datetime('now') WHERE id = ?").run(id);
      await tick(SNAPSHOT);
      assert.equal(
        namedInStandingReport(db, watchId, name),
        true,
        "positive control: a fresh closed_at defeats the seeded cursor, which is why closed_at is in the restore list",
      );
    });

    it("leaves the row alone when a concurrent park took it mid-resume", () => {
      // THE RACE recordPane ALREADY EXISTS FOR (.claude/rules/tmux-and-panes.md),
      // reached one statement later. The flip commits running with
      // tmux_target='', a concurrent agent_park reads targetLiveProbe('') as
      // FALSE rather than null, its CAS compares '' against '' and matches,
      // and the row goes closed+parked while this resume is still in flight.
      // An unpredicated restore then overwrites that park with the pre-flip
      // values - for THIS row, clearing parked_at outright, which is this
      // todo's own defect reintroduced by its own fix.
      //
      // Staged with the real parkAgentRow rather than a hand-written UPDATE,
      // so the CAS being satisfiable by tmux_target='' is part of what the
      // test proves rather than something it assumes.
      const { id, name } = closedWorker({ parked_at: "", parked_branch: "" });

      let parkedAt;
      failedResume(id, name, () => {
        parkedAt = parkAgentRow(id, "", "branch-from-the-concurrent-park");
      });

      assert.ok(parkedAt, "the staged park must actually have won its CAS, or this tests nothing");
      const after = rowNow(id, ["status", "parked_at", "parked_branch"]);
      assert.equal(after.status, "closed");
      assert.equal(after.parked_at, parkedAt, "the concurrent park's stamp must survive the revert");
      assert.equal(
        after.parked_branch,
        "branch-from-the-concurrent-park",
        "the revert must not overwrite a park a lead just performed and got a receipt for",
      );
    });

    it("restores exactly the columns the flip writes, read off the flip statement itself", () => {
      // THE DRIFT GUARD. RESUME_FLIP_COLUMNS drives both the capture SELECT
      // and the restore UPDATE, so a column ADDED to the flip and not to the
      // list would go unreverted with nothing failing - which is this todo's
      // own defect, one column at a time. Parsed off resumeFlipSql() rather
      // than a copy of it: a test that restates the statement is a test that
      // agrees with itself (decisions/2026-08-11-recordpane-guards-the-row-
      // not-the-caller.md's own trap).
      const setClause = resumeFlipSql().replace(/^UPDATE agents SET /, "").replace(/ WHERE .*$/, "");
      const written = setClause.split(",").map((assignment) => assignment.trim().split(/\s*=/)[0]);

      assert.ok(written.length > 5, `the SET clause parse produced ${written.length} columns - the format changed`);
      assert.deepEqual(
        [...written].sort(),
        [...RESUME_FLIP_COLUMNS].sort(),
        "every column resumeAgent's flip writes must be one the revert restores",
      );
    });
  },
);
