import assert from "node:assert/strict";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { isolateTmux, liveAgentRow, makeFakeClaude, McpClient, scratchDirs } from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("the agent_status context_tokens tests");

const dirs = scratchDirs();

process.env.HIVE_DATA_DIR = dirs.dataDir;
const { sessionName } = await import("../dist/tmux.js");
const { transcriptDirName } = await import("../dist/transcript.js");

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

    const after = await mcp.call("agent_status", { name: "claude-usage" });
    assert.equal(after.context_tokens, 1234);

    await mcp.call("agent_close", { name: "claude-usage" });
  });

  it("omits the key entirely for a non-claude worker (D4, matching transcript_dir and session_id)", async () => {
    await mcp.call("agent_spawn", { name: "plain-tokens", command: "sleep", extra_args: ["600"] });
    await liveAgentRow(mcp, "plain-tokens");

    const out = await mcp.call("agent_status", { name: "plain-tokens" });
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
