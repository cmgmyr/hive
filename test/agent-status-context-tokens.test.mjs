import assert from "node:assert/strict";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { isolateTmux, liveAgentRow, makeFakeClaude, McpClient, scratchDirs } from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("the agent_status context_tokens tests");

const dirs = scratchDirs();

process.env.HIVE_DATA_DIR = dirs.dataDir;
const { sessionName } = await import("../dist/tmux.js");
const { transcriptDirName, claudeWindowPath } = await import("../dist/transcript.js");

const claudeConfigDir = join(dirs.tmp, "claude-config");
mkdirSync(join(claudeConfigDir, "projects"), { recursive: true });

const seededCwdPath = join(dirs.tmp, "seeded-cwd");
mkdirSync(seededCwdPath, { recursive: true });
const seededCwd = realpathSync(seededCwdPath);
const seededTranscriptDir = join(claudeConfigDir, "projects", transcriptDirName(seededCwd));
mkdirSync(seededTranscriptDir, { recursive: true });

let mcp;

before(async () => {
  mcp = new McpClient({
    cwd: dirs.projectDir,
    dataDir: dirs.dataDir,
    env: { CLAUDE_CONFIG_DIR: claudeConfigDir, HIVE_SPAWN_READY_MS: "1" },
  });
  await mcp.start();
});

after(async () => {
  await mcp.close();
  cleanup(sessionName());
});

const fakeClaude = makeFakeClaude(dirs.tmp);

function assistantUsageLine(sum) {
  return JSON.stringify({
    type: "assistant",
    message: { role: "assistant", usage: { input_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: sum - 2, output_tokens: 40 } },
  });
}

describe("context_tokens on agent_status", { skip: hasTmux ? false : "tmux is not installed" }, () => {
  it("is null for a claude worker before anything has been written to its transcript", async () => {
    await mcp.call("agent_spawn", { name: "claude-fresh", command: fakeClaude(), cwd: seededCwd });
    await liveAgentRow(mcp, "claude-fresh");

    const out = await mcp.call("agent_status", { name: "claude-fresh" });
    assert.ok("context_tokens" in out, "the key must be present even when null");
    assert.equal(out.context_tokens, null);
    assert.equal(out.context_fill, null);
    const listed = (await mcp.call("agent_list", {})).agents.find((row) => row.name === "claude-fresh");
    assert.equal(listed.context_fill, null);

    await mcp.call("agent_close", { name: "claude-fresh" });
  });

  it("reads the sum from the worker's own real transcript file, keyed by its session_id", async () => {
    await mcp.call("agent_spawn", { name: "claude-usage", command: fakeClaude(), cwd: seededCwd });
    await liveAgentRow(mcp, "claude-usage");

    const before = await mcp.call("agent_status", { name: "claude-usage" });
    assert.ok(before.session_id, "session_id must already be on the row");

    writeFileSync(
      join(seededTranscriptDir, `${before.session_id}.jsonl`),
      [assistantUsageLine(1234), JSON.stringify({ type: "user", message: { role: "user", content: "go" } })].join("\n") + "\n",
    );

    mkdirSync(join(dirs.dataDir, "context-windows"), { recursive: true });
    writeFileSync(claudeWindowPath(before.actor_id), "1000000\n");
    const after = await mcp.call("agent_status", { name: "claude-usage" });
    assert.equal(after.context_tokens, 1234);
    assert.deepEqual(after.context_fill, { used_tokens: 1234, window_tokens: 1000000, used_percent: 0 });
    const listed = (await mcp.call("agent_list", {})).agents.find((row) => row.name === "claude-usage");
    assert.deepEqual(listed.context_fill, after.context_fill);

    await mcp.call("agent_close", { name: "claude-usage" });
  });

  it("retains Claude context_tokens from a transcript before any window record exists", async () => {
    await mcp.call("agent_spawn", { name: "claude-no-window", command: fakeClaude(), cwd: seededCwd });
    await liveAgentRow(mcp, "claude-no-window");
    const before = await mcp.call("agent_status", { name: "claude-no-window" });
    writeFileSync(join(seededTranscriptDir, `${before.session_id}.jsonl`), assistantUsageLine(242365) + "\n");
    const after = await mcp.call("agent_status", { name: "claude-no-window" });
    assert.equal(after.context_tokens, 242365);
    assert.equal(after.context_fill, null);
    await mcp.call("agent_close", { name: "claude-no-window" });
  });

  it("omits the key entirely for a non-claude worker (D4, matching transcript_dir and session_id)", async () => {
    await mcp.call("agent_spawn", { name: "plain-tokens", command: "sleep", extra_args: ["600"] });
    await liveAgentRow(mcp, "plain-tokens");

    const out = await mcp.call("agent_status", { name: "plain-tokens" });
    assert.ok(!("context_fill" in out));
    const listed = (await mcp.call("agent_list", {})).agents.find((row) => row.name === "plain-tokens");
    assert.ok(!("context_fill" in listed));
    assert.ok(!("context_tokens" in out), `should have no context_tokens: ${JSON.stringify(out)}`);

    await mcp.call("agent_close", { name: "plain-tokens" });
  });
});

