import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { DIST, isolateTmux, McpClient, runFixture, scratchDirs, until } from "./helpers.mjs";

// Todo 315. wake_when_idle is a ONE-SHOT: it fires once and stops watching, so
// a lead running three to five workers is structurally guaranteed to miss a
// finish. wake_when_idle(scope: "project") is a STANDING watch that keeps
// watching and reports each crew member as it finishes or goes away.
//
// EVERY ASSERTION HERE IS OVER A RECORD OF WHAT HAPPENED - timers rows, and
// wake_idle_notices rows - never over a sample of agents.agent_state
// (.claude/rules/worker-state.md, test/CLAUDE.md). The notice IS a timers row,
// so COUNTING those rows is what makes the cursor testable at all: a watch
// with no cursor files one every three seconds forever, and a watch with a
// broken cursor files none at all, and those two are only distinguishable by
// a count across ticks.
//
// THE SCHEDULER TESTS DRIVE tick() DIRECTLY, in a child process, with a
// SYNTHETIC AliveSnapshot literal - the method test/scheduler.test.mjs
// established. A pane in the snapshot is alive; one that is not is dead. That
// is the whole tmux dependency for the standing watch's own decisions, which
// touch no tmux at all: they are store reads and one INSERT.
//
// WHY THE OWNER IS A LEAD WHOSE PANE IS DEAD, in every fixture but the expiry
// one. A filed notice is a real due-now timer, so the NEXT tick tries to
// deliver it, and delivery is a tmux fork. A lead-owned wake whose pane is not
// live is HELD rather than cancelled or typed (deliverable()'s lead
// exemption), so these fixtures reach the exact code under test and stop
// short of typing at a terminal. The one fixture that DOES want a delivery
// says so.
const { hasTmux, cleanup } = isolateTmux("the standing watch tests");
const NEEDS_TMUX = { skip: hasTmux ? false : "tmux is not installed" };

const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;

// TMUX_TMPDIR is forwarded into every fixture child on purpose. A fixture that
// does reach a tmux fork (the expiry one, and any accidental future path) must
// land on this suite's own private socket rather than the developer's server;
// paired with the scratch HIVE_DATA_DIR below, that is the isolation
// .claude/rules/tmux-and-panes.md allows, and the pairing it refuses is a
// private socket with the DEFAULT store.
const fixtureEnv = (dataDir) => ({ HIVE_DATA_DIR: dataDir, TMUX_TMPDIR: process.env.TMUX_TMPDIR });

const IMPORTS =
  `const { db, migrate } = await import(${JSON.stringify(join(DIST, "db.js"))});\n` +
  `const { tick, seedGoneCursor } = await import(${JSON.stringify(join(DIST, "scheduler.js"))});\n` +
  "migrate();\n";

// One project, one lead that owns the watch, and helpers to add crew. Every
// row is older than SETTLE_WINDOW so the janitor judges it rather than giving
// it spawn grace, which is what makes "this pane is not in the snapshot" mean
// "gone" here instead of "not born yet".
const SEED = `
const project = db.prepare("INSERT INTO projects (name, path) VALUES ('sw', '/tmp/sw') RETURNING id").get().id;
db.prepare(
  \`INSERT INTO agents (project_id, actor_id, name, tmux_target, command, cwd, kind, status, created_at)
    VALUES (?, 'lead:1', 'lead', '%lead', 'claude', '/tmp', 'lead', 'running', datetime('now', '-300 seconds'))\`,
).run(project);
const addWorker = (actor, name, pane, state, changedOffset) =>
  db.prepare(
    \`INSERT INTO agents (project_id, actor_id, name, tmux_target, command, cwd, kind, status,
        agent_state, state_changed_at, created_at)
      VALUES (?, ?, ?, ?, 'claude', '/tmp', 'agent', 'running', ?,
        datetime('now', ?), datetime('now', '-300 seconds')) RETURNING id\`,
  ).get(project, actor, name, pane, state, changedOffset).id;
const addStandingWatch = (createdOffset = '-60 seconds', maxWait = '+4 hours', opts = {}) =>
  db.prepare(
    \`INSERT INTO timers (project_id, owner, body, kind, watch_scope, deliver_actor, deliver_pane,
        max_wait_at, created_at)
      VALUES (?, ?, ?, 'idle_any', 'project', ?, ?,
        datetime('now', ?), datetime('now', ?)) RETURNING id\`,
  ).get(
    project,
    opts.owner ?? 'lead:1',
    opts.body ?? 'crew update',
    opts.deliverActor ?? 'lead:1',
    opts.deliverPane ?? '%lead',
    maxWait,
    createdOffset,
  ).id;
const logRow = (actor, event, state, offset) =>
  db.prepare(
    "INSERT INTO agent_state_log (actor_id, event, state, created_at) VALUES (?, ?, ?, strftime('%Y-%m-%d %H:%M:%f', 'now', ?))",
  ).run(actor, event, state, offset);
const notices = (watchId) =>
  db.prepare("SELECT id, body, watch, owner, deliver_actor, deliver_pane, fired_at, cancelled_at FROM timers WHERE parent_timer_id = ? ORDER BY id").all(watchId);
const watchRow = (watchId) => db.prepare("SELECT fired_at, fire_count, cancelled_at FROM timers WHERE id = ?").get(watchId);
const cursor = (watchId) =>
  db.prepare("SELECT agent_id, condition, episode, notice_timer_id FROM wake_idle_notices WHERE timer_id = ? ORDER BY agent_id, condition").all(watchId);
`;

// The lead's own pane is deliberately absent: see the file header.
const SNAPSHOT = (panes) => `const snapshot = { panes: new Set(${JSON.stringify(panes)}), windows: new Set() };\n`;

const fixture = (name, body, panes = ["%1", "%2"]) => {
  const { dataDir, tmp } = scratchDirs();
  return runFixture(tmp, name, IMPORTS + SEED + SNAPSHOT(panes) + body, fixtureEnv(dataDir));
};

const out = (expr) => `process.stdout.write(JSON.stringify(${expr}));\n`;

