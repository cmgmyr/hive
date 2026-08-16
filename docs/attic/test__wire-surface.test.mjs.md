# Attic: test/wire-surface.test.mjs

Comments removed from `test/wire-surface.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 8

```
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
```

## line 31

```
// The exact registered tool set, hardcoded rather than derived from the
// snapshot file itself. That keeps a rename or removal failing here - a
// plain name-set mismatch - distinctly from a schema-shape difference in the
// snapshot comparison below, so a failure output tells you which kind of
// change happened without reading a JSON diff first.
```

## line 83

```
// Fixed palette, not the same hash that picks ASCII code points directly -
// that range includes the invalid lone-surrogate band (0xD800-0xDFFF),
// which is exactly the bug the `^` fix below already hit once. é (2-byte
// UTF-8), the euro sign (3-byte), 中 (3-byte), and an emoji (4-byte, needs a
// UTF-16 surrogate PAIR - String.fromCodePoint emits both halves together,
// so this never produces a lone surrogate on its own).
```

## line 91

```
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
```

## line 110

```
// `^` converts its result via ToInt32, so a bare `h ^= h >>> 15` can go
// negative once bit 31 is set - measured directly: 98,967 of 200,000
// chars landed outside 32-126 (some in the UTF-16 surrogate range),
// which JSON/UTF-8 cannot round-trip and produced a false failure that
// had nothing to do with the server. The trailing `>>> 0` forces back to
// uint32 before the modulo.
```

## line 137

```
// Counselors round 2, item 8: without this, the name-set assertion
// below would pass on page one alone if the server ever started
// paginating - EXPECTED_TOOL_NAMES only covers a single response.
```

## line 146

```
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
```

## line 176

```
// exclusiveMinimum: 0 (from .positive()) and minimum: 0 (from
// .nonnegative()) both satisfy this; an ABSENT lower bound does not,
// because zod 4 always emits one and its absence would mean the
// emitter changed under us.
```

## line 187

```
// Guards the assertion against becoming vacuous: if a refactor stopped
// integer parameters reaching the wire as type: "integer" at all, the
// offenders check would pass over an empty set and report nothing wrong.
```

## line 200

```
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
// same way a body is, just cheaper. src/ carries no comments as of todo 436,
// so today it reads strings alone; the comment arm stays for the backfill.
//
// It also carried an exemption for the one DELIBERATE bad call in the tree -
// src/strictInput.ts quoted `pad_delete({expected_revison: 3})`, the
// misspelling that motivated strict parsing. That comment is now in
// docs/attic/src__strictInput.ts.md and the exemption went with it. Restore
// both together or neither: an allowlist covering nothing is the rot the
// present-assertion beside it existed to catch.
```

## line 233

```
// RECURSIVE, not src/ plus src/tools/ by hand. A hardcoded directory
// layout rots exactly the way a hardcoded parameter list would, and the
// `checked > 10` guard below cannot see it: the first src/<newdir>/*.ts
// would teach a refused call to a lead's terminal with this test green.
```

## line 248

```
// Up to the first close paren, which for every shape in this codebase
// ends the argument list - including the ones split across a string
// concatenation, where the array literal's own "])" is that paren.
```

## line 260

```
// Guards against a vacuous pass: a regex that stopped matching anything at
// all would report no offenders and look exactly like a clean tree.
```

## line 271

```
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
```

## line 309

```
// Guards against a vacuous pass the same way the integer test does: zero
// object schemas satisfies an every-object property trivially, and one per
// tool is the floor (each tool's own root), so a tool whose root stopped
// being emitted as an object fails here too.
```

## line 328

```
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
```

## line 347

```
// The refusal has to have STOPPED the delete, not merely reported one.
// Without this, a strict schema that refused after the handler ran would
// pass the assertion above and still have destroyed the pad.
```

## line 353

```
// The control: the correctly spelled parameter still works. Without it,
// "pad_delete refuses everything" also passes the two assertions above.
```

## line 361

```
// toolsByName/renderToolsSnapshot/sortKeysDeep are imported from
// scripts/wire-surface-snapshot.mjs - see that file for what belongs in
// the snapshot (the whole tool, not just inputSchema) and why arrays
// are not normalised.
```

## line 367

```
// Both sides through sortKeysDeep, not just actualTools: otherwise a
// hand-edited or differently-generated snapshot with out-of-order keys
// would report every tool as changed via the per-tool comparison below
// while the byte-exact backstop fails for a different reason, and the
// two disagree about what moved.
```

## line 374

```
// Report WHICH TOOLS changed, not the whole ~20KB snapshot dumped twice
// as one string diff (measured: that is what a schema-only mutation
// produces from a plain assert.equal on the rendered file, and it
// buries the one tool that actually changed). Lane C's reviewer reads a
// schema diff off this file per tool (pad 82 DECISION 2), so the
// failure has to name the tool. Union of both sides' names, so a tool
// present on only one side - added, removed, or renamed - is reported
// too, not just a tool with a changed body present on both.
```

## line 395

```
// Belt and suspenders, not the primary check: `changed` is only
// equivalent to full byte equality because both sides go through the
// same sortKeysDeep + JSON.stringify(_, null, 2) pipeline (renderToolsSnapshot).
// Byte-exact is what actually defines "unchanged" here, not the
// per-tool summary above - if that equivalence ever broke, this still
// catches it.
```

## line 405

```
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
```

## line 425

```
// No assertion on `written.revision` here (counselors round 2, item 7,
// test/CLAUDE.md shape 2 - a saturated comparison): a create returns
// revision 1 whatever the content is, including silently truncated
// content, so it would read as corroboration this test does not
// provide. The real check is the content comparison below.
```
