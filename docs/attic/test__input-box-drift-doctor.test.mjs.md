# Attic: test/input-box-drift-doctor.test.mjs

Comments removed from `test/input-box-drift-doctor.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 19

```
// Todo 319. Nothing told you inputBoxState()'s chrome-matching had drifted,
// and every guard resting on it (the scheduler's wake hold, agent_send's text
// refusal, agent_rename's refusal) fails SILENTLY when it does: none of the
// three carry an input_box field on the paths that clobber (a successful
// send with no wait_ms, a delivered wake, agent_rename's own receipt).
// test/input-box.test.mjs cannot catch this either, by construction - it
// replays FROZEN captures taken at one Claude Code version, so a real chrome
// change can never turn that suite red. This file pins the channel todo 319
// built instead: `hive doctor` reading a running claude worker's real pane
// and naming any box that classifies "unknown".
```

## line 33

```
// createLiveAndDialogPanes creates the session and replays one fixture into
// a pane; reused here for drifted-prompt-glyph.txt (test/input-box.test.mjs's
// own fixture for "INPUT_BOX_PRESENT matches, findInputBoxRow does not" -
// verified there to classify {state: "unknown", text: ""}) rather than
// hand-rolling the identical new-session/new-window shape a second time. The
// other two panes (ready-idle.txt, a genuinely healthy box; folder-trust-
// dialog.txt, verified in test/input-box.test.mjs to make inputBoxState
// return null - INPUT_BOX_PRESENT is absent from it entirely, standing in for
// the TOTAL-drift shape counselors found this check was blind to) are one
// more manual replay each on top, the same pattern
// test/state-provenance-cli.test.mjs's busyPane/longPane already use for a
// third and fourth pane beyond that helper's own two.
//
// Counselors F5 (opus), confirmed real: the panes must be RENDERED before any
// test reads them, or a not-yet-rendered blank pane reads `null` for a reason
// that has nothing to do with the fixture and the healthy-box control passes
// without ever proving what it claims. test/input-box.test.mjs's own B4 note
// and test/pane-fixtures.test.mjs both wait on the fixture's marker text
// before asserting; this file skipped that wait entirely until now.
```

## line 119

```
// Todo 399. The lead row this check was blind to until this lane. `kind`
// and `command` are the two columns the new probe branches on, so both are
// parameters here rather than baked in: `reportsAgentStateLog` (which gates
// the per-worker loop) requires kind='agent', so a lead can never reach that
// loop and the probe had to be its own read.
```

## line 150

```
// Lead review on commit 1f323cf, then counselors on the same PR: the
// per-worker warn used to claim "for every pane on this machine" from
// ONE worker's observation, then (after the first fix) still named a
// CAUSE it could not know ("not a busy or unreadable pane") - a boxed
// tool output above a real dialog can produce 'unknown' with no chrome
// change at all (INPUT_BOX_PRESENT is unanchored over 18 rows). The
// per-worker line states only the observation now; every claim beyond
// it belongs to the ratio.
```

## line 163

```
// With exactly one worker probed and one drifted, the ratio IS 100%,
// so the all-unknown reading is earned here - this is the other half
// of the same fix, not just the removal. "in this project", never
// "machine-wide" (counselors: `workers` is `WHERE project_id = ?`).
```

## line 175

```
// The case the headline test's own ratio line cannot distinguish: with
// only one worker probed, "1 of 1 unknown" and "unknown project-wide"
// are the same fact. Here two are probed and only one drifts, so the
// two readings diverge and only the pane-specific wording is honest.
```

## line 212

```
// TODO 399. The exclusion this check shipped with, closed. The loop
// above is `kind = 'agent'`, so the LEAD's pane was never probed - and
// the lead's pane is the only pane a human types into, which makes it
// the only pane where this detector failing destroys a person's
// half-written message rather than a wake. That is not hypothetical:
// todo 389 is the incident, and todo 399 is its mechanism.
//
// RED-FIRST against the version without the lead probe: the warn does
// not appear and the count reads 1 (the worker alone), not 2.
```

## line 233

```
// The warn says WHY this pane is the one that matters, which the
// per-worker wording deliberately does not.
```

## line 247

```
// TODO 399, PR GATE ON THE REBASED HEAD - AND THE REASON IT SURVIVED
// REVIEW IS THE PART WORTH KEEPING. Every seeded case in this file that
// calls leadRow() also calls agentRow(), so the LEAD-ONLY project was not
// exercised anywhere: a fixture corpus structurally unable to see a case,
// the same class as the 220-column blindness this lane found in
// test/fixtures/panes/, in a different dimension. Two instances in one
// lane.
//
// The summary line used to phrase itself off the LEAD counter alone, so a
// project with a running claude lead and no countable worker - no agent
// rows yet, or every worker row foreign-socket or non-claude - printed
// "workers plus the lead's own pane" having probed no worker at all. A
// report claiming a measurement it did not take, in the surface this lane
// exists to make trustworthy.
//
// RED against phrasing off `leadsProbed` alone.
```

## line 281

```
// The same gap from the other side: a lead that exists but is NOT
// countable (foreign socket here; non-claude is covered separately above)
// alongside a real worker must still say "workers only". This is the
// direction counselors already fixed, kept as the control that stops a
// future edit collapsing the three cases back into two.
```

## line 300

```
// TODO 399, COUNSELORS ROUND 1 (two seats independently). The first
// version used `.get()` with `ORDER BY id`, so with two running lead rows
// only the LOWEST id was probed. That state is reachable - ensureLeadRow's
// own comment in src/cli.ts documents it - and lead rows are exempt from
// the janitor, so a dead-but-`running` first row shadows the live lead
// FOREVER: a standing "not classified" in the denominator and the one
// pane a human types into never probed. Seeded here the way the defect
// actually arrives: an older foreign-socket lead at the lower id, the
// live drifted one above it.
//
// RED against `.get()`: the warn never appears, and the count reads 1
// (the foreign row is skipped) with the "no lead pane was probeable"
// wording rather than 2.
```

## line 333

```
// The gate, and it is the same one every typing path here carries:
// inputBoxState finds its box by claude's own chrome, so probing a lead
// running something else would count a permanent, meaningless "not
// classified" against the ratio the project-scoped warn rests on.
```

## line 352

```
// Counselors, both seats independently, the top finding on this lane's
// own PR: `inputBoxState` returns null for a pane with no box on screen
// to classify AT ALL - a dialog, mid-turn, an unreadable pane, or (the
// dangerous case) a TOTAL chrome drift where INPUT_BOX_PRESENT itself
// stops matching. The first version counted that null in the same
// "checked" number a real clean read incremented, so it silently
// laundered into "classified cleanly". folder-trust-dialog.txt stands in
// for the shape (a real, verified null read - test/input-box.test.mjs
// pins `expect: null` for this exact fixture); it is a dialog, not a
// chrome rewrite, but it exercises the identical code path a total drift
// would take, which is what this line of code cannot tell apart.
```

## line 411

```
// A developer machine can carry its own gating warns unrelated to this
// check (e.g. a dispatcher pinned to a different build than the test
// runner's own interpreter), so comparing strict vs. plain in one run,
// or asserting a bare exit code, saturates on those instead of proving
// anything about THIS warn. Compare against a baseline taken on the
// SAME machine with no drifted row present, the pattern
// test/state-provenance-cli.test.mjs's own F4 test already uses for the
// identical shape.
```
