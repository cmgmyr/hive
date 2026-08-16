import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";

import { DIST, isolateTmux, runFixture, scratchDirs } from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("the notified_at discriminator tests");
const NEEDS_TMUX = { skip: hasTmux ? false : "tmux is not installed" };

const fixtureEnv = (dataDir) => ({ HIVE_DATA_DIR: dataDir, TMUX_TMPDIR: process.env.TMUX_TMPDIR });

const IMPORTS =
  `const { db, migrate } = await import(${JSON.stringify(join(DIST, "db.js"))});\n` +
  `const { tick } = await import(${JSON.stringify(join(DIST, "scheduler.js"))});\n` +
  "migrate();\n";

const SEED = `
const project = db.prepare("INSERT INTO projects (name, path) VALUES ('na', '/tmp/na') RETURNING id").get().id;
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
const addStandingWatch = () =>
  db.prepare(
    \`INSERT INTO timers (project_id, owner, body, kind, watch_scope, deliver_actor, deliver_pane,
        max_wait_at, created_at)
      VALUES (?, 'lead:1', 'crew update', 'idle_any', 'project', 'lead:1', '%lead',
        datetime('now', '+4 hours'), datetime('now', '-60 seconds')) RETURNING id\`,
  ).get(project).id;
const notices = (watchId) =>
  db.prepare("SELECT id, fired_at, typed_at FROM timers WHERE parent_timer_id = ? ORDER BY id").all(watchId);
const cursor = (watchId) =>
  db.prepare(
    "SELECT agent_id, condition, episode, notice_timer_id, notified_at FROM wake_idle_notices WHERE timer_id = ? ORDER BY agent_id",
  ).all(watchId);
const backdateCursor = (watchId, agentId, offset) =>
  db.prepare("UPDATE wake_idle_notices SET notified_at = datetime('now', ?) WHERE timer_id = ? AND agent_id = ?").run(
    offset,
    watchId,
    agentId,
  );
`;

const SNAPSHOT = (panes) => `const snapshot = { panes: new Set(${JSON.stringify(panes)}), windows: new Set() };\n`;

const fixture = (name, body, panes = ["%1", "%2"]) => {
  const { dataDir, tmp } = scratchDirs();
  return runFixture(tmp, name, IMPORTS + SEED + SNAPSHOT(panes) + body, fixtureEnv(dataDir));
};

const out = (expr) => `process.stdout.write(JSON.stringify(${expr}));\n`;

const BACKDATE = "-45 minutes";

