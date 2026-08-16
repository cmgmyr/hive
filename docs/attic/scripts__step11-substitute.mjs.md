# Attic: scripts/step11-substitute.mjs

Comments removed from `scripts/step11-substitute.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 2

```
// Issue #27, L4 fix round, todo 164 (rewritten for R6/todo 168 - see FIXED
// AGAINST R6 below) - the substitute for step 11 of plan-l3-delivery-states.
// A real restarted lead needs the lead's OWN session to restart, which no
// worker running inside a worktree can do (it would mean killing and
// relaunching the very session running this script). This measures the
// lane's central claim end to end instead, against two REAL builds of the
// CLI and the hook, not fixtures: MAIN's dist (before issue #27's L4 lane)
// against THIS BRANCH's dist, over the identical sequence of real `hive
// lead` invocations, a real hook run, and a real wake.
//
// FIVE THINGS MEASURED:
//   1. MAIN's dist: zero agent_state_log rows for the lead, no kind='lead'
//      agents row at all - the mechanism this lane adds simply is not there.
//   2. THIS BRANCH's dist: both exist.
//   3. A janitor sweep (`hive status`) survives a lead row that is BOTH past
//      the settle window AND paneless - the two conditions the janitor's
//      agent sweep actually requires (src/scheduler.ts). A second `hive
//      lead` afterward reuses the SAME row and actor id.
//   4. DECISION 2's other half, exercised for the first time: a lead row
//      CLOSED by someone else (what an already-running pre-fix janitor in
//      another session would still do to it) still has its actor id
//      inherited by the next `hive lead`, under a NEW row.
//   5. The wake-88 pair: a real wake to the lead's own pane reads
//      "no_confirmation_channel" on main (hasChannel() in wakes.ts finds no
//      agents row for the actor at all) and flips through "unconfirmed" to
//      "confirmed" on this branch once a genuine `node hook.js prompt`
//      invocation - not a fixture insert - writes the confirming
//      agent_state_log row.
//
// Arms 1 and 2 are run concurrently and their measurements are DIFFED
// afterward (see diffArms below) rather than each merely asserting its own
// side - if they stop disagreeing, that is reported as its own failure, not
// silently absent from the output.
//
// FIXED AGAINST R6 (counselors opus F2, F8; codex F7), all three verified by
// the lead against scheduler.ts before dispatch:
//   - The old arm 3 could not fail: it swept a lead row that was both
//     seconds old and pointed at a live pane, so the settle window and the
//     live-pane check protected it regardless of whether the janitor's own
//     kind='lead' filter was even present. Fixed by manufacturing both
//     conditions on the row first (test/lead-identity.test.mjs's own
//     STEP 1 test does this correctly; this mirrors it), and PROVEN able to
//     fail: run once by hand against a temporarily reverted kind filter and
//     confirmed it goes red (see todo 168's comment on the record).
//   - The closed-row actor_id reuse (decision 2's other half, the half that
//     matters for an already-running pre-fix session) was never exercised
//     at all. Arm 4 below closes a row directly and proves the next `hive
//     lead` inherits its actor id under a fresh row.
//   - The header used to assert "arms 1 and 2 disagreed on every point
//     measured" without computing any such comparison; each arm only ever
//     asserted its own side. diffArms() now does the comparison for real.
//   - Both early-return paths left `session` unset, so teardown() was a
//     no-op and a scratch tmux server leaked a `sleep 600` process on a
//     private socket; fixed by resolving the session right after the first
//     `hive lead` call, before any check that can return early. Running the
//     arms via Promise.allSettled rather than Promise.all so one arm
//     throwing cannot end the process before the other arm's own finally
//     (and therefore its teardown) has run.
//
// FIXED AGAINST R8 (counselors opus F5), the second time this script has
// claimed a measurement it did not make:
//   - Nothing here read HIVE_AGENT_ID or HIVE_LEAD back out of the lead's
//     own pane; MiniMcpClient and the hook run were simply handed the DB
//     row's actor_id directly, so arm 2 would have passed with cmdLead's
//     entire env block (todo 167's own fix) deleted. fakeClaudeBin's script
//     now dumps both vars from its own real environment
//     (waitForPaneEnv/scratch.envMarker), and that measured value - not the
//     row - is what drives the MCP client and the hook run from here on.
//   - The arm1-vs-arm2 "agent_state_log has rows" disagreement was
//     manufactured, not measured: arm1 never invokes the hook at all and
//     arm2 does, by the script's own choice, so the two counts were never
//     evidence the mechanism differs. Dropped from diffArms(); each arm
//     still records its own honest, non-comparative claim about its count.
//
// FIXED AGAINST R9 (counselors codex F5). waitForPaneEnv waited only for
// the marker FILE to exist, not for its CONTENT to land: the shell's own
// `>` redirection truncates the file as part of setting up the subshell's
// stdout, strictly before either echo inside it has run, so this could
// read the file in that gap and report a missing HIVE_LEAD on otherwise-
// correct code. A false RED rather than a false green - still fixed,
// because a verification script that cries wolf gets ignored, and this one
// has already been wrong twice in the other direction. Now polls for the
// second (last) line specifically before reading.
//
// ISOLATION, all three axes, checked before anything else runs:
//   - env -u TMUX (this script never has TMUX set at all, since it is not
//     itself run from inside a hive-managed pane; guarded anyway).
//   - TMUX_TMPDIR is a directory that ALREADY EXISTS (tmux does not create
//     one named but missing, and silently falls back to the shared socket -
//     .claude/rules/tmux-and-panes.md).
//   - HIVE_DATA_DIR is a scratch directory per arm, never ~/.hive.
// Torn down with `kill-session -t`, never kill-server, never `list-panes -a`
// (test/CLAUDE.md).
//
// HOW TO GET MAIN'S DIST: this script refuses without one, named via
// HIVE_STEP11_MAIN_DIST. Build it once, anywhere outside this worktree:
//   git worktree add --detach /tmp/hive-main-worktree main
//   cd /tmp/hive-main-worktree && npm install && npm run build
//   HIVE_STEP11_MAIN_DIST=/tmp/hive-main-worktree/dist node scripts/step11-substitute.mjs
//
// Lives in scripts/, not test/: this is a one-shot measurement tool run by
// hand against an external prebuilt dist, not a fixture `npm test` can run
// unattended (test/CLAUDE.md's isolateTmux() pattern does not apply cleanly
// to orchestrating two separate dist builds' worth of child processes, and
// the point here is a live comparison, not a pinned regression).
```

## line 142

```
// ---- scratch env per arm --------------------------------------------------
```

## line 147

```
// TMUX_TMPDIR must ALREADY EXIST; tmux does not create it.
```

## line 154

```
// One fake claude binary per scratch env, written once and reused by every
// runCli() call against it - armsBranch() calls runCli several times, and
// the binary's content never changes between them.
//
// Issue #27's L4 fix round R8, todo 174 (counselors opus F5). Dumps the
// SPAWNED PANE PROCESS's own actual HIVE_AGENT_ID/HIVE_LEAD, not a value
// read some other way - the same ground-truth technique
// test/lead-data-dir.test.mjs uses for HIVE_DATA_DIR. Before this, nothing
// in the script read either var back out of a real pane: MiniMcpClient was
// simply handed the DB row's actor_id directly, so arm 2 would have passed
// with cmdLead's entire env block (todo 167's own fix) deleted. Overwritten
// on every restart; a caller that cares about a SPECIFIC pane's values must
// remove the file first (scratch.envMarker) and poll for its fresh
// reappearance, not trust a leftover from an earlier pane this scratch env
// already killed.
```

## line 185

```
// Waits for the marker fakeClaudeBin's script writes, then parses it into
// {HIVE_AGENT_ID, HIVE_LEAD}. Absent keys read as "" (unset), same as the
// shell's own unset-variable expansion that produced the line.
//
// Issue #27's L4 fix round R9, todo 179 item 3 (codex F5). Waiting only for
// EXISTENCE was racy: the shell's own `>` redirection truncates (creates)
// the file as part of setting up the subshell's stdout, strictly before
// either echo inside it has run, so this could read the file between
// truncation and the SECOND line landing and report a missing HIVE_LEAD on
// otherwise-correct code - a FALSE RED, not a false green, but a
// verification script that cries wolf gets ignored, and this one has
// already been wrong twice in the other direction. Poll for the second
// (last) line specifically, not just for the file to exist.
```

## line 216

```
// Strips every HIVE_* var first, not just TMUX/TMUX_PANE: this script itself
// may be running inside a hive-managed pane (it was, while developing it -
// HIVE_AGENT_ID and HIVE_PROJECT_LOCK survived into a spawned `hive lead`
// and made it refuse outright, pointing at a store this scratch run had
// never heard of). Same rule test/helpers.mjs's own baseEnv() applies for
// the identical reason.
```

## line 258

```
// Already gone.
```

## line 267

```
// Never started, or already gone.
```

## line 271

```
// ---- minimal MCP client, parameterised by dist (test/helpers.mjs's
// McpClient is hardcoded to this repo's own dist/index.js) -----------------
```

## line 346

```
// Polls wake_list until the named wake's row satisfies predicate, returning
// that row directly - not a boolean a caller then has to re-fetch the same
// row to use, which every call site here used to do as a second MCP round
// trip for data the polling loop had already just read.
```

## line 361

```
// The real session name, read from tmux itself rather than guessed:
// src/tmux.ts's sessionName() tags it with a hash of the data dir whenever
// the store is not the default (dataDirTag()), which every scratch run here
// always is, so "hive-<projectId>" is wrong for every arm this script runs.
// Exactly one session exists on this scratch server at this point (one
// `hive lead` has run), so the first (only) one is it.
```

## line 393

```
// The shape both arms report, diffed for real by diffArms() below rather
// than each side only ever asserting its own half.
```

## line 399

```
// ---- ARM 1: MAIN's dist, pre-fix ------------------------------------------
```

## line 419

```
// Own-arm claim, not fed into diffArms: this arm never invokes the
// hook (see todo 174's comment on arm2's own agent_state_log check
// below for why that pairing was manufactured, not measured).
```

## line 433

```
// No HIVE_AGENT_ID at all: on main, the lead's own MCP session never
// sets one (that mechanism does not exist yet), so currentActor()
// resolves to user:<login>, exactly like Chris's real session that
// measured wake 88.
```

## line 455

```
// ---- ARMS 2-4: THIS BRANCH's dist -----------------------------------------
// Arm 2: the row and its identity exist at all. Arm 3: a janitor sweep
// survives a row that is both past the settle window and paneless. Arm 4:
// identity survives the row being CLOSED by someone else. Then the wake-88
// pair's positive half.
```

## line 475

```
// Kept open for the rest of this arm rather than reopened per read:
// better-sqlite3 sees each writer's commit through the same handle under
// WAL, so a second connection buys nothing here.
```

## line 492

```
// ARM 3, R6 fix: the janitor's agent sweep requires BOTH created_at
// past SETTLE_WINDOW ('-15 seconds', src/scheduler.ts) AND a dead
// pane. A seconds-old row with a live sleep-600 fake claude - what the
// pre-R6 version of this arm gave it - is protected twice over
// regardless of the kind filter under test, which is why that arm
// could not fail. Manufacture both conditions directly on the row, the
// same way test/lead-identity.test.mjs's own STEP 1 test does.
```

## line 520

```
// ARM 4, missing entirely before R6: decision 2's OTHER half, and the
// half that matters for an already-running pre-fix session, which
// closes a reused row directly rather than merely letting its settle
// window lapse. Close it and kill its pane, the same shape
// test/lead-identity.test.mjs's second reuse test uses, then confirm
// the next `hive lead` mints a NEW row that inherits the OLD actor id.
```

## line 529

```
// Issue #27's L4 fix round R8, todo 174. Removed so the marker below
// can only be the THIRD pane's own write, never a stale leftover from
// the first or second `hive lead` call above.
```

## line 548

```
// Issue #27's L4 fix round R8, todo 174. Ground truth for what cmdLead's
// envFlags (todo 167) actually delivered into THIS pane, read back from
// the pane's own process rather than assumed from the DB row. Nothing
// else in this script read either var out of a real pane before this;
// MiniMcpClient below was simply handed the row's actor_id directly, so
// arm 2 would have passed with cmdLead's entire env block reverted.
```

## line 566

```
// Wake-88 pair, positive half. HIVE_AGENT_ID/HIVE_LEAD taken from the
// pane's own measured environment above, not the DB row directly: this
// is what makes the wake-confirmation chain below actually depend on
// cmdLead's env delivery, rather than merely on the agents table.
```

## line 585

```
// The genuine mechanism, not a fixture insert: a real `node hook.js
// prompt` invocation with a real UserPromptSubmit payload carrying this
// wake's own [hive wake #<id>] marker, exactly what Claude Code sends
// once the typed wake is submitted as a turn. Actor id from the measured
// pane env, same reasoning as the MCP client above: a real hook run
// inherits the pane's own environment, not a value fetched from the DB.
```

## line 608

```
// Issue #27's L4 fix round R8, todo 174 (counselors opus F5, second
// half). NOT fed into diffArms: arm1 never invokes the hook at all
// (record() is actor-generic, so main's hook given the same actor id
// would write a row too), while this arm just ran one by hand above. The
// two counts were never measuring the same thing - the prior "disagree"
// entry was the script computing its own manufactured disagreement, not
// observing a real one. This is an honest, non-comparative claim about
// this arm alone: the hook it just ran actually wrote the row it claims to.
```

## line 630

```
// Computes the comparison the header claims, instead of leaving each arm to
// assert only its own side. A field either arm could not measure (null) is
// reported as its own failure rather than silently treated as "disagreed".
```

## line 635

```
// Issue #27's L4 fix round R8, todo 174 (counselors opus F5). Dropped
// "agent_state_log has rows for the lead" from this list: arm1 never
// invokes the hook and arm2 does, by the script's own choice, so a
// disagreement here was never evidence the MECHANISM differs, only that
// the two arms were driven differently. Each arm still records its own
// honest, non-comparative claim about that count (see armMain and
// armsBranch above) - just not as a computed cross-arm disagreement.
```

## line 659

```
// Independent scratch envs (separate TMUX_TMPDIR, HIVE_DATA_DIR, project
// dir), so nothing stops running both arms concurrently - each spawns its
// own tmux server and MCP subprocess and only the shared `results` array is
// touched by both, always synchronously within one microtask.
//
// allSettled, not all: a throw from either arm must not end the process
// before the OTHER arm's own try/finally (and so its teardown) has run.
```
