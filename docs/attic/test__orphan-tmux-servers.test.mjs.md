# Attic: test/orphan-tmux-servers.test.mjs

Comments removed from `test/orphan-tmux-servers.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 19

```
// Todo 375 item 2. Bounding a tmux call kills the CHILD, not the SERVER it
// was talking to, so the fix leaves survivors: on the night this was filed
// there were 200 candidate scratch sockets under the temp dir and a server
// still spinning from that morning, from a worktree that no longer existed.
// `hive doctor` counts them now. It must never kill one.
```

## line 33

```
// Real servers on real scratch sockets, shaped exactly as isolateTmux's are.
// scratchTmuxServer (test/helpers.mjs) owns the shape, so this file and
// test/tmux-leak-check.test.mjs cannot drift apart on the socket-path
// derivation both of them depend on being right.
```

## line 52

```
// Membership of OUR socket, never an absolute count: other test files run
// concurrently and make scratch sockets of their own, so a count would be
// a race dressed as an assertion.
```

## line 60

```
// THE CONTROL, and it is what makes the assertion above able to fail: the
// same enumeration, one kill-server later, must stop naming it. Without
// this, a function that reported every socket it found - reachable server
// or not - would pass the first assertion perfectly.
// Its last session going takes the server with it (`exit-empty on`), so
// the socket stops answering without this file ever naming kill-server.
```

## line 79

```
// Still COUNTED as a candidate: "0 servers" must never read as "nothing
// is there", which is what doctor's zero line prints this number for.
```

## line 86

```
// Point this process at that server: it is now the socket hive itself
// would talk to, and reporting it would be doctor calling its own live
// server debris. dead-ends/2026-08-07-killing-orphaned-tmux-servers-by-
// pid.md: the safe method resolves the live socket and excludes it.
```

## line 94

```
// CONTROL: the identical server, no longer the live one, IS reported. The
// exclusion has to be the reason for the miss above, not the age floor,
// the prefix, or a probe that failed for some unrelated reason.
```

## line 102

```
// The incident's own shape: a server that is alive and unreachable. A
// real one cannot be manufactured here, so the probe is made to time out
// instead - which is exactly what this classification reads.
// Aged past anything a real machine can be carrying, because candidates
// are probed oldest first and the box this was written on had a genuine
// 10.4h orphan on it: a fixture that is merely "old" can lose the race
// for the budget to real debris and never be probed at all.
```

## line 129

```
// THE POINT OF THE WHOLE ITEM: reporting, not reaping. Asserted against
// the server itself rather than against doctor's own words.
```

## line 140

```
// The threshold at the boundary, both sides of it, because a report that
// warns on the everyday state of a machine that runs this suite is one a
// reader learns to skip. Asserted here rather than through doctor's own
// stdout: making doctor SEE five orphans means making five servers, and
// the wiring it would prove is a single if.
```

## line 149

```
// ONE is enough when it does not answer: the recorded safe reap
// (kill-server by socket) does not work against a wedged server at all.
```

## line 155

```
// The prefix is mirrored by hand in test/helpers.mjs, the same way
// scripts/restart-lead.sh mirrors isViewSessionName's suffix. A drift here
// would make doctor's report silently count nothing at all, which is the
// failure a report cannot show you.
```
