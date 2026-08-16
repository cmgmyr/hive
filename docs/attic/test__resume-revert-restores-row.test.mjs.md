# Attic: test/resume-revert-restores-row.test.mjs

Comments removed from `test/resume-revert-restores-row.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 14

```
// TODO 374. resumeAgent's flip un-closes a parked row in ONE statement that
// also clears the park stamp, and its pre-pane failure path used to put back
// status and closed_at AND NOTHING ELSE. So a resume that died before its pane
// came up left a row that was closed again with parked_at/parked_branch
// cleared, resumed_at stamped, agent_state reset to 'unknown' and a brand-new
// closed_at. The revert restored the row's LIFECYCLE and destroyed the facts
// the row existed to carry.
//
// TWO CONSEQUENCES, AND THIS FILE PINS BOTH, because the second is not the one
// the todo was filed for and is the worse of the two:
//   1. THE LANE STOPS READING AS PARKED. `hive status` no longer prints the
//      resume call for it, agent_resume's parked-row name preference (todo
//      364) no longer applies, and parked_branch - the fact that rebuilds a
//      removed worktree - is gone.
//   2. A STANDING WATCH FILES AN OBITUARY FOR IT. The reverted row satisfies
//      every clause of standingGoneRows (src/scheduler.ts), so the lead is
//      told that worker DIED and to go and excavate its branch, about a lane
//      sitting safe on disk exactly where it was parked. Verbatim the failure
//      markGoneReported exists to prevent for a deliberate park release,
//      reached through the door that lane did not walk.
//
// HOW THE FAILURE PATH IS REACHED, and it is the whole difficulty of testing
// this: the catch under test only runs when something throws BETWEEN the flip
// and paneUp = true. Every case here makes upsertActor's own INSERT throw,
// which is the method test/resume-actor-upsert-failure.test.mjs established
// for this exact gap, and the realistic failure with it - SQLITE_BUSY past
// busy_timeout under contention with a concurrent withWindowClaim holder.
// Nothing reaches tmux on that path, so no case here forks a pane.
//
// EVERY ASSERTION IS ON THE ROW, OR ON A STANDING WATCH'S NOTICE CONTENT,
// NEVER ON "resumeAgent threw". Asserting the throw passes against both
// versions - the pre-fix code throws the same error for the same reason - and
// the deciding fact is what is left behind.
//
// THE SILENCE ASSERTIONS ARE BACKED BY A POSITIVE CONTROL IN THE SAME TEST,
// which is what stops this file going vacuously green if the seeded watch ever
// stops being able to report anything at all. `namedInStandingReport` and
// `seedStandingWatch` are the suite's shared helpers rather than a private
// copy of the same SQL, for the reason their own header gives.
//
// BOTH WATCH ORDERINGS ARE COVERED, and which one a case builds is the whole
// question of whether its silence means anything - the fourth case works that
// out in full and is the place to read. Short version: a watch created BEFORE
// the row closed has no gone-cursor for it (the park and idle exclusions are
// FILTERS, so nothing is ever recorded while they hold), and that is the state
// the defect fires in; a watch created AFTER has one, and the fourth case
// builds that instead.
//
// THE MUTATIONS THESE DIE AGAINST, each run rather than reasoned about, with
// the case it actually killed:
//   - the pre-374 revert (status/closed_at only) -> the column case and both
//     obituary cases.
//   - dropping agent_state from RESUME_FLIP_COLUMNS -> the column case, the
//     ordinary-row obituary case, and the drift guard.
//   - dropping parked_branch -> the column case and the drift guard.
//   - dropping closed_at -> five of the six, including the seeded-cursor case,
//     which is built so that the episode key is the ONLY thing suppressing it.
//   - removing the revert's CAS -> the concurrent-park case.
```

## line 88

```
// The snapshot is deliberately EMPTY, so the watch owner's own pane is not
// live: a filed notice is a real due-now timer, and the next tick would try to
// deliver it. A lead-owned wake whose pane is not live is HELD rather than
// typed, so these cases reach the code under test and stop short of typing at
// a terminal. Same method, and same reason, as test/standing-watch.test.mjs.
```

## line 95

```
// Every flip-written column carries a DISTINCTIVE value, so a restore that
// writes a plausible-looking default instead of the recorded one still fails.
// created_at is old enough that janitor()'s settle window never applies to it.
```

## line 144

```
// THE FAILURE INJECTION. upsertActor's INSERT runs inside resumeAgent's
// paneUp-guarded try and BEFORE placeAgentPane, so throwing there enters the
// catch with paneUp still false and no tmux fork attempted. `duringFailure`
// runs while the row is mid-resume - flipped to running with tmux_target='' -
// which is the only moment a concurrent writer's race can be staged.
//
// IT ASSERTS THE PATCH FIRED. If the intercepted literal ever stops matching,
// the patch silently never fires and resumeAgent SUCCEEDS against a real tmux
// fork, which would look exactly like a passing test.
```

## line 205

```
// Against the SEEDED values, not only against `before`: `before` is read
// out of the same row, so it would agree with a restore that wrote back
// whatever it happened to find. These are the values this test chose.
```

## line 215

```
// A `deepEqual(Object.keys(after), RESUME_FLIP_COLUMNS)` used to sit here
// and was DELETED rather than kept with a caveat: `after` is SELECTed
// from that same list, so both sides shrink together and the assertion
// cannot fail. It read as a coverage guarantee it never gave. What
// actually holds the list to the flip is the drift guard below, and what
// holds the VALUES is the literals above - both of which fail for real.
```

## line 227

```
// CONTROL. While the lane reads parked, the watch is silent about it -
// standingGoneRows' own park exclusion.
```

## line 246

```
// POSITIVE CONTROL, AND IT IS WHAT STOPS THE TWO SILENCES ABOVE BEING
// VACUOUS. Release the park by hand and tick again: same watch, same
// row, same query - and now it DOES report. So the silence came from the
// restored park stamp rather than from a watch that could never speak.
```

## line 260

```
// THE SECOND DOOR, AND PARK IS NOT INVOLVED. A row that finished, went
// idle and was closed is excluded from standingGoneRows by `agent_state
// != 'idle'`. The flip resets agent_state to 'unknown', so a revert that
// restores the park stamp and nothing else still hands that row to the
// gone query. Restoring the park columns alone passes the case above and
// fails this one.
```

## line 286

```
// The same positive control, for the same reason: prove this watch can
// speak about this row at all.
```

## line 298

```
// THE ADJUDICATION, WORKED OUT AGAINST THE CODE AND WRITTEN DOWN HERE SO
// THE NEXT READER DOES NOT RE-DERIVE IT. Two counselors seats disagreed
// about whether the two cases above test a real standing-watch state,
// because `wake_when_idle` creates a watch and calls seedGoneCursor in
// ONE transaction (src/tools/wakes.ts) while `seedStandingWatch` inserts
// only the timer.
//
// THE ANSWER IS THAT BOTH ORDERINGS ARE REAL, AND THEY ARE DIFFERENT
// STATES. seedGoneCursor seeds only rows that are ALREADY CLOSED when
// the watch is created, so:
//   WATCH CREATED BEFORE THE CLOSE - the ordinary case, and the ONLY one
//     the defect needs. The lead has a standing watch up, parks the crew
//     in the evening, and resumes in the morning. No cursor exists for
//     that row, and not because the helper is convenient: while the lane
//     sat parked, standingGoneRows' park exclusion is a FILTER and never
//     wrote one (its own comment says so). The cases above build exactly
//     that state.
//   WATCH CREATED AFTER THE CLOSE - this case. A cursor DOES exist, keyed
//     on the row's closed_at as the episode.
// So the cases above are faithful, and this one covers the ordering they
// do not. It also pins something no other case does: `closed_at`'s OWN
// role in RESUME_FLIP_COLUMNS, ISOLATED. The row here is deliberately
// NEITHER parked NOR idle, so neither of the two exclusions the other
// cases rest on applies - the seeded cursor is the only thing keeping
// this watch quiet, and the cursor is keyed on the row's closed_at as the
// episode. So a revert that stamps a FRESH closed_at, which is exactly
// what the pre-374 one did, makes an accounted-for death look like new
// news. Dropping closed_at from the restore list turns this case red on
// its own, which is the point of building it this way.
```

## line 331

```
// CONTROL, AND IT PROVES THE CURSOR IS REAL AND ACTIVE. This row passes
// every other clause of standingGoneRows - closed, not parked, not idle -
// so silence here is the cursor doing its job and nothing else.
```

## line 350

```
// A FRESH closed_at IS A NEW EPISODE and the cursor no longer covers it -
// precisely what main's revert stamped on every failed resume.
```

## line 362

```
// THE RACE recordPane ALREADY EXISTS FOR (.claude/rules/tmux-and-panes.md),
// reached one statement later. The flip commits running with
// tmux_target='', a concurrent agent_park reads targetLiveProbe('') as
// FALSE rather than null, its CAS compares '' against '' and matches,
// and the row goes closed+parked while this resume is still in flight.
// An unpredicated restore then overwrites that park with the pre-flip
// values - for THIS row, clearing parked_at outright, which is this
// todo's own defect reintroduced by its own fix.
//
// Staged with the real parkAgentRow rather than a hand-written UPDATE,
// so the CAS being satisfiable by tmux_target='' is part of what the
// test proves rather than something it assumes.
```

## line 393

```
// THE DRIFT GUARD. RESUME_FLIP_COLUMNS drives both the capture SELECT
// and the restore UPDATE, so a column ADDED to the flip and not to the
// list would go unreverted with nothing failing - which is this todo's
// own defect, one column at a time. Parsed off resumeFlipSql() rather
// than a copy of it: a test that restates the statement is a test that
// agrees with itself (decisions/2026-08-11-recordpane-guards-the-row-
// not-the-caller.md's own trap).
```
