# Attic: test/lead-doctor-liveness.test.mjs

Comments removed from `test/lead-doctor-liveness.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 8

```
// Issue #27, L4 fix round, DECISION 3's other half: src/scheduler.ts's
// janitor now deliberately never closes a kind='lead' row on its own (see
// ensureLeadRow's comment, src/cli.ts), so a lead whose pane died would
// otherwise sit status='running' forever with nothing saying so. `hive
// doctor` gained the report that used to be the janitor's silent sweep.
//
// Issue #27's L4 fix round R7, todo 171. CI was red on this file from
// 103db7b onward: every test here asserted `out.code === 0`, and a GitHub
// runner installs only node and tmux, never claude, so doctor's own
// `check("claude", ...)` correctly FAILs and doctor correctly exits 1 -
// this is right product behaviour, not a bug. The exact mistake
// test/doctor-profile.test.mjs's own comment already names (counselors
// review on PR #47, finding 2, both seats independently): never assert
// doctor's absolute exit code, compare the failure count relative to a
// baseline taken on the SAME machine instead, via failureCount
// (test/helpers.mjs). Do not "fix" this by downgrading doctor's claude
// check to a warning - hive without claude is genuinely broken, and FAIL is
// the correct level; the bug was this file's assumption, not doctor's
// verdict.
```

## line 28

```
// doctor runs the janitor, which reaches tmux; isolate first (test/CLAUDE.md).
```

## line 46

```
// No lead row exists yet - the baseline this file's failure-count deltas
// are measured against, on whatever this machine's own check outcomes are
// (claude present or not).
```

## line 56

```
// Immune: "lead:" is only ever printed by the two warn("lead", ...) call
// sites in src/cli.ts (a not-live pane, or a probe that could not
// answer), and both sit inside `if (a running lead row exists)`, which
// this baseline has none of. Nothing else in doctor's report is labeled
// "lead", and dirs.projectDir's scratch suffix (mkdtemp) is alphanumeric
// only, so it cannot itself spell out "lead:". A future doctor check
// that reused the "lead" label for something unrelated would inherit
// this false-quiet risk.
```

## line 79

```
// A warn, not a FAIL: reporting a dead-paned lead must not move the
// failure count on its own, on a machine that already fails the claude
// check just as much as one that does not.
```

## line 83

```
// Issue #27's L4 fix round R10, todo 182 item 2 (opus F4). agent_close is
// an MCP tool, not a `hive` CLI verb; this message used to say
// "`agent_close` it" as if it were one, sending a human at a bare
// terminal looking for a subcommand that does not exist.
```

## line 97

```
// Issue #27's L4 fix round R10, todo 180. Before the fix, targetLive('')
// read TRUE - tmux resolves an empty target to the CALLER's own current
// session rather than erroring - so a '' lead row (the exact shape a
// `hive lead` that dies between its INSERT and its CAS leaves behind,
// src/cli.ts's ensureLeadRow) read as live forever: this warning never
// fired, and agent_close refused to retire it.
```

## line 129

```
// Immune, same fact as the no-lead-row baseline case above: "lead:" only
// comes from the two gated warn("lead", ...) sites, and this pane is
// genuinely live so neither fires.
```
