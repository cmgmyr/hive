import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { isolateTmux, REPO, scratchDirs, until } from "./helpers.mjs";

// TODO 386, reproduced from the live incident of 2026-08-13 rather than
// imagined. Standing watch 400 reported worker t384-n1 GONE twice, 62 seconds
// apart, for one episode, and the claim row that is supposed to make that
// impossible named only the SECOND notice.
//
// WHAT THE STORE ACTUALLY RECORDED, read out of ~/.hive/hive.db before any
// code was written (workflows/capture-before-fix.md): notice 412 had fired_at
// set and typed_at NULL, and agent_state_log row 4346 carried ONE user turn
// containing BOTH bodies, concatenated mid-line -
// "...wake_cancel(wake_id: 400).[hive wake #413] 1 worker(s)...". So 412's
// text WAS pasted into the lead's pane; only its Enter never arrived. It sat
// in the input box until the next notice's paste appended to it and that
// notice's Enter submitted both as one turn.
//
// sendText (src/tmux.ts) is a PASTE and then, ENTER_DELAY_MS later, a SECOND
// tmux call for the Enter. deliver() records typed_at only after both return.
// So a failure between them leaves the store saying "never typed" about text
// the reader can already see - and 60 seconds later rearmSpentEpisode
// (NOTICE_RETRY_AFTER) reads that as a lost delivery, deletes the claim,
// re-claims the episode and files the duplicate. The four rows on todo 386
// are that path's signature: the claim row is not overwritten, it is DELETED
// AND RE-INSERTED, which is why its notified_at moved with it.
//
// THE THREE CASES BELOW ARE THE SPLIT THE FIX HAS TO GET RIGHT, and two of
// them exist to keep the first honest: "no duplicate" is trivially satisfiable
// by a re-arm that has stopped working at all, so a delivery where NOTHING
// reached the pane must still be re-armed and reported again.
//
// THE PANE'S OWN CHROME IS A THIRD DIMENSION, added after counselors round 1
// raised it from both seats independently (codex P1#2, claude F7). The early
// record is taken ONLY where a stranded paste would HOLD later wakes, which
// needs claude's input box on screen; on a bash pane inputBoxState is null
// forever, holdsHumanInput is false, nothing holds, and the episode has to
// stay re-armable. So case A replays a real captured claude screen into its
// pane and case C is the identical failure against a plain shell. The first
// version of this file used a shell pane for case A, which is how it passed
// while proving nothing about the pane the incident actually happened on -
// test/CLAUDE.md's shape 7, an assertion satisfied by two indistinguishable
// causes, one dimension over.
//
// FIFTEEN CONCURRENT SCHEDULERS ARE NOT NEEDED and this file deliberately
// does not use them. One scheduler whose Enter fails produces every row the
// incident carried; the fifteen only supplied the tmux fork contention that
// made an Enter fail and the second, near-simultaneous notice for its text to
// merge into.
const { hasTmux, cleanup } = isolateTmux("the partial-send notice tests");
const NEEDS_TMUX = { skip: hasTmux ? false : "tmux is not installed" };

const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { db, migrate } = await import("../dist/db.js");
const { tick } = await import("../dist/scheduler.js");
const { sessionName } = await import("../dist/tmux.js");

// A fake tmux that fails ONE call shape and passes everything else through to
// the real one, the scaffold test/probe.test.mjs already uses. Failing the
// whole binary would prove nothing here: the entire point is that the paste
// SUCCEEDS and only the submit fails, so the paste has to really land in a
// real pane.
const realTmux = hasTmux ? execFileSync("which", ["tmux"], { encoding: "utf8" }).trim() : "/usr/bin/false";
const shimDir = mkdtempSync(join(tmpdir(), "hive-partialsend-"));
writeFileSync(
  join(shimDir, "tmux"),
  `#!/bin/sh
# HIVE_TEST_FAIL_ENTER: the submit only - \`send-keys -t <pane> Enter\`. The
# paste is set-buffer + paste-buffer for a multi-line body, so it is untouched.
if [ "$HIVE_TEST_FAIL_ENTER" = "1" ] && [ "$1" = "send-keys" ]; then
  for a in "$@"; do
    if [ "$a" = "Enter" ]; then echo "tmux: send-keys failed" >&2; exit 1; fi
  done
fi
# HIVE_TEST_FAIL_PASTE: nothing ever reaches the pane. The control.
if [ "$HIVE_TEST_FAIL_PASTE" = "1" ] && [ "$1" = "paste-buffer" ]; then
  echo "tmux: paste-buffer failed" >&2; exit 1
fi
exec ${realTmux} "$@"
`,
  { mode: 0o755 },
);
process.env.PATH = `${shimDir}:${process.env.PATH}`;

