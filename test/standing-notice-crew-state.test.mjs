import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { DIST, REPO, isolateTmux, runFixture, scratchDirs } from "./helpers.mjs";

const { cleanup } = isolateTmux("the standing-notice crew-state tests");

const fixtureEnv = (dataDir) => ({ HIVE_DATA_DIR: dataDir, TMUX_TMPDIR: process.env.TMUX_TMPDIR });

const IMPORTS =
  `const { db, migrate } = await import(${JSON.stringify(join(DIST, "db.js"))});\n` +
  `const { tick } = await import(${JSON.stringify(join(DIST, "scheduler.js"))});\n` +
  "migrate();\n";

// Every worker here gets a pane of its own and the watch delivers somewhere else, because
// noteStandingTransitions skips a worker sitting on the delivery pane and skips one whose pane is not
// in the snapshot. The watch starts pointed at a dead pane so its notice is HELD, which is the only
// window in which a second episode can coalesce onto the same notice - the whole subject here.
const SEED = `
const project = db.prepare("INSERT INTO projects (name, path) VALUES ('cs', '/tmp/cs') RETURNING id").get().id;
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
const setState = (actor, state, offset) => {
  db.prepare("UPDATE agents SET agent_state = ?, state_changed_at = datetime('now', ?) WHERE actor_id = ?")
    .run(state, offset, actor);
  db.prepare(
    \`INSERT INTO agent_state_log (actor_id, event, state, payload, created_at)
      VALUES (?, ?, ?, '{}', strftime('%Y-%m-%d %H:%M:%f', 'now', ?))\`,
  ).run(actor, state === 'idle' ? 'stop' : 'prompt', state, offset);
};
const stopWith = (actor, body, offset) =>
  db.prepare(
    \`INSERT INTO agent_state_log (actor_id, event, state, payload, created_at)
      VALUES (?, 'stop', 'idle', ?, strftime('%Y-%m-%d %H:%M:%f', 'now', ?))\`,
  ).run(actor, body, offset);
const addStandingWatch = () =>
  db.prepare(
    \`INSERT INTO timers (project_id, owner, body, kind, watch_scope, deliver_actor, deliver_pane,
        max_wait_at, created_at)
      VALUES (?, 'lead:1', 'crew update', 'idle_any', 'project', 'lead:1', '%doesnotexist',
        datetime('now', '+4 hours'), datetime('now', '-60 seconds')) RETURNING id\`,
  ).get(project).id;
const noticeRow = (watchId) =>
  db.prepare("SELECT * FROM timers WHERE parent_timer_id = ? ORDER BY id DESC LIMIT 1").get(watchId);
const claimCount = (noticeId) =>
  db.prepare("SELECT COUNT(*) AS n, COUNT(DISTINCT agent_id) AS a FROM wake_idle_notices WHERE notice_timer_id = ?")
    .get(noticeId);
const pointAt = (noticeId, pane) =>
  db.prepare("UPDATE timers SET deliver_pane = ?, held_at = NULL, held_reason = NULL WHERE id = ?")
    .run(pane, noticeId);
const resumeWorker = (actor) =>
  db.prepare(
    "UPDATE agents SET agent_state = 'unknown', state_changed_at = NULL, resumed_at = datetime('now') WHERE actor_id = ?",
  ).run(actor);
const shareOneNotifiedSecond = (noticeId) =>
  db.prepare(
    "UPDATE wake_idle_notices SET notified_at = datetime('now', '-30 seconds') WHERE notice_timer_id = ?",
  ).run(noticeId);
const backdate = (noticeId, offset, alsoCreatedAt) => {
  db.prepare("UPDATE wake_idle_notices SET notified_at = datetime('now', ?) WHERE notice_timer_id = ?")
    .run(offset, noticeId);
  if (alsoCreatedAt) {
    db.prepare("UPDATE timers SET created_at = datetime('now', ?) WHERE id = ?").run(offset, noticeId);
  }
};
`;

const SNAPSHOT = (panes) => `const snapshot = { panes: new Set(${JSON.stringify(panes)}), windows: new Set() };\n`;

