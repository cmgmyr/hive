import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import { DIST, assertScratchStore, clearHiveEnv, isolateTmux, runNode, scratchDirs } from "./helpers.mjs";

// Issue #154, D1: src/hook.ts parses session_id off every payload and
// reconciles the row -- the hook is the authority, which is what makes
// agent_spawn's --session-id flag non-load-bearing rather than redundant.
//
// Every seeded row below starts at a session_id DIFFERENT from the one the
// payload carries (.claude/sessions/dead-ends/2026-07-29-seeding-a-test-row-
// with-the-value-it-asserts.md): a row already seeded with the asserted
// value would pass against a hook that does nothing at all.
isolateTmux("the hook session-id reconcile tests");
const { dataDir } = scratchDirs();

clearHiveEnv();
process.env.HIVE_DATA_DIR = dataDir;
await assertScratchStore();

const { db, migrate } = await import("../dist/db.js");
migrate();

const HOOK = join(DIST, "hook.js");

const project = db
  .prepare("INSERT INTO projects (name, path) VALUES (?, ?) RETURNING id")
  .get("hook-session-reconcile", dataDir).id;

function agentRow(kind, actorId, seededSessionId) {
  return db
    .prepare(
      `INSERT INTO agents (project_id, actor_id, name, tmux_target, command, cwd, status, kind, session_id)
       VALUES (?, ?, ?, '%9600', 'claude', '/tmp', 'running', ?, ?) RETURNING id`,
    )
    .get(project, actorId, actorId, kind, seededSessionId).id;
}

const sessionIdOf = (actorId) =>
  db.prepare("SELECT session_id FROM agents WHERE actor_id = ?").get(actorId).session_id;

async function runHook(event, payload, actorId) {
  const { code } = await runNode(HOOK, [event], {
    dataDir,
    env: { HIVE_AGENT_ID: actorId },
    stdin: JSON.stringify(payload),
  });
  assert.equal(code, 0, `hook must always exit 0, actor ${actorId}`);
}

describe("dist/hook.js reconciles agents.session_id from the hook payload", () => {
  it("corrects a row whose recorded session_id disagrees with the payload's -- the hook wins (D1)", async () => {
    const actorId = "agent:reconcile-mismatch";
    agentRow("agent", actorId, "seeded-stale-id");

    await runHook("prompt", { hook_event_name: "UserPromptSubmit", session_id: "payload-real-id" }, actorId);

    assert.equal(sessionIdOf(actorId), "payload-real-id");
  });

  it("leaves the row alone when the payload carries no session_id at all", async () => {
    const actorId = "agent:reconcile-no-payload-id";
    agentRow("agent", actorId, "seeded-unchanged");

    await runHook("stop", { hook_event_name: "Stop", background_tasks: [] }, actorId);

    assert.equal(sessionIdOf(actorId), "seeded-unchanged");
  });

  it("reconciles on every event, not only the ones stateFor reads a payload for", async () => {
    const actorId = "agent:reconcile-notify";
    agentRow("agent", actorId, "seeded-before-notify");

    await runHook(
      "notify",
      { hook_event_name: "Notification", message: "Claude needs your permission", session_id: "payload-notify-id" },
      actorId,
    );

    assert.equal(sessionIdOf(actorId), "payload-notify-id");
  });

  it("never writes a lead row's session_id -- scoped to kind='agent', the same allowlist the state write uses", async () => {
    const actorId = "lead:reconcile-1";
    agentRow("lead", actorId, "seeded-lead-id");

    await runHook("prompt", { hook_event_name: "UserPromptSubmit", session_id: "payload-lead-id" }, actorId);

    assert.equal(sessionIdOf(actorId), "seeded-lead-id", "a lead row's session_id must stay untouched by the hook");
  });
});
