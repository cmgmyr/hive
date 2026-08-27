import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import { DIST, assertScratchStore, clearHiveEnv, isolateTmux, runNode, scratchDirs } from "./helpers.mjs";

isolateTmux("the hook transcript-path reconcile tests");
const { dataDir } = scratchDirs();

clearHiveEnv();
process.env.HIVE_DATA_DIR = dataDir;
await assertScratchStore();

const { db, migrate } = await import("../dist/db.js");
migrate();

const HOOK = join(DIST, "hook.js");

const project = db
  .prepare("INSERT INTO projects (name, path) VALUES (?, ?) RETURNING id")
  .get("hook-transcript-path-reconcile", dataDir).id;

function agentRow(kind, actorId, command, seededPath) {
  return db
    .prepare(
      `INSERT INTO agents (project_id, actor_id, name, tmux_target, command, cwd, status, kind, transcript_path)
       VALUES (?, ?, ?, '%9600', ?, '/tmp', 'running', ?, ?) RETURNING id`,
    )
    .get(project, actorId, actorId, command, kind, seededPath).id;
}

const transcriptPathOf = (actorId) =>
  db.prepare("SELECT transcript_path FROM agents WHERE actor_id = ?").get(actorId).transcript_path;

async function runHook(event, payload, actorId) {
  const { code } = await runNode(HOOK, [event], {
    dataDir,
    env: { HIVE_AGENT_ID: actorId },
    stdin: JSON.stringify(payload),
  });
  assert.equal(code, 0, `hook must always exit 0, actor ${actorId}`);
}

describe("dist/hook.js reconciles agents.transcript_path from the hook payload", () => {
  it("stores the exact rollout file a codex payload names, unresolved and unmodified", async () => {
    const actorId = "agent:codex-transcript";
    agentRow("agent", actorId, "codex", "");

    await runHook(
      "stop",
      {
        hook_event_name: "Stop",
        session_id: "sess-1",
        transcript_path: "/Users/worker/.codex-home/sessions/2026/08/26/rollout-1-sess-1.jsonl",
      },
      actorId,
    );

    assert.equal(
      transcriptPathOf(actorId),
      "/Users/worker/.codex-home/sessions/2026/08/26/rollout-1-sess-1.jsonl",
    );
  });

  it("corrects a row whose recorded transcript_path disagrees with the payload's -- the hook wins", async () => {
    const actorId = "agent:codex-transcript-mismatch";
    agentRow("agent", actorId, "codex", "/stale/path.jsonl");

    await runHook("stop", { hook_event_name: "Stop", transcript_path: "/fresh/path.jsonl" }, actorId);

    assert.equal(transcriptPathOf(actorId), "/fresh/path.jsonl");
  });

  it("leaves the row alone when the payload carries no transcript_path at all", async () => {
    const actorId = "agent:codex-transcript-no-payload";
    agentRow("agent", actorId, "codex", "seeded-unchanged.jsonl");

    await runHook("stop", { hook_event_name: "Stop", background_tasks: [] }, actorId);

    assert.equal(transcriptPathOf(actorId), "seeded-unchanged.jsonl");
  });

  it("also reconciles a claude row's transcript_path, since claude's own payload carries it too", async () => {
    const actorId = "agent:claude-transcript";
    agentRow("agent", actorId, "claude", "");

    await runHook(
      "stop",
      { hook_event_name: "Stop", background_tasks: [], transcript_path: "/Users/worker/.claude/sess.jsonl" },
      actorId,
    );

    assert.equal(transcriptPathOf(actorId), "/Users/worker/.claude/sess.jsonl");
  });

  it("never writes a lead row's transcript_path -- scoped to kind='agent', the same allowlist the state write uses", async () => {
    const actorId = "lead:codex-transcript-1";
    agentRow("lead", actorId, "codex", "seeded-lead-path.jsonl");

    await runHook("stop", { hook_event_name: "Stop", transcript_path: "/payload/lead-path.jsonl" }, actorId);

    assert.equal(
      transcriptPathOf(actorId),
      "seeded-lead-path.jsonl",
      "a lead row's transcript_path must stay untouched by the hook",
    );
  });
});
