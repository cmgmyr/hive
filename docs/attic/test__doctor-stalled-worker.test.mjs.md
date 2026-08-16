# Attic: test/doctor-stalled-worker.test.mjs

Comments removed from `test/doctor-stalled-worker.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 18

```
// TODO 391, THE SECOND SURFACE. The push half (noteStalledCrew,
// src/scheduler.ts) reaches a lead that has ARMED A STANDING WATCH. This todo
// was filed from a report where the lead had every check it knew about
// running, and the machine that most needs the fact may have no watch at all -
// so `hive doctor` is a required half of the lane rather than a follow-up, as
// todo 391's own body proposed in terms.
//
// WHAT THIS FILE PINS:
//   1. IT FIRES, by name, with the sentence that says what hive OBSERVED - the
//      latch's age AND the transcript's silence, which are two different facts.
//   2. THE DISCRIMINATION IS THE TRANSCRIPT, NOT THE LATCH. A worker with an
//      equally ancient latch and a fresh transcript is working normally: of
//      four such workers checked against the live store, THREE WERE ALIVE.
//   3. BOTH ARMS. A `waiting` worker whose pane shows no dialog is reported;
//      one whose pane cannot be read is not. Narrowing this check to
//      `working` alone must fail here.
//   4. IT IS INFORMATION, NEVER A GATE. Plain warn(), so --strict does not
//      promote it (decisions/2026-08-07-strict-promotes-only-gating-warns.md).
// Plus the zero case, printed rather than silent, and the same two skips the
// push half has.
```

## line 43

```
// Claude Code relocates its whole state tree - transcripts included - when
// this is set, so hive resolves a worker's transcript under a directory this
// file owns rather than the developer's real ~/.claude.
```

## line 63

```
// The same convention test/doctor-unbriefed-worker.test.mjs uses: a path that
// cannot exist, so foreignSocket() answers true with no real server involved.
```

## line 70

```
// ONE REAL PANE FOR THE WHOLE FILE, and only arm 2 needs it: its evidence is a
// FRESH, DEFINITE `awaitingChoice === false`, which no synthetic fixture can
// supply. A bare session with one pane showing a captured idle screen is
// enough - no MCP server and no fake claude, because nothing here is about
// spawning.
```

## line 90

```
// created_at is left at its default (now) deliberately, exactly as the sibling
// file does: it keeps the row inside janitor()'s spawn-race guard, so doctor's
// own janitor call cannot close the row out from under the assertion. The
// latch age under test is an independent column.
```

## line 115

```
// The transcript Claude Code would have written, at a chosen age.
```

## line 150

```
// THE DISCRIMINATING CASE. Identical latch, different transcript. F1
// measured this against the live store: of four workers with an ancient
// `working` latch checked against their own transcripts, three were alive
// and writing. A check keyed on the latch fires four times and is wrong
// three times, which is a check a reader learns to skip.
```

## line 174

```
// A MISSING FILE IS NOT A SKIP: the turn died before its first transcript
// write, which is an API error at turn start and one of the two failures
// this feature was filed for. Its own sentence, because a report that
// mis-describes its own evidence is one a reader stops believing.
```

## line 192

```
// ARM 2 IN DOCTOR. Without this row, narrowing the check to
// `agent_state = 'working'` passes every other case in this file - and arm
// 2 covers the commonest death shape on a machine that actually prompts,
// since a turn that dies after a permission prompt is latched `waiting`.
```

## line 210

```
// AN UNANSWERED PROBE IS NO FACT, NEVER "no dialog". This row's pane id
// exists on no server this process can reach, so paneChoiceCheck answers
// null - and being wrong in the permissive direction means telling a
// reader that a worker sitting on a live dialog has a dead turn.
```

## line 226

```
// It is still COUNTED - the row is latched and past the bound, and the
// count is about the population this check looked at, not about what it
// could conclude.
```

## line 242

```
// THE SKIP LIST IS EXACTLY TWO, and it is the push half's. A bash worker
// fires no hooks and writes no transcript, so it would be named on every
// run for the life of the row with a remedy that cannot work; a row with
// no session_id has no transcript path to resolve at all.
```

## line 250

```
// The bash worker even has a stale transcript sitting exactly where hive
// would resolve one for it, so the gate is doing the work here.
```

## line 261

```
// THE FOREIGN-SOCKET RULE IS ARM 2'S, NOT THE POPULATION'S, and these two
// cases are a PAIR: one pins each direction, and either alone leaves the
// rule unpinned on the other side.
//
// THIS FILE ASSERTED THE OPPOSITE UNTIL THE PR GATE FOUND IT. The single
// case here seeded a `working` foreign-socket row and asserted doctor said
// NOTHING about it - pinning the defect rather than the behaviour, which is
// test/CLAUDE.md's "a test asserting the OLD behaviour" verbatim. The
// filter ran before the arm split, so a worker latched `working` on a
// socket this process cannot see into, with a transcript quiet past the
// bound, was reported by the standing watch and silently dropped by doctor
// - in the no-watch-armed population doctor is the half FOR.
```

## line 274

```
// ARM 1 MAKES NO CLAIM ABOUT A PANE. The evidence is the row's own latch
// and a statSync on a transcript path built from `cwd` and `session_id`,
// and neither of those becomes unreadable because the pane lives on
// another server. Foreign-socket conservatism is about not believing a
// PANE, so it has nothing to say here.
```

## line 290

```
// The control that keeps this honest about which report said what:
// doctor's stuck-row warn still fires for the same row, and it says a
// DIFFERENT thing - that liveness cannot be judged from here, never that
// the turn appears to have died. A reader acts on the two differently,
// which is why one cannot stand in for the other.
```

## line 299

```
// ARM 2's evidence IS a pane read, and this pane cannot be read from
// here at all: probing that pane id against THIS process's server would
// capture whatever stranger's pane happens to hold it (issue #73). So
// the refusal stays - it just belongs to this arm rather than to the
// whole population.
```

## line 315

```
// COUNTED, NOT CONCLUDED ABOUT, and this is the assertion that carries
// the pair. The row is latched and past the bound, so it is part of the
// population this check looked at - which is exactly what a
// population-wide filter destroys. Restoring that filter turns this 1
// into a 0 and takes the case above red at the same time, so the two
// together pin the rule in both directions. Proven by running that
// mutation.
```

## line 324

```
// SAY WHAT THIS DOES NOT PIN. The silence above is satisfied by TWO
// indistinguishable causes: arm 2's foreign-socket refusal, and a
// `paneChoiceCheck` that runs anyway and answers null because no such
// pane exists on this process's server. Deleting the refusal alone
// leaves this test green. That is test/CLAUDE.md's "an assertion
// satisfied by two indistinguishable causes", and it is recorded rather
// than papered over: separating them needs a live stranger's pane
// answering `false` under the foreign row's own id, which is the
// cross-server confusion issue #73 exists to prevent and not something
// this suite can stage. The COUNT above is the half that does
// discriminate, and it is why this case asserts it.
```

## line 338

```
// A DELTA ACROSS TWO RUNS, NOT AN EXIT CODE. Comparing exit codes proves
// nothing on a box already failing for an unrelated reason, and this
// suite's own environment carries a pre-existing gating warn
// (test/CLAUDE.md's "a saturated comparison").
```