const out = (expr) => `process.stdout.write(JSON.stringify(${expr}));\n`;

let paneSeq = 0;

// The delivered string is the only thing this file may assert on: every one of the three defects is a
// render that reads wrong while every number in it is right, and all three were invisible to the
// lanes that measured the stored body instead. So each fixture ends by typing into a REAL pane whose
// shell is `cat`, and the assertions read the file that shell wrote.
function deliverToPane(name, body, extraPanes = []) {
  const { dataDir, tmp } = scratchDirs();
  const session = `hive-crew-state-${process.pid}-${paneSeq++}`;
  const captureFile = join(tmp, "capture.txt");
  execFileSync("tmux", ["new-session", "-d", "-s", session, "bash", "-c", `cat > ${captureFile}`], {
    stdio: "ignore",
  });
  const pane = execFileSync("tmux", ["list-panes", "-t", `=${session}`, "-F", "#{pane_id}"], {
    encoding: "utf8",
  }).trim();
  try {
    const result = runFixture(
      tmp,
      name,
      IMPORTS + SEED + SNAPSHOT([...extraPanes, pane]) + `const deliveryPane = ${JSON.stringify(pane)};\n` + body,
      fixtureEnv(dataDir),
    );
    const text = existsSync(captureFile) ? readFileSync(captureFile, "utf8") : "";
    return { ...result, text };
  } finally {
    cleanup(session);
  }
}

after(() => cleanup());

