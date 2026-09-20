import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";

import { DIST, isolateTmux, runFixture, scratchDirs } from "./helpers.mjs";

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
        agent_state, state_changed_at, session_id, transcript_path, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'agent', 'running', ?,
        datetime('now', ?), ?, ?, datetime('now', '-300 seconds')) RETURNING id\`,
  ).get(
    project, actor, name, pane,
    opts.command ?? 'claude',
    opts.cwd ?? '/tmp/wk',
    state, changedOffset,
    opts.sessionId ?? ('sid-' + name),
    opts.transcriptPath ?? '',
  ).id;

const addStandingWatch = (opts = {}) =>
  db.prepare(
    \`INSERT INTO wakes (project_id, owner, body, kind, watch_scope, deliver_actor, deliver_pane,
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

// Codex hands hive the exact rollout file through its own hook payload (agents.transcript_path),
// never a cwd-resolved directory - written anywhere, deliberately NOT under CLAUDE_CONFIG_DIR.
const writeCodexTranscript = (path, ageSeconds) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, '{"type":"response_item"}\\n');
  const when = (Date.now() - ageSeconds * 1000) / 1000;
  utimesSync(path, when, when);
};

const notices = (watchId) =>
  db.prepare(
    "SELECT id, body, fired_at, typed_at, cancelled_at, deliver_pane FROM wakes WHERE parent_wake_id = ? ORDER BY id",
  ).all(watchId);
const stallCursor = (watchId) =>
  db.prepare(
    "SELECT agent_id, condition, episode, notice_wake_id FROM wake_idle_notices WHERE wake_id = ? AND condition = 'stall' ORDER BY agent_id, episode",
  ).all(watchId);
const blockCursor = () =>
  db.prepare("SELECT agent_id, blocked_since FROM wake_block_notices ORDER BY agent_id").all();
const watchRow = (watchId) =>
  db.prepare("SELECT fired_at, fire_count, cancelled_at FROM wakes WHERE id = ?").get(watchId);
const agentRow = (id) =>
  db.prepare("SELECT status, agent_state, state_changed_at FROM agents WHERE id = ?").get(id);
`;

const SNAPSHOT = (panes) =>
  panes === null
    ? "const snapshot = null;\n"
    : `const snapshot = { panes: new Set(${JSON.stringify(panes)}), windows: new Set() };\n`;

const out = (expr) => `process.stdout.write(JSON.stringify(${expr}));\n`;

const fixture = (name, body, panes = ["%1", "%2"]) => {
  const { dataDir, tmp } = scratchDirs();
  const configDir = join(tmp, "claude-config");
  return runFixture(tmp, name, IMPORTS + SEED + SNAPSHOT(panes) + body, {
    HIVE_DATA_DIR: dataDir,
    CLAUDE_CONFIG_DIR: configDir,
    // This fixture's own scratch dir, for writeCodexTranscript - never a literal /tmp path, or two
    // concurrent runs of this file race on the same rollout file (todo 591).
    CODEX_HOME_ROOT: tmp,
    TMUX_TMPDIR: process.env.TMUX_TMPDIR,
  });
};

const STALE = 30 * 60;
const FRESH = 5;

describe("the stall detector reports a worker whose transcript has gone quiet", () => {

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
    assert.ok(result.cursor[0].notice_wake_id, "the claim records WHICH notice carried it");
  });

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
        "UPDATE wakes SET fired_at = datetime('now', '-120 seconds'), typed_at = NULL WHERE id = ?",
      ).run(first[0].id);

      await tick(snapshot);

      ${out(`{ first: first.length, notices: notices(watchId).length, cursor: stallCursor(watchId).length }`)}
      `,
    );

    assert.equal(result.first, 1);
    assert.equal(result.notices, 2, "the lost report is filed again rather than silently dropped");
    assert.equal(result.cursor, 1, "still one claim row - it was re-armed in place, not duplicated");
  });

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

      db.prepare("UPDATE wakes SET deliver_pane = '%lead' WHERE id = ?").run(watchId);
      await tick(snapshot);

      ${out(`{ dark, notices: notices(watchId).length, cursor: stallCursor(watchId).length, watch: watchRow(watchId) }`)}
      `,
    );

    assert.deepEqual(result.dark, { notices: 0, cursor: 0 }, "no target means no claim, not a burnt one");
    assert.deepEqual(result.watch, { fired_at: null, fire_count: 0, cancelled_at: null }, "watch state");
    assert.equal(result.notices, 1, "the report survives to the tick that has somewhere to put it");
    assert.equal(result.cursor, 1);
  });

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

