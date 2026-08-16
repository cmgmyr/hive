# Attic: test/hold-visibility-repeat-hold.test.mjs

Comments removed from `test/hold-visibility-repeat-hold.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 8

```
// Todo 409, round 2, finding 1 - the gap the round-1 test suite did not
// cover. test/typed-seen.test.mjs's own post-hold case proves first_held_at
// survives delivery for a ONE-SHOT wake, whose claim (claimOneShot) never
// touches first_held_at at all - so that test cannot see the defect a
// REPEATING wake has: fireDelay's own per-cycle claim UPDATE resets
// first_held_at as part of opening the next cycle, and that claim runs
// BEFORE deliver() - so a repeating wake held for several ticks and then
// delivered had its hold record wiped microseconds before the delivery
// could record it. Proven red against the pre-fix code (git stash the
// firstHeldAt threading through deliverable()/deliver() and rerun): wake_get
// reported first_held_at: null after a delivery that had genuinely been
// held, identical to an unheld delivery's.
//
// The fix threads the hold record through the same way typedSeen already
// is - captured off the row before the claim, passed into deliver(), and
// written back by recordTyped - but gated on held_at (not first_held_at
// itself) to avoid resurrecting a stale value from an earlier cycle; see
// test/hold-visibility-repeat-reset.test.mjs for that half. This test is the
// positive case those two do not cover between them: a GENUINE hold on the
// cycle that then delivers, on a REPEATING wake specifically.
```

## line 59

```
// real-input.txt carries genuine unsubmitted text, which
// deliverable()'s own unsubmitted-input hold (holdTimer) holds against -
// the same fixture and mechanism test/wake-hold-unsubmitted-input.test.mjs
// and typed-seen.test.mjs's post-hold case already use, applied here to
// a REPEATING wake for the first time.
```

## line 79

```
// Cycle 1 becomes due and holds: the pane's unsubmitted text is up, so
// deliverable() holds every tick until the box clears.
```

## line 90

```
// Clear the box, matching the one-shot post-hold test's own method:
// repaint the same pane to an idle screen so deliverable() stops
// holding and cycle 1 finally delivers.
```

## line 101

```
// THE ACTUAL FINDING. Round 1's fix left this null - the reset that
// opens the next cycle runs before deliver() records the delivery, so
// "deliver() never clears it" was not enough on its own.
```
