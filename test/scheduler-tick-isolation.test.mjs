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
migrate();
const projectId = db.prepare("INSERT INTO projects (name, path) VALUES (?, ?) RETURNING id").get("tick-isolation", projectDir).id;

const session = `hive-tick-isolation-${process.pid}`;
const realTmux = hasTmux ? execFileSync("which", ["tmux"], { encoding: "utf8" }).trim() : "/usr/bin/false";
const shimDir = mkdtempSync(join(tmpdir(), "hive-tick-isolation-"));
writeFileSync(
  join(shimDir, "tmux"),
  `#!/bin/sh
if [ "$1" = "paste-buffer" ]; then
  for a in "$@"; do
    if [ "$a" = "$HIVE_TEST_FAIL_PANE" ] && [ -n "$HIVE_TEST_FAIL_PANE" ]; then
      echo "tmux: forced paste failure" >&2
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

describe("tick() isolates failures so one timer or step cannot skip delivery", () => {
  it("a throwing timer does not starve later timers in the tick", NEEDS_TMUX, async () => {
    const firstId = seedDelayWake(firstPane, "first");
    const secondId = seedDelayWake(secondPane, "second");
    process.env.HIVE_TEST_FAIL_PANE = firstPane;

    await tick();

    const first = db.prepare("SELECT fired_at FROM wakes WHERE id = ?").get(firstId);
    const second = db.prepare("SELECT fired_at FROM wakes WHERE id = ?").get(secondId);
    assert.ok(first.fired_at, "the first wake must have been claimed before its forced delivery error");
    assert.ok(second.fired_at, "a delivery error for the first timer must not skip the next timer");
  });

  it("a throwing janitor does not skip timer delivery", NEEDS_TMUX, async () => {
    delete process.env.HIVE_TEST_FAIL_PANE;
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
