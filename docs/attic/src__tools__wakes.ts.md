# Attic: src/tools/wakes.ts

Comments removed from `src/tools/wakes.ts` by todo 436, verbatim. Line numbers are
positions in the pre-strip file at fed8064.

## line 31

```
// Where a wake-up's body gets typed when it fires. Workers are deliverable via
// their tmux window; a lead session is deliverable when it runs inside tmux
// (the MCP server inherits TMUX_PANE from the pane that launched claude).
```

## line 48

```
// ORDER BY id DESC LIMIT 1, matching splitTargetWindow's identical shape
// (src/spawn.ts): two running rows sharing one actor_id should never
// happen, but a `.get()` with no ordering picks whichever SQLite returns
// first if it ever does, and the ordering costs nothing. One convention,
// not two - cross-referenced here and there.
```

## line 70

```
// Issue #27. A ONE-SHOT wake leaves pendingWakes() the moment it fires -
// ACTIVE_TIMER_WHERE excludes it on purpose (src/scheduler.ts), and widening
// that clause would change what the scheduler FIRES, not just what is
// reported (pinned by test/delivery-state.test.mjs). So "delivered,
// unconfirmed" has nowhere to appear without a second, separate section.
// This is that section: one-shot only (a repeating timer never leaves
// pendingWakes(), so it would only be a duplicate row here), most recent
// fired_at first, bounded by RECENTLY_FIRED_LIMIT so wake_list's output
// cannot grow without bound in a busy project ("write tools return slim
// receipts; token cost is a design input", CLAUDE.md).
```

## line 82

```
// Also bounded by LOG_RETENTION (the same window
// checkConfirmations, src/scheduler.ts, uses to decide what it can still
// confirm), and that second bound is not cosmetic. Past LOG_RETENTION, a
// typed one-shot's confirmed_at can never change again - hive has
// permanently stopped looking - but deliveryState() below still renders it
// as "unconfirmed", the identical string used for a wake typed eight seconds
// ago that hive is actively still watching. A quiet project would otherwise
// show a one-shot fired months ago under "recently" and report it as
// waiting on an ack it structurally cannot ever receive. Dropping those rows
// loses no information a lead could act on; it just stops the section lying
// about what "unconfirmed" means.
// `, id DESC` is a real tiebreaker, not decoration: fired_at
// is whole-second (src/scheduler.ts's datetime('now')) and a single tick
// fires every due timer in one loop, so a burst sharing one second is
// ordinary, not exotic. Without a tiebreak, ORDER BY carries no stability
// guarantee for equal keys, so which rows survive LIMIT can differ between
// two calls with no intervening write.
```

## line 110

```
// A wake's target has never written a hook row at all (the lead, until issue
// #27 lands) versus a target that writes hook rows but simply has not
// submitted one yet: an absent confirmed_at means one of those two very
// different things, and reporting only "not confirmed" for both is exactly
// the kind of small lie issue #27 exists to remove. Every spawned agent gets
// an agents row (running or closed) the moment it is spawned; the lead does
// not, today. Existence, not liveness - a closed worker's earlier prompt
// rows are still real evidence.
//
// Memoized per wake_list call, not globally: a repeating wake or several
// wakes to the same worker would otherwise repeat an identical lookup once
// per row across both sections below. Not worth a shared cache across calls
// - the whole answer depends on `agents`, which changes on every spawn.
```

## line 137

