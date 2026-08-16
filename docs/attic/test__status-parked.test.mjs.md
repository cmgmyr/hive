# Attic: test/status-parked.test.mjs

Comments removed from `test/status-parked.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 6

```
// Issue #156, D4. A PARKED LANE IS LIVE STATE WITH NO RUNNING PROCESS, so it is
// invisible to every other query on `hive status`: the agents block is
// status='running' and a parked row is closed. The issue's own reason for this
// surface is that "a parked crew that only exists on the board goes stale the
// first time someone forgets", and the board is the one thing here no code
// maintains.
//
// No tmux is needed to make a parked row - it is closed, and the CLI reads it
// out of the store - but `hive status` calls janitor(), which does reach tmux,
// so this file isolates like every other file that can (test/CLAUDE.md).
```

## line 28

```
// projects.path is UNIQUE, so each test seeds its own.
```

## line 50

```
// THE BASELINE MATTERS AS MUCH AS THE RESULT. A project with no running
// agents, no open todos and no pending wakes is skipped entirely by
// cmdStatus's own `continue`, so without the parked count added to that
// condition this whole surface would be unreachable for exactly the
// project it exists for: an end-of-day crew, parked, with nothing else
// running. Proving the empty case prints nothing first is what makes the
// second assertion mean something.
```

## line 87

```
// The whole distinction issue #156 is about: `closed` today means both
// "this lane is done" and "this lane is paused".
```

## line 100

```
// '' is this column's "no fact recorded" default (the convention
// tmux_socket, pane_pid and session_id already set); printing it raw would
// read as a blank branch NAME rather than as an absent fact.
```
