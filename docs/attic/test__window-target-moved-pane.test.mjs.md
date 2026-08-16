# Attic: test/window-target-moved-pane.test.mjs

Comments removed from `test/window-target-moved-pane.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 7

```
// Todo 371. A placement="window" worker's tmux_target is a WINDOW id, so
// anything that moves its pane out of that window destroys the id the row
// names and the janitor's agents sweep closes a LIVE worker.
//
// REPORTED from a live incident in another project (a lead ran `tmux
// join-pane` to pull two window-placed workers into its own window, which
// destroyed their windows; both rows went closed at the next tick while both
// claude processes carried on mid-turn). This file is the local reproduction
// that report was taken on trust for, per
// decisions/2026-08-06-a-relayed-finding-is-not-a-verified-one.md.
//
// IT ASSERTS BOTH HALVES, AND THAT IS THE WHOLE POINT. A test that only shows
// the row closing proves the janitor works, which nobody doubts. The claim
// that makes this a defect rather than a tidy-up is that the PROCESS IS STILL
// RUNNING, so the pane's pid is asserted alive - through the kernel
// (process.kill(pid, 0)), not through hive's own view of the world - before
// the row is ever read.
//
// The sweep is not being accused of misbehaving: a destroyed window is an
// honest `false` from rowAliveProbe, not the `null` the foreign-socket
// conservatism protects. The wrong fact is what the row records.
```

## line 37

```
// Raw tmux, never a dist/ helper answering the same question - test/helpers.mjs
// states the rule and why (a helper that asks the code under test only ever
// proves the code agrees with itself).
// #{session_name}:#{window_id}, NOT a bare #{window_id}, and that is the
// whole assertion rather than a formatting preference. The window this file
// compares against is read as `session:@n` (below), so listing bare `@n` here
// made `!windowIds(session).includes(workerWindow)` compare two strings that
// can never be equal - the fixture check the file rests on would have passed
// with no join-pane at all. Found by this lane's own /simplify pass; it is
// test/CLAUDE.md's first shape, an assertion that cannot fail, and the fix is
// proven by asserting the window IS listed before the move.
```

## line 99

```
// The worker's PANE and its WINDOW are both derived from tmux here,
// never read off the receipt, and that is not indirection for its own
// sake. The receipt's tmux_target is the very thing this lane changes,
// so a window id taken from it would compare a PANE id against the
// window list after the fix and pass for the wrong reason - the shape
// test/CLAUDE.md lists seventh, an assertion satisfied by two
// indistinguishable causes. Written this way the file makes the same
// claim against either kind of target, which is what let it run red
// against the parent commit and green against this one.
```

## line 114

```
// THE POSITIVE CONTROL FOR THE ASSERTION BELOW, and it is the reason
// that assertion can fail at all. "the window is gone after the move"
// says nothing unless the same query found it BEFORE the move - the
// first version compared a bare `@n` against a `session:@n` and was
// therefore true with no join-pane at all.
```

## line 124

```
// The incident's own sequence: the lead pulls the worker's pane into its
// own window. Joining the LAST pane out of a window destroys that window,
// which is what takes the id the row names out of existence.
```

## line 129

```
// Past the janitor's SETTLE_WINDOW (-15 seconds), which would otherwise
// spare this row for a reason that has nothing to do with the defect.
```

## line 150

```
// Todo 371's second-order consequence, decided deliberately rather than
// discovered later. targetLiveProbe returns pid null for a WINDOW target
// ("a window target has no single pane's pid to report at all",
// src/tmux.ts), so every placement="window" row used to carry pane_pid=''
// - which paneReissued reads as "no fact recorded" - and the todo-336 /
// issue-149 pane-reissue guard was INERT for this whole population. A pane
// id makes the pid real, which switches that guard ON for rows it has
// never run against.
//
// Kept rather than suppressed, because the guard's own condition cannot be
// tripped by the move this lane is about: the fixture check above asserts
// #{pane_pid} is UNCHANGED across join-pane. What it can now catch is what
// it was built to catch - a server restart reissuing this pane id to
// somebody else's process.
```

## line 172

```
// probed, not just the row: janitor() returns early with probed=false
// when liveTargets() cannot answer, and a sweep that never ran leaves
// the row 'running' for a reason that has nothing to do with this fix.
// Without this the headline test passes against fully unfixed code
// whenever the probe path breaks (counselors, fable seat).
```

## line 180

```
// The process half first, deliberately: it is what makes a closed row a
// DEFECT rather than a correct reap, and asserting it after the row would
// leave a failure reading as though the sweep had found a dead worker.
```
