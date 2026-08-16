# Attic: test/lead-identity-transaction.test.mjs

Comments removed from `test/lead-identity-transaction.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 7

```
// Issue #27's L4 fix round, DECISION 6. ensureLeadRow's INSERT, its actor_id
// UPDATE and upsertActor used to be three separate writes. A process dying
// between the first two leaves a running row with actor_id = '' that the
// next invocation used to FIND AND RETURN as if it were a normal hit, so the
// lead launched with HIVE_AGENT_ID= (empty) and the hook wrote neither a
// state log row nor last_seen_at for it - and idx_agents_running_name then
// stood in the way of ever replacing the row outright, since "lead" was
// already taken by it. This pins the fix: the three writes are now one
// transaction, and a damaged row found on a later call is healed in place
// rather than returned as-is or left to collide on a fresh INSERT.
```

## line 43

```
// Simulates exactly what a crash between the INSERT and the actor_id
// UPDATE used to leave behind: a running "lead" row with no actor_id at
// all.
```

## line 69

```
// upsertActor's other half: the actors table row must exist too, since
// that is what src/hook.ts's UPDATE and pad/todo attribution key on.
```
