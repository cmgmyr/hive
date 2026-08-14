import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";

import { DIST, isolateTmux, runFixture, scratchDirs } from "./helpers.mjs";

// TODO 391, THE STALL DETECTOR. A worker whose turn dies mid-response has
// fired `prompt` and will never fire `stop`, so its row reads `working` (or
// `waiting`) forever and nothing pushes that to the lead. This file pins the
// store-and-clock half: the sampler, the claim, and every way the report is
// supposed to stay quiet.
//
// EVERY ASSERTION IS OVER A RECORD OF WHAT HAPPENED - `timers` rows and
// `wake_idle_notices` rows - never over a sample of `agents.agent_state`
// (test/CLAUDE.md, .claude/rules/worker-state.md). The notice IS a timers row,
// so COUNTING those rows across ticks is what makes the cursor testable: a
// detector with no cursor files one every three seconds forever, and one with
// a broken cursor files none at all, and only a count across ticks tells those
// apart.
//
// THE METHOD IS test/standing-watch.test.mjs's: drive tick() directly in a
// child process with a SYNTHETIC AliveSnapshot literal. Arm 1 touches no tmux
// at all by design, which is exactly why it can be tested this way and exactly
// why it still answers on a machine whose tmux probe is failing.
//
// THE TRANSCRIPT IS A REAL FILE WITH A REAL mtime, under a scratch
// CLAUDE_CONFIG_DIR. It has to be: the whole discriminating claim of this
// feature is that the transcript's mtime and the latch's age are DIFFERENT
// facts, and a fixture that fakes the sampler cannot fail in the direction
// that matters.
//
// ARM 2's two pane-dependent rows (a real screen with no dialog, and a real
// screen with one) live in test/stall-report-panes.test.mjs, which needs real
// tmux. What IS here is arm 2's third case - an unanswered probe - because
// "no fact" is reachable without a pane at all.
const { hasTmux } = isolateTmux("the stall report tests");
void hasTmux;

const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;

const IMPORTS =
  `import { mkdirSync, utimesSync, writeFileSync } from "node:fs";\n` +
  `import { join } from "node:path";\n` +
  `const { db, migrate } = await import(${JSON.stringify(join(DIST, "db.js"))});\n` +
  `const { tick } = await import(${JSON.stringify(join(DIST, "scheduler.js"))});\n` +
  "migrate();\n";

