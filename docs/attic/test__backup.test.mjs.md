# Attic: test/backup.test.mjs

Comments removed from `test/backup.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 13

```
// A race child runs from a scratch tmp directory with no node_modules above
// it, so the bare specifier "better-sqlite3" would not resolve there; this
// is the same package resolved by absolute path instead.
```

## line 18

```
// Issue #23. This is the mechanism on its own: no tmux, no server, no CLI.
// db.js resolves its file from HIVE_DATA_DIR at import time; point it at a
// scratch dir before the dynamic import, same as migrations.test.mjs.
```

## line 23

```
// PR #36, B5. This is the most destructive file in the suite: it closes the
// live db connection, replaces hive.db out from under it, and rmSync's
// profiles/. Prove the store is scratch before any of that happens, not
// after, same as every other destructive test file (see state-log.test.mjs).
```

## line 56

```
// The failure this issue exists to prevent: a plain file copy of the
// WAL-mode main file, read back with a fresh connection.
```

## line 76

```
// Same rewind trick as migrations.test.mjs, pinned to a specific version
// number rather than MAX(version): migrations are append-only, so a
// version number is a stable handle across the next one landing.
// Version 6 (agent_state_log) is the current last entry. backup_meta is
// NOT touched here (PR #36, B2): it is bootstrapped unconditionally in
// migrate(), not created by a MIGRATIONS entry, precisely so rewinding
// the last real migration can never take it away.
```

## line 97

```
// A real, separate scratch store: this races two actual OS processes,
// which sequential calls on one connection cannot substitute for (the
// first call always finishes before the second's code even runs, so it
// hides exactly the gap this bug lived in). Both start from a fresh
// store, so both see every migration pending - the real trigger PR #36
// reported: several hive processes starting together right after an
// upgrade, each reading the same "nothing applied yet".
```

## line 114

```
// Both processes must agree on one fully-migrated, uncorrupted store:
// this is the regression check, since the pre-fix code let the second
// process re-run already-applied SQL (e.g. CREATE TABLE backup_meta a
// second time) and throw out of migrate() with nothing to catch it.
```

## line 127

```
// A one-off two-script race, unlike raceProcesses: this needs one process
// HOLDING the write lock while a DIFFERENT script tries to migrate, not two
// copies of the same script. Written to a scratch file the same way
// raceProcesses does internally, so no shared helper needs to change shape
// for a single asymmetric case.
```

## line 157

```
// C1 on B1's own fix: BEGIN IMMEDIATE still only waited on the 5s
// busy_timeout. A migration slow enough to run past it - plausible
// applying several at once, exactly what an upgrade on a second machine
// does - left .immediate() throwing SQLITE_BUSY straight out of
// migrate(), the identical failure B1 removed, reached a different way.
```

## line 165

```
// Bootstrap first so the store and its schema already exist; this test
// is about contending for the write lock, not about applying migrations.
```

## line 173

```
// Holder grabs BEGIN IMMEDIATE first and keeps it for 6.5s - longer
// than one 5s busy_timeout window. The migrator starts waiting on the
// lock well before the holder releases it, so succeeding REQUIRES a
// second attempt; a single .immediate() call throws once its own
// busy_timeout expires, seconds before the holder lets go.
```

## line 206

```
// PR #36, B3 (folds in an earlier fix for the same directory-name race).
// Sequential calls, even on separate connections, cannot reproduce this:
// takeSnapshot's own candidate-name search only advances past n=0 when a
// name is ALREADY taken, so two calls in a row on one process just find the
// second slot free and never collide. The actual bug needed two racers
// computing the SAME candidate at the SAME instant, which needs real,
// separately-scheduled processes - and, to make it deterministic rather
// than hoping for a millisecond coincidence, an identical forced `now`.
```

## line 237

```
// The regression: BOTH completed snapshots must still exist and be
// readable, each with its own marker row. Against the pre-fix
// check-then-mkdirSync(recursive) code, the loser's failure handler
// would rmSync the winner's directory out from under it - this reads
// both back with fresh connections, not just checking a path exists.
```

## line 251

```
// Issue #41 half A: a snapshot's backup_meta used to record the store's
// history as of the moment BEFORE that snapshot's own completion, so a
// restored store always understated its backup history by exactly one
// backup. takeSnapshot now writes this snapshot's own success into the
// STAGED copy, before the rename - provable from the snapshot alone.
```

## line 259

```
// The live row is left deliberately stale (no success, a real prior
// failure) so the assertions below can only be explained by half A's own
// write landing inside the snapshot - not by this test accidentally
// reading through to what the live row already says.
```

## line 267

```
// A fixed `now` well in the past: G2a (PR #42 review) means the row is
// stamped with the VACUUM's actual completion time, not this `now` (`now`
// stays reserved for the directory NAME, the deterministic race fixture
// B6 needs) - so the assertions below check `>=`, not `===`, against it.
```

## line 275

```
// The snapshot's OWN content, read with its own connection - a test that
// only checked the live store could not see this bug at all.
```

## line 294

```
// last_error/last_error_at must survive untouched: a real prior failure
// stays readable after a later success, the same rule agent_state_log
// exists for (CLAUDE.md, issue #24) - deleting it here would be that
// mistake rebuilt one function over.
```

## line 301

```
// Confirms the write really landed in the STAGED copy: this test called
// takeSnapshot directly (not backupNow), so the live row this connection
// still has open must be untouched.
```

## line 306

```
// No stray -wal/-shm sidecar in the finished snapshot directory: VACUUM
// INTO resets journal mode away from WAL, and the connection used to
// write this row never sets it either. G3e (PR #42 review): these two
// checks alone cannot fail - a clean close() removes both regardless of
// journal mode, so every path where they could survive is a path where
// close() itself failed, which a plain existsSync after the fact cannot
// distinguish from "never created". The sidecar this connection can
// actually leave behind, on a rollback journal mode, is -journal; see
// the "issue #41 Group 2" describe block below for that check (G2c) and
// an honest statement of what it does and does not prove.
```

## line 322

```
// Issue #41 Group 2 (PR #42 review, counselors G2a/G2b/G2c): three defects
// in half A's own write, none caught by the round-trip tests above.
```

## line 325

```
// G2b. A truncated or short-written VACUUM INTO output can open FINE
// (sqlite3_open reads no page - confirmed against a real garbage file
// before writing this test) and only throw once something actually reads
// a page, which half A's own UPDATE is the first thing in this module to
// do. That NOTADB/CORRUPT is proof the copy is unrestorable and must fail
// the snapshot, not be swallowed as ordinary bookkeeping noise.
//
// Exercised through the real public API, not by reaching into takeSnapshot
// internals: `db` is only ever used for one call, `db.prepare("VACUUM INTO
// ?").run(path)`, so a fake object satisfying just that shape can make a
// "vacuum" write garbage to the target path instead of doing a real one.
```

## line 349

```
// The other half of G2b's "keep it narrow" instruction: a missing
// backup_meta table (a valid, empty SQLite file - confirmed this throws
// SQLITE_ERROR "no such table", NOT NOTADB/CORRUPT, before writing this
// test) says nothing about whether the COPY is restorable. It must still
// be published; widening the G2b catch to "any error fails the backup"
// would let this destroy an otherwise-good snapshot, a worse bug than the
// one G2b fixes.
```

## line 360

```
// a valid, empty SQLite database
```

## line 372

```
// G2c regression pin, and an honest statement of its limits (the pad's own
// instruction: say what it would take for a test to pass while the
// behaviour is broken). This pins the HAPPY path only: a normal write
// followed by a clean close() never leaves a -journal sidecar. It does
// NOT independently force the scenario G2c's runtime check actually
// guards against - a hard interrupt (crash or power loss) mid-write,
// which would need to kill the process at a specific sub-millisecond
// point inside a single UPDATE statement, not reproducible deterministically
// from a unit test. The runtime check in takeSnapshot is what protects
// against that; this test only protects against a future change (e.g.
// switching this connection to WAL or PERSIST journal mode) silently
// starting to leave a journal behind on the ordinary path.
```

## line 395

```
// PR #36, C3: last_success_at is a historical record, not proof anything is
// still on disk. Deleting backups/ right after a real success used to leave
// doctor reporting "All good" over an empty directory.
```

## line 410

```
// Issue #41 Group 1 redesign (PR #42 review, G1a-G1d): backupHealth now
// judges freshness and "has a backup succeeded" from the snapshots on disk,
// not from last_success_at, and reserves the row for what only the row
// knows (a recorded error). This replaces the earlier half B branch, which
// trusted the disk for the optimistic case only.
```

## line 422

```
// Simulate a pre-half-A snapshot restored onto the live store, or one
// installed by hand with cp: a real, fresh, restorable snapshot sits in
// backups/, but last_success_at reads NULL because the row is missing or
// stale. This must read healthy because the SNAPSHOT is fresh, not
// because of anything the row says.
```

## line 435

```
// Reuses the same "last success <ts>" wording as every other ok verdict
// (the pad: do not invent a second phrasing for the same condition), now
// sourced from the snapshot's own directory timestamp rather than the
// (NULL) row.
```

## line 445

```
// C3's case, generalized rather than relaxed: zero snapshots must still
// FAIL regardless of what the row says.
```

## line 455

```
// G1a, the exact asymmetry the lead reproduced against a scratch store: an
// OLD but still-listed snapshot with success NULL used to read healthier
// than the identical snapshot with success recorded, because only the
// null branch ever consulted the disk. Under the redesign both must FAIL,
// since neither reads last_success_at from the LIVE row at all any more -
// freshness comes from MAX(the snapshot's own directory name, the
// SNAPSHOT'S OWN row's last_success_at), never the live row.
//
// The SNAPSHOT's own row has to be poisoned too, not just the live row:
// takeSnapshot's G2a write always uses the REAL clock for last_success_at
// (deliberately - completedAt can never be older than the vacuum it
// measures), so passing an ancient `now` only ages the DIRECTORY name.
// A genuinely 59-day-old snapshot would have its OWN row agree with its
// directory (both captured 59 days ago, in the same real operation); a
// test simulating "old" has to make the same two values agree by hand.
```

## line 502

```
// Found while implementing this redesign, not in the pad. The directory
// name is the snapshot's START time (captured before VACUUM INTO,
// deliberately - B6 needs it fixed for the race test), not its
// completion. Reproduced concretely before writing this fix: a live-row
// failure timed to land DURING a simulated long vacuum - after the
// directory name's `now` but before the snapshot's own row is written -
// used to make backupHealth report FAIL even though the snapshot's own
// row (G2a's real completion time, always captured after the vacuum
// returns) proves that exact failure was resolved. A large VACUUM INTO
// can run long enough for a DIFFERENT server to record a failure in that
// window, and the directory name alone cannot see past it - the fix takes
// MAX(directory name, the snapshot's own row) rather than the directory
// name alone.
```

## line 518

```
// Simulates a vacuum that has been running for 2 seconds: the directory
// name is 2 seconds old. A different server's failure lands 1 second
// ago - after the directory name's `now`, but before this snapshot's
// own row gets written (which always uses the REAL completion time).
```

## line 541

```
// G1d: a directory whose name matches the pattern but has no hive.db
// inside (an interrupted prune, or a partial hand `cp`) must not be named
// as restorable. listSnapshots must still SEE it (retention needs to sweep
// it), but backupHealth must not point an operator at it.
```

## line 552

```
// Confirms listSnapshots still sees it by name (retention's contract) -
// the fix scopes restorability to backupHealth, not to listing.
```

## line 561

```
// G3d, re-derived against the redesign: the branch ORDER is what makes
// this correct, and nothing else pins it. A real, more-recent-than-any-
// snapshot failure must still FAIL doctor even though a restorable
// snapshot exists - checking "is there a snapshot" before "did the most
// recent attempt fail" would report ok on a store whose backups are
// failing right now.
```

## line 578

```
// A NEW failure, strictly after the snapshot just taken. Delegates every
// other statement to the real connection so backupNow's own error
// bookkeeping still lands on the live row; only "VACUUM INTO" fails.
```

## line 606

```
// Issue #39/#41 half C: backup_meta timestamps are now millisecond-resolution
// (SQL_NOW in src/backup.ts), specifically so a failure and a success inside
// the same wall-clock second can be ordered. At second resolution these two
// events used to write identical strings and be unorderable - the original
// #39 report.
```

## line 612

```
// The shared second has to be a REAL recent one, not a fixed past date:
// backupHealth's staleness check (last N days) would otherwise fail these
// for being too old, which is a different branch than the tie-break this
// describe block exists to pin.
```

## line 618

```
// G3c (PR #42 review): the first version of these two tests hand-wrote
// BOTH last_error_at and last_success_at as fixtures and asserted
// backupHealth's verdict, so the only code they actually touched was the
// pre-existing JS >= comparison - reverting SQL_NOW to plain datetime('now')
// everywhere still left them green. They also predate Group 1's redesign,
// under which backupHealth compares last_error_at against
// MAX(the newest snapshot's directory name, that snapshot's OWN
// last_success_at) rather than the live row's last_success_at at all.
//
// These two pin the snapshot's own row DIRECTLY, rather than relying on
// takeSnapshot's injected `now` to control the comparison value: `now`
// only sets the directory name, and the MAX means the real, uncontrolled
// completedAt (G2a - always the actual clock, however long the vacuum
// takes) can pull the comparison value later than intended. Measured
// while writing this: under load, from the rest of the suite running,
// completedAt landed past the injected .900 boundary and flipped one of
// these from failed to resolved. Poisoning the row directly removes that
// dependency on real timing.
//
// Todo 102(a), 2026-07-30: pinning the row closed only HALF of it, and the
// other half made the second test below flake at ~7% (4 failures in 60
// full-suite runs; 3 in 25 the day before). MAX(directory name, own row)
// has two uncontrolled inputs, not one. Pinning the row LOW - which the
// second test must do, since it needs the failure to be the later event -
// means the row loses the MAX and the DIRECTORY NAME becomes the
// comparison value. That name comes from takeSnapshot's `now`, which
// defaults to the real clock (src/backup.ts:199, formatted at :26), read
// after recentSecond() has already fixed `sec`. Under load the gap grows
// past the leftover milliseconds before the hardcoded .900 and the failure
// reads as resolved. So `now` IS injected below, and both inputs to the
// MAX are controlled. The first test never flaked because a late name only
// pushes it further toward its expected true; that asymmetry is why this
// survived the fix above. Product code is correct in every observed run.
```

## line 656

```
// A real failure recorded earlier in this second.
```

## line 660

```
// A snapshot whose OWN row is pinned to land LATER in the exact same
// second: at second resolution these would have been indistinguishable
// and tied - the original #39 report.
```

## line 683

```
// The .000 name loses the MAX to the .100 row below, so the comparison
// value is pinned at .100 regardless of how long this takes to run.
```

## line 703

```
// G3c's other ask: drive at least one of these through REAL writes, not
// hand-typed fixtures, so SQL_NOW itself is actually exercised on both
// sides. Measured while writing this test: two real backupNow calls with
// truly no delay between them can land in the IDENTICAL millisecond on
// this hardware (both writes read 658 in one run), which the >= tie-break
// correctly reads as still-failed - the conservative, intended behaviour,
// but it means "back-to-back" alone does not reliably exercise the
// orderable case this test exists to pin. A short busy-wait guarantees a
// different millisecond while staying overwhelmingly likely to remain in
// the same wall-clock SECOND, which is the actual case under test.
```

## line 720

```
// A REAL forced failure (backups/ is a plain file) through backupNow's
// own SQL_NOW write.
```

## line 730

```
// Guarantee at least one millisecond has elapsed - see the comment
// above this test.
```

## line 756

```
// G3c: the earlier version of this test never checked last_error_at's
// OWN format, so leaving its write on plain datetime('now') would have
// kept the suite green while a same-second failure-after-success stayed
// misordered.
```

## line 791

```
// PR #36, B7: a future last_attempt_at (clock skew, or a restored snapshot
// carrying one) must not wedge the claim shut for as long as the skew
// lasts. The guard fails open toward taking a backup.
```

## line 804

```
// Force takeSnapshot to fail: make the backups directory a file, so
// mkdirSync(parent, {recursive:true}) for the staging directory throws.
```

## line 812

```
// At this point backups/ is a plain file, not a directory, so there is
// no restorable snapshot at all - this hits the same "nothing to
// restore from" branch as the zero-snapshot case (C3), not specifically
// the failedMostRecently branch. Group 1's "a real failure more recent
// than the newest snapshot still FAILs" case (G3d, above) is what pins
// failedMostRecently directly, with a real snapshot present.
```

## line 820

```
// Recovery (PR #36, B9): fix the fault and let a later attempt succeed.
// last_error/last_error_at must NOT be cleared - the evidence that a
// backup failed at some point must survive a later success, the same
// "a state that corrects itself still has to be readable afterwards"
// rule agent_state_log exists for (see CLAUDE.md, issue #24).
//
// last_error_at is backdated here: datetime('now') is second-granularity
// and this whole test runs in under a millisecond, so the upcoming
// success could otherwise land in the SAME second as the failure above,
// and backupHealth's tie-break (see its comment) treats that as still
// failed - correctly, but it would make this specific assertion flaky
// rather than pinning the genuinely-recovered case it exists to check.
```

## line 846

```
// D1/D2 regression pin (PR #42 review, deliberately deferred - see the
// comment on SQL_NOW): during a rolling upgrade, an OLD server still
// running second-resolution code can write a last_attempt_at with no
// millisecond component. This is the SAFE direction of that residual - a
// second-resolution value read by the NEW (millisecond-aware) code - and
// it is the only direction testable from this branch: the unsafe
// direction needs an OLD process actually running old code, which nothing
// here can reproduce. A second-resolution value inside the CURRENT second
// must not be misjudged as "in the future" by claimStatement's third
// disjunct, which would double-fire the hourly claim.
```

## line 869

```
// PR #36, B4: the previous version of this test called maybeBackupHourly
// twice sequentially on ONE connection. Sequential calls on one connection
// cannot reproduce a check-then-act race - the first call always finishes
// (including its own UPDATE) before the second's code runs at all - so a
// hypothetical SELECT-then-UPDATE implementation would have passed that
// test exactly as well as the atomic UPDATE actually shipped. Real,
// separately-scheduled processes are what a "does not double-fire" claim
// has to survive; this also holds regardless of how the two processes
// happen to interleave, since the second one - whenever it runs - re-reads
// last_attempt_at fresh and finds it claimed either way.
```

## line 917

```
// Fixed, not read from the clock (PR #36, B6): the previous version used
// `new Date()` for both the fake snapshots AND (separately, inside
// pruneSnapshots, at call time) the retention cutoff. Those are two
// different instants that happen to agree on which calendar date "12
// hours ago" falls on for most of the day and disagree right at
// 12:00Z, so the test passed or failed depending on what time it
// happened to run - and adjusting the fake offsets would only move the
// flip to a different hour, not remove it. A fixed instant, threaded
// into pruneSnapshots as its `now`, makes both sides agree always.
```

## line 929

```
// Ten recent snapshots, same day, all within "last N".
```

## line 931

```
// One older snapshot per day for 10 days back, outside "last N" but some
// inside the daily-retention window.
```

## line 944

```
// PR #36, B8: a misconfigured policy must never be able to delete every
// snapshot, including the one backupNow just created.
```

## line 959

```
// PR #36, C2: cmdRestore's pre-restore backup names its restore TARGET as
// `protect`, precisely so retention can never be the thing that deletes
// the snapshot the operator just confirmed. This pins the mechanism
// directly: an old snapshot, protected, must survive a policy that would
// otherwise evict it on both counts (outside keepLast, outside the daily
// window).
```

## line 976

```
// PR #36, C4: a SIGKILL during a large VACUUM INTO leaves a .staging-*
// directory that listSnapshotRefs and retention both ignore forever
// (parseSnapshotDirName rejects the name on purpose), so it could fill
// the disk and make every later backup fail. Retention now sweeps them,
// bounded by age so a genuinely still-running backup's own staging
// directory is never mistaken for abandoned.
```

## line 1002

```
// Self-contained: start from an empty backups/ rather than depending on
// what earlier describes left behind (retention's synthetic snapshots).
```

## line 1016

```
// Destroy: the exact disaster class this issue exists to survive (#22's
// wrong-store DELETE, or any other data loss).
```

## line 1023

```
// The live connection has to close before its file gets replaced.
```

## line 1028

```
// Read back with a fresh connection: this is the "reads the rows back"
// half, not a check that a file merely appeared.
```

## line 1040

```
// PR #36, S3: profiles/ used to be restored with rmSync-then-cpSync, the
// exact remove-then-copy shape the comment above restoreSnapshot rejects
// for hive.db, just for profiles/ instead. A failure mid-copy used to
// leave the user's overrides gone and a partial tree in their place.
```

## line 1051

```
// A connection of this test's own, independent of the shared `db` used
// elsewhere in this file: this test closes its connection to restore
// (restoreSnapshot's own requirement), and the shared `db` must stay
// open for whatever else in this file still needs it.
```

## line 1060

```
// Change the live profile after the snapshot, and add a file that must
// NOT survive restore - proving this is a full swap, not a merge.
```

## line 1078

```
// No staging or set-aside-old directories left behind on success.
```

## line 1083

```
// PR #36, C5: a prior crash between the two renames leaves profiles.old/
// as the only surviving copy and live profiles/ missing. Restoring a
// snapshot that has NO profile data of its own must still recover that
// copy - not silently skip recovery just because this particular restore
// was not going to touch profiles/ anyway.
```

## line 1095

```
// A snapshot with no profiles/ of its own (the live store has none at
// backup time).
```

## line 1102

```
// Simulate the crash: profiles.old/ holds the only surviving copy,
// live profiles/ is missing, exactly the state a crash between the two
// renames in restoreSnapshot leaves behind.
```

## line 1120

```
// Issue #41 round trip: halves A/B/C and Groups 1/2 unit-tested their own
// function in isolation above. This describe block is the thing the issue
// was actually filed about - a REAL restoreSnapshot() call, then
// backupHealth read against the store that restore left behind - for all
// three verdicts the one defect produced. Each test opens its own local
// connection rather than the shared top-level `db` module import: the last
// describe block above already closed it, and restoreSnapshot needs the
// file free anyway.
//
// G3a/G3b (PR #42 review): the first version of these three tests could not
// fail. Case 1 asserted only health.ok, and half B's OLD null-success branch
// also returned ok, so the test named for half A passed while pinning half
// B instead. And none of the three proved they were reading RESTORED state:
// each called backupNow and restored immediately, so the LIVE row was
// already in the asserted shape before restoreSnapshot ever ran - a
// no-op restoreSnapshot would have passed all three. Every test below now
// POISONS the live row (or, for case 2, the SNAPSHOT's own row) between
// taking the backup and restoring it, to a value the assertions below would
// fail against - so passing requires the restore to have genuinely replaced
// that content, not merely left an already-correct row untouched - and
// reads the actual ROW content, not only backupHealth's boolean verdict.
```

## line 1145

```
// Genuinely first-ever: no success recorded before this backup at all.
```

## line 1153

```
// G3b: poison the LIVE row AFTER taking the backup, BEFORE restoring.
// If restoreSnapshot were a no-op, a fresh read below would see this.
```

## line 1166

```
// G3a: read the ROW, not just the verdict. Under Group 1's redesign,
// backupHealth judges freshness from the snapshot's own DIRECTORY
// timestamp, not from last_success_at - so a healthy verdict alone no
// longer proves half A's write happened at all; it would read healthy
// purely because the snapshot file is fresh and restorable, regardless
// of what its row says. This asserts half A's actual contract directly.
```

## line 1195

```
// A real, fresh snapshot, taken right now.
```

## line 1200

```
// Poison the SNAPSHOT'S OWN row directly, not the live row: simulate a
// row that is OLDER than the directory itself is fresh - the general
// shape of a pre-half-A or hand-copied snapshot (G1b), where the row
// reflects an earlier backup's success (or none at all). backupHealth
// takes MAX(directory name, the snapshot's own row) - never the row
// alone - specifically so a row like this one, which is SMALLER than
// the directory name, cannot drag a fresh snapshot down to stale.
```

## line 1219

```
// G3b: proves the restore actually happened - if restoreSnapshot were a
// no-op, the live row would still show the FRESH value backupNow just
// wrote above, not this poisoned ancient one.
```

## line 1241

```
// Seeded explicitly, per the plan: last_error_at newer than
// last_success_at will not arise on its own. This is a real failure that
// has not been resolved on the live row yet when the snapshot is taken.
```

## line 1248

```
// Taken now, after the failure: half A writes THIS snapshot's own
// success at its own (later, real completion - G2a) timestamp into the
// staged copy, while last_error/last_error_at pass through untouched
// from the live row at vacuum time - proving the failure resolves
// inside the snapshot without being erased.
```

## line 1257

```
// G3b: poison the LIVE row AFTER taking the snapshot, BEFORE restoring -
// a FRESH, unresolved-looking failure that a real restore must wipe out.
```
