# Attic: test/split-target-window-outlives-view.test.mjs

Comments removed from `test/split-target-window-outlives-view.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 8

```
// Pad 79, T5(a). paneWindow() (src/tmux.ts) resolves a pane's window as
// `#{session_name}:#{window_id}`, and once the window is grouped with a view
// session (todo 279, "always attach through a view"), list-panes can and does
// answer with the VIEW's name rather than the base session's - the identical
// fact adoptableWindow's own comment already measured for cmdLead's adopt
// path (src/tmux.ts, todo 276). splitTargetWindow (src/spawn.ts) used to hand
// that straight back to launchAgent's split-window call. A view is
// destroy-unattached: transient by design, gone the instant its client
// detaches. A target built from its name outlives it by seconds and then
// names a session nothing can find - split-window fails, launchAgent sees
// paneUp === false, DELETEs the agents row, and rethrows a raw tmux error
// naming a session the caller never heard of.
//
// The actual failure window is two back-to-back synchronous tmux forks
// inside one function call (paneWindow(), then split-window) with no yield
// to the event loop between them - not reproducible by racing a real view's
// destruction against it. So this pins the property the fix establishes
// instead, the same way initial-window-claim's deterministic half does
// (plan-lane-3-tmux-topology pad, "DETERMINISTIC ON PURPOSE... carry a
// FIXTURE CHECK proving they recreate the state the race produces"): first
// prove the defect's surface is real (a live view makes paneWindow answer
// with the view's name for a pane it does not even contain), then prove the
// target splitTargetWindow hands back survives the view's death - which is
// exactly what a target built from the view's name cannot do.
```

## line 72

```
// Every attach takes a view now (todo 279), unconditionally - no base
// client is needed to make one exist.
```
