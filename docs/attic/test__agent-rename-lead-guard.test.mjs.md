# Attic: test/agent-rename-lead-guard.test.mjs

Comments removed from `test/agent-rename-lead-guard.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 6

```
// Issue #27's L4 fix round, DECISION 4/5. "lead" is the addressing handle
// every wake, pad and todo comment uses for this project's lead, and
// ensureLeadRow (src/cli.ts) keys its own lookup on kind='lead' + running
// rather than on the name (DECISION 5) - so a rename would not strand the
// row, it would let the NEXT `hive lead` mint a SECOND lead identity under
// the freed name while the renamed row goes on being the real one under a
// name nothing points at any more. agent_rename refuses a lead outright.
```

## line 36

```
// Same reasoning as agent-close-lead-guard.test.mjs: only one running
// "lead" row per project (idx_agents_running_name), so a refused rename
// that correctly leaves the row alone would collide with the next test's
// seed unless cleared first.
```
