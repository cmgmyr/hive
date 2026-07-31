---
paths:
  - "src/dataDir.ts"
  - "src/db.ts"
  - "src/backup.ts"
---

# The store, the data dir, and what keeps tests off it

One of these was broken on 2026-07-28 and destroyed every `agents` and `timers` row in the developer's live store. Each is enforced by code and pinned by a test.

## The data dir is read at call time and cached in exactly one place

`src/dataDir.ts` used to hold it in a module-level `const`, which resolved once at that module's first load. A static `import` of a `dist/` module at the top of `test/helpers.mjs` was hoisted above the line setting `HIVE_DATA_DIR`, so the const had already taken `~/.hive`, `dist/db.js` agreed with it, and the suite's `DELETE FROM timers; DELETE FROM agents;` ran against the live store.

It now reads the env when asked and caches nothing, so importing a module no longer decides the store for a process that has not opened one.

Be precise about what that does NOT fix: `src/db.ts` still opens the database in its module body, so importing `db.js` is itself the act of choosing a store. That is the remaining debt. `db.ts` keeping a `const` is fine, because it only writes down a commitment the module already made.

`resolveDataDir` is deliberately NOT exported. It is `storeDir()` with the refusal removed, and exporting it would put the one call that reintroduces this whole class of bug into the public API, shorter than the guarded one and reading more obviously correct.

Only the COMPARISON canonicalises symlinks. `resolveDataDir` keeps returning the path as the caller named it, because that string also builds brief and posture files, and rewriting it to `/private/var` on macOS changes paths callers hand back to hive.

## Test isolation is enforced, not conventional

`CLAUDE.md` used to assert "real data stays untouched" as a property. That was a convention held up by every author remembering a rule, and it was false on the day it mattered. Two guards hold it up now and both must stay.

- `storeDir()` refuses `~/.hive` outright when a test runner is the entry point, keyed on `NODE_TEST_CONTEXT`. That is an env var, so it crosses into every process the suite spawns, and a file that never sets `HIVE_DATA_DIR` fails loudly instead of writing to a live store. It throws for mid-command callers; `db.ts` uses `guardStoreDir()`, which prints and exits for the same reason `guardAbi()` does, since a throw out of an ESM module body arrives as a stack trace with hive's sentence buried in it.
- `test/suite-isolation.test.mjs` reads the suite's own source and fails when a file that can reach tmux does not call `isolateTmux()` at module top level.

Neither can tell one scratch directory from another, so `assertScratchStore()` still earns its place in a destructive file. `test/store-isolation.test.mjs` reproduces the original mistake and pins all of it. The rest of the suite's rules are in `test/CLAUDE.md`.

A symlink pointing at `~/.hive` is the case that defeats both guards at once, which is why the comparison follows symlinks: `storeDir()` would not refuse it under a test runner, and `untrustedTmuxServer()` would read "scratch store" and let a private tmux server write pane ids into the live database.

## Migrations are append-only

Never edit an existing entry in `MIGRATIONS`; add a new one. A snapshot is taken before any pending migration runs, which is one of the two backup triggers.

## Restoring a live store orphans every open connection

`restoreSnapshot` renames the new file into place, which is atomic and correct, but it cannot reach into a process that already opened the old one. That process keeps its file descriptor, pointing at an inode with no name. Both are `~/.hive/hive.db`, neither errors, and the orphan is freed when the last descriptor closes, so the work is destroyed at the moment the session ends having looked fine throughout.

Detect it in two commands: `stat -f %i ~/.hive/hive.db` against the inode in `lsof -c node | grep 'hive.db$'`. Disagreeing inodes are the diagnosis. Recovery means REPLAYING writes into the new file from a fresh process, then restarting the session.

The refusal that prevents this reads two live signals, a running `agents` row or a `hive-*` tmux session, and `--force` skips both. Read `--force` as "I have accepted this outcome", never as "I am fairly sure nothing is running".
