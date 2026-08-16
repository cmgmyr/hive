# Attic: test/session-id-field.test.mjs

Comments removed from `test/session-id-field.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 5

```
// Issue #154, D1 and D4: agent_spawn generates a UUID and writes it on the
// row in the same statement that inserts it (src/spawn.ts's launchAgent),
// and agent_status/agent_list report it under the same isClaudeCommand gate
// transcript_dir already uses (D2/D3, pinned against the real tools by
// test/transcript-field.test.mjs -- this file mirrors its structure for the
// new field rather than inventing a second policy shape).
```

## line 35

```
// claude --session-id requires a real UUID; loose enough to not overfit a
// particular node:crypto randomUUID rendering, strict enough to catch a
// regression that stops generating one at all.
```

## line 49

```
// Read twice: the id agent_status reports must be the SAME one recorded
// at spawn, not a fresh read of something that could drift.
```

## line 81

```
// agent_status, not agent_list: D3 omits the key for a live row, so this
// is the only reading available while the worker is still up.
```

## line 95

```
// agent_status's reading (captured while live, above) must agree with
// agent_list's reading of the same row after close -- one fact, one
// column, read two ways.
```

## line 106

```
// The pre-#154 manual resume workflow
// (.claude/sessions/workflows/resume-a-closed-worker.md) is exactly this
// call shape. --session-id and --resume are different flags, not two
// copies of one, so nothing about claude's own duplicate-flag handling
// protects this pair -- the auto-generated flag has to get out of the
// way instead.
```

## line 122

```
// '' for a claude worker still gates as "no fact recorded", same as any
// non-claude row -- D4's rule is about the FIELD's trustworthiness, and
// an id this tool never generated is not trustworthy either.
```
