# Attic: test/typing-guards.test.mjs

Comments removed from `test/typing-guards.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 7

```
// Todo 70 / issue #27. The #24 lane guarded exactly one typing path, the
// scheduler's own wake delivery. Two more still typed into whatever was on
// screen: agent_send's text path and agent_rename's /rename (a third, the
// spawn announcement, existed until todo 387 removed it - agent_spawn types
// nothing into a fresh pane anymore, so there is nothing left to guard there,
// though it still WAITS for the pane first; see agent_spawn's own comment on
// PANE_READY_MS for why the wait outlived the typing it was added for).
// Decisions D1-D3, D5 on plan-issue-27-guard govern this file (D5 superseded
// D4 in round 2: see src/tmux.ts next to CHOICE_DIALOG).
```

## line 26

```
// Round 2, D5. A dialog is CHOICE_DIALOG present AND the input-box marker
// ABSENT, not CHOICE_DIALOG alone: a modal replaces claude's input affordance
// rather than sitting beside it. This screen carries BOTH markers at once,
// which is exactly the case D4 could not tell apart from a real dialog and
// D5 exists to fix -- a worker whose own transcript contains the literal text
// "Esc to cancel" (it grepped for the string, or opened
// test/fixtures/panes/folder-trust-dialog.txt) while its input box is still
// on screen. Under D4 this refused forever, with no dialog to ever clear:
// agent_send would tell the lead to clear a prompt that does not exist, and
// every wake targeting that pane would hold for as long as the screen sat
// still. Under D5 it types, because there is somewhere for the paste to go.
// Claude itself has never been observed rendering both markers on one real
// screen, so this stays synthetic the same way test/false-idle.test.mjs pins
// the scheduler's own guard with a printf: what is under test is hive's
// decision, not claude's chrome. The two halves of the pair are each pinned
// separately, against real captures, in test/pane-fixtures.test.mjs.
//
// TODO 399 HAD TO REBUILD THIS SCREEN, AND THE REASON IS THE FINDING. It
// used to be five lines: the literal string "shift+tab to cycle", then a
// dialog's options and "Esc to cancel". That satisfied D5 only because
// "shift+tab to cycle" was itself an INPUT_BOX_PRESENT alternative - so the
// screen proved hive's decision by ACCIDENT, on a shell pane with no input
// box anywhere on it. That accident is the `╰` bug's own shape (a substring
// standing in for a box) pointed the other way, and the box anchor removes
// it: a bare shell printf now correctly reads as having no box, which for a
// NON-claude pane is the fail-closed degeneration this file already records.
//
// So the screen now carries what it always claimed to: a real input box -
// top rule, `❯`+NBSP prompt row, closing rule, a status line and the mode
// footer, in claude's own layout - with the grepped dialog text sitting in
// the SCROLLBACK above it. That is the case D5 is actually about (a worker
// that grepped for the string while its own box is still on screen), and it
// is the same case whether the predicate under it is a footer substring or
// the box's own borders.
```

## line 72

```
// agent_spawn still waits for the pane before returning (fix round 1,
// finding 1 restored it - typing is gone, the wait is not). A dialog
// fixture never shows claude's input-box marker, so agent_spawn's wait
// pays its FULL ceiling on every dialog spawn below; at the production
// default (45s) that alone would blow past McpClient's own 15s call
// timeout. 2000ms is cheap for the ordinary case (a ready fixture is
// detected within ~1s) and short enough that dialog spawns fail fast
// rather than timing out the client - none of the tests below assert
// `ready`, so the exact ceiling only affects how long a dialog case takes,
// not what it proves. spawnShowing's own poll (below) is the belt to this
// suspenders: it does not depend on agent_spawn's wait succeeding, only on
// the fixture having rendered by the time IT checks.
```

## line 88

```
// Round 2, todo 75. This comment has been wrong twice (width, then the
// wrong specifics on the right axis), so what follows is MEASURED, not
// reasoned: replayed each fixture into real panes across a range of
// heights at a fixed 220 columns, and read the actual production
// paneChoiceCheck's answer back (script output kept on the todo, not here).
//
// Only folder-trust-dialog.txt is height-sensitive. Its footer is on line
// 16 of 50; ready-idle.txt, busy-mid-turn.txt and model-picker-dialog.txt
// all carry their marker on line 50, the LAST printed line, so they read
// correctly at every height tested (10 through 50) -- generalising from the
// trust fixture to "each fixture" was the previous version's mistake.
// Measured thresholds for the trust fixture, capturePane(target, N):
//   N=18 (tailCaptureLines(), what paneChoiceCheck and paneAwaitingChoice
//     use since todo 72/74): false at pane height <= 17, true at >= 18.
//   N=12 (paneAwaitingChoice's window before todo 72): false at <= 23,
//     true at >= 24.
// The direction: a NARROWER capture window needs a TALLER pane, because
// capture-pane -S -N counts back N lines from wherever the pane's own
// history currently ends, and a shorter pane pushes that end further down
// (more blank lines printed below the footer before the prompt returns),
// so a narrower N has to reach further to find the same footer. This is
// why round 2 step 2 keeping the window at 18 rather than reverting to 12
// was a live coupling, not just a style choice: reverting would have
// raised the threshold this file depends on from 18 to 24.
//
// None of this is a production hazard: a real claude renders its dialog to
// fit whatever pane it actually has, footer at the bottom, and has never
// been observed with it scrolled off. It is an artifact of REPLAYING a
// fixed 50-line capture into a pane shorter than that.
//
// Enforced, not just described: every worker below spawns with placement
// "window" (see spawnShowing), so each gets this session's own dimensions
// as its own tmux window rather than a pane tiled down by its siblings.
// Margin under the old tiled "split" placement was one or two rows at this
// describe's peak worker count, so the very next spawn added to any
// describe here would have silently dropped below 18 with nothing pointing
// at geometry; window placement removes the shrink path entirely rather
// than asserting around it.
```

## line 137

```
// Each command replays a fixture (or a synthetic screen) byte-for-byte via
// cat/printf, then sleeps so the pane stays put for capture-pane to read.
```

## line 144

```
// placement: "window" gives every worker here its own tmux window rather
// than a pane tiled into a shared one, so a describe spawning many workers
// cannot shrink any of them below the session's own size (see the geometry
// comment above the session's own creation for why height matters and what
// was measured). This is the enforcement half: no pane in this file can ever
// be shorter than 60 rows, so there is no threshold left to fall under.
// Polls for the pane to show something before returning, on top of
// agent_spawn's own wait rather than instead of it: agent_spawn's wait looks
// for CLAUDE's input-box marker specifically, and a dialog fixture never
// shows one, so agent_spawn returns at its ceiling with the fixture already
// rendered (cat is far faster than 2000ms) but with no marker to report. This
// poll is what actually protects the caller's own next read (agent_rename,
// agent_send) against the fixture still painting, independent of whether
// agent_spawn's own wait found what it was looking for.
```

## line 170

```
// This file used to have a describe block here, "agent_spawn's [hive]
// announcement" - agent_spawn typed a line into the pane and waited for it to
// be ready (or refused on a dialog) before doing so, and every test in it
// asserted the receipt's `announced`/`note`/`tail`. Todo 387 removed the
// TYPING: nothing is typed into a spawned worker's pane anymore, so there is
// no announcement receipt left to assert against. The wait stayed (fix round
// 1, finding 1), and the describe below is its regression test.
```

## line 178

```
// TODO 387 FIX ROUND 1, FINDING 1. The first version of this lane removed
// agent_spawn's readiness wait along with its typing, reasoning that with
// nothing left to type there was nothing left to wait FOR. That reasoning
// only looked at what agent_spawn itself does. waitForPaneInput's own
// contract (src/tmux.ts) is that sending into a pane that has not taken the
// terminal loses the text silently and reports success - and the NEXT thing
// to type into a freshly spawned pane is now the lead's own agent_send,
// which can land in the same tool block as the spawn (todo 384's exact
// dispatch shape, and this PR's own regression test for it). Without the
// wait, that send would race a cold claude and could be silently swallowed:
// strictly worse than the false-finish defect this whole lane exists to fix,
// since a swallowed send leaves the worker sitting forever with an empty
// screen and nothing in the store distinguishes that from a worker that is
// simply thinking.
//
// THIS IS WHY THE REGRESSION TEST BELOW USES A SLOW-RENDERING FAKE CLAUDE
// RATHER THAN THE PLAIN ONE spawn-false-finish.test.mjs uses. A plain
// fakeClaude() shell takes the terminal essentially instantly (it is a `sh`
// script, not a cold claude loading plugins and MCP servers), so a test
// built on it cannot distinguish "the wait ran and succeeded quickly" from
// "there was no wait at all" - which is exactly why the first version of
// this lane shipped with its own regression tests green. Forcing a real
// delay before the pane renders is what makes the absence of a wait
// observable.
```

## line 209

```
// A wider ceiling than the file's default 2000ms, and a client of its
// own rather than reusing `mcp`: this is the one case in the file that
// needs agent_spawn to actually wait out a multi-second cold start
// rather than timing out fast, so it cannot share the short ceiling
// every other test here relies on to keep dialog cases quick.
```

## line 225

```
// 2s before the pane renders anything at all - long enough that a
// send fired the instant agent_spawn returns would land on a raw,
// untaken terminal if agent_spawn were not itself waiting.
```

## line 236

```
// THE PROPERTY UNDER TEST: agent_spawn's own return already implies
// the pane was ready, so the immediately-following send below is safe
// BY CONSTRUCTION rather than by luck. Asserted directly (spawn_ms
// comfortably exceeds the artificial 2s render delay) rather than
// inferred from the send succeeding, so a future change that makes
// the wait a no-op fails HERE with a clear message instead of only on
// the send assertion below, which a flaky pane could also fail for
// unrelated reasons.
```

## line 250

```
// No extra wait here - this call fires the instant agent_spawn
// returns, which is exactly the dispatch shape (spawn and send in the
// same tool block) todo 384 measured.
```

## line 297

```
// Immune: folder-trust-dialog.txt is a static, checked-in fixture, grepped
// clean of "rename" in any case (a real trust prompt has no reason to say
// it). The only way "/rename" lands in this pane is agent_rename actually
// typing it, which is exactly the regression this guards.
```

## line 308

```
// Same immunity as the folder-trust case above.
```

## line 312

```
// Todo 317. agent_rename cannot reach the LEAD - the kind='lead' refusal
// throws before any typing - but it types into a live WORKER pane, and a
// human attached to one is ordinary. The failure is worse here than a plain
// merge: a slash command only runs at the start of a line, so "/rename foo"
// pasted onto a half-typed sentence submits the human's unfinished text
// with the command glued on, the retitle never happens, and the receipt
// used to say retitled: true anyway.
//
// Two cases only, not the five agent_send carries: the classifier itself is
// pinned against every fixture in test/input-box.test.mjs, so what is worth
// proving here is the WIRING - that this call site reads "pending" and not
// "box is non-null". ghost-suggestion.txt is the control that catches that
// exact confusion, and it is the destructive direction besides.
```

## line 329

```
// The note has to name a rename that still resolves: the row is already
// the NEW name by this point, so "retry your original call" would send a
// caller at a name nothing answers to.
```

## line 334

```
// Immune: real-input.txt is also grepped clean of "rename" (see the two
// dialog cases above for the same reasoning).
```

## line 337

```
// Deliberately not asserting the fixture's own text is still on screen:
// the pane cats it, so that can never fail. See the matching note in the
// agent_send block below.
```

## line 350

```
// D5, the grep case, same reasoning as agent_spawn's: the marker alone is
// not enough, since paneChoiceCheck backs every dialog-refusal call site.
```

## line 388

```
// Pre-existing bug, found by this lane's review rather than introduced by
// it: passing both used to send the keys, silently drop the text, and
// still report sent: true. "keys won, text vanished" is not a thing any
// caller can have wanted, so this is a caller error, the same way passing
// neither already is.
```

## line 400

```
// Immune: ready-idle.txt is static and grepped clean of "hello", and
// send-both gets its own tmux window (spawnShowing's placement: "window"),
// so there is no other test's typing to bleed into this pane either. A
// fixture edited to include example text containing "hello" (a worked
// example in a transcript, say) would silently defeat this check.
```

## line 428

```
// Todo 392. The whole bug: an ordinary tool-permission prompt's own
// preview box closes with `╰`, the same glyph INPUT_BOX_PRESENT used to
// trust as proof no dialog was up, so this call used to type "1" and
// hive granted the permission nobody read. Same shape as the trust/model
// cases above; the fixture is the only thing that changed.
```

## line 447

```
// D5, the grep case, same reasoning as agent_spawn's and agent_rename's.
```

## line 456

```
// Issue #150. A control byte in `text` reaches tmux as a keystroke instead
// of as literal text - `send-keys -l` stops tmux interpreting key NAMES but
// not raw control bytes, agent_rename's own guard verified this against a
// real tmux - so an unvalidated `text` argument silently becomes the `keys`
// path .claude/rules/tmux-and-panes.md deliberately keeps unguarded against
// a dialog. Checked before any pane read (no tmux fork spent on a call that
// is refused outright), so a genuinely idle pane still proves nothing
// reached it.
```

## line 492

```
// Todo 317. agent_send's text path guarded a DIALOG and nothing else, so a
// pane holding real unsubmitted human text got the send pasted onto the end
// of it and Enter submitted both as one message. Not hypothetical: three
// clobbers of exactly this shape were captured on the SCHEDULER's path
// before its own hold shipped (todo 317 comment 635, from
// agent_state_log/transcript payloads), and this path has been recorded in
// the project's `lessons` pad as observed three times since 2026-07-29
// ("the next agent_send appends to it"), answered with a human procedure
// rather than a check because hive was capturing without "-e" back then and
// throwing the ghost/real signal away.
//
// The refusal is scoped to "pending" alone. The five no-refusal cases below
// are what stops it becoming worse than the bug: ghost and the queued hint
// render in every idle claude pane, so refusing on those refuses every send
// forever.
```

## line 513

```
// The receipt must name the condition well enough to act on, and
// report the box that DECIDED the refusal rather than a second read.
```

## line 519

```
// NOT asserting that "REAL UNSUBMITTED INPUT" is still on screen. It
// is, unconditionally, because the pane cats the fixture and nothing
// re-renders that row - so the assertion passes with the guard deleted
// and on main, while its message claims the property this lane exists
// to protect. That is test/CLAUDE.md's shape 7, and counselors caught
// it here. doesNotMatch above is the live half.
```

## line 527

```
// submit=false is exempt on purpose, and the reason is the ENTER, not
// compose-then-send: see src/tools/agents.ts, where the compose argument
// is recorded as FACTUALLY WRONG. The guard is on the submitting call,
// which is the SECOND call, so two text calls genuinely do refuse at the
// second one. A compose is finished with keys:["Enter"] instead, and the
// refusal note says so. These two tests pin the documented flow end to
// end rather than only its first step, which is how the old single-step
// version passed while the flow it cited was dead.
```

## line 545

```
// The pane already shows real pending text, which is the state a
// compose leaves behind. WHAT THIS RIG CANNOT STAGE, said out loud so
// nobody reads more into it than is here: an actual submit=false call
// does NOT change what inputBoxState sees, because the pane is a catted
// static screen and typed characters echo BELOW the fixture's box row
// rather than into it. So this asserts the same decision the real
// compose hits - a submitting call over a pending box - reached by a
// fixture instead of by a prior call.
```

## line 558

```
// And the remedy the note gives has to actually be reachable: keys is
// unguarded against this condition by design, on a non-lead target.
```

## line 564

```
// The negative controls. Each of these renders in an ORDINARY pane -
// ghost and the queued hint are what an idle claude draws by itself - so
// a refusal on any of them takes agent_send off the air for good. If one
// of these ever starts failing, the classifier widened, not this guard.
//
// EACH ASSERTS DELIVERY, NOT JUST THE RECEIPT (counselors, codex seat).
// sent: true is a claim the handler makes about itself: a mutation that
// returns {sent: true} without ever calling sendText kept every one of
// these green, and the headline refusal green too, while agent_send
// delivered nothing at all. Reading the text back off the pane is what
// makes these end-to-end paths through capture, classify and type on five
// different sets of real bytes, rather than five ways of asking the same
// predicate the same question.
```

## line 585

```
// The fixture name minus ".txt": a literal dot is tmux's own
// window.pane separator, so it has no business in a target name.
```

## line 596

```
// Decision D2. text and keys are not the same operation and are not guarded
// the same way. text means "inject a user turn", which a dialog eats and
// then reads the trailing Enter as an answer -- the exact hazard #27
// exists to close. keys means "drive this TUI deliberately", and pressing a
// key to answer or dismiss a dialog is the ONLY supported way to unstick a
// pane sitting on one; guarding it would remove that. Pinned against every
// fixture, dialog or not, so a future guard added here by symmetry-minded
// reflex breaks this test and has to read this comment first.
```

## line 610

```
// The accept case for the guard below: an ORDINARY worker's keys path is
// untouched by it, on every fixture including a dialog one - this loop
// already proves that; the new guard below is scoped to kind='lead'.
```

## line 615

```
// Issue #27's L4 fix round R6, todo 169 (counselors opus F3). agent_close
// already refuses a kind='lead' target (src/tools/agents.ts); agent_send's
// keys path did not, and a worker could reach the identical outcome -
// ending the lead's session - with no dialog guard, no confirm_self, and
// no kind check at all. Refused only when the CALLER is not itself a lead.
```

## line 624

```
// Relabelled directly on the row rather than minted through
// ensureLeadRow: this guard checks agent.kind alone, and the point
// here is a REAL live pane to prove keys do or do not reach it, not
// exercising the mint path (that is lead-identity.test.mjs's job).
```

## line 639

```
// Immune: ready-idle.txt is static and grepped clean of a literal "^C"
// (Claude Code's idle chrome does not print one). This pane also gets
// its own tmux window, so no earlier test's own Ctrl-C echo can bleed
// in. A fixture recaptured from a screen that shows "^C to exit"-style
// chrome, or a real Ctrl-C echoed by something upstream of this test,
// would silently defeat this check.
```

## line 658

```
// Issue #27's L4 fix round R8, todo 175 item 3 (BOTH SEATS). Used to
// be a bare HIVE_AGENT_ID: "lead:999" naming no row at all, which is
// exactly the env-shaped hole this round closes: the guard now checks
// for a REAL running kind='lead' row with this actor_id, so the
// fixture has to be one, or this test would pass for the wrong reason
// (the same trap it was written to catch on the callER's side).
```

## line 681

```
// Issue #27's L4 fix round R8, todo 175 item 3 (BOTH SEATS). The exact
// shape the branch's own prior fixture proved passed the escape hatch:
// a string shaped like a lead actor id, naming no agents row at all.
```
