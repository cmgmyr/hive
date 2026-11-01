import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { after, before, describe, it } from "node:test";
import {
  clearHiveEnv,
  isolateTmux,
  liveAgentRow,
  makeFakeClaude,
  McpClient,
  reportedAsFinished,
  runNode,
  scratchDirs,
  seedDeadPaneLead,
  seedStandingWatch,
} from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("the fork first-prompt tests");
clearHiveEnv();
const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { db } = await import("../dist/db.js");
const { codexHomeDir } = await import("../dist/codexHome.js");
const { readContextFill } = await import("../dist/transcript.js");
const { tick } = await import("../dist/scheduler.js");
const { liveTargets, sessionName } = await import("../dist/tmux.js");
const HOOK = join(new URL("../dist/hook.js", import.meta.url).pathname);
const OWNER = "lead:fork-first-prompt";
let mcp;
let projectId;

before(async () => {
  mcp = new McpClient({
    cwd: dirs.projectDir,
    dataDir: dirs.dataDir,
    env: { HIVE_AGENT_ID: OWNER, HIVE_SPAWN_READY_MS: "1000" },
  });
  await mcp.start();
  projectId = (await mcp.call("whoami")).project.id;
  seedDeadPaneLead(db, projectId, dirs.projectDir, OWNER);
});

after(async () => {
  if (mcp) {
    const rows = db.prepare("SELECT id FROM agents WHERE project_id = ? AND status = 'running'").all(projectId);
    for (const row of rows) await mcp.call("agent_close", { agent_id: row.id }).catch(() => {});
    await mcp.close();
  }
  cleanup(sessionName());
  rmSync(dirname(dirs.dataDir), { recursive: true, force: true });
});

const fakeClaude = makeFakeClaude(dirs.tmp);

async function hook(actorId, event, sessionId, transcriptPath, extraEnv = {}) {
  const eventName = event === "prompt" ? "UserPromptSubmit" : event === "stop" ? "Stop" : "PostToolUse";
  const args = event === "post_tool_use" ? ["post_tool_use", "codex"] : [event];
  const result = await runNode(HOOK, args, {
    dataDir: dirs.dataDir,
    env: { HIVE_AGENT_ID: actorId, ...extraEnv },
    stdin: JSON.stringify({ hook_event_name: eventName, session_id: sessionId, transcript_path: transcriptPath, cwd: dirs.projectDir }),
  });
  assert.equal(result.code, 0, `hook ${event} must exit zero`);
  return result.stdout;
}

describe("fork restore idle remains latched across every idle reader", { skip: hasTmux ? false : "tmux is not installed" }, () => {
  it("fork restore Stop is not a finish in standing, one-shot or already-satisfied mode=all paths", async () => {
    await mcp.call("agent_spawn", { name: "fork-latch-source", command: fakeClaude() });
    const source = await liveAgentRow(mcp, "fork-latch-source");
    const sourceTranscript = join(dirs.tmp, "fork-latch-source.jsonl");
    writeFileSync(sourceTranscript, JSON.stringify({ session_id: source.session_id }) + "\n");
    db.prepare("UPDATE agents SET transcript_path = ? WHERE id = ?").run(sourceTranscript, source.agent_id);
    const standingId = seedStandingWatch(db, projectId, OWNER);

    const fork = await mcp.call("agent_fork", { agent_id: source.agent_id, name: "fork-latch-child" });
    const child = db.prepare("SELECT * FROM agents WHERE id = ?").get(fork.agent_id);
    assert.ok(child.resumed_at, "fork insertion must arm the first-assignment latch before its pane starts");
    const childTranscript = join(dirs.tmp, "fork-latch-child.jsonl");
    writeFileSync(childTranscript, JSON.stringify({ session_id: fork.session_id }) + "\n");

    const beforeReplay = db.prepare("SELECT agent_state, session_id, transcript_path, resumed_at FROM agents WHERE id = ?").get(child.id);
    const lastSeen = db.prepare("SELECT last_seen_at FROM actors WHERE id = ?").get(child.actor_id);
    await hook(child.actor_id, "prompt", fork.forked_from_session_id, sourceTranscript);
    await hook(child.actor_id, "stop", fork.forked_from_session_id, sourceTranscript);
    assert.deepEqual(db.prepare("SELECT agent_state, session_id, transcript_path, resumed_at FROM agents WHERE id = ?").get(child.id), beforeReplay);
    assert.deepEqual(db.prepare("SELECT last_seen_at FROM actors WHERE id = ?").get(child.actor_id), lastSeen);
    assert.deepEqual(db.prepare("SELECT event, state FROM agent_state_log WHERE actor_id = ? ORDER BY id").all(child.actor_id), []);

    await hook(child.actor_id, "stop", fork.session_id, childTranscript);
    const restored = db.prepare("SELECT agent_state, resumed_at FROM agents WHERE id = ?").get(child.id);
    assert.deepEqual(restored, { agent_state: "idle", resumed_at: child.resumed_at });
    assert.deepEqual(
      db.prepare("SELECT event, state FROM agent_state_log WHERE actor_id = ? ORDER BY id").all(child.actor_id),
      [{ event: "stop", state: "idle" }],
    );

    const oneShotId = db.prepare(
      `INSERT INTO wakes (project_id, owner, body, kind, watch, deliver_actor, deliver_pane, max_wait_at, created_at)
       VALUES (?, ?, 'fork idle', 'idle_any', ?, ?, '%deadlead', datetime('now', '+4 hours'), datetime('now', '-60 seconds'))
       RETURNING id`,
    ).get(projectId, OWNER, JSON.stringify([child.id]), OWNER).id;
    const snapshot = liveTargets();
    await tick(snapshot);
    assert.equal(db.prepare("SELECT held_at FROM wakes WHERE id = ?").get(oneShotId).held_at, null);
    assert.equal(reportedAsFinished(db, standingId, "fork-latch-child"), false);

    const allBeforeAssignment = await mcp.call("wake_when_idle", {
      agents: [child.id], mode: "all", body: "all workers are finished", deliver_to: "fork-latch-child",
    });
    assert.notEqual(allBeforeAssignment.status, "already_satisfied");
    if (allBeforeAssignment.wake_id) await mcp.call("wake_cancel", { wake_id: allBeforeAssignment.wake_id });

    await hook(child.actor_id, "prompt", fork.session_id, childTranscript);
    assert.equal(db.prepare("SELECT resumed_at FROM agents WHERE id = ?").get(child.id).resumed_at, "");
    await hook(child.actor_id, "stop", fork.session_id, childTranscript);
    await tick(liveTargets());
    assert.ok(db.prepare("SELECT held_at FROM wakes WHERE id = ?").get(oneShotId).held_at);
    assert.equal(reportedAsFinished(db, standingId, "fork-latch-child"), true);
    const allAfterAssignment = await mcp.call("wake_when_idle", {
      agents: [child.id], mode: "all", body: "all workers are finished", deliver_to: "fork-latch-child",
    });
    assert.equal(allAfterAssignment.status, "already_satisfied");
    assert.deepEqual(
      db.prepare("SELECT event, state FROM agent_state_log WHERE actor_id = ? ORDER BY id").all(child.actor_id),
      [{ event: "stop", state: "idle" }, { event: "prompt", state: "working" }, { event: "stop", state: "idle" }],
    );
  });
});

