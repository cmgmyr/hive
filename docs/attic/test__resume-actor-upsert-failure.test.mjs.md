# Attic: test/resume-actor-upsert-failure.test.mjs

Comments removed from `test/resume-actor-upsert-failure.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 8

```
// Gate finding on PR #161 (issue #154, todo 353): resumeAgent's
// upsertActor(...) call used to sit BETWEEN the flip UPDATE (which had
// already committed status='running', tmux_target='', pane_pid='') and the
// paneUp-guarded try that follows it. A throw there - SQLITE_BUSY past
// busy_timeout under contention with a concurrent withWindowClaim holder is
// the realistic case - skipped the catch entirely and stranded the row
// 'running' with no pane: the empty tmux_target the flip deliberately
// writes to dodge the janitor-race all three counselor seats found is
// EXACTLY what excludes a stranded row from ever being swept
// (janitor()'s agents sweep requires tmux_target != '').
//
// This test proves the fix (upsertActor moved inside the existing try) by
// injecting the failure directly, per the same pattern
// test/spawn-cwd-scope.test.mjs's "finding 5" uses for launchAgent's
// identical class of late failure: monkey-patch db.prepare to intercept
// upsertActor's own SQL and throw, then assert the ROW, not just that the
// call throws. Asserting only "resumeAgent throws" would pass on both the
// old and the fixed code and prove nothing - the deciding fact is whether
// the row reverts to 'closed' afterward.
```

## line 53

```
// upsertActor's own SQL (src/spawn.ts). The literal has to track
// that statement, or the patch silently stops matching and
// resumeAgent just succeeds against a real tmux fork - so it is
// shared with the other file that patches it rather than typed here
// (test/helpers.mjs, UPSERT_ACTOR_SQL_PREFIX).
```