describe("todo 473: the standing notice reports crew state, not episodes", () => {
  it("names a worker that finished three turns while the notice was held exactly once", () => {
    const result = deliverToPane(
      "repeat-finisher",
      `
      addWorker('agent:1', 'w1', '%1', 'idle', '-50 seconds');
      addWorker('agent:2', 'w2', '%2', 'working', '-50 seconds');
      addWorker('agent:3', 'w3', '%3', 'working', '-50 seconds');
      const watchId = addStandingWatch();

      await tick(snapshot);
      setState('agent:1', 'working', '-40 seconds');
      setState('agent:1', 'idle', '-35 seconds');
      await tick(snapshot);
      setState('agent:1', 'working', '-30 seconds');
      setState('agent:1', 'idle', '-25 seconds');
      setState('agent:2', 'idle', '-25 seconds');
      await tick(snapshot);

      const notice = noticeRow(watchId);
      const claims = claimCount(notice.id);
      pointAt(notice.id, deliveryPane);
      await tick(snapshot);
      ${out("{ claims, delivered: db.prepare('SELECT typed_at FROM timers WHERE id = ?').get(notice.id).typed_at !== null }")}
      `,
      ["%1", "%2", "%3"],
    );

    assert.equal(
      result.claims.n,
      4,
      "the fixture must really have coalesced four EPISODE claims onto one notice, or nothing below is " +
        "measuring deduplication",
    );
    assert.equal(result.claims.a, 2, "and they must belong to only two distinct workers");
    assert.ok(result.delivered, "the notice must actually have been typed into the pane");

    const w1Mentions = result.text.match(/\bw1\b/g) ?? [];
    assert.equal(
      w1Mentions.length,
      1,
      `w1 finished three turns and must be named ONCE in what reaches the pane; got: ${result.text}`,
    );
    assert.equal((result.text.match(/\bw2\b/g) ?? []).length, 1, "and w2, which finished once, exactly once too");
    assert.doesNotMatch(
      result.text,
      /4 finished/,
      "a count of EPISODES sitting next to a list of names reads as a headcount - that is the defect",
    );
  });

  it("counts a worker it has just named as finished out of the still-going tally", () => {
    const result = deliverToPane(
      "no-double-count",
      `
      addWorker('agent:1', 'w1', '%1', 'idle', '-50 seconds');
      addWorker('agent:2', 'w2', '%2', 'working', '-50 seconds');
      const watchId = addStandingWatch();
      await tick(snapshot);

      // The finish is claim-time; the roster is read at DELIVERY time. w1 picking up new work in
      // between is what put one worker in both halves of one sentence.
      setState('agent:1', 'working', '-5 seconds');
      const notice = noticeRow(watchId);
      const claims = claimCount(notice.id);
      pointAt(notice.id, deliveryPane);
      await tick(snapshot);
      ${out("{ claims }")}
      `,
      ["%1", "%2"],
    );

    assert.equal(result.claims.a, 1, "exactly one worker may have been claimed, or the double-count cannot occur");
    assert.equal(
      (result.text.match(/\bw1\b/g) ?? []).length,
      1,
      `w1 must appear once in the delivered text, not once per half-sentence; got: ${result.text}`,
    );
    assert.match(
      result.text,
      /1 other still going\./,
      `only w2 is still going: a worker this notice has already described may not also be tallied as ` +
        `part of the crew that has not reported; got: ${result.text}`,
    );
    assert.match(
      result.text,
      /w1: working/,
      "crew state means w1 is described in the state hive reads NOW, not the state it was claimed in",
    );
  });

  it("reports a worker that is still idle with a live background shell, in the state it is in now", () => {
    const shell = readFileSync(join(REPO, "test", "fixtures", "hook-payloads", "stop-shell-running.json"), "utf8");
    const result = deliverToPane(
      "bg-in-crew-line",
      `
      addWorker('agent:1', 'w1', '%1', 'idle', '-50 seconds');
      addWorker('agent:2', 'w2', '%2', 'idle', '-50 seconds');
      const { writeFileSync } = await import('node:fs');
      const { recordClaudeWindowSize } = await import(${JSON.stringify(join(DIST, "statusline.js"))});
      const contextPath = process.env.HIVE_DATA_DIR + '/crew-context.jsonl';
      writeFileSync(contextPath, JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 25000 } } }) + '\\n');
      recordClaudeWindowSize('agent:1', JSON.stringify({ context_window: { context_window_size: 100000 } }));
      db.prepare('UPDATE agents SET transcript_path = ? WHERE actor_id = ?').run(contextPath, 'agent:1');
      stopWith('agent:1', ${JSON.stringify(shell)}, '-50 seconds');
      const watchId = addStandingWatch();
      await tick(snapshot);
      const notice = noticeRow(watchId);
      pointAt(notice.id, deliveryPane);
      await tick(snapshot);
      ${out("{ full: noticeRow(watchId).body }")}
      `,
      ["%1", "%2"],
    );

    assert.match(
      result.text,
      /w1: idle, 1 background shell running - may not be done, context 25%\./,
      `the per-worker line carries the worker's own background-task fact; got: ${result.text}`,
    );
    assert.match(result.text, /w2: idle, context unavailable\./, "and a worker with no live task carries no such clause");
    assert.match(
      result.full,
      /worker\(s\) in this project have finished or gone away/,
      "the STORED body must still be the full per-episode render - wake_get is what this render defers to",
    );
  });

  it("does not read a worker parked on a dialog as one that went back to work", () => {
    const result = deliverToPane(
      "waiting-is-not-progress",
      `
      addWorker('agent:1', 'w1', '%1', 'idle', '-50 seconds');
      addWorker('agent:2', 'w2', '%2', 'idle', '-50 seconds');
      const watchId = addStandingWatch();
      await tick(snapshot);

      // The ordinary path, not a constructed one: w1 finishes, the notice is held, w1's next turn
      // hits a permission prompt. hive latches that as the waiting state.
      setState('agent:1', 'waiting', '-5 seconds');
      const notice = noticeRow(watchId);
      pointAt(notice.id, deliveryPane);
      await tick(snapshot);
      ${out("{ noticeId: notice.id }")}
      `,
      ["%1", "%2"],
    );

    assert.match(
      result.text,
      /w1: waiting - may be stopped on a dialog; read its pane, context unavailable\./,
      `\`waiting\` is the one state that needs a human, and the full render says so in as many words; ` +
        `got: ${result.text}`,
    );
    assert.doesNotMatch(
      result.text,
      /w1: waiting again since it reported in/,
      "the generic 'again since it reported in' clause phrases a blocked worker as one making progress",
    );
    assert.match(result.text, /w2: idle, context unavailable\./, "the unaffected worker is the control that the render still works");
  });

  it("does not read a resumed worker's placeholder state as work it went back to", () => {
    const result = deliverToPane(
      "resumed-is-not-progress",
      `
      addWorker('agent:1', 'w1', '%1', 'idle', '-50 seconds');
      addWorker('agent:2', 'w2', '%2', 'idle', '-50 seconds');
      const watchId = addStandingWatch();
      await tick(snapshot);

      // resumeFlipSql writes agent_state='unknown' with resumed_at set: the worker has no state yet
      // and is awaiting its first assignment, which is not the same as having taken one.
      resumeWorker('agent:1');
      const notice = noticeRow(watchId);
      pointAt(notice.id, deliveryPane);
      await tick(snapshot);
      ${out("{ noticeId: notice.id }")}
      `,
      ["%1", "%2"],
    );

    assert.match(
      result.text,
      /w1: resumed, awaiting its first assignment, context unavailable\./,
      `a resumed worker has no state yet; got: ${result.text}`,
    );
    assert.doesNotMatch(result.text, /unknown/, "and the raw enum value must never reach the pane");
  });

  it("does not claim nothing else is running when a worker past the name cap is working", () => {
    const result = deliverToPane(
      "cap-hides-a-running-worker",
      `
      for (let i = 1; i <= 9; i++) addWorker('agent:' + i, 'w' + i, '%' + i, 'idle', '-50 seconds');
      const watchId = addStandingWatch();
      await tick(snapshot);

      const notice = noticeRow(watchId);
      const claims = claimCount(notice.id);
      // w9 is the ninth claim, so it falls past FINISHED_SHOWN_CAP and is never described. It then
      // takes new work, which puts it in the still-going roster the tally is drawn from.
      setState('agent:9', 'working', '-5 seconds');
      pointAt(notice.id, deliveryPane);
      await tick(snapshot);
      ${out("{ claims }")}
      `,
      ["%1", "%2", "%3", "%4", "%5", "%6", "%7", "%8", "%9"],
    );

    assert.equal(result.claims.a, 9, "nine distinct workers must have been claimed, or the cap is never reached");
    assert.match(result.text, /And 1 more not shown\./, "and one of them must really be past the cap");
    assert.doesNotMatch(
      result.text,
      /Nothing else is running\./,
      `w9 is working and was never described, so subtracting it from the tally types a flatly false ` +
        `sentence into a lead's pane; got: ${result.text}`,
    );
    assert.match(result.text, /1 other still going\./, "it belongs in the tally, which counts what this render did not describe");
  });

  it("reports the newest episode of a worker whose claims share one notified_at second", () => {
    const shell = readFileSync(join(REPO, "test", "fixtures", "hook-payloads", "stop-shell-running.json"), "utf8");
    const result = deliverToPane(
      "same-second-claims",
      `
      addWorker('agent:1', 'w1', '%1', 'idle', '-50 seconds');
      addWorker('agent:2', 'w2', '%2', 'working', '-50 seconds');
      // The OLDER episode is the one that left a shell running. If the newer episode does not win,
      // the render reports a background task the worker has since finished waiting on.
      stopWith('agent:1', ${JSON.stringify(shell)}, '-50 seconds');
      const watchId = addStandingWatch();
      await tick(snapshot);
      setState('agent:1', 'working', '-40 seconds');
      setState('agent:1', 'idle', '-35 seconds');
      await tick(snapshot);

      const notice = noticeRow(watchId);
      const claims = claimCount(notice.id);
      // notified_at is whole seconds, so two claims landing in the same second is ordinary. Forced
      // here because a fixture cannot rely on the scheduler happening to produce it.
      shareOneNotifiedSecond(notice.id);
      pointAt(notice.id, deliveryPane);
      await tick(snapshot);
      ${out("{ claims }")}
      `,
      ["%1", "%2"],
    );

    assert.equal(result.claims.n, 2, "two episodes for one worker, or there is no ordering to pin");
    assert.equal(result.claims.a, 1, "and both must belong to the same worker");
    assert.match(
      result.text,
      /\bw1: idle, context unavailable\.$/m,
      `the newer episode left nothing running, and it is the one that describes the worker now; ` +
        `got: ${result.text}`,
    );
    assert.doesNotMatch(result.text, /background shell running/, "the older episode's payload must not win");
  });
});

