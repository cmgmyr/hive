# Attic: test/false-idle.test.mjs

Comments removed from `test/false-idle.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 17

```
// Issue #24. wake_when_idle fired while a worker was blocked on its own
// background subagents, because the Stop hook fires when the worker's TURN
// ends and hive recorded that as idle. A lead that trusts the signal verifies a
// half-finished branch.
//
// Two halves, and both are pinned here because only the pair is the fix. The
// hook now reads background_tasks out of the Stop payload, so idle means the
// work stopped rather than the turn stopped. The scheduler carries the watched
// panes into the wake body, so a future regression in that payload field is
// something a lead can see instead of something hive hides.
```

## line 33

```
// This file deletes rows between tests. Prove the store is scratch before
// opening it, not after.
```

## line 52

```
// Age clears the janitor's 15-second spawn-race guard, which is a separate
// protection that must keep working.
//
// state defaults to "idle", the state the #24 bug PRODUCED, so a test asserting
// "working" can only pass if the hook actually wrote it. It defaulted to
// "working" and the two flagship pins seeded rows with the value they went on
// to assert. That matters more here than it looks: hook.ts swallows every
// exception and always exits 0, by design, so an inert hook is indistinguishable
// from a working one unless the row starts somewhere else. A missing migration,
// a bad HIVE_AGENT_ID handoff or a failed db open would all have left those
// tests green.
```

## line 80

```
// What hive recorded, in order, rather than what the row happens to say now.
// The whole reason #24 survived its own fix and its own smoke test is that
// agents.agent_state is overwritten in place; asserting on a reading of it
// reproduces the blind spot rather than testing for it.
```

## line 90

```
// Runs the real hook binary the way Claude Code runs it: a separate process,
// the event as argv[2], the payload as JSON on stdin. Nothing here is stubbed,
// which matters because reading stdin at all is part of what changed.
```

## line 102

```
// The payloads below are the shapes captured from Claude Code 2.1.220, trimmed
// to the fields hive reads. The full captures are on todo 57.
```

## line 134

```
// The bug, exactly. Before this change the Stop hook wrote "idle" here and
// a lead's wake_when_idle fired on a lane with four review subagents still
// running.
// Seeded "idle" explicitly, not by default: this is THE regression pin for
// the whole branch and it should say out loud where it starts.
```

## line 152

```
// The other half. If this ever stops passing, wake_when_idle never fires
// at all and every wake rides to max_wait, which is a worse bug than the
// one being fixed.
```

## line 163

```
// Backgrounded Bash rides in the same array tagged type "shell". Counting
// the array's length instead of filtering by type would leave a worker
// running `npm run watch` permanently non-idle: unlike a subagent, a
// background shell need never end and never re-prompts its parent when it
// does.
```

## line 196

```
// The whitelist this replaced re-opened #24: status === "running" read
// every other value as not-in-flight, so a subagent that is launched but
// not yet started wrote idle and the lead woke on a lane with no subagent
// output at all. Seeded "idle" so "working" can only come from the hook.
```

## line 214

```
// The other side of the denylist. If this stops passing, wake_when_idle
// never fires and every wake rides to max_wait.
```

## line 226

```
// A Claude Code that stops sending background_tasks, or sends nothing at
// all, must land on the behaviour hive had before this change rather than
// on a crash or a stuck worker.
```

## line 243

```
// The Stop branch now reads stdin, and stdin is a one-shot read. A
// regression that drained it in the wrong branch would show up here.
//
// The third case this used to cover, an idle prompt writing "idle", moved
// to the notify describe below. It was pinning the bug.
```

## line 259

```
// Issue #24, the second door. The branch above was fixed and shipped as 2565164
// and the bug reproduced the same morning, because the idle that fired the wake
// was never written by the Stop hook at all. Claude Code emits a Notification
// sixty seconds after a Stop with no user input, hive matched its message text
// and wrote "idle", and a worker blocked on four live subagents was recorded
// finished. The captured payloads are on todo 61 comment 82.
//
// Every assertion here is over the SEQUENCE in agent_state_log, never over a
// reading of agents.agent_state. The original lane passed its smoke test by
// sampling two seconds late.
```

## line 272

```
// Verbatim from the capture, trimmed to the fields hive reads.
```

## line 286

```
// THE regression. Seeded "idle" so "working" can only come from the hook,
// then driven through the real sequence: a Stop with a subagent still
// running, then the sixty-second notification that used to undo it.
```

## line 310

```
// A branch that deliberately does nothing is invisible unless it says so.
// Both #24 lanes lost a day to not knowing which branch wrote an idle.
```

## line 326

```
// The half of this branch that was always right. If it stops working a lead
// loses the one signal that says a worker needs a human.
```

## line 337

```
// Statuses and vocabularies grow. "waiting" is not idle, so an unrecognised
// notification can cost a wake its promptness and can never fire one early.
```

## line 347

```
// An older Claude Code sends no notification_type. hive pins no version, so
// that payload is real, and its answer is inverted along with everything
// else: the idle prose decides nothing rather than deciding idle.
```

## line 362

```
// The wording is Claude Code's to change and the field is the contract. A
// reworded idle prompt must not be able to reach the "waiting" branch, and a
// permission prompt that happens to quote the old sentence must not be able
// to reach the no-op.
```

## line 381

```
// The failure mode of "do not downgrade a working state" is a state machine
// that can never leave it. This one has no memory to get stuck in: the
// notification writes nothing and the next Stop decides with the payload in
// hand, which is the same self-healing the stop branch rests on.
```

## line 403

```
// The wake body is delivered verbatim into a terminal as a user turn, and the
// tail is the one part of it hive did not author. tmux renders a pane to a
// screen, so capture-pane output is normally already clean, which is why this
// is pinned directly: nothing reachable through a real pane would notice if
// it stopped working.
//
// Control bytes are constructed, never written literally into this file.
```

## line 453

```
// Round 2, D5. watchedTail embeds a captured worker screen into a wake body
// that hive itself types into the LEAD's pane. A worker sitting on a real
// dialog carries "Esc to cancel" in its tail, so without masking it, hive
// would type its own detector's trigger into the lead's terminal, and
// deliver()'s cache invalidation guarantees the next timer re-reads it. D5
// mostly closes this already (the lead's pane also carries the input-box
// marker, so it no longer reads as a dialog either way), but the mask is
// cheap and does not depend on that holding: hive should not be able to
// trigger itself.
```

## line 475

```
// Todo 392 round 1, F5. CHOICE_DIALOG gained a second alternative (D3), and
// String.replace with a non-global regex stops after the FIRST match - so
// a tail carrying both markers used to leave the second one to reach the
// lead's pane verbatim, exactly the self-trigger this function exists to
// prevent. Two DIFFERENT alternatives, not the same one twice: that is
// what a non-global replace's blind spot actually is here (a repeated
// identical marker is also unmasked past the first, but two distinct
// matches makes the point without relying on a coincidence).
```

## line 500

```
// Todo 392 round 2 review, F4. The first version of the fix above built
// the replacement regex from CHOICE_DIALOG.source alone, silently
// dropping any flag CHOICE_DIALOG might carry (an `i` for case-drift,
// say) - "cannot drift" was true for the pattern text and false for
// flags. withGlobalFlag is the extracted unit that fix now goes through;
// CHOICE_DIALOG itself is module-private, so this is what a test can
// actually swap regexes on.
```

## line 516

```
// RegExp.flags re-serializes in the spec's canonical order (d g i m s
// u v y), not the order they were passed in - "g" sorts before "i".
```

## line 530

```
// The safety net half. The idle signal is correct now, but it rests on an
// undocumented Claude Code payload field; if that field is renamed hive goes
// quietly back to reporting a worker as finished while its subagents run. A
// lead holding only "Act now" has nothing to catch that with. Carrying the
// pane makes the regression visible instead of silent.
```

## line 537

```
// What the watched worker's screen shows: the real bug's own line.
```

## line 549

```
// The delivery pane runs cat, so whatever the scheduler types is captured
// as bytes rather than inferred from the store. A wake body asserted from
// the row it was built from proves nothing about what reached the terminal.
```

## line 564

```
// The delivery pane appends, so a test that does not start from empty can
// match the previous test's output and pass for the wrong reason.
```

## line 573

```
// created_at is REAL, not backdated, and every caller sets the wake BEFORE the
// transition it is waiting for. That is production ordering and it used to be
// inverted here: the timer was aged sixty seconds, so a transition that
// happened before the wake was set still satisfied
// `state_changed_at >= timer.created_at` and every test read as passing
// whichever way round it was written. Counselors found it by way of a feature
// whose whole failure mode was an agent that never transitions again, and no
// test in this file could see it.
//
// Note this is specific to idle_any, where created_at is part of the FIRING
// decision. The delay wakes below still age their rows, because there
// created_at only clears the janitor's spawn-race settle window and has no
// part in whether the timer fires.
```

## line 598

```
// max_wait_at already past: maybeFireIdle's timedOut branch sets ready=true
// unconditionally and never calls watchedStates() at all - the exact path
// counselors F2 named, since a foreign-socket watched agent can never
// satisfy the ordinary idle_any transition (watchedStates reads it as
// UNKNOWN, D2/D4/D6, which is neither "gone" nor "idle"). Timeout is the
// only door that ever reaches watchedTail() for one.
```

## line 616

```
// The transition idle_any is waiting for, written after the wake exists.
```

## line 624

```
// Wake first, then the transition: the order a lead actually produces.
```

## line 639

```
// The block used to be built as a sparse array whose leading blank line was
// eaten by the filter that dropped the optional "N more" entry, so the body
// ran straight into the header: "lane check--- what hive sees ---". Nothing
// asserted the separator, so nothing caught it.
```

## line 663

```
// Issue #38 step 1, fix round 1 (counselors, both seats). The first version
// of this reported ONLY describeLastLogEvent()'s fact, and that HID the
// exact stall the feature exists to show: a Notification hive reads as
// idle_prompt writes a fresh log row with the literal state 'unchanged'
// (src/hook.ts's stateForNotification) without moving the latch, so a
// worker stuck for 37 minutes that then emits one idle_prompt renders as
// "last log event: notify (0s ago)" - fresh-looking, no hint of the stall.
// #38's own incident is exactly that sequence (75|prompt|working, then
// 78|notify|unchanged 37 minutes later). The fix reports the latch's own
// age (agents.state_changed_at) ALONGSIDE the last log event, never one
// without the other: neither fact alone tells a stalled worker (old latch,
// fresh log - #28's shape too) from a healthy one (both fresh, moving
// together). Sets state_changed_at directly rather than through goIdle,
// since these tests need to control the LATCH's age independently of
// whichever log row happens to be last.
```

## line 682

```
// The exact shape from the issue: the latch set 40 minutes ago by a
// prompt, then silence except for one notify|unchanged moments ago. A
// reader must see the 40m latch age to catch the stall; a last-log-event
// fact reported alone would have hidden it, which is the defect this test
// pins.
```

## line 706

```
// The real magnitude, not just the shape: a regression rendering every
// latch as "1m" would still match \d+m alone.
```

## line 713

```
// The other arm of the same claim: nothing here infers "healthy" from a
// verdict hive computed. It is the plain consequence of the latch and the
// log moving together, in contrast with the stalled case above where they
// diverge by 40 minutes.
```

## line 736

```
// Counselors round 1: nothing exercised a null lastLogEvent() through
// watchedTail. A regression returning "" instead of describeLastLogEvent's
// "no record" for a null would have left every other test in this file
// green, since all of them seed a row.
```

## line 756

```
// reportsAgentStateLog's own gate (stateProvenance.ts), exercised through
// watchedTail rather than assumed: a kind='command' process (`hive.yml`,
// started by `hive start`) gets no HIVE_AGENT_ID and no --settings
// (src/spawn.ts), so it can never write a hook row or a log row either.
// That must read as silence, never as describeLastLogEvent's own "no
// record" - the wrong fact for a channel this row was never on. This
// fixture never calls describeLastLogEvent at all, unlike the other tests
// here; it pins the GATE, not the formatter, and stays green under a
// mutated formatter for exactly that reason.
```

## line 781

```
// Immune: delivered() only ever carries hive's own template text plus the
// worker name and wake body hard-coded in this file, and the watched
// pane's captured screen, which this describe's `before()` fills with a
// static printf'd MARKER, never a scratch path, pid, or session name. No
// generated identifier ever reaches this string, so a real regression
// (a kind='command' row growing a clause) is the only way this matches.
```

## line 795

```
// Counselors round 1, item 2 (shape 7 at a call site). Deleting the
// clause from the foreign-socket branch used to leave the whole suite
// green, because nothing seeded a log row for that branch's own test.
```

## line 818

```
// Round 2, both seats (P2). agent_close never touches state_changed_at
// (hook.ts:285 is the only writer), so a closed row's latch is frozen at
// whatever it read on its way out. The first version of this test
// ASSERTED the misleading output this fixes: a worker that entered
// 'working' an hour before it closed rendered "working for 1h" at read
// time, indistinguishable from one still running. deriveProvenance
// refuses this exact attribution (alive === false -> age_seconds: null)
// and stateNowClause must match it once status !== 'running'.
```

## line 844

```
// Immune: same reasoning as the "last log event" check above - delivered()
// carries only hive's template text, the worker name/wake body literals
// this file wrote, and a static captured screen, none of which is
// generated data that could spell out "working for" by coincidence.
```

## line 856

```
// Round 2, P1 (opus). The first version of this lane capped the WHOLE
// FORMATTED SENTENCE at 160 characters, which caps the wrong string: an
// attacker who pads the EVENT can push hive's own real "(Ns ago)" suffix
// past that cap and out of the rendered text entirely, with no
// truncation marker, forging a fresher-looking age with the true one
// simply gone. Constructed to look like a complete, fresh, genuine
// clause on its own before the padding is even considered.
```

## line 876

```
// The event is capped at 20 characters BEFORE formatting, so only 7 of
// the 200 padding spaces survive (13-character fakeClause + 7 = 20), and
// hive's own real age - 1h, read from the log row's own created_at, not
// the fake "0s" baked into the attacker's event - is appended right
// after the truncation marker, never pushed out of view the way capping
// the finished sentence would have let it.
```

## line 890

```
// Round 2, P1 (codex). A shape the padding test above does not cover: an
// event that itself CONTAINS hive's own wrapping phrase, attempting to
// render as two apparently genuine clauses side by side. The cap is
// chosen (src/tmux.ts's own comment) so a complete forged clause - the
// literal phrase plus a fake event and a fake age - cannot fit inside it
// at all, not merely look suspicious.
```

## line 921

```
// Counselors round 1, P1, both seats independently. agent_state_log's
// event column is process.argv[2] verbatim (src/hook.ts), with no
// validation: a worker with Bash can invoke the hook directly with any
// argv it likes, and this function's whole output is typed into the
// LEAD's pane next. An unsanitized ESC would terminate sendText's
// bracketed paste and deliver the remainder as keys; a bare newline would
// forge a second line inside hive's own vocabulary. Constructed, never
// written literally, matching the ESC/DEL fixtures earlier in this file.
```

## line 955

```
// Round 2 (opus). A null state_changed_at used to drop the "for Xm"
// clause with no trace at all, indistinguishable from a deliberate
// omission - exactly the broken-instrumentation case (agent_state
// defaults to 'unknown', state_changed_at has no default) where a lead
// most needs the line to say something. agentRow() never sets
// state_changed_at, so this fixture needs no extra setup to reach it.
```

## line 980

```
// Round 2 (opus). state_changed_at is written only by hook.ts's
// datetime('now') and should never be malformed in production, but this
// function's own contract is "every read is individually optional" - a
// garbage value here must degrade, not render garbage of its own.
// ageSecondsSince/humanizeAge never throw on a bad string (they return
// NaN via Math.max(0, NaN)), so Number.isFinite is the guard that
// actually saves this, not the try/catch around it.
```

## line 995

```
// Immune: delivered() carries no generated data (see the "last log
// event" note above), and the only numeric-looking substrings that ever
// land here are hive's own computed ages, which is exactly the value
// under test - there is no unrelated source of a literal "NaN".
```

## line 1007

```
// Counselors round 1 on #73, F2. watchedTail used to capturePane() any
// running row with no socket check at all, so a foreign-socket watched
// agent had its OWN pane id probed against THIS process's server instead -
// exactly what watchedPane stands in for here, a real, alive pane that only
// coincidentally shares an id with wherever the agent's row says it lives.
```

## line 1044

```
// The documented half of idle_any, and until now nothing exercised it: a
// worker that was ALREADY idle when the lead set the wake does not count,
// because the lead is waiting for the NEXT thing to finish, not for the
// state it could already see. The wake rides to max_wait instead.
//
// This is also the shape that hid a real bug: a watched agent that never
// transitions again can never satisfy an idle_any wake. That is correct for
// "idle", which a worker leaves and re-enters every turn. It is fatal for
// any state nothing writes back, which is why also_when_stuck was dropped.
```

## line 1055

```
// Strictly before the wake, since these timestamps have one-second
// granularity and `>=` is deliberate.
```

## line 1069

```
// The other side of the same pair, so neither ordering is covered only by
// accident. Same agent shape, same wake, only the ordering differs.
```

## line 1085

```
// tmux buffers are SERVER-GLOBAL, and sendText used a fixed name,
// "hive-input". Every claude session runs its own scheduler against one
// database, so two of them delivering in the same 3s window interleave as
// A set-buffer, B set-buffer, A paste-and-delete, B paste-fails. A types
// B's wake into its own lead, and B throws after its timer is already
// claimed, so B's wake is lost for good.
//
// The race predates this branch. The tail is what made it likely, by making
// every watched wake multiline and so pushing all of them onto this path.
//
// Staged deterministically rather than by racing: park a buffer under the
// OLD shared name and require sendText to leave it completely alone. The
// old code would overwrite it and then delete it with paste-buffer -d.
```

## line 1108

```
// A delay wake watches nothing, so there is no pane to report and no
// reason to make the lead pay for one.
```

## line 1125

```
// Matched against what the code actually emits. This asserted "what hive
// saw" while production emits "what hive sees", so a tail leaking onto
// plain delay wakes would have passed. Anchored on the stable half of the
// sentence rather than the whole thing.
// Both immune for the same reason as the checks above: a plain delay
// wake's delivered text is only ever "[hive wake #N] plain body" (all
// literals from this test), with no watched-pane tail and so no
// generated data of any kind to accidentally spell out either phrase.
```

## line 1138

```
// Todo 65. A wake fired, the store recorded it delivered, and the lead never
// saw it. The standing hypothesis was that a busy lead pane loses the message;
// it does not, which was established before this was written by driving a real
// claude session mid-turn and reading its transcript off disk. A pane sitting
// on a MODAL CHOICE loses it, and does something worse on the way: the paste
// has nowhere to go and is dropped, and the Enter that follows is read as
// "choose the highlighted option". Reproduced against claude 2.1.220, where it
// accepted a folder-trust prompt using the text of a wake-up.
//
// The screens here are printed by a shell rather than driven out of a real
// claude. What is under test is hive's decision not to type into a pane whose
// SCREEN shows a dialog, and a printf reproduces that screen exactly. The claude
// coupling is one regex, pinned separately below.
```

## line 1154

```
// The footer claude renders under a permission prompt, verbatim.
```

## line 1180

```
// Clears the dialog by replacing what the pane is RUNNING, keeping the pane
// id. A wake names a pane, so the second half of this has to be the same
// pane; a new one would prove nothing about the timer that was held. tmux
// wipes the screen on respawn, which is the state change under test.
```

## line 1207

```
// The regex is claude's chrome, so it gets its own assertion rather than
// being implied by the behaviour tests. If claude restyles its prompts this
// fails first and names the reason.
```

## line 1216

```
// A dead target is not a pane with no dialog on it. Reading a capture
// failure as "no dialog, go ahead" would be defensible for the scheduler,
// which has already probed liveness, but only because the scheduler decides
// that; the reader must not decide it here.
```

## line 1224

```
// Counselors finding 5, and a regression the /simplify pane cache
// introduced: deliveries within a tick are serial, so a later timer was
// judged against a screen read before the earlier ones typed into it. Wake
// #7 delivers, the session takes that turn and raises a permission prompt,
// wake #11 is delivered against the cached "no dialog" and its Enter answers
// it.
//
// Staged with a pane that raises a dialog the moment it is written to, which
// is what a claude session does when the turn it was just handed asks for
// permission. Both timers are due in the SAME tick, so the second one can
// only be held if the cache was invalidated by the first delivery.
//
// The dialog is raised on the PASTE, not on the Enter that follows it.
// Issue #55: raising it on a completed line (`read line`) made the test
// depend on an unforced race between this fixture's shell round-trip and
// the scheduler's fresh capture-pane for the second timer, with a ~2-3ms
// margin on a quiet machine (see todo 125's table) - enough to pass
// locally almost every time and lose under CI contention. Delivery
// (src/tmux.ts sendText) already waits ENTER_DELAY_MS between the paste
// and the Enter, so a fixture that reacts to the FIRST character of the
// paste has the dialog on screen for the rest of that gap before the
// Enter even lands, let alone before the second timer's capture. The
// ordering stops being a race and becomes a consequence of the real
// delivery timing - a 100x margin, not a happens-before, and asserted on
// below so a shrinking ENTER_DELAY_MS fails loudly here instead of
// quietly turning this back into a flake. The first character is
// consumed separately by the -n1 read, so it is reassembled with `rest`
// below rather than dropped.
```

## line 1263

```
// Explicit bash: the pane's default shell tracks $SHELL, which is not
// always bash (zsh has no `-n1` on its `read` builtin), and `read -n1`
// is exactly the mechanism the ordering depends on.
//
// `cat -u >> out` replaces the old `sleep 600`: it keeps the pane
// alive the same way, but if the cache-invalidation guard this test
// covers ever regresses and SECONDWAKE's Enter reaches this pane, it
// is appended to `out` instead of vanishing into a sleeping shell.
// Without this, the "must not have been typed" assertion below could
// never fail no matter how broken the guard was: the old fixture was
// parked in `sleep 600` reading nothing by the time a leaked delivery
// could arrive.
```

## line 1296

```
// This fixture now raises the dialog BEFORE writing `out` (the printf
// to `out` happens after the dialog printf), so the dialog wait above
// is no longer an accidental guarantee that `out` has been written.
// Poll for the content instead of reading once.
```

## line 1310

```
// Both halves in one test, because they are one claim about one timer: held
// rather than lost. Split in two, the first half alone would also pass under
// a guard that never delivers anything, which is its own silent loss.
```

## line 1327

```
// Issue #27. The hold itself must be legible even though the timer is
// otherwise untouched: deliverable()'s answer did not change, but a lead
// reading this row should see why it has not fired yet.
```
