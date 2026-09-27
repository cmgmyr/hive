import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import { assertScratchStore, isolateTmux, REPO, repaintPaneAsSameWorker, scratchDirs, until } from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("the held-idle-wake label tests");

const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;

await assertScratchStore();

const { db, migrate } = await import("../dist/db.js");
const { tick } = await import("../dist/scheduler.js");

migrate();

const FIXTURES = join(REPO, "test", "fixtures", "panes");
const holdCommand = () => `cat '${join(FIXTURES, "real-input.txt")}'; sleep 600`;

const session = `hive-heldidle-${process.pid}`;
const outFile = join(dirs.tmp, "delivered.txt");

const project = db
  .prepare("INSERT INTO projects (name, path) VALUES (?, ?) RETURNING id")
  .get("held-idle-label-test", dirs.projectDir).id;

let pane;

before(() => {
  if (!hasTmux) return;
  execFileSync(
    "tmux",
    ["new-session", "-d", "-s", session, "-x", "220", "-y", "50", "-c", dirs.projectDir, holdCommand()],
    { stdio: "ignore" },
  );
  pane = execFileSync("tmux", ["list-panes", "-s", "-t", `=${session}`, "-F", "#{pane_id}"], {
    encoding: "utf8",
  }).trim();
});

after(() => cleanup(session));

function reset() {
  db.exec("DELETE FROM wakes; DELETE FROM agents;");
}

function agentRow(state) {
  const pid = execFileSync("tmux", ["display-message", "-p", "-t", pane, "#{pane_pid}"], {
    encoding: "utf8",
  }).trim();
  return db
    .prepare(
      `INSERT INTO agents (project_id, actor_id, name, tmux_target, command, cwd, status, agent_state,
         pane_pid, state_changed_at, created_at)
       VALUES (?, 'agent:combo', 'combo', ?, 'claude', '/tmp', 'running', ?, ?, datetime('now'), datetime('now', '-60 seconds'))
       RETURNING id`,
    )
    .get(project, pane, state, pid).id;
}

function timedOutIdleAnyWake(agentId) {
  return db
    .prepare(
      `INSERT INTO wakes (project_id, owner, body, kind, watch, deliver_actor, deliver_pane,
         max_wait_at, created_at)
       VALUES (?, 'agent:combo', 'lane check', 'idle_any', ?, 'agent:combo', ?,
         datetime('now', '-1 seconds'), datetime('now', '-60 seconds'))
       RETURNING id`,
    )
    .get(project, JSON.stringify([agentId]), pane).id;
}

const delivered = () => readFileSync(outFile, "utf8");

describe(
  "a one-shot idle wake HELD past max_wait_at (todo 1488)",
  { skip: hasTmux ? false : "tmux is not installed" },
  () => {
    beforeEach(() => {
      reset();
      writeFileSync(outFile, "");
      execFileSync("tmux", ["respawn-pane", "-k", "-t", pane, holdCommand()], { stdio: "ignore" });
    });

    it("delivers without the max-wait label when the idle condition was met before the hold outlived max_wait_at", async () => {
      const agentId = agentRow("idle");
      const wakeId = timedOutIdleAnyWake(agentId);

      await tick();
      const held = db.prepare("SELECT fired_at, held_reason FROM wakes WHERE id = ?").get(wakeId);
      assert.equal(held.fired_at, null, "the unsubmitted-input hold must still be blocking delivery");
      assert.match(held.held_reason ?? "", /unsubmitted/, "held for the input-box reason, not delivered yet");

      repaintPaneAsSameWorker(db, pane, `cat > ${outFile}`);

      await tick();
      const ok = await until(() => delivered().includes(`hive wake #${wakeId}`));
      assert.ok(ok, `wake never delivered; outFile: ${JSON.stringify(delivered())}`);

      assert.doesNotMatch(
        delivered(),
        /max wait reached/,
        "the idle condition was already met, so the hold outliving max_wait_at must not relabel it",
      );
    });

    it("still labels the delivery max wait reached when the idle condition was never met", async () => {
      const agentId = agentRow("working");
      const wakeId = timedOutIdleAnyWake(agentId);

      repaintPaneAsSameWorker(db, pane, `cat > ${outFile}`);

      await tick();
      const ok = await until(() => delivered().includes(`hive wake #${wakeId}`));
      assert.ok(ok, `wake never delivered; outFile: ${JSON.stringify(delivered())}`);

      assert.match(
        delivered(),
        new RegExp(`\\[hive wake #${wakeId}, max wait reached\\]`),
        "the idle condition was never met, so a genuinely timed-out delivery keeps its label",
      );
    });
  },
);
