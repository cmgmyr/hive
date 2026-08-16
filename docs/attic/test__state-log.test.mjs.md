# Attic: test/state-log.test.mjs

Comments removed from `test/state-log.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 7

```
// Issue #24, the instrument rather than the fix. agents.agent_state is one row
// overwritten in place, so a wrong value that corrects itself leaves nothing
// behind. On 2026-07-29 a false "idle" was written at 13:27:39 and overwritten
// with "working" at 13:27:41; the lead sampled at 13:28, saw "working", and
// recorded a PASS on a lane that had already failed. agent_state_log is the
// append-only record of every hook invocation, so the same two seconds are a
// row you read rather than a window you have to be looking through.
//
// The pins that matter here are ordering ones. Anything that samples the log
// instead of reading its sequence has reintroduced the blind spot the table
// exists to remove.
```

## line 24

```
// This file deletes rows between tests. Prove the store is scratch before
// opening it, not after.
```

## line 52

```
// The real hook binary, run the way Claude Code runs it: separate process, the
// event as argv[2], the payload as JSON on stdin.
```

## line 68

```
// The payload captured from Claude Code 2.1.220 that actually re-opened #24:
// a Notification fired 60 seconds after a Stop, carrying no background_tasks at
// all. The full capture is on todo 61 comment 82.
```

## line 98

```
// THE pin for this table. This is the exact shape of the bug: an idle that
// exists for two seconds and is then replaced. Sampling agents.agent_state
// at the end sees "working" and learns nothing, which is how the smoke test
// recorded a PASS on a failing lane.
//
// The fixture was originally the #24 payload itself, a notify writing idle.
// That stopped being a real transition the moment the fix landed, and a
// fixture that can only exist while the bug does is not a fixture. A Stop
// with an empty background_tasks writes a legitimate idle, and the
// task-notification that follows overwrites it, which is the same two-event
// shape and outlives any particular bug.
```

## line 128

```
// state_changed_at has one-second granularity and three events can land
// inside it. Both the id and the millisecond timestamp have to separate
// them, or the log is as blind as the row it replaces.
```

## line 149

```
// UserPromptSubmit carries the whole prompt and a pasted file has no bound.
```

## line 163

```
// The event still happened and still decided a state. A row with an empty
// or unparseable payload is evidence; a missing row is a hole.
```

## line 186

```
// THE ORDERING, pinned on its own. The test below pins that a broken log
// cannot cost the state write, which is a different claim: it stays green
// whether record() runs before or after the UPDATE, because record() has its
// own try/catch either way. The original mutation for it moved record() AND
// stripped that catch, then credited the failure to the move. Two things
// changed and one was named.
//
// This is the asymmetric half, and it is only true in one order. Break the
// STATE write instead of the log write: with the state write first, the
// throw reaches the hook's outer catch and record() never runs, so no row
// exists. With record() first there would be a row describing a state that
// was never written, which is worse than no row at all, because the whole
// point of this table is that a row is evidence the write happened.
```

## line 214

```
// A hook must never break the session, and the state write is what wakes,
// agent_status and hive status all read. Diagnostics lose first, every time.
//
// What this pins is the ISOLATION, not the order: record() carries its own
// try/catch and never shares a transaction with the state write. The
// ordering is pinned by the test above, which is the one that can tell the
// two apart.
//
// Renamed away rather than dropped, and restored before anything is
// asserted. Dropping it means recreating it by hand, which drifts from
// db.ts, and a failed assertion here would leave every later test in this
// file running against a store with no table at all.
```

## line 245

```
// A snapshot of null means the tmux probe failed, so the janitor sweeps
// nothing and no wake is decided. Retention still has to run: a machine can
// sit with an unreachable tmux server for days, and that is exactly when a
// sweep living inside the janitor would stop happening.
```

## line 280

```
// Ids rather than 20,000 real inserts: the cap is expressed as a span
// between the highest and lowest id, so two rows are enough to exercise it.
```