describe("fork hook ownership", () => {
  it("source-session replay cannot bind the child, clear its latch or fire a context checkpoint", async () => {
    const sourceSessionId = randomUUID();
    const childSessionId = randomUUID();
    const key = `hook-fork-${randomUUID()}`;
    const sessions = join(codexHomeDir(key), "sessions", "2026", "11", "01");
    mkdirSync(sessions, { recursive: true });
    const imported = join(sessions, `rollout-${sourceSessionId}.jsonl`);
    const childPath = join(sessions, `rollout-${childSessionId}.jsonl`);
    const usageRecord = {
      type: "event_msg",
      payload: { type: "token_count", info: { last_token_usage: { input_tokens: 90 }, model_context_window: 100 } },
    };
    writeFileSync(imported, JSON.stringify({ type: "session_meta", payload: { id: sourceSessionId } }) + "\n" + JSON.stringify(usageRecord) + "\n");
    writeFileSync(childPath,
      JSON.stringify({ type: "session_meta", payload: { id: childSessionId, forked_from_id: sourceSessionId } }) + "\n" +
      JSON.stringify(usageRecord) + "\n",
    );
    const actorId = `agent:fork-hook-${randomUUID()}`;
    db.prepare("INSERT INTO actors (id, name, kind, last_seen_at) VALUES (?, 'fork-hook-child', 'agent', '2000-01-01 00:00:00')").run(actorId);
    const rowId = db.prepare(
      `INSERT INTO agents (project_id, actor_id, name, tmux_target, command, cwd, kind, status, agent_state,
                           codex_home, session_id, transcript_path, resumed_at, forked_from_session_id)
       VALUES (?, ?, 'fork-hook-child', '%not-probed', 'codex', ?, 'agent', 'running', 'unknown', ?, ?, ?, 'pending', ?)
       RETURNING id`,
    ).get(projectId, actorId, dirs.projectDir, key, childSessionId, childPath, sourceSessionId).id;
    assert.equal(readContextFill("codex", { actor_id: actorId, cwd: dirs.projectDir, session_id: sourceSessionId, transcript_path: imported }).used_percent, 90);
    const before = db.prepare("SELECT agent_state, session_id, transcript_path, resumed_at FROM agents WHERE id = ?").get(rowId);
    const marker = join(dirs.dataDir, "context-checkpoints", `${encodeURIComponent(actorId)}.fired`);

    await hook(actorId, "prompt", sourceSessionId, imported);
    await hook(actorId, "stop", sourceSessionId, imported);
    await hook(actorId, "post_tool_use", sourceSessionId, imported, { HIVE_CONTEXT_CHECKPOINT_PERCENT: "50" });
    assert.deepEqual(db.prepare("SELECT agent_state, session_id, transcript_path, resumed_at FROM agents WHERE id = ?").get(rowId), before);
    assert.deepEqual(db.prepare("SELECT event, state FROM agent_state_log WHERE actor_id = ? ORDER BY id").all(actorId), []);
    assert.equal(existsSync(marker), false, "a source replay with a qualifying usage record must not set the child's checkpoint marker");

    await hook(actorId, "prompt", childSessionId, childPath);
    assert.equal(db.prepare("SELECT resumed_at FROM agents WHERE id = ?").get(rowId).resumed_at, "");
    await hook(actorId, "post_tool_use", childSessionId, childPath, { HIVE_CONTEXT_CHECKPOINT_PERCENT: "50" });
    assert.equal(existsSync(marker), true, "the certified child rollout remains an accepted hook source");
    assert.deepEqual(
      db.prepare("SELECT event, state FROM agent_state_log WHERE actor_id = ? ORDER BY id").all(actorId),
      [{ event: "prompt", state: "working" }],
    );
  });
});