// One project, one lead that owns the watch, and helpers to add crew. Rows are
// older than SETTLE_WINDOW so the janitor judges them rather than giving them
// spawn grace.
//
// THE LEAD'S PANE IS DELIBERATELY ABSENT FROM EVERY SNAPSHOT. A filed notice
// is a real due-now timer, so the NEXT tick tries to deliver it, and delivery
// is a tmux fork. A lead-owned wake whose pane is not live is HELD rather than
// cancelled or typed (deliverable()'s lead exemption), so these fixtures reach
// the code under test and stop short of typing at a terminal - the same
// arrangement test/standing-watch.test.mjs uses and for the same reason.
const SEED = `
const project = db.prepare("INSERT INTO projects (name, path) VALUES ('st', '/tmp/st') RETURNING id").get().id;
db.prepare(
  \`INSERT INTO agents (project_id, actor_id, name, tmux_target, command, cwd, kind, status, created_at)
    VALUES (?, 'lead:1', 'lead', '%lead', 'claude', '/tmp', 'lead', 'running', datetime('now', '-300 seconds'))\`,
).run(project);

// changedOffset is the EPISODE KEY: agents.state_changed_at, the moment this
// row's current latch was written.
const addWorker = (actor, name, pane, state, changedOffset, opts = {}) =>
  db.prepare(
    \`INSERT INTO agents (project_id, actor_id, name, tmux_target, command, cwd, kind, status,
        agent_state, state_changed_at, session_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'agent', 'running', ?,
        datetime('now', ?), ?, datetime('now', '-300 seconds')) RETURNING id\`,
  ).get(
    project, actor, name, pane,
    opts.command ?? 'claude',
    opts.cwd ?? '/tmp/wk',
    state, changedOffset,
    opts.sessionId ?? ('sid-' + name),
  ).id;

const addStandingWatch = (opts = {}) =>
  db.prepare(
    \`INSERT INTO timers (project_id, owner, body, kind, watch_scope, deliver_actor, deliver_pane,
        max_wait_at, created_at)
      VALUES (?, ?, ?, 'idle_any', 'project', ?, ?,
        datetime('now', ?), datetime('now', '-60 seconds')) RETURNING id\`,
  ).get(
    project,
    opts.owner ?? 'lead:1',
    opts.body ?? 'crew update',
    opts.deliverActor ?? 'lead:1',
    opts.deliverPane ?? '%lead',
    opts.maxWait ?? '+4 hours',
  ).id;

// The transcript Claude Code would have written, at a chosen age. hive
// resolves it as <transcriptDir(agents.cwd)>/<agents.session_id>.jsonl, and
// transcriptDir replaces every / and . in the cwd with a dash.
const writeTranscript = (cwd, sessionId, ageSeconds) => {
  const dir = join(process.env.CLAUDE_CONFIG_DIR, "projects", cwd.replace(/[/.]/g, "-"));
  mkdirSync(dir, { recursive: true });
  const path = join(dir, sessionId + ".jsonl");
  writeFileSync(path, '{"type":"assistant"}\\n');
  const when = (Date.now() - ageSeconds * 1000) / 1000;
  utimesSync(path, when, when);
};

const notices = (watchId) =>
  db.prepare(
    "SELECT id, body, fired_at, typed_at, cancelled_at, deliver_pane FROM timers WHERE parent_timer_id = ? ORDER BY id",
  ).all(watchId);
const stallCursor = (watchId) =>
  db.prepare(
    "SELECT agent_id, condition, episode, notice_timer_id FROM wake_idle_notices WHERE timer_id = ? AND condition = 'stall' ORDER BY agent_id, episode",
  ).all(watchId);
const blockCursor = () =>
  db.prepare("SELECT agent_id, blocked_since FROM wake_block_notices ORDER BY agent_id").all();
const watchRow = (watchId) =>
  db.prepare("SELECT fired_at, fire_count, cancelled_at FROM timers WHERE id = ?").get(watchId);
const agentRow = (id) =>
  db.prepare("SELECT status, agent_state, state_changed_at FROM agents WHERE id = ?").get(id);
`;

const SNAPSHOT = (panes) =>
  panes === null
    ? "const snapshot = null;\n"
    : `const snapshot = { panes: new Set(${JSON.stringify(panes)}), windows: new Set() };\n`;

const out = (expr) => `process.stdout.write(JSON.stringify(${expr}));\n`;

// A fresh store AND a fresh CLAUDE_CONFIG_DIR per fixture, so one scenario's
// transcript files can never satisfy another's sampler.
const fixture = (name, body, panes = ["%1", "%2"]) => {
  const { dataDir, tmp } = scratchDirs();
  const configDir = join(tmp, "claude-config");
  return runFixture(tmp, name, IMPORTS + SEED + SNAPSHOT(panes) + body, {
    HIVE_DATA_DIR: dataDir,
    CLAUDE_CONFIG_DIR: configDir,
    TMUX_TMPDIR: process.env.TMUX_TMPDIR,
  });
};

// Fifteen minutes is the bound; these sit either side of it with room to spare.
const STALE = 30 * 60;
const FRESH = 5;

