# Attic: test/wake-cancel-lead-override.test.mjs

Comments removed from `test/wake-cancel-lead-override.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 6

```
// Issue #149 (todo 348) comment 763, fix round 1, finding 2 (counselors).
// HELD_REASON_PANE_REISSUED_WORKER names wake_cancel as the remedy for a
// held, worker-owned wake. wake_cancel used to be owner-scoped only
// (`WHERE ... AND owner = ?`), and a plain wake_set with no deliver_to makes
// the worker both owner and deliver_actor - so once the janitor closes that
// worker's row (this lane's own step-4 widening), the actor_id that could
// ever satisfy `owner = currentActor()` belongs to a session that no longer
// runs. Nobody could ever call wake_cancel and get it to match: the remedy
// named a caller that cannot reach it. A running lead can now cancel any
// pending wake in the project, matching the reasoning that made "hold" safe
// in the first place - a lead is the one wake_list and hive status's
// heldWakes count are visible to, so the lead is the one who needs the power
// to act on what it can already see.
//
// No tmux needed: isRunningLeadActor (src/spawn.ts) is a pure row check
// (kind='lead', status='running', actor_id match) with no pane involved.
// isolateTmux() is still called at module top level per test/CLAUDE.md - the
// MCP server's own scheduler reaches tmux regardless of what this file
// asserts.
```

## line 47

```
// A real, running kind='lead' row - the fact isRunningLeadActor checks.
// No tmux_target needed; the check never reads it.
```
