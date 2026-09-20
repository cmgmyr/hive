import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { DIST, REPO, isolateTmux, runFixture, scratchDirs } from "./helpers.mjs";

const { cleanup } = isolateTmux("the standing-notice background-task tests");

const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;

const FIXTURES = join(REPO, "test", "fixtures", "hook-payloads");
const payload = (name) => readFileSync(join(FIXTURES, name), "utf8");

const fixtureEnv = (dataDir) => ({ HIVE_DATA_DIR: dataDir, TMUX_TMPDIR: process.env.TMUX_TMPDIR });

const IMPORTS =
  `const { db, migrate } = await import(${JSON.stringify(join(DIST, "db.js"))});\n` +
  `const { tick, shortRenderForLeadDelivery } = await import(${JSON.stringify(join(DIST, "scheduler.js"))});\n` +
  "migrate();\n";

const SEED = `
const { writeFileSync } = await import('node:fs');
const { join } = await import('node:path');
const { recordClaudeWindowSize } = await import(${JSON.stringify(join(DIST, "statusline.js"))});
const seedContext = (id, actor) => {
  const path = join(process.env.HIVE_DATA_DIR, encodeURIComponent(actor) + '.jsonl');
  writeFileSync(path, JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 25000 } } }) + '\\n');
  recordClaudeWindowSize(actor, JSON.stringify({ context_window: { context_window_size: 100000 } }));
  db.prepare('UPDATE agents SET transcript_path = ? WHERE id = ?').run(path, id);
  return id;
};
const EPISODE = '-5 seconds';
const project = db.prepare("INSERT INTO projects (name, path) VALUES ('bt', '/tmp/bt') RETURNING id").get().id;
db.prepare(
  \`INSERT INTO agents (project_id, actor_id, name, tmux_target, command, cwd, kind, status, created_at)
    VALUES (?, 'lead:1', 'lead', '%lead', 'claude', '/tmp', 'lead', 'running', datetime('now', '-300 seconds'))\`,
).run(project);
const addWorker = (actor, name, pane, state, changedOffset) =>
  seedContext(db.prepare(
    \`INSERT INTO agents (project_id, actor_id, name, tmux_target, command, cwd, kind, status,
        agent_state, state_changed_at, created_at)
      VALUES (?, ?, ?, ?, 'claude', '/tmp', 'agent', 'running', ?,
        datetime('now', ?), datetime('now', '-300 seconds')) RETURNING id\`,
  ).get(project, actor, name, pane, state, changedOffset).id, actor);
const addDeadWorker = (actor, name, offset) =>
  seedContext(db.prepare(
    \`INSERT INTO agents (project_id, actor_id, name, tmux_target, command, cwd, kind, status,
        agent_state, state_changed_at, closed_at, created_at)
      VALUES (?, ?, ?, '%gone', 'claude', '/tmp', 'agent', 'closed', 'working',
        datetime('now', ?), datetime('now', ?), datetime('now', '-300 seconds')) RETURNING id\`,
  ).get(project, actor, name, offset, offset).id, actor);
const addStandingWatch = () =>
  db.prepare(
    \`INSERT INTO wakes (project_id, owner, body, kind, watch_scope, deliver_actor, deliver_pane,
        max_wait_at, created_at)
      VALUES (?, 'lead:1', 'crew update', 'idle_any', 'project', 'lead:1', '%lead',
        datetime('now', '+4 hours'), datetime('now', '-60 seconds')) RETURNING id\`,
  ).get(project).id;
// The real hook writes the log row milliseconds after the state write, inside the same episode, so a
// fixture's stop row has to land in the episode's own window or it is testing a different episode.
// EPISODE is that shared instant, and the tests that pass an explicit offset are the ones deliberately
// putting a row OUTSIDE the window.
const stopRow = (actor, body, offset = EPISODE) =>
  db.prepare(
    \`INSERT INTO agent_state_log (actor_id, event, state, payload, created_at)
      VALUES (?, 'stop', 'idle', ?, strftime('%Y-%m-%d %H:%M:%f', 'now', ?))\`,
  ).run(actor, body, offset);
const notifyRow = (actor, body) =>
  db.prepare(
    \`INSERT INTO agent_state_log (actor_id, event, state, payload, created_at)
      VALUES (?, 'notify', 'unchanged', ?, strftime('%Y-%m-%d %H:%M:%f', 'now'))\`,
  ).run(actor, body);
const noticeRow = (watchId) =>
  db.prepare("SELECT * FROM wakes WHERE parent_wake_id = ? ORDER BY id DESC LIMIT 1").get(watchId);
const shortAndFull = (watchId) => {
  const row = noticeRow(watchId);
  return row === undefined ? null : { full: row.body, short: shortRenderForLeadDelivery(row) };
};
const stateOf = (id) => db.prepare("SELECT agent_state FROM agents WHERE id = ?").get(id).agent_state;
`;

