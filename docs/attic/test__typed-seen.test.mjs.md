# Attic: test/typed-seen.test.mjs

Comments removed from `test/typed-seen.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 19

```
// Todo 407, pad 142 PART 2. Before this column, a delivery that decided to
// TYPE wrote nothing about what it saw - held_reason covers a HOLD, and
// deliver() clears held_at/held_reason on the very write that records
// success, so a wake held for ten minutes and one that was never held read
// as byte-identical rows once delivered (todo 389's incident). typed_seen is
// deliverable()'s own four facts, in the order it computes them, encoded as
// a short fixed vocabulary and written into the UPDATE deliver() already
// runs - see src/scheduler.ts's DeliverableResult and src/db.ts's migration
// for the full argument.
//
// Set a real wake against a real pane and read wake_list/wake_get (the real
// MCP tools, through a real running server on its own natural scheduler
// tick) - the same method test/wake-delivery-state.test.mjs and
// test/wake-hold-unsubmitted-input.test.mjs use for the sibling columns this
// one sits beside.
```

## line 80

```
// MUTATION: revert deliver()'s UPDATE to drop `typed_seen = ?` (the
// pre-todo-407 shape). typed_seen stays NULL forever and this
// assert.match throws on null. Proven red against that revert before
// writing the fix; see todo 407's own comments for the run.
```

## line 105

```
// wake_get carries the same fact, untruncated - the receipt pad 142
// names as this column's whole reason to ride along verbatim.
```

## line 115

```
// Reuses test/wake-hold-unsubmitted-input.test.mjs's own scenario: a
// pane holding genuine unsubmitted text holds the wake, then delivers
// once the box clears. This exercises fireDelay's post-hold branch,
// the second of deliverable()'s three call sites, not only the
// first-tick path the test above covers.
```

## line 137

```
// Todo 409. While still held, first_held_at must already be recording
// the fact - read through wake_get, since wake_list deliberately does
// not carry it (see wake_get's own comment).
```

## line 159

```
// Todo 409's own acceptance criterion: a wake held at least once and
// then delivered must be distinguishable, AFTER delivery, from one
// delivered on its first tick. held_at/held_reason no longer carry
// that fact (deliver() clears them, unchanged); first_held_at must,
// via deliver()'s explicit re-write of the value it captured before
// this ONE-SHOT wake's claim (claimOneShot, which never touches
// first_held_at at all - see test/hold-visibility-repeat-hold.test.mjs
// for the REPEATING case, where the claim does touch it and the
// ordering is what makes this survive).
```

## line 179

```
// THE FIFTH BOX VALUE IS THE WHOLE POINT (pad 142), AND IT HAS THREE
// CAUSES (see deliverable()'s own box comment, src/scheduler.ts). This
// test exercises ONE of the three: a pane with no recognisable claude
// chrome at all - here, a fake claude binary that just echoes plain
// text, the same shape tmux-and-panes.md calls "THIS PROTECTION IS
// CLAUDE-CHROME-SHAPED" - not a drifted claude pane and not a failed
// read. A reader seeing box=absent on a real delivery cannot tell
// which of the three it is without first checking whether the pane
// even runs claude; this fixture is deliberately the "it never did"
// case, not the drift case pad 142 Part 1 diagnosed.
//
// MUTATION: swap the box mapping in deliverable() so `boxState ===
// null` reads "empty" instead of "absent" (collapsing the fifth value
// into the fourth). The test above ("ordinary delivery") still passes
// unchanged - both would read box=empty - but this one dies, because
// it is the only test in this file that can tell "absent" and "empty"
// apart. Run: swap the ternary branch, `npm run build`, re-run this
// file; the mutation must fail exactly this test.
```

## line 226

```
// FIX 1 (counselors, fix round 2): the pid branch was production-
// reachable and pinned by nothing - `const pid = "ok";` killed no test
// here, because every other spawned worker in this file has a
// freshly-recorded, matching pid, so "ok" is what they would all read
// anyway regardless of whether the ternary is real.
//
// `deliver_pane_pid` is `COALESCE(agents.pane_pid, '')` over a LEFT
// JOIN keyed on deliver_actor (src/scheduler.ts, DELIVER_SOCKET_JOIN) -
// a wake owned by a plain `user:` session with no agents row, or one
// whose worker row has closed, misses that join and reads ''. This
// test reproduces the SAME join-miss shape directly (blanking
// agents.pane_pid for a real, live worker) rather than constructing a
// rowless actor, because the fact under test is what deliverable()
// does with an empty recorded pid against a genuinely live pane, not
// how a rowless actor gets there.
//
// MUTATION: replace the pid ternary with `const pid = "ok";`. Dies
// here and only here - this is the only test in the file with a
// blanked agents.pane_pid.
```

## line 253

```
// Blanks the RECORDED pid while the real tmux pane stays alive and
// unchanged - the exact "cannot judge identity" shape paneReissued()
// itself already treats as no-fact rather than as a mismatch.
```

## line 276

```
// FIX 1 (counselors, fix round 2): the dialog branch was equally
// unpinned - `const dialog = "no";` killed no test here either, for
// the identical reason: every other delivery in this file reads a
// real, successful capture-pane, so "no" is what they would all read
// regardless of whether the ternary is real.
//
// paneAwaitingChoice (src/tmux.ts) returns null from a bare catch on
// ANY throw, including the real 10s TmuxTimeoutError a wedged tmux
// server produces. This test forces exactly that: a fake tmux binary
// that hangs on capture-pane and forwards every other subcommand
// (list-panes, split-window, ...) to the real one, paired with a short
// HIVE_TMUX_TIMEOUT_MS so the hang resolves to a timeout in
// milliseconds rather than the real 10s bound. Liveness and pid both
// read through list-panes (rowAliveProbe/targetLiveProbe), never
// capture-pane, so they are unaffected and this delivery still
// proceeds - it is ONLY the dialog and box reads that fail.
//
// A DEDICATED STORE, NOT ONLY A DEDICATED CLIENT, AND THIS IS THE PART
// THAT WAS WRONG THE FIRST TIME THIS TEST WAS WRITTEN. "Every hive MCP
// server instance runs this scheduler... As long as any session with
// hive is open, timers fire" (src/scheduler.ts's own header) is not
// decoration - the file's shared `mcp` client is itself a live server,
// ticking against the SAME database, the whole time this test runs.
// Pointing a hung-tmux client at the SHARED dataDir does not isolate
// anything: the shared server's own healthy tmux wins the atomic claim
// first and delivers the wake with a real capture-pane, and this test
// was measured green-for-the-wrong-reason that way - reading
// dialog=no, from the OTHER server. A dedicated scratch dataDir (and
// therefore a dedicated, differently-tagged tmux session -
// .claude/rules/tmux-and-panes.md, "tmux session names are namespaced
// by data store") makes the hung server the ONLY server that can ever
// see this wake at all.
//
// MUTATION: replace the dialog ternary with `const dialog = "no";`.
// Dies here and only here - this is the only test in the file whose
// tmux probe genuinely fails rather than genuinely answering.
```

## line 314

```
// sessionName() reads HIVE_DATA_DIR at call time (store-and-datadir.md)
// rather than caching it, so the swap has to bracket this one call -
// restored in the finally below regardless of what happens in between.
```

## line 350

```
// box=absent is the same failed-read route inputBoxState's own
// try/catch takes (route 3 of the three the box comment now names),
// not the fifth-value drift case - deterministic here, not
// incidental, since inputBoxHoldsWake always runs and always caches
// its result before deliverable() reads it back.
```
