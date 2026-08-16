# Attic: test/sweep-scratch.test.mjs

Comments removed from `test/sweep-scratch.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 25

```
// Todo 402. Two populations, two different testing arguments - said here
// rather than left implicit, because the file's own shape is the answer to
// "why does one half get a real end-to-end reap and the other does not".
//
// SHELLS: this development machine carries real, ordinary orphaned login
// shells whenever this file runs (ps holds no fixture boundary), so the
// script's own end-to-end CLI path - which scans the WHOLE process table -
// is never exercised here against `--kill`. Its ENUMERATION is (fixture ps
// rows, no process involved), and its KILL MECHANISM is, directly, against
// one real process this file spawns and owns for exactly that purpose. That
// is the seam test/CLAUDE.md and todo 402 both ask for when the honest
// answer is that the full path cannot be exercised safely.
//
// SCRATCH TMUX SERVERS: the opposite argument applies, because
// orphanScratchServers() is scoped by construction to `hive-tmux-*` sockets
// nothing but hive's own test/dev tooling ever creates, and the age floor
// used below (1h, orphanScratchServers' own production default) safely
// excludes any concurrent sibling lane's own seconds-old scratch socket -
// the identical safety argument test/orphan-tmux-servers.test.mjs already
// rests on. So this half gets the real thing: the actual CLI, `--kill`, a
// real server, and a real verification that the file's OWN live session
// survives the reap.
```

## line 104

```
// the real orphan
// real parent, not orphaned
// orphaned, too young
// no leading dash
// no pty
```

## line 123

```
// A genuine double-fork orphan: the outer `sh -c` backgrounds a bash whose
// argv[0] is set to a leading dash via `exec -a`, then exits - reparenting
// the survivor to launchd/init the instant it does, exactly the population
// isOrphanLoginShell exists to name. This is the honest fixture: a process
// that actually IS orphaned, not a synthetic row asserting a property no
// real process has to hold.
```

## line 154

```
// Already gone.
```

## line 180

```
// The wedged-server pid fallback (dead-ends/2026-08-11-reaping-a-wedged-
// tmux-server-by-socket-alone.md): its decision - refuse unless lsof names
// EXACTLY one pid for the socket - is what stands between "resolve the live
// pid as well as the live socket" and the pid-list dead-end this whole
// population's safety argument rests on. A genuinely wedged tmux server is
// not something this suite can manufacture safely, so this tests the
// decision against real sockets in the two states it is easy and safe to
// produce: one with no listener at all, and one with exactly one (an
// ordinary, live scratchTmuxServer - not wedged, but identical from lsof's
// side, which is the only thing this function looks at).
```

## line 209

```
// The resolved pid really does own this socket - probed independently
// via kill(pid, 0) rather than trusted from reapWedgedServer's own claim.
```

## line 218

```
// Told the real pid IS the live one: must then refuse, since excluding
// it leaves zero candidates rather than a wrong guess.
```

## line 225

```
// The suite-lock guard, found by the lead running the script against a real
// concurrently-running suite: it offered up that suite's own live scratch
// socket, because orphanScratchServers() only ever excludes THIS process's
// own live socket, never a sibling's. `lockPath` is always a throwaway file
// here, never the real shared one - see liveSuiteLockHolder's own comment
// for why writing to the real path from a test would race whatever lane is
// actually running a suite on this machine right now.
```

## line 268

```
// Safety net only - the one test that spawns an orphan asserts it is
// already gone; this covers an assertion failure interrupting that test
// before it gets the chance to observe that.
```

## line 275

```
// Already gone.
```

## line 289

```
// CONTROL: still answers after a dry run. Without this, "reported" could
// just as easily mean "reported because it is already gone".
```

## line 295

```
// The file's OWN live session, on its OWN isolated socket - not the
// orphan's. If the reap ever touched the wrong socket, this is what
// would go missing.
```

## line 314

```
// A nonexistent lock path, not the default: when this test runs as PART
// of a real `npm test`, the real suite lock IS held - by the very run
// this test is inside - and this test is about the reap mechanism, not
// the guard (that has its own describe block below). Found by running
// this file inside a real full suite rather than standalone: the guard
// fired against its own test suite and this test failed for the right
// reason, just the wrong test.
```

## line 325

```
// THE HEADLINE: the orphan is actually gone, probed directly rather than
// trusted from the script's own stdout.
```

## line 333

```
// THE CONTROL THAT MAKES THE HEADLINE MEAN SOMETHING: the live session's
// panes are byte-identical to the snapshot taken before the reap.
```

## line 345

```
// The test runner's own pid - genuinely alive for the whole test, no
// fixture process needed to keep it that way.
```

## line 360

```
// SWEEP_PS_ROWS_JSON, not a real scan: this machine carries real,
// unrelated orphaned shells (90 of them the day this was written), and
// scanning the whole process table would catch every one of those too.
// This closes the shell candidate set to exactly the one row this test
// owns. The etime is FICTIONAL (the real process is seconds old) -
// findOrphanShells only compares it against the floor below, already
// covered on real values by its own describe block above; the kill
// still lands on the real pid, so the mechanism under test is real.
// age-hours stays at a REALISTIC floor (1h, not 0) for the same reason
// the etime is faked rather than the floor lowered: orphanScratchServers
// scans the WHOLE shared tmpdir for hive-tmux-* sockets, so a floor of 0
// would also offer up any OTHER concurrently-running test file's own
// fresh scratch socket - reproduced once while writing this, against
// test/tmux-leak-check.test.mjs's own fixtures running in parallel.
```

## line 379

```
// Not an exact count: orphanScratchServers scans the whole shared
// tmpdir, so under a real `npm test` run other concurrently-running
// test files' own 5h-backdated fixtures can legitimately appear
// alongside this one. The count is not what this test is about; the
// probe below, against the specific socket this test made, is.
```

## line 386

```
// THE HEADLINE: the server the lock is meant to protect is still there.
```

## line 389

```
// THE CONTROL THAT MAKES THE SCOPE CLAIM MEAN SOMETHING: the shell reap
// was NOT also blocked - only the destructive half the lock exists for.
// isAlive rather than a try/catch around assert.fail: the two throw
// shapes (ESRCH vs. an assertion) must not be caught by the same catch,
// or a genuine failure here reads as an unrelated ERR_ASSERTION mismatch
// instead of the real one.
```

## line 416

```
// too fresh for any realistic floor
```

## line 424

```
// The fresh server the floor was supposed to exclude is still there.
```

## line 429

```
// A private socket with no session ever created on it: sessionName()
// resolves to a real tag, but livePaneIds() finds nothing there. This
// must read as "nothing to verify", never as "no live session, so
// anything found is safe to kill" - the guard the empty-list test above
// covers is about candidates, this one is about the live-session check
// itself degrading safely.
// A real, empty directory - never handed to tmux, so no server has ever
// listened on the socket path it resolves to.
```
