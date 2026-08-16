# Attic: test/lease-acquire-returning.test.mjs

Comments removed from `test/lease-acquire-returning.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 5

```
// Fix round 1 on todo 345 / issue #148, P1: lease_acquire's success receipt
// used to come from a SEPARATE SELECT run after the INSERT, not from the
// INSERT itself. Actor A inserts a short-TTL lease and stalls before that
// follow-up SELECT runs; the lease expires, actor B's own lease_acquire
// purges it and inserts its own; A's SELECT - reached only after the stall -
// then reads B's row, and A's receipt reports B's expiry as evidence of A's
// own acquisition.
//
// The fix reads the expiry back with RETURNING on the INSERT statement
// itself, so the receipt is generated in the exact same statement that
// created the row - there is no later read left to interleave a
// concurrent purge-and-reinsert into. That collapses the vulnerable window
// entirely rather than narrowing it (the same shape as the pad_append
// separator fix in this same round), so unlike the revision and lease-
// extend races there is no interleaving left to reconstruct: nothing runs
// between the INSERT and the receipt being built. This test is therefore an
// ordinary regression check that the RETURNING path reports the row it
// actually created, not a race reconstruction - said plainly rather than
// implying coverage the single-statement fix doesn't leave room for.
//
// PROVEN RED against the pre-fix INSERT-then-SELECT shape: a throwaway
// repro of the exact scenario above (A's insert, a purge-and-reinsert by B
// landing before A's follow-up SELECT, then that SELECT) reported A's
// receipt as acquired:true with B's row's expiry. Output pasted in the PR
// body.
```

## line 36

```
// HIVE_DATA_DIR must be set BEFORE dist/db.js is ever imported in this
// process - it opens the store in its module body, so an import hoisted
// above this line would choose the wrong store (test/CLAUDE.md).
```
