# Attic: test/db.test.mjs

Comments removed from `test/db.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 9

```
// Issue #49. restoreSnapshot renames a new hive.db into place, which orphans
// any process that already opened the old one: same path, different inode,
// no error either side. storeReplaced() in src/db.ts is the detection
// primitive - a latched predicate comparing a fresh statSync against the
// inode the process actually opened.
//
// The latch is process-global state, so each scenario below runs in its own
// child process: a single process cannot both prove "false immediately after
// a normal open" and "true and stuck there once tripped" without one
// contaminating the other's starting condition.
```

## line 53

```
// Its own process and its own fixture, not chained after a replace: a
// deletion checked once the latch is already tripped from a prior
// replace never reaches statSync at all (storeReplaced() returns early
// on the latch), so it would never actually exercise the ENOENT path
// this case exists to pin.
```

## line 85

```
// A hard link to the just-migrated file, BEFORE swapping anything:
// a new directory entry pointing at the exact same inode `db` has
// open, not a copy with an inode of its own. cpSync here would give
// "the original restored" a NEW inode, which a broken, non-latched
// implementation (a plain `current !== openedInode` with no latch)
// would read as "back to normal" and pass this test for the wrong
// reason.
```

## line 96

```
// Rename the link back onto dbPath: this is the same inode `db` was
// opened against, restored exactly, not a fresh copy of it. If
// storeReplaced() re-stat'd instead of latching, this would read as
// "unreplaced" again; the latch must keep answering true regardless.
```

## line 109

```
// The false-positive case the issue calls out by name. A rename only
// orphans a process that already had the old file open; a fresh process
// opening whatever is at the path right now commits to THAT inode and
// must read as unreplaced.
```

## line 125

```
// Swap the file out from under it while no process has it open, the same
// way a restart between two sessions would. `mv` between two directories
// on the same filesystem is a real rename, so dbPath ends up with the
// swap file's inode, not its old content rewritten in place.
```
