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

One of these was broken on 2026-07-28 and destroyed every `agents` and `timers` row in the developer's live store. Each is enforced by code and pinned by a test.

## The data dir is read at call time and cached in exactly one place

`src/dataDir.ts` used to hold it in a module-level `const`, which resolved once at that module's first load. A static `import` of a `dist/` module at the top of `test/helpers.mjs` was hoisted above the line setting `HIVE_DATA_DIR`, so the const had already taken `~/.hive`, `dist/db.js` agreed with it, and the suite's `DELETE FROM timers; DELETE FROM agents;` ran against the live store.

It now reads the env when asked and caches nothing, so importing a module no longer decides the store for a process that has not opened one.

Be precise about what that does NOT fix: `src/db.ts` still opens the database in its module body, so importing `db.js` is itself the act of choosing a store. That is the remaining debt. `db.ts` keeping a `const` is fine, because it only writes down a commitment the module already made.

`resolveDataDir` is deliberately NOT exported. It is `storeDir()` with the refusal removed, and exporting it would put the one call that reintroduces this whole class of bug into the public API, shorter than the guarded one and reading more obviously correct.

**Issue #81's `src/config.ts` is a second consumer of this reasoning, not a special case.** `attachMode()`/`setAttachMode()` resolve `storeDir()` inside the function body on every call, for the identical reason `dataDir.ts` does. One place it diverges deliberately: a config READ (an absent or malformed `config.json`) never throws, defaulting instead, because a config read must not be the thing that breaks a tmux attach. `storeDir()`'s OWN refusal (the test-isolation guard right above) is not folded into that default -- it is left outside the try in `readConfig()` so it still reaches the caller, the same as it already does on the write side. Swallowing it too would make a misconfigured test process read a silent default instead of the loud failure this guard exists to give it.

Only the COMPARISON canonicalises symlinks. `resolveDataDir` keeps returning the path as the caller named it, because that string also builds brief and posture files, and rewriting it to `/private/var` on macOS changes paths callers hand back to hive.

## Test isolation is enforced, not conventional

`CLAUDE.md` used to assert "real data stays untouched" as a property. That was a convention held up by every author remembering a rule, and it was false on the day it mattered. Three guards hold it up now and all three must stay.

- `storeDir()` refuses `~/.hive` outright when a test runner is the entry point, keyed on `NODE_TEST_CONTEXT`. That is an env var, so it crosses into every process the suite spawns, and a file that never sets `HIVE_DATA_DIR` fails loudly instead of writing to a live store. It throws for mid-command callers; `db.ts` uses `guardStoreDir()`, which prints and exits for the same reason `guardAbi()` does, since a throw out of an ESM module body arrives as a stack trace with hive's sentence buried in it.
- `storeDir()`/`guardStoreDir()` also refuse `~/.hive` for any process that is not one of hive's own entry points, checked whether or not a test runner is involved (todo 324, below).
- `test/suite-isolation.test.mjs` reads the suite's own source and fails when a file that can reach tmux does not call `isolateTmux()` at module top level.

None of the three can tell one scratch directory from another, so `assertScratchStore()` still earns its place in a destructive file. `test/store-isolation.test.mjs` reproduces the original mistake and pins all of it. The rest of the suite's rules are in `test/CLAUDE.md`.

**That USED TO cover only the SUITE, and the runbook requires every lane to write something none of the three guards above could see.** Step 11 - exercise the change against a real server rather than the tests - is a hand-rolled driver script, and the original three guards missed it: `storeDir()`'s test-runner refusal keys on `NODE_TEST_CONTEXT`, which a plain `node driver.mjs` does not set; `assertScratchStore()` is a helper such a script never calls; and `test/suite-isolation.test.mjs` reads the SUITE's own source, so a driver outside `test/` is invisible to it. The mechanism is the one stated above, reached from the other side: **`src/db.ts` opens the store in its module body from the CALLING process's environment, so `await import(dist/db.js)` IS the act of choosing a store.** Setting `HIVE_DATA_DIR` in the env you hand a CHILD process does nothing for the parent that imports `db.js` to seed or inspect rows - which is the natural way to write such a driver, because a scratch store starts empty and the thing you are exercising usually needs a row in it.

Found on todo 321, where exactly that driver ran `UPDATE agents SET agent_state = 'waiting' WHERE name = 'impl'` against `~/.hive`, the live store. It changed nothing only because no live agent happened to be named `impl` - a name this project uses constantly.

