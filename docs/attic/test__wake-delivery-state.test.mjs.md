# Attic: test/wake-delivery-state.test.mjs

Comments removed from `test/wake-delivery-state.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 19

```
// Issue #27, L3 step 4. This is runbook step 11 from plan-l3-delivery-states:
// set a real wake against a real pane, hold it behind a real dialog, clear
// the dialog, and read wake_list (the actual MCP tool, through a real
// running server on its own natural scheduler tick, not tick() called
// in-process) at each stage. Unit tests elsewhere pin the timers-table
// writes; nothing else exercises the OUTPUT this lane exists to make
// legible - the distinctions a lead actually reads.
//
// Issue #75 added a fifth: unconfirmed_busy, alongside confirmed, plain
// unconfirmed, no_confirmation_channel, and the null (nothing typed yet)
// case. One test below seeds typed_busy directly to pin the reporting
// layer's own NULL/0/1 boundary in isolation; a second, added in counselors
// round 1 (todo 209, item E3), drives a real wake_set through this file's
// real running server and its own natural scheduler tick against two real
// spawned targets - the lane's actual claim, busy vs idle reporting
// differently, THROUGH THE REAL PATH, not asserted only against a hand-set
// column.
```

## line 94

```
// Held: the dialog fixture is up, the scheduler's own tick sees it and
// records the hold, and this wake must still be in the PENDING list -
// never claimed, never gone - with the reason legible.
```

## line 114

```
// Clear the dialog by replacing what the pane is running, same pane id
// (tmux wipes the screen on respawn) - the state change under test.
```

## line 118

```
// Typed and unconfirmed: delivered now, gone from the pending list (a
// one-shot wake leaves it the moment it fires - ACTIVE_TIMER_WHERE),
// present in recently_delivered with typed_at set. This fakeClaude
// never runs a real hook, so it can never submit a UserPromptSubmit -
// confirmation must read "unconfirmed", not silently absent.
//
// Waits for typed_at specifically, not just presence in
// recently_delivered: fired_at (the claim) and typed_at (the attempt)
// are set by two separate writes roughly ENTER_DELAY_MS apart
// (src/tmux.ts's sendText sleeps between the paste and the Enter), so
// there is a real, legitimate window where a fired wake is already
// visible here with typed_at still null. Stopping at "just visible"
// makes this test race that window instead of testing the state it
// actually settles into.
```

## line 152

```
// Confirmed: write the hook row this fixture never generates, by hand,
// at or after typed_at, carrying THIS wake's own `[hive wake #<id>] `
// marker (counselors A1) - the exact shape a real UserPromptSubmit hook
// invocation writes when it is genuinely the wake's own paste that got
// submitted. The scheduler's OWN next tick must pick it up on its own,
// through checkConfirmations(), not because this test called anything
// about confirmation directly.
```

## line 171

```
// Todo 392. Observed live before this fix: a wake aimed at a worker
// sitting on an ordinary tool-permission prompt had fired_at set,
// typed_at set, held_at NULL - the hold above never ran, because the
// preview box's own `╰` made paneChoiceCheck answer "no dialog". Same
// hold as the folder-trust case above; the fixture is the bug itself.
```

## line 195

```
// Not just "not yet" - still held, and still nothing typed, after
// several more scheduler ticks against the SAME unanswered dialog.
// held_at is rewritten on every tick the hold still applies, so an
// advanced held_at is proof the ticks kept happening and kept holding.
```

## line 216

```
// Seeded directly: no L4 yet means the lead writes no agents row at
// all, and there is no way to make a fixture do that through the
// normal spawn path - a spawned worker always gets one.
```

## line 231

```
// Claimed but never typed: sendText itself never returned - the defect
// #27 exists to make legible in the first place. Must read as neither
// confirmed nor unconfirmed; forcing it into that pair would hide the
// more urgent fact that nothing was ever typed at all.
```

## line 265

```
// Issue #75. Reporting-layer half of the busy/idle distinction; the
// scheduler's own write of typed_busy is exercised in
// test/delivery-state.test.mjs's tick()-driven tests. This seeds the
// column directly and checks only what wake_list derives from it, which
// is what deliveryState() (src/tools/wakes.ts) actually reads. Each
// target needs a real agents row - unlike the no-channel case above,
// this is about the channel EXISTING but the delivery landing mid-turn.
```

## line 328

```
// Counselors round 1 (todo 209, item E3). The lane's central claim - a
// wake typed at a busy target reports differently from one typed at an
// idle target - was previously only hand-seeded at this reporting layer
// (the test above) or tick()-driven against a bare actor string with no
// real agent (test/delivery-state.test.mjs). Neither drove a real wake
// through the actual wake_set -> real running server's own scheduler
// tick -> wake_list path against a real spawned target. This does, for
// both targets in the same test, so a constant confirmation value cannot
// pass it. fakeClaude never runs a real hook, so each target's log is
// primed by hand the same way a real turn's hook invocation would leave
// it - the same technique the busy/idle table in delivery-state.test.mjs
// uses, just driven through wake_set/wake_list instead of tick()
// directly.
```

## line 389

```
// Counselors A6. Past the same retention window checkConfirmations()
// (src/scheduler.ts) uses, a typed one-shot's confirmed_at can never
// change again - hive has structurally stopped looking - so reporting it
// as "unconfirmed", the identical string used for a wake typed seconds
// ago that hive is actively still watching, is the exact ambiguity the
// tri-state exists to remove, reappearing on a case nobody enumerated.
```

## line 416

```
// Counselors A7. fired_at is whole-second, and a single tick fires every
// due timer in one loop, so several wakes sharing one fired_at is
// ordinary. ORDER BY fired_at DESC alone carries no stability guarantee
// for equal keys - id DESC is a real tiebreaker, not decoration.
```
