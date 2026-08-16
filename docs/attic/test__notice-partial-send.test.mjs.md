# Attic: test/notice-partial-send.test.mjs

Comments removed from `test/notice-partial-send.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 10

```
// TODO 386, reproduced from the live incident of 2026-08-13 rather than
// imagined. Standing watch 400 reported worker t384-n1 GONE twice, 62 seconds
// apart, for one episode, and the claim row that is supposed to make that
// impossible named only the SECOND notice.
//
// WHAT THE STORE ACTUALLY RECORDED, read out of ~/.hive/hive.db before any
// code was written (workflows/capture-before-fix.md): notice 412 had fired_at
// set and typed_at NULL, and agent_state_log row 4346 carried ONE user turn
// containing BOTH bodies, concatenated mid-line -
// "...wake_cancel(wake_id: 400).[hive wake #413] 1 worker(s)...". So 412's
// text WAS pasted into the lead's pane; only its Enter never arrived. It sat
// in the input box until the next notice's paste appended to it and that
// notice's Enter submitted both as one turn.
//
// sendText (src/tmux.ts) is a PASTE and then, ENTER_DELAY_MS later, a SECOND
// tmux call for the Enter. deliver() records typed_at only after both return.
// So a failure between them leaves the store saying "never typed" about text
// the reader can already see - and 60 seconds later rearmSpentEpisode
// (NOTICE_RETRY_AFTER) reads that as a lost delivery, deletes the claim,
// re-claims the episode and files the duplicate. The four rows on todo 386
// are that path's signature: the claim row is not overwritten, it is DELETED
// AND RE-INSERTED, which is why its notified_at moved with it.
//
// THE THREE CASES BELOW ARE THE SPLIT THE FIX HAS TO GET RIGHT, and two of
// them exist to keep the first honest: "no duplicate" is trivially satisfiable
// by a re-arm that has stopped working at all, so a delivery where NOTHING
// reached the pane must still be re-armed and reported again.
//
// THE PANE'S OWN CHROME IS A THIRD DIMENSION, added after counselors round 1
// raised it from both seats independently (codex P1#2, claude F7). The early
// record is taken ONLY where a stranded paste would HOLD later wakes, which
// needs claude's input box on screen; on a bash pane inputBoxState is null
// forever, holdsHumanInput is false, nothing holds, and the episode has to
// stay re-armable. So case A replays a real captured claude screen into its
// pane and case C is the identical failure against a plain shell. The first
// version of this file used a shell pane for case A, which is how it passed
// while proving nothing about the pane the incident actually happened on -
// test/CLAUDE.md's shape 7, an assertion satisfied by two indistinguishable
// causes, one dimension over.
//
// FIFTEEN CONCURRENT SCHEDULERS ARE NOT NEEDED and this file deliberately
// does not use them. One scheduler whose Enter fails produces every row the
// incident carried; the fifteen only supplied the tmux fork contention that
// made an Enter fail and the second, near-simultaneous notice for its text to
// merge into.
```

## line 64

```
// A fake tmux that fails ONE call shape and passes everything else through to
// the real one, the scaffold test/probe.test.mjs already uses. Failing the
// whole binary would prove nothing here: the entire point is that the paste
// SUCCEEDS and only the submit fails, so the paste has to really land in a
// real pane.
```

## line 91

```
// Two real panes, and the difference between them is the point. `shellPane`
// runs a plain shell: no claude chrome, so inputBoxState is null and a
// stranded paste holds nothing. `claudePane` replays a real captured idle
// claude screen, byte for byte, the way test/typing-guards.test.mjs replays
// its fixtures - so inputBoxState finds a box, classifies it, and a stranded
// paste there would read `pending` and hold every later wake. Both take a real
// paste and both are read back with capture-pane, which is the only evidence
// separating "the text reached the reader" from "nothing was delivered".
```

## line 104

```
// 220 columns because every fixture in that directory was captured at 220 and
// replaying one into a narrower pane wraps its borders - the defect todo 399
// found by running at 80 (.claude/rules/tmux-and-panes.md, "A WRAPPED BORDER
// IS ONE EDGE"). A wrapped border means no box, which would make case A pass
// for exactly the wrong reason.
```

## line 121

```
// The fixture has to be on screen before any test reads the box, or the
// pane is still blank and reads as no-box - a race that would silently turn
// case A back into case C.
```

## line 137

```
// Every scenario gets its own project, watch and worker, so one case's cursor
// rows can never satisfy another's assertions.
```

## line 149

```
// A worker that DIED: closed, frozen mid-work, never parked. That is
// standingGoneRows' own population.
```

## line 185

```
// Anchored to the REPORTED block's two-space indent and to GONE specifically.
// A bare /name/ also matches the "Still going:" roster, which names every
// worker that is merely alive
// (common-issues/a-bare-name-matcher-also-matches-the-still-going-roster.md).
```

## line 194

```
// A declaration rather than a const: before() reads it, and this file's
// helpers sit below the hooks.
```

## line 200

```
// The one thing this file simulates rather than waits for. NOTICE_RETRY_AFTER
// is 60 real seconds and the re-arm reads fired_at, so moving fired_at back is
// exactly equivalent to waiting - and it is the only value moved.
```

## line 210

```
// Tick 1 files the notice. Tick 2 delivers it, with the submit broken.
```

## line 224

```
// Counselors round 1, claude F3: without this the test passes for the
// wrong reason. A mutation that breaks the RE-ARM rather than the RECORD
// also produces one notice, and the two are only told apart by the column
// this lane actually changed.
```

## line 234

```
// The incident's 62 seconds, without waiting them out.
```

## line 254

```
// CONTROL 1. Without this, "no duplicate" is satisfied just as well by a
// re-arm that has stopped working, which would silently lose every finish
// whose delivery genuinely failed - the case NOTICE_RETRY_AFTER exists for.
```

## line 284

```
// CONTROL 2, and the one that pins the split itself (counselors round 1,
// codex P1#2 and claude F7). Identical failure to case A - the paste
// lands, the Enter fails - against a plain shell. There is no claude
// chrome, so inputBoxState is null, holdsHumanInput is false, and nothing
// will hold behind the stranded text. The whole argument for recording it
// as delivered is absent, so the episode must stay re-armable and the
// duplicate here is the CORRECT outcome.
```
