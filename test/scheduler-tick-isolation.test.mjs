import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { assertScratchStore, isolateTmux, scratchDirs } from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("the scheduler tick isolation tests");
const NEEDS_TMUX = { skip: hasTmux ? false : "tmux is not installed" };
const { dataDir, projectDir } = scratchDirs();

process.env.HIVE_DATA_DIR = dataDir;
await assertScratchStore();

const { db, migrate } = await import("../dist/db.js");
const { tick } = await import("../dist/scheduler.js");
const { sendText } = await import("../dist/tmux.js");
migrate();
const projectId = db.prepare("INSERT INTO projects (name, path) VALUES (?, ?) RETURNING id").get("tick-isolation", projectDir).id;

const session = `hive-tick-isolation-${process.pid}`;
const realTmux = hasTmux ? execFileSync("which", ["tmux"], { encoding: "utf8" }).trim() : "/usr/bin/false";
const shimDir = mkdtempSync(join(tmpdir(), "hive-tick-isolation-"));
writeFileSync(
  join(shimDir, "tmux"),
  `#!/bin/sh
command=""
for a in "$@"; do
  case "$a" in paste-buffer|send-keys) command="$a" ;; esac
done
if [ "$command" = "paste-buffer" ]; then
  for a in "$@"; do
    if [ "$a" = "$HIVE_TEST_FAIL_PANE" ] && [ -n "$HIVE_TEST_FAIL_PANE" ]; then
      echo "tmux: forced paste failure" >&2
      exit 1
    fi
  done
fi
if [ "$command" = "send-keys" ] && [ "$HIVE_TEST_FAIL_ENTER" = "1" ]; then
  for a in "$@"; do
    if [ "$a" = "Enter" ]; then
      echo "tmux: forced Enter failure" >&2
      exit 1
    fi
  done
fi
exec ${realTmux} "$@"
`,
  { mode: 0o755 },
);
process.env.PATH = `${shimDir}:${process.env.PATH}`;

let firstPane;
let secondPane;

before(() => {
  if (!hasTmux) return;
  execFileSync("tmux", ["new-session", "-d", "-s", session, "-n", "first", "sleep", "600"], { stdio: "ignore" });
  execFileSync("tmux", ["new-window", "-d", "-t", session, "-n", "second", "sleep", "600"], { stdio: "ignore" });
  firstPane = execFileSync("tmux", ["list-panes", "-t", `${session}:first`, "-F", "#{pane_id}"], { encoding: "utf8" }).trim();
  secondPane = execFileSync("tmux", ["list-panes", "-t", `${session}:second`, "-F", "#{pane_id}"], { encoding: "utf8" }).trim();
  assert.ok(firstPane && secondPane, `expected two panes, got ${JSON.stringify([firstPane, secondPane])}`);
});

after(() => {
  delete process.env.HIVE_TEST_FAIL_PANE;
  cleanup(session);
});

function seedDelayWake(pane, body) {
  return db
    .prepare(
      `INSERT INTO wakes (project_id, owner, body, kind, watch, deliver_actor, deliver_pane,
         due_at, created_at)
       VALUES (?, 'user:test', ?, 'delay', '[]', 'user:test', ?, datetime('now', '-5 seconds'), datetime('now'))
       RETURNING id`,
    )
    .get(projectId, body, pane)
    .id;
}

function seedMalformedIdleWake(pane) {
  return db
    .prepare(
      `INSERT INTO wakes (project_id, owner, body, kind, watch, deliver_actor, deliver_pane, created_at)
       VALUES (?, 'user:test', 'poison', 'idle_any', 'not-json', 'user:test', ?, datetime('now'))
       RETURNING id`,
    )
    .get(projectId, pane).id;
}

