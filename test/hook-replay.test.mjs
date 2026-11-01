import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { DIST, REPO, assertScratchStore, clearHiveEnv, isolateTmux, runNode, scratchDirs } from "./helpers.mjs";

isolateTmux("the hook replay tests");
const { dataDir } = scratchDirs();

clearHiveEnv();
process.env.HIVE_DATA_DIR = dataDir;
process.env.CLAUDE_CONFIG_DIR = join(dataDir, "claude-home");
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

  it("rate_limit StopFailure from findings-limit-fork-spike A2 holds without changing worker state", async () => {
    const actorId = "agent:synthetic-limit";
    const id = db.prepare(`INSERT INTO agents
      (project_id, actor_id, name, tmux_target, command, cwd, status, agent_state, kind, session_id)
      VALUES (?, ?, 'synthetic-limit', '%9601', 'claude', '/tmp', 'running', 'working', 'agent', 'synthetic-claude-session') RETURNING id`)
      .get(project, actorId).id;
    const transcriptDir = join(process.env.CLAUDE_CONFIG_DIR, "projects", "-tmp");
    const transcriptPath = join(transcriptDir, "synthetic-claude-session.jsonl");
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(transcriptDir, { recursive: true });
    writeFileSync(transcriptPath,
      `{"type":"assistant","sessionId":"synthetic-claude-session","isApiErrorMessage":true,"error":"rate_limit","apiError":"usage_limit_reached","quotaLimits":{"status":"rejected","resetsAt":1793555100}}\n`);

    await runHook("stop_failure", JSON.stringify({
      session_id: "synthetic-claude-session",
      transcript_path: transcriptPath,
      error: "rate_limit",
      last_assistant_message: "You've hit your session limit · resets 3:45pm",
    }), actorId);

    assert.equal(stateOf(id), "working");
    assert.equal(db.prepare("SELECT state FROM agent_state_log WHERE actor_id = ? ORDER BY id DESC LIMIT 1").get(actorId).state, "unchanged");
    assert.equal(db.prepare("SELECT harness FROM agent_usage_limits WHERE agent_id = ?").get(id).harness, "claude");
  });

  it("generated Claude hooks match only rate_limit StopFailure from findings-limit-fork-spike A2", async () => {
    const id = agentRow("hook-settings", "working");
    const { ensureWorkerHooksFile } = await import("../dist/hooks.js");
    const path = ensureWorkerHooksFile(id, { includePostToolUse: false });
    const settings = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(settings.hooks.StopFailure.length, 1);
    assert.equal(settings.hooks.StopFailure[0].matcher, "rate_limit");
    assert.match(settings.hooks.StopFailure[0].hooks[0].command, /hook\.js stop_failure$/);
  });
});