```
// Shared by both sections below so a wake's delivery state reads the same
// way wherever it appears. confirmation is deliberately a tri-state, now
// four, rather than boolean-plus-null: each value is an absent confirmed_at
// for a DIFFERENT reason, and collapsing any two back together would
// recreate the exact ambiguity this field exists to remove.
//
// Issue #75. unconfirmed_busy is that discipline applied to a third cause:
// typed_busy (src/scheduler.ts's deliver()) records that the target's last
// recorded hook state, AT THE MOMENT HIVE TYPED, was mid-turn. It is an
// OBSERVATION, not a prediction of whether this wake will go on to confirm.
//
// An earlier version of this comment claimed a busy delivery "can structurally
// never confirm", and was corrected. .claude/rules/tmux-and-panes.md:43 and
// this project's board disagree about exactly that - both claim verification -
// and this value does not need either one to be right (see deliver()'s own
// comment for the full argument). If a genuine prompt row DOES arrive later,
// confirmed_at is set exactly as it is for any other wake and this branch is
// never reached: the ternary below checks confirmed_at first. unconfirmed_busy
// only ever means "still unconfirmed, and the target's last recorded state at
// typing time was mid-turn" - nothing stronger.
//
// typed_busy === 0 or null (idle, or no hook row to ask at all) still
// reports plain "unconfirmed": that is the real alarm this tri-, now four-,
// state exists to keep legible, and a row written before this column existed
// has typed_busy NULL, so it reports exactly as it always did - no backfill
// needed, no behaviour change for history.
//
// NAMED RESIDUAL: typed_busy=1 can be STALE. A target latched into a stuck
// 'working' (issue #38, or a dropped API response) or a permanently stuck
// 'waiting' (issue #28, a permission prompt nobody ever answers - deliver()'s
// own comment puts 'waiting' in the same busy bucket as 'working') reports
// unconfirmed_busy, the quiet value, for what is actually the real alarm - a
// target that is not coming back. Not fixed here: this field must not grow a
// freshness bound (stateProvenance.ts's own docstring forbids exactly that
// inference). Issue #72 (merged f1b805b, shortly before this lane) is the
// compensating control - last_log_event plus its age is surfaced in
// agent_list, `hive status` and `hive doctor`, so a stale 'working' or
// 'waiting' row is visible through a channel built to show staleness, even
// though this field deliberately does not try. Reopen if unconfirmed_busy is
// ever the ONLY place a stuck target would have been visible.
// typed_seen names WHY a delivering row was judged
// safe to type - it does NOT make a held-then-delivered row distinguishable
// from a never-held one, not even combined with held_at/held_reason, since
// deliver() clears both unconditionally on every delivery regardless of this
// column (src/scheduler.ts's own DeliverableResult write site has the full
// argument; this comment's own first-shipped claim to
// the contrary was retracted). Passed through verbatim - NULL for
// a row this migration predates, or one still pending - rather than reshaped
// into a structured field, matching held_reason's own precedent one line
// above and the slim-receipt contract (.claude/rules/tool-contract.md): it is
// already a short fixed-vocabulary string, so a reader gets it exactly as
// deliverable() wrote it.
```

## line 206

```
// null (rather than "unconfirmed") when typed_at itself is unset: this
// is either a wake still pending delivery, or - for a fired one-shot in
// the recently-delivered section - a claim whose sendText never
// completed (issue #27's own motivating defect). Neither is "waiting on
// an ack", so forcing either into the confirmed/unconfirmed pair would
// hide the more urgent fact that nothing was ever typed at all.
//
// "NEVER COMPLETED" NARROWED LATER, and the narrowing matters to anyone
// diagnosing from this field. sendText is a paste and then a second tmux
// call for the Enter; on a pane where a stranded paste would HOLD later
// wakes (claude chrome on screen), src/scheduler.ts's deliver() now records
// typed_at the moment the PASTE lands, so a null here means specifically
// that the paste never reached the pane - not that some part of sendText
// failed. On every other pane the pre-lane reading still applies, because
// the record is still written after both calls return. Read this null as
// "nothing reached the pane" only once you know which of the two the target
// was.
```

## line 236

```
// cutToUnitBudget stops the cut from landing inside an astral
// character's surrogate pair, which used to be able to reach a wake body -
// delivered VERBATIM into a pane (worker-state.md) - as a lone surrogate
// half. No round-trip constraint on this output, so the ellipsis is not
// counted against the 120 bound - same as before this fix.
```

## line 244

```
// Issue #150. A wake body is delivered verbatim into a pane by sendText
// (worker-state.md: "Wake-up bodies are delivered verbatim"), so an
// unvalidated body is the identical text/keys breach agent_send.text guards
// against, one door over. Shared across every write path into `timers.body`
// - wake_set, wake_when_idle, and wake_update all reach the same column and
// the same deliver() -> sendText call, so all three need it, not only the
// tool issue #150 names; leaving any one unvalidated reopens the hole
// through a second door.
```

## line 265

```
// The five fields every wake carries regardless of which section it appears
// in, factored out so the callers below cannot drift apart on a field they
// are all supposed to report identically. truncate defaults to true for
// wake_list's two sections; wake_get passes false, since an untruncated body
// is its whole reason to exist.
// scope and parent_wake_id appear only when they are set, rather
// than as two nulls on every wake in every list: a standing watch and a
// notice it filed are both a small minority of rows, and "write tools return
// slim receipts; token cost is a design input" (.claude/rules/tool-contract.md)
// applies hardest to wake_list, which a lead calls repeatedly across a wave.
// A reader that sees `scope` knows this wake keeps watching; a reader that
// sees `parent_wake_id` knows this row was filed BY a watch rather than set
// by a human, which is otherwise indistinguishable from an ordinary wake.
```

