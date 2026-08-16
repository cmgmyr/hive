# Attic: test/split-window-stale-actor-id.test.mjs

Comments removed from `test/split-window-stale-actor-id.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 7

```
// Lead review round 1, item A on todo 267. A lead's actor_id is DELIBERATELY
// REUSED across a restart: ensureLeadRow (src/cli.ts) mints a NEW running row
// that carries the CLOSED row's old actor_id forward, so the closed row's
// stale tmux_target survives for stillThere's own adoption check. So after
// any lead close-and-restart, two rows can share one actor_id - a closed one
// holding a STALE pane and a running one holding the real pane -
// splitTargetWindow's parent lookup (src/spawn.ts) must resolve the RUNNING
// one, never whichever row an unscoped `WHERE actor_id = ?` with no ORDER BY
// happens to return first (ordinarily the lower, closed, rowid).
```

## line 68

```
// A real, ALIVE pane in a DIFFERENT window - what the closed row's
// stale tmux_target looks like when it has not actually died. Built by
// spawning a genuine placement="window" worker through the real lead,
// not a synthetic fixture, so this is a real pane in a real window.
```

## line 81

```
// todo 371: a row's tmux_target is a PANE id for every placement now, so
// the window has to be resolved from that pane. Reading it off the receipt
// made this comparison a pane id against a `session:@n` string, which can
// never be equal - the assertion below stopped being able to fail.
```

## line 91

```
// Inserted FIRST, so it gets the LOWER id - reproducing the real shape:
// the closed row is the OLDER one, and a restart's new running row
// always gets a HIGHER id than whatever it reused the actor_id from.
// Distinct `name` values: idx_agents_running_name only allows one
// status='running' row per (project_id, name), and the real lead row
// already holds "lead" - splitTargetWindow's lookup is by actor_id,
// not name, so the name here is otherwise irrelevant.
```
