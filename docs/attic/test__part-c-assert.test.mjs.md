# Attic: test/part-c-assert.test.mjs

Comments removed from `test/part-c-assert.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 21

```
// SQLite's own shape with no fractional seconds (datetime('now')'s shape,
// which is what agent_state_log's MIN(created_at) reads back as through this
// column): 'YYYY-MM-DD HH:MM:SS', UTC, no zone suffix.
```

## line 26

```
// No isolateTmux() here on purpose: these assertions are pure functions over
// plain data (part-c-gate.mjs's own collected `result` shape), reachable
// from neither tmux nor a real MCP server, which is the whole point of
// factoring them out of the real-worker gate -- see that file's own header.
```

## line 31

```
// A genuinely correct run's shape, trimmed to what the assertions read.
// Timestamps are real SQLite output shapes: agent_state_log's created_at
// carries fractional seconds (strftime %f), timers.fired_at does not
// (datetime('now')); both are UTC with no zone suffix. epochSeconds values
// are the ACTUAL Unix epoch for the matching UTC wall-clock time below, not
// small arbitrary numbers -- an earlier draft of this fixture used epoch
// values like 100/106/110 alongside "2026-01-01" timestamps, which are
// billions of seconds apart, so every comparison in this file was vacuously
// true regardless of which branch it was meant to exercise. That is
// precisely the "assertion that cannot fail" shape test/CLAUDE.md warns
// about, just one level up: a fixture whose own numbers cannot disagree
// proves nothing about the code reading them, however it turns out.
//   2026-01-01 00:01:30 UTC = 1767225690  (file 1 completes)
//   2026-01-01 00:01:40 UTC = 1767225700  (file 2 completes)
//   2026-01-01 00:01:50 UTC = 1767225710  (file 3 completes -- LAST)
//   2026-01-01 00:01:55 UTC = idle recorded (good case: after last completion)
//   2026-01-01 00:01:56 UTC = wake fires (good case: after last completion,
//                             1s after the triggering idle row, and well
//                             before max_wait_at)
//   2026-01-01 00:06:00 UTC = max_wait_at (the wake's own timeout, far later
//                             than the genuine fire above -- see
//                             assertWakeFiredByIdleNotMaxWaitTimeout)
```

## line 55

```
// A normal, non-dialog claude screen: carries INPUT_BOX_PRESENT's own marker
// ("for shortcuts") and none of CHOICE_DIALOG's ("Esc to cancel"), same shape
// as this repo's own test/fixtures/panes/ready-idle.txt and
// busy-mid-turn.txt.
```

## line 60

```
// A genuine choice dialog: CHOICE_DIALOG's marker present, INPUT_BOX_PRESENT's
// absent -- same shape as folder-trust-dialog.txt / model-picker-dialog.txt.
```

## line 78

```
// The positive control assertSubagentActuallyObserved looks for: a
// `stop` row before the last completion (epoch 1767225710) whose
// payload names a live subagent, i.e. hive's actual subject -- a
// worker genuinely waiting on background work -- was exercised.
```

## line 90

```
// Real-clock-relative on purpose, unlike every other timestamp in this
// fixture: assertRetentionCouldNotHaveEvicted defaults to the real
// Date.now() in production, and runAllAssertions calls it that way, so a
// fixed "2026-01-01" here would fail this one check more each month
// real time passes, for a reason that has nothing to do with the code
// under test. See the dedicated describe block below for deterministic,
// injected-`nowMs` coverage of this assertion's actual branches.
```

## line 98

```
// The scratch store is fresh per `up`, so the boundary captured before
// this run's worker ever touched it is always empty -- see
// assertRetentionCouldNotHaveEvicted's own header on what that proves.
```

## line 150

```
// Last completion is epoch 110 (2026-01-01T00:01:50Z); this idle row
// lands at :01:45, five seconds before the third subagent finished.
```

## line 180

```
// Last completion is epoch 110 (:01:50Z); fire it two seconds early.
```

## line 191

```
// Todo 141 item 10: without an explicit Number.isFinite guard in
// parseUtcSeconds, a malformed timestamp parses to NaN, and every
// comparison against NaN is false -- an assertion built to catch a real
// regression would instead read "not violated" and silently PASS.
```

## line 226

```
// The exact false-green this closes: a max-wait fire lands well after the
// last completion (so assertWakeFiredAfterLastCompletion alone passes) but
// at or after its own max_wait_at, with no idle transition ever having
// caused it.
```

## line 244

```
// Idle row is at :01:55; fire it 60s later, before max_wait_at but far
// outside the 30s prompt window -- coincidental, not idle-triggered.
```

## line 250

```
// The real bug this closes, reproduced exactly: fired_at is whole-second
// (datetime('now')), agent_state_log.created_at is millisecond
// (strftime %f). A wake firing in the SAME wall second as its own
// triggering idle row -- the best possible outcome -- must PASS, not read
// as firing before the idle row that triggered it just because the idle
// row happened to carry a later fractional part within that same second.
```

## line 261

```
// Same whole second as the idle row above (:55), but its raw millisecond
// value (:55.000) is earlier than the idle row's (:55.700) -- exactly
// the truncation-artifact negative the floor exists to admit.
```

## line 269

```
// The negative control: this must still FAIL, or the fix above is just
// the check deleted wearing a floor's clothes. A full second (not a
// fraction of one) before the triggering idle row is a real ordering
// violation no amount of resolution-matching should admit.
```

## line 300

```
// The false green this closes, found independently by both counselor
// seats: a worker that never calls the Agent tool at all -- e.g. batching
// the three sleep-and-write tasks into its own foreground Bash turn --
// writes the same three completion files and a single late Stop|idle row.
// Every other assertion in this file passes on that run.
```

## line 317

```
// Moved from :01:00 (before last completion) to :01:52 (after it).
```

## line 371

```
// Sample index 2 is still pre-completion in goodResult(); set firedAt there.
```

## line 388

```
// The residual named on the triage pad: agent_output failing becomes
// paneTail: null silently, and nothing used to notice a run losing most of
// its pane evidence.
```

## line 422

```
// The scenario named on the triage pad: deliverable()'s HOLD breaks and a
// wake types into a choice dialog instead of waiting for it to clear.
```

## line 446

```
// The false green this closes: spawnReceipt.announced === true is equally
// true whether the RIGHT server answered or a different one did (e.g. the
// machine's user-scoped installed build loading alongside this branch's).
```

## line 489

```
// The blind spot this closes (todo 141 item 9): dist/ and .claude/ are
// both gitignored, so a worker overwriting dist/hook.js leaves HEAD and
// git status --porcelain byte-identical while the actual code under test
// was rewritten out from under the run.
```

## line 501

```
// nowMs is injected everywhere here, pinned relative to this block's own
// fixture timestamps -- see goodResult()'s comment on why the real clock
// and a fixed historical fixture must never be compared directly.
```

## line 534

```
// 7 days before NOW_MS
```

## line 540

```
// Todo 141 item 8: the false green this closes. The bounds check above
// only ever reads the POST-run span, which cannot tell "bounds were never
// close" apart from "a prune already ran and erased its own evidence" -- a
// delete shrinks the span it would otherwise be caught by.
```

## line 580

```
// The #55 method correction this file's header cites: a runner that stops
// at the first throw can leave a LATER assertion completely dead while an
// EARLIER one fails, and "the file went red" cannot tell the two apart.
// This pins that runAllAssertions names each failure individually instead.
```

## line 586

```
// Break "no idle while live" (todo 24's shape)...
```

## line 591

```
// ...AND independently break "working tree unchanged", so a runner that
// stopped at the first failure would never learn about the second.
```

## line 601

```
// The two untouched assertions must still report their own real result,
// not be swallowed by the two failures above.
```

## line 608

```
// Todo 392 round 1, F4. This file's own header (scripts/part-c-assert.mjs,
// above CHOICE_DIALOG) says "keep in sync by hand" - this is the mechanical
// half of that instruction, the same shape scripts/restart-lead.sh's own
// sync test (test/restart-lead.test.mjs) already has. Both copies are JS
// regex literals, unlike restart-lead.sh's bash ERE strings, so this can
// compare them as TEXT directly rather than needing the behavioural
// cross-dialect comparison that file's view-session test does.
```

## line 616

```
// WHAT THIS TEST USED TO BE, AND WHY IT WAS REPLACED RATHER THAN REPAIRED.
// It extracted `CHOICE_DIALOG` and `INPUT_BOX_PRESENT` from both files as
// regex SOURCE TEXT and asserted the strings matched. That pins a copy; it
// does not remove one, and it only works while both copies are regex
// literals. Todo 399 replaced the input-box half with a structural anchor,
// the extraction returned undefined, and this test went red - correctly,
// but the copy underneath had been carrying todo 392's bug through that
// lane's own acceptance run before anyone noticed. Two lanes bitten by one
// structure is a reason to delete the structure.
//
// So the copy is gone and this asserts the ABSENCE of a new one. Comments
// are stripped first: this file's own prose says "INPUT_BOX_PRESENT" while
// explaining the history, and a test that cannot tell an explanation from a
// declaration would forbid documenting the decision it exists to enforce.
```
