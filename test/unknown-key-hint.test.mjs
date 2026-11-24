import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { McpClient, isolateTmux, scratchDirs } from "./helpers.mjs";

const { cleanup } = isolateTmux("the unknown-key hint tests");
after(() => cleanup());

const dirs = scratchDirs();
let mcp;

before(async () => {
  mcp = new McpClient({ cwd: dirs.projectDir, dataDir: dirs.dataDir });
  await mcp.start();
});

after(async () => {
  await mcp.close();
});

describe("unknown-key refusal hints", () => {
  it("lists every matching schema key in schema order and leaves unrelated refusals unchanged", async () => {
    const { unknownKeyHint } = await import("../dist/strictInput.js");

    assert.equal(unknownKeyHint(["id"], ["todo_id", "pad_id", "agent_id"]), 'id: did you mean "todo_id" or "pad_id" or "agent_id"?');
    assert.equal(unknownKeyHint(["id"], ["todo_id", "pad_id"], ["todo_id"]), 'id: did you mean "pad_id"?');
    assert.equal(unknownKeyHint(["id"], ["todo_id", "pad_id"], ["todo_id", "pad_id"]), undefined);
    assert.equal(unknownKeyHint(["typo"], ["todo_id", "title"]), undefined);
    assert.equal(unknownKeyHint(["tag"], ["tag", "tags"]), 'tag: did you mean "tags"?');
  });

  it("a todo_get id typo names todo_id and a todo_update id typo cannot change the todo", async () => {
    const todo_id = (await mcp.call("todo_create", { title: "original title" })).todo_id;
    let getError;
    try {
      await mcp.call("todo_get", { id: todo_id });
    } catch (error) {
      getError = error.message;
    }
    assert.match(getError, /id: did you mean "todo_id" or "project_id"\?/);

    let updateError;
    try {
      await mcp.call("todo_update", { todo_id, title: "must not be written", id: todo_id });
    } catch (error) {
      updateError = error.message;
    }
    assert.match(updateError, /id: did you mean "project_id"\?/);
    assert.equal((await mcp.call("todo_get", { todo_id })).title, "original title");
  });

  it("does not suggest a key that the caller already supplied", async () => {
    let errorText;
    try {
      await mcp.call("todo_get", { todo_id: 1, project_id: 1, id: 1 });
    } catch (error) {
      errorText = error.message;
    }
    assert.equal(errorText, 'MCP error -32602: Input validation error: Invalid arguments for tool todo_get: Unrecognized key: "id"');
  });

  it("an unknown key with no likely match keeps the current refusal", async () => {
    let errorText;
    try {
      await mcp.call("todo_get", { todo_id: 1, typo: true });
    } catch (error) {
      errorText = error.message;
    }
    assert.equal(errorText, 'MCP error -32602: Input validation error: Invalid arguments for tool todo_get: Unrecognized key: "typo"');
  });
});
