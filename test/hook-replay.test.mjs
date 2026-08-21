import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { DIST, REPO, assertScratchStore, clearHiveEnv, isolateTmux, runNode, scratchDirs } from "./helpers.mjs";

isolateTmux("the hook replay tests");
const { dataDir } = scratchDirs();

clearHiveEnv();
process.env.HIVE_DATA_DIR = dataDir;
await assertScratchStore();

const { db, migrate } = await import("../dist/db.js");
migrate();

const HOOK = join(DIST, "hook.js");
const FIXTURES = join(REPO, "test", "fixtures", "hook-payloads");

const project = db
  .prepare("INSERT INTO projects (name, path) VALUES (?, ?) RETURNING id")
  .get("hook-replay-test", dataDir).id;

function agentRow(name, state) {
  return db
    .prepare(
      `INSERT INTO agents (project_id, actor_id, name, tmux_target, command, cwd, status, agent_state)
       VALUES (?, ?, ?, '%9600', 'claude', '/tmp', 'running', ?) RETURNING id`,
    )
    .get(project, `agent:${name}`, name, state).id;
}

const stateOf = (id) => db.prepare("SELECT agent_state FROM agents WHERE id = ?").get(id).agent_state;

const logStateFor = (actorId) =>
  db.prepare("SELECT state FROM agent_state_log WHERE actor_id = ? ORDER BY id DESC LIMIT 1").get(actorId).state;

function fixture(name) {
  return readFileSync(join(FIXTURES, name), "utf8");
}

async function runHook(event, payload, actorId) {
  const { code } = await runNode(HOOK, [event], { dataDir, env: { HIVE_AGENT_ID: actorId }, stdin: payload });
  assert.equal(code, 0, `hook must always exit 0, actor ${actorId}`);
}

function expectedState(startState, decidedLogState) {
  return decidedLogState === "unchanged" ? startState : decidedLogState;
}

const CASES = [
  ["prompt-user.json", "prompt", "idle", "working"],

  ["prompt-spawn-announcement.json", "prompt", "idle", "working"],
  ["prompt-task-notification.json", "prompt", "idle", "working"],
  ["stop-subagents-running.json", "stop", "idle", "working"],
  ["stop-shell-running.json", "stop", "working", "idle"],
  ["stop-monitors-running.json", "stop", "working", "idle"],
  ["stop-idle.json", "stop", "idle", "idle"],
  ["notify-idle-prompt.json", "notify", "working", "unchanged"],
  ["notify-permission-prompt.json", "notify", "idle", "waiting"],
];

describe("dist/hook.js decides the recorded state for every captured payload", () => {

  for (const [file, event, startState, decidedLogState] of CASES) {
    it(`${file} (${event}) -> ${decidedLogState}`, async () => {
      const actorId = `agent:${file}`;
      const agent = agentRow(file, startState);

      await runHook(event, fixture(file), actorId);

      assert.equal(stateOf(agent), expectedState(startState, decidedLogState));
      assert.equal(logStateFor(actorId), decidedLogState);
    });
  }
});