## line 288

```
// Made by the lead on 2026-08-08 and RECORDED HERE AS A
// JUDGEMENT rather than left in a pad, because a number the code depends on
// must not live only in a comment thread. FOUR HOURS IS A GUESS, not a
// measurement, and it is the design's own proposal accepted as a default: it
// is roughly the length of the lanes this tool is actually run for, long
// enough that a lead does not have to think about it and short enough that a
// watch nobody cancelled stops typing into a pane the same day it was set. Do
// not read it as derived from anything. If it turns out wrong, the evidence
// is a real lane where a watch expired while its crew was still working, or
// one that outlived its lead by long enough to be a nuisance - and the fix is
// this constant, not a redesign.
```

## line 301

```
// A standing watch stores NO explicit list. Its membership is a query over
// the project's running kind='agent' rows, evaluated on every tick, which is
// the entire point: a worker spawned after the watch was set is watched
// without anyone re-declaring anything. Chris's own reason for choosing the
// crew over a named set is that his work pattern spins workers up and down
// mid-flight, so a named set re-introduces this todo's bug just later in the
// sequence.
//
// So `watch` keeps its '[]' default. What that buys is NOT mixed-version
// safety - see src/db.ts's migration for why that argument was false, and for
// the true reason kind stays 'idle_any'. What it does buy is real: deliver()
// calls watchedTail() unconditionally, and for a NON-empty list that runs
// capture-pane for up to three agents and embeds their screens in the body.
// An empty list is what keeps a compact roster from arriving as three worker
// terminals pasted into a lead's pane, plus three tmux forks per notice in the
// hottest loop hive has.
// THE WATCH AND ITS OWN STARTING CURSOR ARE ONE WRITE. seedGoneCursor records
// every worker already dead when this watch was set, which is what lets
// standingGoneRows drop its `closed_at >= created_at` bound entirely - both
// stamps are whole seconds, so that comparison reported a worker that died
// 0.9s before the watch and had no correct direction to be flipped to (see
// standingGoneRows in src/scheduler.ts). One transaction, because a worker
// that dies BETWEEN the INSERT and the seed would otherwise be written into
// the cursor as history and never reported at all - the failure this replaced
// the comparison to avoid.
//
// ONE STANDING WATCH PER (PROJECT, OWNER), refused rather than allowed. Two
// watches over one crew report every finish twice for four hours and leave two
// wake ids to find before the pasting stops, and the way a lead gets there is
// not exotic: calling again after a restart, or having forgotten. The refusal
// names the existing id so the answer is one call.
//   SCOPED TO THE OWNER, NOT THE PROJECT, and that boundary is deliberate.
//   Refusing project-wide would stop a SECOND LEAD from watching a crew it
//   shares, which is a cross-lead question this project records as
//   explicitly UNANSWERED - and this lane does not get to settle it
//   by picking a WHERE clause.
//   Not narrowed to (project, owner, deliver_actor) either, which would allow
//   one lead to watch its crew and have a reviewer told as well: a second
//   watch is a second full report and a second cursor, and a caller that wants
//   a different target can cancel and re-set with deliver_to. Refusing more is
//   the safer direction for a defect whose complaint is "nothing refuses".
// INSIDE THE TRANSACTION, so two concurrent calls cannot both read "none" and
// both insert. .immediate() takes SQLite's writer slot up front, which is what
// makes that check and the INSERT one decision.
```

## line 399

```
// The crew AS IT STANDS, names only: a lead needs to know what it just
// started watching, and a slim receipt cannot confirm what it does not echo
// (.claude/rules/tool-contract.md). Deliberately not the provenance block
// the one-shot returns - that is per-agent decoration for a fixed list,
// and this list is not fixed. It is a snapshot, not the watch's membership.
```

## line 483

```
// A single-value enum is the shape on purpose, not a
// placeholder: a watch is (owner, SCOPE, lifetime), and scope takes
// project / group / list (.claude/sessions/decisions/2026-08-08-
// watch-membership-is-a-parameter.md). Only the crew ships. Groups
// are blocked on agent labels, which do not exist - an agent has a
// name, a kind and a project, nothing to group by - and on an
// undecided overlap-dedup rule; list scope is what agents=[...]
// already is. Widening this enum is the extension, and a boolean
// `standing: true` here would have to be replaced by one.
```

## line 518