// Two real panes, and the difference between them is the point. `shellPane`
// runs a plain shell: no claude chrome, so inputBoxState is null and a
// stranded paste holds nothing. `claudePane` replays a real captured idle
// claude screen, byte for byte, the way test/typing-guards.test.mjs replays
// its fixtures - so inputBoxState finds a box, classifies it, and a stranded
// paste there would read `pending` and hold every later wake. Both take a real
// paste and both are read back with capture-pane, which is the only evidence
// separating "the text reached the reader" from "nothing was delivered".
let shellPane;
let claudePane;

const readyIdle = join(REPO, "test", "fixtures", "panes", "ready-idle.txt");

// 220 columns because every fixture in that directory was captured at 220 and
// replaying one into a narrower pane wraps its borders - the defect todo 399
// found by running at 80 (.claude/rules/tmux-and-panes.md, "A WRAPPED BORDER
// IS ONE EDGE"). A wrapped border means no box, which would make case A pass
// for exactly the wrong reason.
before(async () => {
  if (!hasTmux) return;
  migrate();
  execFileSync("tmux", ["new-session", "-d", "-s", sessionName(), "-x", "220", "-y", "60"]);
  shellPane = execFileSync("tmux", ["list-panes", "-t", `=${sessionName()}`, "-F", "#{pane_id}"], {
    encoding: "utf8",
  }).trim();
  claudePane = execFileSync(
    "tmux",
    ["new-window", "-P", "-F", "#{pane_id}", "-t", `=${sessionName()}`, "sh", "-c", `cat '${readyIdle}'; sleep 600`],
    { encoding: "utf8" },
  ).trim();
  // The fixture has to be on screen before any test reads the box, or the
  // pane is still blank and reads as no-box - a race that would silently turn
  // case A back into case C.
  await until(() => capture(claudePane).includes("❯"));
  const { inputBoxState } = await import("../dist/tmux.js");
  const box = inputBoxState(claudePane);
  assert.ok(
    box !== null && box.state !== "unknown",
    `the claude fixture pane must classify as a real box for case A to mean anything, got ${JSON.stringify(box)}`,
  );
});

after(() => {
  cleanup(sessionName());
});

// Every scenario gets its own project, watch and worker, so one case's cursor
// rows can never satisfy another's assertions.
let seq = 0;
function seedScenario(pane) {
  const tag = `ps${++seq}`;
  const project = db
    .prepare("INSERT INTO projects (name, path) VALUES (?, ?) RETURNING id")
    .get(tag, `/tmp/${tag}`).id;
  db.prepare(
    `INSERT INTO agents (project_id, actor_id, name, tmux_target, command, cwd, kind, status, created_at)
       VALUES (?, ?, 'lead', ?, 'claude', '/tmp', 'lead', 'running', datetime('now', '-300 seconds'))`,
  ).run(project, `lead:${tag}`, pane);
  // A worker that DIED: closed, frozen mid-work, never parked. That is
  // standingGoneRows' own population.
  const worker = db
    .prepare(
      `INSERT INTO agents (project_id, actor_id, name, tmux_target, command, cwd, kind, status,
          agent_state, state_changed_at, closed_at, created_at)
        VALUES (?, ?, ?, '%9', 'claude', '/tmp', 'agent', 'closed', 'working',
          datetime('now', '-30 seconds'), datetime('now'), datetime('now', '-300 seconds')) RETURNING id`,
    )
    .get(project, `agent:${tag}`, `w-${tag}`).id;
  const watch = db
    .prepare(
      `INSERT INTO timers (project_id, owner, body, kind, watch_scope, deliver_actor, deliver_pane,
          max_wait_at, created_at)
        VALUES (?, ?, 'crew update', 'idle_any', 'project', ?, ?,
          datetime('now', '+4 hours'), datetime('now', '-60 seconds')) RETURNING id`,
    )
    .get(project, `lead:${tag}`, `lead:${tag}`, pane).id;
  return { project, worker, watch, name: `w-${tag}` };
}

const notices = (watch) =>
  db
    .prepare(
      `SELECT id, body, fired_at, typed_at, cancelled_at FROM timers
        WHERE parent_timer_id = ? ORDER BY id`,
    )
    .all(watch);
const cursor = (watch) =>
  db
    .prepare(
      `SELECT agent_id, condition, episode, notice_timer_id, notified_at
         FROM wake_idle_notices WHERE timer_id = ? ORDER BY notified_at`,
    )
    .all(watch);

// Anchored to the REPORTED block's two-space indent and to GONE specifically.
// A bare /name/ also matches the "Still going:" roster, which names every
// worker that is merely alive
// (common-issues/a-bare-name-matcher-also-matches-the-still-going-roster.md).
const reportedGone = (watch, name) =>
  notices(watch).filter((n) => new RegExp(`^ {2}${name}: GONE`, "m").test(n.body));

const snapshotWith = (target) => ({ panes: new Set([target]), windows: new Set() });

// A declaration rather than a const: before() reads it, and this file's
// helpers sit below the hooks.
function capture(pane) {
  return execFileSync("tmux", ["capture-pane", "-p", "-t", pane], { encoding: "utf8" });
}

