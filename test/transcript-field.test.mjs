import assert from "node:assert/strict";
import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { isolateTmux, liveAgentRow, makeFakeClaude, McpClient, scratchDirs } from "./helpers.mjs";

// Issue #5, todo 90: agent_status and agent_list wiring for the transcript
// directory. Pure encoding and existence gating are pinned in
// transcript.test.mjs with no server involved; this file pins the policy
// choices layered on top -- D2 (agent_status always reports it for a claude
// worker), D3 (agent_list only for a row that is not confirmed alive), and D4
// (never for a non-claude command) -- against the real tools.
const { hasTmux, cleanup } = isolateTmux("the transcript field tests");

const dirs = scratchDirs();
// sessionName tags itself from HIVE_DATA_DIR, so the test process has to
// resolve the same store the server does to name the session cleanup targets.
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { sessionName } = await import("../dist/tmux.js");
const { transcriptDirName } = await import("../dist/transcript.js");

// A private CLAUDE_CONFIG_DIR for this file, so the assertions below do not
// depend on (or risk misreading) whatever the real ~/.claude/projects holds.
const claudeConfigDir = join(dirs.tmp, "claude-config");
mkdirSync(join(claudeConfigDir, "projects"), { recursive: true });

// One real directory a worker can be spawned into, with its transcript
// directory pre-created under the scratch config dir, so the "found it" path
// is tested against an actual resolved value, not just presence of the key.
const seededCwdPath = join(dirs.tmp, "seeded-cwd");
mkdirSync(seededCwdPath, { recursive: true });
const seededCwd = realpathSync(seededCwdPath);
const seededTranscriptDir = join(claudeConfigDir, "projects", transcriptDirName(seededCwd));
mkdirSync(seededTranscriptDir, { recursive: true });

let mcp;
let projectId;

before(async () => {
  mcp = new McpClient({
    cwd: dirs.projectDir,
    dataDir: dirs.dataDir,
    env: { CLAUDE_CONFIG_DIR: claudeConfigDir, HIVE_SPAWN_READY_MS: "1" },
  });
  await mcp.start();
  projectId = (await mcp.call("whoami")).project.id;
});

after(async () => {
  await mcp.close();
  cleanup(sessionName(projectId));
});

const fakeClaude = makeFakeClaude(dirs.tmp);

describe("transcript_dir on agent_status and agent_list", { skip: hasTmux ? false : "tmux is not installed" }, () => {
  it("agent_status always reports it for a claude worker, null when nothing is there (D2)", async () => {
    await mcp.call("agent_spawn", { name: "claude-bare", command: fakeClaude() });
    await liveAgentRow(mcp, "claude-bare");

    const out = await mcp.call("agent_status", { name: "claude-bare" });
    assert.ok("transcript_dir" in out, "the key must be present even though the worker is alive");
    assert.equal(out.transcript_dir, null, "nothing was ever written for this cwd");

    await mcp.call("agent_close", { name: "claude-bare" });
  });

  it("agent_status resolves a real transcript directory when one exists on disk", async () => {
    await mcp.call("agent_spawn", { name: "claude-seeded", command: fakeClaude(), cwd: seededCwd });
    await liveAgentRow(mcp, "claude-seeded");

    const out = await mcp.call("agent_status", { name: "claude-seeded" });
    assert.equal(out.transcript_dir, seededTranscriptDir);

    await mcp.call("agent_close", { name: "claude-seeded" });
  });

  it("agent_status omits the key entirely for a non-claude worker (D4)", async () => {
    await mcp.call("agent_spawn", { name: "plain-status", command: "sleep", extra_args: ["600"] });
    await liveAgentRow(mcp, "plain-status");

    const out = await mcp.call("agent_status", { name: "plain-status" });
    assert.ok(!("transcript_dir" in out), `should have no transcript_dir: ${JSON.stringify(out)}`);

    await mcp.call("agent_close", { name: "plain-status" });
  });

  it("agent_list omits the key for a live claude worker, even one with a real directory (D3)", async () => {
    await mcp.call("agent_spawn", { name: "claude-live", command: fakeClaude(), cwd: seededCwd });
    await liveAgentRow(mcp, "claude-live");

    const row = (await mcp.call("agent_list")).agents.find((a) => a.name === "claude-live");
    assert.ok(row?.alive);
    assert.ok(!("transcript_dir" in row), `a live worker's row should stay slim: ${JSON.stringify(row)}`);

    await mcp.call("agent_close", { name: "claude-live" });
  });

  it("agent_list reports it once the row is closed, and omits it for a non-claude row (D3 + D4)", async () => {
    await mcp.call("agent_spawn", { name: "claude-closes", command: fakeClaude(), cwd: seededCwd });
    await liveAgentRow(mcp, "claude-closes");
    await mcp.call("agent_close", { name: "claude-closes" });

    await mcp.call("agent_spawn", { name: "plain-closes", command: "sleep", extra_args: ["600"] });
    await liveAgentRow(mcp, "plain-closes");
    await mcp.call("agent_close", { name: "plain-closes" });

    const out = await mcp.call("agent_list", { include_closed: true });

    const claudeRow = out.agents.find((a) => a.name === "claude-closes");
    assert.ok(claudeRow, "closed claude worker should still be listed");
    assert.equal(claudeRow.transcript_dir, seededTranscriptDir);

    const plainRow = out.agents.find((a) => a.name === "plain-closes");
    assert.ok(plainRow, "closed non-claude worker should still be listed");
    assert.ok(!("transcript_dir" in plainRow), `non-claude row should never get one: ${JSON.stringify(plainRow)}`);
  });
});
