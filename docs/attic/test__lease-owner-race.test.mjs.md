# Attic: test/lease-owner-race.test.mjs

Comments removed from `test/lease-owner-race.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 5

```
// Issue #148 / todo 345. The lease extension UPDATE used to be
// `WHERE project_id = ? AND lock_key = ?` with no owner predicate. The race:
// actor A's lease_acquire reads the row (owner: A, about to expire), and
// before A's extend UPDATE runs, actor B's OWN lease_acquire purges the
// now-expired row and inserts itself as owner. A's dangling UPDATE then
// still matches by project_id/lock_key alone, extends B's row, and reports
// {acquired: true, extended: true} to A - two actors now both hold evidence
// they own the same key.
//
// That interleaving (A's SELECT, then B's full purge-and-insert, then A's
// UPDATE) is a few synchronous SQL statements wide. Racing two real MCP
// server processes for it would pass or fail on IPC/scheduling luck, not on
// whether the guard works, so - per the same standing preference as the pad
// revision race test - this asserts extendOwnedLease's predicate directly:
// it reconstructs exactly the state B's purge-and-insert would leave behind,
// then calls the real extend function as A and checks it refuses.
//
// PROVEN RED against the pre-fix UPDATE (no owner predicate): reproduced
// inline below with a throwaway copy of the old SQL, since the old
// extension logic was not a separate function to import. Output pasted in
// the PR body.
```

## line 46

```
// A holds the lease, about to expire.
```

## line 52

```
// A's handler already read owner === "agent:A" and is about to extend.
// Concurrently, B's lease_acquire purges the expired row and takes it -
// exactly what a real interleaving would do between A's SELECT and A's
// UPDATE.
```

## line 65

```
// A's dangling extend attempt, using the ownership it read before B's
// insert landed.
```
