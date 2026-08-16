# Attic: test/stall-report.test.mjs

Comments removed from `test/stall-report.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 7

```
// TODO 391, THE STALL DETECTOR. A worker whose turn dies mid-response has
// fired `prompt` and will never fire `stop`, so its row reads `working` (or
// `waiting`) forever and nothing pushes that to the lead. This file pins the
// store-and-clock half: the sampler, the claim, and every way the report is
// supposed to stay quiet.
//
// EVERY ASSERTION IS OVER A RECORD OF WHAT HAPPENED - `timers` rows and
// `wake_idle_notices` rows - never over a sample of `agents.agent_state`
// (test/CLAUDE.md, .claude/rules/worker-state.md). The notice IS a timers row,
// so COUNTING those rows across ticks is what makes the cursor testable: a
// detector with no cursor files one every three seconds forever, and one with
// a broken cursor files none at all, and only a count across ticks tells those
// apart.
//
// THE METHOD IS test/standing-watch.test.mjs's: drive tick() directly in a
// child process with a SYNTHETIC AliveSnapshot literal. Arm 1 touches no tmux
// at all by design, which is exactly why it can be tested this way and exactly
// why it still answers on a machine whose tmux probe is failing.
//
// THE TRANSCRIPT IS A REAL FILE WITH A REAL mtime, under a scratch
// CLAUDE_CONFIG_DIR. It has to be: the whole discriminating claim of this
// feature is that the transcript's mtime and the latch's age are DIFFERENT
// facts, and a fixture that fakes the sampler cannot fail in the direction
// that matters.
//
// ARM 2's two pane-dependent rows (a real screen with no dialog, and a real
// screen with one) live in test/stall-report-panes.test.mjs, which needs real
// tmux. What IS here is arm 2's third case - an unanswered probe - because
// "no fact" is reachable without a pane at all.
```

## line 49

```
// One project, one lead that owns the watch, and helpers to add crew. Rows are
// older than SETTLE_WINDOW so the janitor judges them rather than giving them
// spawn grace.
//
// THE LEAD'S PANE IS DELIBERATELY ABSENT FROM EVERY SNAPSHOT. A filed notice
// is a real due-now timer, so the NEXT tick tries to deliver it, and delivery
// is a tmux fork. A lead-owned wake whose pane is not live is HELD rather than
// cancelled or typed (deliverable()'s lead exemption), so these fixtures reach
// the code under test and stop short of typing at a terminal - the same
// arrangement test/standing-watch.test.mjs uses and for the same reason.
```

## line 132

```
// A fresh store AND a fresh CLAUDE_CONFIG_DIR per fixture, so one scenario's
// transcript files can never satisfy another's sampler.
```

## line 144

```
// Fifteen minutes is the bound; these sit either side of it with room to spare.
```

## line 149

```
// THE DISCRIMINATING TEST, and the reason this feature is not just "the
// latch is old". Both fixtures are IDENTICAL in `agents` and in
// agent_state_log - both `working`, both with the same ancient
// state_changed_at - and differ ONLY in the transcript file's mtime.
//
// F1 is what makes this the headline: measured against the live store, of
// four workers with an ancient `working` latch checked against their own
// transcripts, THREE WERE ALIVE AND WRITING. A detector keyed on latch age
// fires four times and is wrong three times.
```

## line 192

```
// A MISSING FILE IS NOT A SKIP: it means the turn died before its first
// transcript write, i.e. an API error at turn start, which is one of the two
// failures this feature was filed for. It reports with its own sentence,
// because a body that mis-describes its own evidence is a small lie in a
// lead's session.
```

## line 218

```
// THE SKIP LIST IS EXACTLY TWO. A bash worker fires no hooks and writes no
// transcript, so it must never be judged here - it would otherwise be named
// on every tick for the life of the row, with a remedy that cannot work.
// A row with no session_id has no transcript path to resolve at all.
```

## line 241

```
// ONE REPORT PER TURN. A worker nobody rescues is reported once, which is
// correct: nothing about the condition has changed. Only a count ACROSS
// TICKS can tell a working cursor from a missing one.
```

## line 262

```
// THE RE-ARM. A rescue is a real UserPromptSubmit, which stamps a new
// state_changed_at, so a stall in the NEXT turn is a new episode and speaks
// again. Without this the key would be permanent and a worker rescued and
// re-stalled would go unreported forever.
```

## line 292

```
// THE DELIVERY-FAILURE RE-ARM, and it matters more here than anywhere else
// this pattern ships: this key re-arms only on a NEW TURN, and a stalled
// worker has no new turn until someone rescues it - so a stall notice lost
// to a throwing sendText, or to a pane that dies before its first delivery,
// is lost FOREVER for that worker without this.
```

## line 324

```
// NOBODY TO TELL. The claim is spent either way, so filing at a pane nobody
// reads consumes the one report this episode was ever going to get - and
// because the key re-arms only on a new turn, that is PERMANENT rather than
// late. Resolving the target must therefore come BEFORE the claim.
```

## line 355

```
// ARM 1 NEEDS NOTHING TMUX CAN REFUSE, and that is why the call is not
// gated on a non-null snapshot the way the block half is. Under a
// persistently null snapshot - a foreign socket, an untrusted server/store
// pair, a tmux answering null on a timeout - arm 1 must still answer, on
// standingGoneRows' explicit precedent. Arm 2 must NOT: it reads a pane.
```

## line 385

```
// ARM 2 DOES NOT FIRE ON AN UNANSWERED PROBE. The row's pane is LIVE in the
// snapshot, so rowAlive says true and the probe is actually reached - and
// the probe cannot answer, because no such pane exists on any tmux server
// this fixture can reach. `null` is "no fact", never "no dialog": being
// wrong here means telling a lead that a worker sitting on a live dialog has
// a dead turn.
```

## line 408

```
// REPORT, NEVER A GATE. A wrong bound must cost a paragraph in a terminal
// and never a live worker: nothing is fired, held, cancelled or closed.
```

## line 437

```
// TWO REAL PROCESSES AGAINST ONE STORE. Every session runs its own scheduler,
// so an in-process guard is not a guard at all - and a same-process fixture
// passes even against one, which is why this spawns children.
//
// SAY EXACTLY WHAT THIS PROVES, BECAUSE IT IS LESS THAN ITS NAME SUGGESTS.
// The end-to-end property is real and worth pinning: two independent
// schedulers, one store, one stalled worker, ONE notice. What it does NOT
// isolate is the atomic claim, and that was MEASURED rather than assumed.
// `unreported()` is a cheap read-gate OUTSIDE the transaction, and it answers
// first: with claimEpisode mutated to always win (and still writing its row),
// this test stays GREEN, both with the children merely started together and
// with the wall-clock barrier below. The claim is a BACKSTOP behind the gate,
// reachable only in the microseconds between one instance's gate read and
// another's commit, and nothing available from outside the process forces that
// window open. The mutation this test's sibling rows DO die against is
// dropping the cursor gate itself.
//
// The barrier stays because it is strictly closer to the real hazard - both
// children are inside one tick of each other rather than merely "around the
// same time" - not because it was shown to be sufficient. Todo 391's spec
// (section 8) predicted `INSERT OR IGNORE -> INSERT OR REPLACE` would go red
// here and at "told once per episode"; it does not, for this same reason, and
// that measurement is recorded on the todo rather than written up as a pass.
```

## line 470

```
// The runner sets up the store, then starts two independent node processes
// that tick against it at the same instant.
```
