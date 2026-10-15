import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { DIST, REPO } from "./helpers.mjs";
import { startMcpClient } from "./mcp-client.mjs";

// Written under the project tree, not os.tmpdir(): bare specifiers ("@modelcontextprotocol/sdk", "zod")
// only resolve from inside REPO's node_modules.
const FIXTURE_DIR = mkdtempSync(join(REPO, "test", ".fixture-"));
const FIXTURE_PATH = join(FIXTURE_DIR, "broken-tool-server.mjs");

writeFileSync(
  FIXTURE_PATH,
  `import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { enforceStrictInput } from ${JSON.stringify(join(DIST, "strictInput.js"))};

const server = enforceStrictInput(new McpServer({ name: "broken-tool-probe", version: "0" }, {}));

server.registerTool(
  "returns_bare_string",
  { description: "deliberately violates its own outputSchema", inputSchema: {}, outputSchema: { y: z.number() } },
  () => ({ content: [{ type: "text", text: "not json" }] }),
);

await server.connect(new StdioServerTransport());
`,
);

after(() => rmSync(FIXTURE_DIR, { recursive: true, force: true }));

async function driveOneCall(scriptPath, toolName) {
  const client = startMcpClient(process.execPath, [scriptPath], {
    cwd: REPO,
    env: process.env,
    timeoutMs: 8000,
    clientInfo: { name: "guard-test", version: "0" },
  });
  try {
    await client.start();
    return await client.request("tools/call", { name: toolName, arguments: {} });
  } finally {
    await client.close();
  }
}

describe("the outputSchema wrapper fails loudly, not silently, on a bad handler", () => {
  it("a tool declaring outputSchema whose handler returns non-JSON content fails with a named, diagnosable error, not the SDK's generic one", async () => {
    const response = await driveOneCall(FIXTURE_PATH, "returns_bare_string");
    assert.equal(response.result.isError, true);
    assert.match(
      response.result.content[0].text,
      /tool "returns_bare_string" declares outputSchema but its result was not a JSON object/,
      "the SDK's own message here is 'no structured content was provided', which names no tool and no " +
        "cause - this proves src/strictInput.ts's own fail-closed branch fired, not the SDK's",
    );
  });
});
