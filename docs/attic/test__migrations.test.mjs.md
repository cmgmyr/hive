# Attic: test/migrations.test.mjs

Comments removed from `test/migrations.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 6

```
// The one path in the name-uniqueness work the rest of the suite cannot see:
// what a store that ALREADY holds duplicate running names does when the
// unique index arrives. Creating that index over violating rows fails, so the
// migration renames the losers first, and a failure here would surface as a
// store that cannot be opened at all.
//
// db.js resolves its file from HIVE_DATA_DIR at import time, so point it at a
// scratch dir before the dynamic import. No tmux, no server, no agents: this
// is the schema on its own.
```

## line 21

```
// The version in MIGRATIONS that creates INDEX. Pinned by number rather than
// found with MAX(version), which is what this used to do and which quietly
// meant "whatever migration was added most recently". The next migration to
// land broke all three tests here: the rewind forgot THAT version instead,
// migrate() replayed its CREATE TABLE against a table that was still there, and
// the index this file exists to test was never recreated. Migrations are
// append-only, so a version number is a stable handle and MAX is not.
```

## line 30

```
// Rewind to the state a store was in before that migration existed. It adds
// exactly one index and mutates data, so dropping the index and forgetting the
// version reproduces the old store faithfully. Rewinding beats hand-writing the
// old schema, which would silently drift from db.ts.
```

## line 75

```
// Differs only by case, which the index folds together, so it is a
// duplicate too even though a plain string comparison says otherwise.
```

## line 79

```
// A closed row by a running row's name is not a conflict; the index is
// partial for exactly this reason.
```

## line 82

```
// Names are unique per project, not per store.
```

## line 94

```
// The lowest id keeps the name it was spawned with; a lead's muscle
// memory for the original worker still lands on the original worker.
```

## line 97

```
// The other project is untouched: it never violated anything.
```

## line 106

```
// The renamed rows are addressable again rather than colliding forever.
```

## line 117

```
// Issue #15, counselors round: without this, the suite would pass exactly as
// well if archived_at had been added by EDITING migration 1 and omitting the
// v11 entry entirely - fine for a fresh scratch store (which is all every
// other test here uses), even though every real v10 store would then never
// gain the column at all. This is the append-only invariant itself, pinned.
```

## line 124

```
// Same rewind technique as rewindOneMigration above, applied to an ADD
// COLUMN instead of a CREATE INDEX: drop the column (DROP COLUMN needs
// SQLite 3.35+; better-sqlite3 here bundles 3.53) and forget the version, so
// the next migrate() call replays the exact ALTER TABLE a real v10 store
// would run, rather than a hand-written approximation that could drift from
// db.ts.
```

## line 157

```
// Every other column on the pre-existing row survives untouched - the
// append-only invariant itself: v11 must be purely additive, not a
// rewrite of a row's own data.
```

## line 167

```
// Not MAX(version): that only ever meant "v11 was applied" while v11
// happened to be the newest migration that existed. Todo 309 added a
// v12 (dashboard_meta) that this rewind never touches - v12 stays
// recorded as applied throughout, so MAX(version) reads 12 here
// regardless of whether v11's own replay worked, and would keep reading
// as whatever the newest migration is forever after, silently stopping
// this assertion from checking anything. What the test actually means -
// v11 itself got applied via its own real replay, not skipped - is a
// membership check, not a maximum.
```
