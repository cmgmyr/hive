import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, it } from "node:test";
import { startMcpClient } from "./mcp-client.mjs";

const dir = mkdtempSync(join(tmpdir(), "hive-mcp-client-"));
after(() => rmSync(dir, { recursive: true, force: true }));

function server(source, name) {
  const path = join(dir, name);
  writeFileSync(path, source);
  return path;
}

it("the shared MCP client does not inherit a parent HIVE_DATA_DIR", async () => {
  const path = server(
    `require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {\n` +
      `  const request = JSON.parse(line);\n` +
      `  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: process.env.HIVE_DATA_DIR ?? null }) + '\\n');\n` +
      `});\n`,
    "env-probe.cjs",
  );
  const previous = process.env.HIVE_DATA_DIR;
  process.env.HIVE_DATA_DIR = "parent-store-must-not-flow";
  const client = startMcpClient(process.execPath, [path], { env: {} });
  try {
    const response = await client.request("read-env");
    assert.equal(response.result, null);
  } finally {
    await client.close();
    if (previous === undefined) delete process.env.HIVE_DATA_DIR;
    else process.env.HIVE_DATA_DIR = previous;
  }
});

it("a response to another id does not resolve a pending request", async () => {
  const path = server(
    `require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {\n` +
      `  const request = JSON.parse(line);\n` +
      `  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id + 1, result: 'wrong' }) + '\\n');\n` +
      `  setTimeout(() => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: 'matched' }) + '\\n'), 20);\n` +
      `});\n`,
    "wrong-id.cjs",
  );
  const client = startMcpClient(process.execPath, [path], { env: {}, timeoutMs: 500 });
  try {
    const response = await client.request("match-id");
    assert.equal(response.id, 1);
    assert.equal(response.result, "matched");
  } finally {
    await client.close();
  }
});