describe("wake_idle_notices.notified_at as the re-insert-vs-update discriminator", () => {
  it(
    "a rearm-driven delete and re-claim MOVES notified_at",
    NEEDS_TMUX,
    () => {
      const result = fixture(
        "rearm-moves-notified-at",
        `
        const w1 = addWorker('agent:1', 'w1', '%1', 'working', '-120 seconds');
        const watchId = addStandingWatch();

        // w1 finishes: claimEpisode inserts the cursor row and stampEpisodeNotice
        // links it to a fresh notice, both inside claimStandingBatch's one
        // transaction. The lead's pane is dead, so deliverable() HOLDS this
        // notice rather than typing or cancelling it - fired_at stays NULL.
        db.prepare("UPDATE agents SET agent_state = 'idle', state_changed_at = datetime('now') WHERE id = ?").run(w1);
        await tick(snapshot);
        const claimed = cursor(watchId)[0];
        const firstNotice = notices(watchId)[0];

        // Force the gap on the claim itself.
        backdateCursor(watchId, w1, ${JSON.stringify(BACKDATE)});
        const backdated = cursor(watchId)[0].notified_at;

        // Simulate todo 386's own incident by hand: the notice FIRED (a real
        // delivery attempt was made) but was never TYPED, and it fired long
        // enough ago that NOTICE_RETRY_AFTER (-60 seconds) has passed. That is
        // exactly rearmSpentEpisode's own condition, and it is the only real
        // path that ever reaches it (src/scheduler.ts's own comment: "fires
        // only for a claim whose notice was spent WITHOUT ever being typed").
        db.prepare("UPDATE timers SET fired_at = datetime('now', '-70 seconds'), typed_at = NULL WHERE id = ?").run(
          firstNotice.id,
        );

        // w1 is still idle with the SAME episode. standingIdleRows' own
        // unreported() read-gate now finds a spent, unreported claim and
        // re-derives w1 as a candidate: rearmSpentEpisode DELETEs the old row
        // and claimEpisode re-INSERTs it, fresh.
        await tick(snapshot);
        const after = cursor(watchId)[0];
        const afterNotices = notices(watchId);

        ${out(`{
          backdated,
          notifiedAt: after.notified_at,
          noticeTimerId: after.notice_timer_id,
          firstNoticeId: firstNotice.id,
          afterNoticeIds: afterNotices.map((n) => n.id),
        }`)}
        `,
      );
      assert.notEqual(
        result.notifiedAt,
        result.backdated,
        "a re-inserted claim must carry a FRESH notified_at, not the deleted row's old one",
      );
      assert.ok(
        result.afterNoticeIds.includes(result.firstNoticeId) && result.afterNoticeIds.length === 2,
        "the re-claim must file a SECOND notice - the first is still sitting there, spent and untyped",
      );
      assert.notEqual(
        result.noticeTimerId,
        result.firstNoticeId,
        "the re-inserted row must point at the NEW notice, not the one it was re-armed away from",
      );
    },
  );

  it(
    "coalescing a second worker's finish into a pending notice leaves an already-claimed episode's notified_at untouched",
    NEEDS_TMUX,
    () => {
      const result = fixture(
        "coalesce-leaves-notified-at-alone",
        `
        const w1 = addWorker('agent:1', 'w1', '%1', 'working', '-120 seconds');
        const w2 = addWorker('agent:2', 'w2', '%2', 'working', '-120 seconds');
        const watchId = addStandingWatch();

        // w1 finishes and is claimed. Its notice stays PENDING (fired_at NULL)
        // for the same dead-lead-pane reason as above.
        db.prepare("UPDATE agents SET agent_state = 'idle', state_changed_at = datetime('now') WHERE id = ?").run(w1);
        await tick(snapshot);
        const firstNotice = notices(watchId)[0];

        // Force the gap on w1's claim.
        backdateCursor(watchId, w1, ${JSON.stringify(BACKDATE)});
        const backdated = cursor(watchId)[0].notified_at;

        // w2 finishes LATER, while w1's notice is still pending: this is the
        // TODO 390 coalescing path (claimStandingBatch's pendingNoticeFor
        // branch). w2 is a fresh claim and gets its own stampEpisodeNotice
        // call, linking it to w1's SAME pending notice; w1's own cursor row is
        // only ever RENDERED (crewRowForRender), never re-claimed or re-stamped.
        db.prepare("UPDATE agents SET agent_state = 'idle', state_changed_at = datetime('now') WHERE id = ?").run(w2);
        await tick(snapshot);
        const merged = notices(watchId);
        const after = cursor(watchId);
        const w1Row = after.find((r) => r.agent_id === w1);
        const w2Row = after.find((r) => r.agent_id === w2);

        ${out(`{
          backdated,
          sameNotice: merged.length === 1 && merged[0].id === firstNotice.id,
          w1NotifiedAt: w1Row.notified_at,
          w1NoticeTimerId: w1Row.notice_timer_id,
          w2NoticeTimerId: w2Row.notice_timer_id,
        }`)}
        `,
      );
      assert.ok(
        result.sameNotice,
        "the fixture must really be coalescing w2 into w1's one pending notice, or this proves nothing",
      );
      assert.equal(
        result.w2NoticeTimerId,
        result.w1NoticeTimerId,
        "both episodes must point at the one coalesced notice",
      );
      assert.equal(
        result.w1NotifiedAt,
        result.backdated,
        "w1's own claim must stay at its backdated notified_at - coalescing w2 into the same notice must never " +
          "touch an episode this tick did not claim",
      );
    },
  );
});

process.on("exit", () => cleanup());
