# Attic: scripts/payload-canary.mjs

Comments removed from `scripts/payload-canary.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 2

```
// Issue #46 step 2: the live payload conformance canary (#32's half D).
// A sibling of scripts/part-c-gate.mjs, not a fork of it -- reuses its
// exported McpClient, gitSnapshot, workerAssignment and
// checkDataDirForResultRecording rather than re-deriving them. Brings up an
// isolated instance (scripts/isolated-hive.mjs), spawns ONE real claude
// worker, has it launch real background subagents so at least one Stop
// payload carries a non-empty background_tasks, reads every hook payload
// this run produced out of agent_state_log on the SCRATCH store, diffs each
// against the manifest step 1 (scripts/payload-shape.mjs) derives from the
// committed corpus (test/fixtures/hook-payloads/), reports, and tears down
// on every exit path including failure.
//
// Lives in scripts/, not test/: `npm test` must never run this. It costs
// real tokens, a network connection, and roughly the same few minutes
// part-c-gate.mjs takes. Run it by hand after any change to the corpus, to
// src/hook.ts, or when checking whether Claude Code itself has changed a
// hook payload's shape.
//
// WHAT IS COVERED BY `npm test` AND WHAT IS NOT: test/payload-shape.test.mjs
// pins the decision logic this script calls (deriveManifest, checkPayload)
// with mutated copies of committed fixtures -- fast, deterministic, no
// tokens. This file's OWN wiring -- bringing up a real instance, spawning a
// real worker, reading real agent_state_log rows, the run-level "did a Stop
// ever carry a non-empty background_tasks" check -- is exercised only by
// running it. A change here that breaks the wiring (a wrong column name, a
// mismatched actor id) is invisible to `npm test` and visible only in this
// script's own run, printed below.
//
// DOCUMENTED PRECONDITION (same one part-c-gate.mjs documents, and the same
// underlying cause): the spawned worker's Bash calls need an allow rule
// already in the DEVELOPER'S OWN ~/.claude/settings.json, because the
// worker's project root inherits trust from this checkout but not a
// pre-approved Bash permission of its own. Without one the worker hits a
// permission prompt on its first Bash call and the run hangs until
// RUN_TIMEOUT_MS. This script does not and will not solve that; set the
// allow rule by hand before running it.
//
// BLAST RADIUS: identical to part-c-gate.mjs's own, for the identical
// reason (see isolated-hive.mjs's header) -- the worker's project root sits
// inside this trusted checkout, so it has a live path back to the working
// tree via a plain `cd ..`. gitSnapshot(), reused from part-c-gate.mjs, is
// the actual enforcement: taken before the worker starts and again before
// teardown, so a dirtied tree is DETECTED, not merely hoped against.
//
// RECOVERY, if this process is killed hard enough that its own signal
// handler never runs: the isolated instance is left up. Tear it down with
//   node scripts/isolated-hive.mjs down --force
//
// WHERE THE RESULT LANDS: the STORE, not a delivered wake, for the same #27
// reason part-c-gate.mjs documents. recordResultInStore() below opens a
// SEPARATE connection to the REAL default store and kv_sets a compact
// summary under PAYLOAD_CANARY_RESULT_KV_KEY. Read it back with the hive
// kv_get tool, key "payload-canary:last-run", from any session in this
// project.
//
// SCOPE: SHAPE conformance only. This script asserts nothing about what
// state hive decides to write for any payload it reads -- that surface
// belongs to test/hook-replay.test.mjs, not here. NOT a scheduled job: the
// issue asks for one eventually; this lands hand-run, exactly like
// part-c-gate.mjs, and scheduling is a follow-up for someone to file later.
//
// THREE VERDICTS, THREE EXIT CODES, one `verdict` field in the kv record.
// This split exists because the completion signal this script waits on --
// the worker's IDLE WAKE -- fires when the worker's TURN ends, not when the
// worker has done the assignment. A run whose worker never launched the
// subagents still gets a clean idle wake, an empty background_tasks, and
// (if step 0 of the assignment never ran either) no confirmed MCP server --
// a run that answers nothing about payload shapes, not a passing one.
// Treating that the same as a real drift finding is worse than not running
// this at all: a canary that cries wolf gets ignored, and its next real
// finding gets ignored with it.
//   PASS (exit 0)          The run's preconditions held (server confirmed,
//                          wake fired, subagents demonstrably ran) and no
//                          shape or run-level finding fired.
//   FAIL (exit 1)          Either the working tree was dirtied (checked
//                          unconditionally -- a blast-radius breach matters
//                          whether or not the run was otherwise valid), or
//                          the preconditions held and something real fired:
//                          a shape FAILURE, or subagents demonstrably ran
//                          and background_tasks still never populated (the
//                          actual #24 detector, meaningful only once the
//                          precondition is established).
//   INCONCLUSIVE (exit 2)  A precondition didn't hold: the MCP server was
//                          never confirmed, the idle wake never fired, no
//                          subagent ever demonstrably ran, or the run threw
//                          outright. This run cannot support a judgement
//                          about payload shapes either way -- re-run it,
//                          it is a result about the HARNESS, not the corpus.
```

## line 106

```
// Duplicated from part-c-gate.mjs on purpose, not by oversight: it is a
// single filename literal, not logic, and workerAssignment() (imported,
// reused verbatim) already bakes this exact path into the prompt it hands
// the worker. Exporting a whole function from a file this lane does not own
// just to share one string is not worth the coupling.
```

## line 115

```
// One connection held for the whole poll, not reopened every tick: up to
// ~150 ticks over RUN_TIMEOUT_MS's 5 minutes, and a readonly connection has
// nothing to invalidate between reads of the same row.
```

## line 136

```
// event/state/created_at read alongside payload for the printed report;
// payload is the one src/hook.ts stores UNREDACTED, precisely so a reader
// like this one can read it back. Same open/query/close-in-finally shape as
// part-c-gate.mjs's own readRows; not shared with it because this lane's
// file ownership is "scripts/ (new files only)" (see installSignalHandlers'
// own comment below for the same boundary).
```

## line 153

```
// The manifest keys on hook_event_name ("Stop", "Notification",
// "UserPromptSubmit"), read from the payload JSON itself -- NOT the DB row's
// own `event` column, which src/hook.ts fills from the CLI arg it was
// invoked with ("stop", "prompt", "notify") and never renames to match. Row
// event is kept in the report for a human to cross-check, never used as the
// manifest lookup key.
```

## line 186

```
// THE RUN-LEVEL CHECK, and it is the highest-value one this script runs:
// this canary deliberately launches background subagents, so a run in
// which NO Stop payload ever carried a non-empty background_tasks means
// the array that used to populate has emptied -- the #24 shape exactly.
// The corpus alone cannot express this: it holds fixtures of both an
// empty and a non-empty Stop, with no notion of "this run's own
// subagents," so the check has to live here, next to the code that
// causes the subagents to exist.
```

## line 199

```
// Exit codes for the three verdicts evaluateRun can return; see the header
// for what each means to a human reading a run's output later.
```

## line 203

```
// THE ONE PLACE THE VERDICT IS DECIDED. Every value runCanary collects onto
// `partial` gets consumed here or nowhere -- a value gathered and never
// compared against anything is not evidence, it is decoration (the lessons
// pad's own run-5 note). Called exactly once; main() uses its `verdict` for
// the exit code AND recordResultInStore uses the SAME value for the kv
// record, so the durable result and the console result cannot disagree the
// way an independently re-derived overallPass in each place already had.
//
// PRIORITY, and it is deliberate, not incidental:
//   1. canaryError -> INCONCLUSIVE. The harness itself broke; nothing below
//      was necessarily even collected.
//   2. a dirtied working tree -> FAIL, unconditionally, ahead of the
//      precondition check. A blast-radius breach is real and dangerous
//      whether or not the run was otherwise valid to judge shapes from.
//   3. the three preconditions (server confirmed, wake fired, a subagent
//      demonstrably ran) -> INCONCLUSIVE if any fails. Below this point
//      shapeFailures/runLevelOk are NOT consulted: they describe a run
//      whose own premise -- that it exercised what this canary exists to
//      exercise -- did not hold, so they are not a verdict, only context
//      (still printed; see main()).
//   4. otherwise, a valid run: shapeFailures or a false runLevelOk -> FAIL.
//      Neither fired -> PASS.
```

## line 230

```
// part-c-assert.mjs's own assertWorkingTreeUnchanged compares BOTH head
// and status, and for good reason: a worker that COMMITS inside the
// checkout leaves `git status --porcelain` byte-identical while moving
// HEAD, so status alone passes on exactly the case blast-radius
// enforcement exists to catch.
```

## line 244

```
// part-c-assert.mjs's own assertWakeFiredAfterLastCompletion and its
// siblings treat a null fired_at as PROVES NOTHING, never a pass; mirrored
// here because this script, unlike that one, takes no sample history that
// could otherwise explain a cancellation.
```

## line 251

```
// The same check part-c-assert.mjs's assertWorkerUsedItsOwnMcpServer
// makes: confirms the worker actually called THIS branch's hive-iso
// server, not the machine's separately-installed one, which would
// silently verify the wrong build's payload shapes.
```

## line 258

```
// The precondition run 2 actually violated: an idle wake firing and an
// MCP server confirmation prove the worker's SESSION behaved, not that it
// did the assignment. A worker whose first turn ends without launching
// any subagent produces exactly this shape -- a clean idle wake, an empty
// background_tasks -- and reading that as "the array that used to
// populate has emptied" would be a false positive on the one check this
// whole issue is about.
```

## line 272

```
// Unreachable given the checks above (a valid run always produces an
// analysis), kept as a named failure rather than a silent PASS in case
// that invariant is ever wrong.
```

## line 277

```
// A fresh array, not a reuse of the git check's failReasons above: this
// point is only reached when that one was empty (it returned otherwise),
// but naming a new one keeps that fact from having to be re-derived by a
// future reader.
```

## line 286

```
// Only meaningful here, past the subagent precondition above: THE #24
// DETECTOR. Subagents demonstrably ran (completionFiles proved it) and
// no Stop payload ever showed them in background_tasks -- the array
// that used to populate has emptied.
```

## line 292

```
// parseFailures is deliberately NOT a reason here: a truncated payload
// (src/hook.ts's PAYLOAD_LIMIT, e.g. a huge pasted prompt) is a storage
// limit, not shape drift, and if EVERY Stop payload were unparseable
// stopCount would stay 0 and runLevelOk would already fail above -- the
// one case that would matter is already covered.
```

## line 301

```
// Duplicated from part-c-gate.mjs's own installSignalHandlers, on purpose:
// this lane's file ownership is "scripts/ (new files only)" (see the
// plan-issue-46 pad), so adding a fifth export to a file this lane does not
// own is out of scope here, the same reasoning mcpVerificationPath's own
// comment above already gives for its one-line duplication. This one is
// longer -- real control flow, not a literal -- but the alternative is
// broadening this lane's ownership to fix a cosmetic duplication, which
// costs more than the 15 lines it would save.
```

## line 356

```
// `ready` (renamed from `announced` by todo 387 fix round 1: agent_spawn
// no longer types anything, but still waits for the pane and still
// reports whether a dialog blocked it) is the same readiness/no-dialog
// signal this check always depended on.
```

## line 386

```
// The positive signal that subagents demonstrably RAN, independent of
// background_tasks: each subagent's own Bash command (see
// workerAssignment(), reused from part-c-gate.mjs) writes "<n>.completed"
// to this directory as its LAST action, so a file existing here proves a
// subagent actually executed, not merely that the worker claimed to
// launch one. Using background_tasks itself for this would be circular
// -- it is the exact signal the run-level check below is trying to
// judge.
```

## line 413

```
// verdict/reasons come from evaluateRun(), called exactly once in main() --
// never re-derived here. The kv record is the DURABLE half of this script's
// result (#27: a result that only arrives by keystroke can report a pass
// into a void), so it must read the identical verdict the console and the
// exit code used, not a second expression that happens to agree today.
```

## line 453

```
// (b) from the lead's review: the isolated instance is gone by the time a
// human reads this run's output, so anything not printed here is gone with
// it. The raw Stop payload text (unparsed -- exactly what src/hook.ts
// stored) and last_assistant_message are the two fields that would answer
// "did the worker actually do the assignment" in seconds instead of a
// re-run; everything else in a Stop payload is already covered by the
// shape findings printed above this.
```

## line 489

```
// Set on a teardown problem below, consumed only after the verdict's own
// exit code is assigned (near the end of this function) -- setting
// process.exitCode here would otherwise get silently overwritten the
// moment the verdict computation runs, which would let a PASS verdict
// mask a real leaked-state warning.
```

## line 531

```
// THE ONE VERDICT. See evaluateRun's own header: every value partial
// carries either feeds a reason here or was deleted for carrying none.
```

## line 545

```
// A failed store write must never downgrade a real FAIL/INCONCLUSIVE to
// PASS's exit code, but it also must not be silently absorbed into
// whatever verdict-derived code was already set -- so it forces the
// worst code rather than picking one.
```
