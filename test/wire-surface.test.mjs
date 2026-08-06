import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import { isolateTmux, McpClient, scratchDirs } from "./helpers.mjs";
import { renderToolsSnapshot, SNAPSHOT_PATH, sortKeysDeep, toolsByName } from "../scripts/wire-surface-snapshot.mjs";

// Issue #105 lane W. This file exists to BE the fixed point every later
// dependency bump in the series (zod 3 -> 4 especially, lane C) is measured
// against: committed before anything moves, so a downstream schema diff is a
// real comparison against a tree that predates the bump, not a comparison a
// worker generated against its own work. See pad 82, DECISION 2.
//
// The snapshot's serialization (sortKeysDeep, toolsByName, renderToolsSnapshot)
// lives in scripts/wire-surface-snapshot.mjs, not here, and that script is
// also how you regenerate the committed fixture (`node
// scripts/wire-surface-snapshot.mjs`) - counselors round 2, item 5. One
// definition shared by the reader (this file) and the writer (that script),
// so a hand-rolled regeneration can never format the fixture differently
// than this test expects.
// isolateTmux() is required at module top level in any file that spawns
// hive (test/CLAUDE.md), because every hive command can reach the
// scheduler's tmux probes - this file never creates a tmux session itself,
// so cleanupTmux() below is called with no names and iterates nothing.
// Kept anyway, matching the pattern every other McpClient-only file in this
// suite uses, for the isolation contract rather than actual cleanup
// (counselors round 2, item 10).
const { cleanup: cleanupTmux } = isolateTmux("the wire-surface tests");
after(() => cleanupTmux());

// The exact registered tool set, hardcoded rather than derived from the
// snapshot file itself. That keeps a rename or removal failing here - a
// plain name-set mismatch - distinctly from a schema-shape difference in the
// snapshot comparison below, so a failure output tells you which kind of
// change happened without reading a JSON diff first.
const EXPECTED_TOOL_NAMES = [
  "actor_prune",
  "agent_close",
  "agent_list",
  "agent_output",
  "agent_rename",
  "agent_send",
  "agent_spawn",
  "agent_status",
  "help",
  "kv_delete",
  "kv_get",
  "kv_list",
  "kv_set",
  "lease_acquire",
  "lease_release",
  "pad_append",
  "pad_archive",
  "pad_delete",
  "pad_edit",
  "pad_list",
  "pad_read",
  "pad_write",
  "project_add",
  "project_list",
  "project_prune",
  "project_select",
  "todo_archive",
  "todo_block",
  "todo_comment",
  "todo_complete",
  "todo_create",
  "todo_get",
  "todo_list",
  "todo_unblock",
  "todo_update",
  "wake_cancel",
  "wake_get",
  "wake_list",
  "wake_set",
  "wake_update",
  "wake_when_idle",
  "whoami",
];

// Fixed palette, not the same hash that picks ASCII code points directly -
// that range includes the invalid lone-surrogate band (0xD800-0xDFFF),
// which is exactly the bug the `^` fix below already hit once. é (2-byte
// UTF-8), the euro sign (3-byte), 中 (3-byte), and an emoji (4-byte, needs a
// UTF-16 surrogate PAIR - String.fromCodePoint emits both halves together,
// so this never produces a lone surrogate on its own).
const MULTIBYTE = ["é", "€", "中", "\u{1f600}"];

// Deterministic, position-dependent pseudo-random text, mostly printable
// ASCII with a multibyte character substituted at a fixed cadence.
// Counselors round 2, item 6: this test's own McpClient (test/helpers.mjs)
// used to decode each `data` Buffer independently, which mangles a UTF-8
// sequence that happens to straddle two `data` events - a real stdio
// decoding bug, and the ASCII-only fixture this replaced was built to
// exclude it entirely. Every 997th position (prime, so it never aligns with
// a power-of-two pipe buffer size) goes multibyte instead of ASCII, giving
// ~200 chances across a 200,000-character payload to land on a chunk
// boundary. A uniform ASCII fixture ("x".repeat(n)) would also let a bug
// that truncates and re-pads, or swaps two equal-length chunks, pass
// unnoticed - length alone would still match - so most positions still
// resolve to a near-arbitrary printable byte, and a single corrupted
// character anywhere in the payload changes the full-string comparison
// below.
function bigPayload(chars) {
  let out = "";
  for (let i = 0; i < chars; i++) {
    let h = (i * 2654435761) >>> 0;
    // `^` converts its result via ToInt32, so a bare `h ^= h >>> 15` can go
    // negative once bit 31 is set - measured directly: 98,967 of 200,000
    // chars landed outside 32-126 (some in the UTF-16 surrogate range),
    // which JSON/UTF-8 cannot round-trip and produced a false failure that
    // had nothing to do with the server. The trailing `>>> 0` forces back to
    // uint32 before the modulo.
    h = (h ^ (h >>> 15)) >>> 0;
    out += i % 997 === 0 ? MULTIBYTE[h % MULTIBYTE.length] : String.fromCharCode(32 + (h % 95));
  }
  return out;
}

const dirs = scratchDirs();
let mcp;

