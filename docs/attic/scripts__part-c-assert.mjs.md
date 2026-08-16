# Attic: scripts/part-c-assert.mjs

Comments removed from `scripts/part-c-assert.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 1

```
// Issue #31 part C step 4: the assertions over the rows part-c-gate.mjs
// collects. Pure functions, deliberately -- no tmux, no MCP client, no real
// worker -- so they can be pinned by fast synthetic-fixture unit tests
// (test/part-c-assert.test.mjs) instead of costing tokens on every change.
//
// THE RULE EVERY ASSERTION HERE FOLLOWS, and the reason it exists: part-c-
// gate.mjs's own first real run went green while structurally unable to see
// what it claimed to check -- the poll loop returned before the wake's
// scheduler tick had fired, so fired_at was null, and a bare `fired_at >
// lastCompletion` comparison against null is neither true nor an exception
// in JS, it is just quietly falsy, which is indistinguishable from "checked
// and found fine". So every assertion below asserts the PRESENCE of what it
// is about to compare -- fired_at is not null, there are exactly 3 completed
// files, agent_state_log is non-empty for this actor -- and throws a
// "PROVES NOTHING" error naming exactly what was missing, distinct from a
// "FAILS" error naming what was wrong, before it ever reaches the
// comparison. A caller that only reads the thrown message at 2am should not
// need the distinction explained twice.
//
// runAllAssertions() below evaluates every assertion independently, in its
// own try/catch, rather than stopping at the first throw: issue #55's own
// method correction (a mutation check that watches the FILE's pass/fail can
// have a later assertion be completely dead while an earlier one still
// fails, and short-circuiting is exactly why) applies here just as much as
// it does to the suite this pattern was first written for.
```

## line 27

```
// /simplify's own review flagged this as re-deriving src/stateProvenance.ts's
// parseStoreTimestamp (same transform, that one returns milliseconds). Left
// duplicated rather than imported: parseStoreTimestamp is not exported, and
// this lane does not touch src/ for a two-line pure function. Same shape as
// LOG_MAX_ROWS/LOG_RETENTION_DAYS below -- keep in sync by hand; grep
// `parseStoreTimestamp` in src/stateProvenance.ts to check for drift.
```

## line 34

```
// Every timestamp read out of the scratch store here is UTC with a space
// separator and no zone suffix (datetime('now') and strftime(...'now') are
// both UTC-by-default in SQLite); Date.parse needs the 'T' and 'Z' to not
// silently reinterpret it in the calling process's own local zone.
```

## line 39

```
// Todo 141 item 10. Without this, a malformed non-null timestamp parses to
// NaN, every `<=`/`>=`/`<`/`>` comparison against it is false, and an
// assertion built to catch a real regression instead reads that as "not
// violated" and PASSES on data it never actually understood.
```

## line 49

```
// /simplify: the "are all 3 tracked" half of this was written a second time
// in assertWakeHeldThroughoutSubagentWindow's own isFullyDone filter. Shared
// here so the two cannot drift on what "done" means.
```

## line 67

```
// Proves: no `idle` row exists in this actor's agent_state_log with a
// created_at at or before the last of the 3 subagents' completion -- i.e.
// hive never reported the worker idle while a subagent was still live. This
// is issue #24's own defect and the reason this gate exists at all.
```

## line 85

```
// log is ordered by id (see part-c-gate.mjs's own SELECT ... ORDER BY id),
// which is insertion order, so the first idle row is the earliest chronologically.
```

## line 98

```
// Proves: timers.fired_at, once set, is after the last of the 3 subagents'
// completion timestamps -- the wake did not fire before the work it was
// meant to wait for had actually finished.
```

## line 106

```
// Named per todo 141 item 2: a cancelled timer (the janitor found the
// delivery pane gone) previously fell into the same "never fired" message
// as a timer that simply had not fired yet -- the wrong cause, in a
// report whose whole point is naming the exact failure.
```

## line 130

```
// Proves: across every sample taken WHILE at least one subagent was still
// live, fired_at read back null -- a continuous, sampled "held" window
// rather than one before/after look, which the plan's own constraint 4
// names as unable to tell "held correctly" apart from "fired, and nothing
// was watching".
```

## line 161

```
// Todo 141 item 2. FALSE GREEN this closes: WAKE_MAX_WAIT_SECONDS (280s) is
// comfortably longer than a correct run (~30-40s), so a scheduler regression
// that stops firing on genuine idle transitions still produces a fired_at
// well after the last completion -- assertWakeFiredAfterLastCompletion alone
// cannot tell that apart from a real idle fire, because both are "after the
// last completion". Two extra facts do distinguish them: maybeFireIdle's own
// contract only sets fired_at at-or-after max_wait_at on the timeout path, so
// fired_at strictly before it rules out a max-wait fire; and a genuine idle
// fire lands close in time to the idle row that triggered it, not merely
// somewhere in an up-to-280-second window.
```

## line 210

```
// scheduler ticks every 3s in production; generous margin for a slow tick.
// timers.fired_at is written by `datetime('now')` (src/scheduler.ts) --
// WHOLE-SECOND resolution. agent_state_log.created_at is written by
// `strftime('%Y-%m-%d %H:%M:%f', 'now')` (src/db.ts) -- MILLISECOND
// resolution. Different precision ON PURPOSE for each column's own
// reasons; nobody should "fix" that by touching the schema (no MIGRATIONS
// entry belongs here) -- this is a COMPARISON bug, not a storage one.
// Comparing the two at full precision made a wake that fires in the SAME
// WALL SECOND as its triggering idle row -- the best possible outcome --
// read as up to 0.999s "before" its own trigger, a false FAILS for hive
// being fast rather than slow. Flooring the idle epoch to whole seconds
// before subtracting compares both sides at the coarser of the two
// resolutions, which is the real information content available here.
// This does not weaken the check: a fire a full second or more before the
// FLOORED idle second is still a genuine ordering violation and still
// fails below, since flooring only ever moves idleEpoch DOWN (toward
// firedEpoch), never up past it.
```

## line 249

```
// Mirrors src/hook.ts's TERMINAL_STATUSES, not imported: this lane does not
// touch src/hook.ts, and importing it into a read-only assertion script for
// one constant would blur that line for no real gain. Keep in sync by hand;
// `grep -n TERMINAL_STATUSES src/hook.ts` to check for drift.
```

## line 266

```
// Todo 141 item 3. FALSE GREEN this closes, found independently by both
// counselor seats: every other assertion here can pass on a run where no
// subagent ever actually ran. A worker that decides three `sleep && date`
// calls do not warrant the Agent tool -- or batches them into its own
// foreground Bash call -- writes the same three completion files and a
// single, late Stop|idle row; waitingOnSubagents() is never exercised, and
// nothing above would have noticed. This is the positive control: at least
// one `stop` row, timestamped before the last completion, must carry a
// background_tasks payload naming a real, in-flight subagent.
```

## line 303

```
// Todo 141 item 4, both counselor seats independently. The worker's own
// --strict-mcp-config wiring (todo 128/129) is set up and never verified:
// spawnReceipt.announced === true is equally true whether the worker loaded
// the right hive-iso server, the machine's user-scoped installed build
// alongside it, or nothing at all -- nothing in the run used to DEPEND on
// that server existing, connecting, or pointing at THIS branch's dist.
// Claude Code namespaces MCP tools by server key, so under
// --strict-mcp-config the worker can only see mcp__hive-iso__*; the
// assignment's step 0 (part-c-gate.mjs's workerAssignment) has it call a
// hive tool and write the EXACT tool name it invoked, so a run where a
// second registration also loaded (a different prefix) is caught rather than
// silently credited.
```

## line 332

```
// TODO 399: THIS USED TO BE A HAND-SYNCED COPY OF src/tmux.ts's CHOICE_DIALOG,
// INPUT_BOX_PRESENT and D5 discriminator, kept honest by a sync test that
// compared the two regexes' SOURCE TEXT. That worked only while the predicate
// WAS a regex literal. Todo 399 replaced it with a structural anchor over the
// box's own borders, the extraction returned undefined, and the sync test went
// red - which is the good outcome; the bad one is what the copy was doing in
// the meantime. Todo 392 had already found this exact copy carrying the bug
// that lane fixed, right through its own acceptance run, because this file is
// the STEP 11 LIVE DRIVER (part-c-gate.mjs runs it against a real worker).
// Twice is a structure, not an accident.
//
// So it is imported now. `screenAwaitingChoice` is the string-taking form of
// the same function src/tmux.ts's own paneAwaitingChoice calls; see its
// comment there for why the pair (footer present AND input box absent), and
// why the box half is anchored rather than matched. This file reads its tail
// through the real agent_output MCP tool, which has already applied
// src/tmux.ts's own capturePane trimming, so there is no window to match here
// and never was - unlike scripts/restart-lead.sh's copy, which had one.
//
// From THIS checkout's dist/, deliberately, not from whatever `hive` resolves
// to on PATH: the checkout that ships this script is the one whose
// classification is being asserted. Same reasoning restart-lead.sh gives for
// its own dist/projectYml.js import.
```

## line 358

```
// Todo 141 item 5, second half: paneTail is sampled every 2 seconds
// (part-c-gate.mjs's pollUntilDone) and read by NOTHING -- agent_output
// failing becomes paneTail: null silently, and a run can lose the entire
// pane half of its evidence while staying green. This is the presence check
// the comparison assertion below depends on, split out so a caller can tell
// "too many failed reads to trust the window" apart from "the window
// genuinely never saw a dialog".
```

## line 384

```
// Todo 141 item 5, first half, and the plan's own constraint 4: "the dialog
// guard needs a sampled window, not one look." Couples dialog state with
// fired_at across every readable sample, not a single before/after check:
// deliverable() in src/scheduler.ts holds a wake above claimOneShot whenever
// the pane is awaiting a choice, so fired_at becoming non-null in the SAME
// sample the pane shows a dialog is exactly the shape of that guard failing.
// Scenario named on the triage pad: deliverable() breaks and a wake types
// into a choice dialog instead of holding -- this is the check built to
// catch it, where paneTail's own 2-second sampling previously went entirely
// unread.
```

## line 419

```
// Proves: git HEAD and `git status --porcelain` are byte-identical before
// the worker started and after it finished, AND (todo 141 item 9) dist/'s
// own content checksum is unchanged too. Named in isolated-hive.mjs's own
// header: siting the worker's project root inside this trusted checkout
// (todo 129) gives it a live path back to the working tree, so this is
// detection for that trade-off, not merely trust in the prompt's scope.
//
// dist/ is gitignored, so git HEAD and status alone are blind to it -- for a
// gate whose entire premise is "the branch's dist", a worker overwriting
// dist/hook.js would leave both of the checks above reporting "unchanged"
// while the actual code under test was rewritten out from under the run.
// part-c-gate.mjs's distChecksum() closes that the same way this assertion
// already closes the trusted-cwd trade-off: detection, not prevention.
```

## line 466

```
// Duplicated from src/scheduler.ts's pruneStateLog, not imported: this lane
// does not touch src/scheduler.ts, and importing the scheduler module into a
// read-only assertion script for two constants would blur that line for no
// real gain. If these drift from src/scheduler.ts's own LOG_MAX_ROWS /
// LOG_RETENTION, this assertion's whole point -- proving retention could not
// have evicted anything this run depends on -- drifts silently with them.
// Keep in sync by hand; `grep -n LOG_MAX_ROWS src/scheduler.ts` to check.
```

## line 476

```
// Proves: agent_state_log's GLOBAL id span (every actor, every project
// sharing this store -- pruneStateLog's own bound is global, not per-actor)
// and the age of its oldest row are both well inside the bounds that trigger
// pruneStateLog's two deletes, AND (todo 141 item 8) that no prune actually
// ran mid-run despite that.
//
// The bounds check alone is read only from the POST-run span, which cannot
// tell "retention's bounds were never close to triggering" apart from "a
// prune already ran and erased the evidence that it happened" -- a delete
// both removes rows and shrinks the span that would otherwise reveal it, so
// a post-run-only read can look exactly as healthy either way. Comparing
// against a boundary captured at gate START (part-c-gate.mjs's
// readGlobalSpan, called right after the scratch server connects, before the
// worker does anything) closes that: this scratch store is fresh per `up`,
// so its agent_state_log is provably empty at that point, and its first-ever
// row must therefore get id 1. A post-run MIN(id) other than 1 is direct
// evidence a prune deleted at least one row from this very run, not merely a
// risk that one theoretically could have.
//
// ACCEPTED IN NARROWED FORM (todo 141 triage; opus's own honest note, kept
// here so this is never read as live protection it is not): in a per-run
// mkdtemp store, neither half of this assertion can actually FAIL today. The
// global span is always double digits of rows and minutes old, nowhere near
// LOG_MAX_ROWS or the 7-day window, and the store is always genuinely fresh,
// so the pre-run boundary is always empty and the post-run MIN(id) is always
// 1. Its real value is guarding a FUTURE change that reuses a store across
// runs, where none of that would still be true by construction.
//
// nowMs is injectable (defaults to the real clock) so a unit test can pin
// "now" instead of racing this month's Date.now() against a fixture's fixed
// historical timestamps -- the same dependency-injection shape killSocket()
// and checkSocketPathLength() already use elsewhere in this project for the
// same reason: a real clock in a fixture is not a fixture.
```

## line 559

```
// Right after the idle check, not merely alongside it: this is the
// precondition that makes an empty or short agent_state_log above readable
// as "correct" rather than "evicted" -- see this function's own header.
```

## line 563

```
// The positive control (todo 141 item 3): everything below this line can
// pass on a run where no subagent ever actually existed. Placed early so a
// reader scanning top-to-bottom hits it before the timing checks it
// underwrites.
```

## line 577

```
// Every assertion runs regardless of whether an earlier one threw: see the
// header comment on why short-circuiting is the wrong shape for a report
// that needs to say WHICH check failed, not just that the run did.
```
