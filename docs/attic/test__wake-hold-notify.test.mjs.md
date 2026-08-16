# Attic: test/wake-hold-notify.test.mjs

Comments removed from `test/wake-hold-notify.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 20

```
// Todo 314, issue #28's fourth path. A wake held because its target pane is
// on a dialog now tells the wake's OWNER, once, instead of holding silently.
//
// Every assertion here is over a RECORD OF WHAT HAPPENED - rows in timers,
// and the owner pane's own screen - never a sample of what is (test/CLAUDE.md,
// .claude/rules/worker-state.md). The notification is itself a timers row, so
// COUNTING those rows is what makes the debounce testable at all: a per-tick
// version inserts one every three seconds for as long as the dialog is up,
// and this file's headline test was proven RED against exactly that before
// the conditional claim went in.
//
// Real tmux, real spawned workers, real dialog fixture, and the server's own
// natural scheduler tick - the same method test/wake-delivery-state.test.mjs
// uses for the hold this notification hangs off.
```

## line 76

```
// The notification names the wake it is about, so every row it could have
// produced is findable from the held wake's own id. Excluding that id is what
// keeps this from counting the held wake itself, and the trailing space is
// not decoration: without it a query for wake #1 also matches a notice about
// wake #10, so the count assertions below would silently drift once this file
// has ten wakes in one store.
```

## line 89

```
// A wake OWNED by a spawned worker, so the notification has a pane to reach.
// wake_set records currentActor() as the owner and this test session is a
// plain `user:` actor with no agents row, which is a genuine no-pane case the
// scheduler skips - so the owner is rewritten before the wake comes due. The
// row is otherwise exactly what wake_set built, delay long enough that no
// tick can evaluate it in the gap.
```

## line 101

```
// The same trick for an idle wake: wake_when_idle records this test session
// as the owner, and it has no pane. The wake itself is exactly what the real
// tool built, watching real agents, with a max_wait far outside every timeout
// in this file - so a notification arriving here can only be the block path,
// never the timeout the wide half exists to beat.
```

## line 117

```
// The standing-watch version of ownedIdleWake above, and it exists for the
// same reason: wake_when_idle records this session's rowless `user:` actor as
// the owner, which has no pane. It returns the ORIGINAL owner too, because
// wake_cancel is owner-scoped and a fixture that has re-owned a wake cannot
// cancel it back (see cancelWatch).
```

## line 134

```
// The store's own account of a worker being stopped on a dialog: what
// src/hook.ts writes when Claude Code raises a Notification (todo 313's
// capture measured exactly this sequence). Written directly because a fake
// claude fires no hooks - the pane fixture supplies the dialog, this supplies
// the latch that decides whether hive bothers to look at it.
//
// `since` is explicit so the re-arm test can move it: it is the block-episode
// key (wake_block_notices.blocked_since), and a second block with the same
// timestamp is the same episode by design.
```

## line 167

```
// deliver_actor and project_id are both unreadable from the delivered
// screen, so nothing else in this file would notice them being wrong.
// deliver_actor is how DELIVER_SOCKET_JOIN resolves the notification's
// tmux socket and how checkConfirmations attributes it; project_id is
// the deliberate cross-project choice (the HELD wake's project, not the
// owner's own row's).
```

## line 183

```
// THE HEADLINE ASSERTION. Not just "one notification exists" - one
// notification exists AFTER the scheduler has gone on holding this
// wake for several more ticks. held_at is rewritten by holdTimer on
// every tick the hold still applies, so an advanced held_at is proof
// the ticks kept happening and kept holding; without it, "still one
// notification" would also be satisfied by a scheduler that had
// stopped, which is the vacuous pass this file must not be able to
// take (test/CLAUDE.md, shape 7).
```

## line 204

```
// HAND THE STORE TO A DIFFERENT SERVER PROCESS, which is why the
// debounce had to be an atomic conditional UPDATE rather than anything
// held in memory: hive runs one MCP server per Claude Code session, all
// ticking against one WAL store, and sessions come and go. An
// in-process Set of already-notified timer ids passes every assertion
// above - measured, not assumed - and cannot pass this one, because the
// fresh process starts with an empty one.
//
// The OLD server is closed first, deliberately. Leaving it running
// makes an advancing held_at prove nothing about the new process (the
// old one advances it every three seconds either way), and the count
// below would then be asserted before the new server had necessarily
// ticked at all - which is exactly how this assertion passed against
// the in-process mutation on its first version.
```

## line 234

```
// The original wake is UNTOUCHED: not fired, not cancelled, not typed.
// This is the line between this lane and the withdrawn also_when_stuck
// design, so it is asserted rather than assumed.
```

## line 243

```
// The notification really reached the owner's terminal, read back off
// that pane rather than inferred from the timers row.
```

## line 246

```
// `-S -` is the WHOLE history, not the visible screen. A project-scope
// watch delivers one notice per condition and each is a multi-line
// roster, so by the time this reads the pane the line naming this worker
// has scrolled well past the visible rows - and how far depends on how
// many OTHER crew members this file happens to have left blocked, which
// would make this assertion a fixture depending on unrelated tests.
```

## line 258

```
// Clearing the dialog lets the ORIGINAL deliver normally, which is the
// whole reason it was held rather than fired or cancelled.
```

## line 281

```
// It inherits deliverable()'s guards because it IS an ordinary wake:
// held, not typed into the dialog. That is the property that makes
// reusing the delivery path worth more than a direct call to deliver().
```

## line 290

```
// THE RECURSION GUARD. A held notification is a hold like any other, so
// without the "nobody else to tell" rule it would notify its own owner
// and that notification would hold and notify again, one row per tick
// forever. Nothing may be filed about the notification itself, and the
// original must still have exactly one.
//
// WHAT THIS BOUNDS, said plainly because the guard is two rules and
// this exercises one: no chain within these few ticks, with the owner's
// agents row unchanged throughout. The owner === deliver_actor check in
// ownerPaneToTell is what holds when that row DOES change (a lead
// restart moving panes, or two running lead rows sharing one actor_id),
// and nothing here moves a row, so this test does not see that half.
```

## line 317

```
// The positive control this negative test needs: "nobody was told" is
// equally satisfied by an owner nobody COULD have told (an empty
// tmux_target, or the same pane as the target), which is
// test/CLAUDE.md's shape 7. Assert the exact inputs the notify path
// reads before asserting its silence.
```

## line 327

```
// real-input.txt is a human mid-sentence in that pane, not a stuck
// worker, and a human does not need to be told about their own typing.
```

## line 337

```
// The third hold reason, and the one a real tmux cannot easily produce: a
// lead-owned wake whose own delivery pane is not live (mid-restart). There is
// no live pane to deliver a notification to, so the hold must stay silent -
// and this is reachable with a fabricated snapshot and no tmux at all, the
// same shape test/scheduler.test.mjs uses.
//
// The owner's pane IS in the snapshot on purpose. With it absent the janitor
// would close the owner's row before deliverable() ever ran, and "no
// notification" would be satisfied by the owner having no running row rather
// than by the hold reason - two indistinguishable causes for one assertion
// (test/CLAUDE.md, shape 7).
```

## line 366

```
// AMENDMENT 1's half of the feature, and the one that makes it a fix rather
// than a delay. maybeFireIdle gates on `ready` before it ever consults
// deliverable(), and a worker stopped on a dialog is `waiting`, never idle -
// so a wake_when_idle watching it never becomes due, is never held, and its
// owner hears nothing until max_wait_seconds. Every wake below is created
// with max_wait_seconds: 900, an order of magnitude past every timeout in
// this file, so a notification arriving here CANNOT be the timeout path.
```

## line 398

```
// The wake itself is untouched: still pending, never fired, never
// cancelled, and NOT marked held - it was never due, so writing held_at
// would make wake_list and `hive status` report a delivery hive never
// attempted.
```

## line 408

```
// Still one after several more ticks, with the dialog still up: the
// block-notice claim is per episode, not per tick. THE CONTROL WAKE is
// what stops that being vacuous: the wide path writes nothing to the
// watched timer, so there is no advancing column to prove the scheduler
// was even running during the window (the held-wake half used held_at
// for exactly this). A plain wake set to fire inside the window MUST be
// delivered by the end of it, so a scheduler that had stopped fails
// here rather than passing the count assertion for free.
```

## line 425

```
// AND NOT IN THIS PROCESS EITHER. Same mutation the held-wake half's
// handover kills: an in-process Set keyed on (timer, agent, episode)
// satisfies every count above, because one server has been doing all
// the work. Hand the store to a fresh process, whose memo is empty, and
// let it go on seeing the same block.
```

## line 445

```
// THE RE-ARM. A worker that is unblocked and blocks again must be
// reported again, which is why the claim is keyed on the agent's own
// state_changed_at rather than on a boolean. Faithful to the real
// sequence: the dialog is answered (pane clears, hive records the
// worker moving off `waiting`), then a new dialog goes up with a new
// state_changed_at.
```

## line 465

```
// Todo 392, measured live before this fix: a standing watch armed over a
// worker sitting on an ordinary tool-permission prompt filed ZERO block
// notices in ~4 minutes, because noteBlockedWatched's own pane read
// (paneChoiceCheck) answered "no dialog" - the preview box's own `╰`
// again. Same mechanism as the folder-trust case above; this pins the
// fixture the bug was actually about.
```

## line 500

```
// The exact shape that killed also_when_stuck: `waiting` is latched and
// nothing clears it, so a worker that answered its dialog and carried
// on still reads `waiting` in the store for the rest of its turn. The
// store cannot tell that from a live block - and is never asked to.
// The pane read is the authority, and this pane has no dialog on it.
```

## line 513

```
// The positive control, or "nothing was sent" proves nothing: the owner
// has a pane, it is not the watched pane, and the watched agent really
// does read `waiting` in the store.
```

## line 529

```
// TODO 321, STEP 2. The lead suspected the shipped one-shot path files its
// block notice at the wrong pane, and this is the measurement rather than
// the suspicion. noteBlockedWatched resolves who to tell with ownerPane(),
// which is `SELECT tmux_target FROM agents WHERE actor_id = ? AND status =
// 'running'` - null for a session with no agents row. resolveDelivery
// (src/tools/wakes.ts) DELIBERATELY supports that caller, falling back to
// the TMUX_PANE it is running in, so a plain `user:` session that sets
// wake_when_idle has a perfectly good delivery pane recorded on the wake
// and was told NOTHING about a worker stopped on a dialog - exactly the
// silence todo 314 exists to remove, in the configuration todo 315 found
// the standing watch inert in.
//
// BOTH HALVES ARE ASSERTED IN ONE TEST ON PURPOSE, because each is the
// other's control. "A notice was filed for the rowless owner" is
// meaningless without proof that the owner really has no row; "the notice
// still goes to the owner when it HAS one" is what pins that this is a
// FALLBACK and not a redirect - the wake's deliver_to here names a
// different session from the owner throughout, so a blanket switch to
// deliver_pane fails the second half.
```

## line 554

```
// NOT ownedIdleWake: the owner is left exactly as wake_when_idle
// recorded it, which for this test session is a `user:` actor with no
// agents row at all. That is the case under test, not a fixture
// shortcut.
```

## line 586

```
// THE FALLBACK CONTROL. Give the same wake an owner that HAS a running
// row and re-arm the block (a new state_changed_at is a new episode, the
// same way the re-arm test above does it). The owner is now a different
// session from deliver_to, so the pane the second notice lands on says
// which rule is in force.
```

## line 609

```
// mode=any watching both, DELIVERED TO the blocked worker, and the two
// paths are reached IN SEQUENCE - which is the shape that matters,
// since maybeFireIdle now skips the wide path for a wake that is ready.
// Stage one: nothing is idle, so the wake is not ready and the wide
// path speaks about the blocked worker. Stage two: the other watched
// agent goes idle, the wake becomes ready, deliverable() finds the
// delivery pane on that same dialog, and the held-wake path must stay
// silent - both compute the same (wake, agent, episode) key.
```

## line 627

```
// WHICH PATH SPOKE, asserted rather than left to the count (counselors
// round 2, both seats: with the wide path deleted entirely, the held
// path alone also produces exactly one notice to this same pane, so a
// count-only test is green against gutting the feature). The wide
// path's body is the one that says the wake cannot fire yet.
```

## line 637

```
// Stage two: make the wake READY while its delivery pane is still on
// the dialog, which is the held-wake path's own condition. It must hold
// the wake exactly as before and say nothing, because the wide path
// already claimed this episode.
// resumed_at IS CLEARED IN THE SAME STATEMENT, and todo 373 is why. This
// worker was REALLY spawned (spawnShowing), so launchAgent stamped the
// "started, and not yet given anything" latch on its row, and every idle
// reader now declines to act on the idle of a worker nobody has given
// anything to (src/firstPrompt.ts). The finish this line is simulating is
// a worker that WAS given its lane and finished it, so clearing the latch
// is what makes the seeded row mean what the test says it means - without
// it, stage two's premise ("the wake becomes ready") is silently false
// and the assertions below pass on a wake that was never held.
```

## line 667

```
// TODO 321. Todo 314's block half read its membership from
// JSON.parse(timer.watch) and answered [] for an empty list, and a STANDING
// watch stores watch='[]' on purpose - so a crew member stopped on a
// permission prompt was invisible to it. The finish half cannot see that
// worker either (it is `waiting`, never idle), so the owner heard nothing at
// all until the watch expired, four hours later by default. A lead taking the
// advice this project now gives - one standing watch instead of N one-shots -
// lost a signal it used to have.
//
// SAME METHOD AS THE ONE-SHOT HALF ABOVE: real tmux, a real spawned worker
// showing a real dialog fixture, the server's own natural tick, and every
// assertion over a RECORD OF WHAT HAPPENED (rows in timers and
// wake_block_notices) rather than a sample of agent_state.
```

## line 684

```
// A block notice carries no parent link (todo 322 is the open question of
// whether it should), so it cannot be found the way a finish notice can.
// The worker's name is unique per test and a finish notice about a
// DIFFERENT worker can still name this one in its "Still going" roster, so
// the parent filter is what separates the two kinds rather than decoration.
// Matched on the worker's name alone, NOT on the standing body's own
// wording. A matcher carrying "Standing watch #" reads well and is a trap:
// it makes every count assertion below silently become "how many notices
// used the standing WORDING", so a regression that files per-agent notices
// with the one-shot body fails as "0 found" instead of "2 where 1 was
// expected. Measured, not imagined - that is exactly what the first
// version of this helper did under the batching mutation. Names are unique
// per test and no one-shot wake in this file watches these workers, so the
// name is enough on its own.
// CANCELLING A WAKE THIS FILE HAS RE-OWNED DOES NOT WORK BY DEFAULT, and
// finding that the hard way is why it is a helper. wake_cancel is
// owner-scoped, and these fixtures rewrite `owner` to a spawned agent so
// the notice has a pane to reach - so a plain wake_cancel from this
// session matches nothing, returns a receipt, and leaves the watch
// RUNNING. Two live standing watches then both file notices about the same
// crew, and the second test reads the first watch's notice while looking
// for its own claim rows. Give the wake back before cancelling it, and
// assert the cancel actually landed rather than trusting the receipt.
```

## line 713

```
// ONE DEFINITION OF THE CALL THE BODY SUGGESTS, shared by the matcher and
// every assertion below. Written out twice, it drifted the moment the lane
// corrected that call's parameter name (agent: -> name:): the matcher
// silently stopped matching anything and three assertions failed as "0
// notices filed" - a red that reads as the feature being broken rather
// than the test being stale. test/CLAUDE.md's shape 5 from the other side.
```

## line 721

```
// A spawn receipt says the pane EXISTS; it does not say the fixture has
// finished painting into it. Step 3's negative cache turned that race from
// a one-tick delay into a 30-second one - a tick that reads the pane
// between `liveAgentRow` and `cat` finishing gets "no dialog" and
// suppresses for 30s - so every standing fixture here waits for the dialog
// to be ON SCREEN before the watch that reads it exists. Found by
// counselors round 1 (opus F8) as a flake this lane would otherwise have
// added.
```

## line 750

```
// The membership control, and it is the whole point of the lane: the
// watch names NOBODY, and the blocked worker was never in a list.
```

## line 770

```
// NOT "it has no max wait": every standing watch carries max_wait_at as
// its LIFETIME (counselors round 1, codex 5c). What is false for a
// standing watch is that the max wait is a deadline it races to fire
// before, which is what the one-shot's sentence means by it.
```

## line 777

```
// THE NO-CHAIN FACT, PINNED RATHER THAN ARGUED. The reason a notice can
// never itself become a block-notice candidate used to be "it carries
// the default empty watch list"; an empty list is exactly what stopped
// meaning "watches nothing" in this lane. What holds now is that
// insertNotice sets no watch_scope, so the notice stays a one-shot row.
// A future insertNotice that copied its parent's scope would pass every
// other assertion in this file and fail here.
```

## line 788

```
// THE WATCH'S OWN ROW IS UNTOUCHED. Writing fired_at would stop it
// watching; writing held_at/held_reason would make wake_list and `hive
// status` report a delivery hive never attempted.
```

## line 797

```
// ONE PER BLOCK, NOT ONE PER TICK, with the same control the one-shot
// half uses: the wide path writes nothing to the watch, so a plain wake
// set to fire inside the window is what proves the scheduler was still
// ticking rather than stopped.
```

## line 809

```
// Scoped to THIS agent, not to the watch. A project-scope watch really
// does report every blocked crew member, including the ones earlier
// tests in this file left latched on their own dialogs, so a
// watch-wide count here would assert that the lane's own feature does
// not work.
```

## line 831

```
// FILED IS NOT TOLD. Every assertion above reads a timers row or a claim
// row, and .claude/rules/tmux-and-panes.md records what that misses:
// todo 317's handler returned {sent: true} without ever calling sendText
// and kept eight tests green. typed_at is set only after sendText has
// RETURNED (deliver(), outside its own try/finally), so requiring it here
// kills a standing block notice that is filed and never typed - proven
// red by making claimBlockBatch file its notice with a due_at an hour
// out.
//
// THE PANE ITSELF IS READ IN THE FIXTURE TEST AT THE BOTTOM OF THIS FILE,
// not here, and that is a limit of THIS fixture rather than a weaker
// standard. This owner is the delivery target of a project-scope watch in
// a file that leaves a dozen workers running, so it also receives finish
// notices whose rosters name all of them - and its pane is a shell in
// `sleep`, which never consumes what is typed at it. Measured rather than
// reasoned about: in a full-file run this pane's whole history ends
// mid-way through the FIRST large notice delivered to it, with everything
// after that absent, so whether this assertion passes depends on which
// notice happened to arrive first. The bottom fixture reads a pane whose
// only delivery is the block notice under test.
```

## line 854

```
// A SECOND CREW MEMBER, SPAWNED AFTER THE WATCH WAS SET. This is the
// coverage the assertion above gave up when it was scoped to one
// agent_id, and it is worth more deliberately than it was by accident:
// it pins that membership is a LIVE QUERY over the project rather than a
// set fixed at creation, which is the property a one-shot does not have
// and the whole reason a standing watch exists. A version that resolved
// the crew once, when the watch was created, passes every assertion
// above and fails here.
```

## line 880

```
// Only one standing watch is allowed per project at a time, so this must
// not outlive its own test.
```

## line 885

```
// ONE NOTICE, NOT ONE PER WORKER. A notice is delivered by a paste into a
// pane, so the per-agent shape todo 314 shipped means three blocked crew
// members are three pastes and three user turns in a lead's session about
// one situation. That was fine while membership was a list the caller
// wrote; project scope is what removed the bound, which is the same
// argument the fork cost gets.
//
// THE FIXTURE IS THE ORDINARY CASE RATHER THAN A CONTRIVED ONE: both
// workers are already sitting on their dialogs when the watch is created,
// which is what "a lead sets a standing watch over a crew that is already
// stuck" looks like. The dialogs are confirmed ON THE PANES before the
// watch exists, so the first tick that can see the watch can see both
// blocks - otherwise this could pass by filing two notices a tick apart
// and never exercise the batch at all.
```

## line 902

```
// A LEGAL NAME CARRYING A QUOTE. normalizeAgentName rejects control
// characters and nothing else, so this is a name a user can really
// create, and interpolating it between literal quotes rendered
// agent_output(name: "batch"two") - a remedy the reader cannot run,
// invisible to test/wire-surface.test.mjs because that guard reads the
// template in source rather than a rendered body. The expectation below
// is written out LITERALLY rather than through JSON.stringify, which
// would just be the renderer asserting about itself.
```

## line 940

```
// The roster's own count, checked against the body rather than against a
// literal: a project-scope watch legitimately names every OTHER crew
// member this file has left latched on a dialog, so the honest assertion
// is that the number the reader is given matches the number of workers
// listed under it.
// A TAUTOLOGY TODAY, KEPT WITH THAT SAID (counselors round 1, opus F7).
// The header count and the per-worker lines are both rendered from the
// one `names` array in standingBlockNoticeBody, so this cannot currently
// fail. It has power only against a future version that renders the two
// from different sources - which is exactly the shape that would tell a
// lead "2 crew members" above a list of three - so it is worth its two
// lines, and worth not being mistaken for coverage it does not provide.
```

## line 959

```
// The claims are still PER AGENT - the batch is the delivery vehicle,
// not the key. Without this a single row keyed on the timer would look
// identical here and would stop the second worker ever being re-reported
// after it blocks again.
```

## line 975

```
// WHAT THIS PINS AND WHAT IT DOES NOT, because the first version of its name
// claimed more than the fixture can see (counselors, opus). The seeded row
// takes deliverable()'s `!live` branch, which calls holdTimer directly, so no
// mutation inside ownerPaneToTell, claimModalHoldWithNotice, heldTarget or
// holdNoticeBody can turn this red - gut all four and it still passes. What
// it does kill is routing the lead-pane-dead hold through noteModalHold,
// which would fail both assertions below: held_reason would read the modal
// string, and agent:9's live pane would get a notice.
//
// The case its old name suggested - a MODAL hold whose owner has no live pane
// - is a NAMED RESIDUAL rather than a covered one: that hold latches
// held_reason with nobody told, and no later tick claims again. See
// claimModalHoldWithNotice's own comment on why that is accepted here (it
// fails silent, the pre-lane behaviour) and what closing it would cost.
```

## line 1012

```
// TODO 321, STEP 3: THE FORK THE BLOCK HALF PAYS FOR A PANE WITH NO DIALOG ON
// IT. A worker that answered its prompt and carried on still reads `waiting`
// forever (issue #28's latch), so the only gate in front of the pane read -
// "have I already reported this block" - never fires for it and hive re-reads
// its screen on every tick, in every running session. Todo 314 accepted that
// on the grounds that the set was "small by construction"; project scope
// removed the bound, and a standing watch stays a candidate for its whole life
// where a one-shot leaves at fired_at.
//
// THE ASSERTION IS A COUNT OF capture-pane INVOCATIONS, NEVER AN ELAPSED TIME.
// A timing assertion here would be a flake generator, and the thing under test
// is literally "how many times did we fork", so counting the forks is both the
// stronger and the cheaper measurement. A `tmux` shim earlier on PATH logs
// every invocation and execs the real binary, so the fixture drives a REAL
// tmux against a REAL pane and still gets an exact count.
//
// The snapshot is passed in, so tick() never calls liveTargets() and the only
// capture-pane naming this pane can be the block half's own read.
```

## line 1043

```
// A real pane showing a real screen with NO dialog on it: the stale latch
// this cache exists for. Created through the real tmux, in this file's own
// isolated session, so the fixture's rowAlive and paneAwaitingChoice are
// answering about something that genuinely exists.
```

## line 1085

```
// The positive half FIRST: a count of 0 would satisfy "not re-read" while
// meaning the block half never looked at all, which is two
// indistinguishable causes for one assertion (test/CLAUDE.md, shape 7).
```

## line 1090

```
// And nothing was reported, which is what makes this the STALE latch case
// rather than a worker that really is on a dialog.
```

## line 1097

```
// COUNSELORS ROUND 1, codex 3. blockNoticeTarget preferred the OWNER's pane on
// the strength of `status = 'running'` alone - and the janitor deliberately
// EXEMPTS kind='lead' rows, so a lead whose pane died keeps a running row
// naming a dead pane for as long as it likes. Owner-first then chose that dead
// pane over a live deliver_to, claimed the block episode against it, and
// nobody was ever told: this lane's own defect - silence about a blocked
// worker - reintroduced by this lane's own targeting rule.
//
// Real tmux for the dialog, because the decision under test happens AFTER the
// pane read: a fabricated snapshot cannot produce a dialog, and without one no
// notice is filed at all and the test would pass for the wrong reason.
```

## line 1117

```
// The dialog has to be painted before the fixture reads it, for the same
// reason the standing tests above wait: a read that lands early answers
// "no dialog" and the fixture proves nothing.
```

## line 1133

```
// The lead: running, janitor-exempt, and its pane is NOT in the
// snapshot below. That pairing is the whole fixture.
```

## line 1141

```
// Owned by the lead, delivered to the live worker: the exact shape a
// lead sets when it wants a reviewer told instead of itself.
```

## line 1146

```
// Two ticks: the first files the notice, the second delivers it. The
// notice is the ONLY thing ever typed at tellPane, which is what makes
// reading it back off that pane a stable assertion.
```

## line 1165

```
// FILED IS NOT TOLD (counselors round 1, codex 6). Everything above reads
// rows; this reads the terminal. A standing block notice that never reaches
// sendText passes every row assertion in this file and fails here.
```

## line 1174

```
// FOUND BY THE PR GATE ON THIS LANE, after blockNoticeTarget's identical defect
// was fixed: ownerPaneToTell resolved the owner's pane on `status = 'running'`
// alone, and the janitor exempts kind='lead', so a lead whose pane died keeps a
// running row naming a dead pane indefinitely.
//
// WHAT IT COSTS, and it is not the notice - it is the CLAIM.
// claimModalHoldWithNotice claims wake_block_notices on the same (timer, agent,
// episode) key the wide half uses, and nothing re-arms that key inside an
// episode. So filing at a dead pane SPENT the one report that block was ever
// going to get: `hive lead`'s restart clears held_at/held_reason and re-points
// every lead-owned timer at the fresh pane, so this path runs again - and then
// loses the block key it burned while nobody was listening. The lead comes
// back and is told nothing about a worker that is still stuck.
//
// The second tick below is that restart, which is why this test is a SEQUENCE
// rather than an assertion that a dead pane yields null: a version that
// returns null AFTER claiming passes the first half and fails the second.
```

## line 1217

```
// owner != deliver_actor is what ownerPaneToTell requires before it
// resolves a pane at all, and it is the ordinary shape: a lead sets a
// wake on a worker's pane.
```

## line 1227

```
// `hive lead` restarting: the row is re-pointed at the fresh pane and
// the restart CAS clears held_at/held_reason.
```

## line 1239

```
// While the owner's pane is dead: held, but NOTHING claimed and nothing
// filed. The hold itself is unaffected - only who hears about it.
```

## line 1245

```
// After the restart: the same episode is reported, which is only possible
// because the claim above was never spent.
```