const SNAPSHOT = (panes) => `const snapshot = { panes: new Set(${JSON.stringify(panes)}), windows: new Set() };\n`;

const fixture = (name, body, panes = ["%1", "%2", "%3", "%4", "%5"]) => {
  const { dataDir, tmp } = scratchDirs();
  return runFixture(tmp, name, IMPORTS + SEED + SNAPSHOT(panes) + body, fixtureEnv(dataDir));
};

const out = (expr) => `process.stdout.write(JSON.stringify(${expr}));\n`;

const SHELL = payload("stop-shell-running.json");
const MONITORS = payload("stop-monitors-running.json");
const IDLE = payload("stop-idle.json");

after(() => cleanup());

describe("todo 468: a finish that left a background task running says so, in both renders", () => {
  it("names a live background shell a worker went idle against, and stays silent when there is none", () => {
    const result = fixture(
      "shell-named",
      `
      const busy = addWorker('agent:1', 'w1', '%1', 'idle', '-5 seconds');
      const clean = addWorker('agent:2', 'w2', '%2', 'idle', '-5 seconds');
      stopRow('agent:1', ${JSON.stringify(SHELL)});
      stopRow('agent:2', ${JSON.stringify(IDLE)});
      const watchId = addStandingWatch();
      await tick(snapshot);
      ${out("{ ...shortAndFull(watchId), busyState: stateOf(busy), cleanState: stateOf(clean) }")}
      `,
    );
    assert.equal(
      result.busyState,
      "idle",
      "the latch must still read idle - this lane fixes the reader, and a working row would make the " +
        "notice assertions below vacuous by never reporting the worker at all",
    );
    assert.equal(result.cleanState, "idle");
    assert.match(
      result.short,
      /^w1: idle, 1 background shell running - may not be done, context 25%\.$/m,
      "the SHORT render is the one a lead reads; six lead turns were spent on it saying only '1 finished'",
    );
    assert.match(
      result.short,
      /^w2: idle, context 25%\.$/m,
      "w2's Stop payload carried no live task, so its line carries no such clause - or the clause proves nothing",
    );
    assert.match(
      result.full,
      /w1: [^\n]+\. It went idle with 1 background shell still running \(shell: "Full suite run, granted slot/,
      "the full render names the task's own description, from the captured payload - and the sentence " +
        "before it ends, since stateNowClause returns no punctuation of its own and two sentences run " +
        "together in prose typed at someone mid-incident",
    );
    assert.match(result.full, /read its pane before you act on this line/);
  });

  it("counts a monitor exactly as it counts a shell", () => {
    const result = fixture(
      "monitor-named",
      `
      addWorker('agent:1', 'w1', '%1', 'idle', '-5 seconds');
      stopRow('agent:1', ${JSON.stringify(MONITORS)});
      const watchId = addStandingWatch();
      await tick(snapshot);
      ${out("shortAndFull(watchId)")}
      `,
    );
    assert.match(result.short, /^w1: idle, 3 background monitors running - may not be done, context 25%\.$/m);
    assert.match(
      result.full,
      /It went idle with 3 background monitors still running/,
      "three live monitors, from a real captured payload, counted and pluralised in the render that carries detail",
    );
    assert.match(result.full, /monitor: "live updates for artifact/);
  });

  it("names a task type this codebase has never seen, rather than dropping it", () => {
    const unseen = JSON.stringify({
      hook_event_name: "Stop",
      background_tasks: [{ id: "x1", type: "parachute", status: "running", description: "something new" }],
      session_crons: [],
    });
    const result = fixture(
      "unseen-type",
      `
      addWorker('agent:1', 'w1', '%1', 'idle', '-5 seconds');
      stopRow('agent:1', ${JSON.stringify(unseen)});
      const watchId = addStandingWatch();
      await tick(snapshot);
      ${out("shortAndFull(watchId)")}
      `,
    );
    assert.match(result.short, /^w1: idle, 1 background parachute running - may not be done, context 25%\.$/m);
    assert.match(
      result.full,
      /It went idle with 1 background parachute still running \(parachute: "something new"\)/,
      "an unknown type is named by the reader; only the LATCH keeps a closed set",
    );
  });

  it("mixes types by name rather than pretending they are one kind", () => {
    const mixed = JSON.stringify({
      hook_event_name: "Stop",
      background_tasks: [
        { id: "x1", type: "shell", status: "running", description: "tail -f" },
        { id: "x2", type: "monitor", status: "running", description: "watch" },
      ],
      session_crons: [],
    });
    const result = fixture(
      "mixed-types",
      `
      addWorker('agent:1', 'w1', '%1', 'idle', '-5 seconds');
      stopRow('agent:1', ${JSON.stringify(mixed)});
      const watchId = addStandingWatch();
      await tick(snapshot);
      ${out("shortAndFull(watchId)")}
      `,
    );
    assert.match(result.full, /It went idle with 2 background tasks \(monitor, shell\) still running/);
  });

  it("ignores a background task the payload marks terminal", () => {
    const done = JSON.stringify({
      hook_event_name: "Stop",
      background_tasks: [{ id: "x1", type: "shell", status: "completed", description: "already over" }],
      session_crons: [],
    });
    const result = fixture(
      "terminal-task",
      `
      addWorker('agent:1', 'w1', '%1', 'idle', '-5 seconds');
      stopRow('agent:1', ${JSON.stringify(done)});
      const watchId = addStandingWatch();
      await tick(snapshot);
      ${out("shortAndFull(watchId)")}
      `,
    );
    assert.match(result.short, /^w1: idle, context 25%\.$/m, "and it is still reported, with nothing hanging off it");
    assert.doesNotMatch(result.short, /background/);
  });
});

describe("todo 468/473: the crew render grows with the CREW, never with the episodes it coalesced", () => {
  const crew = (n) =>
    Array.from({ length: n }, (_, i) => `addWorker('agent:${i + 1}', 'w${i + 1}', '%${i + 1}', 'idle', '-5 seconds');`).join("\n      ");
  const stops = (n, body) =>
    Array.from({ length: n }, (_, i) => `stopRow('agent:${i + 1}', ${JSON.stringify(body)});`).join("\n      ");

  const render = (name, n, withTasks) =>
    fixture(
      name,
      `
      ${crew(n)}
      ${stops(withTasks, SHELL)}
      ${Array.from({ length: n - withTasks }, (_, i) => `stopRow('agent:${withTasks + i + 1}', ${JSON.stringify(IDLE)});`).join("\n      ")}
      const watchId = addStandingWatch();
      await tick(snapshot);
      ${out("shortAndFull(watchId)")}
      `,
    );

  const clauseCount = (text) => (text.match(/background shell running/g) ?? []).length;
  const workerLines = (text) => (text.match(/^w\d+: /gm) ?? []).length;

  it("gives each worker one line and puts the background fact on the line it belongs to", () => {
    const result = render("short-n2", 2, 2);
    assert.equal(workerLines(result.short), 2, "two workers, two lines");
    assert.equal(clauseCount(result.short), 2, "and each one's own live shell is stated on its own line");
  });

  it("marks only the affected workers when the crew grows to three", () => {
    const result = render("short-n3", 3, 2);
    assert.equal(workerLines(result.short), 3);
    assert.equal(clauseCount(result.short), 2);
    assert.match(result.short, /^w3: idle, context 25%\.$/m, "the third left nothing running, so its line says only that");
    assert.ok(
      result.short.length < 300,
      `three workers must not need more than a few lines; got ${result.short.length} chars: ${result.short}`,
    );
  });

  it("keeps the per-task detail in the FULL body, which is what the pointer is for", () => {
    const result = render("short-n2-full", 2, 2);
    assert.equal(
      (result.full.match(/It went idle with 1 background shell still running/g) ?? []).length,
      2,
      "the full render is per-worker on purpose: the short one says THAT, wake_get says WHICH",
    );
  });
});

describe("todo 468: what reaches the pane is safe to type there", () => {
  it("strips a control byte out of a task's TYPE, not only out of its description", () => {
    const nasty = JSON.stringify({
      hook_event_name: "Stop",
      background_tasks: [{ id: "x1", type: "sh\rell", status: "running", description: "clean\rdescription" }],
      session_crons: [],
    });
    const result = fixture(
      "control-byte-in-type",
      `
      addWorker('agent:1', 'w1', '%1', 'idle', '-5 seconds');
      stopRow('agent:1', ${JSON.stringify(nasty)});
      const watchId = addStandingWatch();
      await tick(snapshot);
      ${out("shortAndFull(watchId)")}
      `,
    );
    assert.doesNotMatch(
      result.full,
      /[\u0000-\u0008\u000b-\u001f\u007f]/,
      "a wake body is typed literally into a pane, so a carriage return in it submits the prompt early " +
        "and splits the wake in half - the type is as much of the string as the description is",
    );
    assert.match(result.full, /sh ell: "clean description"/, "and it is flattened rather than dropped");
  });
});

describe("todo 468/473: past the roster cap", () => {
  it("tells the reader that names are hidden, and counts the hidden ones over the whole crew", () => {
    const result = fixture(
      "past-the-cap",
      `
      for (let i = 1; i <= 9; i++) {
        addWorker('agent:' + i, 'w' + i, '%' + i, 'idle', '-5 seconds');
        stopRow('agent:' + i, ${JSON.stringify(SHELL)});
      }
      const watchId = addStandingWatch();
      await tick(snapshot);
      ${out("shortAndFull(watchId)")}
      `,
      ["%1", "%2", "%3", "%4", "%5", "%6", "%7", "%8", "%9"],
    );
    assert.equal(
      (result.short.match(/^w\d+: /gm) ?? []).length,
      8,
      "the fixture must really exceed the 8-name cap, or this proves nothing",
    );
    assert.match(
      result.short,
      /And 1 more not shown\./,
      "9 workers finished and 8 fit; a render that quietly showed 8 and said nothing about the ninth " +
        "would be the same dishonest-claim defect this whole round is about",
    );
  });
});

describe("todo 468: which log row the clause is read from", () => {
  it("keeps the clause when a notify row lands after the stop that latched the episode", () => {
    const result = fixture(
      "notify-after-stop",
      `
      addWorker('agent:1', 'w1', '%1', 'idle', '-5 seconds');
      stopRow('agent:1', ${JSON.stringify(SHELL)});
      notifyRow('agent:1', ${JSON.stringify(IDLE)});
      const watchId = addStandingWatch();
      await tick(snapshot);
      ${out("shortAndFull(watchId)")}
      `,
    );
    assert.match(
      result.full,
      /It went idle with 1 background shell still running/,
      "the notify branch writes rows nobody attributes to it (issue #38); the reader filters on event, " +
        "so a notify landing after the stop cannot blank the clause",
    );
  });

  it("says nothing when the newest stop row is older than the episode being reported", () => {
    const result = fixture(
      "stale-stop-row",
      `
      addWorker('agent:1', 'w1', '%1', 'idle', '-5 seconds');
      stopRow('agent:1', ${JSON.stringify(SHELL)}, '-60 seconds');
      const watchId = addStandingWatch();
      await tick(snapshot);
      ${out("shortAndFull(watchId)")}
      `,
    );
    assert.match(result.short, /^w1: idle, context 25%\.$/m, "the finish is still reported");
    assert.doesNotMatch(
      result.short,
      /background/,
      "a stop row from a previous episode is not evidence about this one - the same payload one " +
        "episode later DOES produce the clause, which is what makes this assertion mean something",
    );
  });

  it("reads the episode's own stop row, not a later one the worker has since written", () => {
    const result = fixture(
      "later-stop-row-wins-nothing",
      `
      addWorker('agent:1', 'w1', '%1', 'idle', '-5 seconds');
      addWorker('agent:2', 'w2', '%2', 'idle', '-5 seconds');
      stopRow('agent:1', ${JSON.stringify(SHELL)});
      stopRow('agent:2', ${JSON.stringify(IDLE)});
      const watchId = addStandingWatch();
      await tick(snapshot);
      // Both claims are made; now w2 takes another turn and stops again with a shell live. Reachable
      // because the short render is built at DELIVERY time and a lead-bound notice can be held for an
      // hour, so the worker moves on while the notice waits.
      stopRow('agent:2', ${JSON.stringify(SHELL)}, '+30 seconds');
      ${out("shortAndFull(watchId)")}
      `,
    );
    assert.match(
      result.short,
      /^w2: idle, context 25%\.$/m,
      "w2 finished clean and a LATER episode of its own is not evidence about the one being reported",
    );
    assert.match(
      result.short,
      /^w1: idle, 1 background shell running - may not be done, context 25%\.$/m,
      "w1 is the control that must keep its clause, so a query that stopped reporting anything at all " +
        "cannot pass this",
    );
  });

  it("does not blank the clause when the worker's next stop left nothing running", () => {
    const result = fixture(
      "later-clean-stop-does-not-blank",
      `
      addWorker('agent:1', 'w1', '%1', 'idle', '-5 seconds');
      stopRow('agent:1', ${JSON.stringify(SHELL)});
      const watchId = addStandingWatch();
      await tick(snapshot);
      stopRow('agent:1', ${JSON.stringify(IDLE)}, '+30 seconds');
      ${out("shortAndFull(watchId)")}
      `,
    );
    assert.match(
      result.short,
      /^w1: idle, 1 background shell running - may not be done, context 25%\.$/m,
      "this is the harmful direction: a later clean stop must not turn the reported episode into a clean " +
        "finish, which is the false negative this whole todo exists to prevent",
    );
    assert.match(result.full, /It went idle with 1 background shell still running/);
  });

  it("says nothing about a GONE worker's background tasks", () => {
    const result = fixture(
      "gone-worker",
      `
      addDeadWorker('agent:1', 'w1', '-5 seconds');
      stopRow('agent:1', ${JSON.stringify(SHELL)});
      const watchId = addStandingWatch();
      await tick(snapshot);
      ${out("shortAndFull(watchId)")}
      `,
    );
    assert.match(result.full, /w1: GONE/, "the fixture must really be reporting a GONE row");
    assert.doesNotMatch(
      result.full,
      /It went idle with/,
      "its pane is gone, so what it was waiting on is not something a lead can act on",
    );
  });

  it("stays quiet, rather than throwing, on a Stop payload the log truncated mid-JSON", () => {
    const truncated = SHELL.slice(0, 400);
    const result = fixture(
      "truncated-payload",
      `
      addWorker('agent:1', 'w1', '%1', 'idle', '-5 seconds');
      stopRow('agent:1', ${JSON.stringify(truncated)});
      const watchId = addStandingWatch();
      await tick(snapshot);
      ${out("shortAndFull(watchId)")}
      `,
    );
    assert.match(result.short, /^w1: idle, context 25%\.$/m, "the notice must still be written");
    assert.doesNotMatch(result.short, /background/);
  });
});
