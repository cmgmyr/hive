# Attic: test/backup-tick.test.mjs

Comments removed from `test/backup-tick.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 8

```
// PR #36, B4 (the third item): the containment claim this whole lane rests
// on - a broken backup path must never cost a due wake-up its delivery - had
// no test. Both existing per-tick jobs (janitor, pruneStateLog) are already
// proven independent of tmux answering or of each other; this is the same
// proof for maybeBackupHourly, done for real rather than by reading the
// try/catch and trusting it.
```

## line 20

```
// This file writes timer and backup_meta rows directly. Prove the store is
// scratch before opening it, not after.
```

## line 59

```
// Force maybeBackupHourly to both attempt (eligible: last_attempt_at
// cleared) and fail (backups/ is a plain file, so mkdirSync for the
// staging directory throws) during the tick this test drives.
```

## line 69

```
// tick() awaits delivery internally (fireDelay claims the timer, setting
// fired_at, then awaits deliver()), so this is synchronously true the
// moment tick() resolves - no polling needed.
```
