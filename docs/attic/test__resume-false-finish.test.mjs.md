# Attic: test/resume-false-finish.test.mjs

Comments removed from `test/resume-false-finish.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 22

```
// Issue #156's REAL DEFECT, D3. A resumed worker fires a Stop hook the moment
// its restore turn ends, and a standing watch reports that as "finished"
// BEFORE the worker has been given its assignment. Observed live twice; a lead
// that trusts the wake tears down a worker that never started.
//
// THIS FILE IS THE REPRODUCTION AND THE FIX IN ONE PLACE, and the reproduction
// half is why it can be trusted. Every step below is REAL: a real spawn, a real
// agent_park, a real agent_resume, and a real Claude Code Stop payload driven
// through the BUILT dist/hook.js (test/fixtures/hook-payloads/stop-idle.json,
// copied byte-for-byte off the live store). Nothing hand-writes agent_state,
// which is the whole point - .claude/rules/worker-state.md's "enumerate every
// path that can write the value" exists because two full lanes of #24 reasoned
// from an observed value to a presumed writer and neither checked.
//
// WHY THIS IS NOT THE STALE-IDLE DEFECT LANE A ALREADY FIXED. resumeAgent's
// flip resets agent_state to 'unknown' and state_changed_at to NULL, which
// closed the case where a PRE-CLOSE latch survived the resume and satisfied
// standingIdleRows on the first tick. This defect is the opposite: the idle
// here is GENUINE and FRESH, written by a real Stop hook seconds after the
// resume, so that reset cannot touch it and idleIsAFreshTransition is correctly
// true for it. A fix aimed at the latch would look right and do nothing.
```

## line 55

```
// This file's own watch owner, distinct from the spawn sibling's: both seed a
// dead-paned lead, and an actor id shared between two files sharing a store
// would collide.
```

## line 67

```
// The watch's owner is a lead whose pane is deliberately NOT in any snapshot
// below. A filed notice is a real due-now timer, so the next tick tries to
// deliver it, and delivery types at a terminal; a lead-owned wake whose pane
// is not live is HELD rather than typed (deliverable()'s lead exemption), so
// these cases reach the code under test and stop short of a real paste. The
// method is test/standing-watch.test.mjs's, for its reasons.
```

## line 83

```
// A standing watch over the project, seeded directly rather than through
// wake_when_idle so its owner is the dead-paned lead above.
```

## line 87

```
// EVERY ASSERTION BELOW IS OVER NOTICE CONTENT, NEVER OVER A ROW COUNT, and
// that is a correctness requirement of this harness rather than a style choice.
// This file needs an McpClient (only the real tools can park and resume) AND an
// in-process tick(), and the MCP server starts a scheduler of its OWN on a
// 3000ms interval (startScheduler, src/index.ts) against this same store. So a
// SECOND, real tick can land inside any test here at any moment, with a REAL
// tmux snapshot rather than the synthetic one passed below - which sees every
// leftover worker from earlier tests in this file, several of which are
// legitimately idle and reportable. A `notices.length === 1` assertion is
// therefore a coin flip on machine load, and it failed exactly that way: green
// run after run in isolation, then red once under a full `npm test` where the
// concurrent files stretch a test past a 3s boundary.
//
// Counting was also the WRONG QUESTION. What every case here is about is
// whether a particular worker is named as finished, so asking that directly is
// both robust and more precise - and it stays red under mutation, since an
// unsuppressed restore turn puts that name in SOME notice regardless of how
// many notices exist.
//
// test/standing-watch.test.mjs can count because it has no MCP server at all -
// it drives tick() inside runFixture children. Do not copy its counting
// assertions here without also removing the server.
// BOTH MATCHERS ARE test/helpers.mjs's NOW, shared with the spawn-side sibling
// rather than copied into it (/simplify, two seats): they encode the notice
// FORMAT, and both files' headline assertions are silence assertions, so a
// stale second copy would answer false for every worker and go vacuously
// green. Why the match is anchored, and why GONE is excluded, is written where
// they live.
```

## line 121

```
// The restore turn ending: a real Stop hook, for the resumed worker's own
// actor_id, carrying a payload Claude Code has actually been observed sending.
```

## line 124

```
// "stop", not "Stop": the hook's own argv vocabulary is lower-case
// (stateFor, src/hook.ts), and the capitalised Claude Code event name falls
// through its default branch to "waiting" - a value that is never idle and
// would have made this whole file quietly prove nothing.
```

## line 136

```
// Park and resume a fresh worker, returning its row. The full real path: the
// worker carries a session id from its own spawn (--session-id, issue #154),
// agent_park stamps the row, agent_resume reuses it.
```

## line 144

```
// THE WORKER IS GIVEN ITS LANE BEFORE IT IS PARKED, matching the real-world
// shape: a park follows work. Todo 387 removed the reason this used to be
// LOAD-BEARING (counselors F2, two seats) - launchAgent no longer stamps
// resumed_at at spawn, so resumed_at is already '' before this prompt ever
// fires, and the assertion below would hold with or without it. Kept for
// the realism rather than deleted: a worker that was truly never spoken to
// before a park is a different, narrower case than this file's subject
// (issue #156's resume defect), and test/spawn-false-finish.test.mjs pins
// that one - a spawned worker has no turn at all until briefed.
```

## line 167

```
// A real UserPromptSubmit - the assignment finally arriving. This is the one
// event that clears the suppression, and driving it through the built hook
// rather than writing the column is what makes the clearing half real too.
```

## line 183

```
// Straight after the resume the row is exactly where a fresh spawn starts:
// no claim about liveness until a real hook event makes one. This is lane
// A's reset, and proving it here is what separates the two defects.
```

## line 192

```
// And now the row says idle, freshly, with nothing having asked the worker
// to do anything. THAT is the defect's premise: not a stale value, a true
// one about a turn nobody wanted.
```

## line 199

```
// Asserted over agent_state_log, never over a sample of agents.agent_state:
// a sample is not evidence about a state machine (worker-state.md,
// test/CLAUDE.md), and this row is overwritten in place.
```

## line 216

```
// A synthetic AliveSnapshot carrying the resumed worker's REAL pane, the
// method test/scheduler.test.mjs established. The lead's %deadlead is
// absent, so any notice is held rather than typed.
```

## line 223

```
// BEFORE THE FIX THIS WAS 1, and the notice read the way the issue records
// it: "t348-fixround: idle for 1s, last log event: stop (0s ago)" for a
// worker that had not been given its assignment yet.
```

## line 232

```
// THE OTHER HALF, AND THE ONE THAT MAKES THIS A SUPPRESSION RATHER THAN A
// MUTE. The assignment arrives as a real user turn, the worker works, and
// the finish after that is genuine news the lead is waiting on.
```

## line 255

```
// The defect was OBSERVED through a standing watch, but watchedStates
// reads the same row for a one-shot over an explicit list. Fixing only the
// half that was observed is how a defect ships twice.
```

## line 267

```
// ASSERTED ON held_at, NOT fired_at, and the reason is worth stating so a
// later reader does not "fix" it back. maybeFireIdle decides `ready` and
// then consults deliverable(), which HOLDS a lead-owned wake whose pane is
// not live (HELD_REASON_LEAD_PANE_DEAD) - and %deadlead is deliberately
// absent from every snapshot in this file, so no case here ever types at a
// terminal. A held wake is never claimed, so fired_at stays null whether
// the wake became ready or not, and asserting on it would pass against
// both versions of the code. held_at moves only once the wake is READY,
// which is precisely the decision under test.
```

## line 292

```
// THIS READER WAS MISSED ON THIS LANE'S FIRST PASS and is the reason the
// predicate moved into stateProvenance.ts. wake_when_idle's mode="all"
// shortcut reads agents.agent_state directly and returns before any
// scheduler code runs, so the two fixes in src/scheduler.ts did nothing
// for it: a lead that resumes a crew and immediately sets a mode="all"
// wake was told every worker was already finished.
// deliver_to names the worker itself: resolveDelivery runs BEFORE the
// already_satisfied shortcut and refuses a caller that is not inside tmux,
// which the test process is not. Its own pane is the one target here that
// is guaranteed to exist, and the fake claude behind it does nothing with
// what lands there.
```

## line 311

```
// Scheduled rather than short-circuited, so cancel it: a real pending wake
// left behind would be delivered by the MCP server's own scheduler during
// a later test in this file.
```

## line 316

```
// And the shortcut still works for a worker that really has finished, or
// this would be a mute rather than a suppression.
```

## line 329

```
// A parked row is status='closed' with agent_state 'working' or 'unknown',
// which is byte-for-byte what standingGoneRows was built to report: a
// worker frozen mid-work with no terminal left to read. So every park used
// to file one false obituary - "hive last read it as unknown ... check its
// branch, its todo and any pad it was writing" - about a lane the lead had
// just deliberately paused. At 18:00 with a crew of four, that is four.
```

## line 344

```
// FOUND AS A FLAKE, WHICH IS WHY THE WINDOW IS NAMED HERE: the MCP
// server runs its own 3s scheduler, and it sometimes ticked in the few
// hundred milliseconds between the park and the resume in the tests below.
// That read as test cross-talk and was the product.
```

## line 372

```
// THE ONE LINE THE TEST ABOVE STOPS SHORT OF. agent_close on a parked row
// RELEASES the stamp: parked_at goes back to '' and nothing else on the
// row moves - not closed_at, not agent_state. So on the very next tick the
// row satisfies every clause of standingGoneRows again (closed, state
// still 'working' or 'unknown', parked_at now '', closed_at not null), and
// the episode is still unreported BECAUSE THE PARK SUPPRESSION WAS A
// FILTER RATHER THAN A CLAIM - no cursor row was ever written for it.
//
// The lead abandons a lane at 09:00 and is told the worker DIED, with last
// night's timestamp and instructions to go excavate its branch. That is
// verbatim the failure the park exclusion exists to prevent, displaced by
// one call.
```

## line 398

```
// The case that makes watching from outside worth doing at all is a turn
// that dies mid-response: precisely the worker that cannot report itself.
// Suppressing that alongside the restore turn would trade one silent
// failure for a worse one.
```

## line 410

```
// Todo 384 comment 944. hive knows resumed_at was still set when this row
// closed, which means it was never given anything - so the ordinary
// obituary's "check its branch, its todo and any pad it was writing" is
// advice to go excavate work that cannot exist. Same row, same query,
// different sentence.
```

## line 428

```
// COUNSELORS FOUND THIS AND THE TEST ABOVE IS WHY IT WAS MISSED: that one
// kills the worker while agent_state is still 'unknown', so it never
// touches the interesting shape. Here the restore turn ENDS first, which
// freezes agent_state at 'idle' - and standingGoneRows excludes 'idle' on
// the premise that an idle worker's finish "has already been reported".
// The suppression is exactly what makes that premise false. Before the
// fix, this worker was silent in BOTH halves: no finish (suppressed) and
// no obituary (excluded as already-reported), forever.
```

## line 451

```
// FIX ROUND 1, FINDING 4. This is the exact row the reviewer named: a
// resumed worker whose restore turn ENDED (state_changed_at is set by
// that real Stop hook) while resumed_at is STILL set, because nothing
// ever sent it a real assignment to clear the latch. hive cannot tell
// from here whether that Stop was the restore alone or a restore that
// absorbed a real assignment landing in the same busy window (the exact
// shape #156 added the gone disjunct to report) - so it must NOT claim
// "nothing was in flight" about a row it cannot see into. The first
// version of this fix got this wrong, claiming resumed_at alone was
// proof enough.
// Anchored to THIS worker's own line, not the whole (batched) body: the
// notice above also reports ff-parked/ff-abandon/ff-death from earlier
// cases in this file, and they correctly DO carry "never given an
// assignment" on their own lines - a blanket doesNotMatch on the full
// body would fail for the wrong reason. The positive match below is
// sufficient on its own: a GONE line carries exactly one of the two
// sentences, never both, so proving it is the branch/todo/pad one
// already proves it is not the other.
```

## line 485

```
// Both end a turn in the same tick. One is a restore turn, one is a real
// finish by a worker that was never parked.
//
// THE NEIGHBOUR IS GIVEN ITS ASSIGNMENT FIRST - realism, not a load-
// bearing requirement anymore. Todo 373 once made a plain spawn carry the
// same suppression a resume does; todo 387 removed that (a fresh worker's
// pane gets no turn at all until briefed, so there is nothing to suppress
// even without the prompt below). Kept as the true-to-life control shape:
// a real finish reported alongside a suppressed restore turn, in the same
// tick.
```

## line 500

```
// The whole case in two lines: the never-parked neighbour's finish is
// news, the resumed worker's restore turn is not, and both ended a turn in
// the same tick.
```
