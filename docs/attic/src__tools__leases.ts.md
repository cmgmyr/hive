# Attic: src/tools/leases.ts

Comments removed from `src/tools/leases.ts` by todo 436, verbatim. Line numbers are
positions in the pre-strip file at fed8064.

## line 22

```
// The row a lease_acquire re-read always MIGHT not find: whatever made it
// worth re-reading (a failed insert, a lost extend race) is itself evidence
// something else is changing this row, and a release can remove it in the
// same window. Both call sites below used to cast one of these two reads
// `as LeaseRow` with no `| undefined` and dereference it unguarded (one of
// the two casts was already guarded, the other was not; this makes both go
// through the one function instead of disagreeing).
//
// Exported for test/lease-acquire-conflict-undefined.test.mjs: proves the
// guard directly rather than racing the couple of statements between a
// failed insert and this read - too narrow for two real processes to land
// in reliably, the same reasoning as extendOwnedLease's own test.
```

## line 40

```
// AND owner = ?, not just project_id/lock_key: between the caller's own
// SELECT (below) and this UPDATE, another actor's lease_acquire can
// purgeExpired this exact row and insert itself as owner. Without the owner
// predicate this UPDATE would still match by key alone and extend THAT
// actor's lease while the caller believes it renewed its own - two actors
// then both hold evidence they own the same key, the one thing a lease
// exists to prevent. Returns false when that race happened (or the lease
// was released outright) instead of reporting a false success.
//
// Exported for test/lease-owner-race.test.mjs: the race window above is a
// couple of synchronous SQL statements wide, too narrow to hit reliably by
// racing two real MCP server processes (their IPC and scheduling jitter
// dwarfs it). The test calls this directly with the row's owner already
// changed out from under it, reconstructing what that race would leave
// behind instead of chasing it live.
```

## line 65

```
// Update is NOT missing here: re-acquiring your own lease extends it in
// place below, so lease_acquire fills both the Create and Update cells the
// way kv_set does for kv. The first pass of #82's matrix left that cell an
// unqualified "none", which read as unclassified; the PR gate caught it.
//
// No lease_read or lease_list (issue #82). A failed acquire below already
// answers "who holds this, until when" through held_by and expires_at, with
// no side effect when the lease is actually contended. It only stops being a
// clean read when the lease is free: acquiring one to check it claims it.
// That gap (a side-effect-free peek, or a project-wide list of every held
// lease) is accepted rather than filed. It has not bitten anyone yet, and a
// caller who wants to check before dispatching a worker into a contended
// area can already do so for the one case that matters: the lease is held.
```

## line 95

```
// RETURNING, not a separate SELECT afterward. A inserts a one-second
// lease and stalls before a follow-up SELECT could run; the lease
// expires, B purges it and inserts its own, and A's SELECT - reached
// only after the stall - reads B's row instead of the one A itself just
// created. A then reports B's future expiry as evidence of its OWN
// acquisition. RETURNING makes the receipt come from the exact row this
// statement inserted, with no later read that could observe a
// replacement. DO NOTHING's conflict branch returns no row, so `.get()`
// returning undefined already tells us whether we won - no separate
// changes count needed.
```

## line 116

```
// We lost the INSERT (some row already existed a moment ago), but a
// concurrent lease_release can remove that exact row before this
// read runs.
```

## line 121

```
// Released between our failed insert and this read - nothing to
// report as held; the caller can just retry lease_acquire.
```

## line 129

```
// Lost the race: `row` is now stale, since another actor's own
// lease_acquire purged and took it between our read above and the
// extend attempt just now. Re-read for who actually holds it.
```
