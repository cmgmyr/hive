import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import { McpClient, isolateTmux, scratchDirs } from "./helpers.mjs";

const { cleanup: cleanupTmux } = isolateTmux("the MCP prompt registration tests");
after(() => cleanupTmux());

async function server(fn) {
  const dirs = scratchDirs();
  const mcp = new McpClient({ cwd: dirs.projectDir, dataDir: dirs.dataDir });
  await mcp.start();
  try {
    return await fn(mcp);
  } finally {
    await mcp.close();
  }
}

describe("the MCP prompt set (todo 748)", () => {
  it("registers exactly one prompt, pointing at `hive runbook` rather than restating a process hive does not own", async () => {
    const { list, get } = await server(async (mcp) => ({
      list: await mcp.request("prompts/list", {}),
      get: await mcp.request("prompts/get", { name: "runbook" }),
    }));

    assert.ok(!list.error, JSON.stringify(list.error));
    assert.deepEqual(
      list.result.prompts.map((p) => p.name),
      ["runbook"],
      "a prompt registered here reaches every user of every project as /mcp__hive__<name>; " +
        "only what hive itself ships belongs in that set",
    );

    assert.ok(!get.error, JSON.stringify(get.error));
    const text = get.result.messages.map((m) => m.content.text).join("\n");
    assert.match(text, /hive runbook/);
    assert.match(text, /help\(topic="workflow"\)/);
  });

  it("names exactly the registered set in `help`, so the overview cannot advertise a prompt that was removed", async () => {
    const { registered, overview } = await server(async (mcp) => ({
      registered: (await mcp.request("prompts/list", {})).result.prompts.map((p) => p.name),
      overview: await mcp.request("tools/call", { name: "help", arguments: {} }),
    }));

    const text = overview.result?.content?.[0]?.text ?? "";
    const block = text.match(/^PROMPTS[^\n]*\n((?:  .*\n?)*)/m);
    assert.ok(block, `help's overview has no PROMPTS block:\n${text.slice(0, 800)}`);
    const named = [...block[1].matchAll(/^ {2}(\S+)/gm)].map((m) => m[1]);
    assert.deepEqual(
      named.sort(),
      [...registered].sort(),
      "help's PROMPTS block and registerPrompts() disagree; every session is told to call help first, " +
        "so a name here that is not registered is a slash command that resolves to nothing",
    );
  });
});
