# Attic: test/agent-names.test.mjs

Comments removed from `test/agent-names.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 8

```
// Addressing a worker by name (issue #10): the schemas a lead reads, the
// resolution rules underneath them, and the name a spawned worker is given.
// The spawning parts need a private tmux server.
```

## line 14

```
// sessionName tags itself from HIVE_DATA_DIR, so the test process has to
// resolve the same store the server does to name the session it cleans up.
```

## line 27

```
// The fake claude below never draws a prompt box, so the readiness wait
// can only ever time out. Make it time out immediately instead of sitting
// out the full 45s default.
```

## line 43

```
// Pass "cat" when the test needs to see what hive typed into the pane: cat
// echoes it back into the rendered terminal.
```

## line 47

```
// The tools that take "which agent?" as an argument. agent_spawn names a new
// worker rather than resolving an existing one, and agent_list takes no ref.
```

## line 110

```
// Three running workers whose names overlap on purpose: "impl" is both an
// exact name and a substring of "impl-followup", which is what forces the
// precedence rule to be a rule rather than an accident.
```

## line 164

```
// One reader for "what is this target's window called", used by both window
// tests below. list-panes rather than display-message, matching what
// ownsItsWindow (src/spawn.ts) does and for its reason: display-message
// silently answers for some other target when the one it is given is dead.
```

## line 196

```
// The point of the whole rule: a lead reading agent:N in a pad written
// before the rename must still land on this worker.
```

## line 202

```
// The new name resolves, in full and in part; the old one is gone.
```

## line 225

```
// The new name is typed into the worker's terminal, where a newline
// submits everything after it as a turn of its own.
```

## line 237

```
// send-keys returns before the pane has rendered what cat echoed back, so
// poll rather than reading once: a single read is the CI-only flake.
```

## line 260

```
// Todo 371. Which window is hive's to retitle is answered by asking the
// window its own name (ownsItsWindow, src/spawn.ts) rather than by reading
// the KIND of id in tmux_target, which every row now records as a pane. The
// safe direction of that check is the half worth pinning: a miss must mean
// "leave the title alone", never "retitle anyway".
//
// A human renaming a worker's window is the reachable way to produce a miss
// (a project's shared window is the other, and the split cases above already
// cover it by never being retitled at all). Renaming the window by hand is
// also exactly the case the OLD check got wrong: it keyed on the id being a
// window id, which stayed true after a human renamed it, so hive overwrote a
// label it no longer owned.
```

## line 281

```
// The row is renamed either way - the window title is cosmetic and is the
// only thing this check gates. Asserted so a future reader cannot read the
// skip as "the rename did not happen".
```

## line 288

```
// Counselors, opus seat: the DANGEROUS direction for the commonest
// placement was pinned by nothing. Mutate ownsItsWindow's `=== expectedTitle`
// to `.startsWith(projectName)` and every split-placed rename would retitle
// the project's SHARED tab - the one holding the lead and every other worker
// - with the whole suite still green. The window-placed cases above cannot
// catch that: they assert the retitle HAPPENS.
```

## line 305

```
// The other half of the same finding, from the codex seat: a title alone can
// MATCH a window that is not the worker's. The reachable case is a human
// renaming the project's shared window to exactly the string hive would have
// given this worker's own window. The @hive-project-id stamp is what tells
// them apart, so this pins the stamp check rather than the name check.
```

## line 328

```
// Counselors round 2, fable seat: one mutation still survived the two
// controls above. Relaxing the name test from `===` to a prefix match keeps
// all of them green, because both shared-window cases are blocked by the
// STAMP rather than by the name. The window that only exact equality rules
// out is another WINDOW-PLACED WORKER's - hive-owned and unstamped like this
// worker's own, so the two stamps agree and the title is the only thing left
// that differs.
```

## line 342

```
// A human pulling one worker in beside another: a's pane now lives in b's
// window, so a's rename resolves to a window that is not a's.
```

## line 352

```
// The third of the three facts ownsItsWindow reads, and the one a mutation
// survived until this test existed: @hive-owned tells a window HIVE made
// from one a HUMAN made. A user's own window carrying this exact title is
// reachable with two tmux commands and is the case a name-plus-stamp check
// cannot see - both a user window and a worker's own window are unstamped.
```

## line 363

```
// A window the user made: hive stamps @hive-owned on every window it
// creates and on nothing else, so a plain new-window is the honest fixture.
```

## line 399

```
// Substring resolution is case-insensitive, so two names that differ only by
// case are not two distinct handles: every partial match would find both and
// report them as ambiguous. Uniqueness has to be judged the same way.
```

## line 457

```
// The destructive case. Close "lane" while "lane-two" runs, and a lead that
// types the full name "lane" must not have it silently resolve to its
// sibling: agent_close would kill the wrong pane and wake_set would plant a
// wake in the wrong terminal.
```

## line 492

```
// Close every running worker, not a tracked list: a case-pair test that
// fails does so by spawning the worker it expected to be refused, and that
// leak would then satisfy the next test for the wrong reason.
```

## line 506

```
// SQLite's NOCASE folds ASCII only; JavaScript's toLowerCase is
// Unicode-aware. If uniqueness and resolution use different engines, these
// pairs pass the uniqueness check and then collide at resolution, leaving
// two workers reachable only by agent_id. That is the exact state the
// uniqueness rule exists to prevent.
```

## line 536

```
// A name reaches a terminal: the pane announcement at spawn, and /rename on
// a live worker. `tmux send-keys -l` stops tmux interpreting key NAMES; it
// passes a raw control byte straight through to the TUI. Verified against
// tmux directly, outside this suite: send-keys -l -- with a literal 0x03 in
// the string interrupts a running foreground process. A control character
// in a name is a keystroke, not a label.
```

## line 551

```
// Nothing may have been typed, and the label must be untouched.
```

## line 554

```
// Todo 323 audit, corrected on counselors review: an EARLIER version of
// this comment anchored on the literal "/rename" agent_rename actually
// types, reasoning that "the slash is never part of" the pane's [hive]
// announcement (which embeds the project's scratch directory name,
// mkdtemp's random suffix under scratchDirs()). That reasoning was
// backwards - the announcement's cwd is a PATH, so it is full of
// slashes as separators - and the anchor traded away real coverage for
// no benefit: a future regression that changed sendText's call at
// src/tools/agents.ts:735 to omit the literal "/" would go undetected
// by the anchored pattern while still typing an unwanted keystroke.
// Reverted to the bare check. IMMUNE anyway, by the actual property:
// every generated segment in this pane's announcement (scratchDirs()'s
// two mkdtemp suffixes, six alphanumeric characters each) is preceded
// by a FIXED literal prefix ("hive-test-" or "project-"), never by a
// bare "/", so "rename" can only appear here as a full 6-character
// random suffix equal to that exact word - on mkdtemp's alphabet,
// ~2.7e-11 per suffix, well below the 1e-9 bar this project already
// accepts elsewhere (see the tmux-socket-foreign.test.mjs alias check).
```

## line 604

```
// Issue #27's L4 fix round, DECISION 7c. Before this guard, once no lead row
// was running (a fresh clone, or between a lead session ending and the next
// `hive lead`), a worker could take the name "lead" outright: the next `hive
// lead` would INSERT, hit SQLITE_CONSTRAINT_UNIQUE on idx_agents_running_name,
// and throw out of ensureLeadRow BEFORE ensureSession or attach - the lead
// does not start, and nothing about that failure names a worker as the cause.
```

## line 654

```
// requireNameFree reads, then launchAgent inserts, with nothing spanning
// the two. hive runs one server per session against one shared WAL store,
// so two leads spawning the same name can both pass the check and both
// insert. The app check cannot see that race; only the store can. This
// writes straight to SQLite to assert the constraint exists, rather than
// asserting the tool refuses.
```

## line 679

```
// Same rule the app applies: ASCII case folding is part of it.
```

## line 681

```
// A closed row by that name is not a conflict; only running rows are.
```

## line 700

```
// Two rows racing for the same running name, driven by a REAL constraint
// error rather than a stand-in: this is the path no single-caller test can
// reach (requireNameFree has already passed and another session's write
// landed in between), and going through agent_spawn would prove nothing,
// since requireNameFree would catch the planted row first and produce the
// same sentence by the other route. Factored out of two near-identical
// tests in /simplify review - they differed only in these three values and
// in what they asserted about asNameClash's output afterward.
```

## line 732

```
// Immune: on the clash branch, asNameClash (src/spawn.ts) returns a BRAND
// NEW Error built from a fixed template plus only the caller-supplied
// `name` ("raced", a hardcoded literal here, never SQLite's own error
// text) - raw's message is never read into the result. A future edit that
// started forwarding part of the original error (e.g. for debugging)
// would reintroduce exactly what this line checks for.
```

## line 740

```
// Anything else has to pass through untouched, or a real fault would be
// reported to a lead as a name collision it can do nothing about.
```

## line 746

```
// Issue #27's L4 fix round R6, todo 170 (counselors opus F7). "lead" is
// never a name a caller CHOSE - ensureLeadRow (src/cli.ts) is the only
// thing that ever names a row "lead" - so "pick another name" is advice
// the loser of a `hive lead` race cannot act on. Same driving shape as the
// test above, with name="lead" to hit the branch that changes the sentence.
```

## line 758

```
// Immune, same fact as the sibling test above: the LEAD_NAME branch
// returns a fully fixed string with no interpolation at all, so "pick
// another name" can only appear here if that branch's own wording
// regresses to include it.
```
