# Attic: test/split-window-parent-placement.test.mjs

Comments removed from `test/split-window-parent-placement.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 7

```
// Todo 267 / plan-lane-3-tmux-topology. splitTargetWindow (src/spawn.ts) used
// to open with `process.env.TMUX_PANE`, the caller's own ambient pane. That
// happened to answer "the spawning lead's window" only by luck of derivation
// (under one shared session, the caller usually IS the lead). This file
// drives the REAL MCP entry point - two real `agent_spawn` calls chained
// through a real store row, never a helper - per
// dead-ends/2026-08-05-helper-whose-parameters-cannot-disagree.md: a helper
// whose two args are always made to agree proves nothing about the caller
// that matters. Neither McpClient process here ever runs inside tmux (no
// TMUX_PANE in its env), so any test that only proves "the worker landed in
// the project's window" cannot tell the store lookup from the old
// ambient-primary code's fallback - both give the same answer when ambient
// is empty. The tests below are built so the two answers DIFFER.
```

## line 89

```
// placement="window": worker0 gets its OWN dedicated window, distinct
// from and NOT stamped with the project's @hive-project-id
// (test/worker-first-window-stamp.test.mjs). So findProjectWindow(session,
// project.id) can never resolve to it - the only way a later spawn can
// land there is by resolving worker0's OWN pane from the store.
```

## line 102

```
// todo 371: a row's tmux_target is a PANE id for every placement now, so
// the window has to be resolved from that pane. Reading it off the receipt
// made this comparison a pane id against a `session:@n` string, which can
// never be equal - the assertion below stopped being able to fail.
```

## line 109

```
// Now worker0 itself is the spawning parent - drive the real MCP entry
// point as worker0 would (its own pane's process carries
// HIVE_AGENT_ID=worker0.actor_id, exactly as a real claude worker's does).
```

## line 145

```
// worker0's pane is real, alive, and on OUR OWN server - only the
// recorded socket disagrees, the same shape
// test/tmux-socket-foreign.test.mjs uses to fake "foreign" without a
// second real tmux server. rowLive() must refuse to trust this row's
// tmux_target on that basis alone (foreignSocket(), src/tmux.ts).
```
