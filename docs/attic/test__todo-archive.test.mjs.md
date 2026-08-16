# Attic: test/todo-archive.test.mjs

Comments removed from `test/todo-archive.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 6

```
// hive status/statusline below run through runCli, which spawns hive and
// probes tmux; isolate first (see helpers.mjs).
```

## line 26

```
// Positive control (counselors round on #15): without an active todo in
// the same call, a default query that returns NOTHING would still pass
// the "archived target is absent" assertion below.
```

## line 34

```
// Assert over what todo_list actually RETURNS, not just the receipt
// (test/CLAUDE.md): a filter bug that returns the right count from the
// wrong query would still pass a length-only assertion.
```

## line 57

```
// Counselors round on #15: the original test only covered a comment
// written BEFORE archiving. Comments are the whole reason this is
// archive and not delete, so continued access afterward is the part
// that actually matters.
```

## line 73

```
// Counselors round on #15: without this intermediate check, two
// fabricated no-op receipts (never actually writing archived_at either
// time) would still pass - the todo was never removed, so it is still
// there to be "found again" at the end regardless of whether archiving
// ever really happened.
```

## line 95

```
// Counselors round on #15: the original test inspected only the two
// receipts, which pass even if todo_archive never writes to the store
// at all. Confirm via an independent read (todo_get) after each call.
```

## line 105

```
// Exactly one archived row for this id: not zero (never written) and
// not toggled back to active by the second, supposedly-no-op call.
```

## line 118

```
// Still visible in the default (active-only) list - a todo silently
// archived anyway despite the archived=false receipt would fail this.
```

## line 129

```
// Negative control (counselors round on #15): an unrelated non-completed
// todo, no blocking edge at all. Without this, a refusal that fires
// whenever ANY non-completed todo exists anywhere in the project - not
// specifically a dependent of this one - would still pass.
```

## line 141

```
// The refusal must not have half-applied anything: still active.
```

## line 171

```
// Counselors round on #15: the original test stopped at the receipt,
// which passes even if todo_archive reports success without writing.
```

## line 179

```
// The pad's "unless this todo is itself already completed" clause: a
// completed blocker already contributes nothing to the dependent's
// open_blockers (OPEN_BLOCKERS_SQL filters on the blocker's own status),
// so archiving it must be allowed unconditionally - this is the ordinary
// lane-teardown case the feature exists for.
```

## line 192

```
// Counselors round on #15, the sharpest of the discrimination gaps: the
// original test checked the dependent's status but never is_blocked or
// open_blockers - the actual premise this whole rule rests on. A
// completed blocker not being an OPEN blocker is the claim; checking
// only `status: "open"` on the dependent does not verify it.
```

## line 215

```
// Counselors round on #15, P2: archiving a blocked dependent is allowed,
// but a naive LIVE_DEPENDENTS_SQL would still count that archived,
// non-completed dependent as live, refusing to archive its blocker with
// no way out but falsely completing the dependent or destroying the edge.
```

## line 225

```
// Archive the dependent first - allowed today (it is not a blocker of
// anything itself), and still open, never completed.
```

## line 240

```
// Counselors round on #15: nothing pinned the slim-receipt invariant
// (CLAUDE.md) itself - a handler that returned a full todo row or its
// comments would still pass every other assertion in this file.
```

## line 250

```
// Counselors round on #15, P1: todo_archive's refusal only ever looks at the
// moment of archiving. Nothing stopped an archived todo from becoming a live
// blocker afterward, through two separate routes.
```

## line 264

```
// The refusal must not have half-applied anything: b must still read as
// unblocked, not silently linked to an invisible blocker.
```

## line 294

```
// Confirm the refusal actually held: the blocker is still completed, and
// the dependent is not newly blocked by an invisible edge.
```

## line 323

```
// Moving TO completed is not the hazard - only leaving completed is.
```

## line 327

```
// The documented escape hatch: unarchive first, then reopen freely.
```

## line 346

```
// Its own scratch project: the shared `mcp`/`dirs` above accumulate
// todos across this file's other tests, and this assertion needs an
// exact count.
```

## line 357

```
// Counselors round on #15: a single static "count == 1" snapshot
// accepts any query that happens to land on the right number from the
// wrong rows. Tying the count to the SPECIFIC todo being archived,
// one step at a time, closes that: each archive must drop the count
// by exactly one, not just produce some number that matches by luck.
```

## line 371

```
// Archived and completed are independent axes: both rows' statuses
// are still 'open'/'in_progress', so a naive status-only count would
// have kept counting them. Zero live todos (plus no agents, no
// timers) means cmdStatus's own "nothing here" gate skips the
// project block entirely.
```

## line 389

```
// Counselors round on #15: without asserting the exit code and
// stderr, a crash that happens to also produce empty stdout would
// pass the "prints nothing" assertion below just as well as the
// intended behaviour would.
```
