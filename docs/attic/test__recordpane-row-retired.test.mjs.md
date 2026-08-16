# Attic: test/recordpane-row-retired.test.mjs

Comments removed from `test/recordpane-row-retired.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 8

```
// COUNSELORS, ALL THREE SEATS, ISSUE #156. THE INVARIANT UNDER TEST IS ONE
// SENTENCE: recordPane must not write a pane onto a row that is no longer
// running.
//
// HOW IT WAS REACHED. resumeAgent's flip commits status='running' with
// tmux_target='' - deliberately, to take the row out of the janitor's
// `tmux_target != ''` sweep while the resume is in flight. A concurrent
// agent_park reading that row gets `{live: false}` from targetLiveProbe('')
// (FALSE, not null, src/tmux.ts), so its "unknown liveness is never dead"
// refusal does not fire, it kills nothing, and parkAgentRow's CAS compares ''
// against '' AND MATCHES. The row goes closed+parked mid-resume, and
// recordPane then wrote the live pane onto it: a running `claude --resume`
// process on a row the janitor cannot see (its sweep is status='running'),
// listed by `hive status` as resumable, and resumable AGAIN onto a second pane
// of the same session.
//
// WHY THE FIX IS IN recordPane AND NOT IN agent_park. launchAgent has the
// identical INSERT-to-recordPane gap (an agent_close landing in it), so a guard
// written into the park path would have left that twin live while reading as a
// fix. The invariant belongs to recordPane because it is true whoever retired
// the row and for whatever reason.
//
// THIS TEST DRIVES resumeAgent DIRECTLY rather than through MCP, and patches
// db.prepare to land the retirement in the exact gap - the method
// test/resume-actor-upsert-failure.test.mjs and test/spawn-cwd-scope.test.mjs's
// "finding 5" already use for this file's other late failures. The MCP server
// runs in its own process, so a test-side db.prepare patch would never be seen
// there.
//
// IT ASSERTS THE ROW *AND* THE PANE. Asserting only "resumeAgent throws" would
// pass against BOTH versions of the code, since the pre-fix version throws
// nothing and the post-fix one throws for the right reason - and the whole
// point is what is left behind, not what was raised.
```

## line 70

```
// recordPane's own UPDATE. The literal has to track src/spawn.ts or
// this patch silently stops matching and resumeAgent just succeeds -
// which is why the assertions below are on the row and the pane rather
// than on the throw: a patch that never fired would otherwise look
// like a passing test.
```

## line 79

```
// args[3] is agentId; the pane this resume just built is args[0].
```

## line 81

```
// THE CONCURRENT PARK, landed in the exact gap: the row is
// retired between placeAgentPane and this write. Written the way
// parkAgentRow writes it, so the row shape is the real one.
```

## line 117

```
// THE ROW. It must still read exactly as the park left it. Before the
// fix, recordPane's unconditional UPDATE wrote the live pane onto this
// closed row, so tmux_target named a running process on a row nothing
// sweeps.
```

## line 132

```
// THE PANE. The row's view - a parked lane with nothing running - has to
// be TRUE, not merely recorded. A pane left alive here is a `claude
// --resume` process belonging to no row, which is the half that leaks.
```
