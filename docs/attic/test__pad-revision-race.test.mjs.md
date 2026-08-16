# Attic: test/pad-revision-race.test.mjs

Comments removed from `test/pad-revision-race.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 7

```
// Issue #148 / todo 345. bumpPad's UPDATE used to be `WHERE id = ?` with no
// revision predicate: two sessions that both read revision N before either
// wrote both pass checkRevision's JS-level pre-check (it compares against
// its OWN fresh read, not against the other session), then both UPDATE. The
// second write silently overwrites the first's content, and BOTH receipts
// report success with a revision computed from each session's own stale
// read - the actual current revision after both writes disagrees with what
// either caller was told.
//
// The interleaving that triggers this is checkRevision's SELECT racing
// against another session's UPDATE - a couple of synchronous SQL statements
// wide, sub-microsecond. Racing two real MCP server PROCESSES for this
// (spawn, IPC round trip, JSON parsing) introduces jitter many orders of
// magnitude larger than the window itself, so a process race here would
// pass or fail on luck, not prove anything either way. Per the lead's
// standing preference on todo 345, this test instead asserts the
// conditional write's WHERE clause directly: it calls getPadMeta and
// bumpPad exactly as two raced sessions would, with the state that a real
// interleaving would produce constructed on purpose instead of chased.
//
// PROVEN RED against the pre-fix bumpPad (WHERE id = ? only, no RETURNING):
// the first assert.throws below failed because session B's write silently
// succeeded, and the trailing content assertion failed because B's content
// had overwritten A's. Output pasted in the PR body.
```

## line 48

```
// Both sessions read while the pad is still at revision 1 - the state
// that exists right up until either writer's UPDATE commits.
```

## line 55

```
// Session A's write lands first.
```

## line 59

```
// Session B's write is built from ITS OWN read, taken before A wrote -
// exactly the interleaving above. It must now be rejected rather than
// silently overwriting A's write.
```

## line 88

```
// Fix round 1, counselors: this test's original form (two bare
// unconditional bumps in a row, asserting the second returns 3) cannot
// discriminate what its own name claimed. Two sequential calls in one
// process never construct a "stale" number at all - nothing here ever
// reads a revision and holds onto it while something else changes the
// row, so "stale+1" and "the true value" are the same number by
// construction and would agree even if bumpPad's RETURNING were reverted
// to some other computation entirely. Renamed to what it actually shows
// (ordinary sequential correctness), kept because it is still real
// coverage of the RETURNING path, and paired below with a version that
// actually discriminates.
```

## line 103

```
// Two unconditional bumps in a row, as pad_append with no
// expected_revision would issue.
```

## line 114

```
// "Stale" knowledge, captured early - what a caller relying on an
// earlier read (or a bumpPad implementation that computed its return
// value as thisRevision + 1 instead of reading RETURNING) would believe
// the revision to be for the call under test below.
```

## line 121

```
// An intervening write neither the caller nor staleRevision above has
// any knowledge of. True revision is now 2.
```

## line 125

```
// The call under test. staleRevision + 1 (2) and the row's true
// post-write revision (3) are now DIFFERENT numbers, which is exactly
// what the original version of this test never constructed - two
// sequential calls with nothing else running between them can never
// produce a disagreement to catch.
```
