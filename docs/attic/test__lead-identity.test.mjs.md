# Attic: test/lead-identity.test.mjs

Comments removed from `test/lead-identity.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 10

```
// #27's acknowledgement half, wave 10 (plan-l4-lead-identity). Two things
// under test: `hive lead` giving the lead a real agents row (kind='lead')
// that survives a restart with the SAME actor id, and cmdLead passing
// --settings to a claude lead so its hook writes finally land somewhere.
```

## line 19

```
// ONE store for the whole file, queried directly and by every `hive lead`
// subprocess below. A second scratchDirs() call would open a SECOND sqlite
// file that the CLI subprocess never writes to, which reads exactly like the
// row this test looks for was never created.
```

## line 30

```
// Each test needs its own project (agents.name is unique per running project,
// and hive.yml lives at the project root), but they all share one store.
```

## line 39

```
// `sleep 600` so the pane survives long enough to be killed on purpose,
// rather than exiting and closing its own window before the test gets to it.
```

## line 68

```
// restart-lead.sh's job (scripts/restart-lead.sh): kill the lead's
// pane, then re-run `hive lead`. True of the script's code since its
// own step-2 fix; this simulates that sequence directly rather than
// shelling out to it.
// Backdated created_at past SETTLE_WINDOW first: a freshly inserted row
// is protected by the settle window regardless of kind, so without this
// the janitor() call below would have no discriminating power at all
// over DECISION 3's kind='lead' filter - it would pass on the settle
// window alone, the same fixture-too-small-to-reach-the-bound shape
// this project's suite has shipped before (test/CLAUDE.md, shape 6).
```

## line 81

```
// Issue #27's L4 fix round, DECISION 3. This is the janitor sweep that
// used to close a reused lead row in exactly this gap - a `hive status`
// or another session's own scheduler tick landing here was F1. Running
// it explicitly, between the two `hive lead` invocations, is what gives
// this test discriminating power over deployed behaviour: the previous
// version of this test never ran anything here, so it passed for a
// reason that had nothing to do with whether the janitor sweeps a lead.
```

## line 102

```
// DECISION 3's second half. A kind='lead' filter in THIS process's
// janitor cannot reach every OTHER already-running MCP server in the
// project, which keeps ticking its own pre-fix janitor until its
// session restarts - so identity has to survive the row actually being
// closed by one of them, not merely avoid it here. Simulated directly,
// since reproducing a second live pre-fix server is not practical in a
// test: whatever closed it, ensureLeadRow must still find it.
```

## line 115

```
// Not leadRow(): the closed row above and the fresh one this call
// inserts both match kind='lead' now, and leadRow() carries no status
// filter, so it would answer whichever SQLite happens to return first.
```

## line 131

```
// agent_rename now refuses a lead outright (DECISION 4), so this
// should be unreachable going forward; the point of DECISION 5 is
// defence in depth for exactly that "should be" - a row whose name
// drifted from "lead" some other way (a direct write, an older build)
// must not fool ensureLeadRow into treating it as absent and minting a
// SECOND identity under the still-free name.
//
// Not leadRow(): earlier tests in this describe block have already left
// a CLOSED kind='lead' row behind alongside the running one, and
// leadRow() carries no status filter (see the comment on the previous
// test), so it could just as easily pick the closed one here.
```

## line 149

```
// "boss", not "not-lead-anymore": the old fixture shared the substring
// "lead" with the real name, so a resolver that fell back to fuzzy
// matching could have found this row by NAME after all and made the
// test pass for the wrong reason. Sharing no substring means DECISION
// 5 (found by kind, not by name) is what a name-only lookup could not
// have gotten right by accident (counselors codex F5).
```

## line 171

```
// Issue #27's L4 fix round R6, todo 170 (counselors codex F5): this
// USED TO assert the drifted name was preserved, not corrected - true
// of the code at the time, but it meant a rename left behind by an
// already-running pre-41bbd77 server (agent_rename did not yet refuse
// a lead target) permanently stranded the canonical "lead" handle
// every wake, pad and todo comment addresses this row by. ensureLeadRow
// now resets the name on every reuse, the same "identity survives what
// another version did to the row" argument decision 2 already rests
// on for actor_id. Asserting the FIX now, not the bug it replaced.
```

## line 183

```
// The brief's "ALSO CHECK": the janitor's SECOND sweep, timers rather
// than agents. A lead's own pending wake is exactly as exposed to the
// momentarily-dead-pane restart gap as its agents row was, since
// wakes.ts's resolveDelivery stamps deliver_actor with the lead's own
// actor_id at wake_set time.
```

## line 207

```
// Same exposure, the other entry point: deliverable() has no
// SETTLE_WINDOW grace at all, so a wake becoming due in the exact gap
// would otherwise be cancelled outright on its very first delivery
// attempt, rather than just held for a tick until the restart lands a
// live pane. created_at is deliberately recent, so janitor()'s own sweep
// (run first, inside tick()) is settle-window-protected and cannot be
// what saves this timer - only deliverable()'s exemption can.
```

## line 233

```
// Counselors R2-A on this lane's own review: not cancelling is not
// enough on its own. Without a held_at/held_reason write, this row
// reads identically to one that simply is not due yet - typed_at,
// held_at and held_reason all NULL - which is the exact ambiguity
// held_at/held_reason exist to remove (#27's own motivating defect,
// one door over).
```

## line 244

```
// Issue #27's L4 fix round R8, todo 175 item 1 (counselors opus F2,
// MEDIUM). idx_agents_running_name is UNIQUE(project_id, name COLLATE
// NOCASE) WHERE status='running', and the reuse branch's name reset
// (todo 170) had no guard of its own against it - only the INSERT branch
// wrapped its own constraint hit in asNameClash. Reproduces this round's
// own premise directly: an already-running pre-41bbd77 server renames the
// lead row away from "lead" (freeing the name), and a pre-7c agent_spawn
// on that same old server takes it for a worker before this reset runs.
```

## line 281

```
// Immune: output can carry generated data (projectDir's mkdtemp
// suffix, actor ids, pane targets), but mkdtemp's random component is
// six characters, far short of either literal here - "SQLITE_CONSTRAINT"
// and "idx_agents_running_name" are 17+ characters including
// underscores, so no scratch path fragment can ever spell either out.
```

## line 287

```
// Issue #27's L4 fix round R9, todo 179 item 2 (codex F4). Was
// missing the /i flag: both candidate messages (src/spawn.ts's
// asNameClash and this file's own error) start with a capital
// "Another", so this assertion could never fail regardless of which
// message actually fired - unpinned in exactly the direction that
// matters, since a regression back to asNameClash's wrong-for-this-
// case message would have passed silently.
// Immune: a full English sentence with backticks: no combination of
// generated identifiers this suite produces (mkdtemp suffixes,
// autoincrement ids, pane numbers) can spell it out by coincidence.
```

## line 314

```
// Issue #27's L4 fix round R9, todo 179 item 2 (codex F4). The test
// above seeds the name-thief lowercase, which idx_agents_running_name's
// own COLLATE NOCASE happily collides against - but the holder lookup
// in asLeadNameReuseClash used plain `name = ?` with no collation, so a
// legacy worker named with different casing would trip the SAME
// constraint (the index does not care about case) while this function's
// own lookup missed it, falling back to "could not find which one"
// instead of naming the actual holder.
```

## line 355

```
// Immune: a fixed English phrase, longer than any random component
// (mkdtemp's six-character suffix) this suite's scratch paths carry.
```

## line 364

```
// Issue #27's L4 fix round R9, todo 178 (counselors opus F2, MEDIUM). The
// sibling case to STEP 1's own "reuses a closed lead row's actor id" test:
// that test kills the WINDOW along with the row's own close, so the pane
// really is dead and a fresh split is correct. Here the row is closed (by
// "another process", exactly what the CAS's own loser message advises a
// re-run after) while the pane is genuinely still alive - the case that
// used to leave the original pane running, untracked, still writing hook
// state under the actor id the new row just inherited.
```

## line 393

```
// Only the row is closed - the pane, window and session are
// untouched, standing in for the row being closed by something
// other than a real session ending (a pre-176 server, or the
// documented cross-server residual in agent_close's own retirement
// check per .claude/rules/tmux-and-panes.md).
```

## line 414

```
// The load-bearing assertion: exactly one pane in the lead's window,
// not two. A version of this fix that only fixed the actor_id
// bookkeeping (or seeded previousTarget without also seeding the
// new row's own tmux_target column, so the CAS never matches) would
// still leak a second, untracked claude here.
```

## line 439

```
// Issue #27's L4 fix round R8, todo 172 (counselors opus F4, MEDIUM). The
// previous version of this describe block ran raw `UPDATE ... WHERE
// tmux_target = ?` statements directly against the database and never
// called cmdLead at all: it pinned SQLite's own changes() semantics, which
// were never in doubt, using literals copied from production. Deleting
// `AND tmux_target = ?` from cli.ts's CAS left the suite green, and the
// loser branch (cli.ts's kill-pane-and-throw) had zero coverage of any
// kind, which is why the two holes below sat there unexamined.
//
// A true two-process concurrency test (two real `hive lead` invocations
// synchronized to race) was judged not worth the flakiness risk, and here
// that risk is concrete rather than hypothetical: this suite's CI runs on
// macOS, which does not give a freshly forked child scheduling priority
// the way Linux does, so racing a real spawned pane's own startup command
// against this process's next few lines of JS would not be deterministic
// here even if it might be on a Linux workstation. Forcing the loser
// branch with a database trigger instead reproduces the exact interleaving
// counselors reasoned through - something else changes this row between
// ensureLeadRow's read and cmdLead's own CAS write - with ordinary
// single-process, single-threaded ordering: the trigger fires inside
// ensureLeadRow's own reuse transaction (the `UPDATE agents SET command =
// ...` every restart performs), strictly before cmdLead's code reaches the
// CAS a few lines later.
//
// Issue #27's L4 fix round R9, todo 177 item 3 (counselors opus, checked
// against scheduler.ts and confirmed sound - keep this technique, do not
// churn it). What it does NOT establish, written down here rather than
// left implicit: a REAL racer that also read the pane as live would write
// the SAME value back, and both CASes would succeed with no loser at all.
// The loser branch is only reachable in production when the two processes
// genuinely DISAGREE about liveness - one gets targetLive() === true while
// the other gets null from an unreachable probe, or the pane dies in the
// gap between the two probes. The trigger below manufactures the POST
// STATE that disagreement would produce, not the disagreement itself, so
// reachability in production rests on that reasoning, not on anything
// these tests measure directly.
```

## line 496

```
// Stands in for a second `hive lead` recording its own fresh pane on
// this row in the gap between THIS run's read of previousTarget and
// its own CAS write - counselors opus's exact interleaving (P2 wins
// the race while P1 is mid-flight), forced deterministically rather
// than raced.
```

## line 511

```
// Reading the row still names the racer's value: the loser did not
// clobber the winner's write, only failed to record its own.
```

## line 518

```
// The bug this test exists to catch: leadPane === previousTarget in
// this branch, a pane this process only PROBED, not one it made.
```

## line 551

```
// closeAgentRow() leaves tmux_target unchanged when it closes a row
// (src/scheduler.ts) - reproduced here landing in the same gap as
// above: ensureLeadRow's read still sees status='running', then this
// row is closed by "another process" before cmdLead's own CAS runs.
```

## line 568

```
// Issue #27's L4 fix round R9, todo 179 item 2 (codex F4). A
// `status = 'closed'` assertion used to sit here and could never
// fail: this CAS's own UPDATE only ever touches tmux_target, never
// status, so it reads 'closed' whether the CAS won or lost. Tried
// replacing it with a tmux_target-unchanged check instead, and
// found that one is ALSO non-discriminating for this exact
// scenario before deciding to remove rather than keep it: this
// test's own row takes the stillThere/no-op-write branch (leadPane
// === previousTarget, both the live pane from the first call), so
// even a CAS with no status guard at all would write the SAME
// value back - SQLite counts that as a changed row regardless
// (the comment on wonRace's own transaction above says so).
// Verified directly: temporarily dropped the CAS's `AND status =
// 'running'` clause and confirmed by hand that tmux_target stays
// identical either way here. notEqual(second.code, 0) plus the
// "won the race" match above are the only two assertions in this
// test with real discriminating power; removed the rest rather
// than leave a check that looks meaningful and is not.
```

## line 594

```
// Issue #27's L4 fix round R9, todo 177 item 2 (counselors codex F3).
// Both tests above start from a LIVE EXISTING pane (leadPane ===
// previousTarget in both), so the loser branch's kill-pane call is never
// actually reached with createdPane=true in either one - replacing it
// with a constant no-op leaves both green. That is precisely the
// regression that would leak a loser's freshly launched claude process,
// and nothing above catches it.
```

## line 620

```
// Kills the whole SESSION, not just the pane, so the second `hive
// lead` finds no session at all and takes the claimInitialWindow
// branch (ensureSession returns true) - the branch that genuinely
// creates a pane, unlike STEP 1c's other two tests.
```

## line 636

```
// No live pane may remain recording this failed attempt - the
// session itself may also be gone (exit-empty, once its only
// pane is killed), which is fine; either way nothing may survive.
```

## line 658

```
// Issue #27's L4 fix round R10, todo 181 item 2 (BOTH SEATS, opus's
// fix). Before this fix, ensureLeadRow's fresh-INSERT branch seeded
// tmux_target with the closed row's OWN stale pane, so a running row
// advertised a pane from a previous tmux generation from the moment the
// INSERT committed - before anything on THIS invocation had confirmed
// it was still this lead's pane, or even still existed. A crash between
// that INSERT and the CAS a few lines later in cmdLead (ensureSession
// throwing, new-session failing) would leave the row running and
// naming that stale pane, which the CURRENT server generation may have
// already reissued to a completely different live agent - the "hive
// types into a stranger's pane" failure class #27 exists to remove.
//
// A trigger on the INSERT captures what the column was actually SEEDED
// with, independent of whatever the CAS later overwrites it with on a
// successful run - deterministic, not timing-dependent, the same
// technique this describe block's own hijack triggers use on UPDATE.
```

## line 689

```
// A closed lead row from a PREVIOUS generation, naming a pane that
// never existed on THIS server - exactly the shape ensureLeadRow's
// priorClosed lookup finds on a fresh `hive lead` after a reboot.
```

## line 714

```
// The golden path is unaffected: previousTarget (unchanged) still
// lets stillThere do its own job, and the row ends up with a real,
// live pane once the CAS runs against casExpected.
```

## line 735

```
// Issue #27's L4 fix round R6, todo 166 (counselors codex F1, verified by
// the lead against the code). deliver_pane is snapshotted once at
// wake_set time and nothing updated it before this fix, so a restart -
// which normally lands a genuinely different pane, not the exotic case -
// left every pending lead-owned wake naming a pane that no longer existed.
// Own project and session, not STEP 1's shared one: this test wants a
// clean before/after pane pair, not state several prior tests have already
// mutated.
```

## line 774

```
// Killing the WINDOW (as STEP 1's own restart test above does) would
// take the whole session, and therefore this scratch tmux SERVER,
// down with it - a server with no sessions left exits, and the next
// one to start renumbers panes from %0, which would make the "must
// be a genuinely different pane" assertion below pass by accident
// even if deliver_pane were never re-pointed. Split a second,
// throwaway pane into the lead's window directly (standing in for
// DECISION 2's split-worker scenario without spinning up a real
// one), so the window - and so the session and server - survive
// when only the lead's own pane is killed next.
```

## line 806

```
// Not just the column: fire it for real and read the delivery back
// off the actual pane's terminal, the way lead-pane-target.test.mjs
// proves delivery rather than trusting a receipt.
```

## line 842

```
// Immune, though result.stdout is exactly the risky shape from the
// attach-mode -CC bug (cli.ts's non-TTY attach() prints "Session ...
// for project ... (<scratch project path>)" here too): the fixed
// phrase "skipping hooks" cannot appear inside a bare mkdtemp path.
```
