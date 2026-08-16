# Attic: test/todo-slug.test.mjs

Comments removed from `test/todo-slug.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 6

```
// This file only calls todo_create/todo_get/todo_list/todo_update, but
// McpClient starts the same MCP server every tool runs on, including
// agent_spawn, so it can reach tmux and test/CLAUDE.md requires isolation
// unconditionally (test/suite-isolation.test.mjs enforces this by reading
// the file, not by observing whether a given file happens to use it).
```

## line 14

```
// Same class fallbackSlug/slugParam guard against - every C0 control byte
// and DEL - checked locally rather than imported, since this file exercises
// behaviour through the real MCP tools, not by importing src/tmux.js.
```

## line 33

```
// Mutation this dies against: drop `slug` from the INSERT column list in
// todo_create's handler (src/tools/todos.ts). Without it, the row's slug
// stays '' and summarize() falls back to a truncation of the title,
// which reads nothing like "pane steal" - so this assertion would fail
// rather than silently pass.
```

## line 56

```
// Mutation this dies against: drop `slug: patch.slug ?? null` from
// updateTodo's UPDATE statement bindings. Without it the COALESCE always
// receives NULL and the column never moves off "first guess", so this
// assertion would still read the old value.
```

## line 70

```
// Mutation this dies against: summarize() returning row.slug directly
// (i.e. '' for a slug-less row) instead of `row.slug || fallbackSlug(...)`.
// A blank slug would fail every assertion below, including the
// non-empty check.
```

## line 79

```
// Consistency is the entire point of this field (todo 318, comment 699):
// read it again through the other surface and require byte-identical
// output, proving this is a deterministic computation and not a fresh
// judgement call made per read.
```

## line 90

```
// test/CLAUDE.md shape 6: a fixture that never exceeds the bound cannot
// test the bound. This case and the long-title case above must both
// exist, or only one branch of fallbackSlug's length check is exercised.
```

## line 100

```
// Mutation this dies against: restore the naive `trimmed.slice(0,
// SLUG_MAX_LEN)` in fallbackSlug (src/tools/todos.ts) in place of the
// code-point-safe walk. 37 filler chars leave exactly enough of
// CUT_BUDGET (39, SLUG_MAX_LEN minus the reserved ellipsis unit) for
// the emoji's own 2 UTF-16 units to fit whole (37 + 2 = 39) - reproduced
// directly against the real fallbackSlug before this fix (see todo
// 318's own record): a code-unit slice at a fixed position split the
// pair and left an unpaired surrogate half, not valid UTF-16, and not a
// "usable label" by the lane's own standard - it rides into wake
// bodies, board entries and receipts.
```

## line 119

```
// The emoji itself must survive whole, not merely "no crash": the cut
// must land AFTER the full character, not drop it to dodge the split.
```

## line 123

```
// Counselors' own concrete failure: a slug read back from todo_get must
// be acceptable input to the tool that would have produced it.
```

## line 129

```
// test/CLAUDE.md shape 6, corrected per counselors: the PTY-headroom
// fixture above word-wraps well under 40 chars, so a naive
// `slug.length <= 40` assertion against it can never fail regardless of
// whether the reserved-ellipsis-unit math is right. An UNBROKEN title
// forces the "no space in budget" branch, which is the one that
// actually uses the full CUT_BUDGET.
//
// Mutation this dies against: CUT_BUDGET = SLUG_MAX_LEN instead of
// SLUG_MAX_LEN - 1 (src/tools/todos.ts) - i.e. not reserving a unit for
// the appended ellipsis. Measured against the real function before this
// fix: a 41-char unbroken title truncated to 40 chars + "…" = 41 UTF-16
// units, one over slugParam's own z.string().max(40), so todo_update
// rejected the exact value todo_get had just returned - the receipt did
// not round-trip through its own writer.
```

## line 154

```
// Mutation this dies against: drop the stripControlChars() call from
// fallbackSlug (src/tools/todos.ts), i.e. `title.trim()` instead of
// `stripControlChars(title).trim()`. `title` carries no control-char
// guard (an existing, unconstrained parameter this lane does not
// widen), so this is the path that serves ~300 pre-existing rows and
// every title-only todo_create - and both posture files this lane
// wrote tell a lead to carry a slug into a wake body, delivered
// VERBATIM into a pane, where a bare CR submits the line early.
```

## line 173

```
// Mutation this dies against: drop `|| \`todo ${row.id}\`` from
// summarize() (src/tools/todos.ts). Without it this todo's slug reads
// as '' - the exact blank-field failure this field exists to prevent,
// now unreachable through fallbackSlug alone once control characters
// are stripped (the fix above), since a title that is ONLY control
// characters/whitespace trims to "" the same way an all-whitespace one
// already did.
```

## line 186

```
// Mutation this dies against: drop `OR t.slug LIKE ?` from
// listTodoSummaries's query clause (src/tools/todos.ts). The slug's
// whole purpose is letting a lead find a todo by the name people
// actually use for it; title/body here deliberately share no substring
// with the query term, so a title/body-only match returns nothing.
```

## line 205

```
// Mutation this dies against: restore `.min(1)` on slugParam
// (src/tools/todos.ts). Before this fix there was no way to reset a
// typo'd slug: COALESCE(?, slug) only skips the column on NULL/omitted,
// and min(1) refused "" as a value, so a bad slug was permanent.
// Short and under SLUG_MAX_LEN on purpose, so fallbackSlug returns it
// verbatim and the assertion below isn't also computing a truncation.
```

## line 221

```
// Mutation this dies against: remove .max(SLUG_MAX_LEN) from slugParam
// (src/tools/todos.ts). Without it this call would succeed instead of
// throwing, and the assertion below would never run its catch branch.
```

## line 232

```
// Mutation this dies against: remove the findUnsafeControlChar .refine()
// from slugParam (src/tools/todos.ts). Without it neither call below
// would throw. Two cases, not one: a newline would corrupt a
// single-line rendering (a board line, a wake body); a raw control byte
// like 0x03 is the same hazard normalizeAgentName guards a worker name
// against, since a slug reaches a pane through a wake body too.
```
