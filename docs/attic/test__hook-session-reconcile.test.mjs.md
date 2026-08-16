# Attic: test/hook-session-reconcile.test.mjs

Comments removed from `test/hook-session-reconcile.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 6

```
// Issue #154, D1: src/hook.ts parses session_id off every payload and
// reconciles the row -- the hook is the authority, which is what makes
// agent_spawn's --session-id flag non-load-bearing rather than redundant.
//
// Every seeded row below starts at a session_id DIFFERENT from the one the
// payload carries (.claude/sessions/dead-ends/2026-07-29-seeding-a-test-row-
// with-the-value-it-asserts.md): a row already seeded with the asserted
// value would pass against a hook that does nothing at all.
```
