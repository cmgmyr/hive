---
paths:
  - "src/dataDir.ts"
  - "src/db.ts"
  - "src/backup.ts"
  - "src/result.ts"
  - "src/scheduler.ts"
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

`restoreSnapshot` renames the new file into place, which is atomic and correct, but it cannot reach into a process that already opened the old one. That process keeps its file descriptor, pointing at an inode with no name. Both are `~/.hive/hive.db`, neither errors, and (without the guard below) the orphan is freed when the last descriptor closes, so the work is destroyed at the moment the session ends having looked fine throughout.

`hive restore`'s own refusal reads two live signals, a running `agents` row or a `hive-*` tmux session, and `--force` skips both. Read `--force` as "I have accepted this outcome", never as "I am fairly sure nothing is running": it cannot see a `claude` session started outside hive, or one starting in the gap between the check and the overwrite.

**Issue #49: an MCP server now detects this itself and refuses, rather than silently continuing.** `storeReplaced()` in `src/db.ts` records the inode `db` opened right after `new Database`, and a fresh `statSync` on every call compares against it - once tripped it latches, since the answer cannot change back. Two guarded entry points cover the server's whole write surface: `run()` in `src/result.ts`, the choke point every registered tool routes through (pinned by `test/tool-registration.test.mjs`, which scans `src/tools/*.ts` and fails if a future tool's handler does not call it), refuses every call, reads included, and names the remedy (restart the session). `src/scheduler.ts`'s `tick()` checks the same predicate and, if tripped, stops permanently rather than throwing (`CLAUDE.md`'s "the scheduler must never throw" holds) - an orphaned scheduler's harm is not the store, it is typing a stale wake into a live tmux pane as a real user turn.

Manual diagnosis is now the fallback, useful for a server predating this guard or when reading the situation from outside a poisoned session: `stat -f %i ~/.hive/hive.db` against the inode in `lsof -c node | grep 'hive.db$'`. Disagreeing inodes are the diagnosis. Recovery means REPLAYING writes into the new file from a fresh process, then restarting the session.

**Two known residuals, both accepted rather than fixed here.**

- **The open-to-stat startup window.** `storeReplaced()`'s baseline is read right after `new Database`, not atomically with the open itself. A rename landing in that gap makes the new process record the NEW inode as its own baseline, so it never sees a mismatch for a replacement it never actually observed - the failure mode is silent, same as with no guard at all, not worse. The clean fix needs `fstat` on the open descriptor, which better-sqlite3 does not expose. Module-load code already carries two documented startup races (see `db.ts`'s WAL-conversion retry); adding a retry loop here for a narrower window than either of those was judged not worth the risk of breaking every hive process at startup over a residual that is no worse than the pre-#49 baseline.
- **A CLI process blocked on an interactive prompt is not guarded.** The claim elsewhere in this codebase that every non-server writer is short-lived, and therefore cannot hold a stale inode across a restore, has exactly one exception: `hive lead`'s `hive.yml` trust prompt and `hive init` open the store at load and write after a prompt that blocks on a human, so that process genuinely can span a restore. Known and unfixed; do not repeat the unqualified "every non-server writer is short-lived" claim without this caveat.
