# Attic: test/lead-hook-state.test.mjs

Comments removed from `test/lead-hook-state.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 7

```
// Issue #27, step 3. The lead now has an agents row (kind='lead'), so
// src/hook.ts's `UPDATE agents SET agent_state ... WHERE actor_id = ?` would
// MATCH one for the first time and write exactly the state
// .claude/rules/worker-state.md's "never set a /goal on a worker" says a
// lead running unattended under /goal cannot be trusted to hold: nine
// consecutive false idles were measured on agent:53 in 50 seconds with no
// prompt|working between them, and the lead has no supervisor above it the
// way a lead polls a worker. The fix is a discriminator on kind, read once
// per invocation, not "the UPDATE matches zero rows anyway" - that reasoning
// is exactly what stopped being true here.
```

## line 79

```
// The negative control for the test above: a lead whose agent_state is
// NOT 'unknown' proves the skip is a real branch, not a coincidence of
// the column's default value matching what the UPDATE would have set.
```

## line 90

```
// The half of the acceptance criteria a skip is most likely to break by
// accident: proving kind='agent' still goes through the UPDATE at all.
```