**Closed, also by todo 324, with a fourth check rather than another paragraph.** `defaultStoreRefusal()` (`src/dataDir.ts`) now refuses the default store for any process that is not one of hive's own five scripts - the CLI, the MCP server, the Claude Code state hook, and both of the SessionStart kickoff entries (`dist/kickoff.js` and the plugin's own `claude-plugin/kickoff.mjs`, which lives outside `dist/` and runs first) - identified by `isProductEntryPoint()` comparing `process.argv[1]`, set by node before any user code runs, against each script's resolved path. A hand-rolled driver is none of those, so it is refused the same way a test runner is, through the identical printed-and-exited `guardStoreDir()` path, and the message it gets names the one legitimate case the check cannot see: `HIVE_ALLOW_DEFAULT_STORE=1`, a deliberate opt-in for a human's one-off script. That override cannot reach the test-runner refusal - `defaultStoreRefusal()` checks `underTestRunner()` first and returns before the override is ever consulted - because the point of the override is a human at a terminal, never a test process that happened to set it. `test/store-entry-guard.test.mjs` pins the whole thing, including that a test-runner process cannot use the override to defeat its own refusal.

The preamble below still applies to a driver targeting a SCRATCH store, which the check above cannot see at all - it only ever judges the default store - so it earns its place for the same reason `assertScratchStore()` does: neither guard can tell one scratch directory from another.

```js
process.env.HIVE_DATA_DIR = scratchDataDir;   // BEFORE any dist import
const { db } = await import(join(DIST, "db.js"));
if (!db.name.startsWith(scratchDataDir)) throw new Error(`refusing: opened ${db.name}`);
```

The refusal is the load-bearing half, since the assignment can be defeated by an import that is hoisted above it - which is the original 2026-07-28 bug in a new file.

A symlink pointing at `~/.hive` is the case that defeats both guards at once, which is why the comparison follows symlinks: `storeDir()` would not refuse it under a test runner, and `untrustedTmuxServer()` would read "scratch store" and let a private tmux server write pane ids into the live database.

## Migrations are append-only

Never edit an existing entry in `MIGRATIONS`; add a new one. A snapshot is taken before any pending migration runs, which is one of the two backup triggers.

**Todo 331's trigger migration adds a standing constraint on every migration after it.** `scratchpads`, `todos` and `kv` each carry a SQL `BEFORE UPDATE` trigger that aborts when a content column (`scratchpads.content`, `todos.title`/`body`, `kv.value`) changes while `updated_at` does not read as the current moment. Any future migration that rewrites one of those columns for existing rows must stamp `updated_at` in the same `UPDATE` statement, or it aborts against its own trigger. This cannot be relaxed retroactively once a store has applied the migration, since migrations are append-only - know this going in, not after a migration fails against a store that already has it.

## The store's write lock now also excludes something that is not a store write

Todo 277 (plan-lane-3-tmux-topology). `withWindowClaim` (`src/spawn.ts`) is `db.transaction(claim).immediate()` wrapped around a section that reads whether this store's shared tmux session already has a window for a project and, if not, creates and stamps one - a tmux operation, not a database write. It works because of the exact fact this file already rests on: every hive instance on a machine shares one WAL-mode SQLite database, and SQLite allows exactly one writer at a time. `BEGIN IMMEDIATE` takes that writer slot up front rather than on first write, so a section that writes nothing to the database still excludes every other `withWindowClaim` section on the machine from running concurrently. `launchAgent`, `cmdLead`, and `cmdAttach` (`src/spawn.ts`, `src/cli.ts`) all wrap their own read-then-create window sections in it, which is what stops two concurrent creators from both stamping a window for the same project - the store's write lock, borrowed to serialize something outside the store.

Two rules on what may live inside that section, both because the thing being borrowed is the store's ONLY writer slot, shared by every hive process on the machine:

- **Tmux forks only, and only fast ones.** The section holds the lock for as long as it runs; `db.ts`'s 5s `busy_timeout` is four orders of magnitude more than the few tmux forks a window claim actually costs, and the scheduler's `tick()` (above) contends here like anything else on the machine.
- **Never anything that blocks on a human.** A prompt inside this section would hold the store's only writer slot hostage to someone reading a terminal, stalling every other hive process on the machine until they answer. This is the identical failure shape the residual directly below warns about for restore - a process spanning a human-blocking prompt - one level up: there it is about a stale file descriptor surviving past a prompt, here it is about a lock. `hive.yml`'s trust prompt is the concrete near-miss: `ensureTrusted` runs well above `cmdLead`'s own claim call, never inside it.

