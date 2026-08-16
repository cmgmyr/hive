---
paths:
  - "src/dataDir.ts"
  - "src/db.ts"
  - "src/backup.ts"
  - "src/result.ts"
  - "src/scheduler.ts"
  - "src/config.ts"
---

# The store, the data dir, and what keeps tests off it

## The data dir is read at call time and cached in exactly one place

`resolveDataDir` is deliberately NOT exported.

Only the COMPARISON canonicalises symlinks. `resolveDataDir` keeps returning the path as the caller named it.

## Test isolation is enforced, not conventional

Three guards hold it up and all three must stay.

- `storeDir()` refuses `~/.hive` outright when a test runner is the entry point.
- `storeDir()`/`guardStoreDir()` also refuse `~/.hive` for any process that is not one of hive's own entry points.
- `test/suite-isolation.test.mjs` reads the suite's own source and fails when a file that can reach tmux does not call `isolateTmux()` at module top level.

None of the three can tell one scratch directory from another, so `assertScratchStore()` still earns its place in a destructive file.

A hand-rolled driver script is invisible to all three guards above. `defaultStoreRefusal()` (`src/dataDir.ts`) closes that gap for the DEFAULT store only; it cannot see a driver targeting a SCRATCH store, which still needs the manual guard below.

```js
process.env.HIVE_DATA_DIR = scratchDataDir;   // BEFORE any dist import
const { db } = await import(join(DIST, "db.js"));
if (!db.name.startsWith(scratchDataDir)) throw new Error(`refusing: opened ${db.name}`);
```

The refusal is the load-bearing half, since the assignment can be defeated by an import that is hoisted above it.

## Migrations are append-only

Never edit an existing entry in `MIGRATIONS`; add a new one.

**A trigger migration adds a standing constraint on every migration after it.** Any future migration that rewrites `scratchpads.content`, `todos.title`/`body`, or `kv.value` for existing rows must stamp `updated_at` in the same `UPDATE` statement, or it aborts against its own trigger. This cannot be relaxed retroactively once a store has applied the migration.

## The store's write lock now also excludes something that is not a store write

Two rules on what may live inside a `withWindowClaim` section:

- **Tmux forks only, and only fast ones.**
- **Never anything that blocks on a human.**

`withWindowClaim` (`src/spawn.ts`) throws on `db.inTransaction` before `db.transaction` is ever entered rather than nesting silently as a no-op savepoint.

Tmux side effects do NOT roll back with the transaction: the lock buys mutual exclusion, not atomicity.

## Restoring a live store orphans every open connection

Read `--force` as "I have accepted this outcome", never as "I am fairly sure nothing is running": it cannot see a `claude` session started outside hive, or one starting in the gap between the check and the overwrite.

`storeReplaced()` in `src/db.ts` latches once tripped and refuses every further call through `run()` (`src/result.ts`) and `src/scheduler.ts`'s `tick()`. Recovery means REPLAYING writes into the new file from a fresh process, then restarting the session.

**Two known residuals, both accepted rather than fixed here**: the open-to-stat startup window, and a CLI process blocked on an interactive prompt (`hive lead`'s `hive.yml` trust prompt, `hive init`) is not guarded. Do not repeat the unqualified "every non-server writer is short-lived" claim without this caveat.

See `.claude/skills/hive-internals` for the incidents, mechanisms, and measurements behind these.
