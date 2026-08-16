# Attic: scripts/run-tests.mjs

Comments removed from `scripts/run-tests.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 1

```
// Todo 375 item 3. `npm test` runs the suite and then asks every tmux socket
// the suite created whether a server is still on it.
//
// WHY THIS IS A WRAPPER RATHER THAN A SECOND npm SCRIPT. `posttest` does not
// run when `test` fails, and a failed or killed run is precisely the one most
// likely to have left a server behind - the same reason .github/workflows/
// ci.yml gives its own leak step `if: always()`. `npm test && node
// scripts/tmux-leaks.mjs` has the identical hole. So the check has to sit
// after the runner INSIDE one process that owns both exit codes.
//
// Everything else about `npm test` is unchanged on purpose: same
// `node --test`, same file list (the shell glob this replaces, resolved here
// instead), same stdio, so CI's own summary parsing and skip-budget gate read
// exactly what they always did.
```

## line 35

```
// ANY positional argument means the caller is naming its own targets - a
// file, a directory, a pattern - so the glob is skipped entirely and node
// --test resolves them itself. Splitting on `.test.mjs` instead (the first
// shape of this) quietly made `npm test -- test/` run the whole suite PLUS
// that directory, which is this wrapper deciding something node --test is
// better at. Flags-only invocations still get the full list.
```

## line 42

```
// Longest-file-first hoist, todo 423. Measured 2026-08-15: wake-hold-notify.
// test.mjs is the suite's critical path - under 16-way concurrency it doesn't
// start until +36.6s, queued behind other files, then runs ~143s regardless
// of what else is happening, so the run is bounded by 36.6 + 143 rather than
// by its own ~143s. Hoisting it to start FIRST measured 183.05s -> 154.39s
// wall (4 alternated full runs: baseline, hoisted, baseline, hoisted), ~15.7%,
// well clear of this machine's ~6s run-to-run noise floor (todo 420).
//
// MECHANISM: node --test sorts its file list by path STRING before
// scheduling - it ignores the order given on argv, proven experimentally (see
// .claude/sessions/dead-ends/2026-08-15-node-test-does-not-honour-argv-file-order.md)
// - and an absolute path always sorts before a "test/..." relative one,
// because "/" < "t". Spelling ONE file's path as absolute hoists it to the
// front without touching the others, their order, or the file's own name.
//
// WHAT THIS RIDES, AND WHAT GOES RED IF IT STOPS BEING TRUE: node comparing
// relative and absolute spellings against each other by raw string, rather
// than resolving every path to absolute first before sorting. That's an
// implementation detail of node's own test runner, not a documented
// contract, so a future node could change it silently - the suite would just
// get ~29s slower again, nothing would fail. test/run-tests-file-order.test.mjs
// pins exactly this assumption against a throwaway two-file fixture; if it
// goes red, this hoist has stopped working and needs a different mechanism.
//
// WHY NOT RENAME THE FILE INSTEAD (durable against the above, but rejected):
// eight references to test/wake-hold-notify.test.mjs by name across
// src/scheduler.ts, src/tmux.ts, test/stall-report-panes.test.mjs and
// .claude/rules/tmux-and-panes.md - one of which, src/scheduler.ts:1464, has
// already broken on a previous rename - and it would put a scheduling hint
// in a filename with nothing to tell a future reader why it's there. With
// the guard test above pinning the fragility directly, the rename's
// durability advantage costs real, immediate breakage for a benefit the
// guard already delivers more cheaply.
//
// RE-DERIVING WHICH FILE BELONGS HERE, if wake-hold-notify.test.mjs stops
// being the longest: run
//   npm test -- --test-reporter=junit --test-reporter-destination=/tmp/j.xml
// twice, join each testsuite's timestamp+time to its file via junit's
// `file=` testcase attribute, and find whichever file's span ends last
// relative to the run's own start - see todo 420 comment 1131 for the full
// method. Getting this stale costs only the ~15.7% win back, silently -
// nothing goes red for staleness itself, only for the mechanism breaking.
```

## line 92

```
// Todo 401 fix round 1 (counselors, all three seats independently): "named
// ⇒ cheap, skip the lock" was too broad. `npm test -- test/` and `npm test
// -- test/*.test.mjs` are `named` - the caller passed a positional - but
// node --test then runs the ENTIRE directory: full tmux/MCP contention, no
// lock, the exact shape this file exists to serialize. A flag's own value
// being misread as a target (`npm test -- --test-name-pattern foo`) lands
// here too. Only a single, explicit `.test.mjs` file is actually cheap;
// anything else - no target, a directory, several files - takes the lock.
```

## line 103

```
// process.exitCode, never process.exit, for the same reason the child's exit
// handler below gives at length: this can run ahead of queued stdout on a
// piped run, and the lock's own timeout message is exactly the line that
// would go missing. `lockBlocked` gates the rest of the file instead.
```

## line 111

```
// Two separate try/catches on purpose (counselors round 1: opus, codex).
// Resolving the lock path and the current holder are git lookups that can
// legitimately fail in a broken-git environment, which is a fault far
// bigger than this lock and worth failing OPEN for. A failure INSIDE
// acquireSuiteLock itself - a filesystem without hardlink support, a
// permission error - means the lock mechanism is broken, not absent, and
// failing open there would silently turn off the one thing this file
// exists to guarantee. That case is left to propagate and crash the
// wrapper loudly instead of being folded into the same fail-open path.
```

## line 124

```
// also a git call - same fail-open bucket as resolveLockPath above
```

## line 126

```
// Counselors round 2 (all three seats): resolveLockPath() can succeed
// and THEN currentHolder() throw - a JS try block does not roll back an
// earlier assignment just because a later statement in it fails. Without
// this line, lockPath stayed set with holderInfo still null, so the
// branch below acquired anyway with holder: null - writing a lock file
// containing only startedAt, no pid. Every later contender's isAlive()
// then got a non-numeric pid and read it as alive forever, wedging every
// lane on the machine for the full 20-minute TTL. Both-or-neither.
```

## line 153

```
// Todo 419. `hive lead`/`hive attach` (maybeOpenDashboard, src/cli.ts) and
// `hive pad --edit` both reach a bare `open` resolved off PATH, and a real
// one pops a browser window or editor on whoever runs the suite - three
// windows during one real `npm test` on the main checkout (`open` on a
// file:// URL duplicates 1:1 per call and never focuses an existing one, so
// three windows means three separate escaping invocations). Reproduced and
// traced to test/restart-lead.test.mjs's REPO-registered lead spawn, fixed
// there with --no-dashboard; see that test's own comment and
// scripts/open-guard.mjs's header for the two preconditions the escape
// needs and why a fresh worktree could not reproduce it at first.
//
// This installs a fake `open` on PATH for the WHOLE run, from the RUNNER
// that spawns every test file - not a shared bootstrap a test file has to
// import. That distinction is load-bearing, not decoration:
// .claude/sessions/decisions/2026-07-28-two-guards-for-test-store-isolation.md
// rejected "a shared test bootstrap imported first by every test file" on
// exactly this shape, because it converts "remember to call the helper"
// into "remember to import the bootstrap FIRST" - the same failure with the
// same trigger, since a hoisted static import can land above it and
// nothing enforces the ordering. A PATH fake set here cannot be beaten that
// way: it is on PATH before `node --test` even starts, no test file has to
// do anything to get it, and the only way past it is to actively rewrite
// PATH - which is exactly what test/dashboard-open.test.mjs and
// test/dashboard-open-lead.test.mjs already do on purpose (their own
// makeFakeOpen bin prepended ahead of this one), so those two keep
// exercising the real open path with their own fake, unchanged.
//
// The run FAILS on any recorded call, the same shape as the tmux leak check
// just below: a guard that only reports is a guard someone reads once. See
// scripts/open-guard.mjs's header for why "any call at all" is the right
// bar here, unlike the tmux check's clean-but-present cases.
```

## line 194

```
// Counselors round 1 (codex): the lock was acquired against THIS process's
// pid, but this process is the supervisor, not the one running the suite.
// A SIGKILL to the wrapper alone (uncatchable, so it cannot release) would
// leave the still-running child behind a lock recording a now-dead pid,
// reclaimed instantly by the next contender while the original suite is
// still going. Repointing at the child's pid the moment it exists closes
// that window down to the few ms between acquire and spawn.
// `child.pid` guard (counselors round 2): `uv_spawn` is synchronous, so
// `child.pid` is populated by the time spawn() returns in the ordinary
// case, but an async spawn failure (fd exhaustion) leaves it undefined,
// and JSON.stringify would then drop the pid key entirely - the same
// non-numeric-pid hazard readHolder() now guards against, but no reason to
// write it in the first place.
```

## line 214

```
// SIGNALS ARE FORWARDED, and this script's own header is why (counselors
// round 2). It exists because a failed or KILLED run is the one most
// likely to have left a server behind - and before this, a supervisor
// that signalled the wrapper rather than the whole process group killed
// the wrapper first, so the leak check never ran and `node --test` could
// be left alive. CI sets cancel-in-progress: true, which is exactly that
// shape. Whether a given runner signals the group or the leader is
// environmental, so it is not something this script may assume.
//
// Killing the child rather than exiting: the "exit" handler below then
// runs the check on a run that has genuinely stopped, which is the case
// the check is most for. A default-disposition SIGTERM does NOT run a
// test file's own process.on("exit") handlers (measured, todo 375 comment
// 899), so the manifest - written at socket CREATION - is the only thing
// that can still name what that run leaked.
```

## line 234

```
// Already gone; the exit handler below has it.
```

## line 240

```
// The suite's own result always wins the exit code; the leak check can
// only ever turn a green run red, never a red run green.
```

## line 245

```
// A MISSING MANIFEST IS ONLY A FAILURE WHEN THE FILE LIST IS OURS (PR
// gate, fix round 1). For the full suite it is a real fault: this
// script built that list, every hive-reaching file in it must call
// isolateTmux() (test/CLAUDE.md), so no manifest means the wiring broke
// and the check silently stopped covering anything. For a NAMED target
// the list is the caller's, and plenty of legitimate targets never
// touch tmux at all - `npm test -- test/db.test.mjs` exited 1 with
// "tmux leak check FAILED" on a clean pass. Strict where it can be
// justified, not where it cannot.
```

## line 258

```
// Todo 419: read before reap() removes the log's directory.
```

## line 267

```
// RELEASE ON EVERY PATH this handler can be reached by: normal exit,
// test failure, and a signal forwarded above - all three land here, the
// same reasoning the manifest cleanup above already relies on. Nothing
// released it if we never acquired one (named run, NO_LOCK, or a
// disabled resolver), which is why suiteLock can be null here.
```

## line 273

```
// process.exitCode, NEVER process.exit (counselors round 2). CI runs
// `npm test 2>&1 | tee`, so stdout is a PIPE, and node's pipe writes are
// asynchronous: process.exit() drops whatever is still queued. Measured
// on this node - a single 500KB console.log followed by process.exit(0)
// piped to `wc -c` delivers 65536 bytes, the pipe buffer, and nothing
// more. The line at risk is this script's own verdict, including "tmux
// leak check FAILED: <reason>", so the failure shape is a red exit code
// with the reason missing. Short writes usually survive; a long leak
// list, or a reader that has stalled, does not. Setting the code and
// letting the process end on its own costs nothing here: the child has
// exited and no handles are left to keep the loop alive.
```
