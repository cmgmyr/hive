import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { McpClient, isolateTmux, scratchDirs } from "./helpers.mjs";

// Ad-hoc lane off pad 71 "tmux-placement-design". resolveHomeProject's
// registration fallback (src/context.ts) silently creates a project for a cwd
// no project covers, and run() (src/result.ts) used to say nothing about it.
// These tests drive a REAL MCP server over stdio against scratch state, not a
// helper: test/CLAUDE.md's false-green shape #4 and
// .claude/sessions/dead-ends/2026-08-05-helper-whose-parameters-cannot-disagree.md
// are both about a unit test whose inputs the real caller can never produce.
// mcp.request() is used directly here, not mcp.call(), because call() only
// ever reads content[0].text - exactly the thing this lane is pinning does
// NOT change - and the notice is a second block.

const { cleanup: cleanupTmux } = isolateTmux("the project-registration-notice tests");
after(() => cleanupTmux());

async function toolCall(mcp, name, args = {}) {
  const msg = await mcp.request("tools/call", { name, arguments: args });
  assert.equal(msg.result?.isError, undefined, `${name} returned an error: ${msg.result?.content?.[0]?.text}`);
  return msg.result.content;
}

describe("silent project registration becomes a visible notice", () => {
  it("a tool call from a cwd no project covers gets a second content block naming the created project", async () => {
    const { dataDir, projectDir } = scratchDirs();
    const mcp = new McpClient({ cwd: projectDir, dataDir });
    await mcp.start();
    try {
      const content = await toolCall(mcp, "whoami");
      assert.equal(content.length, 2, "expected a notice as a second content block");
      const receipt = JSON.parse(content[0].text);
      assert.equal(receipt.project.path, projectDir, "content[0] must still be the tool's own JSON receipt, untouched");

      const notice = content[1].text;
      assert.match(notice, new RegExp(`project ${receipt.project.id}\\b`), "notice must name the created project's id");
      assert.match(notice, new RegExp(projectDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "notice must name the created project's path");
      assert.match(notice, /project_prune|project_select/, "notice must name a remedy");
    } finally {
      await mcp.close();
    }
  });

  it("does not repeat the notice on a second call in the same process", async () => {
    const { dataDir, projectDir } = scratchDirs();
    const mcp = new McpClient({ cwd: projectDir, dataDir });
    await mcp.start();
    try {
      const first = await toolCall(mcp, "whoami");
      assert.equal(first.length, 2, "first call should register and notify");

      const second = await toolCall(mcp, "whoami");
      assert.equal(second.length, 1, "second call in the same process must not repeat the notice");
    } finally {
      await mcp.close();
    }
  });

  it("project_add is deliberate registration and stays silent", async () => {
    const { dataDir, projectDir } = scratchDirs();
    const mcp = new McpClient({ cwd: projectDir, dataDir });
    await mcp.start();
    try {
      const content = await toolCall(mcp, "project_add", { path: projectDir });
      assert.equal(content.length, 1, "project_add must never emit the registration notice");
    } finally {
      await mcp.close();
    }
  });

  it("a cwd already covered by a registered project gets no notice, even in a fresh process", async () => {
    const { dataDir, projectDir } = scratchDirs();

    const registering = new McpClient({ cwd: projectDir, dataDir });
    await registering.start();
    await toolCall(registering, "project_add", { path: projectDir });
    await registering.close();

    const mcp = new McpClient({ cwd: projectDir, dataDir });
    await mcp.start();
    try {
      const content = await toolCall(mcp, "whoami");
      assert.equal(content.length, 1, "a cwd matching an already-registered project must not be announced as newly created");
    } finally {
      await mcp.close();
    }
  });
});