describe("the stall detector reports a worker whose transcript has gone quiet", () => {
  // THE DISCRIMINATING TEST, and the reason this feature is not just "the
  // latch is old". Both fixtures are IDENTICAL in `agents` and in
  // agent_state_log - both `working`, both with the same ancient
  // state_changed_at - and differ ONLY in the transcript file's mtime.
  //
  // F1 is what makes this the headline: measured against the live store, of
  // four workers with an ancient `working` latch checked against their own
  // transcripts, THREE WERE ALIVE AND WRITING. A detector keyed on latch age
  // fires four times and is wrong three times.
  it("reports the stale worker and stays silent about the fresh one, on identical latches", () => {
    const result = fixture(
      "discriminating",
      `
      const stale = addWorker('agent:1', 'stale', '%1', 'working', '-3600 seconds');
      const busy = addWorker('agent:2', 'busy', '%2', 'working', '-3600 seconds');
      writeTranscript('/tmp/wk', 'sid-stale', ${STALE});
      writeTranscript('/tmp/wk', 'sid-busy', ${FRESH});
      const watchId = addStandingWatch();

      await tick(snapshot);

      ${out(`{
        notices: notices(watchId).map((n) => n.body),
        cursor: stallCursor(watchId),
        staleId: stale,
        busyId: busy,
      }`)}
      `,
    );

    assert.equal(result.notices.length, 1, "one notice, naming only the worker whose transcript went quiet");
    assert.match(result.notices[0], /stale: has claimed `working`/);
    assert.doesNotMatch(
      result.notices[0],
      /^ {2}busy:/m,
      "the fresh-transcript worker has an equally old latch and must NOT be reported",
    );
    assert.equal(result.cursor.length, 1, "and only one episode was claimed");
    assert.equal(result.cursor[0].agent_id, result.staleId);
    assert.equal(result.cursor[0].condition, "stall");
    assert.ok(result.cursor[0].notice_timer_id, "the claim records WHICH notice carried it");
  });

  // A MISSING FILE IS NOT A SKIP: it means the turn died before its first
  // transcript write, i.e. an API error at turn start, which is one of the two
  // failures this feature was filed for. It reports with its own sentence,
  // because a body that mis-describes its own evidence is a small lie in a
  // lead's session.
  it("reports a worker that never wrote a transcript at all, with its own sentence", () => {
    const result = fixture(
      "missing-transcript",
      `
      addWorker('agent:1', 'neverwrote', '%1', 'working', '-3600 seconds');
      const watchId = addStandingWatch();
      await tick(snapshot);
      ${out(`{ notices: notices(watchId).map((n) => n.body), cursor: stallCursor(watchId).length }`)}
      `,
    );

    assert.equal(result.notices.length, 1);
    assert.match(result.notices[0], /neverwrote: has claimed `working` for .* and has never written a transcript/);
    assert.doesNotMatch(
      result.notices[0],
      /transcript has not been written for/,
      "it must not claim a staleness it never measured",
    );
    assert.equal(result.cursor, 1);
  });

  // THE SKIP LIST IS EXACTLY TWO. A bash worker fires no hooks and writes no
  // transcript, so it must never be judged here - it would otherwise be named
  // on every tick for the life of the row, with a remedy that cannot work.
  // A row with no session_id has no transcript path to resolve at all.
  it("skips a non-claude worker and a worker with no session id, and nothing else", () => {
    const result = fixture(
      "skip-list",
      `
      addWorker('agent:1', 'shell', '%1', 'working', '-3600 seconds', { command: 'bash' });
      addWorker('agent:2', 'nosid', '%2', 'working', '-3600 seconds', { sessionId: '' });
      // Both would otherwise qualify: the bash worker even has a stale
      // transcript sitting at the path hive would resolve for it.
      writeTranscript('/tmp/wk', 'sid-shell', ${STALE});
      const watchId = addStandingWatch();
      await tick(snapshot);
      ${out(`{ notices: notices(watchId).map((n) => n.body), cursor: stallCursor(watchId).length }`)}
      `,
    );

    assert.deepEqual(result.notices, [], "neither row has a state channel this report can speak about");
    assert.equal(result.cursor, 0, "and neither episode was claimed");
  });

  // ONE REPORT PER TURN. A worker nobody rescues is reported once, which is
  // correct: nothing about the condition has changed. Only a count ACROSS
  // TICKS can tell a working cursor from a missing one.
  it("tells the owner once per episode, however many ticks the condition survives", () => {
    const result = fixture(
      "once-per-episode",
      `
      addWorker('agent:1', 'stuck', '%1', 'working', '-3600 seconds');
      writeTranscript('/tmp/wk', 'sid-stuck', ${STALE});
      const watchId = addStandingWatch();

      for (let i = 0; i < 5; i++) await tick(snapshot);

      ${out(`{ notices: notices(watchId).length, cursor: stallCursor(watchId).length }`)}
      `,
    );

    assert.equal(result.notices, 1, "five ticks of one unchanged condition is one report");
    assert.equal(result.cursor, 1);
  });

  // THE RE-ARM. A rescue is a real UserPromptSubmit, which stamps a new
  // state_changed_at, so a stall in the NEXT turn is a new episode and speaks
  // again. Without this the key would be permanent and a worker rescued and
  // re-stalled would go unreported forever.
  it("speaks again for a NEW episode after a rescue moves the latch", () => {
    const result = fixture(
      "re-arm",
      `
      const id = addWorker('agent:1', 'stuck', '%1', 'working', '-7200 seconds');
      writeTranscript('/tmp/wk', 'sid-stuck', ${STALE});
      const watchId = addStandingWatch();
      await tick(snapshot);
      const first = notices(watchId).length;

      // The rescue: a real prompt stamps a fresh latch. This one is still
      // older than the bound, so the SECOND stall is reportable immediately -
      // what makes it a different report is the episode, not the clock.
      db.prepare("UPDATE agents SET state_changed_at = datetime('now', '-3600 seconds') WHERE id = ?").run(id);
      await tick(snapshot);

      ${out(`{ first, cursor: stallCursor(watchId), notices: notices(watchId).length }`)}
      `,
    );

    assert.equal(result.first, 1);
    assert.equal(result.notices, 2, "a second episode is a second report");
    assert.equal(result.cursor.length, 2, "two claim rows");
    assert.notEqual(result.cursor[0].episode, result.cursor[1].episode, "keyed on the latch's own moment");
  });

  // THE DELIVERY-FAILURE RE-ARM, and it matters more here than anywhere else
  // this pattern ships: this key re-arms only on a NEW TURN, and a stalled
  // worker has no new turn until someone rescues it - so a stall notice lost
  // to a throwing sendText, or to a pane that dies before its first delivery,
  // is lost FOREVER for that worker without this.
  it("files the episode again when its notice was spent without ever being typed", () => {
    const result = fixture(
      "delivery-failure",
      `
      addWorker('agent:1', 'stuck', '%1', 'working', '-3600 seconds');
      writeTranscript('/tmp/wk', 'sid-stuck', ${STALE});
      const watchId = addStandingWatch();
      await tick(snapshot);
      const first = notices(watchId);

      // Spent, never typed, and older than NOTICE_RETRY_AFTER: the exact
      // shape of a notice whose sendText threw.
      db.prepare(
        "UPDATE timers SET fired_at = datetime('now', '-120 seconds'), typed_at = NULL WHERE id = ?",
      ).run(first[0].id);

      await tick(snapshot);

      ${out(`{ first: first.length, notices: notices(watchId).length, cursor: stallCursor(watchId).length }`)}
      `,
    );

    assert.equal(result.first, 1);
    assert.equal(result.notices, 2, "the lost report is filed again rather than silently dropped");
    assert.equal(result.cursor, 1, "still one claim row - it was re-armed in place, not duplicated");
  });

  // NOBODY TO TELL. The claim is spent either way, so filing at a pane nobody
  // reads consumes the one report this episode was ever going to get - and
  // because the key re-arms only on a new turn, that is PERMANENT rather than
  // late. Resolving the target must therefore come BEFORE the claim.
  it("claims nothing when there is nobody to tell, and still reports once a target is live", () => {
    const result = fixture(
      "nobody-to-tell",
      `
      addWorker('agent:1', 'stuck', '%1', 'working', '-3600 seconds');
      writeTranscript('/tmp/wk', 'sid-stuck', ${STALE});
      // The lead owns it (so the janitor's own dead-pane cancel exempts the
      // row and this fixture is testing the stall path rather than the
      // sweep), its pane is NOT in the snapshot, and there is no delivery
      // pane to fall back to: blockNoticeTarget has nothing to return.
      const watchId = addStandingWatch({ deliverPane: '' });
      await tick(snapshot);
      const dark = { notices: notices(watchId).length, cursor: stallCursor(watchId).length };

      db.prepare("UPDATE timers SET deliver_pane = '%lead' WHERE id = ?").run(watchId);
      await tick(snapshot);

      ${out(`{ dark, notices: notices(watchId).length, cursor: stallCursor(watchId).length, watch: watchRow(watchId) }`)}
      `,
    );

    assert.deepEqual(result.dark, { notices: 0, cursor: 0 }, "no target means no claim, not a burnt one");
    assert.deepEqual(result.watch, { fired_at: null, fire_count: 0, cancelled_at: null }, "watch state");
    assert.equal(result.notices, 1, "the report survives to the tick that has somewhere to put it");
    assert.equal(result.cursor, 1);
  });

  // ARM 1 NEEDS NOTHING TMUX CAN REFUSE, and that is why the call is not
  // gated on a non-null snapshot the way the block half is. Under a
  // persistently null snapshot - a foreign socket, an untrusted server/store
  // pair, a tmux answering null on a timeout - arm 1 must still answer, on
  // standingGoneRows' explicit precedent. Arm 2 must NOT: it reads a pane.
  it("still answers for a `working` worker with no tmux at all, and stays quiet for `waiting`", () => {
    const result = fixture(
      "no-tmux",
      `
      addWorker('agent:1', 'wworking', '%1', 'working', '-3600 seconds');
      addWorker('agent:2', 'wwaiting', '%2', 'waiting', '-3600 seconds');
      writeTranscript('/tmp/wk', 'sid-wworking', ${STALE});
      writeTranscript('/tmp/wk', 'sid-wwaiting', ${STALE});
      const watchId = addStandingWatch();
      await tick(snapshot);
      ${out(`{ notices: notices(watchId).map((n) => n.body), cursor: stallCursor(watchId).length }`)}
      `,
      null,
    );

    assert.equal(result.notices.length, 1, "arm 1 answers with no snapshot at all");
    assert.match(result.notices[0], /wworking: has claimed `working`/);
    assert.doesNotMatch(
      result.notices[0],
      /wwaiting/,
      "arm 2 reads a pane, so with no snapshot it has no fact and must say nothing",
    );
    assert.equal(result.cursor, 1);
  });

  // ARM 2 DOES NOT FIRE ON AN UNANSWERED PROBE. The row's pane is LIVE in the
  // snapshot, so rowAlive says true and the probe is actually reached - and
  // the probe cannot answer, because no such pane exists on any tmux server
  // this fixture can reach. `null` is "no fact", never "no dialog": being
  // wrong here means telling a lead that a worker sitting on a live dialog has
  // a dead turn.
  it("says nothing about a `waiting` worker whose pane could not be read", () => {
    const result = fixture(
      "null-probe",
      `
      addWorker('agent:1', 'unreadable', '%1', 'waiting', '-3600 seconds');
      writeTranscript('/tmp/wk', 'sid-unreadable', ${STALE});
      const watchId = addStandingWatch();
      await tick(snapshot);
      ${out(`{ notices: notices(watchId).length, cursor: stallCursor(watchId).length, block: blockCursor().length }`)}
      `,
    );

    assert.equal(result.notices, 0, "an unanswered probe is not evidence that no dialog is up");
    assert.equal(result.cursor, 0, "and the episode must stay unclaimed so a later tick can still report it");
    assert.equal(result.block, 0, "the block half's own key is untouched");
  });

  // REPORT, NEVER A GATE. A wrong bound must cost a paragraph in a terminal
  // and never a live worker: nothing is fired, held, cancelled or closed.
  it("changes nothing about the watch, the worker, or any other wake", () => {
    const result = fixture(
      "report-not-gate",
      `
      const id = addWorker('agent:1', 'stuck', '%1', 'working', '-3600 seconds');
      writeTranscript('/tmp/wk', 'sid-stuck', ${STALE});
      const watchId = addStandingWatch();
      const before = agentRow(id);
      await tick(snapshot);
      ${out(`{
        notices: notices(watchId).length,
        watch: watchRow(watchId),
        before,
        after: agentRow(id),
      }`)}
      `,
    );

    assert.equal(result.notices, 1, "the report happened, so the assertions below are about a live path");
    assert.equal(result.watch.fired_at, null, "the watch must never fire on a stall");
    assert.equal(result.watch.cancelled_at, null, "and must never be cancelled by one");
    assert.equal(result.watch.fire_count, 0);
    assert.equal(result.after.status, "running", "the worker's row is not closed");
    assert.deepEqual(result.after, result.before, "and nothing about its state was rewritten");
  });
});