describe("todo 473: the staleness note earns its space or is not printed", () => {
  it("is absent from a notice delivered seconds after the finish it reports", () => {
    const result = deliverToPane(
      "no-note-on-short-hold",
      `
      addWorker('agent:1', 'w1', '%1', 'idle', '-50 seconds');
      addWorker('agent:2', 'w2', '%2', 'idle', '-50 seconds');
      const watchId = addStandingWatch();
      await tick(snapshot);
      const notice = noticeRow(watchId);
      pointAt(notice.id, deliveryPane);
      await tick(snapshot);
      ${out("{ noticeId: notice.id }")}
      `,
      ["%1", "%2"],
    );

    assert.match(result.text, /w1: idle, context unavailable\./, "the notice itself must have reached the pane, or the absence proves nothing");
    assert.doesNotMatch(
      result.text,
      /Held/,
      `138 characters of provenance on a one-second hold was 66% of the wake and said nothing; got: ${result.text}`,
    );
    assert.doesNotMatch(result.text, /reflects what hive knew/, "and neither half of it may survive");
  });

  it("states the timestamp and the age once when a long hold refreshed nothing", () => {
    const result = deliverToPane(
      "one-clause-on-long-hold",
      `
      addWorker('agent:1', 'w1', '%1', 'idle', '-50 seconds');
      addWorker('agent:2', 'w2', '%2', 'idle', '-50 seconds');
      const watchId = addStandingWatch();
      await tick(snapshot);
      const notice = noticeRow(watchId);
      backdate(notice.id, '-12 minutes', true);
      pointAt(notice.id, deliveryPane);
      await tick(snapshot);
      ${out("{ noticeId: notice.id }")}
      `,
      ["%1", "%2"],
    );

    assert.match(result.text, /Held 12m/, `a 12-minute hold must still be reported; got: ${result.text}`);
    const stamps = result.text.match(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC/g) ?? [];
    assert.equal(
      stamps.length,
      1,
      `held-since and content-as-of are the same instant here, so the note may state it once; got: ${result.text}`,
    );
    assert.doesNotMatch(
      result.text,
      /before this reached you/,
      "the second clause distinguishes two facts that are identical at this hold",
    );
  });

  it("keeps both clauses in full when a coalesced update really did move the content clock", () => {
    const result = deliverToPane(
      "two-clauses-when-they-differ",
      `
      addWorker('agent:1', 'w1', '%1', 'idle', '-50 seconds');
      addWorker('agent:2', 'w2', '%2', 'working', '-50 seconds');
      const watchId = addStandingWatch();
      await tick(snapshot);
      const notice = noticeRow(watchId);

      // Backdate only the first episode's filing, then coalesce a second finish onto the same notice:
      // updateNoticeInPlace stamps created_at with 'now', which is what forces the two clocks apart.
      backdate(notice.id, '-45 minutes', false);
      setState('agent:2', 'idle', '-5 seconds');
      await tick(snapshot);
      const claims = claimCount(notice.id);
      pointAt(notice.id, deliveryPane);
      await tick(snapshot);
      ${out("{ claims, sameNotice: noticeRow(watchId).id === notice.id }")}
      `,
      ["%1", "%2"],
    );

    assert.ok(result.sameNotice, "the second finish must land on the SAME notice, or the clocks were never forced apart");
    assert.equal(result.claims.n, 2, "and the notice must carry both episodes");
    assert.match(
      result.text,
      /Held since \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC \(4\dm ago\)\. Its content reflects what hive knew as of/,
      `a genuinely long hold whose content was refreshed keeps the note in full - it is not truncated; got: ${result.text}`,
    );
    assert.match(result.text, /before this reached you\./);
  });
});