describe("the stall detector corroborates a codex worker against its stored transcript_path", () => {
  it("reports a codex worker whose stored transcript file has gone quiet", () => {
    const result = fixture(
      "codex-stale",
      `
      const path = join(process.env.CODEX_HOME_ROOT, 'codex-home', 'sessions', 'rollout-stale.jsonl');
      addWorker('agent:1', 'codex-stale', '%1', 'working', '-3600 seconds', {
        command: 'codex', transcriptPath: path,
      });
      writeCodexTranscript(path, ${STALE});
      const watchId = addStandingWatch();
      await tick(snapshot);
      ${out(`{ notices: notices(watchId).map((n) => n.body), cursor: stallCursor(watchId).length }`)}
      `,
    );

    assert.equal(result.notices.length, 1);
    assert.match(result.notices[0], /codex-stale: has claimed `working`/);
    assert.equal(result.cursor, 1);
  });

  it("stays silent about a codex worker whose stored transcript file is fresh", () => {
    const result = fixture(
      "codex-fresh",
      `
      const path = join(process.env.CODEX_HOME_ROOT, 'codex-home', 'sessions', 'rollout-fresh.jsonl');
      addWorker('agent:1', 'codex-fresh', '%1', 'working', '-3600 seconds', {
        command: 'codex', transcriptPath: path,
      });
      writeCodexTranscript(path, ${FRESH});
      const watchId = addStandingWatch();
      await tick(snapshot);
      ${out(`{ notices: notices(watchId).length, cursor: stallCursor(watchId).length }`)}
      `,
    );

    assert.equal(result.notices, 0, "a live codex transcript is not a stall, exactly like claude's");
    assert.equal(result.cursor, 0);
  });

  it("skips a codex worker with no transcript_path recorded yet, same as before this lane", () => {
    const result = fixture(
      "codex-no-path",
      `
      addWorker('agent:1', 'codex-quiet', '%1', 'working', '-3600 seconds', { command: 'codex' });
      const watchId = addStandingWatch();
      await tick(snapshot);
      ${out(`{ notices: notices(watchId).length, cursor: stallCursor(watchId).length }`)}
      `,
    );

    assert.equal(result.notices, 0, "no hook payload has ever carried a path for this row to corroborate against");
    assert.equal(result.cursor, 0);
  });

  it("never reports a codex worker whose stored transcript_path file is gone -- a missing file is never a stall", () => {
    const result = fixture(
      "codex-reaped",
      `
      addWorker('agent:1', 'codex-reaped', '%1', 'working', '-3600 seconds', {
        command: 'codex',
        transcriptPath: join(process.env.CODEX_HOME_ROOT, 'codex-home', 'sessions', 'reaped-away.jsonl'),
      });
      const watchId = addStandingWatch();
      await tick(snapshot);
      ${out(`{ notices: notices(watchId).length, cursor: stallCursor(watchId).length }`)}
      `,
    );

    assert.equal(
      result.notices,
      0,
      "unlike claude's 'never wrote a transcript at all', a codex row's recorded path pointing " +
        "nowhere must not be read as evidence of a stall (agent_close reaps CODEX_HOME)",
    );
    assert.equal(result.cursor, 0);
  });
});

describe("two schedulers reporting one stall file one notice between them", () => {
  it("claims the episode exactly once across concurrent instances", () => {
    const { dataDir, tmp } = scratchDirs();
    const configDir = join(tmp, "claude-config");
    const env = {
      HIVE_DATA_DIR: dataDir,
      CLAUDE_CONFIG_DIR: configDir,
      TMUX_TMPDIR: process.env.TMUX_TMPDIR,
    };

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
