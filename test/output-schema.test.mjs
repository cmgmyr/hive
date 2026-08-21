import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { isolateTmux, McpClient, scratchDirs } from "./helpers.mjs";

const { cleanup: cleanupTmux } = isolateTmux("the output-schema tests");
after(() => cleanupTmux());

const EXPECTED_OUTPUT_SCHEMA_TOOLS = [
  "actor_prune",
  "agent_close",
  "agent_park",
  "agent_rename",
  "agent_resume",
  "agent_spawn",
  "kv_delete",
  "kv_set",
  "lease_acquire",
  "lease_release",
  "pad_append",
  "pad_archive",
  "pad_delete",
  "pad_edit",
  "pad_write",
  "project_add",
  "project_prune",
  "todo_archive",
  "todo_block",
  "todo_comment",
  "todo_complete",
  "todo_create",
  "todo_unblock",
  "todo_update",
  "wake_cancel",
  "wake_set",
  "wake_update",
  "wake_when_idle",
];

const dirs = scratchDirs();
let mcp;

before(async () => {
  mcp = new McpClient({ cwd: dirs.projectDir, dataDir: dirs.dataDir });
  await mcp.start();
});

after(async () => {
  await mcp.close();
});

describe("outputSchema on write tools", () => {
  it("advertises outputSchema on exactly the write tools, and no others", async () => {
    const listed = await mcp.request("tools/list", {});
    const withSchema = listed.result.tools.filter((t) => t.outputSchema).map((t) => t.name).sort();
    assert.deepEqual(withSchema, [...EXPECTED_OUTPUT_SCHEMA_TOOLS].sort());
  });

  it("a call to a tool with outputSchema returns structuredContent matching the text content", async () => {
    const resp = await mcp.request("tools/call", {
      name: "pad_write",
      arguments: { name: "output-schema-probe", content: "hi" },
    });
    assert.equal(resp.result.isError, undefined);
    assert.ok(resp.result.structuredContent, "expected structuredContent alongside text content");
    assert.deepEqual(resp.result.structuredContent, JSON.parse(resp.result.content[0].text));
  });

  it("a tool with no outputSchema never carries structuredContent, however large its payload", async () => {
    const big = await mcp.call("pad_write", { name: "no-schema-payload-probe", content: "x".repeat(29_880) });
    const resp = await mcp.request("tools/call", { name: "pad_read", arguments: { pad_id: big.pad_id } });
    assert.equal(resp.result.isError, undefined);
    assert.equal(
      resp.result.structuredContent,
      undefined,
      "pad_read declares no outputSchema; a duplicate structuredContent copy would double the wire bytes " +
        "of the single most-read tool call in this project for no validation benefit",
    );
  });

  it("an error result from a tool with outputSchema carries no structuredContent, and does not throw output validation", async () => {
    const resp = await mcp.request("tools/call", { name: "pad_archive", arguments: { pad_id: 999999999 } });
    assert.equal(resp.result.isError, true);
    assert.equal(resp.result.structuredContent, undefined);
  });

  it("a variant-shaped write tool (lease_acquire) validates every branch it can return without tmux", async () => {
    const fresh = await mcp.request("tools/call", {
      name: "lease_acquire",
      arguments: { key: "output-schema-lease", ttl_seconds: 60 },
    });
    assert.equal(fresh.result.isError, undefined);
    assert.deepEqual(fresh.result.structuredContent, { project_id: 1, key: "output-schema-lease", acquired: true, expires_at: fresh.result.structuredContent.expires_at });

    const extended = await mcp.request("tools/call", {
      name: "lease_acquire",
      arguments: { key: "output-schema-lease", ttl_seconds: 60 },
    });
    assert.equal(extended.result.isError, undefined);
    assert.deepEqual(extended.result.structuredContent, { project_id: 1, key: "output-schema-lease", acquired: true, extended: true });

    await mcp.call("lease_release", { key: "output-schema-lease" });
  });
});