describe("a standing watch keeps watching", () => {
  it("reports each finish as it happens, and never fires its own row", () => {
    const result = fixture(
      "keeps-watching",
      `
      const w1 = addWorker('agent:1', 'w1', '%1', 'working', '-120 seconds');
      const w2 = addWorker('agent:2', 'w2', '%2', 'working', '-120 seconds');
      const watchId = addStandingWatch();

      // Nothing has finished: the watch must be silent, and must not have
      // taken the store's writer slot for a cursor row either.
      await tick(snapshot);
      const quiet = { notices: notices(watchId).length, cursor: cursor(watchId).length };

      // w1 finishes.
      db.prepare("UPDATE agents SET agent_state = 'idle', state_changed_at = datetime('now') WHERE id = ?").run(w1);
      await tick(snapshot);
      const afterFirst = notices(watchId);

      // w2 finishes LATER, which is exactly the finish a one-shot loses: it
      // would have fired on w1 and stopped watching.
      db.prepare("UPDATE agents SET agent_state = 'idle', state_changed_at = datetime('now') WHERE id = ?").run(w2);
      await tick(snapshot);
      const afterSecond = notices(watchId);

      ${out(`{
        quiet,
        first: afterFirst.map((n) => n.body),
        noticeWatchLists: afterFirst.map((n) => n.watch),
        second: afterSecond.map((n) => n.body),
        watch: watchRow(watchId),
      }`)}
      `,
    );

    assert.deepEqual(result.quiet, { notices: 0, cursor: 0 }, "a tick with nothing to report must write nothing at all");
    assert.equal(result.first.length, 1, "w1's finish should have filed exactly one notice");
    assert.match(result.first[0], /w1/);
    assert.doesNotMatch(result.first[0], /^ {2}w2:/m, "w2 had not finished and must not be in the finished block");
    assert.match(result.first[0], /Still going: w2/, "the roster names what is still running");
    // A notice carries the DEFAULT EMPTY watch list, and that is not
    // incidental: deliver() calls watchedTail() unconditionally, and for a
    // non-empty list it runs capture-pane for up to three agents and embeds
    // their SCREENS in the body it types into the lead's own pane. Putting
    // the crew in a notice's watch list is the obvious-looking way to build
    // the roster, and it is the one thing that would turn a compact roster
    // into three worker terminals plus three tmux forks per notice in the
    // hottest loop hive has.
    assert.deepEqual(result.noticeWatchLists, ["[]"], "a notice must watch nothing, or deliver() pastes worker screens");

    // TODO 390: w2's LATER finish must still be reported (this is the
    // one-shot's own defect), but while the pane stays held it must update
    // the SAME pending notice rather than queue a second one behind it.
    assert.equal(result.second.length, 1, "the pane is still held; a second finish must not queue a second notice");
    assert.match(result.second[0], /w2/);
    assert.match(result.second[0], /w1/, "and the earlier finish must still be named in the merged notice");

    assert.equal(result.watch.fired_at, null, "the watch's own row must never fire while it is watching");
    assert.equal(result.watch.fire_count, 0);
  });

  // THE CONFIGURATION THE FIRST VERSION OF THIS FEATURE WAS INERT IN, and
  // which the whole suite ran as without noticing. resolveDelivery
  // (src/tools/wakes.ts) deliberately accepts a session with NO agents row,
  // falling back to the TMUX_PANE it is running in - a plain claude session,
  // or anything using the documented HIVE_AGENT_ID identity. Notices used to
  // be filed at ownerPane(), which is a lookup in `agents` and answers null
  // for exactly that caller, so the watch reported nothing for its whole life
  // and then delivered a working expiry wake saying it had ended.
  it("reports finishes for an owner that has no agents row at all", () => {
    const result = fixture(
      "rowless-owner",
      `
      const w1 = addWorker('agent:1', 'w1', '%1', 'idle', '-30 seconds');
      const watchId = addStandingWatch('-60 seconds', '+4 hours', {
        owner: 'user:no-row-at-all',
        deliverActor: 'user:no-row-at-all',
        deliverPane: '%lead',
      });
      const ownerRows = db.prepare("SELECT COUNT(*) AS n FROM agents WHERE actor_id = 'user:no-row-at-all'").get().n;
      await tick(snapshot);
      const filed = notices(watchId);
      ${out("{ ownerRows, bodies: filed.map((n) => n.body), panes: filed.map((n) => n.deliver_pane) }")}
      `,
      // %lead IS in this fixture's snapshot, unlike every other one here, and
      // that is not a detail. A rowless owner is by definition not a `lead:`
      // actor, so the janitor's timers sweep has no exemption to give it: a
      // watch whose delivery pane is not live gets CANCELLED on the first
      // tick, before any of this runs. Correct, pre-existing behaviour, and
      // it only became reachable for a standing watch once notices started
      // going to deliver_pane - which is exactly why the fixture has to be
      // honest about the pane being alive.
      ["%1", "%lead"],
    );
    assert.equal(result.ownerRows, 0, "the fixture must really be the rowless case, or it proves nothing");
    assert.equal(result.bodies.length, 1, "a session with no agents row still gets told; it has a pane either way");
    assert.match(result.bodies[0], /w1/);
    assert.deepEqual(result.panes, ["%lead"], "and it is told at the pane the wake itself resolved");
  });

  it("files notices at deliver_to, the target the receipt named", () => {
    // deliver_to is resolved at creation, stored, and echoed back. Filing at
    // the owner instead makes one wake with two destinations, where the
    // receipt names the one that gets almost nothing.
    const result = fixture(
      "deliver-to-target",
      `
      const w1 = addWorker('agent:1', 'w1', '%1', 'idle', '-30 seconds');
      const reviewer = addWorker('agent:9', 'reviewer', '%9', 'working', '-120 seconds');
      const watchId = addStandingWatch('-60 seconds', '+4 hours', {
        owner: 'lead:1',
        deliverActor: 'agent:9',
        deliverPane: '%9',
      });
      await tick(snapshot);
      const filed = notices(watchId);
      ${out(`{
        panes: filed.map((n) => n.deliver_pane),
        actors: filed.map((n) => n.deliver_actor),
        owners: filed.map((n) => n.owner),
        bodies: filed.map((n) => n.body),
      }`)}
      `,
      ["%1", "%9"],
    );
    assert.deepEqual(result.panes, ["%9"]);
    assert.deepEqual(result.actors, ["agent:9"], "the notice goes where the wake said it would");
    assert.deepEqual(result.owners, ["lead:1"], "and still records who set it, which is what wake_cancel is scoped by");
    assert.doesNotMatch(
      result.bodies[0],
      /^ {2}reviewer:/m,
      "the delivery target is not reported to itself - it would be a paste into the pane it is reading from",
    );
  });

  it("delivers the caller's own body on every notice, not only at expiry", () => {
    // body is REQUIRED, help.ts teaches leads to write one, and
    // worker-state.md tells them to make it self-contained. A required
    // parameter that surfaces only when the feature ends is a broken
    // contract.
    const result = fixture(
      "body-on-every-notice",
      `
      const w1 = addWorker('agent:1', 'w1', '%1', 'idle', '-30 seconds');
      const watchId = addStandingWatch('-60 seconds', '+4 hours', {
        body: 'read its diff, complete its todo, dispatch the one it unblocks',
      });
      await tick(snapshot);
      ${out("{ bodies: notices(watchId).map((n) => n.body) }")}
      `,
    );
    assert.equal(result.bodies.length, 1);
    assert.match(result.bodies[0], /read its diff, complete its todo, dispatch the one it unblocks/);
    assert.match(result.bodies[0], /what you asked to be told/, "and labelled, so it is not read as hive's own voice");
  });

  it("keeps reporting after max_wait passes while its expiry cannot be delivered", () => {
    // The expiry branch only completes when deliverable() says yes, and a
    // pane holding unsubmitted human text holds a wake INDEFINITELY by
    // design. Returning before the reporting call meant a watch whose expiry
    // was held stopped watching silently while wake_list showed it pending -
    // this todo's own defect with a timer on it. Here the delivery pane is
    // simply not live, which holds the same way for a lead-owned wake.
    const result = fixture(
      "expiry-held-keeps-reporting",
      `
      const w1 = addWorker('agent:1', 'w1', '%1', 'working', '-120 seconds');
      const watchId = addStandingWatch('-300 seconds', '-1 seconds');
      await tick(snapshot);
      const afterExpiryTick = watchRow(watchId);
      db.prepare("UPDATE agents SET agent_state = 'idle', state_changed_at = datetime('now') WHERE id = ?").run(w1);
      await tick(snapshot);
      ${out("{ afterExpiryTick, bodies: notices(watchId).map((n) => n.body) }")}
      `,
    );
    assert.equal(result.afterExpiryTick.fired_at, null, "the fixture must really be the held case, or it proves nothing");
    assert.equal(result.bodies.length, 1, "a watch still in the candidate set is still watching");
    assert.match(result.bodies[0], /w1/);
  });

  it("reports a finish landing in the very tick that expires the watch", () => {
    const result = fixture(
      "finish-in-the-expiring-tick",
      `
      const w1 = addWorker('agent:1', 'w1', '%1', 'idle', '-5 seconds');
      const watchId = addStandingWatch('-300 seconds', '-1 seconds');
      await tick(snapshot);
      ${out("{ bodies: notices(watchId).map((n) => n.body), watch: watchRow(watchId) }")}
      `,
      ["%lead", "%1"],
    );
    assert.equal(result.bodies.length, 1, "the last finish must not be dropped just because the clock also ran out");
    assert.ok(result.watch.fired_at !== null, "and the expiry still fires in the same tick");
  });

  it("reports one idle episode once, however many ticks see it", () => {
    const result = fixture(
      "one-episode-once",
      `
      const w1 = addWorker('agent:1', 'w1', '%1', 'idle', '-30 seconds');
      const watchId = addStandingWatch();
      await tick(snapshot);
      await tick(snapshot);
      await tick(snapshot);
      ${out("{ notices: notices(watchId).length, cursor: cursor(watchId) }")}
      `,
    );
    assert.equal(result.notices, 1, "three ticks over one unchanged idle must file exactly one notice");
    assert.equal(result.cursor.length, 1);
    assert.equal(result.cursor[0].condition, "idle");
    assert.ok(result.cursor[0].notice_timer_id !== null, "the cursor row records which notice carried it");
  });

  it("reports a worker that was ALREADY idle when the watch was set", () => {
    // Decision A (todo 315 comment 638), and a deliberate difference from
    // mode=any. The control below is the whole point of this test: it proves
    // the two really do differ, rather than restating a default.
    const result = fixture(
      "already-idle",
      `
      const w1 = addWorker('agent:1', 'w1', '%1', 'idle', '-600 seconds');
      const standing = addStandingWatch('-60 seconds');
      const oneShot = db.prepare(
        \`INSERT INTO timers (project_id, owner, body, kind, watch, deliver_actor, deliver_pane, max_wait_at, created_at)
          VALUES (?, 'lead:1', 'one-shot', 'idle_any', ?, 'lead:1', '%lead', datetime('now', '+4 hours'), datetime('now', '-60 seconds'))
          RETURNING id\`,
      ).get(project, JSON.stringify([w1])).id;
      await tick(snapshot);
      const oneShotRow = db.prepare("SELECT fired_at, held_reason FROM timers WHERE id = ?").get(oneShot);
      ${out("{ standingNotices: notices(standing).length, oneShotRow }")}
      `,
    );
    assert.equal(result.standingNotices, 1, "a worker idle before the watch existed is still a finish nobody was told about");
    // THE CONTROL'S INSTRUMENT IS held_reason, NOT fired_at, and the
    // difference is the whole value of the control (counselors, opus 9). This
    // fixture's lead pane is deliberately absent from the snapshot, so a
    // one-shot that DID become ready would be held rather than fired and would
    // read fired_at === null too - the assertion held in both states and
    // discriminated nothing (test/CLAUDE.md shape 7). An unready idle wake is
    // never offered to deliverable() at all, so a NULL held_reason is what
    // actually proves it never became ready. The sibling control in "a watched
    // worker that dies" asserts the same field in the opposite direction.
    assert.equal(result.oneShotRow.fired_at, null);
    assert.equal(
      result.oneShotRow.held_reason,
      null,
      "control: mode=any never even offered this wake for delivery, so the two really do differ - a held wake would read fired_at null as well",
    );
  });
});

