# Attic: test/standing-watch.test.mjs

Comments removed from `test/standing-watch.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 9

```
// Todo 315. wake_when_idle is a ONE-SHOT: it fires once and stops watching, so
// a lead running three to five workers is structurally guaranteed to miss a
// finish. wake_when_idle(scope: "project") is a STANDING watch that keeps
// watching and reports each crew member as it finishes or goes away.
//
// EVERY ASSERTION HERE IS OVER A RECORD OF WHAT HAPPENED - timers rows, and
// wake_idle_notices rows - never over a sample of agents.agent_state
// (.claude/rules/worker-state.md, test/CLAUDE.md). The notice IS a timers row,
// so COUNTING those rows is what makes the cursor testable at all: a watch
// with no cursor files one every three seconds forever, and a watch with a
// broken cursor files none at all, and those two are only distinguishable by
// a count across ticks.
//
// THE SCHEDULER TESTS DRIVE tick() DIRECTLY, in a child process, with a
// SYNTHETIC AliveSnapshot literal - the method test/scheduler.test.mjs
// established. A pane in the snapshot is alive; one that is not is dead. That
// is the whole tmux dependency for the standing watch's own decisions, which
// touch no tmux at all: they are store reads and one INSERT.
//
// WHY THE OWNER IS A LEAD WHOSE PANE IS DEAD, in every fixture but the expiry
// one. A filed notice is a real due-now timer, so the NEXT tick tries to
// deliver it, and delivery is a tmux fork. A lead-owned wake whose pane is not
// live is HELD rather than cancelled or typed (deliverable()'s lead
// exemption), so these fixtures reach the exact code under test and stop
// short of typing at a terminal. The one fixture that DOES want a delivery
// says so.
```

## line 41

```
// TMUX_TMPDIR is forwarded into every fixture child on purpose. A fixture that
// does reach a tmux fork (the expiry one, and any accidental future path) must
// land on this suite's own private socket rather than the developer's server;
// paired with the scratch HIVE_DATA_DIR below, that is the isolation
// .claude/rules/tmux-and-panes.md allows, and the pairing it refuses is a
// private socket with the DEFAULT store.
```

## line 54

```
// One project, one lead that owns the watch, and helpers to add crew. Every
// row is older than SETTLE_WINDOW so the janitor judges it rather than giving
// it spawn grace, which is what makes "this pane is not in the snapshot" mean
// "gone" here instead of "not born yet".
```

## line 97

```
// The lead's own pane is deliberately absent: see the file header.
```

## line 147

```
// A notice carries the DEFAULT EMPTY watch list, and that is not
// incidental: deliver() calls watchedTail() unconditionally, and for a
// non-empty list it runs capture-pane for up to three agents and embeds
// their SCREENS in the body it types into the lead's own pane. Putting
// the crew in a notice's watch list is the obvious-looking way to build
// the roster, and it is the one thing that would turn a compact roster
// into three worker terminals plus three tmux forks per notice in the
// hottest loop hive has.
```

## line 157

```
// TODO 390: w2's LATER finish must still be reported (this is the
// one-shot's own defect), but while the pane stays held it must update
// the SAME pending notice rather than queue a second one behind it.
```

## line 168

```
// THE CONFIGURATION THE FIRST VERSION OF THIS FEATURE WAS INERT IN, and
// which the whole suite ran as without noticing. resolveDelivery
// (src/tools/wakes.ts) deliberately accepts a session with NO agents row,
// falling back to the TMUX_PANE it is running in - a plain claude session,
// or anything using the documented HIVE_AGENT_ID identity. Notices used to
// be filed at ownerPane(), which is a lookup in `agents` and answers null
// for exactly that caller, so the watch reported nothing for its whole life
// and then delivered a working expiry wake saying it had ended.
```

## line 191

```
// %lead IS in this fixture's snapshot, unlike every other one here, and
// that is not a detail. A rowless owner is by definition not a `lead:`
// actor, so the janitor's timers sweep has no exemption to give it: a
// watch whose delivery pane is not live gets CANCELLED on the first
// tick, before any of this runs. Correct, pre-existing behaviour, and
// it only became reachable for a standing watch once notices started
// going to deliver_pane - which is exactly why the fixture has to be
// honest about the pane being alive.
```

## line 208

```
// deliver_to is resolved at creation, stored, and echoed back. Filing at
// the owner instead makes one wake with two destinations, where the
// receipt names the one that gets almost nothing.
```

## line 243

```
// body is REQUIRED, help.ts teaches leads to write one, and
// worker-state.md tells them to make it self-contained. A required
// parameter that surfaces only when the feature ends is a broken
// contract.
```

## line 264

```
// The expiry branch only completes when deliverable() says yes, and a
// pane holding unsubmitted human text holds a wake INDEFINITELY by
// design. Returning before the reporting call meant a watch whose expiry
// was held stopped watching silently while wake_list showed it pending -
// this todo's own defect with a timer on it. Here the delivery pane is
// simply not live, which holds the same way for a lead-owned wake.
```

## line 321

```
// Decision A (todo 315 comment 638), and a deliberate difference from
// mode=any. The control below is the whole point of this test: it proves
// the two really do differ, rather than restating a default.
```

## line 340

```
// THE CONTROL'S INSTRUMENT IS held_reason, NOT fired_at, and the
// difference is the whole value of the control (counselors, opus 9). This
// fixture's lead pane is deliberately absent from the snapshot, so a
// one-shot that DID become ready would be held rather than fired and would
// read fired_at === null too - the assertion held in both states and
// discriminated nothing (test/CLAUDE.md shape 7). An unready idle wake is
// never offered to deliverable() at all, so a NULL held_reason is what
// actually proves it never became ready. The sibling control in "a watched
// worker that dies" asserts the same field in the opposite direction.
```

## line 359

```
// src/hook.ts rewrites state_changed_at even when the state it writes is
// the one already there, so a /goal fires Stop after every turn and
// .claude/rules/worker-state.md measured NINE false idles in fifty seconds.
// Keyed on the timestamp alone, a standing watch reports all nine.
```

## line 393

```
// TODO 390: the lead's pane is deliberately absent from this fixture's
// snapshot (the file header explains why), so it stays held across every
// tick here. The real finish below is still a NEW episode - the control
// this test exists for - but while the pane is held it folds into the
// one pending notice rather than queuing a second one behind it.
```

## line 401

```
// THE SHAPE RETENTION ACTUALLY PRODUCES, which the first version of this
// test could not reach. pruneStateLog deletes a PREFIX, by age and by a
// global row-count bound - so it takes the OLDER prompt|working row and
// leaves the NEWER stop|idle row standing. A fail-open keyed on "no rows at
// all after the previous episode" is aimed at the one shape a prefix delete
// cannot make, and the reachable one silently swallowed a real finish for
// the watch's whole life while wake_list showed it healthy.
```

## line 439

```
// TODO 390: still reported (unanswerable must not mean silent) - and,
// the pane being held throughout this fixture, folded into the ONE
// notice already pending rather than queued as a second row.
```

## line 446

```
// The other direction, and it is what stops the fail-open above from
// swallowing the /goal fix: a log that still covers the interval and
// simply holds no working row is an answer, not an absence of one.
```

## line 468

```
// THE STRICT-REGRESSION GUARD. Under the explicit-list wake this
// replaces, a watched worker that goes away fires the wake through
// watchedStates' GONE branch. Under project scope, membership is a query
// over RUNNING agents - so without a key of its own, a dead worker does
// not merely lack a fresh latch, it silently leaves the watched set.
```

## line 511

```
// THE PAIR, AND IT HAS TO BE A PAIR. Either half alone is green against a
// gone query with no state discriminator in it at all: the death below is
// reported either way, and "the close filed nothing" is only meaningful
// sitting next to a close that DID file something. Delete
// `a.agent_state != 'idle'` from standingGoneRows and this test goes red on
// the middle assertion, which is the whole reason it is written as one
// fixture walking one loop rather than two tidy ones.
```

## line 557

```
// TODO 390: the death is still reported (the whole point of this test),
// and since the pane is held throughout, it folds into the ONE notice
// already pending rather than filing a second row.
```

## line 585

```
// BOTH DIRECTIONS OF THE SUB-SECOND COLLISION, INSIDE ONE SECOND, which is
// the only way to test it: datetime('now') has no sub-second component, so
// a death at .100 and a watch at .900 are stored as the identical string
// and NO comparison between them can recover the order. `>=` reported the
// dead-already worker; `>` would lose the one that died while the watch was
// live, which the receipt had just named as watched. The fix is that
// neither stamp is compared: the cursor is seeded at creation, so the
// question is answered by a row that exists rather than by a timestamp.
```

## line 632

```
// Not a standing-watch assertion at all. It is the guard that this lane
// did not regress the behaviour it is replacing, which is the only way to
// know the gone-key work above was needed rather than invented.
```

## line 651

```
// The wake becomes READY on the gone branch and then holds only because
// this fixture's lead pane is deliberately dead. Held is the proof it got
// past `ready`: an unready idle wake is never offered to deliverable() at
// all, so held_reason would stay NULL.
```

## line 737

```
// CLAUDE.md's "the scheduler must never throw", reached through this lane's
// own new write. The cancel is one UPDATE in tick()'s candidate loop, and a
// throw from it - SQLITE_BUSY outliving the 5s busy_timeout, an I/O error -
// escapes fireDelay into tick()'s outer catch, which skips every later
// candidate. A notice that keeps failing that write starves every unrelated
// wake in the store on every tick.
//
// THE THROW IS INJECTED WITH A TRIGGER, because nothing else makes an UPDATE
// fail on demand: RAISE(ABORT) throws out of the identical statement, at the
// identical point. TWO SIBLING WAKES, one either side of the notice by id,
// so the assertion cannot pass by an accident of candidate ordering - the
// candidates query has no ORDER BY, and whichever end it starts from, one
// sibling is behind the throwing row. held_reason is the instrument rather
// than fired_at: these are lead-owned wakes on a dead pane, so being HELD is
// what "this candidate was reached" looks like here.
```

## line 822

```
// TODO 390 (pad 142 PART 3). Wakes held behind a modal (or, here, a dead
// lead pane - the same hold shape "the parent link" tests above already use
// to avoid a real tmux fork) used to queue one notice PER finish and release
// them all together the moment the pane cleared. THE PROPERTY UNDER TEST:
// N edges arriving while held must leave exactly ONE pending notice, naming
// every worker whose episode it stands in for - never a sample of the
// current row taken once, but the full set of rows this project EVER filed
// for the watch, which is durable precisely because a `timers` row is never
// deleted (test/CLAUDE.md's own rule: assert over a record, not a sample).
```

## line 877

```
// COUNSELORS ROUND 3, F7 CORRECTION: this pins pendingNoticeFor's OWN
// `fired_at IS NULL` filter, not updateNoticeInPlace's guard of the same
// shape - claimStandingBatch's read-then-write runs inside one
// .immediate() transaction, so updateNoticeInPlace's guard is never
// actually reached with a stale row from this caller (see its own
// comment). What this proves instead: a notice that has ALREADY fired by
// the time the next finish arrives must not be found as "pending" at
// all - w2's finish gets its OWN fresh notice rather than either being
// silently dropped or matched against a row that is already being typed.
// Delete `AND fired_at IS NULL` from pendingNoticeFor's own query (not
// updateNoticeInPlace's) to see this test go red.
```

## line 920

```
// REVIEW ROUND 1: created_at is refreshed on every in-place update (so
// NOTICE_MAX_AGE cannot cancel a long-held coalesced notice out from under
// itself), which means it answers "how fresh is the CONTENT", never "how
// long has this notice been HELD" - the trailer's first version read the
// one number as if it were the other, understating a long hold's own age
// worst in exactly the lunch-break case this lane exists for. The fix
// reads the hold's own start from wake_idle_notices.notified_at, which
// `updateNoticeInPlace` never touches. Proven here by forcing the two
// clocks apart with a backdated first episode, matching pad 142's own
// 45-minute scenario, rather than waiting on a real clock.
```

## line 964

```
// REVIEW ROUND 2 (Claude Code Review on PR #181). crewRowForRender's own
// comment claimed "a closed row does not move again"; agent_resume's flip
// (src/spawn.ts) proves that false, and coalescing is what makes it
// reachable - the pre-lane code rendered a GONE candidate once, from the
// row the same tick claimed it, and never read the row again. A worker
// reported GONE, then resumed while its notice is still held, must not
// have the next coalescing update re-assert a stale "no terminal left to
// read" obituary about a row that is now live.
```

## line 1018

```
// FIVE GUARDS THAT NO FIXTURE REACHED. Counselors listed five mutations to
// this lane's source that leave every earlier test in this file green - a
// guard nothing exercises is a guard the next reader can delete for being
// dead. Each test below is written against one of them and was checked by
// applying that mutation, not by reasoning about it.
```

## line 1025

```
// Two guards protect this and they are not redundant: the pane skip in
// noteStandingTransitions compares the wake's recorded deliver_pane
// against the row's tmux_target, and the actor_id exclusion in the query
// compares identities. They agree until a worker's pane MOVES after the
// wake was set (a respawn rewrites agents.tmux_target while the timer
// keeps the pane it resolved at creation), and then only the actor test
// still holds. That is the case here, so this kills the exclusion rather
// than passing on the pane skip.
```

## line 1057

```
// NOTICE_RETRY_AFTER's LOWER bound, which is the entire reason it is sixty
// seconds rather than zero. Delivery is not atomic with the claim
// (sendText's own ENTER_DELAY_MS is 300ms, and the path can queue behind
// the store's 5s busy_timeout), so a second instance ticking in that gap
// must read a healthy in-flight notice as in flight, not as failed.
//
// WHAT THIS PINS EXACTLY: a claim five seconds old is not re-armed, which
// kills any bound shorter than five seconds. It does not distinguish 60s
// from 30s, and it does not need to - what a shortened bound breaks is
// duplicate delivery of a live notice, and five seconds is already far
// past the whole claim-to-typed path.
```

## line 1088

```
// The read-gate INSIDE the claim, which the cancelled-parent test above
// cannot reach: it cancels the watch between ticks, after which tick()'s
// own candidates query excludes it and this guard is never consulted. The
// race it exists for is the one where the cancel lands DURING a tick,
// after the candidates SELECT that produced the in-memory row - real,
// because a tick can span several deliveries and their 300ms Enter sleeps.
//
// Reproduced with a trigger on an EARLIER candidate's own hold, which is
// the only way to write "another actor cancelled it mid-tick" from inside
// a single-process fixture. If the candidate order were ever reversed the
// watch would file its notice and this test would FAIL rather than pass
// vacuously, which is the safe direction for an ordering it cannot pin.
```

## line 1127

```
// The same conservatism watchedStates applies, for the same reason: a row
// that says `idle` is a hook's claim about a pane, and if this process
// cannot see that pane (dead) or has no business reading it (issue #73's
// foreign socket, where a probe answers correctly about someone else's
// server) the honest answer is "no fact", not "finished".
```

## line 1143

```
// %2 is absent: the dead pane. %3 is present, so the only thing that can
// exclude `foreign` is its recorded socket.
```

## line 1155

```
// test/CLAUDE.md shape 6, a fixture too small to reach the bound: every
// other test here has two workers against a cap of eight, so the cap and
// its "and N more" branch were unreachable from the whole file. Ten
// running workers plus one that finishes.
```

## line 1189

```
// Swallowing this would make every assertion below vacuous on a runner
// with no server, so it is deliberately NOT collapsed to "" - the empty
// string is a value the assertions accept.
```

## line 1235

```
// TWO PROPERTIES OF THE ROW, WITH THE REASONS THEY ARE ACTUALLY PINNED
// FOR. An earlier version of this test attached the mixed-version
// argument to the kind assertion, and that argument was FALSE: an old
// scheduler's idle_all branch requires states.length > 0, a guard that
// predates this lane, and a standing watch stores an empty watch list
// under either design - so a new kind and this flag degrade identically.
// The real reason kind stays 'idle_any' is that SQLite cannot ALTER the
// CHECK constraint on that column, so a new value means rebuilding
// `timers` under live writers. See src/db.ts's migration.
```

## line 1245

```
// This one IS load-bearing at runtime: deliver() calls watchedTail()
// unconditionally, and a non-empty watch list makes it capture up to
// three worker panes and paste their SCREENS into the delivered body.
```

## line 1254

```
// A project holds one standing watch per owner, so every test in this
// block that sets one hands it back. See the refusal test below.
```

## line 1259

```
// NOTHING REFUSED A SECOND ONE, and the way a lead gets there is ordinary:
// calling again after a restart, or having forgotten. The cost is every
// finish reported twice for four hours with two wake ids to find.
```

## line 1269

```
// Scoped to (project, OWNER), not to the project: refusing project-wide
// would stop a second lead watching a crew it shares, which decides the
// cross-lead question todo 315 comment 631 records as unanswered.
```

## line 1286

```
// And once it is cancelled the owner may set another, or a lead could
// never replace its own watch.
```

## line 1292

```
// THE LIFETIME, AGAINST A REAL PANE, and it is here rather than in a
// fixture for a reason worth recording. A fixture version of this test
// PASSED against the pre-lane source: a row with kind='idle_any', an empty
// watch list and a max_wait_at in the past fires through the existing
// timeout branch whether or not this lane exists, so the assertion "it
// fired" was already true. The only thing that is actually new at expiry is
// WHAT IT SAYS, and the only place that exists is the pane. So the test
// reads the pane. (workflows/verify-a-test-goes-red-first.md, step 9: ask
// what the test would assert if the subject did nothing.)
```

## line 1305

```
// The running server's own scheduler delivers it, on its own tick.
//
// THE MARGIN IS NAMED, and until()'s own 3000ms DEFAULT IS EXACTLY THE
// SCHEDULER'S TICK INTERVAL (startScheduler's default, src/scheduler.ts),
// so the default gives this delivery ONE tick's chance and no slack for
// the ~300ms ENTER_DELAY_MS and the tmux forks after it. That is not a
// theoretical race: it failed under the full suite at 3008ms while
// passing on its own, and until() RETURNS FALSE rather than throwing, so
// it failed on the row assertion below with a message about the wrong
// thing. Six tick opportunities, asserted on directly.
// (.claude/sessions/decisions/2026-07-31-accept-margin-over-happens-
// before.md: a margin is not a happens-before, so anchor it to the real
// product constant and make shrinking it loud.)
```

## line 1334

```
// TODO 390 (pad 142 PART 3, the cheap win). Every generated notice's body
// is a snapshot, so it must say when it was taken and how stale it already
// is by the time a human reads it. Proven against a REAL delivery, because
// the trailer is appended in deliver() itself, not stored in the row's own
// body - a test that only read the `body` column would not see it at all.
// ITS OWN SESSION AND PANE, deliberately not the shared `mcp`/`livePane`
// above: those accumulate every prior test's pasted text for the life of
// this describe block, past the pane's own visible height, and even a
// wide `-S` scrollback capture came back with this assertion's own tail
// silently missing - a pty input-buffer limit on the "sleep 600" pane's
// cooked-mode echo, not anything this lane's own code does. A fresh pane
// starts with nothing in it, so this cannot be that.
```

## line 1362

```
// A GONE worker, not an idle one: standingGoneRows consults no tmux at
// all, so this needs no second real pane the way an idle finish would.
```

## line 1386

```
// TODO 390 COUNSELORS ROUND 3, F6 (opus + fable, independently). The
// fixture-based "keeps the hold's own start time separate..." test
// re-implements the MIN(notified_at) query inline and never calls
// noticeStalenessNote or delivers anything, and the real-delivery
// staleness test above uses a single, uncoalesced notice where both
// clocks agree to the second - so neither can fail against a version that
// silently reads `heldSince = timer.created_at` for both halves, which is
// the exact defect round 1 shipped. THIS test forces the two clocks apart
// (a 45-minute backdated first episode, matching pad 142's own scenario)
// AND delivers the result through the real, running server, then reads
// BOTH numbers back off the DELIVERED PANE TEXT - proving what the
// header comment above claims rather than asserting it.
```

## line 1400

```
// `cat > file`, NOT `sleep 600`: this notice's body (two candidates plus
// the coalescing summary) is long enough to hit a real limit `sleep`'s
// pane hits elsewhere in this file - nothing reads a `sleep` pane's
// stdin, so the pty's own cooked-mode input queue fills and silently
// drops the tail of a long paste, independent of this lane's own code
// (measured: cut off mid-word, at a different byte offset each run).
// `cat` continuously drains stdin, so nothing queues up, and every byte
// sent lands in the file - read that back instead of capture-pane's
// viewport, which only ever showed what `cat` echoed to its OWN stdout,
// a second and unrelated copy.
```

## line 1417

```
// LEAD-SHAPED ACTOR, DELIBERATELY. isLeadActorId is a bare string-prefix
// check with no row lookup behind it (worker-state.md), so this needs no
// real agents row to get deliverable()'s lead exemption: a dead
// deliver_pane HOLDS (retried every tick) rather than being CANCELLED
// outright, which is what a non-lead owner gets with no SETTLE_WINDOW
// grace at all. That HOLD is what buys the window this test needs
// between the two finishes - a live pane throughout would let the FIRST
// notice deliver before the second finish ever has a chance to coalesce
// into it, which is exactly the race the first version of this test hit.
```

## line 1436

```
// Redirect BEFORE any finish is added, so every notice this watch
// files inherits the dead pane and holds from birth.
```

## line 1439

```
// GONE workers, not idle ones: standingGoneRows consults no tmux at
// all, so neither needs its own real pane the way an idle finish would.
```

## line 1472

```
// RELEASE THE HOLD, matching what `hive lead` does on restart: point
// the pending notice at the real, live pane so the next tick delivers.
```

## line 1477

```
// Poll for text at the very END of what deliver() sends (the trailer,
// appended after the body), not text near the start - `cat`'s own
// write-to-file buffering does not guarantee the whole single paste
// lands in the file atomically, so polling on an early marker like
// "finished or gone away" can see a PARTIAL write that stops short of
// the trailer this test exists to check, and read that as "delivered"
// before it actually was. Waiting for the trailer's own last words
// means everything before it, in the same write, is already there.
```

## line 1512

```
// THE WIRING, which the fixture above cannot see: it calls seedGoneCursor
// itself, so it proves the seeded cursor SUPPRESSES a death and proves
// nothing about anyone calling it. This is the half that fails if
// createStandingWatch stops seeding.
```

## line 1518

```
// The project row the server resolved for this cwd, read off a wake it
// created rather than guessed at from a path.
```

## line 1548

```
// A notice the watch would have filed, written directly: what is under
// test is the cascade, not the filing, and the scheduler tests above
// already pin the filing.
```
