# Attic: test/wake-get-update.test.mjs

Comments removed from `test/wake-get-update.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 7

```
// Issue #96. wake_get is a read-by-id (untruncated body, any state, still
// project-scoped like wake_list); wake_update reschedules or edits a pending
// wake WITHOUT minting a new id (owner-scoped like wake_cancel, pending-only
// via the same ACTIVE_TIMER_WHERE predicate pendingWakes() applies). Neither
// tool ever types into a pane - both are pure timers-row reads/writes - so
// most of this file needs no live tmux target at all. A handful of tests are
// the exception, individually marked with their own skip rather than the
// whole file: each needs a real pane so deliverable() lets a claim through,
// either driving the REAL running MCP server's own background scheduler (not
// a hand-called tick()), or calling tick() directly to prove wake_update
// landing WHILE a tick is already mid-flight cannot make a stale in-flight
// claim deliver old data - the CI review finding on PR #101, and the
// counselors round on that same fix that found due_at alone was not a
// sufficient guard. See claimOneShot's own comment in src/scheduler.ts for
// the full mechanism these race tests pin.
```

## line 52

```
// deliver_actor/deliver_pane are throwaway strings for every test but the
// last: neither wake_get nor wake_update ever reads them to deliver
// anything, so a pane no tmux server has ever issued is deliberate, not an
// oversight - it would make a test that accidentally exercised delivery fail
// loudly instead of quietly passing.
```

## line 68

```
// due_at only for a 'delay' wake, matching what wake_when_idle's own
// INSERT does for idle_any/idle_all - never setting due_at at all, since
// maybeFireIdle never reads it.
```

## line 139

```
// Seeded an hour out, so "relative to the original due_at" and "relative
// to now" predict very different results if this were ever confused.
```

## line 255

```
// Shared by every mid-tick race test below. A: any due 'delay' wake on the
// same live pane. Its real delivery (a genuine sendText, with tmux.ts's
// real 300ms ENTER_DELAY_MS sleep before pressing Enter) is what gives
// tick() its first true await point - everything before that (janitor,
// the candidates SELECT, A's own deliverable()+claim, sendText's
// synchronous tmux calls) runs in one synchronous stretch. B, already
// read into this SAME tick's in-memory candidates array, has not been
// touched yet when that await point is reached, so a wake_update call
// landing there lands in exactly the window claimOneShot's full-state
// guard has to defend.
//
// A is guaranteed to be read and claimed before B, not just usually:
// tick()'s candidates query has no ORDER BY, but EXPLAIN QUERY PLAN shows
// it scans idx_timers_active(project_id, kind) WHERE cancelled_at IS NULL
// - a non-unique index, so SQLite ties break on rowid. A and B share this
// test's project_id and kind ('delay'), so A (inserted first, lower id)
// sorts before B deterministically.
```

## line 291

```
// Not awaited yet: everything up through A's sendText call happens
// synchronously inside this expression, before this line returns.
```

## line 295

```
// The REAL wake_update tool, landing in exactly the window the CI
// reviewer flagged: after B was already read as a candidate, before
// its own claim. A local stdio round-trip to the MCP server is
// microseconds to low milliseconds - comfortably inside A's real
// 300ms sendText sleep, so this is deterministic, not a timing hope.
```

## line 332

```
// due_at is deliberately untouched here - this is the exact case the
// due_at-only guard missed: nothing about due_at changed, so a guard
// scoped to due_at alone would still match and let the stale claim
// through, delivering "OLD body" instead of refusing.
```

## line 360

```
// B starts a plain one-shot (repeatEveryMs default null) - this is the
// specific shape P1 named worse than the body case: fireDelay's own
// branch decision (timer.repeat_every_ms != null) is read from this
// SAME stale in-memory row, BEFORE either claim runs, so an unguarded
// fix could take the ONE-SHOT branch on stale data even after the row
// became repeating underneath it.
```

## line 369

```
// repeat_every_seconds only, matching the pad's own "independent
// fields" design - due_at is deliberately left alone, exactly the
// update wake_update actually recommends for "start repeating this".
```

## line 389

```
// The row is now genuinely, correctly repeating and still due. A
// second, ordinary tick() - reading it fresh this time, no race - must
// take the REPEATING branch and fire it exactly once, proving the
// "fires a second time immediately" failure mode P1 described is
// actually closed, not just deferred.
```

## line 427

```
// The claim UPDATE in fireDelay() sets the NEXT due_at from
// repeat_every_ms read off the row at claim time - so once the real
// background scheduler (unmodified 3s tick) claims this cycle, the
// resulting due_at must reflect the UPDATED 1s interval, not the
// original 5s one.
```

## line 449

```
// Issue #150. deliver() (src/scheduler.ts) types a wake's body verbatim into
// a pane via sendText, exactly as agent_send's text path does, so an
// unvalidated body is the identical text-becomes-keys breach one door over
// (.claude/rules/tmux-and-panes.md). No live pane needed here: the check
// runs before resolveDelivery and before the INSERT/UPDATE, so these tests
// never touch tmux.
```

## line 464

```
// This test session runs outside tmux, so wake_set still fails - but only
// at delivery-target resolution, which runs AFTER body validation. That
// proves a clean multi-line, tabbed body passed the control-byte check
// rather than a passing assertion of convenience: a regression that
// started rejecting tab or newline would fail here with a body-shaped
// message instead of this one.
```
