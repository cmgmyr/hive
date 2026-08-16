# Attic: test/lead-pane-target.test.mjs

Comments removed from `test/lead-pane-target.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 9

```
// Issue #27, L4 fix round, DECISIONS 1 and 2 (pad brief-l4-counselors-round).
//
// DECISION 1: the lead's tmux_target must be a pane id (%N), never
// session:window. wakes.ts's resolveDelivery prefers the agents row's
// tmux_target over TMUX_PANE, and tmux resolves a window-shaped send-keys
// target to that window's ACTIVE pane - a split worker's, once one is
// running there - so a window target silently misdelivers a lead-directed
// wake to the wrong terminal. The first test below proves the fixed shape
// delivers correctly, then manufactures the pre-fix (window) shape directly
// on the row to prove it misdelivers - the negative control the brief asks
// for, without reverting any code.
//
// DECISION 2: a found window is not proof of a live lead - split workers
// keep it open (and keep matching leadTitle) after the lead's own claude
// exits. The second test kills only the lead's own pane, leaving the split
// worker's pane (and so the window) alive, and asserts a restart notices and
// gets a fresh pane actually running leadCommand rather than silently
// recording the worker-occupied window.
```

## line 56

```
// Issue #27's L4 fix round R9, todo 179 item 1 (opus F6). Dumps the
// LEAD's own pane env on every launch, ground truth for what cmdLead's
// envFlags actually delivered - the same technique
// test/lead-data-dir.test.mjs and scripts/step11-substitute.mjs use.
// Every OTHER test that measures a pane's real environment happens to
// go through claimInitialWindow (a session that does not exist yet);
// this file's own "found window" restart test below is the one place
// in the whole suite that reaches the split-window call, and until this
// marker, nothing there ever read its env back - deleting `...envFlags`
// from that call left the whole suite green.
```

## line 92

```
// A split worker lands in the lead's own window (splitTargetWindow
// finds it by title) - the layout DECISION 2's "window survives the
// lead" scenario needs. Todo 316 made the split land WITHOUT taking
// pane focus, so DECISION 1's negative control below (which needs the
// worker pane active, to prove a window-shaped target misdelivers to
// whichever pane is) now sets that up explicitly instead of getting it
// for free from the split.
```

## line 106

```
// A tmux target that is EMPTY means "the current pane", not "nothing" -
// `select-pane -t ""` silently retargets whatever is focused, and
// `capture-pane -t ""` reads it. This file does both with workerTarget,
// so an empty value here would not fail: it would quietly assert about
// the wrong pane and pass. Todo 316 added the select-pane below, which
// is the first one in this repo, so pin the precondition here rather
// than leaving the trap for whoever copies that line next.
```

## line 131

```
// POSITIVE: the shape `hive lead` now records.
```

## line 143

```
// NEGATIVE CONTROL: manufacture the shape the pre-fix code recorded
// (src/cli.ts:465 stored claimInitialWindow's discarded `window`, not
// its `pane`) directly on the row, without reverting any code, and
// show resolveDelivery's own send-keys target misdelivers under it.
```

## line 152

```
// Todo 316 stopped the split above from taking pane focus, so a
// window-shaped target would otherwise still resolve to the lead
// pane's own default focus rather than exercising the misdelivery this
// control exists to prove. Select the worker pane explicitly to
// reconstruct the pre-316 layout this control needs, without touching
// the fixed delivery path itself.
```

## line 191

```
// Kill only the lead's own pane. The window survives because the split
// worker's pane is still in it - the exact shape that made the pre-fix
// "found window" branch launch no command at all.
```

## line 197

```
// Issue #27's L4 fix round R9, todo 179 item 1. Removed so the marker
// read below can only be THIS split-window launch's own write, never
// a stale leftover from before()'s earlier claimInitialWindow launch.
```

## line 210

```
// The substantive check this test exists for now: this restart went
// through the split-window call specifically (a found window, no
// stillThere pane), and until now nothing in the suite ever read that
// one call site's env back out of a real pane. Deleting `...envFlags`
// from cli.ts's split-window call left every other test green.
```

## line 236

```
// Not just a pane existing - leadCommand must actually be running in
// it. The pre-fix branch recorded the window with nothing launched;
// "some pane exists" alone would not catch that regression, since the
// worker's own pane already satisfies it.
```