describe("the cursor is a transition, not a timestamp", () => {
  // src/hook.ts rewrites state_changed_at even when the state it writes is
  // the one already there, so a /goal fires Stop after every turn and
  // .claude/rules/worker-state.md measured NINE false idles in fifty seconds.
  // Keyed on the timestamp alone, a standing watch reports all nine.
  it("does not re-report an idle latch that moved with no work in between", () => {
    const result = fixture(
      "goal-churn",
      `
      const w1 = addWorker('agent:1', 'w1', '%1', 'idle', '-30 seconds');
      logRow('agent:1', 'stop', 'idle', '-30 seconds');
      const watchId = addStandingWatch();
      await tick(snapshot);
      const first = notices(watchId).length;

      // The latch moves again with nothing but another stop|idle behind it -
      // the /goal shape exactly.
      logRow('agent:1', 'stop', 'idle', '-1 seconds');
      db.prepare("UPDATE agents SET state_changed_at = datetime('now') WHERE id = ?").run(w1);
      await tick(snapshot);
      const churned = notices(watchId).length;

      // CONTROL: a real turn happened this time, so the next idle IS a
      // finish and must be reported. Without this, a discriminator that
      // suppressed everything would pass the assertion above.
      logRow('agent:1', 'prompt', 'working', '+1 seconds');
      logRow('agent:1', 'stop', 'idle', '+2 seconds');
      db.prepare("UPDATE agents SET state_changed_at = datetime('now', '+2 seconds') WHERE id = ?").run(w1);
      await tick(snapshot);
      const afterRealWork = notices(watchId).length;
      ${out("{ first, churned, afterRealWork }")}
      `,
    );
    assert.equal(result.first, 1);
    assert.equal(result.churned, 1, "a latch that moved with no working|waiting row between is not a new finish");
    // TODO 390: the lead's pane is deliberately absent from this fixture's
    // snapshot (the file header explains why), so it stays held across every
    // tick here. The real finish below is still a NEW episode - the control
    // this test exists for - but while the pane is held it folds into the
    // one pending notice rather than queuing a second one behind it.
    assert.equal(result.afterRealWork, 1, "control: a real turn between two idles IS a new finish, held in the same notice");
  });

  // THE SHAPE RETENTION ACTUALLY PRODUCES, which the first version of this
  // test could not reach. pruneStateLog deletes a PREFIX, by age and by a
  // global row-count bound - so it takes the OLDER prompt|working row and
  // leaves the NEWER stop|idle row standing. A fail-open keyed on "no rows at
  // all after the previous episode" is aimed at the one shape a prefix delete
  // cannot make, and the reachable one silently swallowed a real finish for
  // the watch's whole life while wake_list showed it healthy.
  it("reports the finish when retention truncated the interval it would have checked", () => {
    const result = fixture(
      "log-pruned-prefix",
      `
      const w1 = addWorker('agent:1', 'w1', '%1', 'idle', '-30 seconds');
      logRow('agent:1', 'stop', 'idle', '-30 seconds');
      const watchId = addStandingWatch();
      await tick(snapshot);

      // A real turn happens: prompt|working, then stop|idle.
      logRow('agent:1', 'prompt', 'working', '-20 seconds');
      logRow('agent:1', 'stop', 'idle', '-10 seconds');
      db.prepare("UPDATE agents SET state_changed_at = datetime('now', '-10 seconds') WHERE id = ?").run(w1);

      // Retention then deletes the PREFIX - here everything up to and
      // including the working row, exactly as a global id-bound delete does
      // when an unrelated actor's churn pushes the table past LOG_MAX_ROWS.
      // The stop|idle survives, so a probe for "did it work in between" finds
      // nothing and the log cannot answer.
      db.prepare("DELETE FROM agent_state_log WHERE created_at < datetime('now', '-15 seconds')").run();
      const survivors = db.prepare("SELECT state FROM agent_state_log ORDER BY id").all().map((r) => r.state);

      await tick(snapshot);
      ${out("{ survivors, notices: notices(watchId).length }")}
      `,
    );
    assert.deepEqual(
      result.survivors,
      ["idle"],
      "the fixture must really be the partial-retention shape: the working row gone, the idle row kept",
    );
    // TODO 390: still reported (unanswerable must not mean silent) - and,
    // the pane being held throughout this fixture, folded into the ONE
    // notice already pending rather than queued as a second row.
    assert.equal(result.notices, 1, "a truncated interval is unanswerable, and unanswerable must not mean silent");
  });

  it("control: an INTACT log that records no work is evidence, and stays quiet", () => {
    // The other direction, and it is what stops the fail-open above from
    // swallowing the /goal fix: a log that still covers the interval and
    // simply holds no working row is an answer, not an absence of one.
    const result = fixture(
      "log-intact-no-work",
      `
      const w1 = addWorker('agent:1', 'w1', '%1', 'idle', '-30 seconds');
      logRow('agent:1', 'stop', 'idle', '-40 seconds');
      const watchId = addStandingWatch();
      await tick(snapshot);
      logRow('agent:1', 'stop', 'idle', '-1 seconds');
      db.prepare("UPDATE agents SET state_changed_at = datetime('now') WHERE id = ?").run(w1);
      await tick(snapshot);
      ${out("{ notices: notices(watchId).length }")}
      `,
    );
    assert.equal(result.notices, 1, "the interval is covered and holds no work, so the moved latch is not a finish");
  });
});

describe("a watched worker that dies", () => {
  it("is reported, even though it has no idle latch and drops out of the crew", () => {
    // THE STRICT-REGRESSION GUARD. Under the explicit-list wake this
    // replaces, a watched worker that goes away fires the wake through
    // watchedStates' GONE branch. Under project scope, membership is a query
    // over RUNNING agents - so without a key of its own, a dead worker does
    // not merely lack a fresh latch, it silently leaves the watched set.
    const result = fixture(
      "gone-worker",
      `
      const w1 = addWorker('agent:1', 'w1', '%1', 'working', '-120 seconds');
      const w2 = addWorker('agent:2', 'w2', '%2', 'working', '-120 seconds');
      const watchId = addStandingWatch();
      await tick(snapshot);
      const before = notices(watchId).length;

      // w1's window dies. The janitor closes the row on the next tick, which
      // is the real path: nothing else stamps closed_at.
      const shrunk = { panes: new Set(['%2']), windows: new Set() };
      await tick(shrunk);
      const after = notices(watchId);
      const w1Row = db.prepare("SELECT status, closed_at FROM agents WHERE id = ?").get(w1);

      // And it is reported ONCE, not on every later tick.
      await tick(shrunk);
      ${out(`{
        before,
        closed: w1Row.status === 'closed' && w1Row.closed_at !== null,
        bodies: after.map((n) => n.body),
        afterRepeat: notices(watchId).length,
        cursor: cursor(watchId),
      }`)}
      `,
    );
    assert.equal(result.before, 0, "nothing had finished yet");
    assert.equal(result.closed, true, "the janitor is what stamps closed_at, and this test depends on it running");
    assert.equal(result.bodies.length, 1);
    assert.match(result.bodies[0], /w1: GONE/);
    assert.equal(result.afterRepeat, 1, "a death is reported once, not on every tick that can still see the closed row");
    assert.deepEqual(
      result.cursor.map((c) => c.condition),
      ["gone"],
    );
  });

  // THE PAIR, AND IT HAS TO BE A PAIR. Either half alone is green against a
  // gone query with no state discriminator in it at all: the death below is
  // reported either way, and "the close filed nothing" is only meaningful
  // sitting next to a close that DID file something. Delete
  // `a.agent_state != 'idle'` from standingGoneRows and this test goes red on
  // the middle assertion, which is the whole reason it is written as one
  // fixture walking one loop rather than two tidy ones.
  it("stays quiet when the lead closes a worker it already read, and still reports one that died mid-work", () => {
    const result = fixture(
      "close-from-idle-versus-death",
      `
      const done = addWorker('agent:1', 'done', '%1', 'idle', '-30 seconds');
      const died = addWorker('agent:2', 'died', '%2', 'working', '-120 seconds');
      const watchId = addStandingWatch();

      // The finish is reported. The false alarm this guards against lives
      // INSIDE this loop, so the fixture walks it rather than jumping to the
      // close.
      await tick(snapshot);
      const afterFinish = notices(watchId).map((n) => n.body);

      // The lead reads it and closes it. closeAgentRow (src/spawn.ts) writes
      // status and closed_at and nothing else, so the state stays frozen at
      // whatever the worker last reported - asserted below rather than
      // assumed, because the discriminator rests entirely on it.
      db.prepare("UPDATE agents SET status = 'closed', closed_at = datetime('now') WHERE id = ?").run(done);
      await tick(snapshot);
      const afterClose = notices(watchId).map((n) => n.body);
      const frozen = db.prepare("SELECT agent_state FROM agents WHERE id = ?").get(done).agent_state;

      // The other row closes while it still reads 'working': the turn that
      // died mid-response (issue #38), which is the case this half exists for.
      db.prepare("UPDATE agents SET status = 'closed', closed_at = datetime('now') WHERE id = ?").run(died);
      await tick(snapshot);
      const afterDeath = notices(watchId).map((n) => n.body);
      ${out("{ afterFinish, afterClose, frozen, afterDeath }")}
      `,
    );
    assert.equal(result.afterFinish.length, 1, "the finish itself is still reported");
    assert.match(result.afterFinish[0], /done/);
    assert.equal(result.frozen, "idle", "the premise: a close freezes the state, it does not clear it");
    assert.deepEqual(
      result.afterClose,
      result.afterFinish,
      "closing a worker the lead has already read is its own tidy-up, not a death to be woken for",
    );
    // TODO 390: the death is still reported (the whole point of this test),
    // and since the pane is held throughout, it folds into the ONE notice
    // already pending rather than filing a second row.
    assert.equal(result.afterDeath.length, 1, "a row that closed while it still read working IS the death this reports");
    assert.match(result.afterDeath[0], /died: GONE/);
    assert.match(
      result.afterDeath[0],
      /last read it as working/,
      "and it says what hive observed, rather than asserting what was lost",
    );
    assert.doesNotMatch(result.afterDeath[0], /is lost/, "hive has not looked at the branch, the todo or the pad");
  });

  it("says nothing about a worker that died before the watch was set", () => {
    const result = fixture(
      "gone-before",
      `
      const w1 = addWorker('agent:1', 'w1', '%1', 'working', '-120 seconds');
      db.prepare("UPDATE agents SET status = 'closed', closed_at = datetime('now', '-600 seconds') WHERE id = ?").run(w1);
      const watchId = addStandingWatch('-60 seconds');
      seedGoneCursor(watchId, project);
      await tick(snapshot);
      ${out("{ notices: notices(watchId).length }")}
      `,
    );
    assert.equal(result.notices, 0, "a death from before the watch existed is history, not news");
  });

  // BOTH DIRECTIONS OF THE SUB-SECOND COLLISION, INSIDE ONE SECOND, which is
  // the only way to test it: datetime('now') has no sub-second component, so
  // a death at .100 and a watch at .900 are stored as the identical string
  // and NO comparison between them can recover the order. `>=` reported the
  // dead-already worker; `>` would lose the one that died while the watch was
  // live, which the receipt had just named as watched. The fix is that
  // neither stamp is compared: the cursor is seeded at creation, so the
  // question is answered by a row that exists rather than by a timestamp.
  it("tells a death that beat the watch from one that landed in the same second after it", () => {
    const result = fixture(
      "same-second-deaths",
      `
      const before = addWorker('agent:1', 'died-before', '%1', 'working', '-120 seconds');
      const after = addWorker('agent:2', 'died-after', '%2', 'working', '-120 seconds');
      const t = db.prepare("SELECT datetime('now') AS t").get().t;

      // Dead first, then the watch is set: the whole second they share is
      // exactly what the old bound could not see past.
      db.prepare("UPDATE agents SET status = 'closed', closed_at = ? WHERE id = ?").run(t, before);
      const watchId = addStandingWatch();
      db.prepare("UPDATE timers SET created_at = ? WHERE id = ?").run(t, watchId);
      seedGoneCursor(watchId, project);

      // And this one dies while the watch is standing, still inside it.
      db.prepare("UPDATE agents SET status = 'closed', closed_at = ? WHERE id = ?").run(t, after);

      await tick(snapshot);
      const first = notices(watchId).map((n) => n.body);
      // The seeded row must stay suppressed on every later tick too, not just
      // the first: it carries no notice, and the delivery-failure re-arm only
      // reaches rows that do.
      await tick(snapshot);
      ${out("{ first, later: notices(watchId).length, cursor: cursor(watchId) }")}
      `,
    );
    assert.equal(result.first.length, 1);
    assert.match(result.first[0], /died-after: GONE/, "a worker that died while the watch stood is news at any resolution");
    assert.doesNotMatch(result.first[0], /died-before/, "and one that was already dead is not, at the same resolution");
    assert.equal(result.later, 1, "the seeded row is never re-armed: it has no spent claim behind it to repair");
    assert.deepEqual(
      result.cursor.map((c) => c.notice_timer_id === null),
      [true, false],
      "the pre-seeded row carries no notice; the reported one carries the notice that named it",
    );
  });

  it("control: mode=any still fires on a watched agent that goes away", () => {
    // Not a standing-watch assertion at all. It is the guard that this lane
    // did not regress the behaviour it is replacing, which is the only way to
    // know the gone-key work above was needed rather than invented.
    const result = fixture(
      "mode-any-gone-not-regressed",
      `
      const w1 = addWorker('agent:1', 'w1', '%1', 'working', '-120 seconds');
      const oneShot = db.prepare(
        \`INSERT INTO timers (project_id, owner, body, kind, watch, deliver_actor, deliver_pane, max_wait_at, created_at)
          VALUES (?, 'lead:1', 'one-shot', 'idle_any', ?, 'lead:1', '%lead', datetime('now', '+4 hours'), datetime('now', '-60 seconds'))
          RETURNING id\`,
      ).get(project, JSON.stringify([w1])).id;
      const shrunk = { panes: new Set(), windows: new Set() };
      await tick(shrunk);
      const heldNotFired = db.prepare("SELECT fired_at, held_reason FROM timers WHERE id = ?").get(oneShot);
      ${out("{ heldNotFired, agentClosed: db.prepare(\"SELECT status FROM agents WHERE id = ?\").get(w1).status }")}
      `,
    );
    assert.equal(result.agentClosed, "closed");
    // The wake becomes READY on the gone branch and then holds only because
    // this fixture's lead pane is deliberately dead. Held is the proof it got
    // past `ready`: an unready idle wake is never offered to deliverable() at
    // all, so held_reason would stay NULL.
    assert.equal(result.heldNotFired.fired_at, null);
    assert.match(
      result.heldNotFired.held_reason ?? "",
      /lead's pane is not live/,
      "mode=any must still reach delivery for a watched agent that went away",
    );
  });
});