```
// The two shapes are refused LOUDLY rather than resolved by a
// precedence rule, because every way of resolving them silently is a
// wake that watches something other than what the caller asked for.
// A standing watch computes its membership on every tick, so an
// `agents` list passed alongside it would simply be ignored - the
// caller would read a receipt naming the workers it asked for and get
// a watch over a different set.
```

## line 545

```
// Issue #27. The lead's hook writes only
// its append-only log row, never agents.agent_state (worker-state.md,
// src/hook.ts's UPDATE is scoped to kind = 'agent') - so watchedStates
// (src/scheduler.ts) can never read a lead as idle, "idle" is false
// forever, and this would silently degrade to firing only at
// max_wait_seconds, reported as a timeout rather than the loud,
// immediate error a caller can actually act on. Refuse before the
// INSERT, not after: a scheduled wake that can only ever time out is
// worse than no wake at all.
```

## line 564

```
// One subprocess for every watched agent's liveness, not one per
// agent: the mode=all check below and the watching decoration
// further down both need it, and src/tmux.ts's own comment on
// liveTargets names this exact "many targets" shape as what it is
// for (agent_list's own snapshot uses the same pattern).
```

## line 572

```
// An agent tmux says is gone counts as nothing left to wait for. An
// agent tmux could not answer about does NOT: reading unknown as
// satisfied returns "Act now" while every worker is mid-task, and
// the lead proceeds on a completion that never happened.
```

## line 578

```
// Issue #156, AND THIS IS THE READER THAT LANE ALMOST MISSED.
// A worker's restore turn ends in a real Stop hook and writes a
// real, fresh idle for a turn nobody asked for (a spawn-side
// announcement turn briefly had the same shape too, later removed
// rather than leaving a second case for every
// reader here to keep in step with). This shortcut never reaches
// watchedStates (src/scheduler.ts), so without the same predicate
// a lead that resumes a crew and immediately sets a mode="all"
// wake is told "Every watched agent is already idle ... Act now"
// off that turn - verbatim the defect, through the one idle door
// the fix had not walked. src/firstPrompt.ts owns the definition
// and names every reader.
```

## line 621

```
// provenance is decoration only: it does not change what this call
// schedules or what already_satisfied above fired on (that stays a
// bare liveness + agent_state check, deliberately).
```

## line 625

```
// `state` replaces the sibling field below rather than duplicating
// it: deriveProvenance already applies the "gone" override when
// the snapshot says the pane is dead, so using it here (instead of
// the raw a.agent_state agentSummary would have shown "gone" for)
// keeps this surface consistent with agent_list for the exact
// same worker.
```

## line 669

```
// Todo 409. Deliberately NOT in deliveryState() (below), which also
// feeds wake_list's two arrays: the tool-contract rule's slim-
// receipt discipline is a per-row cost across every pending and
// recently-delivered wake in a project, and this is a diagnostic
// fact for the ONE wake a caller already named by id. held_at is
// "is this wake held right now"; this is "was it ever held this
// cycle, and since when" - a question wake_list's summary view has
// never answered and does not need to for every row to stay
// useful. No companion tick count: see holdTimer's own comment
// (src/scheduler.ts) for why a count here would be counting writes
// across concurrently-running server instances, not ticks.
```

## line 714

```
// due_at/repeat_every_ms only mean anything to a 'delay' wake.
// tick()'s candidates query (this file's own scheduler.ts) dispatches
// purely on kind: an idle_any/idle_all row goes to maybeFireIdle
// regardless of due_at, so writing due_at on one is a silent no-op -
// the exact "receipt says something happened when it did not" shape
// as the claimOneShot staleness this same PR already fixed, reached
// from a different direction. Worse for repeat_every_seconds:
// ACTIVE_TIMER_WHERE keeps a row with repeat_every_ms set active
// forever once fired_at is set, but an idle-kind candidate requires
// fired_at IS NULL (tick()'s WHERE), so once it fires once it can
// never be a candidate again - a permanently-pending wake that can
// never fire, visible in wake_list forever.
//
// #101. Scoped by the SAME predicate the
// final UPDATE below uses (id, project_id, owner, ACTIVE_TIMER_WHERE)
// - not project_id alone, which the first version of this check used.
// A wake's kind never changes after creation, so there is no
// staleness risk in checking it separately from the write; the
// reason to match predicates is failure SHAPE, not correctness.
// Scoping only by project_id meant "another actor's idle wake" or "a
// cancelled/fired idle wake" threw this kind-specific error instead
// of the plain updated: false every other kind of miss (wrong owner,
// not pending) already returns - two different failure shapes for
// what is, from the caller's side, the same class of "you can't
// touch this wake" miss. Matching the predicate means this throw is
// reachable only for a wake the caller could otherwise legitimately
// edit, so the helpful, kind-specific message survives for the one
// case a caller can actually act on; every other mismatch (including
// a foreign or non-pending idle wake) now falls through to the same
// updated: false the main UPDATE already returns for its own misses.
```

