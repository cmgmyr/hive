# Attic: test/spawn-false-finish.test.mjs

Comments removed from `test/spawn-false-finish.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 22

```
// TODO 387, OPTION (e). agent_spawn used to type a short `[hive]` line into a
// brand-new worker's pane and SUBMIT it (todo 373), creating a real turn hive
// asked for itself. Todo 384 found the actual cost of that turn: if a lead's
// real assignment landed while it was still running, it could be absorbed
// into it as an attachment with no `UserPromptSubmit` to clear the
// suppression, and since the ordinary dispatch shape is brief once and wait
// for the finish, that suppression was OPERATIONALLY PERMANENT for the worker
// it hit - not the "bounded, not permanent" residual todo 373 recorded.
//
// THIS FILE USED TO PIN THE SUPPRESS-THEN-CLEAR MECHANISM (todo 373) AND NOW
// PINS ITS REPLACEMENT: a spawned worker has NO TURN AT ALL until briefed.
// Nothing is typed into its pane, so there is no announcement, no latch to
// stamp, and no window for a real assignment to be absorbed into. The defect
// this file used to reproduce cannot recur structurally, because the turn it
// depended on no longer exists.
//
// EVERYTHING HERE IS REAL where it can be: a real agent_spawn, and for the
// regression case below, real Claude Code payloads (captured off the live
// store) driven through the BUILT dist/hook.js. Nothing hand-writes
// agent_state - .claude/rules/worker-state.md's "enumerate every path that
// can write the value" exists because two full lanes of #24 reasoned from an
// observed value to a presumed writer and neither checked.
```

## line 56

```
// This fixture used to be recognised specially as hive's OWN announcement
// text (isSpawnAnnouncement). It carries no special meaning anymore - reused
// below only as a stand-in for "some real prompt text", to prove the point
// that nothing about ITS CONTENT matters now, only whether hive typed it.
```

## line 69

```
// agent_spawn still waits for the pane before returning (fix round 1,
// finding 1: the wait outlives the announcement it was added for). The
// plain fakeClaude() shell below never renders anything recognisable as
// ready, so without a short ceiling every spawn in this file would burn
// the full default wait for no reason - none of these cases are about
// readiness, only about whether anything gets typed.
```

## line 78

```
// A lead whose pane is deliberately in no snapshot below, so a filed notice
// is HELD rather than typed at a real terminal.
```

## line 122

```
// The receipt's own shape: `ready` still reports whether the pane took
// the terminal (fix round 1, finding 1 restored the wait behind it), but
// nothing about its value gates any typing anymore - false here (the
// 1ms ceiling above times out against a fakeClaude that renders nothing)
// proves that on its own, not "ready and therefore untyped".
```

## line 139

```
// THE MINIMUM WAVE SHAPE (mirrors the old file's own case): spawn the
// crew, give one its real assignment, leave the other untouched.
```

## line 152

```
// agent_state defaults to 'unknown', which already satisfies the roster's
// own `agent_state != 'idle'` filter - so an unbriefed worker under (e)
// was never the silent-crew hazard todo 366/384 found for the old spawn
// shape (where the announcement's own Stop latched a false 'idle'). It is
// simply a worker whose state channel has nothing to say yet, and the
// roster says so rather than denying it exists.
```

## line 188

```
// A bash worker is kind='agent' (agent_spawn's own allowlist) but fires
// no hooks at all - reportsAgentStateLog is false for it, same gate
// reportUnbriefedWorkers already uses. Its state_changed_at is NULL
// forever, exactly like a genuinely untouched claude worker's - the only
// thing that tells them apart is whether hive can see this row's state
// at all, and "never given an assignment, so nothing was in flight" is a
// claim hive has no standing to make about a row it cannot observe.
```

## line 200

```
// Anchored to THIS worker's own line, not the whole body - sf-death-
// unbriefed (the previous case) is a real claude worker in the SAME
// notice and correctly DOES carry "never given an assignment" on its
// own line, so a blanket doesNotMatch on the full body would fail for
// the wrong reason. See resume-false-finish.test.mjs's matching case for
// the same note.
```

## line 232

```
// THE FAILING TEST, RED AGAINST THE BUILD BEFORE THIS COMMIT. Before todo
// 387, launchAgent's INSERT stamped resumed_at at spawn and src/hook.ts
// excepted hive's own announcement prompt from clearing it
// (isSpawnAnnouncement). Replaying that exact sequence - a prompt event
// carrying hive's former announcement text, then a stop - reproduced todo
// 384's defect: the latch stayed set through it (the announcement's own
// prompt did not count as "given something"), so the worker's real work
// inside that same absorbed turn was suppressed, permanently, because the
// ordinary dispatch shape never sends a second message to clear it.
//
// AFTER TODO 387, THE SAME SEQUENCE PROVES THE OPPOSITE, AND FOR THE RIGHT
// REASON: launchAgent no longer stamps resumed_at at all, and hook.ts no
// longer excepts any particular prompt text - every prompt a spawned worker
// gets is a real one. So this fixture's text carries no special meaning
// anymore; replaying it is simply replaying "some prompt, then a stop", and
// the standing watch must report the finish because there is nothing left
// to suppress it.
```
