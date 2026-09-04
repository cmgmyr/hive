import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { isolateTmux, liveAgentRow, makeFakeClaude, McpClient, scratchDirs } from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("the session_id field tests");

const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { sessionName } = await import("../dist/tmux.js");

let mcp;

before(async () => {
  mcp = new McpClient({
    cwd: dirs.projectDir,
    dataDir: dirs.dataDir,
    env: { HIVE_SPAWN_READY_MS: "1" },
  });
  await mcp.start();
});

after(async () => {
  await mcp.close();
  cleanup(sessionName());
});

const fakeClaude = makeFakeClaude(dirs.tmp);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("session_id on agent_status and agent_list", { skip: hasTmux ? false : "tmux is not installed" }, () => {
  it("agent_spawn generates one for a claude worker; agent_status reports the same value (D1/D2)", async () => {
    await mcp.call("agent_spawn", { name: "session-claude", command: fakeClaude() });
    await liveAgentRow(mcp, "session-claude");

    const out = await mcp.call("agent_status", { name: "session-claude" });
    assert.ok("session_id" in out, "the key must be present even though the worker is alive");
    assert.match(out.session_id, UUID_RE, `should be a generated UUID: ${out.session_id}`);

    const again = await mcp.call("agent_status", { name: "session-claude" });
    assert.equal(again.session_id, out.session_id);

    await mcp.call("agent_close", { name: "session-claude" });
  });

  it("agent_status omits the key entirely for a non-claude worker (D4)", async () => {
    await mcp.call("agent_spawn", { name: "session-plain", command: "sleep", extra_args: ["600"] });
    await liveAgentRow(mcp, "session-plain");

    const out = await mcp.call("agent_status", { name: "session-plain" });
    assert.ok(!("session_id" in out), `should have no session_id: ${JSON.stringify(out)}`);

    await mcp.call("agent_close", { name: "session-plain" });
  });

  it("agent_list omits the key for a live claude worker, matching transcript_dir's own D3 gating", async () => {
    await mcp.call("agent_spawn", { name: "session-live", command: fakeClaude() });
    await liveAgentRow(mcp, "session-live");

    const row = (await mcp.call("agent_list")).agents.find((a) => a.name === "session-live");
    assert.ok(row?.alive);
    assert.ok(!("session_id" in row), `a live worker's row should stay slim: ${JSON.stringify(row)}`);

    await mcp.call("agent_close", { name: "session-live" });
  });

  it("agent_list reports it once the row is closed, and omits it for a non-claude row (D3 + D4)", async () => {
    await mcp.call("agent_spawn", { name: "session-closes", command: fakeClaude() });
    await liveAgentRow(mcp, "session-closes");

    const whileLive = await mcp.call("agent_status", { name: "session-closes" });
    await mcp.call("agent_close", { name: "session-closes" });

    await mcp.call("agent_spawn", { name: "plain-closes", command: "sleep", extra_args: ["600"] });
    await liveAgentRow(mcp, "plain-closes");
    await mcp.call("agent_close", { name: "plain-closes" });

    const out = await mcp.call("agent_list", { include_closed: true });

    const claudeRow = out.agents.find((a) => a.name === "session-closes");
    assert.ok(claudeRow, "closed claude worker should still be listed");
    assert.match(claudeRow.session_id, UUID_RE);

    assert.equal(claudeRow.session_id, whileLive.session_id);

    const plainRow = out.agents.find((a) => a.name === "plain-closes");
    assert.ok(plainRow, "closed non-claude worker should still be listed");
    assert.ok(!("session_id" in plainRow), `non-claude row should never get one: ${JSON.stringify(plainRow)}`);
  });

  it("skips the auto --session-id when extra_args already requests --resume", async () => {

    await mcp.call("agent_spawn", {
      name: "session-manual-resume",
      command: fakeClaude(),
      extra_args: ["--resume", "some-prior-session-id"],
    });
    await liveAgentRow(mcp, "session-manual-resume");

    const out = await mcp.call("agent_status", { name: "session-manual-resume" });
    assert.ok(!out.command.includes("--session-id"), `should not inject --session-id: ${out.command}`);
    assert.ok(out.command.includes("--resume some-prior-session-id"), `should keep the caller's --resume: ${out.command}`);

    assert.equal(out.session_id, null);

    await mcp.call("agent_close", { name: "session-manual-resume" });
  });
});
