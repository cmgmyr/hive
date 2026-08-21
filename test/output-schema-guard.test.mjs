import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { DIST, REPO } from "./helpers.mjs";

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

function driveOneCall(scriptPath, toolName) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath], { cwd: REPO, stdio: ["pipe", "pipe", "inherit"] });
    let buf = "";
    const responses = [];
    child.stdout.on("data", (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line.trim()) {
          try {
            responses.push(JSON.parse(line));
          } catch {
            /* ignore non-JSON stdout noise */
          }
        }
      }
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("timed out waiting for the fixture server"));
    }, 8000);
    function send(msg) {
      child.stdin.write(`${JSON.stringify(msg)}\n`);
    }
    function waitFor(id) {
      return new Promise((res) => {
        const check = () => {
          const found = responses.find((r) => r.id === id);
          if (found) return res(found);
          setTimeout(check, 20);
        };
        check();
      });
    }
    (async () => {
      send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "guard-test", version: "0" } },
      });
      await waitFor(1);
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: toolName, arguments: {} } });
      const result = await waitFor(2);
      clearTimeout(timer);
      child.kill();
      resolve(result);
    })().catch(reject);
  });
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