**The hazard that would remove the exclusion with nothing failing.** better-sqlite3 nests a transaction inside another one via `SAVEPOINT` rather than throwing. A `withWindowClaim` call made from inside an already-open, `DEFERRED` outer transaction takes no writer slot of its own - it rides along inside the outer one as a no-op savepoint - and the read-then-create race this function exists to close is back, with no error and nothing in the suite going red to say so. Checked at review (pad 79 T5), not merely asserted: every `db.transaction` call in `src/` that can run before a `withWindowClaim` call site sits outside it (`ensureLeadRow`'s two, `src/cli.ts`, both run before `cmdLead`'s own claim; the lead-pane CAS runs after it). If a future caller wraps its own call to `launchAgent`, `cmdLead`, or `cmdAttach` in a transaction, this is what it breaks, silently - the same class of hazard `storeReplaced()`'s open-to-stat window is, below.

Same two honest limits as any other user of this lock, restated here because they read differently once the thing inside the section is tmux rather than SQL: tmux side effects do NOT roll back with the transaction - a throw partway through leaves whatever windows were already created; the lock buys mutual exclusion, not atomicity. And a process that dies inside the section releases the lock, since SQLite rolls the transaction back on connection loss, which is why this is a transaction and not a leases-table claim with a TTL to get wrong.

## Restoring a live store orphans every open connection

`restoreSnapshot` renames the new file into place, which is atomic and correct, but it cannot reach into a process that already opened the old one. That process keeps its file descriptor, pointing at an inode with no name. Both are `~/.hive/hive.db`, neither errors, and (without the guard below) the orphan is freed when the last descriptor closes, so the work is destroyed at the moment the session ends having looked fine throughout.

`hive restore`'s own refusal reads two live signals, a running `agents` row or a `hive-*` tmux session, and `--force` skips both. Read `--force` as "I have accepted this outcome", never as "I am fairly sure nothing is running": it cannot see a `claude` session started outside hive, or one starting in the gap between the check and the overwrite.

**Issue #49: an MCP server now detects this itself and refuses, rather than silently continuing.** `storeReplaced()` in `src/db.ts` records the inode `db` opened right after `new Database`, and a fresh `statSync` on every call compares against it - once tripped it latches, since the answer cannot change back. Two guarded entry points cover the server's whole write surface: `run()` in `src/result.ts`, the choke point every registered tool routes through (pinned by `test/tool-registration.test.mjs`, which scans `src/tools/*.ts` and fails if a future tool's handler does not call it), refuses every call, reads included, and names the remedy (restart the session). `src/scheduler.ts`'s `tick()` checks the same predicate and, if tripped, stops permanently rather than throwing (`CLAUDE.md`'s "the scheduler must never throw" holds) - an orphaned scheduler's harm is not the store, it is typing a stale wake into a live tmux pane as a real user turn.

Manual diagnosis is now the fallback, useful for a server predating this guard or when reading the situation from outside a poisoned session: `stat -f %i ~/.hive/hive.db` against the inode in `lsof -c node | grep 'hive.db$'`. Disagreeing inodes are the diagnosis. Recovery means REPLAYING writes into the new file from a fresh process, then restarting the session.

**Two known residuals, both accepted rather than fixed here.**

- **The open-to-stat startup window.** `storeReplaced()`'s baseline is read right after `new Database`, not atomically with the open itself. A rename landing in that gap makes the new process record the NEW inode as its own baseline, so it never sees a mismatch for a replacement it never actually observed - the failure mode is silent, same as with no guard at all, not worse. The clean fix needs `fstat` on the open descriptor, which better-sqlite3 does not expose. Module-load code already carries two documented startup races (see `db.ts`'s WAL-conversion retry); adding a retry loop here for a narrower window than either of those was judged not worth the risk of breaking every hive process at startup over a residual that is no worse than the pre-#49 baseline.
- **A CLI process blocked on an interactive prompt is not guarded.** The claim elsewhere in this codebase that every non-server writer is short-lived, and therefore cannot hold a stale inode across a restore, has exactly one exception: `hive lead`'s `hive.yml` trust prompt and `hive init` open the store at load and write after a prompt that blocks on a human, so that process genuinely can span a restore. Known and unfixed; do not repeat the unqualified "every non-server writer is short-lived" claim without this caveat.
