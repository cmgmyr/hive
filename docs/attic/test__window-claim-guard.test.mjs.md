# Attic: test/window-claim-guard.test.mjs

Comments removed from `test/window-claim-guard.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 6

```
// Todo 346, pad 111 entry 13. withWindowClaim (src/spawn.ts) is
// `db.transaction(claim).immediate()`, and better-sqlite3 nests a transaction
// inside an already-open one as a no-op SAVEPOINT rather than throwing (see
// node_modules/better-sqlite3/lib/methods/transaction.js: `if (db.inTransaction)`
// swaps BEGIN/COMMIT for SAVEPOINT/RELEASE, with no error either way). A claim
// made from inside an outer transaction would take no writer slot of its own,
// so the machine-wide mutual exclusion this function exists to provide is
// silently gone - no throw, no failing test. This file pins the guard that
// makes that a loud refusal instead.
//
// No tmux here at all: withWindowClaim's own body never touches it (only the
// `claim` callback passed in by real call sites does), so this exercises the
// guard directly against a scratch store with a no-op claim.
```

## line 69

```
// The refusal has to fire BEFORE db.transaction() is entered, or the
// caller's outer transaction would already be holding a savepoint it
// then has to unwind. Proven here by checking the outer transaction's own
// effects are untouched by the throw: a sibling statement in the same
// outer transaction still commits normally once the nested call is
// removed, i.e. the guard does not corrupt the outer transaction's state.
```

## line 82

```
// The whole outer transaction rolled back on the throw (better-sqlite3's
// own undo.run() in wrapTransaction), so the insert above must not have
// survived either - proof the guard did not leave the store half-written.
```
