# Attic: test/spawn-pane-focus.test.mjs

Comments removed from `test/spawn-pane-focus.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 6

```
// Todo 316. tmux makes a newly split pane, or a newly created window, ACTIVE
// by default. A human typing into the pane or window that had focus when a
// spawn lands gets some of their keystrokes stolen by the worker's pane
// instead - confirmed in real use, not a hypothetical. This exercises the
// actual launchAgent code path (through agent_spawn) against a real tmux
// server, not a reimplementation of it, for the same reason
// worker-first-window-naming.test.mjs does.
```

## line 42

```
// First split-placed worker for this project claims the session's
// fresh initial window (claimInitialWindow, not the split-window path
// under test) and is the window's only pane, so it starts active -
// stand-in for "the human's pane already had focus".
```

## line 59

```
// Second split-placed worker goes through splitTargetWindow -> the
// split-window call in launchAgent (src/spawn.ts) - the exact call
// this todo is about, since worker-1's window already exists.
```

## line 89

```
// placement="window" runs through createWindow's new-window call
// (src/tmux.ts) - the sibling call this todo names explicitly ("check
// it rather than assuming they behave the same").
```