// The one thing this file simulates rather than waits for. NOTICE_RETRY_AFTER
// is 60 real seconds and the re-arm reads fired_at, so moving fired_at back is
// exactly equivalent to waiting - and it is the only value moved.
const ageNoticePastRetry = (noticeId) =>
  db.prepare("UPDATE timers SET fired_at = datetime('now', '-61 seconds') WHERE id = ?").run(noticeId);

describe("a notice whose paste landed but whose Enter failed", () => {
  it("is not reported a second time, on a pane where the text will hold", NEEDS_TMUX, async () => {
    const { watch, worker, name } = seedScenario(claudePane);

    // Tick 1 files the notice. Tick 2 delivers it, with the submit broken.
    await tick(snapshotWith(claudePane));
    assert.equal(notices(watch).length, 1, "the death should be reported once");
    process.env.HIVE_TEST_FAIL_ENTER = "1";
    await tick(snapshotWith(claudePane));
    delete process.env.HIVE_TEST_FAIL_ENTER;

    const delivered = notices(watch)[0];
    assert.ok(delivered.fired_at, "the notice was claimed");
    assert.match(
      capture(claudePane),
      new RegExp(`\\[hive wake #${delivered.id}\\]`),
      "the paste really landed in the pane - without this the case is not the incident's",
    );
    // Counselors round 1, claude F3: without this the test passes for the
    // wrong reason. A mutation that breaks the RE-ARM rather than the RECORD
    // also produces one notice, and the two are only told apart by the column
    // this lane actually changed.
    assert.notEqual(
      delivered.typed_at,
      null,
      "the record must say delivered - that is the fix, not the absence of a second notice",
    );

    // The incident's 62 seconds, without waiting them out.
    ageNoticePastRetry(delivered.id);
    await tick(snapshotWith(claudePane));

    assert.equal(
      reportedGone(watch, name).length,
      1,
      "the worker's death is on the reader's screen; saying it again is the defect",
    );
    const rows = cursor(watch);
    assert.equal(rows.length, 1, "one claim row per agent, unchanged");
    assert.equal(rows[0].agent_id, worker);
    assert.equal(
      rows[0].notice_timer_id,
      delivered.id,
      "the claim must still name the notice that carried it, not a later one",
    );
  });

  it("is still reported again when nothing reached the pane at all", NEEDS_TMUX, async () => {
    // CONTROL 1. Without this, "no duplicate" is satisfied just as well by a
    // re-arm that has stopped working, which would silently lose every finish
    // whose delivery genuinely failed - the case NOTICE_RETRY_AFTER exists for.
    const { watch, name } = seedScenario(claudePane);

    await tick(snapshotWith(claudePane));
    const before = notices(watch);
    assert.equal(before.length, 1);
    process.env.HIVE_TEST_FAIL_PASTE = "1";
    await tick(snapshotWith(claudePane));
    delete process.env.HIVE_TEST_FAIL_PASTE;

    assert.doesNotMatch(
      capture(claudePane),
      new RegExp(`\\[hive wake #${before[0].id}\\]`),
      "nothing reached the pane in this case",
    );
    assert.equal(notices(watch)[0].typed_at, null);

    ageNoticePastRetry(before[0].id);
    await tick(snapshotWith(claudePane));

    assert.equal(
      reportedGone(watch, name).length,
      2,
      "a delivery that never reached the pane must still be repaired",
    );
  });

  it("IS reported again on a pane with no input box for the text to hold in", NEEDS_TMUX, async () => {
    // CONTROL 2, and the one that pins the split itself (counselors round 1,
    // codex P1#2 and claude F7). Identical failure to case A - the paste
    // lands, the Enter fails - against a plain shell. There is no claude
    // chrome, so inputBoxState is null, holdsHumanInput is false, and nothing
    // will hold behind the stranded text. The whole argument for recording it
    // as delivered is absent, so the episode must stay re-armable and the
    // duplicate here is the CORRECT outcome.
    const { watch, name } = seedScenario(shellPane);

    await tick(snapshotWith(shellPane));
    const before = notices(watch);
    assert.equal(before.length, 1);
    process.env.HIVE_TEST_FAIL_ENTER = "1";
    await tick(snapshotWith(shellPane));
    delete process.env.HIVE_TEST_FAIL_ENTER;

    assert.match(
      capture(shellPane),
      new RegExp(`\\[hive wake #${before[0].id}\\]`),
      "the paste landed here too - the only difference from case A is the pane's chrome",
    );
    assert.equal(
      notices(watch)[0].typed_at,
      null,
      "no hold exists on this pane, so the pre-lane record is what keeps the repair reachable",
    );

    ageNoticePastRetry(before[0].id);
    await tick(snapshotWith(shellPane));

    assert.equal(
      reportedGone(watch, name).length,
      2,
      "a worker whose obituary is stranded where nothing will hold it must be reported again",
    );
  });
});
