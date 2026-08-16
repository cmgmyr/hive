# Attic: test/worker-first-window-naming.test.mjs

Comments removed from `test/worker-first-window-naming.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 7

```
// A worker spawned before its own project's lead has ever run: a real case
// (the first thing to happen in a brand-new store, e.g. right after a
// reboot), not an edge case to punt on. launchAgent's createdSession branch
// (src/spawn.ts) claims the session's fresh initial window directly, the
// same first-occupant path `hive lead` itself uses via claimInitialWindow -
// this file exercises it through agent_spawn instead, since it needs a
// session that does not exist yet, which none of the other lead-*.test.mjs
// files start from (isolateTmux is one call per file, at module top level,
// so a fresh-session scenario needs its own file rather than a nested
// describe reusing an already-created session).
```
