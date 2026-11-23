import assert from "node:assert/strict";
import { after, before, it } from "node:test";
import { McpClient, isolateTmux, scratchDirs } from "./helpers.mjs";

const { cleanup } = isolateTmux("the pad-edit miss tests");
const dirs = scratchDirs();
let mcp;

before(async () => {
  mcp = new McpClient({ cwd: dirs.projectDir, dataDir: dirs.dataDir });
  await mcp.start();
});

after(async () => {
  await mcp.close();
  cleanup();
});

async function miss(padId, oldText) {
  try {
    await mcp.call("pad_edit", { pad_id: padId, old_text: oldText, new_text: "changed" });
  } catch (error) {
    return error.message;
  }
  assert.fail("pad_edit should reject a missing exact match");
}

it("pad_edit miss names the current revision", async () => {
  const { pad_id } = await mcp.call("pad_write", { name: "revision-miss", content: "stored text" });
  const error = await miss(pad_id, "not present");
  assert.match(error, new RegExp(`old_text not found in pad ${pad_id} \\(revision 1\\)\\. Re-read with pad_read\\.`));
  assert.doesNotMatch(error, /whitespace is ignored/);
});

it("pad_edit whitespace-only mismatch names the line and does not edit", async () => {
  const original = "\nfirst\r\n\talpha   beta\r\nlast";
  const { pad_id } = await mcp.call("pad_write", { name: "whitespace-miss", content: original });
  const error = await miss(pad_id, "alpha beta");
  assert.match(error, /revision 1/);
  assert.match(error, /matches once if whitespace is ignored, starting at line 3; copy that text exactly\./);
  const read = await mcp.call("pad_read", { pad_id });
  assert.equal(read.content, original, "a whitespace hint must never apply the edit");
  assert.equal(read.revision, 1);
});

it("pad_edit ambiguous loose match gives the plain miss", async () => {
  const { pad_id } = await mcp.call("pad_write", { name: "ambiguous-miss", content: "a  b\na\tb" });
  const error = await miss(pad_id, "a b");
  assert.match(error, new RegExp(`old_text not found in pad ${pad_id} \\(revision 1\\)\\. Re-read with pad_read\\.`));
  assert.doesNotMatch(error, /whitespace is ignored/);
});
