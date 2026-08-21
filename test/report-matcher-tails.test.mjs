import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { namedInStandingReport, reportedAsFinished, scratchDirs, standingNoticeBodies } from "./helpers.mjs";

const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { db, migrate } = await import("../dist/db.js");
const { tick } = await import("../dist/scheduler.js");
migrate();

const OWNER = "lead:report-tails";

const projectId = db
  .prepare("INSERT INTO projects (name, path) VALUES ('report-tails', '/tmp/report-tails') RETURNING id")
  .get().id;

db.prepare(
  `INSERT INTO agents (project_id, actor_id, name, tmux_target, command, cwd, kind, status, created_at)
     VALUES (?, ?, 'lead', '%deadlead', 'claude', '/tmp', 'lead', 'running', datetime('now', '-300 seconds'))`,
).run(projectId, OWNER);

const addFinisher = (name) =>
  db
    .prepare(
      `INSERT INTO agents (project_id, actor_id, name, tmux_target, command, cwd, kind, status,
          agent_state, state_changed_at, created_at)
         VALUES (?, ?, ?, ?, 'claude', '/tmp', 'agent', 'running', 'idle',
          datetime('now', '-1 seconds'), datetime('now', '-300 seconds')) RETURNING id`,
    )
    .get(projectId, `actor:${name}`, name, `%${name}`).id;

const addStillGoing = (name) =>
  db
    .prepare(
      `INSERT INTO agents (project_id, actor_id, name, tmux_target, command, cwd, kind, status,
          agent_state, created_at)
         VALUES (?, ?, ?, ?, 'claude', '/tmp', 'agent', 'running', 'working', datetime('now', '-300 seconds'))
         RETURNING id`,
    )
    .get(projectId, `actor:${name}`, name, `%${name}`).id;

const addStandingWatch = () =>
  db
    .prepare(
      `INSERT INTO timers (project_id, owner, body, kind, watch_scope, deliver_actor, deliver_pane,
          max_wait_at, created_at)
        VALUES (?, ?, 'crew update', 'idle_any', 'project', ?, '%deadlead',
          datetime('now', '+4 hours'), datetime('now', '-60 seconds')) RETURNING id`,
    )
    .get(projectId, OWNER, OWNER).id;

// FINISHED_SHOWN_CAP and ROSTER_STILL_GOING are both 8 in src/scheduler.ts. Ten of each is the
// minimum corpus that forces BOTH caps' overflow tails to actually render - fewer than 9 of either
// and the tail under test is never produced (.claude/sessions/common-issues/
// a-fixture-corpus-blind-to-a-dimension-nobody-chose.md).
const watchId = addStandingWatch();
const finisherNames = Array.from({ length: 10 }, (_, i) => `mt-fin-${i}`);
const stillGoingNames = Array.from({ length: 10 }, (_, i) => `mt-live-${i}`);
finisherNames.forEach(addFinisher);
stillGoingNames.forEach(addStillGoing);
// Every seeded pane must be alive in the snapshot: tick() reaps any running agent whose pane is
// missing from it as GONE, which would silently convert the "still going" half of this corpus into
// more finishers instead of leaving it running.
const allPanes = new Set([...finisherNames, ...stillGoingNames].map((n) => `%${n}`));

await tick({ panes: allPanes, windows: new Set() });

const body = standingNoticeBodies(db, watchId).find(Boolean);

describe("todo 476: the report matchers see structure the render folds into a tail", () => {
  it("setup: the seeded corpus really does overflow both caps, or nothing below tests anything", () => {
    assert.ok(body, "the batch must produce a notice");
    assert.match(body, /and \d+ more finish\(es\) not shown above\./, "the finish list must overflow FINISHED_SHOWN_CAP");
    assert.match(body, /Still going: .*, and \d+ more\./, "the roster must overflow ROSTER_STILL_GOING");
  });

  it("REGRESSION GUARD: a still-going roster name within the cap, with no claim row, must NOT be seen by namedInStandingReport", () => {
    // Second sighting of .claude/sessions/common-issues/a-bare-name-matcher-also-matches-the-still-
    // going-roster.md: matching the roster here re-collapses "reported" and "merely alive" into one.
    const withinCapRoster = stillGoingNames[0];
    assert.match(body, new RegExp(`(?:^Still going: |; )${withinCapRoster} \\(`, "m"), "setup: this name must really be in the roster, or this guard proves nothing");
    assert.equal(
      namedInStandingReport(db, watchId, withinCapRoster),
      false,
      "a live, still-going worker must never read as 'reported' just because the roster names it in passing",
    );
  });

  it("a finish folded past FINISHED_SHOWN_CAP has no name anywhere in the rendered text, yet the claim record still proves it was reported", () => {
    const folded = finisherNames[9];
    assert.doesNotMatch(
      body,
      new RegExp(folded),
      "setup: this name must be genuinely absent from the rendered text - it is the fold, not a visible entry",
    );
    assert.ok(
      namedInStandingReport(db, watchId, folded),
      "no regex over the rendered text can recover this name (src/scheduler.ts drops it to a bare count), " +
        "so the matcher reads wake_idle_notices - the claim every finish stamps regardless of whether it made the visible slice",
    );
    assert.ok(
      reportedAsFinished(db, watchId, folded),
      "the same claim record must also answer the finished-specifically question, not just 'named somewhere'",
    );
  });

  it("a still-going worker folded past ROSTER_STILL_GOING is a real, accepted gap: no claim record exists for it, so no matcher can recover it", () => {
    const folded = stillGoingNames[9];
    assert.doesNotMatch(body, new RegExp(folded), "setup: this name must be genuinely absent from the rendered text");
    assert.equal(
      namedInStandingReport(db, watchId, folded),
      false,
      "unlike a finish, a still-going worker leaves no wake_idle_notices row - the roster is a live snapshot, " +
        "not a claim - so a name folded past ROSTER_STILL_GOING has nothing left to check; this is not a bug in " +
        "the matcher, it is the render giving away less than a claim table would",
    );
  });
});