before(async () => {
  mcp = new McpClient({ cwd: dirs.projectDir, dataDir: dirs.dataDir });
  await mcp.start();
});

after(async () => {
  await mcp.close();
});

describe("MCP wire surface", () => {
  it("tools/list returns the exact expected tool name set", async () => {
    const listed = await mcp.request("tools/list", {});
    // Counselors round 2, item 8: without this, the name-set assertion
    // below would pass on page one alone if the server ever started
    // paginating - EXPECTED_TOOL_NAMES only covers a single response.
    assert.equal(listed.result.nextCursor, undefined, "tools/list is paginating; this test only checked page one");
    const names = listed.result.tools.map((t) => t.name).sort();
    assert.deepEqual(names, EXPECTED_TOOL_NAMES);
  });

  it("every tool's advertised shape matches the committed wire-surface snapshot", async () => {
    const listed = await mcp.request("tools/list", {});
    // toolsByName/renderToolsSnapshot/sortKeysDeep are imported from
    // scripts/wire-surface-snapshot.mjs - see that file for what belongs in
    // the snapshot (the whole tool, not just inputSchema) and why arrays
    // are not normalised.
    const actualTools = toolsByName(listed.result.tools);
    const expectedFile = readFileSync(SNAPSHOT_PATH, "utf8");
    // Both sides through sortKeysDeep, not just actualTools: otherwise a
    // hand-edited or differently-generated snapshot with out-of-order keys
    // would report every tool as changed via the per-tool comparison below
    // while the byte-exact backstop fails for a different reason, and the
    // two disagree about what moved.
    const expectedTools = sortKeysDeep(JSON.parse(expectedFile));

    // Report WHICH TOOLS changed, not the whole ~20KB snapshot dumped twice
    // as one string diff (measured: that is what a schema-only mutation
    // produces from a plain assert.equal on the rendered file, and it
    // buries the one tool that actually changed). Lane C's reviewer reads a
    // schema diff off this file per tool (pad 82 DECISION 2), so the
    // failure has to name the tool. Union of both sides' names, so a tool
    // present on only one side - added, removed, or renamed - is reported
    // too, not just a tool with a changed body present on both.
    const allNames = new Set([...Object.keys(actualTools), ...Object.keys(expectedTools)]);
    const changed = [...allNames]
      .filter((name) => JSON.stringify(actualTools[name]) !== JSON.stringify(expectedTools[name]))
      .sort();

    assert.deepEqual(
      changed,
      [],
      `wire surface changed for: ${changed.join(", ")}. Compare each against the committed snapshot at ` +
        `${SNAPSHOT_PATH}. If intended (e.g. lane C's zod 4 bump), regenerate it deliberately with ` +
        "`node scripts/wire-surface-snapshot.mjs` and explain the diff per tool in the PR body.",
    );

    // Belt and suspenders, not the primary check: `changed` is only
    // equivalent to full byte equality because both sides go through the
    // same sortKeysDeep + JSON.stringify(_, null, 2) pipeline (renderToolsSnapshot).
    // Byte-exact is what actually defines "unchanged" here, not the
    // per-tool summary above - if that equivalence ever broke, this still
    // catches it.
    assert.equal(renderToolsSnapshot(listed.result.tools), expectedFile);
  });

  it("a 200KB payload round-trips through real stdio unchanged, both directions", async () => {
    // NOT a test of SDK 1.30's 10MB read-buffer cap (PR #104), and it cannot
    // be made into one at this size: STDIO_DEFAULT_MAX_BUFFER_SIZE is
    // 10 * 1024 * 1024 bytes (@modelcontextprotocol/sdk's shared/stdio.js),
    // and 200KB is 1.95% of that - no implementation of the cap, including
    // its removal, changes this test's outcome. Counselors round 2 caught
    // this; a prior version of this comment claimed cap coverage it did not
    // have, which is the actual false green here, not the fixture.
    //
    // What this size DOES exercise: a single JSON-RPC line above roughly
    // 64KB does not arrive in one `data` event, so the reassembly this
    // test's own McpClient does (test/helpers.mjs: concatenate chunks, then
    // find the newline) - the same shape the real SDK's ReadBuffer uses -
    // has to run multi-chunk rather than trusting a single read.
    //
    // The cap itself is symmetric, for the record: client/stdio.js
    // constructs its own ReadBuffer with the same 10MB default, so there is
    // no direction this payload size proves anything about that the other
    // does not - a prior version of this comment claimed one direction was
    // unbounded, which was also wrong.
    const payload = bigPayload(200_000);
    // No assertion on `written.revision` here (counselors round 2, item 7,
    // test/CLAUDE.md shape 2 - a saturated comparison): a create returns
    // revision 1 whatever the content is, including silently truncated
    // content, so it would read as corroboration this test does not
    // provide. The real check is the content comparison below.
    const written = await mcp.call("pad_write", { name: "wire-surface-payload", content: payload });
    const read = await mcp.call("pad_read", { pad_id: written.pad_id });
    assert.equal(read.content.length, payload.length);
    assert.equal(read.content, payload);
  });
});