describe("a notice that was claimed but never typed", () => {
  const rearmFixture = (name, typedAt) =>
    fixture(
      name,
      `
      const w1 = addWorker('agent:1', 'w1', '%1', 'idle', '-30 seconds');
      const watchId = addStandingWatch();
      await tick(snapshot);
      const notice = notices(watchId)[0];
      // The claim committed and the send did or did not happen. fired_at is
      // pushed well past NOTICE_RETRY_AFTER so this is a settled outcome, not
      // a delivery still in flight.
      db.prepare("UPDATE timers SET fired_at = datetime('now', '-300 seconds'), typed_at = ${typedAt} WHERE id = ?").run(notice.id);
      await tick(snapshot);
      ${out("{ notices: notices(watchId).length }")}
      `,
    );

  it("re-arms the episode, because the cursor records a claim and not a delivery", () => {
    assert.equal(
      rearmFixture("rearm-failed", "NULL").notices,
      2,
      "a spent claim that never typed must not consume the finish it was carrying",
    );
  });

  it("control: a notice that WAS typed keeps its episode consumed", () => {
    assert.equal(
      rearmFixture("rearm-typed", "datetime('now', '-300 seconds')").notices,
      1,
      "without this control the re-arm above would pass against a cursor that simply never worked",
    );
  });
});