// TWO REAL PROCESSES AGAINST ONE STORE. Every session runs its own scheduler,
// so an in-process guard is not a guard at all - and a same-process fixture
// passes even against one, which is why this spawns children.
//
// SAY EXACTLY WHAT THIS PROVES, BECAUSE IT IS LESS THAN ITS NAME SUGGESTS.
// The end-to-end property is real and worth pinning: two independent
// schedulers, one store, one stalled worker, ONE notice. What it does NOT
// isolate is the atomic claim, and that was MEASURED rather than assumed.
// `unreported()` is a cheap read-gate OUTSIDE the transaction, and it answers
// first: with claimEpisode mutated to always win (and still writing its row),
// this test stays GREEN, both with the children merely started together and
// with the wall-clock barrier below. The claim is a BACKSTOP behind the gate,
// reachable only in the microseconds between one instance's gate read and
// another's commit, and nothing available from outside the process forces that
// window open. The mutation this test's sibling rows DO die against is
// dropping the cursor gate itself.
//
// The barrier stays because it is strictly closer to the real hazard - both
// children are inside one tick of each other rather than merely "around the
// same time" - not because it was shown to be sufficient. Todo 391's spec
// (section 8) predicted `INSERT OR IGNORE -> INSERT OR REPLACE` would go red
// here and at "told once per episode"; it does not, for this same reason, and
// that measurement is recorded on the todo rather than written up as a pass.
describe("two schedulers reporting one stall file one notice between them", () => {
  it("claims the episode exactly once across concurrent instances", () => {
    const { dataDir, tmp } = scratchDirs();
    const configDir = join(tmp, "claude-config");
    const env = {
      HIVE_DATA_DIR: dataDir,
      CLAUDE_CONFIG_DIR: configDir,
      TMUX_TMPDIR: process.env.TMUX_TMPDIR,
    };

    // The runner sets up the store, then starts two independent node processes
    // that tick against it at the same instant.
    const TICKER =
      IMPORTS +
      "const snapshot = { panes: new Set(['%1', '%2']), windows: new Set() };\n" +
      "const startAt = Number(process.env.STALL_BARRIER_AT);\n" +
      "while (Date.now() < startAt) {}\n" +
      "for (let i = 0; i < 3; i++) await tick(snapshot);\n";

    const result = runFixture(
      tmp,
      "concurrent-runner",
      IMPORTS +
        SEED +
        `
      import { spawn } from "node:child_process";
      import { writeFileSync as write } from "node:fs";

      addWorker('agent:1', 'stuck', '%1', 'working', '-3600 seconds');
      writeTranscript('/tmp/wk', 'sid-stuck', ${STALE});
      const watchId = addStandingWatch();

      const tickerPath = join(${JSON.stringify(tmp)}, "concurrent-ticker.mjs");
      write(tickerPath, ${JSON.stringify(TICKER)});
      // Generous enough that both children are past their imports and their
      // own store open before either starts ticking, on a machine under load.
      const barrier = String(Date.now() + 4000);
      const run = () =>
        new Promise((resolve, reject) => {
          const child = spawn(process.execPath, [tickerPath], {
            stdio: "inherit",
            env: { ...process.env, STALL_BARRIER_AT: barrier },
          });
          child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error("ticker exited " + code))));
        });
      await Promise.all([run(), run()]);

      ${out(`{ notices: notices(watchId).length, cursor: stallCursor(watchId).length }`)}
      `,
      env,
    );

    assert.equal(result.cursor, 1, "the episode is claimed exactly once across both instances");
    assert.equal(result.notices, 1, "so exactly one notice was filed about it");
  });
});
