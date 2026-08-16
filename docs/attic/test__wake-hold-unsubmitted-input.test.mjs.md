# Attic: test/wake-hold-unsubmitted-input.test.mjs

Comments removed from `test/wake-hold-unsubmitted-input.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 8

```
// Todo 270. Chris's call 2026-08-05, after it bit him on both machines: he
// was typing into the lead's pane, a wake came due, and hive pasted the wake
// body after his half-typed text and pressed Enter, submitting both as one
// message. `deliverable()` (src/scheduler.ts) already held a wake against a
// pane sitting on a MODAL - this is that hold's sibling condition, for a
// pane whose input box is genuinely present but carries real unsubmitted
// text, which the modal check cannot see (a modal replaces the input box
// entirely; this is the opposite shape, box present, no dialog).
//
// Set a real wake against a real pane showing one of this project's own
// captured claude 2.1.220 screens, and read wake_list (the real MCP tool,
// through a real running server on its own natural scheduler tick) - the
// same method test/wake-delivery-state.test.mjs uses for the modal hold,
// applied to this sibling condition. Assert over wake_list's own held_at/
// typed_at, not a sample of pane content or agent_state - the timers row's
// own account of what happened, matching test/CLAUDE.md and
// .claude/rules/worker-state.md.
```

## line 82

```
// Held: real-input.txt's own box carries genuine unsubmitted text
// (issue #34's own honest control), so the scheduler must hold
// rather than paste onto it. MUTATION 2's proof lives here - remove
// the hold and this wake types within a tick or two instead of
// sitting held.
```

## line 101

```
// Stays held across several more ticks, not just the first one seen -
// the accepted residual (no timeout, matching the dialog hold's own)
// means this must not resolve on its own while the text is still up.
```

## line 110

```
// Clear it by replacing the pane's screen with a genuinely empty
// input box (ready-idle.txt), same pane id (tmux wipes the screen on
// respawn) - the state change under test.
```

## line 126

```
// The negative controls: a ghost suggestion, the queued-messages hint,
// and a genuinely empty box must NOT hold - a hold that fires on any of
// these holds every idle pane forever, since ready-idle.txt's own empty
// box is what a pane looks like between turns. MUTATION 1's proof lives
// here - broaden the hold to ghost/empty and one of these three starts
// sitting held instead of delivering.
```
