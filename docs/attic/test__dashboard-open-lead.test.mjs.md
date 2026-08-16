# Attic: test/dashboard-open-lead.test.mjs

Comments removed from `test/dashboard-open-lead.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 8

```
// Todo 356, correction round. Counselors (both seats, independently) and
// Chris's own check at the source (src/cli.ts's `let command = args[0] ??
// "lead"`) found that bare `hive` dispatches to cmdLead, not cmdAttach - so
// the first version of this feature, wired to cmdAttach only, never fired on
// the trigger the todo actually asked for ("when initially calling `hive`").
// This file is the sibling of test/dashboard-open.test.mjs for that
// corrected trigger: bare `hive` / `hive lead` opens the dashboard, and
// `--no-dashboard` (which scripts/restart-lead.sh now always passes) does
// not. test/dashboard-open.test.mjs still owns the underlying gates
// (darwin/hive.yml/file-existence/kv-marker/TTL/containment) - not repeated
// here.
```

## line 139

```
// Counselors, delta round on todo 356: three flag-parsing gaps the cmdLead
// wiring introduced, all fixed in the same commit as these tests.
```

## line 187

```
// The whole point of this check: a silently-ignored typo would have
// reached maybeOpenDashboard un-suppressed and opened a window.
```
