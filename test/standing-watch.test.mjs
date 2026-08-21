import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { DIST, isolateTmux, McpClient, runFixture, scratchDirs, until } from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("the standing watch tests");
const NEEDS_TMUX = { skip: hasTmux ? false : "tmux is not installed" };

const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;

const fixtureEnv = (dataDir) => ({ HIVE_DATA_DIR: dataDir, TMUX_TMPDIR: process.env.TMUX_TMPDIR });

const IMPORTS =
  `const { db, migrate } = await import(${JSON.stringify(join(DIST, "db.js"))});\n` +
  `const { tick, seedGoneCursor } = await import(${JSON.stringify(join(DIST, "scheduler.js"))});\n` +
  "migrate();\n";

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
const addWorkerWithParent = (actor, name, pane, state, changedOffset, parentActorId) =>
  db.prepare(
    \`INSERT INTO agents (project_id, actor_id, name, tmux_target, command, cwd, kind, status,
        agent_state, state_changed_at, created_at, parent_actor_id)
      VALUES (?, ?, ?, ?, 'claude', '/tmp', 'agent', 'running', ?,
        datetime('now', ?), datetime('now', '-300 seconds'), ?) RETURNING id\`,
  ).get(project, actor, name, pane, state, changedOffset, parentActorId).id;
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
      // Delivered to the lead (the default), which must stay lead-targeted so the notice keeps
      // HOLDING rather than really firing between ticks (a dead pane on a non-lead target gets
      // cancelled or, worse, thrown-through mid-tick by a real send failure - only a lead-owned wake
      // is exempt) - which is exactly what this test needs across three ticks to prove the
      // coalescing itself. The STORED body is the full render regardless of target (todo 455 fix 1);
      // only the DELIVERED text shortens for a lead, and this fixture never really delivers.
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
    assert.match(result.first[0], /^1 worker\(s\) in this project have finished or gone away/);
    assert.match(result.first[0], /^ {2}w1: /m);
    assert.doesNotMatch(result.first[0], /^ {2}w2:/m, "w2 had not finished and must not be named yet");
    assert.match(result.first[0], /Still going: w2/, "and it still names what is still running");

    assert.deepEqual(result.noticeWatchLists, ["[]"], "a notice must watch nothing, or deliver() pastes worker screens");

    assert.equal(result.second.length, 1, "the pane is still held; a second finish must not queue a second notice");
    assert.match(result.second[0], /^2 worker\(s\) in this project have finished or gone away/);
    assert.match(result.second[0], /^ {2}w1: /m);
    assert.match(result.second[0], /^ {2}w2: /m);

    assert.equal(result.watch.fired_at, null, "the watch's own row must never fire while it is watching");
    assert.equal(result.watch.fire_count, 0);
  });

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

      ["%1", "%lead"],
    );
    assert.equal(result.ownerRows, 0, "the fixture must really be the rowless case, or it proves nothing");
    assert.equal(result.bodies.length, 1, "a session with no agents row still gets told; it has a pane either way");
    assert.match(result.bodies[0], /w1/);
    assert.deepEqual(result.panes, ["%lead"], "and it is told at the pane the wake itself resolved");
  });

  it("files notices at deliver_to, the target the receipt named", () => {

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

    const result = fixture(
      "body-on-every-notice",
      `
      const w1 = addWorker('agent:1', 'w1', '%1', 'idle', '-30 seconds');
      // Delivered to a worker: the echoed body is deferred to wake_get for a lead target (todo 455
      // commit 3), so this pins the FULL render, which still echoes it inline.
      const watchId = addStandingWatch('-60 seconds', '+4 hours', {
        body: 'read its diff, complete its todo, dispatch the one it unblocks',
        deliverActor: 'agent:9',
        deliverPane: '%9',
      });
      await tick(snapshot);
      ${out("{ bodies: notices(watchId).map((n) => n.body) }")}
      `,
      ["%1", "%2", "%9"],
    );
    assert.equal(result.bodies.length, 1);
    assert.match(result.bodies[0], /read its diff, complete its todo, dispatch the one it unblocks/);
    assert.match(result.bodies[0], /what you asked to be told/, "and labelled, so it is not read as hive's own voice");
  });

  it("keeps reporting after max_wait passes while its expiry cannot be delivered", () => {

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

    assert.equal(result.oneShotRow.fired_at, null);
    assert.equal(
      result.oneShotRow.held_reason,
      null,
      "control: mode=any never even offered this wake for delivery, so the two really do differ - a held wake would read fired_at null as well",
    );
  });
});

describe("the cursor is a transition, not a timestamp", () => {

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

    assert.equal(result.afterRealWork, 1, "control: a real turn between two idles IS a new finish, held in the same notice");
  });

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

    assert.equal(result.notices, 1, "a truncated interval is unanswerable, and unanswerable must not mean silent");
  });

  it("control: an INTACT log that records no work is evidence, and stays quiet", () => {

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

    const result = fixture(
      "gone-worker",
      `
      const w1 = addWorker('agent:1', 'w1', '%1', 'working', '-120 seconds');
      const w2 = addWorker('agent:2', 'w2', '%2', 'working', '-120 seconds');
      // Delivered to a worker, to pin the FULL render's GONE prose.
      const watchId = addStandingWatch('-60 seconds', '+4 hours', { deliverActor: 'agent:9', deliverPane: '%9' });
      await tick(snapshot);
      const before = notices(watchId).length;

      // w1's window dies. The janitor closes the row on the next tick, which
      // is the real path: nothing else stamps closed_at. '%9' (the notice's
      // own delivery pane) must stay alive here too, or the janitor cancels
      // the watch itself for a dead delivery pane before candidates are read.
      const shrunk = { panes: new Set(['%2', '%9']), windows: new Set() };
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
      ["%1", "%2", "%9"],
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

  it("stays quiet when the lead closes a worker it already read, and still reports one that died mid-work", () => {
    const result = fixture(
      "close-from-idle-versus-death",
      `
      const done = addWorker('agent:1', 'done', '%1', 'idle', '-30 seconds');
      const died = addWorker('agent:2', 'died', '%2', 'working', '-120 seconds');
      // Delivered to the lead (the default), which must stay lead-targeted so the notice keeps
      // HOLDING rather than really firing between the three ticks below - the coalescing this test
      // depends on. The stored body is the full render (todo 455 fix 1).
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
    assert.match(result.afterFinish[0], /^1 worker\(s\) in this project have finished or gone away/);
    assert.match(result.afterFinish[0], /^ {2}done: /m);
    assert.equal(result.frozen, "idle", "the premise: a close freezes the state, it does not clear it");
    assert.deepEqual(
      result.afterClose,
      result.afterFinish,
      "closing a worker the lead has already read is its own tidy-up, not a death to be woken for",
    );

    assert.equal(result.afterDeath.length, 1, "a row that closed while it still read working IS the death this reports");
    assert.match(result.afterDeath[0], /^2 worker\(s\) in this project have finished or gone away/);
    assert.match(result.afterDeath[0], /^ {2}done: /m);
    assert.match(
      result.afterDeath[0],
      /^ {2}died: GONE - /m,
      "a fresh GONE (not a stale one) needs no annotation, plain and named",
    );
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
      // Delivered to a worker, to pin the FULL render's GONE prose.
      const watchId = addStandingWatch('-60 seconds', '+4 hours', { deliverActor: 'agent:9', deliverPane: '%9' });
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

describe("todo 390: coalescing while held", () => {
  it("holds a pane's second finish in the SAME pending notice instead of queuing a new one, and names both workers", () => {
    const result = fixture(
      "coalesce-two-finishes",
      `
      const w1 = addWorker('agent:1', 'w1', '%1', 'working', '-120 seconds');
      const w2 = addWorker('agent:2', 'w2', '%2', 'working', '-120 seconds');
      // Delivered to the lead (the default), which must stay lead-targeted so the notice keeps
      // HOLDING rather than really firing between the two ticks below - the coalescing this test
      // depends on. The stored body is the full render (todo 455 fix 1).
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
    assert.match(result.bodyAfterFirst, /^1 worker\(s\) in this project have finished or gone away/, "the FIRST write names only the worker finished so far");
    assert.match(result.bodyAfterFirst, /^ {2}w1: /m);
    assert.doesNotMatch(result.bodyAfterFirst, /^ {2}w2:/m, "w2 had not finished when the first write happened");
    assert.match(result.bodyAfterSecond, /^2 worker\(s\) in this project have finished or gone away/, "the SECOND write names both, by an updated count");
    assert.match(result.bodyAfterSecond, /^ {2}w1: /m);
    assert.match(result.bodyAfterSecond, /^ {2}w2: /m);
    assert.equal(result.cursor.length, 2, "both episodes are recorded in the cursor");
    assert.deepEqual(
      result.cursor.map((c) => c.notice_timer_id),
      [result.idsAfterSecond[0], result.idsAfterSecond[0]],
      "both episodes point at the ONE notice that carries them - what the delivery-failure re-arm reads",
    );
  });

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

  it("does not re-assert a stale obituary for a GONE worker that was resumed while the notice was held", () => {
    const result = fixture(
      "coalesce-gone-then-resumed",
      `
      const died = addWorker('agent:1', 'died', '%1', 'working', '-120 seconds');
      const w2 = addWorker('agent:2', 'w2', '%2', 'working', '-120 seconds');
      // Delivered to the lead (the default), which must stay lead-targeted so the notice keeps
      // HOLDING rather than really firing between the two ticks below - the coalescing this test
      // depends on. The stored body is the full render (todo 455 fix 1).
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
    assert.match(result.firstBody, /^ {2}died: GONE - /m, "the premise: died was genuinely reported GONE before the resume");
    assert.doesNotMatch(result.firstBody, /was reported GONE earlier in this hold/, "not stale yet - the row had not moved when this was first reported");
    assert.match(
      result.mergedBody,
      /^ {2}died: was reported GONE earlier in this hold, but its row's state has moved since/m,
      "the full render must still flag a stale GONE report, not silently drop the correction (todo 455 fix 1: " +
        "this is what must not collapse into the delivery-time short line either)",
    );
    assert.match(result.mergedBody, /w2/, "the finish that actually happened on this tick must still be named");
  });
});

describe("the guards nothing else reaches", () => {
  it("never reports the delivery target to itself, even when its pane has moved", () => {

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

      ["%1", "%3"],
    );
    assert.equal(result.bodies.length, 1, "the live worker is still reported, or this test proves only that nothing ran");
    assert.match(result.bodies[0], /live/);
    assert.doesNotMatch(result.bodies[0], /dead-pane/, "a running row whose pane is gone is not a finish hive observed");
    assert.doesNotMatch(result.bodies[0], /foreign/, "and a row recorded on another server's socket is not ours to read");
    assert.equal(result.cursor, 1, "neither may consume its episode: the cursor would swallow the real finish later");
  });

  it("summarises the roster past its bound instead of pasting the whole crew", () => {

    const result = fixture(
      "roster-bound",
      `
      const done = addWorker('agent:0', 'done', '%0', 'idle', '-30 seconds');
      for (let i = 1; i <= 10; i++) addWorker('agent:' + i, 'w' + i, '%' + i, 'working', '-120 seconds');
      // Delivered to a worker outside the numbered crew above, to pin the FULL render's own
      // per-name "Still going" roster cap (the delivery-time short render for a lead caps
      // differently - it prints a bare count, not a capped name list, so this bound does not apply
      // to it).
      const watchId = addStandingWatch('-60 seconds', '+4 hours', { deliverActor: 'agent:99', deliverPane: '%99' });
      await tick(snapshot);
      ${out("{ bodies: notices(watchId).map((n) => n.body) }")}
      `,
      ["%0", "%1", "%2", "%3", "%4", "%5", "%6", "%7", "%8", "%9", "%10", "%99"],
    );
    assert.equal(result.bodies.length, 1);
    const roster = result.bodies[0].split("\n").find((l) => l.startsWith("Still going:"));
    assert.ok(roster, "the roster line must exist, or the assertions below are about nothing");
    assert.equal(roster.split(";").length, 8, "eight named, not the whole crew pasted into a terminal");
    assert.match(roster, /, and 2 more\.$/, "and the rest counted, so the lead knows what it is not being shown");
    assert.doesNotMatch(roster, /w9|w10/, "the summarised tail really is left out, rather than the count being decoration");
  });
});

describe("todo 455 commit 1: the parent filter", () => {
  it("suppresses a grandchild spawned by a worker, not by the watch's own owner", () => {
    const result = fixture(
      "parent-filter-worker-grandchild",
      `
      const w1 = addWorker('agent:1', 'w1', '%1', 'idle', '-30 seconds');
      const probe = addWorkerWithParent('agent:2', 'probe', '%2', 'idle', '-30 seconds', 'agent:1');
      const watchId = addStandingWatch();
      await tick(snapshot);
      ${out("{ bodies: notices(watchId).map((n) => n.body) }")}
      `,
    );
    assert.equal(result.bodies.length, 1, "the tick must really have reported something, or this proves nothing");
    assert.match(result.bodies[0], /w1/, "the real lane, spawned by the watch's owner, is still reported");
    assert.doesNotMatch(
      result.bodies[0],
      /probe/,
      "a worker's own throwaway probe is that worker's problem to notice, not the lead's",
    );
  });

  it("still reports a lead's own throwaway, since the lead is its own watch's owner (known limitation)", () => {
    const result = fixture(
      "parent-filter-lead-throwaway",
      `
      const probe = addWorkerWithParent('agent:1', 'lead-probe', '%1', 'idle', '-30 seconds', 'lead:1');
      const watchId = addStandingWatch();
      await tick(snapshot);
      ${out("{ bodies: notices(watchId).map((n) => n.body) }")}
      `,
    );
    assert.equal(result.bodies.length, 1);
    assert.match(result.bodies[0], /lead-probe/, "the filter only suppresses a WORKER's own throwaway, not the owner's");
  });

  it("reports a worker with no recorded parent at all, rather than dropping it silently", () => {
    const result = fixture(
      "parent-filter-null-parent",
      `
      const orphan = addWorker('agent:1', 'orphan', '%1', 'idle', '-30 seconds');
      const parentless = db.prepare("SELECT parent_actor_id FROM agents WHERE id = ?").get(orphan).parent_actor_id;
      const watchId = addStandingWatch();
      await tick(snapshot);
      ${out("{ parentless, bodies: notices(watchId).map((n) => n.body) }")}
      `,
    );
    assert.equal(result.parentless, null, "the fixture must really be the NULL-parent case, or this proves nothing");
    assert.equal(result.bodies.length, 1);
    assert.match(result.bodies[0], /orphan/, "a NULL parent must never be silently filtered out as though it failed the match");
  });

  it("binds the filter to the watch's OWNER, not its delivery target", () => {
    const result = fixture(
      "parent-filter-owner-not-deliver-actor",
      `
      const grandchild = addWorkerWithParent('agent:2', 'grandchild', '%2', 'idle', '-30 seconds', 'agent:5');
      const watchId = addStandingWatch('-60 seconds', '+4 hours', {
        owner: 'agent:5',
        deliverActor: 'lead:1',
        deliverPane: '%lead',
      });
      await tick(snapshot);
      ${out("{ bodies: notices(watchId).map((n) => n.body) }")}
      `,
    );
    assert.equal(result.bodies.length, 1, "the tick must really have reported something, or this proves nothing");
    assert.match(
      result.bodies[0],
      /grandchild/,
      "the watch's OWNER spawned this one, so it must be reported even though delivery goes to a different pane/actor",
    );
  });
});

describe("todo 455 fix 3: the still-going roster shares the parent filter", () => {
  it("does not count a grandchild as still going - it will never be reported finished either", () => {
    const result = fixture(
      "still-going-owned-by-watch",
      `
      const w1 = addWorker('agent:1', 'w1', '%1', 'idle', '-30 seconds');
      const realChild = addWorkerWithParent('agent:3', 'real-child', '%3', 'working', '-120 seconds', 'lead:1');
      const grandchild = addWorkerWithParent('agent:4', 'grandchild', '%4', 'working', '-120 seconds', 'agent:1');
      const watchId = addStandingWatch();
      await tick(snapshot);
      ${out("{ bodies: notices(watchId).map((n) => n.body) }")}
      `,
      ["%1", "%3", "%4"],
    );
    assert.equal(result.bodies.length, 1, "the tick must really have reported something, or this proves nothing");
    assert.match(result.bodies[0], /Still going: [^\n]*real-child/, "the owner's own still-running worker is named");
    assert.doesNotMatch(
      result.bodies[0],
      /Still going: [^\n]*grandchild/,
      "a grandchild the watch will never report as finished must not be promised as still going either",
    );
  });
});

describe("todo 455 fix 1: the notice row always stores the full render", () => {
  it("stores the full render for a lead target too, so wake_get(id) actually returns detail", () => {
    const result = fixture(
      "fix1-stores-full-for-lead",
      `
      const w1 = addWorker('agent:1', 'w1', '%1', 'idle', '-30 seconds');
      const watchId = addStandingWatch('-60 seconds', '+4 hours', {
        body: 'the parent watch body, reachable through wake_get for a lead target',
      });
      await tick(snapshot);
      ${out("{ body: notices(watchId)[0].body }")}
      `,
    );
    assert.match(result.body, /^1 worker\(s\) in this project have finished or gone away/);
    assert.match(result.body, /the parent watch body/, "the echoed parent body is stored, not thrown away");
    assert.match(result.body, /agent_output\(name:/, "the how-to-read paragraph is stored");
    assert.match(result.body, /STILL WATCHING/, "the still-watching/expiry reminder is stored");
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

    assert.equal(row.kind, "idle_any", "a new kind would need `timers` rebuilt past its CHECK, under live writers");

    assert.equal(row.watch, "[]", "a standing watch stores no list: its membership is a query, evaluated every tick");
    assert.equal(row.watch_scope, "project");
    assert.equal(receipt.standing, true);
    assert.equal(receipt.scope, "project");
    assert.ok(typeof receipt.expires_at === "string");
    assert.equal(receipt.max_wait_seconds, 14400, "four hours, and it is a judgement recorded in the code");

    await mcp.call("wake_cancel", { wake_id: receipt.wake_id });
  });

  it("refuses a second standing watch, and names the one already running", NEEDS_TMUX, async () => {
    const first = await mcp.call("wake_when_idle", { body: "crew update", scope: "project" });
    await assert.rejects(
      mcp.call("wake_when_idle", { body: "crew update again", scope: "project" }),
      new RegExp(`already have a standing watch[\\s\\S]*wake #${first.wake_id}[\\s\\S]*wake_cancel`),
      "the refusal has to name the id, or the lead is left hunting for what to cancel",
    );

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

    const replacement = await mcp.call("wake_when_idle", { body: "a fresh one", scope: "project" });
    await mcp.call("wake_cancel", { wake_id: replacement.wake_id });
  });

  it("delivers one last wake saying it expired, and then stops being a candidate", NEEDS_TMUX, async () => {
    const receipt = await mcp.call("wake_when_idle", { body: "crew update", scope: "project" });
    const { db } = await import("../dist/db.js");
    db.prepare("UPDATE timers SET max_wait_at = datetime('now', '-1 seconds') WHERE id = ?").run(receipt.wake_id);

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

  it("delivers a coalesced notice whose held-since and content-refreshed clocks were genuinely forced apart", NEEDS_TMUX, async () => {
    const clockSession = `hive-standing-watch-clocks-${process.pid}`;

    const captureFile = join(dirs.tmp, "clock-capture.txt");
    execFileSync("tmux", ["new-session", "-d", "-s", clockSession, "bash", "-c", `cat > ${captureFile}`], {
      stdio: "ignore",
    });
    const clockPane = execFileSync("tmux", ["list-panes", "-t", `=${clockSession}`, "-F", "#{pane_id}"], {
      encoding: "utf8",
    }).trim();

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

      db.prepare("UPDATE timers SET deliver_pane = '%doesnotexist' WHERE id = ?").run(receipt.wake_id);

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

      db.prepare("UPDATE timers SET deliver_pane = ? WHERE id = ?").run(clockPane, first.id);

      const clockCapture = () => (existsSync(captureFile) ? readFileSync(captureFile, "utf8") : "");

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

  it("todo 455 fix 1: types the short render to a lead pane while the stored body stays full, capped and citing its own id", NEEDS_TMUX, async () => {
    const leadSession = `hive-standing-watch-shortrender-${process.pid}`;
    const captureFile = join(dirs.tmp, "shortrender-capture.txt");
    execFileSync("tmux", ["new-session", "-d", "-s", leadSession, "bash", "-c", `cat > ${captureFile}`], {
      stdio: "ignore",
    });
    const leadPane = execFileSync("tmux", ["list-panes", "-t", `=${leadSession}`, "-F", "#{pane_id}"], {
      encoding: "utf8",
    }).trim();

    const leadMcp = new McpClient({
      cwd: dirs.projectDir,
      dataDir: dirs.dataDir,
      env: { HIVE_AGENT_ID: "lead:990002", TMUX_PANE: leadPane },
    });
    try {
      await leadMcp.start();
      const receipt = await leadMcp.call("wake_when_idle", { body: "crew update", scope: "project" });
      const { db } = await import("../dist/db.js");
      const projectId = db.prepare("SELECT project_id FROM timers WHERE id = ?").get(receipt.wake_id).project_id;

      // Closed directly, the same shape the "clocks"/"staleness" tests above use: a genuinely running
      // worker on a pane not in any snapshot would be reaped by the janitor as GONE before this test
      // could observe it as idle, so this pins the finish directly rather than racing that sweep.
      const addDead = (actor, name) =>
        db
          .prepare(
            `INSERT INTO agents (project_id, actor_id, name, tmux_target, command, cwd, kind, status,
                agent_state, state_changed_at, closed_at, created_at, parent_actor_id)
              VALUES (?, ?, ?, '%doesnotexist', 'claude', '/tmp', 'agent', 'closed', 'working',
                datetime('now'), datetime('now'), datetime('now', '-300 seconds'), 'lead:990002')`,
          )
          .run(projectId, actor, name);

      for (let i = 1; i <= 10; i++) addDead(`agent:shortrender-${i}`, `w${i}`);

      const noticeRow = () =>
        db
          .prepare("SELECT id, body FROM timers WHERE parent_timer_id = ? ORDER BY id DESC LIMIT 1")
          .get(receipt.wake_id);
      const SCHEDULER_TICK_MS = 3000;
      const filed = await until(() => noticeRow() !== undefined, SCHEDULER_TICK_MS * 4);
      assert.ok(filed, "the finish must be filed as a notice before this test can check it");
      const stored = noticeRow();
      assert.match(
        stored.body,
        /^10 worker\(s\) in this project have finished or gone away/,
        "the STORED body is the full render even for a lead target (todo 455 fix 1)",
      );

      const clockCapture = () => (existsSync(captureFile) ? readFileSync(captureFile, "utf8") : "");
      const delivered = await until(() => clockCapture().includes("wake_get("), SCHEDULER_TICK_MS * 6);
      assert.ok(delivered, "the short render must actually reach the lead's pane");
      const text = clockCapture();
      assert.match(
        text,
        new RegExp(`10 finished: [\\w, ]+\\(\\+2 more\\)\\. 0 still going\\. wake_get\\(${stored.id}\\) for detail\\.`),
        "the DELIVERED text is the short line, capped the same as the full render, citing the notice's own id",
      );
      assert.doesNotMatch(
        text,
        /worker\(s\) in this project have finished/,
        "the full-render prose must never leak into what is typed to a lead",
      );
      await leadMcp.call("wake_cancel", { wake_id: receipt.wake_id });
    } finally {
      await leadMcp.close();
      cleanup(leadSession);
    }
  });

  it("todo 455 fix 6: a stalled/blocked worker's notice is NEVER shortened for a lead - pins the TYPED text, not the stored body", NEEDS_TMUX, async () => {
    const leadSession = `hive-standing-watch-stall-shortrender-${process.pid}`;
    const captureFile = join(dirs.tmp, "stall-shortrender-capture.txt");
    execFileSync("tmux", ["new-session", "-d", "-s", leadSession, "bash", "-c", `cat > ${captureFile}`], {
      stdio: "ignore",
    });
    const leadPane = execFileSync("tmux", ["list-panes", "-t", `=${leadSession}`, "-F", "#{pane_id}"], {
      encoding: "utf8",
    }).trim();

    // A real pane, or the janitor reaps this row as GONE (a dead pane) before stallCandidateRows ever
    // sees it as 'working' - the same trap the "shortrender" fix-1 test above hit with idle workers.
    const stuckSession = `hive-standing-watch-stall-worker-${process.pid}`;
    execFileSync("tmux", ["new-session", "-d", "-s", stuckSession, "sleep 600"], { stdio: "ignore" });
    const stuckPane = execFileSync("tmux", ["list-panes", "-t", `=${stuckSession}`, "-F", "#{pane_id}"], {
      encoding: "utf8",
    }).trim();

    const leadMcp = new McpClient({
      cwd: dirs.projectDir,
      dataDir: dirs.dataDir,
      env: { HIVE_AGENT_ID: "lead:990003", TMUX_PANE: leadPane },
    });
    try {
      await leadMcp.start();
      const receipt = await leadMcp.call("wake_when_idle", { body: "crew update", scope: "project" });
      const { db } = await import("../dist/db.js");
      const projectId = db.prepare("SELECT project_id FROM timers WHERE id = ?").get(receipt.wake_id).project_id;

      // agent_state 'working' needs no live-pane check at all in noteStalledCrew (only 'waiting' does),
      // so a real pane here is only to survive the janitor sweep, not to satisfy the stall detector
      // itself. No transcript file means transcriptStaleness() reads "never", which still qualifies.
      db.prepare(
        `INSERT INTO agents (project_id, actor_id, name, tmux_target, command, cwd, session_id, kind, status,
            agent_state, state_changed_at, created_at)
          VALUES (?, 'agent:stall-shortrender-1', 'stuck-worker', ?, 'claude', '/tmp/stuck',
            'sid-stuck', 'agent', 'running', 'working', datetime('now', '-1200 seconds'),
            datetime('now', '-1200 seconds'))`,
      ).run(projectId, stuckPane);

      const noticeRow = () =>
        db
          .prepare("SELECT id, body FROM timers WHERE parent_timer_id = ? ORDER BY id DESC LIMIT 1")
          .get(receipt.wake_id);
      const SCHEDULER_TICK_MS = 3000;
      const filed = await until(() => noticeRow() !== undefined, SCHEDULER_TICK_MS * 4);
      assert.ok(filed, "the stall must be filed as a notice before this test can check it");
      const stored = noticeRow();
      assert.match(
        stored.body,
        /worker\(s\) in this project have stopped writing to their transcript/,
        "the fixture must really be a stall notice, or this proves nothing",
      );

      const capture = () => (existsSync(captureFile) ? readFileSync(captureFile, "utf8") : "");
      const delivered = await until(() => capture().includes("stuck-worker"), SCHEDULER_TICK_MS * 6);
      assert.ok(delivered, "the stall notice must actually reach the lead's pane");
      const text = capture();
      assert.match(
        text,
        /worker\(s\) in this project have stopped writing to their transcript/,
        "the DELIVERED text must be the full stall body - this class has no other surface that will ever report it",
      );
      assert.match(text, /stuck-worker: has claimed `working`/);
      assert.doesNotMatch(
        text,
        /\d+ finished: /,
        "a stalled worker must never be typed as a FINISH - it has not finished, it is stopped",
      );
      assert.doesNotMatch(text, /wake_get\(/, "the short-render's wake_get pointer must not appear on a stall notice");
      await leadMcp.call("wake_cancel", { wake_id: receipt.wake_id });
    } finally {
      await leadMcp.close();
      cleanup(leadSession);
      cleanup(stuckSession);
    }
  });

  it("todo 455 fix 4: watching_now names only the crew the delivery path will ever report, not a grandchild", NEEDS_TMUX, async () => {
    const { db } = await import("../dist/db.js");

    const probe = await mcp.call("wake_when_idle", { body: "probe", scope: "project" });
    const projectId = db.prepare("SELECT project_id FROM timers WHERE id = ?").get(probe.wake_id).project_id;
    await mcp.call("wake_cancel", { wake_id: probe.wake_id });

    db.prepare(
      `INSERT INTO agents (project_id, actor_id, name, tmux_target, command, cwd, kind, status, parent_actor_id)
        VALUES (?, 'agent:fix4-real', 'fix4-real', '%doesnotexist', 'claude', '/tmp', 'agent', 'running', ?)`,
    ).run(projectId, OWNER);
    db.prepare(
      `INSERT INTO agents (project_id, actor_id, name, tmux_target, command, cwd, kind, status, parent_actor_id)
        VALUES (?, 'agent:fix4-grand', 'fix4-grandchild', '%doesnotexist', 'claude', '/tmp', 'agent', 'running', 'agent:fix4-real')`,
    ).run(projectId);

    const receipt = await mcp.call("wake_when_idle", { body: "crew update", scope: "project" });
    await mcp.call("wake_cancel", { wake_id: receipt.wake_id });
    db.prepare("DELETE FROM agents WHERE actor_id IN ('agent:fix4-real', 'agent:fix4-grand')").run();

    assert.ok(receipt.watching_now.includes("fix4-real"), "the owner's own worker must be named as watched");
    assert.ok(
      !receipt.watching_now.includes("fix4-grandchild"),
      "a grandchild the delivery path will never report as finished must not be promised as watched either",
    );
  });

  it("writes the crew's existing dead into its cursor at creation, as history", NEEDS_TMUX, async () => {
    const { db } = await import("../dist/db.js");

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