describe("permission_mode's reportsAgentStateLog gate on agent_status", { skip: hasTmux ? false : "tmux is not installed" }, () => {
  it("is present (even if still null) for a claude worker and absent entirely for a non-claude one", async () => {
    await mcp.call("agent_spawn", { name: "claude-mode", command: fakeClaude(), cwd: seededCwd });
    await liveAgentRow(mcp, "claude-mode");
    const claudeOut = await mcp.call("agent_status", { name: "claude-mode" });
    assert.ok("permission_mode" in claudeOut, "the key must be present even before any hook has fired");
    await mcp.call("agent_close", { name: "claude-mode" });

    await mcp.call("agent_spawn", { name: "plain-mode", command: "sleep", extra_args: ["600"] });
    await liveAgentRow(mcp, "plain-mode");
    const plainOut = await mcp.call("agent_status", { name: "plain-mode" });
    assert.ok(!("permission_mode" in plainOut), `should have no permission_mode: ${JSON.stringify(plainOut)}`);
    await mcp.call("agent_close", { name: "plain-mode" });
  });
});


describe("Codex context_fill on both public read surfaces", () => {
  it("reads the worker rollout's latest input count and inline window with large cached and cumulative usage", async () => {
    const { db, migrate } = await import("../dist/db.js");
    migrate();
    const project = db.prepare("SELECT id FROM projects WHERE path = ?").get(realpathSync(dirs.projectDir));
    const path = join(dirs.tmp, "rollout.jsonl");
    const row = db.prepare(`INSERT INTO agents (project_id, actor_id, name, command, cwd, kind, status, session_id, transcript_path)
      VALUES (?, 'agent:codex-fill', 'codex-fill', 'codex', ?, 'agent', 'closed', 'codex-session', ?) RETURNING id`)
      .get(project.id, dirs.projectDir, path);
    const empty = await mcp.call("agent_status", { agent_id: row.id });
    assert.equal(empty.context_fill, null);
    assert.equal("context_tokens" in empty, false);
    writeFileSync(path, [100, 240141].map((input) => JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: {
      last_token_usage: { input_tokens: input, cached_input_tokens: input - 1, output_tokens: 5000 },
      total_token_usage: { input_tokens: 41000000, total_tokens: 42000000 }, model_context_window: 828400,
    } } })).join("\n") + "\n");
    const status = await mcp.call("agent_status", { agent_id: row.id });
    assert.deepEqual(status.context_fill, { used_tokens: 240141, window_tokens: 828400, used_percent: 29 });
    const listed = (await mcp.call("agent_list", { include_closed: true })).agents.find((agent) => agent.agent_id === row.id);
    assert.deepEqual(listed.context_fill, status.context_fill);
  });
});
