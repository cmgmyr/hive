import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { isolateTmux, REPO, scratchDirs, until } from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("the partial-send notice tests");
const NEEDS_TMUX = { skip: hasTmux ? false : "tmux is not installed" };

const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { db, migrate } = await import("../dist/db.js");
const { tick } = await import("../dist/scheduler.js");
const { sessionName } = await import("../dist/tmux.js");

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

let shellPane;
let claudePane;

const readyIdle = join(REPO, "test", "fixtures", "panes", "ready-idle.txt");

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

const reportedGone = (watch, name) =>
  notices(watch).filter((n) => new RegExp(`^ {2}${name}: GONE`, "m").test(n.body));

const snapshotWith = (target) => ({ panes: new Set([target]), windows: new Set() });

function capture(pane) {
  return execFileSync("tmux", ["capture-pane", "-p", "-t", pane], { encoding: "utf8" });
}

const ageNoticePastRetry = (noticeId) =>
  db.prepare("UPDATE timers SET fired_at = datetime('now', '-61 seconds') WHERE id = ?").run(noticeId);

describe("a notice whose paste landed but whose Enter failed", () => {
  it("is not reported a second time, on a pane where the text will hold", NEEDS_TMUX, async () => {
    const { watch, worker, name } = seedScenario(claudePane);

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

    assert.notEqual(
      delivered.typed_at,
      null,
      "the record must say delivered - that is the fix, not the absence of a second notice",
    );

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
