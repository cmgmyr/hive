# Attic: test/scheduler.test.mjs

Comments removed from `test/scheduler.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 7

```
// Issue #49. Once storeReplaced() (src/db.ts) is tripped, tick() must do none
// of its work - no janitor sweep, no retention, no hourly backup, no timer
// delivery - and never throw. Separately, the interval startScheduler created
// must actually stop, not just keep firing a tick() that no-ops forever.
//
// Every fixture below constructs its own AliveSnapshot literal ({ panes,
// windows }) rather than reaching real tmux, so nothing here needs
// isolateTmux(): an empty snapshot means "nothing alive", matching what
// src/tmux.ts documents for a server that answered with nothing running.
```

## line 17

```
// Seeds a project, one running agent whose pane will not be in the snapshot,
// one stale agent_state_log row, and one due, undeliverable timer. Shared by
// both the tripped run and its control so the only difference between them
// is the latch.
```

## line 76

```
// If tick() threw, this await would reject and the fixture process
// would exit non-zero, which runFixture already asserts against.
```

## line 95

```
// Observe clearInterval without touching production code: wrap the
// globals before startScheduler ever calls setInterval.
```

## line 108

```
// Long enough for several 20ms ticks to have had the chance to fire.
```