describe("tick() isolates failures so one timer or step cannot skip delivery", () => {
  it("a throwing timer does not starve later timers in the tick", NEEDS_TMUX, async () => {
    const poisonId = seedMalformedIdleWake(firstPane);
    const secondId = seedDelayWake(secondPane, "second");
    const snapshot = {
      panes: new Set([firstPane, secondPane]),
      windows: new Set(),
      pids: new Map(),
    };
    const errors = [];
    const originalError = console.error;
    console.error = (...args) => errors.push(args.join(" "));
    try {
      await tick(snapshot);
    } finally {
      console.error = originalError;
    }

    const poison = db.prepare("SELECT fired_at FROM wakes WHERE id = ?").get(poisonId);
    const second = db.prepare("SELECT fired_at FROM wakes WHERE id = ?").get(secondId);
    assert.equal(poison.fired_at, null, "the malformed watch must throw before it can claim its wake");
    assert.ok(errors.some((line) => line.includes(`timer ${poisonId} failed`)), "the poison timer must actually throw");
    assert.ok(second.fired_at, "a thrown timer must not skip the next timer");
    db.prepare("DELETE FROM wakes WHERE id = ?").run(poisonId);
  });

  it("a pre-paste one-shot error preserves the untyped claim", NEEDS_TMUX, async () => {
    const timerId = seedDelayWake(firstPane, "lost-after-claim");
    process.env.HIVE_TEST_FAIL_PANE = firstPane;

    await tick();

    const timer = db.prepare("SELECT fired_at, fire_count, cancelled_at, held_reason FROM wakes WHERE id = ?").get(timerId);
    assert.ok(timer.fired_at, "the wake must have been claimed before the injected delivery failure");
    assert.equal(timer.fire_count, 1, "the failed one-shot wake must not be claimed again");
    assert.equal(timer.cancelled_at, null, "an undelivered wake must not be marked terminal");
    assert.equal(timer.held_reason, null, "do not record an undelivered wake as terminal");
    delete process.env.HIVE_TEST_FAIL_PANE;
  });

  it("a post-paste one-shot error records the lost wake", NEEDS_TMUX, async () => {
    const timerId = seedDelayWake(firstPane, "lost-after-paste");
    process.env.HIVE_TEST_FAIL_ENTER = "1";
    await assert.rejects(sendText(firstPane, "direct shim check", true), /forced Enter failure/);

    await tick();

    const timer = db.prepare("SELECT fired_at, fire_count, cancelled_at, held_reason FROM wakes WHERE id = ?").get(timerId);
    assert.ok(timer.fired_at, "the wake must have been claimed before the injected delivery failure");
    assert.equal(timer.fire_count, 1, "the failed one-shot wake must not be claimed again");
    assert.ok(timer.cancelled_at, "a pasted one-shot with no notice repair path must be terminal");
    assert.match(timer.held_reason, /^delivery stopped after claim: /, "the failure must leave a reason on the wake");
    assert.match(timer.held_reason, /body was pasted; no Enter was sent/, "the record must distinguish the partial delivery");
    delete process.env.HIVE_TEST_FAIL_PANE;
    delete process.env.HIVE_TEST_FAIL_ENTER;
  });

  it("a throwing janitor does not skip timer delivery", NEEDS_TMUX, async () => {
    delete process.env.HIVE_TEST_FAIL_PANE;
    delete process.env.HIVE_TEST_FAIL_ENTER;
    const timerId = seedDelayWake(firstPane, "after-janitor");
    db.prepare(
      `INSERT INTO agents (project_id, actor_id, name, tmux_target, command, cwd, status, agent_state, created_at)
       VALUES (?, 'agent:poison', 'poison', '%missing',
         'claude', '/tmp', 'running', 'working', datetime('now', '-60 seconds'))`,
    ).run(projectId);
    db.exec(
      `CREATE TRIGGER fail_poison_agent_close BEFORE UPDATE ON agents
       WHEN OLD.actor_id = 'agent:poison'
       BEGIN SELECT RAISE(ABORT, 'forced janitor failure'); END`,
    );

    await tick({ panes: new Set([firstPane, secondPane]), windows: new Set(), serverAnswered: true });

    const timer = db.prepare("SELECT fired_at FROM wakes WHERE id = ?").get(timerId);
    assert.ok(timer.fired_at, "a janitor failure must not skip the timer loop");
  });
});
