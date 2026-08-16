# Attic: src/tools/pads.ts

Comments removed from `src/tools/pads.ts` by todo 436, verbatim. Line numbers are
positions in the pre-strip file at fed8064.

## line 34

```
// Pads hold the large blobs in this store; mutations that never touch the
// content skip fetching it. Exported for test/pad-revision-race.test.mjs:
// the real race window is a handful of synchronous SQL statements wide,
// too narrow to hit reliably by racing two real OS processes (their IPC and
// scheduling jitter is milliseconds; the window is sub-microsecond), so that
// test reconstructs the interleaving directly by calling this and bumpPad
// as a deliberately-raced pair of sessions rather than chasing a flaky
// racer - see that file's own comment.
```

## line 46

```
// Shared by checkRevision's early check and bumpPad/deletePad's SQL-level
// guard below, so a caller sees the same sentence whether the mismatch was
// visible from our own read or only showed up in the WHERE clause. `current
// == null` means the row is gone entirely (deleted by a concurrent write
// between our read and this one), which is a different fact than a changed
// revision and gets its own message.
```

## line 70

```
// Shared by bumpPad and pad_delete's own guarded DELETE: both run a
// predicate-conditioned write and need the identical "0 rows changed" throw.
```

## line 78

```
// The friendly PRE-check: rejects early, with a clear message, when the
// caller supplied expected_revision and it already disagrees with our own
// read. This cannot be the actual guard - another write can still land
// between this check and the UPDATE below - so bumpPad's WHERE clause is
// what a concurrent write is actually checked against.
```

## line 97

```
// Every pad mutation bumps the revision and stamps the writer. When
// predicateRevision is given, the UPDATE itself is conditioned on it (`AND
// revision = ?`), so a write that raced in between checkRevision's read and
// this statement makes THIS call a no-op instead of silently overwriting it
// - the actual guard, not just the friendly pre-check above. RETURNING hands
// back the authoritative post-write revision instead of a value computed
// from a stale read, which is also why a caller with no predicate (pad_append
// with no expected_revision, pad_archive) still goes through this path
// rather than a bare .run(): the previous version discarded the write's own
// row count and could report success for zero rows changed. Exported for the
// same test as getPadMeta above.
```

## line 121

```
// pad_append's own content concatenation is safe against the live column, but
// the SEPARATOR used to be decided in JS from `pad.content` AS READ - a
// `joined` variable computed once, well before this statement runs. Two
// sessions both reading content that ends in a newline both decide joined = "",
// and whichever writes second glues its entry onto the first's with no
// separator at all ("alpha\n" + A's "" + "A-entry" landing on top of B's own
// already-appended "alpha\nB-entry" produces "alpha\nB-entryA-entry"). The CASE
// here reads the live `content` column in the SAME statement as the append, so
// there is no read-then-decide step left to go stale - exactly the property
// pad_append already had for the append itself, extended to the separator too.
// Exported so test/pad-append-live-separator.test.mjs exercises the real
// fragment rather than a copy of it.
```

## line 136

```
// Shared with the CLI (hive pad): exact-name lookup among active pads.
```

## line 143

```
// Shared with the CLI (hive pads).
```

## line 157

```
// Shared with the CLI (hive pad --save): revision-guarded overwrite.
// Returns the new revision.
```

## line 170

```
// Shared with the CLI (hive init). Returns null when an active pad already
// holds the name; the partial unique index enforces that race-free.
```

## line 282

```
// getPadMeta, not getPad: content is no longer read in JS at all
// (see APPEND_WITH_SEPARATOR_SET) now that the separator decision
// moved into the write statement itself, so there is nothing left
// here that needs the content column.
```

## line 288

```
// Predicate is the CALLER'S expected_revision, not our own read: the
// append itself concatenates in SQL against the live row, so it never
// clobbers a concurrent change and needs no guard when the caller
// did not ask for one. When they did, the predicate closes the gap
// between checkRevision's read above and this statement. The
// separator is decided in the same statement too (see
// APPEND_WITH_SEPARATOR_SET) - not from `pad.content` above, which
// may already be stale by the time this runs.
```

## line 329

```
// Predicate is ALWAYS our own read revision, expected_revision or
// not: old_text/new_text is computed here in JS against pad.content
// as read above, so a write is lost exactly like pad_write's full
// overwrite would be if this UPDATE were unconditional. An omitted
// expected_revision means the caller stated no expectation, not that
// losing a concurrent write is fine.
```

## line 361

```
// No predicate: archived is a metadata flag, not content, so a
// lost race here at worst flips it back and forth rather than
// destroying anything - out of this fix's scope (issue
// #148 names pads.ts's content-rewriting writes, not this one).
```

## line 394

```
// Predicate is always our own read revision, same reasoning as
// pad_edit: delete is irreversible, so "expected_revision guards
// against deleting a pad someone just updated" (the tool's own
// description) has to hold whether or not the caller passed one.
```

## line 423

```
// Pads hold the large blobs in this store; only pull content when a
// query needs a snippet.
```