describe("the parent link", () => {
  it("cancels a filed notice rather than typing it, once the watch is cancelled", () => {
    const result = fixture(
      "cancelled-parent",
      `
      const w1 = addWorker('agent:1', 'w1', '%1', 'idle', '-30 seconds');
      const watchId = addStandingWatch();
      await tick(snapshot);
      const notice = notices(watchId)[0];
      db.prepare("UPDATE timers SET cancelled_at = datetime('now') WHERE id = ?").run(watchId);
      await tick(snapshot);
      const after = db.prepare("SELECT cancelled_at, typed_at, fired_at FROM timers WHERE id = ?").get(notice.id);
      ${out("{ after }")}
      `,
    );
    assert.ok(result.after.cancelled_at !== null, "a notice whose watch is gone is cancelled, not delivered");
    assert.equal(result.after.fired_at, null, "and it is never claimed, so it cannot report itself as delivered");
    assert.equal(result.after.typed_at, null);
  });

  it("cancels a notice that has sat pending long enough to be about a lane that moved on", () => {
    const result = fixture(
      "stale-notice",
      `
      const w1 = addWorker('agent:1', 'w1', '%1', 'idle', '-30 seconds');
      const watchId = addStandingWatch();
      await tick(snapshot);
      const notice = notices(watchId)[0];
      db.prepare("UPDATE timers SET created_at = datetime('now', '-6 hours') WHERE id = ?").run(notice.id);
      await tick(snapshot);
      const after = db.prepare("SELECT cancelled_at, typed_at FROM timers WHERE id = ?").get(notice.id);
      ${out("{ after }")}
      `,
    );
    assert.ok(result.after.cancelled_at !== null, "`hive lead` re-points every active lead-owned timer; this is the bound on that");
    assert.equal(result.after.typed_at, null);
  });

  // CLAUDE.md's "the scheduler must never throw", reached through this lane's
  // own new write. The cancel is one UPDATE in tick()'s candidate loop, and a
  // throw from it - SQLITE_BUSY outliving the 5s busy_timeout, an I/O error -
  // escapes fireDelay into tick()'s outer catch, which skips every later
  // candidate. A notice that keeps failing that write starves every unrelated
  // wake in the store on every tick.
  //
  // THE THROW IS INJECTED WITH A TRIGGER, because nothing else makes an UPDATE
  // fail on demand: RAISE(ABORT) throws out of the identical statement, at the
  // identical point. TWO SIBLING WAKES, one either side of the notice by id,
  // so the assertion cannot pass by an accident of candidate ordering - the
  // candidates query has no ORDER BY, and whichever end it starts from, one
  // sibling is behind the throwing row. held_reason is the instrument rather
  // than fired_at: these are lead-owned wakes on a dead pane, so being HELD is
  // what "this candidate was reached" looks like here.
  it("keeps working through the rest of the tick when cancelling a stale notice throws", () => {
    const result = fixture(
      "stale-notice-cancel-throws",
      `
      const delayWake = (body) => db.prepare(
        \`INSERT INTO timers (project_id, owner, body, kind, deliver_actor, deliver_pane, due_at, created_at)
          VALUES (?, 'lead:1', ?, 'delay', 'lead:1', '%lead', datetime('now'), datetime('now', '-300 seconds'))
          RETURNING id\`,
      ).get(project, body).id;

      const w1 = addWorker('agent:1', 'w1', '%1', 'idle', '-30 seconds');
      const watchId = addStandingWatch();
      const earlier = delayWake('due before the notice');
      await tick(snapshot);
      const notice = notices(watchId)[0];
      const later = delayWake('due after the notice');

      // Stale past NOTICE_MAX_AGE, so the next tick cancels rather than types
      // it - and the trigger makes that cancel fail.
      db.prepare("UPDATE timers SET created_at = datetime('now', '-6 hours') WHERE id = ?").run(notice.id);
      db.exec(
        "CREATE TRIGGER cancel_fails BEFORE UPDATE OF cancelled_at ON timers " +
          "WHEN NEW.id = " + notice.id + " BEGIN SELECT RAISE(ABORT, 'cancel failed'); END",
      );
      // Both siblings were already held by the tick above; the assertions want
      // what THIS tick does, so the instrument is cleared first.
      db.prepare("UPDATE timers SET held_at = NULL, held_reason = NULL WHERE id IN (?, ?)").run(earlier, later);

      await tick(snapshot);
      const held = db.prepare("SELECT id, held_reason FROM timers WHERE id IN (?, ?) ORDER BY id").all(earlier, later);
      const noticeRow = db.prepare("SELECT cancelled_at, fired_at, typed_at FROM timers WHERE id = ?").get(notice.id);
      ${out("{ ids: { earlier, notice: notice.id, later }, held, noticeRow }")}
      `,
    );
    assert.ok(
      result.ids.earlier < result.ids.notice && result.ids.notice < result.ids.later,
      "the fixture must really bracket the throwing row, or ordering decides the result instead of the fix",
    );
    assert.equal(
      result.noticeRow.cancelled_at,
      null,
      "the injected throw must really have happened: a trigger that did not match would have cancelled the row",
    );
    assert.equal(result.noticeRow.typed_at, null, "and a stale notice is still never typed");
    assert.deepEqual(
      result.held.map((t) => t.held_reason !== null),
      [true, true],
      "every candidate after the failed cancel must still be reached; a throw here starves the whole store",
    );
  });

  it("leaves a notice with no parent alone, so todo 314's own notices are untouched", () => {
    const result = fixture(
      "parentless-notice",
      `
      const parentless = db.prepare(
        \`INSERT INTO timers (project_id, owner, body, kind, deliver_actor, deliver_pane, due_at, created_at)
          VALUES (?, 'lead:1', 'a todo 314 notice', 'delay', 'lead:1', '%lead', datetime('now'), datetime('now', '-6 hours'))
          RETURNING id\`,
      ).get(project).id;
      await tick(snapshot);
      const after = db.prepare("SELECT cancelled_at, held_reason FROM timers WHERE id = ?").get(parentless);
      ${out("{ after }")}
      `,
    );
    assert.equal(result.after.cancelled_at, null, "the staleness bound must apply only to rows that carry a parent");
    assert.match(result.after.held_reason ?? "", /lead's pane is not live/, "it reached delivery and held, exactly as before");
  });
});

// TODO 390 (pad 142 PART 3). Wakes held behind a modal (or, here, a dead
// lead pane - the same hold shape "the parent link" tests above already use
// to avoid a real tmux fork) used to queue one notice PER finish and release
// them all together the moment the pane cleared. THE PROPERTY UNDER TEST:
// N edges arriving while held must leave exactly ONE pending notice, naming
// every worker whose episode it stands in for - never a sample of the
// current row taken once, but the full set of rows this project EVER filed
// for the watch, which is durable precisely because a `timers` row is never
// deleted (test/CLAUDE.md's own rule: assert over a record, not a sample).
describe("todo 390: coalescing while held", () => {
  it("holds a pane's second finish in the SAME pending notice instead of queuing a new one, and names both workers", () => {
    const result = fixture(
      "coalesce-two-finishes",
      `
      const w1 = addWorker('agent:1', 'w1', '%1', 'working', '-120 seconds');
      const w2 = addWorker('agent:2', 'w2', '%2', 'working', '-120 seconds');
      const watchId = addStandingWatch();

      db.prepare("UPDATE agents SET agent_state = 'idle', state_changed_at = datetime('now') WHERE id = ?").run(w1);
      await tick(snapshot);
      const afterFirst = notices(watchId);

      db.prepare("UPDATE agents SET agent_state = 'idle', state_changed_at = datetime('now') WHERE id = ?").run(w2);
      await tick(snapshot);
      const afterSecond = notices(watchId);

      ${out(`{
        idsAfterFirst: afterFirst.map((n) => n.id),
        idsAfterSecond: afterSecond.map((n) => n.id),
        bodyAfterFirst: afterFirst[0].body,
        bodyAfterSecond: afterSecond[0].body,
        cursor: cursor(watchId),
      }`)}
      `,
    );
    assert.equal(result.idsAfterFirst.length, 1, "the first finish files exactly one notice, as before this lane");
    assert.equal(
      result.idsAfterSecond.length,
      1,
      "the second finish while still held must update the SAME row rather than queue a second one - the " +
        "thundering herd this lane exists to remove",
    );
    assert.deepEqual(result.idsAfterSecond, result.idsAfterFirst, "same row id, updated in place");
    assert.match(result.bodyAfterSecond, /w1/, "the worker named before this update must still be named");
    assert.match(result.bodyAfterSecond, /w2/, "and the worker that just finished must be named too");
    assert.doesNotMatch(result.bodyAfterFirst, /updated in place/, "the FIRST write is not itself a coalesced one");
    assert.match(result.bodyAfterSecond, /updated in place/, "the SECOND write is, and must say so");
    assert.equal(result.cursor.length, 2, "both episodes are recorded in the cursor");
    assert.deepEqual(
      result.cursor.map((c) => c.notice_timer_id),
      [result.idsAfterSecond[0], result.idsAfterSecond[0]],
      "both episodes point at the ONE notice that carries them - what the delivery-failure re-arm reads",
    );
  });

  // COUNSELORS ROUND 3, F7 CORRECTION: this pins pendingNoticeFor's OWN
  // `fired_at IS NULL` filter, not updateNoticeInPlace's guard of the same
  // shape - claimStandingBatch's read-then-write runs inside one
  // .immediate() transaction, so updateNoticeInPlace's guard is never
  // actually reached with a stale row from this caller (see its own
  // comment). What this proves instead: a notice that has ALREADY fired by
  // the time the next finish arrives must not be found as "pending" at
  // all - w2's finish gets its OWN fresh notice rather than either being
  // silently dropped or matched against a row that is already being typed.
  // Delete `AND fired_at IS NULL` from pendingNoticeFor's own query (not
  // updateNoticeInPlace's) to see this test go red.
  it("falls back to a fresh notice when the pending one was claimed by a delivery in between", () => {
    const result = fixture(
      "coalesce-race-lost",
      `
      const w1 = addWorker('agent:1', 'w1', '%1', 'working', '-120 seconds');
      const w2 = addWorker('agent:2', 'w2', '%2', 'working', '-120 seconds');
      const watchId = addStandingWatch();

      db.prepare("UPDATE agents SET agent_state = 'idle', state_changed_at = datetime('now') WHERE id = ?").run(w1);
      await tick(snapshot);
      const first = notices(watchId)[0];
      db.prepare("UPDATE timers SET fired_at = datetime('now'), typed_at = datetime('now') WHERE id = ?").run(first.id);

      db.prepare("UPDATE agents SET agent_state = 'idle', state_changed_at = datetime('now') WHERE id = ?").run(w2);
      await tick(snapshot);
      const after = notices(watchId);
      ${out(`{
        ids: after.map((n) => n.id),
        firstBody: after.find((n) => n.id === first.id).body,
        secondBody: after.find((n) => n.id !== first.id)?.body,
      }`)}
      `,
    );
    assert.equal(result.ids.length, 2, "losing the race must file a FRESH notice, never drop w2's report entirely");
    assert.doesNotMatch(
      result.firstBody,
      /^ {2}w2:/m,
      "the already-fired notice must never be rewritten after the fact - w2 must not appear as a FINISHED worker",
    );
    assert.match(result.secondBody, /w2/, "and the fresh notice carries the winner this tick actually claimed");
  });

  // REVIEW ROUND 1: created_at is refreshed on every in-place update (so
  // NOTICE_MAX_AGE cannot cancel a long-held coalesced notice out from under
  // itself), which means it answers "how fresh is the CONTENT", never "how
  // long has this notice been HELD" - the trailer's first version read the
  // one number as if it were the other, understating a long hold's own age
  // worst in exactly the lunch-break case this lane exists for. The fix
  // reads the hold's own start from wake_idle_notices.notified_at, which
  // `updateNoticeInPlace` never touches. Proven here by forcing the two
  // clocks apart with a backdated first episode, matching pad 142's own
  // 45-minute scenario, rather than waiting on a real clock.
  it("keeps the hold's own start time separate from the content's own refresh time", () => {
    const result = fixture(
      "coalesce-two-clocks",
      `
      const w1 = addWorker('agent:1', 'w1', '%1', 'working', '-120 seconds');
      const w2 = addWorker('agent:2', 'w2', '%2', 'working', '-120 seconds');
      const watchId = addStandingWatch();

      db.prepare("UPDATE agents SET agent_state = 'idle', state_changed_at = datetime('now') WHERE id = ?").run(w1);
      await tick(snapshot);
      const first = notices(watchId)[0];
      db.prepare(
        "UPDATE wake_idle_notices SET notified_at = datetime('now', '-45 minutes') WHERE notice_timer_id = ?",
      ).run(first.id);

      db.prepare("UPDATE agents SET agent_state = 'idle', state_changed_at = datetime('now') WHERE id = ?").run(w2);
      await tick(snapshot);
      const merged = notices(watchId)[0];
      const createdAt = db.prepare("SELECT created_at FROM timers WHERE id = ?").get(merged.id).created_at;
      const heldSince = db
        .prepare("SELECT MIN(notified_at) AS t FROM wake_idle_notices WHERE notice_timer_id = ?")
        .get(merged.id).t;
      ${out("{ sameRow: first.id === merged.id, createdAt, heldSince }")}
      `,
    );
    assert.ok(result.sameRow, "the fixture must really be coalescing into one row, or this proves nothing");
    const asMs = (t) => new Date(`${t.replace(" ", "T")}Z`).getTime();
    assert.ok(
      asMs(result.createdAt) - asMs(result.heldSince) > 40 * 60 * 1000,
      "content-refresh (created_at) must be recent while the hold's own start (notified_at) stays at the " +
        "backdated first episode - the two facts the trailer now reports separately",
    );
  });

  // REVIEW ROUND 2 (Claude Code Review on PR #181). crewRowForRender's own
  // comment claimed "a closed row does not move again"; agent_resume's flip
  // (src/spawn.ts) proves that false, and coalescing is what makes it
  // reachable - the pre-lane code rendered a GONE candidate once, from the
  // row the same tick claimed it, and never read the row again. A worker
  // reported GONE, then resumed while its notice is still held, must not
  // have the next coalescing update re-assert a stale "no terminal left to
  // read" obituary about a row that is now live.
  it("does not re-assert a stale obituary for a GONE worker that was resumed while the notice was held", () => {
    const result = fixture(
      "coalesce-gone-then-resumed",
      `
      const died = addWorker('agent:1', 'died', '%1', 'working', '-120 seconds');
      const w2 = addWorker('agent:2', 'w2', '%2', 'working', '-120 seconds');
      const watchId = addStandingWatch();

      db.prepare("UPDATE agents SET status = 'closed', closed_at = datetime('now') WHERE id = ?").run(died);
      await tick(snapshot);
      const first = notices(watchId)[0];

      // Simulate agent_resume's flip: status back to running, closed_at
      // cleared, with no awareness that \`first\` is holding died's episode
      // as GONE.
      db.prepare(
        "UPDATE agents SET status = 'running', closed_at = NULL, agent_state = 'working', " +
          "state_changed_at = datetime('now') WHERE id = ?",
      ).run(died);

      db.prepare("UPDATE agents SET agent_state = 'idle', state_changed_at = datetime('now') WHERE id = ?").run(w2);
      await tick(snapshot);
      const merged = notices(watchId)[0];
      ${out("{ sameRow: first.id === merged.id, firstBody: first.body, mergedBody: merged.body }")}
      `,
    );
    assert.ok(result.sameRow, "the fixture must really be coalescing into one row, or this proves nothing");
    assert.match(
      result.firstBody,
      /died: GONE - hive last read it as working, and its row was closed at/,
      "the premise: died was genuinely reported GONE before the resume",
    );
    assert.doesNotMatch(
      result.mergedBody,
      /no terminal left to read/,
      "must not assert a stale obituary about a worker that is now live",
    );
    assert.match(
      result.mergedBody,
      /died: was reported GONE earlier in this hold, but its row's state has moved since/,
      "and must say so plainly instead of trusting either snapshot",
    );
    assert.match(result.mergedBody, /w2/, "the finish that actually happened on this tick must still be named");
  });
});

// FIVE GUARDS THAT NO FIXTURE REACHED. Counselors listed five mutations to
// this lane's source that leave every earlier test in this file green - a
// guard nothing exercises is a guard the next reader can delete for being
// dead. Each test below is written against one of them and was checked by
// applying that mutation, not by reasoning about it.
describe("the guards nothing else reaches", () => {
  it("never reports the delivery target to itself, even when its pane has moved", () => {
    // Two guards protect this and they are not redundant: the pane skip in
    // noteStandingTransitions compares the wake's recorded deliver_pane
    // against the row's tmux_target, and the actor_id exclusion in the query
    // compares identities. They agree until a worker's pane MOVES after the
    // wake was set (a respawn rewrites agents.tmux_target while the timer
    // keeps the pane it resolved at creation), and then only the actor test
    // still holds. That is the case here, so this kills the exclusion rather
    // than passing on the pane skip.
    const result = fixture(
      "target-inside-the-crew",
      `
      const w1 = addWorker('agent:1', 'w1', '%1', 'idle', '-30 seconds');
      const reviewer = addWorker('agent:9', 'reviewer', '%8', 'idle', '-30 seconds');
      const watchId = addStandingWatch('-60 seconds', '+4 hours', {
        deliverActor: 'agent:9',
        deliverPane: '%9',
      });
      await tick(snapshot);
      ${out("{ bodies: notices(watchId).map((n) => n.body) }")}
      `,
      ["%1", "%8", "%9"],
    );
    assert.equal(result.bodies.length, 1, "the tick must really have reported something, or this proves nothing");
    assert.match(result.bodies[0], /w1/);
    assert.doesNotMatch(
      result.bodies[0],
      /reviewer/,
      "the session being told is never told about itself: that is a paste into the pane it is reading from",
    );
  });

  it("does not re-arm a delivery that is still in flight", () => {
    // NOTICE_RETRY_AFTER's LOWER bound, which is the entire reason it is sixty
    // seconds rather than zero. Delivery is not atomic with the claim
    // (sendText's own ENTER_DELAY_MS is 300ms, and the path can queue behind
    // the store's 5s busy_timeout), so a second instance ticking in that gap
    // must read a healthy in-flight notice as in flight, not as failed.
    //
    // WHAT THIS PINS EXACTLY: a claim five seconds old is not re-armed, which
    // kills any bound shorter than five seconds. It does not distinguish 60s
    // from 30s, and it does not need to - what a shortened bound breaks is
    // duplicate delivery of a live notice, and five seconds is already far
    // past the whole claim-to-typed path.
    const result = fixture(
      "in-flight-not-rearmed",
      `
      const w1 = addWorker('agent:1', 'w1', '%1', 'idle', '-30 seconds');
      const watchId = addStandingWatch();
      await tick(snapshot);
      const notice = notices(watchId)[0];
      db.prepare("UPDATE timers SET fired_at = datetime('now', '-5 seconds'), typed_at = NULL WHERE id = ?").run(notice.id);
      await tick(snapshot);
      ${out("{ notices: notices(watchId).length }")}
      `,
    );
    assert.equal(
      result.notices,
      1,
      "a claim spent five seconds ago is a delivery in flight, not a failed one; re-arming it pastes the notice twice",
    );
  });

  it("refuses to file for a watch cancelled after this tick read it", () => {
    // The read-gate INSIDE the claim, which the cancelled-parent test above
    // cannot reach: it cancels the watch between ticks, after which tick()'s
    // own candidates query excludes it and this guard is never consulted. The
    // race it exists for is the one where the cancel lands DURING a tick,
    // after the candidates SELECT that produced the in-memory row - real,
    // because a tick can span several deliveries and their 300ms Enter sleeps.
    //
    // Reproduced with a trigger on an EARLIER candidate's own hold, which is
    // the only way to write "another actor cancelled it mid-tick" from inside
    // a single-process fixture. If the candidate order were ever reversed the
    // watch would file its notice and this test would FAIL rather than pass
    // vacuously, which is the safe direction for an ordering it cannot pin.
    const result = fixture(
      "cancelled-mid-tick",
      `
      const w1 = addWorker('agent:1', 'w1', '%1', 'idle', '-30 seconds');
      const earlier = db.prepare(
        \`INSERT INTO timers (project_id, owner, body, kind, deliver_actor, deliver_pane, due_at, created_at)
          VALUES (?, 'lead:1', 'held first', 'delay', 'lead:1', '%lead', datetime('now'), datetime('now', '-300 seconds'))
          RETURNING id\`,
      ).get(project).id;
      const watchId = addStandingWatch();
      db.exec(
        "CREATE TRIGGER cancel_mid_tick AFTER UPDATE OF held_at ON timers WHEN NEW.id = " + earlier +
          " BEGIN UPDATE timers SET cancelled_at = datetime('now') WHERE id = " + watchId + "; END",
      );
      await tick(snapshot);
      const held = db.prepare("SELECT held_reason FROM timers WHERE id = ?").get(earlier).held_reason;
      const watch = db.prepare("SELECT cancelled_at FROM timers WHERE id = ?").get(watchId).cancelled_at;
      ${out("{ held, cancelled: watch !== null, notices: notices(watchId).length, cursor: cursor(watchId).length }")}
      `,
    );
    assert.ok(result.held !== null, "the earlier candidate must really have been held, or the cancel never fired");
    assert.equal(result.cancelled, true, "and the watch must really have been cancelled inside this tick");
    assert.equal(result.notices, 0, "a claim must not outlive the watch it belongs to");
    assert.equal(result.cursor, 0, "and it must not consume the episode either, or the finish is lost twice over");
  });

  it("does not believe a running row whose pane it cannot see, or cannot see into", () => {
    // The same conservatism watchedStates applies, for the same reason: a row
    // that says `idle` is a hook's claim about a pane, and if this process
    // cannot see that pane (dead) or has no business reading it (issue #73's
    // foreign socket, where a probe answers correctly about someone else's
    // server) the honest answer is "no fact", not "finished".
    const result = fixture(
      "unbelievable-rows",
      `
      const live = addWorker('agent:1', 'live', '%1', 'idle', '-30 seconds');
      const deadPane = addWorker('agent:2', 'dead-pane', '%2', 'idle', '-30 seconds');
      const foreign = addWorker('agent:3', 'foreign', '%3', 'idle', '-30 seconds');
      db.prepare("UPDATE agents SET tmux_socket = '/nonexistent-tmux-dir/tmux-999/default' WHERE id = ?").run(foreign);
      const watchId = addStandingWatch();
      await tick(snapshot);
      ${out("{ bodies: notices(watchId).map((n) => n.body), cursor: cursor(watchId).length }")}
      `,
      // %2 is absent: the dead pane. %3 is present, so the only thing that can
      // exclude `foreign` is its recorded socket.
      ["%1", "%3"],
    );
    assert.equal(result.bodies.length, 1, "the live worker is still reported, or this test proves only that nothing ran");
    assert.match(result.bodies[0], /live/);
    assert.doesNotMatch(result.bodies[0], /dead-pane/, "a running row whose pane is gone is not a finish hive observed");
    assert.doesNotMatch(result.bodies[0], /foreign/, "and a row recorded on another server's socket is not ours to read");
    assert.equal(result.cursor, 1, "neither may consume its episode: the cursor would swallow the real finish later");
  });

  it("summarises the roster past its bound instead of pasting the whole crew", () => {
    // test/CLAUDE.md shape 6, a fixture too small to reach the bound: every
    // other test here has two workers against a cap of eight, so the cap and
    // its "and N more" branch were unreachable from the whole file. Ten
    // running workers plus one that finishes.
    const result = fixture(
      "roster-bound",
      `
      const done = addWorker('agent:0', 'done', '%0', 'idle', '-30 seconds');
      for (let i = 1; i <= 10; i++) addWorker('agent:' + i, 'w' + i, '%' + i, 'working', '-120 seconds');
      const watchId = addStandingWatch();
      await tick(snapshot);
      ${out("{ bodies: notices(watchId).map((n) => n.body) }")}
      `,
      ["%0", "%1", "%2", "%3", "%4", "%5", "%6", "%7", "%8", "%9", "%10"],
    );
    assert.equal(result.bodies.length, 1);
    const roster = result.bodies[0].split("\n").find((l) => l.startsWith("Still going:"));
    assert.ok(roster, "the roster line must exist, or the assertions below are about nothing");
    assert.equal(roster.split(";").length, 8, "eight named, not the whole crew pasted into a terminal");
    assert.match(roster, /, and 2 more\.$/, "and the rest counted, so the lead knows what it is not being shown");
    assert.doesNotMatch(roster, /w9|w10/, "the summarised tail really is left out, rather than the count being decoration");
  });
});

describe("the tool surface", () => {
  const OWNER = "user:standing-watch-owner";
  const session = `hive-standing-watch-${process.pid}`;
  let mcp;
  let livePane;

  const capturePaneText = (target) => {
    try {
      return execFileSync("tmux", ["capture-pane", "-p", "-t", target]).toString();
    } catch {
      // Swallowing this would make every assertion below vacuous on a runner
      // with no server, so it is deliberately NOT collapsed to "" - the empty
      // string is a value the assertions accept.
      throw new Error(`capture-pane failed for ${target}`);
    }
  };

  before(async () => {
    if (hasTmux) {
      execFileSync("tmux", ["new-session", "-d", "-s", session, "sleep 600"], { stdio: "ignore" });
      livePane = execFileSync("tmux", ["list-panes", "-t", `=${session}`, "-F", "#{pane_id}"], {
        encoding: "utf8",
      }).trim();
    }
    mcp = new McpClient({
      cwd: dirs.projectDir,
      dataDir: dirs.dataDir,
      env: { HIVE_AGENT_ID: OWNER, ...(livePane ? { TMUX_PANE: livePane } : {}) },
    });
    await mcp.start();
  });

  after(async () => {
    await mcp.close();
    cleanup(session);
  });

  it("refuses a call that names neither shape", async () => {
    await assert.rejects(mcp.call("wake_when_idle", { body: "x" }), /exactly one of agents/);
  });

  it("refuses a call that names both, rather than silently picking one", async () => {
    await assert.rejects(
      mcp.call("wake_when_idle", { body: "x", agents: ["nobody"], scope: "project" }),
      /You passed both/,
    );
  });

  it("refuses mode on a standing watch, since it reports EACH finish", async () => {
    await assert.rejects(mcp.call("wake_when_idle", { body: "x", scope: "project", mode: "all" }), /has no meaning/);
  });

  it("stores a row an OLD scheduler cannot misread", NEEDS_TMUX, async () => {
    const receipt = await mcp.call("wake_when_idle", { body: "crew update", scope: "project" });
    const { db } = await import("../dist/db.js");
    const row = db.prepare("SELECT kind, watch, watch_scope, max_wait_at FROM timers WHERE id = ?").get(receipt.wake_id);
    // TWO PROPERTIES OF THE ROW, WITH THE REASONS THEY ARE ACTUALLY PINNED
    // FOR. An earlier version of this test attached the mixed-version
    // argument to the kind assertion, and that argument was FALSE: an old
    // scheduler's idle_all branch requires states.length > 0, a guard that
    // predates this lane, and a standing watch stores an empty watch list
    // under either design - so a new kind and this flag degrade identically.
    // The real reason kind stays 'idle_any' is that SQLite cannot ALTER the
    // CHECK constraint on that column, so a new value means rebuilding
    // `timers` under live writers. See src/db.ts's migration.
    assert.equal(row.kind, "idle_any", "a new kind would need `timers` rebuilt past its CHECK, under live writers");
    // This one IS load-bearing at runtime: deliver() calls watchedTail()
    // unconditionally, and a non-empty watch list makes it capture up to
    // three worker panes and paste their SCREENS into the delivered body.
    assert.equal(row.watch, "[]", "a standing watch stores no list: its membership is a query, evaluated every tick");
    assert.equal(row.watch_scope, "project");
    assert.equal(receipt.standing, true);
    assert.equal(receipt.scope, "project");
    assert.ok(typeof receipt.expires_at === "string");
    assert.equal(receipt.max_wait_seconds, 14400, "four hours, and it is a judgement recorded in the code");
    // A project holds one standing watch per owner, so every test in this
    // block that sets one hands it back. See the refusal test below.
    await mcp.call("wake_cancel", { wake_id: receipt.wake_id });
  });

  // NOTHING REFUSED A SECOND ONE, and the way a lead gets there is ordinary:
  // calling again after a restart, or having forgotten. The cost is every
  // finish reported twice for four hours with two wake ids to find.
  it("refuses a second standing watch, and names the one already running", NEEDS_TMUX, async () => {
    const first = await mcp.call("wake_when_idle", { body: "crew update", scope: "project" });
    await assert.rejects(
      mcp.call("wake_when_idle", { body: "crew update again", scope: "project" }),
      new RegExp(`already have a standing watch[\\s\\S]*wake #${first.wake_id}[\\s\\S]*wake_cancel`),
      "the refusal has to name the id, or the lead is left hunting for what to cancel",
    );
    // Scoped to (project, OWNER), not to the project: refusing project-wide
    // would stop a second lead watching a crew it shares, which decides the
    // cross-lead question todo 315 comment 631 records as unanswered.
    const other = new McpClient({
      cwd: dirs.projectDir,
      dataDir: dirs.dataDir,
      env: { HIVE_AGENT_ID: "user:a-second-lead", ...(livePane ? { TMUX_PANE: livePane } : {}) },
    });
    await other.start();
    try {
      const second = await other.call("wake_when_idle", { body: "the other lead's watch", scope: "project" });
      assert.ok(second.wake_id > first.wake_id, "a different owner is not refused");
      await other.call("wake_cancel", { wake_id: second.wake_id });
    } finally {
      await other.close();
    }
    await mcp.call("wake_cancel", { wake_id: first.wake_id });
    // And once it is cancelled the owner may set another, or a lead could
    // never replace its own watch.
    const replacement = await mcp.call("wake_when_idle", { body: "a fresh one", scope: "project" });
    await mcp.call("wake_cancel", { wake_id: replacement.wake_id });
  });

  // THE LIFETIME, AGAINST A REAL PANE, and it is here rather than in a
  // fixture for a reason worth recording. A fixture version of this test
  // PASSED against the pre-lane source: a row with kind='idle_any', an empty
  // watch list and a max_wait_at in the past fires through the existing
  // timeout branch whether or not this lane exists, so the assertion "it
  // fired" was already true. The only thing that is actually new at expiry is
  // WHAT IT SAYS, and the only place that exists is the pane. So the test
  // reads the pane. (workflows/verify-a-test-goes-red-first.md, step 9: ask
  // what the test would assert if the subject did nothing.)
  it("delivers one last wake saying it expired, and then stops being a candidate", NEEDS_TMUX, async () => {
    const receipt = await mcp.call("wake_when_idle", { body: "crew update", scope: "project" });
    const { db } = await import("../dist/db.js");
    db.prepare("UPDATE timers SET max_wait_at = datetime('now', '-1 seconds') WHERE id = ?").run(receipt.wake_id);
    // The running server's own scheduler delivers it, on its own tick.
    //
    // THE MARGIN IS NAMED, and until()'s own 3000ms DEFAULT IS EXACTLY THE
    // SCHEDULER'S TICK INTERVAL (startScheduler's default, src/scheduler.ts),
    // so the default gives this delivery ONE tick's chance and no slack for
    // the ~300ms ENTER_DELAY_MS and the tmux forks after it. That is not a
    // theoretical race: it failed under the full suite at 3008ms while
    // passing on its own, and until() RETURNS FALSE rather than throwing, so
    // it failed on the row assertion below with a message about the wrong
    // thing. Six tick opportunities, asserted on directly.
    // (.claude/sessions/decisions/2026-07-31-accept-margin-over-happens-
    // before.md: a margin is not a happens-before, so anchor it to the real
    // product constant and make shrinking it loud.)
    const SCHEDULER_TICK_MS = 3000;
    const delivered = await until(
      () => capturePaneText(livePane).includes("standing watch has expired"),
      SCHEDULER_TICK_MS * 6,
    );
    assert.ok(delivered, "the expiry wake was never typed into the owner's pane");
    const row = db.prepare("SELECT fired_at, fire_count FROM timers WHERE id = ?").get(receipt.wake_id);
    assert.ok(row.fired_at !== null, "the expiry must SPEAK; a silent one is the original bug with a timer on it");
    assert.equal(row.fire_count, 1, "and it leaves the candidate set, so it can never fire twice");
    assert.match(
      capturePaneText(livePane),
      /nothing is watching now/,
      "the sentence has to tell a lead that it is now unwatched, not just that a timer elapsed",
    );
  });

  // TODO 390 (pad 142 PART 3, the cheap win). Every generated notice's body
  // is a snapshot, so it must say when it was taken and how stale it already
  // is by the time a human reads it. Proven against a REAL delivery, because
  // the trailer is appended in deliver() itself, not stored in the row's own
  // body - a test that only read the `body` column would not see it at all.
  // ITS OWN SESSION AND PANE, deliberately not the shared `mcp`/`livePane`
  // above: those accumulate every prior test's pasted text for the life of
  // this describe block, past the pane's own visible height, and even a
  // wide `-S` scrollback capture came back with this assertion's own tail
  // silently missing - a pty input-buffer limit on the "sleep 600" pane's
  // cooked-mode echo, not anything this lane's own code does. A fresh pane
  // starts with nothing in it, so this cannot be that.
  it("tells the reader when the notice was observed and how long it sat before this reached them", NEEDS_TMUX, async () => {
    const staleSession = `hive-standing-watch-staleness-${process.pid}`;
    execFileSync("tmux", ["new-session", "-d", "-s", staleSession, "sleep 600"], { stdio: "ignore" });
    const stalePane = execFileSync("tmux", ["list-panes", "-t", `=${staleSession}`, "-F", "#{pane_id}"], {
      encoding: "utf8",
    }).trim();
    const staleMcp = new McpClient({
      cwd: dirs.projectDir,
      dataDir: dirs.dataDir,
      env: { HIVE_AGENT_ID: "user:staleness-owner", TMUX_PANE: stalePane },
    });
    try {
      await staleMcp.start();
      const receipt = await staleMcp.call("wake_when_idle", { body: "crew update", scope: "project" });
      const { db } = await import("../dist/db.js");
      const projectId = db.prepare("SELECT project_id FROM timers WHERE id = ?").get(receipt.wake_id).project_id;
      // A GONE worker, not an idle one: standingGoneRows consults no tmux at
      // all, so this needs no second real pane the way an idle finish would.
      db.prepare(
        `INSERT INTO agents (project_id, actor_id, name, tmux_target, command, cwd, kind, status,
            agent_state, state_changed_at, closed_at)
          VALUES (?, 'agent:staleness-1', 'w1', '%doesnotexist', 'claude', '/tmp', 'agent', 'closed',
            'working', datetime('now'), datetime('now'))`,
      ).run(projectId);
      const staleCapture = () => execFileSync("tmux", ["capture-pane", "-p", "-t", stalePane]).toString();
      const SCHEDULER_TICK_MS = 3000;
      const delivered = await until(() => staleCapture().includes("finished or gone away"), SCHEDULER_TICK_MS * 6);
      assert.ok(delivered, "the finish notice must actually reach the pane");
      assert.match(
        staleCapture(),
        /Held since \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC \(\d+[sm] ago\)\. Its content reflects what hive knew/,
        "the staleness trailer must be on the DELIVERED text, not just the stored body",
      );
      await staleMcp.call("wake_cancel", { wake_id: receipt.wake_id });
    } finally {
      await staleMcp.close();
      cleanup(staleSession);
    }
  });

  // TODO 390 COUNSELORS ROUND 3, F6 (opus + fable, independently). The
  // fixture-based "keeps the hold's own start time separate..." test
  // re-implements the MIN(notified_at) query inline and never calls
  // noticeStalenessNote or delivers anything, and the real-delivery
  // staleness test above uses a single, uncoalesced notice where both
  // clocks agree to the second - so neither can fail against a version that
  // silently reads `heldSince = timer.created_at` for both halves, which is
  // the exact defect round 1 shipped. THIS test forces the two clocks apart
  // (a 45-minute backdated first episode, matching pad 142's own scenario)
  // AND delivers the result through the real, running server, then reads
  // BOTH numbers back off the DELIVERED PANE TEXT - proving what the
  // header comment above claims rather than asserting it.
  it("delivers a coalesced notice whose held-since and content-refreshed clocks were genuinely forced apart", NEEDS_TMUX, async () => {
    const clockSession = `hive-standing-watch-clocks-${process.pid}`;
    // `cat > file`, NOT `sleep 600`: this notice's body (two candidates plus
    // the coalescing summary) is long enough to hit a real limit `sleep`'s
    // pane hits elsewhere in this file - nothing reads a `sleep` pane's
    // stdin, so the pty's own cooked-mode input queue fills and silently
    // drops the tail of a long paste, independent of this lane's own code
    // (measured: cut off mid-word, at a different byte offset each run).
    // `cat` continuously drains stdin, so nothing queues up, and every byte
    // sent lands in the file - read that back instead of capture-pane's
    // viewport, which only ever showed what `cat` echoed to its OWN stdout,
    // a second and unrelated copy.
    const captureFile = join(dirs.tmp, "clock-capture.txt");
    execFileSync("tmux", ["new-session", "-d", "-s", clockSession, "bash", "-c", `cat > ${captureFile}`], {
      stdio: "ignore",
    });
    const clockPane = execFileSync("tmux", ["list-panes", "-t", `=${clockSession}`, "-F", "#{pane_id}"], {
      encoding: "utf8",
    }).trim();
    // LEAD-SHAPED ACTOR, DELIBERATELY. isLeadActorId is a bare string-prefix
    // check with no row lookup behind it (worker-state.md), so this needs no
    // real agents row to get deliverable()'s lead exemption: a dead
    // deliver_pane HOLDS (retried every tick) rather than being CANCELLED
    // outright, which is what a non-lead owner gets with no SETTLE_WINDOW
    // grace at all. That HOLD is what buys the window this test needs
    // between the two finishes - a live pane throughout would let the FIRST
    // notice deliver before the second finish ever has a chance to coalesce
    // into it, which is exactly the race the first version of this test hit.
    const clockMcp = new McpClient({
      cwd: dirs.projectDir,
      dataDir: dirs.dataDir,
      env: { HIVE_AGENT_ID: "lead:990001", TMUX_PANE: clockPane },
    });
    try {
      await clockMcp.start();
      const receipt = await clockMcp.call("wake_when_idle", { body: "crew update", scope: "project" });
      const { db } = await import("../dist/db.js");
      const projectId = db.prepare("SELECT project_id FROM timers WHERE id = ?").get(receipt.wake_id).project_id;
      // Redirect BEFORE any finish is added, so every notice this watch
      // files inherits the dead pane and holds from birth.
      db.prepare("UPDATE timers SET deliver_pane = '%doesnotexist' WHERE id = ?").run(receipt.wake_id);
      // GONE workers, not idle ones: standingGoneRows consults no tmux at
      // all, so neither needs its own real pane the way an idle finish would.
      const addDead = (actor, name) =>
        db
          .prepare(
            `INSERT INTO agents (project_id, actor_id, name, tmux_target, command, cwd, kind, status,
                agent_state, state_changed_at, closed_at)
              VALUES (?, ?, ?, '%doesnotexist', 'claude', '/tmp', 'agent', 'closed',
                'working', datetime('now'), datetime('now'))`,
          )
          .run(projectId, actor, name);
      const noticeRow = () =>
        db
          .prepare("SELECT id, body, fired_at FROM timers WHERE parent_timer_id = ? ORDER BY id DESC LIMIT 1")
          .get(receipt.wake_id);
      const SCHEDULER_TICK_MS = 3000;

      addDead("agent:clocks-1", "clock-a");
      const filed = await until(() => noticeRow() !== undefined, SCHEDULER_TICK_MS * 4);
      assert.ok(filed, "the first finish must be filed as a notice before this test can force the clocks apart");
      const first = noticeRow();
      assert.equal(first.fired_at, null, "must still be HELD (dead pane), or the coalescing window is already closed");

      db.prepare(
        "UPDATE wake_idle_notices SET notified_at = datetime('now', '-45 minutes') WHERE notice_timer_id = ?",
      ).run(first.id);
      addDead("agent:clocks-2", "clock-b");
      const coalesced = await until(() => {
        const n = noticeRow();
        return n !== undefined && n.id === first.id && n.fired_at === null && n.body.includes("clock-a") && n.body.includes("clock-b");
      }, SCHEDULER_TICK_MS * 4);
      assert.ok(coalesced, "the second finish must update the SAME notice, or this is not testing a coalesced one");

      // RELEASE THE HOLD, matching what `hive lead` does on restart: point
      // the pending notice at the real, live pane so the next tick delivers.
      db.prepare("UPDATE timers SET deliver_pane = ? WHERE id = ?").run(clockPane, first.id);

      const clockCapture = () => (existsSync(captureFile) ? readFileSync(captureFile, "utf8") : "");
      // Poll for text at the very END of what deliver() sends (the trailer,
      // appended after the body), not text near the start - `cat`'s own
      // write-to-file buffering does not guarantee the whole single paste
      // lands in the file atomically, so polling on an early marker like
      // "finished or gone away" can see a PARTIAL write that stops short of
      // the trailer this test exists to check, and read that as "delivered"
      // before it actually was. Waiting for the trailer's own last words
      // means everything before it, in the same write, is already there.
      const delivered = await until(() => clockCapture().includes("reached you."), SCHEDULER_TICK_MS * 6);
      assert.ok(delivered, "the coalesced notice must actually reach the pane");

      const text = clockCapture();
      const parseAge = (n, unit) => Number(n) * (unit === "h" ? 3600 : unit === "m" ? 60 : 1);
      const heldMatch = text.match(/Held since [^(]+\((\d+)([smh]) ago\)/);
      const contentMatch = text.match(
        /Its content reflects what hive knew as of [^,]+, (\d+)([smh]) before this reached you/,
      );
      assert.ok(heldMatch && contentMatch, `both clauses must be on the delivered text; got: ${text}`);
      const heldSeconds = parseAge(heldMatch[1], heldMatch[2]);
      const contentSeconds = parseAge(contentMatch[1], contentMatch[2]);
      assert.ok(
        heldSeconds >= 40 * 60,
        `held-since must reflect the 45-minute backdated first episode (got "${heldMatch[0]}")`,
      );
      assert.ok(
        contentSeconds < 5 * 60,
        `content-refreshed must be recent, not carrying the 45-minute backdate (got "${contentMatch[0]}")`,
      );
      await clockMcp.call("wake_cancel", { wake_id: receipt.wake_id });
    } finally {
      await clockMcp.close();
      cleanup(clockSession);
    }
  });

  // THE WIRING, which the fixture above cannot see: it calls seedGoneCursor
  // itself, so it proves the seeded cursor SUPPRESSES a death and proves
  // nothing about anyone calling it. This is the half that fails if
  // createStandingWatch stops seeding.
  it("writes the crew's existing dead into its cursor at creation, as history", NEEDS_TMUX, async () => {
    const { db } = await import("../dist/db.js");
    // The project row the server resolved for this cwd, read off a wake it
    // created rather than guessed at from a path.
    const probe = await mcp.call("wake_when_idle", { body: "probe", scope: "project" });
    const projectId = db.prepare("SELECT project_id FROM timers WHERE id = ?").get(probe.wake_id).project_id;
    await mcp.call("wake_cancel", { wake_id: probe.wake_id });
    const dead = db
      .prepare(
        `INSERT INTO agents (project_id, actor_id, name, tmux_target, command, cwd, kind, status,
            agent_state, state_changed_at, closed_at)
          VALUES (?, 'agent:already-dead', 'already-dead', '%99', 'claude', '/tmp', 'agent', 'closed',
            'working', datetime('now'), datetime('now')) RETURNING id`,
      )
      .get(projectId).id;
    const receipt = await mcp.call("wake_when_idle", { body: "crew update", scope: "project" });
    const seeded = db
      .prepare("SELECT condition, episode, notice_timer_id FROM wake_idle_notices WHERE timer_id = ? AND agent_id = ?")
      .get(receipt.wake_id, dead);
    await mcp.call("wake_cancel", { wake_id: receipt.wake_id });
    assert.ok(seeded, "a worker already dead when the watch is set is recorded by the creation itself");
    assert.equal(seeded.condition, "gone");
    assert.equal(
      seeded.notice_timer_id,
      null,
      "with no notice behind it, so the delivery-failure re-arm can never resurrect it as news",
    );
  });

  it("cancels the notices a watch already filed, along with the watch", NEEDS_TMUX, async () => {
    const receipt = await mcp.call("wake_when_idle", { body: "crew update", scope: "project" });
    const { db } = await import("../dist/db.js");
    // A notice the watch would have filed, written directly: what is under
    // test is the cascade, not the filing, and the scheduler tests above
    // already pin the filing.
    const notice = db
      .prepare(
        `INSERT INTO timers (project_id, owner, body, kind, deliver_actor, deliver_pane, due_at, parent_timer_id)
         SELECT project_id, owner, 'w1 finished', 'delay', deliver_actor, deliver_pane, datetime('now', '+3600 seconds'), id
           FROM timers WHERE id = ? RETURNING id`,
      )
      .get(receipt.wake_id).id;
    const cancelled = await mcp.call("wake_cancel", { wake_id: receipt.wake_id });
    assert.equal(cancelled.cancelled, true);
    assert.equal(cancelled.cancelled_notices, 1);
    assert.ok(
      db.prepare("SELECT cancelled_at FROM timers WHERE id = ?").get(notice).cancelled_at !== null,
      "a notice orphaned by its watch types into a lead's pane about a watch that no longer exists",
    );
  });
});