## line 761

```
// body: same free-text field wake_set already accepts from this same
// caller, typed into a terminal the identical way (deliver()'s prefix
// and sendText are unchanged by this lane) - no new untrusted surface,
// so nothing here needs the sanitize-the-field discipline that
// applies to a value hive itself derives, like describeLastLogEvent's
// event column (.claude/sessions/dead-ends/2026-08-02-capping-the-
// sentence-not-the-field.md). Matches wake_set exactly, which is why
// it reuses wake_set's own rejectUnsafeBody (issue #150) rather than
// a second definition: this writes the identical column through the
// identical delivery path, so a body clean at wake_set and dirty at
// wake_update would just be the guard reopened through its own edit
// door.
```

## line 778

```
// Changes the interval used from the NEXT firing onward only.
// due_at (the next fire time) is written solely by the scheduler's
// claim UPDATE (src/scheduler.ts's fireDelay), using repeat_every_ms
// read from the row AT THAT FIRING - so updating this column here
// never moves a due_at already set by the prior cycle. Verified
// against src/scheduler.ts directly, not assumed.
```

## line 788

```
// The only field that moves due_at, and it does so relative to now,
// matching wake_set (Chris's pre-decision) rather than the wake's
// original due_at.
```

## line 796

```
// Owner-scoped and pending-only, mirroring wake_cancel's own WHERE
// (owner = ?, cancelled_at IS NULL) - reusing ACTIVE_TIMER_WHERE
// rather than hand-writing a second pending predicate that could
// drift from pendingWakes()'s. A miss (wrong id, not yours, not
// pending) reads as updated: false, the same soft-failure shape
// wake_cancel already uses for the identical predicate shape.
//
// parent_timer_id IS NULL. A caller cannot SET parent_timer_id - no MCP
// tool declares it, and strictInput refuses an undeclared key - but
// that is a proof about ORIGIN, not about immutability once a row has
// one. A standing watch's owner also owns every notice it files
// (insertNotice writes the WATCH's own owner onto each), so without
// this exclusion that owner could wake_update a filed notice's body
// directly - and src/scheduler.ts's coalescing path and staleness
// trailer would then rewrite or append onto whatever the caller put
// there, corrupting the one kind of body this file promises is
// hive-rendered end to end (worker-state.md's verbatim-delivery
// invariant is the mirror claim, about a caller's OWN wake).
```

## line 839

```
// Issue #149. Owner-only used to mean literally unreachable for a wake
// whose owner is also its deliver_actor (the common case for a plain
// wake_set with no deliver_to) once that actor's own agents row is
// closed - no session can ever call currentActor() and get that
// actor_id back, since identity comes from the caller's own environment
// (HIVE_AGENT_ID), never something one session can assume on another's
// behalf. That is exactly the shape HELD_REASON_PANE_REISSUED_WORKER's
// remedy text points at: a worker's row gets reaped by the widened
// janitor sweep (src/scheduler.ts), and the hold's whole argument is
// that a lead ends up watching it in wake_list - so the lead needs the
// power to act on what it can already see. isRunningLeadActor is the
// same row-verified check agent_close's lead-target refusal uses, not a
// string prefix on HIVE_AGENT_ID (src/spawn.ts's own comment on why
// isLeadActorId alone is not enough). Ownership is still the only route
// for anyone who is not a running lead - this does not open
// cross-worker cancellation.
```

## line 869

```
// A standing watch files notices as separate timer rows, and
// before parent_timer_id existed they were ORPHANS: this UPDATE
// touches only the row it was given, so a notice filed ten seconds
// before the cancel still typed into the owner's pane afterwards. The
// scheduler carries the matching check at delivery (a notice whose
// parent is cancelled is cancelled rather than typed), and this is the
// other half of it - without this the row would stay in wake_list
// looking pending until a tick got round to it.
//
// Not owner-scoped a second time: the parent has already been proven
// to belong to this caller by the UPDATE above, and a notice carries
// its parent's owner by construction (insertNotice, src/scheduler.ts).
// Only runs when the parent was actually cancelled, so a miss - wrong
// id, not yours, already cancelled - takes the store's writer slot for
// nothing exactly as it did before.
```
