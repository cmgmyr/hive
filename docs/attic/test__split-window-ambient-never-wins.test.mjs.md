# Attic: test/split-window-ambient-never-wins.test.mjs

Comments removed from `test/split-window-ambient-never-wins.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 7

```
// Lead review round 1, item B on todo 267. test/split-window-parent-
// placement.test.mjs proves the store lookup does work findProjectWindow
// alone cannot, but every McpClient in that file happens to have no
// TMUX_PANE in its env at all, so it cannot tell "the store is consulted"
// from "ambient still wins when the two disagree, but nothing here ever
// sets ambient" - the gap that file's own header names. This file closes it:
// pad 71's actual failure case, verbatim - "a second claude session in the
// same project spawns into ITS OWN window rather than the lead's, because
// TMUX_PANE names whoever called." A plain `user:<name>` caller (no
// HIVE_AGENT_ID, so no agents row of its own) with a REAL, live TMUX_PANE
// sitting in a DIFFERENT window must still land in the project's stamped
// window, never at wherever that ambient pane happens to be.
```

## line 57

```
// A REAL, alive pane in a DIFFERENT window - what ambient TMUX_PANE
// would name if this caller happened to be sitting in one.
```

## line 72

```
// todo 371: a row's tmux_target is a PANE id for every placement now, so
// the window has to be resolved from that pane. Reading it off the receipt
// made this comparison a pane id against a `session:@n` string, which can
// never be equal - the assertion below stopped being able to fail.
```

## line 80

```
// No HIVE_AGENT_ID: currentActor() resolves to a plain user:<name>,
// which has no agents row - a caller that is not a lead, exactly the
// "unattended run / not-a-lead caller" case the fallback exists for.
// TMUX_PANE is set to the real, live, DIFFERENT stray pane above.
```
