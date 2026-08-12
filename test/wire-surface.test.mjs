import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { isolateTmux, McpClient, REPO, scratchDirs } from "./helpers.mjs";
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
  "agent_park",
  "agent_rename",
  "agent_resume",
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

  it("no integer parameter advertises a negative lower bound", async () => {
    // Issue #105 lane C, counselors run 22. This is a property over the
    // GENERATED surface, deliberately not a second snapshot: the snapshot
    // above pins what the shape IS, and this pins something that must be true
    // of a shape nobody has written yet. A new tool declaring a bare
    // z.number().int() emits minimum: -9007199254740991 and fails HERE, which
    // is what stops the fix from being a sweep that misses the 43rd tool
    // (.claude/sessions/common-issues/a-fix-applied-to-only-some-call-sites.md).
    //
    // The rule, and why it is about the lower bound only: zod 4 emits both
    // bounds for every integer. The MAXIMUM is a fact about JSON numbers
    // (past Number.MAX_SAFE_INTEGER they stop round-tripping through a
    // double) and is correct for every field. The MINIMUM is that same fact
    // mirrored, and no parameter in this surface has a valid negative value -
    // they are all ids, counts, offsets, revisions, delays and line counts.
    // See src/tools/params.ts for the two measured cases that made this
    // concrete (agent_output lines: -5 reaching tmux, pad_list offset: -1
    // silently returning the last row).
    //
    // Walks the whole schema, not just top-level properties: three of the 80
    // integer schemas live inside anyOf unions (wake_set.deliver_to,
    // wake_when_idle.agents.items, wake_when_idle.deliver_to) and a
    // properties-only walk would skip them.
    const listed = await mcp.request("tools/list", {});
    const offenders = [];
    let integers = 0;
    const walk = (node, path) => {
      if (Array.isArray(node)) return node.forEach((v, i) => walk(v, `${path}/${i}`));
      if (!node || typeof node !== "object") return;
      if (node.type === "integer") {
        integers++;
        // exclusiveMinimum: 0 (from .positive()) and minimum: 0 (from
        // .nonnegative()) both satisfy this; an ABSENT lower bound does not,
        // because zod 4 always emits one and its absence would mean the
        // emitter changed under us.
        const lower = node.minimum ?? node.exclusiveMinimum;
        if (typeof lower !== "number" || lower < 0) offenders.push(`${path} -> ${JSON.stringify(node)}`);
      }
      for (const [k, v] of Object.entries(node)) walk(v, `${path}/${k}`);
    };
    for (const tool of listed.result.tools) walk(tool.inputSchema, tool.name);

    // Guards the assertion against becoming vacuous: if a refactor stopped
    // integer parameters reaching the wire as type: "integer" at all, the
    // offenders check would pass over an empty set and report nothing wrong.
    assert.ok(integers > 0, "no integer schemas found in tools/list; this assertion has nothing to check");
    assert.deepEqual(
      offenders,
      [],
      `these integer parameters advertise a negative lower bound: ${offenders.join(", ")}. ` +
        "Give each one .positive(), .nonnegative(), or its real domain bound in src/tools/, then " +
        "regenerate the snapshot with `node scripts/wire-surface-snapshot.mjs`.",
    );
  });

  // TODO 321. hive TELLS ITS READER WHICH CALL TO MAKE, in wake bodies typed
  // verbatim into a terminal, in refusal notes, and in help text - and three
  // of those instructions named a parameter that does not exist
  // (`agent_output(agent: "w1")`; the parameter is `name`). That is not a typo
  // that degrades into a coercion: every tool advertises
  // additionalProperties: false and REFUSES an undeclared key with a -32602
  // (.claude/rules/tool-contract.md, and the assertion right below this one),
  // so the remedy in a block notice - the entire value of the notice - was a
  // call the reader could not run. Two of the three shipped in todo 314 and
  // todo 315 and survived both of their reviews.
  //
  // DERIVED FROM tools/list, NEVER FROM A LITERAL IN THIS FILE. A hardcoded
  // list of good parameter names would be a second copy of the schema, free to
  // drift from it the same way the bodies did - the identical failure one
  // level up. This asks the running server what each tool actually declares.
  //
  // It scans COMMENTS as well as strings, on purpose: this project treats a
  // comment as an assertion (.claude/sessions/decisions/2026-08-09-a-comment-
  // is-an-assertion.md), and a comment teaching the wrong call is wrong in the
  // same way a body is, just cheaper.
  it("every tool call hive suggests in its own source names real parameters", async () => {
    const listed = await mcp.request("tools/list", {});
    const declared = new Map(
      listed.result.tools.map((t) => [t.name, new Set(Object.keys(t.inputSchema?.properties ?? {}))]),
    );
    // RECURSIVE, not src/ plus src/tools/ by hand. A hardcoded directory
    // layout rots exactly the way a hardcoded parameter list would, and the
    // `checked > 10` guard below cannot see it: the first src/<newdir>/*.ts
    // would teach a refused call to a lead's terminal with this test green.
    const dir = join(REPO, "src");
    const files = readdirSync(dir, { recursive: true })
      .filter((f) => f.endsWith(".ts"))
      .map((f) => join(dir, f));
    // THE ONE DELIBERATE COUNTER-EXAMPLE IN THE TREE. src/strictInput.ts's own
    // comment quotes `pad_delete({pad_id: 7, expected_revison: 3})` - the
    // misspelling that motivated strict parsing - so it is a bad key on
    // purpose, and it is prose ABOUT a refused call rather than an instruction
    // to make one. Exempted by exact string, and asserted to still be present
    // below: an allowlist that silently covers nothing after a rewording is
    // the same rot as a stale comment.
    const DELIBERATE = "src/strictInput.ts: pad_delete(expected_revison: ...)";
    const offenders = [];
    let checked = 0;
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      for (const call of source.matchAll(/\b([a-z]+_[a-z_]+)\(\{?\s*(?=\w+\s*:)/g)) {
        const tool = call[1];
        if (!declared.has(tool)) continue;
        // Up to the first close paren, which for every shape in this codebase
        // ends the argument list - including the ones split across a string
        // concatenation, where the array literal's own "])" is that paren.
        const args = source.slice(call.index, source.indexOf(")", call.index));
        for (const key of args.matchAll(/[({,]\s*(\w+)\s*:/g)) {
          checked++;
          if (!declared.get(tool).has(key[1])) {
            offenders.push(`${file.slice(REPO.length + 1)}: ${tool}(${key[1]}: ...)`);
          }
        }
      }
    }
    // Guards against a vacuous pass: a regex that stopped matching anything at
    // all would report no offenders and look exactly like a clean tree.
    assert.ok(checked > 10, `only ${checked} suggested parameters found; this assertion has stopped matching`);
    assert.ok(
      offenders.includes(DELIBERATE),
      `the deliberate counter-example in ${DELIBERATE.split(":")[0]} is no longer found; re-read it and update or drop the exemption`,
    );
    assert.deepEqual(
      offenders.filter((o) => o !== DELIBERATE),
      [],
      `these suggested calls name parameters no tool declares, and would be refused with a -32602: ${offenders.join(", ")}`,
    );
  });

  it("no object anywhere in the surface accepts undeclared keys", async () => {
    // Todo 298. Same posture as the integer-bounds assertion above and for the
    // same reason: a property over the GENERATED surface, so a 43rd tool that
    // somehow escaped src/strictInput.ts fails HERE rather than relying on
    // anyone reading that file's comment
    // (.claude/sessions/common-issues/a-fix-applied-to-only-some-call-sites.md).
    // The snapshot below would also catch it, but only as "the wire surface
    // changed"; this names the missing guarantee.
    //
    // WALKS THE WHOLE SCHEMA, NOT JUST THE ROOT, and that is the difference
    // between this assertion and a version of it that could not fail in the
    // direction that matters. src/strictInput.ts makes the ROOT object strict;
    // strictness is a property of one object level, so a nested object
    // parameter is loose inside a strict parent. Counselors run 23 named the
    // concrete case: add `metadata: z.object({owner, reason})` to todo_create
    // and a caller sending {"owner": "impl", "resaon": "handoff"} gets `resaon`
    // stripped silently - todo 298's exact bug, one level down, with a
    // root-only assertion still green. Same reason the integer walk twelve
    // lines up recurses: the thing you are looking for hides below the top.
    //
    // kv_set's `value` is z.any() and emits {} with no `type` key, so the walk
    // never tests it. That preserves the deliberate carve-out (arbitrary keys
    // there sit INSIDE a declared parameter) with no exemption list to keep in
    // sync - see the audit in src/strictInput.ts.
    const listed = await mcp.request("tools/list", {});
    assert.equal(listed.result.nextCursor, undefined, "tools/list is paginating; this assertion only saw page one");
    const offenders = [];
    let objects = 0;
    const walk = (node, path) => {
      if (Array.isArray(node)) return node.forEach((v, i) => walk(v, `${path}/${i}`));
      if (!node || typeof node !== "object") return;
      if (node.type === "object") {
        objects++;
        if (node.additionalProperties !== false) offenders.push(path);
      }
      for (const [k, v] of Object.entries(node)) walk(v, `${path}/${k}`);
    };
    for (const tool of listed.result.tools) walk(tool.inputSchema, tool.name);

    // Guards against a vacuous pass the same way the integer test does: zero
    // object schemas satisfies an every-object property trivially, and one per
    // tool is the floor (each tool's own root), so a tool whose root stopped
    // being emitted as an object fails here too.
    assert.ok(
      objects >= listed.result.tools.length && listed.result.tools.length > 0,
      `found ${objects} object schemas across ${listed.result.tools.length} tools; expected at least one root each`,
    );
    assert.deepEqual(
      offenders,
      [],
      `these object schemas do not advertise additionalProperties: false: ${offenders.join(", ")}. ` +
        "A ROOT means something bypassed the wrapper in src/strictInput.ts, applied to the server in " +
        "src/index.ts. A NESTED one means a parameter was declared with z.object; declare it with " +
        "z.strictObject instead, since the wrapper only reaches the root.",
    );
  });

  it("refuses a misspelled optional parameter instead of silently dropping it", async () => {
    // THE counselors run 22 case, as a real client call rather than an
    // anecdote. pad_delete's expected_revision guards against deleting a pad
    // someone just updated, and checkRevision(pad, undefined, false) returns
    // SILENTLY. Before todo 298, zod stripped the misspelled key and the pad
    // was permanently deleted while the caller believed they were guarded -
    // the typo and a deliberate omission produced the identical call.
    //
    // Driven through the real registered surface, not a unit test over
    // z.strictObject: that would prove a fact about ZOD and would still pass
    // with src/strictInput.ts deleted
    // (.claude/sessions/dead-ends/2026-08-05-helper-whose-parameters-cannot-disagree.md).
    const pad = await mcp.call("pad_write", { name: "strict-input-typo-case", content: "guarded" });

    await assert.rejects(
      () => mcp.call("pad_delete", { pad_id: pad.pad_id, expected_revison: pad.revision }),
      /MCP error -32602:.*Unrecognized key: "expected_revison"/,
      "a misspelled expected_revision must be refused with -32602 naming the key, not stripped",
    );

    // The refusal has to have STOPPED the delete, not merely reported one.
    // Without this, a strict schema that refused after the handler ran would
    // pass the assertion above and still have destroyed the pad.
    const survived = await mcp.call("pad_read", { pad_id: pad.pad_id });
    assert.equal(survived.content, "guarded");

    // The control: the correctly spelled parameter still works. Without it,
    // "pad_delete refuses everything" also passes the two assertions above.
    const deleted = await mcp.call("pad_delete", { pad_id: pad.pad_id, expected_revision: survived.revision });
    assert.equal(deleted.deleted, true);
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
