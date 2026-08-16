# Attic: test/tmux-leak-check.test.mjs

Comments removed from `test/tmux-leak-check.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 20

```
// Todo 375 item 3. A leaked test tmux server is silent, so it accumulates
// until something else falls over (todo 294: 227 alive at one point, then
// "fork failed: Device not configured"). `npm test` now asks every socket the
// suite created whether a server is still on it.
//
// A LEAK DETECTOR THAT CANNOT FAIL IS WORSE THAN NONE (test/CLAUDE.md), so
// every case here runs against a DELIBERATELY LEAKED, REAL tmux server, with
// the control being the same socket one teardown later - the thing that
// actually differs, not a query that would throw for a second reason.
```

## line 35

```
// scratchTmuxServer (test/helpers.mjs) owns the shape, shared with
// test/orphan-tmux-servers.test.mjs: two hand-copied derivations of
// <tmpdir>/<prefix>/tmux-<uid>/default both have to stay in step with
// src/tmux.ts's socketUnder() for either file to be testing anything.
```

## line 68

```
// THE CONTROL, and it is the one that makes this file mean anything: the
// IDENTICAL manifest and the IDENTICAL socket path, one teardown later.
// Todo 294's own positive control failed exactly here - it asserted that
// querying the socket throws, which is also true when the socket FILE is
// gone, so it passed with the kill removed entirely.
```

## line 80

```
// The wedged case. It is the one an unbounded check cannot report at all,
// because it hangs instead - so it is also the one worth proving is not
// silently classified as "gone".
```

## line 98

```
// COUNSELORS ROUND 2, F5. Every non-ETIMEDOUT failure used to classify as
// "gone", which includes EAGAIN and EMFILE - process and fd exhaustion,
// the exact state this detector exists to catch. The sequence the codex
// seat named: kill-server fails, the survivor probe then fails to SPAWN,
// the handler calls it gone and deletes the socket directory, and the
// run-level check finds no socket and reports clean. An unknown result
// manufactures the one gap this script already admits to having.
```

## line 124

```
// THE CONTROL, and it is the whole difficulty of this fix: tmux's own
// answer must still read as gone, or every ordinary clean run goes red.
// "no server running on <path>" is what a REAPED socket answers, because
// kill-server does not unlink the socket file.
```

## line 138

```
// And the second control, for the machine with no tmux at all: every
// socket in the manifest would read unknown and fail an otherwise clean
// run, since isolateTmux records its socket before it checks for tmux.
```

## line 147

```
// PR GATE, on the code fix round 2 wrote. F5 gave isolateTmux's exit
// handler a settle-and-retry for an inconclusive reading and this
// run-level gate did not inherit it, so a SINGLE unknown failed the whole
// `npm test`. The scenario is the one F5's own argument describes: ~120
// sockets probed in sequence, one fork each, immediately after a
// `node --test` run whose processes are still being reaped - one EAGAIN in
// that burst and a clean run goes red. A false red, which is precisely
// why it is a fix and not an accept: a detector that cries wolf gets
// deleted.
//
// The server here is genuinely REAPED before the check runs, so the
// retry's answer is the truth rather than a fixture's opinion; the fake
// only injects the transient failure on the FIRST call and passes
// everything after it through to the real tmux.
```

## line 174

```
// EAGAIN's own wording, and NOT one NOTHING_THERE matches - a fork
// that never ran says nothing about the server.
```

## line 187

```
// THE DISCRIMINATOR: two calls, not one. Without it, a check that somehow
// probed nothing at all would satisfy the assertion above just as well.
```

## line 191

```
// The retry does NOT rescue a persistent unknown - that case is the test
// above ("counts a probe that could not RUN as unknown"), whose fake fails
// every call and still fails the run.
```

## line 197

```
// The same finding at the destructive end. This handler DELETES the
// directory on "gone", and that directory holds the socket file backing a
// live server's own listener - removing it is what made todo 294's leaks
// unreachable forever. Both arms run the identical child; only the PATH
// the exit handler resolves tmux on differs.
```

## line 212

```
// Through TMUX_TMPDIR, the way every real test file makes its server:
// tmux creates the uid directory itself that way, and does NOT create
// the parent of a `-S` path (measured - it prints "error creating"
// and exits 0, so a -S here would leave no socket at all and this
// test would silently exercise nothing).
```

## line 220

```
// Prepending AFTER the server exists, so only the exit handler's own
// calls resolve to the fake: kill-server fails, and the probe that
// verifies it fails the same way.
```

## line 234

```
// Read from tmux, not from the handler's words: the server this test
// is protecting really is still there.
```

## line 243

```
// kill-session, not the other verb: test/suite-isolation.test.mjs
// forbids that one by name in any test file, and tmux's own
// `exit-empty on` takes the server down with its last session -
// the same reasoning scratchTmuxServer's reap() carries.
```

## line 252

```
// Already gone.
```

## line 257

```
// THE CONTROL: the identical child with the real tmux on PATH kills its
// own server, gets a real ANSWER back, and removes the directory.
// Without it, "the directory survived" would pass against a handler
// that never cleans up at all.
//
// Both arms exit 1 - this one for the todo 294 report, since the child
// leaves a session it never threaded through cleanup() - so the exit
// code is not the discriminator here. The DIRECTORY is, and so is which
// sentence the handler printed.
```

## line 277

```
// A detector that fires on debris nobody caused gets ignored, then
// removed. The manifest names sockets the suite created; one whose server
// was never started, or whose directory is already gone, is clean.
```

## line 287

```
// COUNSELORS ROUND 2, F8. The wrapper installed no signal handlers, so a
// supervisor signalling IT rather than the process group killed it before
// the check ran - and CI sets cancel-in-progress: true. The wrapper's own
// header argues it exists BECAUSE a killed run is the one most likely to
// have leaked, so this was the script failing its own stated reason.
//
// End to end through the real wrapper, against a real leaked server: the
// target file starts one, says so, and then sleeps until it is killed.
// A default-disposition SIGTERM runs no exit handlers in that child
// (measured, todo 375 comment 899), so nothing but the manifest can name
// what it left.
```

## line 316

```
// NODE_TEST_CONTEXT has to go, and finding out why is worth recording:
// node --test REFUSES TO RUN FILES when it sees that variable inherited
// from the test process that spawned it ("run() is being called
// recursively within a test file. skipping running files"), so the target
// silently never runs and the wrapper reports "nothing to check" on a run
// that did nothing. HIVE_DATA_DIR is set even though this fixture never
// touches the store, because dropping NODE_TEST_CONTEXT also drops
// storeDir()'s refusal of the real ~/.hive (test/CLAUDE.md).
```

## line 334

```
// The server has to exist before the signal, or this measures a race
// rather than the handler.
```

## line 351

```
// Already gone.
```

## line 358

```
// No manifest means no test file called isolateTmux(), which cannot be
// true of this suite - so it is a failure of the check itself, not a
// green run. Without this branch, breaking the wiring below would report
// "no leaks" forever.
```

## line 368

```
// PR gate, fix round 1, both directions. The full file list is built by
// scripts/run-tests.mjs itself, and test/CLAUDE.md requires every
// hive-reaching file in it to call isolateTmux() - so no manifest there
// means the wiring broke and the check silently stopped covering
// anything. A NAMED target is the caller's list, and plenty of
// legitimate targets never touch tmux: `npm test -- test/db.test.mjs`
// exited 1 with "tmux leak check FAILED" on a clean pass.
```

## line 379

```
// A REAL leak is a failure either way - the relaxation is about the
// manifest's absence, never about what a manifest that exists reported.
```

## line 386

```
// The gate's own repro, end to end through the real wrapper. Only this
// direction is affordable here: proving the FULL-run direction the same
// way means running the entire suite inside the suite, so its verdict is
// pinned at the boundary above instead.
```

## line 394

```
// NODE_TEST_CONTEXT undefined: inherited from this test process, node
// --test skips running the file entirely and prints a recursion warning,
// so the wrapper's "nothing to check" line would have been produced by a
// run that never happened. Found while writing the signal test below.
```

## line 409

```
// PR gate, fix round 1. The survivor check is gated on the socket FILE
// existing (a file whose tmux never ran cannot have left a server), and
// the first shape of that gate was an early `return` sitting above the
// rmSync - so every file that calls isolateTmux() without creating a
// session leaked its scratch directory on every run. test/CLAUDE.md
// requires that call of every hive-reaching file, and plenty of them
// never issue a new-session (test/wire-surface.test.mjs among them), so
// this is the common path, not an exotic one.
```

## line 424

```
// The directory under test is the one isolateTmux just made, so the
// child names it rather than the parent guessing at a mkdtemp suffix.
```

## line 436

```
// END TO END over the wiring, because everything above tests the checker
// against a manifest this file wrote by hand. If isolateTmux stopped
// appending, every assertion above would still pass and the real run
// would check nothing at all.
```

## line 460

```
// Counselors round 2 (F6). isolateTmux appends only the file's own
// socket, and four files start a server on a bespoke TMUX_TMPDIR of their
// own - those were invisible to this check AND to the ps guard, which
// says in its own header that it cannot see two of them. They call
// recordScratchTmuxSocket now; this pins that the call actually reaches
// the manifest, since the four call sites themselves assert nothing about
// it.
```

## line 488

```
// Counselors round 2. clearHiveEnv() deletes EVERY HIVE_* key, the
// manifest variable included, and isolateTmux used to read that variable
// at call time - so a file calling them in this order dropped its own
// socket from the manifest, and the run still reported every socket it
// did receive as "all gone". Latent when it was found (no file violates
// the order today), which is exactly why nothing would have caught the
// first one that did.
```

## line 502

```
// The order that used to lose the socket. Red against a call-time
// read of process.env, green against the module-scope capture.
```
