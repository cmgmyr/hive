# Attic: test/hold-visibility-repeat-reset.test.mjs

Comments removed from `test/hold-visibility-repeat-reset.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 8

```
// Todo 409, edge 1 - the half of the lane that is not in the todo's own text.
// first_held_at (src/db.ts's migration; src/scheduler.ts's TimerRow) is a
// per-CYCLE fact: the first tick a wake was held this cycle. A repeating
// wake reuses one row across many deliveries, and the per-cycle reset UPDATE
// in fireDelay (src/scheduler.ts, next to typed_at/confirmed_at/held_at/
// held_reason/typed_busy/typed_seen) is what clears it BETWEEN cycles -
// deliver() then re-writes it for THIS cycle from the value it captured
// before that claim ran (see test/hold-visibility-repeat-hold.test.mjs for
// that half, a genuine hold on the cycle that delivers). This test is the
// other half: the reset itself, proving cycle 1's hold does not leak into
// cycle 2's report once cycle 2 has nothing holding it.
//
// Miss the reset and a wake held once is reported as held on every fire after
// it, forever: a stale hold from a morning cycle would read as evidence a
// cycle fired hours later was also held. This test seeds that stale record
// directly after a real cycle 1 delivers, then asserts a real cycle 2 -
// delivered with nothing holding it - reports no hold at all.
```

## line 71

```
// Cycle 1: an ordinary immediate delivery against an idle pane, nothing
// holds it. Wait for it to actually deliver before seeding the stale
// hold record below, or the seed could be overwritten by the very
// reset it is trying to prove works.
```

## line 80

```
// Simulate what a REAL hold on cycle 1 would have left behind - the
// shape holdTimer()/claimModalHoldWithNotice() write - directly, rather
// than orchestrating a genuine dialog or unsubmitted-input hold on a
// repeating timer (test/hold-visibility-repeat-hold.test.mjs covers a
// real hold on a repeating cycle end to end). What matters here is only
// whether the NEXT cycle's claim clears it.
```

## line 90

```
// Cycle 2: repeat_every_seconds later, against the same idle pane.
// Nothing holds this cycle either.
```
