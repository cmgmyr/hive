import assert from "node:assert/strict";
import { after, before, it } from "node:test";
import { isolateTmux, McpClient, scratchDirs } from "./helpers.mjs";

const { cleanup: cleanupTmux } = isolateTmux("the tool-annotations tests");
after(() => cleanupTmux());

const dirs = scratchDirs();
let mcp;

before(async () => {
  mcp = new McpClient({ cwd: dirs.projectDir, dataDir: dirs.dataDir });
  await mcp.start();
});

after(async () => {
  await mcp.close();
});

it("every listed tool declares all four boolean MCP hints and stays closed-world", async () => {
  const listed = await mcp.request("tools/list", {});
  const tools = listed.result.tools;
  const hintNames = ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"];

  assert.ok(tools.length > 0, "tools/list returned no tools");
  assert.equal(listed.result.nextCursor, undefined, "tools/list is paginating; this test only checked page one");
  for (const tool of tools) {
    assert.ok(tool.annotations && typeof tool.annotations === "object", `${tool.name} has no annotations object`);
    assert.deepEqual(
      Object.keys(tool.annotations).sort(),
      [...hintNames].sort(),
      `${tool.name} must declare exactly the four supported hints`,
    );
    for (const hint of hintNames) {
      assert.equal(typeof tool.annotations[hint], "boolean", `${tool.name}.${hint} must be a boolean`);
    }
    assert.equal(tool.annotations.openWorldHint, false, `${tool.name} must not claim an open-world effect`);
  }
});
