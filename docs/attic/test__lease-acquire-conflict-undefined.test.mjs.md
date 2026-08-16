# Attic: test/lease-acquire-conflict-undefined.test.mjs

Comments removed from `test/lease-acquire-conflict-undefined.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 5

```
// Fix round 1 on todo 345 / issue #148, P2: lease_acquire's conflict-path
// read used to be `.get(...) as LeaseRow`, a non-optional cast, then
// dereferenced unguarded (`row.owner === actor`). A concurrent
// lease_release can remove that exact row between the failed insert
// attempt and this read - a couple of synchronous SQL statements, the same
// order of narrowness as the owner-extend race this same file already
// guards (test/lease-owner-race.test.mjs), and too tight to hit reliably
// by racing two real processes for the identical reason. The fix extracts
// the read into readLease, typed `LeaseRow | undefined` and guarded at
// both of its call sites (this one, and the extend-lost-race re-read a few
// lines down, which was already guarded before this round - the two used
// to disagree).
//
// PROVEN RED against the pre-fix shape: a throwaway repro of
// `.get(...) as LeaseRow` against an empty locks table, then dereferencing
// `.owner`, threw `TypeError: Cannot read properties of undefined (reading
// 'owner')`. Output pasted in the PR body.
```

## line 32

```
// No row for this key at all - the state a release lands the row in,
// reached between a failed insert attempt and the read that follows it.
```
