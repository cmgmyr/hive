import assert from "node:assert/strict";
import { after, before, it } from "node:test";
import { McpClient, isolateTmux, scratchDirs } from "./helpers.mjs";

const { cleanup: cleanupTmux } = isolateTmux("the pad-read-range tests");
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

it("pad_read without range keys returns the full unchanged pad shape", async () => {
  const created = await mcp.call("pad_write", {
    name: "whole-pad",
    content: "full content 😀",
    tags: ["range"],
  });
  const read = await mcp.call("pad_read", { pad_id: created.pad_id });

  assert.deepEqual(Object.keys(read).sort(), [
    "content",
    "name",
    "pad_id",
    "revision",
    "tags",
    "updated_at",
    "updated_by",
  ]);
  assert.equal(read.content, "full content 😀");
  assert.deepEqual(read.tags, ["range"]);
});

it("pad_read chunks reassemble a large pad by following next_offset", async () => {
  const content = `${"abc😀é".repeat(50_000)}end`;
  const created = await mcp.call("pad_write", { name: "large-pad", content });
  const chunks = [];
  let offset = 0;

  while (offset != null) {
    const read = await mcp.call("pad_read", { pad_id: created.pad_id, offset, limit: 50_000 });
    assert.equal(read.total_length, content.length);
    assert.equal(read.offset, offset);
    chunks.push(read.content);
    offset = read.next_offset;
  }

  assert.equal(chunks.join(""), content);
});

it("pad_read moves a chunk end back instead of splitting a surrogate pair", async () => {
  const created = await mcp.call("pad_write", { name: "surrogate-boundary", content: "a😀b" });
  const read = await mcp.call("pad_read", { pad_id: created.pad_id, offset: 0, limit: 2 });

  assert.equal(read.content, "a");
  assert.equal(read.total_length, 4);
  assert.equal(read.offset, 0);
  assert.equal(read.next_offset, 1);

  const overlapping = await mcp.call("pad_read", { pad_id: created.pad_id, offset: 2, limit: 2 });
  assert.equal(overlapping.content, "😀b");
  assert.equal(overlapping.offset, 1);
  assert.equal(overlapping.next_offset, null);
});

it("pad_read advances through a leading surrogate pair when limit is one", async () => {
  const content = "😀b";
  const created = await mcp.call("pad_write", { name: "one-unit-surrogate", content });
  const chunks = [];
  let offset = 0;
  let reads = 0;

  while (offset != null && reads < 10) {
    const read = await mcp.call("pad_read", { pad_id: created.pad_id, offset, limit: 1 });
    chunks.push(read.content);
    offset = read.next_offset;
    reads++;
  }

  assert.equal(offset, null, "following next_offset must reach the end instead of stalling");
  assert.equal(chunks.join(""), content);
});

it("pad_read returns an empty terminal chunk when offset is past the pad", async () => {
  const created = await mcp.call("pad_write", { name: "past-end", content: "short" });
  const read = await mcp.call("pad_read", { pad_id: created.pad_id, offset: 9, limit: 3 });

  assert.equal(read.content, "");
  assert.equal(read.total_length, 5);
  assert.equal(read.offset, 9);
  assert.equal(read.next_offset, null);
});

it("pad_read with a zero limit returns an empty chunk without advancing", async () => {
  const created = await mcp.call("pad_write", { name: "zero-limit", content: "short" });
  const read = await mcp.call("pad_read", { pad_id: created.pad_id, offset: 2, limit: 0 });

  assert.equal(read.content, "");
  assert.equal(read.total_length, 5);
  assert.equal(read.offset, 2);
  assert.equal(read.next_offset, 2);
});

it("pad_read refuses out-of-bounds range values and unknown keys", async () => {
  const created = await mcp.call("pad_write", { name: "invalid-range", content: "short" });
  const rejectsRangeValue = (error) => {
    assert.match(error.message, /Input validation error: Invalid arguments for tool pad_read:/);
    assert.doesNotMatch(error.message, /Unrecognized keys/);
    return true;
  };

  await assert.rejects(mcp.call("pad_read", { pad_id: created.pad_id, offset: -1 }), rejectsRangeValue);
  await assert.rejects(mcp.call("pad_read", { pad_id: created.pad_id, limit: -1 }), rejectsRangeValue);
  await assert.rejects(
    mcp.call("pad_read", { pad_id: created.pad_id, offset: Number.MAX_SAFE_INTEGER + 1 }),
    rejectsRangeValue,
  );
  await assert.rejects(mcp.call("pad_read", { pad_id: created.pad_id, typo: true }), /typo/i);
});
