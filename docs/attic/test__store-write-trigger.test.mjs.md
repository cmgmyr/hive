# Attic: test/store-write-trigger.test.mjs

Comments removed from `test/store-write-trigger.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 6

```
// Todo 331. The guard this file pins is a database-level trigger, not a
// Node-side check, so the incident it exists to catch has to be reproduced
// at the SQL layer directly - a raw UPDATE with no project_id predicate,
// changing content while leaving updated_at untouched, exactly like the
// python3+sqlite3 heredoc that produced the real incident (todo 331 comment
// 707). db.js resolves its file from HIVE_DATA_DIR at import time, so point
// it at a scratch dir before the dynamic import (test/CLAUDE.md).
//
// The legitimate-write suite below spawns a real hive server (McpClient),
// which can reach tmux (the janitor runs on every tool call), so this file
// isolates it even though none of pad/todo/kv touches tmux directly
// (test/CLAUDE.md, pinned by test/suite-isolation.test.mjs).
```

## line 31

```
// A fixed past timestamp, not the INSERT's own datetime('now') default: the
// trigger now compares NEW.updated_at against a FRESH datetime('now'), not
// against OLD.updated_at (see the migration's own comment for why - a same-
// second comparison against OLD produced false positives on ordinary rapid
// writes). A row seeded with "now" and attacked microseconds later can land
// in the same wall-clock second as the attack, which is the one case this
// design does not catch (documented as an accepted residual). The real
// incident's own row was stale by 17+ minutes, so seeding a genuinely past
// updated_at is the faithful reproduction, not a workaround for the test.
```

## line 56

```
// Reproduces the real incident: two projects each carry a pad named
// "board" (a conventional name the orchestration profile encourages),
// and the write that caused it addressed rows by that name with no
// project_id predicate at all.
```

## line 75

```
// The whole statement is refused, not just the row that tripped it -
// neither project's pad was touched, which is what proves this is a
// statement-level guard rather than a partial, silently-uneven one.
```

## line 90

```
// no backticks: SQLite string, not markdown
```

## line 102

```
// Regression for a real false positive found while building this
// migration: a first design compared NEW.updated_at to OLD.updated_at,
// and datetime('now') is whole-second resolution, so a row created and
// then immediately re-written (pad_write followed by pad_append
// milliseconds later, ordinary usage) got an identical OLD and NEW
// updated_at even though the second write genuinely re-stamped "now" -
// the trigger aborted a real pad_append. Seeding via the column DEFAULT
// here (not STALE_UPDATED_AT) is deliberate: it puts OLD.updated_at at
// the actual current second, the exact condition that broke the first
// design.
```

## line 125

```
// Negative control, not a regression test - it pins a documented limit
// rather than a bug. A smoke test replaying the incident against a
// freshly seeded store found this the same day PR #140 merged: the
// migration's own comment originally called this gap "one-in-a-billion",
// and it is not. Seed a row through a legitimate-shaped write (content
// set alongside updated_at = datetime('now'), as pad_write/todo_create/
// kv_set all do), then rewrite it with raw SQL a few milliseconds later
// - the natural shape of a hand-rolled driver script that seeds a row
// and then mutates it directly (the todo 324 family). Both statements'
// updated_at read the same wall-clock second, so the bypass's
// NEW.updated_at (carried forward, untouched) reads as "now" too and the
// WHEN clause never fires.
//
// If this test starts FAILING (the bypass throws), that means someone
// narrowed or removed the same-second window - a real improvement, not
// a break. Update this test and the migration's own comment together
// rather than deleting either silently: the documented limit and the
// checked one must not drift apart.
//
// This residual is exactly what todo 331's other lane (a PreToolUse
// hook denying a Bash command that writes to the store) is for: it does
// not care what second it is.
```
