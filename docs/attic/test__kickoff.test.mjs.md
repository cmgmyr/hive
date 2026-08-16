# Attic: test/kickoff.test.mjs

Comments removed from `test/kickoff.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 9

```
// The hook and the CLI both start hive, which probes tmux; isolate first.
```

## line 13

```
// The SessionStart hook fires in every directory on the machine, so most of
// what it does is decline. Each gate is tested rejecting on its own, with
// --explain turning the silence into a readable reason.
```

## line 20

```
// -c commit.gpgsign=false: these scratch commits exist only to give the repo a
// branch to read. Inheriting the developer's signing config makes the suite
// fail whenever their signing agent is locked, which has nothing to do with
// what is under test.
```

## line 33

```
// Todo 323 audit. "heads WORKERS as unprobed, not confirmed" below used to
// assert `doesNotMatch(additionalContext, /gone/)` against the WHOLE digest.
// additionalContext interpolates the seeded worker's own cwd verbatim
// (src/kickoff.ts: `  ${a.name} [${describeForHuman(...)}] ${a.cwd}`), and
// that test's cwd is dirs.projectDir - a real mkdtempSync() path (see
// scratchDirs() in helpers.mjs) whose random six-character suffix is drawn
// from [0-9a-zA-Z]. That suffix can, in principle, spell "gone" as a
// substring, which the old bare pattern would misread as the real
// tmux-probe state the test means to rule out - the same shape as the -CC
// scratch-path flake in test/attach-mode.test.mjs, just far less likely
// (four specific letters, not two). Scoping the pattern to the bracketed
// state text right after the worker's own name removes the cwd from the
// haystack entirely, since the cwd is only ever printed AFTER the closing
// bracket.
// Counselors review (both seats, independently): the fixture below had two
// faithfulness bugs, neither of which broke the proof but both of which
// misrepresented the real render. mkdtempSync's random suffix is always
// exactly six characters (scratchDirs(), test/helpers.mjs), not seven
// ("abcgone" is seven). And this describe's own seeded row (kind='agent',
// command='claude', no state_changed_at) is reportsAgentStateLog()-true
// (src/stateProvenance.ts:306-308), so deriveProvenance takes the no-record
// branch, not not-instrumented: describeForHuman renders it as
// "unknown (no record)", never "unknown (not instrumented)" (that branch is
// for a non-claude command or non-agent kind, which this row is neither).
```

## line 86

```
// The hook runs on every session start everywhere; opening SQLite in
// every unrelated directory is the cost this gate order exists to avoid.
```

## line 108

```
// hive.yml is committed. A teammate without the profile it names gets
// silence, never an error.
```

## line 143

```
// Issue #27: `hive lead` now sets HIVE_AGENT_ID (lead:<id>) so the hook
// has an actor to write against, which makes check 1's OLD rule -
// "HIVE_AGENT_ID is set" means worker - true for a lead's own session for
// the first time. HIVE_LEAD is what tells the two apart; this is the
// regression the plan named as most likely to ship silently, so it is
// asserted on the RENDERED payload, not a boolean.
```

## line 161

```
// Issue #27's L4 fix round, DECISION 7a. The check used to be truthiness
// (`!process.env.HIVE_LEAD`), so HIVE_LEAD="0" - the one value a future
// caller would most plausibly write meaning false - read as truthy and let
// a worker past the gate that exists specifically to keep it from opening
// the store at all. The only test covering this check before now was the
// accepting HIVE_LEAD="1" case above; this is the rejecting one.
```

## line 198

```
// #15: this digest is the first thing a lead reads at cold boot, which is
// exactly when a closed lane's archived scaffolding must stay invisible.
// Archived and completed are independent axes, so an archived todo can
// still carry status 'open' or 'in_progress' - the case a naive
// status-only query would miss.
```

## line 223

```
// Counselors round on #15: kickoff's BLOCKED section prints only a
// count, never titles, so a title-absence assertion there is checking
// output the digest never produces regardless of whether the count is
// right. Capture the count BEFORE archiving the dependent, then assert
// it drops by exactly one after - the only assertion that actually
// discriminates a correct exclusion from a query that never applied it.
```

## line 248

```
// kickoff passes alive=null and never shells out to tmux (deliberately: it
// runs on every session start and has to stay cheap), so the WORKERS header
// must not read as a liveness check that already happened. Seeded with a
// raw insert rather than agent_spawn, since kickoff's WORKERS query is a
// plain SELECT with no tmux involved and this is the row shape it reads.
// Issue #156 (counselors, opus F7). The SessionStart digest is the ONE
// surface that requires nobody to remember anything, and a crew parked on
// Friday that goes unmentioned at 09:00 on Monday is the exact failure the
// issue was filed about, reached from inside the feature meant to end it.
// A parked row is CLOSED, so every other query in the digest is blind to it
// by construction.
```

## line 267

```
// A parked row and an ORDINARY closed row, so the assertion cannot pass
// by counting closed rows: only one of these is a paused lane.
```

## line 314

```
// The header's wording is not the only thing that has to stay true: if
// kickoff ever started passing a real tmux probe instead of alive=null,
// the header text alone would not catch it, since deriveProvenance's
// state stays a separate field from the string above it (counselors'
// T3). tmux_target '%1' names no real pane on this isolated server, so a
// real probe would render "gone" (src/stateProvenance.ts) - the seeded
// row is the discriminator this assertion needs to be able to fail.
//
// Scoped to the bracketed state text right after "seeded", not the
// whole digest: additionalContext also prints this worker's own cwd
// (dirs.projectDir, a real mkdtempSync() scratch path) immediately
// after the closing bracket, and that path's random suffix can in
// principle contain "gone" as a substring for a reason that has
// nothing to do with tmux-probe state. See "the 'gone' negative
// assertion itself" above.
```

## line 330

```
// Counselors review: the negative alone is coupled to a row shape
// nothing else here pins - it would go silently vacuous forever if
// kickoff.ts's WORKERS render ever gained a second space before the
// bracket (e.g. column-alignment, matching how `hive status` already
// pads its own worker rows, src/cli.ts). Pin the actual current render
// positively too, so a reformat is caught here rather than only by
// this describe's own header-only /seeded/ check above.
```

## line 340

```
// TODO 373, COUNSELORS F3, AND THIS IS THE SURFACE THAT DECIDED IT. Every
// other reader of "this worker has not been given anything yet" is chosen by
// a human: a wake, a dashboard, a status line. This block is INJECTED into a
// fresh lead's context at session start, right next to TRIAGE_MESSAGE
// telling that session to reconcile what it just read and propose lanes. So
// an unqualified "idle for 3m" here is not a display nit - it is a fact this
// surface manufactures for a model that has no way to check it.
```

## line 355

```
// The shape a real RESUME leaves (todo 387: a plain spawn no longer
// stamps resumed_at at all, so this shape is resume-only now):
// resumeAgent stamps resumed_at in its flip, the restore turn ends in a
// Stop hook, and nobody has re-briefed this worker yet.
```

## line 382

```
// The control, and it is what makes the assertion above able to fail: the
// old render for exactly this row is a bare idle with its stop event.
```

## line 387

```
// Issue #27, step 5: confirming rather than assuming that the WORKERS
// block's existing kind='agent' filter also excludes the lead's own row,
// now that the lead has one. Zero production code changes here - the
// filter was already there - this is the test that goes red if a future
// change widens it.
```

## line 418

```
// The WORKERS line prints the row's NAME, not its actor_id - asserting on
// actor_id here would pass even with kind='agent' dropped from the query,
// since nothing in the rendered line ever carries actor_id at all.
```

## line 443

```
// Truncation must not eat the sections that come after the board.
```

## line 453

```
// A profile that exists plus a key that does not parse: the kickoff fires
// and the warning has somewhere to land.
```

## line 497

```
// Registered without `hive init`, so the project has no board or runbook
// pad and the digest has nothing but the warning to report.
```

## line 510

```
// The gate that matters: no profile means silence, and silence is the one
// state where nothing else in the session would ever mention hive.yml.
```
