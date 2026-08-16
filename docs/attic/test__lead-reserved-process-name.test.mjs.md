# Attic: test/lead-reserved-process-name.test.mjs

Comments removed from `test/lead-reserved-process-name.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 6

```
// Issue #27's L4 fix round, DECISION 7c, the hive.yml half. Same shape as a
// worker spawned with name "lead" (test/agent-names.test.mjs), through the
// other door: a hive.yml `processes:` entry named "lead" reaches
// startYmlCommand (src/cli.ts) directly, which never called requireNameFree
// in the first place. Two bugs, not one: its own "already running?" lookup
// carries no kind filter, so it could mistake the REAL lead's row for its
// own and report "already running" without starting anything; and if no
// lead happened to be running yet, launchAgent would take the name outright,
// so the next `hive lead` would collide on idx_agents_running_name the same
// way agent_spawn used to.
```

## line 62

```
// IMMUNE to generated data: stdout also carries this run's scratch
// project path, but that path (and every other generated value in this
// file - session name, pids) is built from mkdtemp's alnum-only random
// suffix or a numeric pid, neither of which can ever produce a SPACE.
// "already running" is only ever printed by cmdStart's own reservedName
// guard (src/cli.ts ~line 359); nothing generated here can spell it.
```
