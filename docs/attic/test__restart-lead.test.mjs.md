# Attic: test/restart-lead.test.mjs

Comments removed from `test/restart-lead.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 9

```
// Todo 186 / plan-restart-lead-in-tree step 3. Only refusal 2 is exercised
// here (whether the running-agents count includes the lead's own row): the
// respawn half of the fix kills a real pane and launches a fresh claude,
// which is exactly the live action this lane may never trigger (the plan
// pad's "THE LINE YOU DO NOT CROSS"). Every invocation below is --dry-run,
// which touches nothing.
```

## line 29

```
// A real, executable `hive` on PATH: restart-lead.sh calls it as a bare
// command (`command -v hive`, `hive status`), not through dist/cli.js
// directly. Written through dispatcherScript() rather than by hand so this
// cannot silently drift from the exec-line format readDispatcher parses
// elsewhere (test/CLAUDE.md).
```

## line 40

```
// The fake claude replays a real captured idle screen (test/fixtures/panes/
// ready-idle.txt) rather than doing nothing: refusal 1 (claude chrome on
// screen) and refusal 3 (input box present, no choice dialog) both have to
// pass before refusal 2 - the one under test - is ever reached. See
// test/CLAUDE.md and test/typing-guards.test.mjs's own replayFixture for the
// same technique.
```

## line 57

```
// execFileSync throws on a non-zero exit rather than returning it, and
// scenario B below expects exit 1, so this wrapper reads status/stdout/stderr
// uniformly whether the script exited 0 or refused.
//
// HIVE_REPO is the scratch PROJECT dir, not REPO (the real hive checkout this
// suite runs from): the script now resolves its project FROM THE STORE by
// matching REPO against a registered project's path (fix round 1, todo 189),
// and the project seeded below is registered at projectDir, not at REPO. This
// still exercises every refusal here - HIVE_SESSION already overrides the
// derived value regardless - but a mismatched HIVE_REPO would
// make resolve_project fail before any of them are reached. Todo 193 covers
// the derivation itself, with HIVE_REPO unset.
```

## line 86

```
// Shared by every describe block below todo 189's own (fix round 1, todo 193).
// Each gets its OWN project/session so scenarios cannot see each other's
// state - the file's first describe block already leaves a permanent
// kind='agent' worker row behind (its second test, above), which would
// silently break any later "running agents: 0" expectation that reused its
// project.
```

## line 96

```
// Runs a REAL `hive lead` (not through restart-lead.sh) to give a scenario a
// real fake-claude pane to work with, and waits for the fixture to actually
// render - see the comment on the first describe block's own test for why
// that wait matters (a receipt is not proof the pane has content yet).
```

## line 111

```
// `log` is a caller-chosen path so each scenario reads back only its OWN
// run's log lines, rather than grepping a file every earlier test in this
// suite has also appended to.
```

## line 134

```
// `hive lead` returns once the pane is split/created, not once `cat`
// has actually rendered the fixture into it - capture-pane against an
// empty pane is refusal 1's own false negative, not the fix under test.
```

## line 146

```
// say() only echoes to stdout under a tty; execFileSync's pipe is not
// one, so the log file - always written, tty or not - is the only
// place "running agents: N" can be read back from a captured run.
```

## line 170

```
// Fix round 1, todo 193 items 2-3 (opus finding 2, codex P1 1 / P2 5). Both
// still --dry-run only; neither needs a real kill to discriminate.
```

## line 183

```
// A dev server started by hive.yml's `processes:` block, not a worker -
// this must never block a lead restart. If the allowlist regresses from
// `kind = 'agent'` to `kind != 'lead'`, this row starts counting and the
// assertion below goes red (a refusal, not a clean dry run).
```

## line 211

```
// project_id = projB.id, deliberately NOT projA - this row must not
// count against projA's restart. Pre-189, refusal 2's query had no
// project_id filter at all, so this would have counted and refused; if
// that filter regresses, this goes red the same way.
```

## line 232

```
// Fix round 1, todo 193 item 4 (codex's test finding: HIVE_REPO was always
// set in every scenario above, which overrides derivation entirely and would
// stay green even against a hardcoded, broken REPO). HIVE_REPO is
// deliberately absent from this scenario's env.
```

## line 241

```
// Registered at REPO - the real checkout this suite runs from - but
// only as a path STRING in this SCRATCH store; nothing here opens or
// touches the live ~/.hive database, which has its own, unrelated
// project row at the same path.
```

## line 247

```
// --no-dashboard: this test is about REPO PATH DERIVATION, not
// dashboard behavior, and REPO is the real checkout - its own hive.yml
// has `dashboard: true` for real (hive dogfoods its own feature), and
// its own .claude/dashboard/index.html exists for real whenever a live
// hive MCP instance has ticked it. Without this flag, maybeOpenDashboard
// (src/cli.ts) would reach a real `open` here - the suite-wide fake
// (scripts/open-guard.mjs, todo 419) catches it either way, but this
// call is the one this test should not be making in the first place.
```

## line 258

```
// REPO's real hive.yml (this checkout's own) does define a `lead:`
// command, so REFUSAL 4 (todo 190) applies to THIS scratch project too
// once PROJECT_PATH resolves to REPO - trust it here the same way
// seedTrustedYml does for processes, or this test would hit that
// refusal instead of the property it means to check.
```

## line 274

```
// No HIVE_REPO key at all - SCRIPT_DIR resolution is what has to find
// its way back to REPO. A hardcoded or broken derivation (e.g. codex's
// suggested REPO=/nonexistent mutation) makes resolve_project fail to
// match ANY registered project, which refuses outright rather than
// reaching this log line - that is the red this test goes to.
```

## line 293

```
// Fix round 2, todo 195 (counselors round 2: opus finding 3, codex P1 4).
// Every test above sets HIVE_SESSION explicitly, which is exactly why the
// prior bash reimplementation of hive's session naming (data_dir_tag/
// session_name_for/canon_dir - deleted in this commit) went unnoticed: it
// hashed a trailing newline pwd's pipeline output carries, could never
// equal src/dataDir.ts's own tagFor(), and made every non-default
// HIVE_DATA_DIR run derive a session that did not exist. This suite's
// scratch store IS a non-default HIVE_DATA_DIR from hive's own
// perspective (dataDirTag() hashes it to a real, non-empty tag), so
// `sessionName()` here is already a hash-tagged name like
// "hive-<8hex>-main", not the bare "hive-main" the everyday default-store
// path would give - exactly the shape the deleted code could never
// reproduce, verified directly against it before deleting it.
```

## line 320

```
// No HIVE_SESSION key at all - tmux display-message on the store's
// own pane is what has to find its way back to this exact session.
```

## line 326

```
// Both occurrences (pre-kill resolution and post-restart
// re-resolution) must name THIS real session. A still-broken
// derivation refuses outright (no such session exists to scope
// list-panes against); a derivation that fell back to some OTHER
// live session would not match this exact, hash-tagged name.
```

## line 346

```
// Todo 273 (topology-3c). `display-message -p -t <pane-id>` is AMBIGUOUS the
// instant the pane's window is linked into a second, grouped session - a real
// view session (viewSessionName(), src/tmux.ts) is exactly that. Measured
// against tmux 3.7b: it favors the MORE RECENTLY CREATED session of the
// group, which is the view here, not the base - and a view session can
// vanish (destroy-unattached) at any moment, so naming it as SESSION risks a
// false refusal or a false "no live pane" read later in the same run. This
// pins that resolve_lead_pane's fix (list-panes -a, filtered by the
// view-session suffix) survives exactly the condition that broke the old
// display-message-based derivation.
```

## line 369

```
// Grouped with the base (`new-session -t <base>`), the same
// relationship a real view session has - created AFTER the base, so
// it is the one tmux favors if the ambiguity this test exists for
// still exists.
```

## line 379

```
// Already gone.
```

## line 388

```
// Both occurrences (pre-kill resolution and post-restart
// re-resolution) must name the BASE session, never the view.
```

## line 414

```
// Fix round 1, todo 193 item 1 (opus finding 1, codex P1 3 - the central
// defect this whole fix round exists for) plus item 1's session-survival and
// store-match requirements (opus findings 3 and 6, codex P1 2 and 4). Every
// scenario below runs the REAL script, no --dry-run, inside the isolated
// tmux server + scratch store this file already sets up - per test/CLAUDE.md
// and the plan pad's "THE LINE YOU DO NOT CROSS", the LIVE machine is never
// touched by any of this.
```

## line 434

```
// The decoy: split -b INTO THE SAME WINDOW as the lead, which puts it
// AHEAD of the lead's pane in list-panes order - verified against a
// throwaway tmux server before writing this test (split-window -b
// reindexes the new pane to a lower pane_index than the pane it split
// from). This is exactly counselors' scenario: a second pane in the
// lead's own window, sorted first. The OLD resolve_lead_pane (first
// window-name match wins) would have picked THIS pane and killed it;
// that is the red this test goes to against the pre-189 script.
```

## line 447

```
// Split into lines and compare real indices, not substring position:
// pane ids are not fixed-width ("%1" is a substring of "%10"), so
// order.indexOf(decoyPane) < order.indexOf(leadPane) on the raw text
// can pass or fail for the wrong reason once pane ids reach two
// digits on a longer-lived server. Round 2, opus's "lower" section.
```

## line 471

```
// Both occurrences - pre-kill resolution AND post-restart
// re-resolution - must have used the store, not just the first one.
// Round 2, opus's "lower" section: a plain assert.match only proves
// the substring appears somewhere, so a regression that broke ONLY
// the second resolution (post `hive lead`) would still pass this.
```

## line 507

```
// This repo's own ordinary shape: hive.yml's `processes:` block is
// empty, so the lead's pane really is the only pane in the only
// window of a fresh session - the one case where kill-pane, with no
// placeholder, takes the window and the session down with it.
```

## line 516

```
// A custom SESSION option, not a window or a pane, so it cannot
// trivially survive by riding along on some OTHER window the way an
// extra witness window would - and it would NOT be preserved by a
// same-named session tmux creates fresh, the way `#{session_id}`
// turned out not to discriminate either (verified against a
// throwaway tmux server: with only ever one session on a server,
// destroying it and creating a new one of the same name reuses id
// $0, and `#{session_created}`'s one-second resolution can
// coincidentally match a kill-then-recreate that happens inside the
// same wall-clock second). A session option set before the restart
// and read back after is the one thing here that positively proves
// "same session object", not merely "a session by this name exists
// again": a fresh `new-session` never carries a prior session's
// custom options, verified directly (not just reasoned about)
// against a throwaway server before writing this assertion.
// No `=` prefix here, unlike every other -t in this file: verified
// directly against a throwaway tmux server that set-option/
// show-options refuse an exact-match session target ("no such
// session: =name") even when the plain name resolves fine on the
// identical server - unlike list-panes/list-windows/capture-pane,
// which all accept it. A tmux quirk, not a copy-paste inconsistency.
```

## line 564

```
// IMMUNE to the placeholder window's own generated data: the script
// names it "restart-lead-placeholder-$$" (its own shell pid,
// scripts/restart-lead.sh), a value this test never controls or
// predicts. The pattern is deliberately unanchored to that suffix -
// it only asks whether the fixed "restart-lead-placeholder" prefix
// is gone - so the pid cannot cause a false pass here either way. A
// future caller matching the FULL name (prefix plus pid) would have
// to thread the pid through, which is exactly the trap this avoids.
```

## line 586

```
// Fix round 2, todo 198. Covers: the skip-the-kill path (194), the
// UNTRUSTED lead: direction (197), two running kind='lead' rows (194's
// LIMIT 1), and the session surviving when claude never becomes ready
// (196 item 2-3). The production detached-re-exec path is covered
// separately below - it needs TMUX_PANE set, which every test above
// deliberately avoids (isolateTmux() clears it).
```

## line 604

```
// No `hive lead` run at all here - no agents row, no tmux session.
// If the code under test were reverted to always requiring a pane
// to kill, this would refuse instead of proceeding.
```

## line 633

```
// Kill the pane OUTSIDE the script, leaving the row stale (status
// still 'running', tmux_target still naming the now-dead pane) -
// the canonical trigger this whole path exists for: the lead died
// without cmdLead ever recording its replacement.
```

## line 647

```
// NOT asserting newPane !== deadPane: if this was the only session
// on the shared scratch tmux server at the moment it died, the
// server itself restarts and pane ids resume from %0 - a
// coincidental match here is possible and does not indicate
// anything was actually reused. Liveness and the handoff below are
// the real assertions.
```

## line 669

```
// startRealLead below runs BEFORE this file exists, so the initial
// lead pane is an ordinary claude (untouched by hive.yml at all) -
// this test is about the SCRIPT's own preflight, not what `hive lead`
// itself does with an untrusted command.
```

## line 679

```
// Deliberately NOT seeding command_trust - this is the untrusted case.
```

## line 702

```
// A second, stray kind='lead' row for the SAME project - src/cli.ts
// documents this can happen after an older server's rename-repair
// path leaves two (the real row keeps name='lead'; idx_agents_running_
// name is unique on (project_id, name) for running rows, so the stray
// one - as it would be in practice - carries a DIFFERENT name). Its
// pane id is not a real pane, so without LIMIT 1 the two-row-wide
// $row would never exact-match anything in list-panes at all (a
// two-line string cannot equal any single pane_id line), and
// resolution would report "nothing to kill" even though the real
// lead pane is right there and live.
```

## line 742

```
// A claude that starts but never renders the input-box marker - the
// production shape of "a bad trusted lead: command, a missing
// binary in the tmux server's own env, or a crash right after
// launch" (todo 196's own framing). Written to hive.yml as an
// ABSOLUTE PATH and trusted explicitly, so the SERVER spawns
// exactly this binary regardless of PATH - the initial lead pane
// above was already launched before this file existed, so refusal
// 1 (which only inspects that pane's already-rendered screen) is
// unaffected by any of this.
```

## line 770

```
// The session must still exist, and the placeholder must NOT have
// been removed on this failure path (todo 196 item 3) - it is the
// only anchor keeping a single-pane/single-window session alive
// once the new (never-ready) lead pane is the only other occupant
// of its window and something later needs it gone too.
```

## line 785

```
// Fix round 2, todo 198's own framing of "the biggest gap": every test above
// runs with TMUX_PANE cleared (isolateTmux() does this at module load), so
// every one of them takes the INLINE branch. The detached re-exec under
// nohup - re-exec, exit, and a background child that outlives the parent -
// is how this script actually runs in every real invocation, and nothing
// above ever enters it. Codex round 2's own framing is the one to hold onto:
// make that branch return without spawning a child, and every real restart
// becomes a silent no-op while every other test in this file stays green.
```

## line 807

```
// TMUX_PANE set to the exact pane the script will resolve as the
// lead - simulating "this script is running inside the pane it is
// about to kill", the ordinary case per the script's own header
// comment, not an edge case.
```

## line 816

```
// The FOREGROUND parent must return quickly, having only re-exec'd
// a detached child - not have carried out the restart itself. If
// the detached-branch guard broke and returned without spawning a
// child at all (codex round 2's own framing), this call would
// still exit 0 having done nothing, and nothing checked below would
// ever become true.
```

## line 835

```
// The detached child runs independently of the parent that already
// returned; poll the log for it to finish rather than assuming any
// fixed delay (the log is the natural witness here, since the
// parent's own stdout/stderr told us nothing about the child).
```

## line 859

```
// TODO 399 REPLACED A SYNC TEST WITH AN ABSENCE TEST, and the reason is that
// the thing it was keeping in sync should not have existed.
//
// It used to extract `CHOICE_DIALOG` and `INPUT_BOX` from this script as bash
// ERE strings, extract their counterparts from src/tmux.ts as regex sources,
// and assert the strings matched. That pins a transcription; it does not
// remove one. It also only works while both sides ARE regex literals - todo
// 399 replaced the input-box half with a structural anchor over the box's own
// borders, the extraction returned undefined, and this test went red.
//
// Red was the good outcome. The bad one is what the copy was doing until
// then: this script REPAINTS THE LEAD'S PANE, and its transcribed input-box
// regex carried todo 399's defect in full, so its dialog gate degenerated to
// the bare footer match on the one pane a human types into. Todo 392 had
// already found the sibling copy in scripts/part-c-assert.mjs carrying THAT
// lane's bug through its own acceptance run. Two lanes, two copies, one
// structure.
//
// So the copies are gone: the script calls hive's own paneAwaitingChoice and
// paneHasInputBox through `node -e` against this checkout's dist/, the same
// pattern and the same fail-closed handling it already uses for
// dist/projectYml.js. This test asserts the copies STAY gone and that the
// call is still wired, and it names the file to open when it fires.
```

## line 883

```
// Comments are stripped first: this script's own prose quotes the retired
// regex while explaining why it is retired, and a test that cannot tell an
// explanation from a declaration would forbid recording the decision it
// exists to enforce.
```

## line 928

```
// Todo 392 round 1, F2. CLAUDE_PANE_CMD has no src/tmux.ts counterpart - it
// is a process-identity signal this script alone needs, since hive's own TS
// code never has to guess a pane's identity from scratch (it always starts
// from the pane a STORE row already names). What is worth pinning is its own
// SHAPE: a real claude reports its version as pane_current_command for its
// entire life - idle, busy, and sitting on a real dialog, all measured live
// against claude 2.1.231 - and that must match, while an ordinary shell or
// tool name must not. bash's own grep -qE interprets this, not a JS regex
// reinterpretation of it, for the same reason the view-session test below
// does: the two dialects can silently disagree on what "looks like a match"
// means.
```

## line 963

```
// Todo 392 round 1, F2. Refusal 1 used to OR CHOICE_DIALOG in unguarded, as
// proof a pane is claude: "Esc to cancel" alone was implausible in a bare
// shell's scrollback, but D3 (todo 392) widened CHOICE_DIALOG with "Would
// you like to proceed" for the plan-approval dialog, and that IS ordinary
// installer/CLI prompt text.
//
// This does NOT reproduce the exact scroll-depth exploit: refusal 1 reads
// -S -30, refusal 3's awaiting_choice reads -S -18 (matching src/tmux.ts's
// own tailCaptureLines()), so a real kill needed the matching text to sit
// PAST refusal 3's narrower window while staying inside refusal 1's wider
// one - refusal 3 would have caught this exact fixture too, since the text
// is close to the bottom on both reads, and the two windows are not
// reproduced far enough apart here to tell them apart. What this DOES prove,
// and has to prove regardless of that depth: refusal 1 must be correct ON
// ITS OWN, not merely lucky that refusal 3 happens to also fire on the same
// condition it does - the assertion on WHICH message comes back is what
// makes that the actual claim, not just "the script refused eventually".
```

## line 990

```
// A REAL pane, but genuinely not claude: a plain `sh` printing text an
// ordinary installer might. pane_current_command for this pane is "sh"
// - it never matches CLAUDE_PANE_CMD - and INPUT_BOX has nothing to
// match either. This text was a real CHOICE_DIALOG alternative when
// this test was written (round 1's D3 widening); round 2's M2 swapped
// that alternative for "ctrl+g to edit in", so it is ordinary,
// non-matching prose now - which still proves the point, since
// refusal 1 stopped consulting CHOICE_DIALOG at all in round 1 (F2)
// and this asserts identity is refused on SCREEN CONTENT generally,
// not on this one string surviving in the regex.
```

## line 1031

```
// Todo 273. The two copies cannot be compared as TEXT the way CHOICE_DIALOG/
// INPUT_BOX are above: bash's ERE ('view-[0-9]+$', via grep -vE) and the TS
// regex source (isViewSessionName, src/tmux.ts) are two different dialects
// for the identical shape, so a literal string match would fail even with no
// drift at all. Compare BEHAVIOUR instead, across a shared fixture set - the
// same guarantee CHOICE_DIALOG/INPUT_BOX give, reached the only way available
// once the two sides cannot share source text.
```

## line 1052

```
// Issue #117 counselors: freeViewSessionName bumps past a live
// collision with a numeric suffix, so a bumped view still has to read
// as a view here - the EXCLUDE direction is the dangerous one, since
// this filter's whole job is telling a view apart from the durable
// base session it is trying to isolate.
```
