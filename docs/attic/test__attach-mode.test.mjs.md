# Attic: test/attach-mode.test.mjs

Comments removed from `test/attach-mode.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 8

```
// Issue #81. controlModeFor() is pure and reads storeDir()/config.json at
// call time (same reasoning as config.ts and dataDir.ts), so setting
// HIVE_DATA_DIR per case is enough; no subprocess is needed for it.
// attachScripts() no longer is (issue #117 counselors): it now probes the
// real tmux server through freeViewSessionName's has-session check before
// naming a view, so its cases need isolateTmux()'s isolation below even
// though they never assert on a live tmux server directly - a bare `tmux`
// call still needs somewhere safe to land. The CLI-level cases at the bottom
// need a subprocess AND a private tmux server for a different reason:
// cmdAttach's non-TTY branch is only reachable through a real "hive attach"
// invocation.
```

## line 27

```
// Auto-attach's own behaviour lives in test/auto-attach-scope.test.mjs, which
// drives ensureAttached against fake tmux and osascript binaries. It used to
// live here as three assertions against a pure helper plus a regex over
// src/tmux.ts's source text; see that file's header for why none of them could
// fail when the behaviour regressed.
```

## line 33

```
// HIVE_ATTACH_MODE is a one-off testing override; withEnv restores it after
// every case that sets it so a later, unrelated case does not inherit it.
```

## line 37

```
// FOUND BY CI ON PR #132, one red macOS leg against a diff that could not have
// caused it. The two negative assertions over CLI stdout below were
// `doesNotMatch(stdout, /-CC/)`, and `hive attach` prints the project's own
// path in its first line, so the regex was reading the SCRATCH DIRECTORY NAME:
//
//   'Session ... for project "project-wBTbTT" (/T/hive-test-CC2fL1/project-wBTbTT).
//    Attach from a terminal with: tmux new-session -t ...'
//
// `scratchDirs()` builds that root with `mkdtemp(tmpdir() + "hive-test-")`,
// whose six random characters are drawn from a set that includes upper case,
// so roughly one run in a few thousand produces a suffix starting "CC" and
// this test fails on the name alone. Latent since it was written; nothing to
// do with control mode, and no `-CC` flag anywhere in that output.
//
// WHY A TOKEN TEST RATHER THAN A NARROWER REGEX. The obvious repair is to
// copy the positive assertions and look for /-CC new-session/, and that trades
// a false red for a FALSE GREEN, which is the worse direction and the one this
// project keeps re-shipping: `-CC` also legitimately precedes `attach` (see
// the already-attached case near the bottom of this file, which matches
// /tmux (-CC )?attach -t /), so a negative scoped to new-session would stop
// catching a `-CC attach` regression entirely and say nothing.
//
// Splitting on whitespace and asking for an exact token is immune to whatever
// the path contains, because a path is one token and can never equal "-CC" -
// it is absolute, so it always carries a "/". It catches the flag in every
// position it can appear, including ones nobody has written a test for yet,
// which is the property a NEGATIVE assertion needs: it is asserting the
// absence of something, so it must not depend on knowing where it would be.
// Pinned by its own cases in "the -CC negative assertion itself" below, which
// need no tmux and no subprocess.
```

## line 79

```
// The reproduction, kept as a fixture rather than as a story: this is the
// real stdout from the CI failure's shape, with the scratch path that broke
// it. `/-CC/` matches this string; the token test must not.
```

## line 91

```
// BOTH positions, because a negative that only knew about one of them would
// be a false green rather than a false red. These are the two subcommands
// the flag is ever printed in front of.
```

## line 133

```
// controlModeFor() is the one helper both call sites go through, so
// proving the override reaches it here proves it reaches both.
```

## line 137

```
// Unaffected once the override is gone: the stored value is still raw.
```

## line 145

```
// An invalid override is not an override at all; falls through exactly
// like a malformed config file does.
```

## line 152

```
// Issue #117. attachScripts used to embed a plain `attach -t hive-1`, so two
// auto-attaches racing each other both landed a client on hive-1 itself.
// viewSessionName() is pid-tagged, and this test process's pid is fixed for
// the whole run, so the expected view name is computed once rather than
// pinned as a literal - a literal here would silently stop discriminating
// the moment the pid tag format changed elsewhere.
```

## line 173

```
// M1 (pad 80): reverting either script back to a plain `attach -t hive-1`
// is what this case exists to catch. Counselors review (both seats,
// independently) on the todo-323 audit: a `doesNotMatch(iterm/terminal,
// /\bmux attach -t hive-1"/)` pair used to sit here, annotated as
// immune. Removed instead, for the same reason as the sibling deletion
// in "sets destroy-unattached on the view, not on base" directly below,
// which this project already used once as precedent for exactly this
// shape: node asserts in order, and the two exact-string `assert.equal`
// calls above already pin BOTH scripts character-for-character,
// including `new-session` where M1's regression would have printed
// `attach`. Any output the removed pattern could have caught already
// fails those equality checks first, so it could never independently be
// the assertion that caught a real regression - keeping it annotated as
// "immune" rather than removing it would have left two contradictory
// precedents in one file for the identical shape.
```

## line 191

```
// M3 (pad 80): dropping destroy-unattached from the emitted chain must
// fail this - it is what keeps a stray view from outliving its client
// (todo 273's stray-view report; pad 80 decision 3).
//
// Issue #117 counselors, F2. A doesNotMatch against the literal passed-in
// session ("hive-1") used to sit here too, meant to prove the option
// never lands on base. Deleted: v (viewSessionName()'s own output)
// always ends "view-<pid>" and can never literally render as "hive-1",
// so no mutation of this code could ever make that assertion fail - and
// the exact-string equality test above already pins destroy-unattached's
// target as v, not session, which is the only way that could go wrong.
```

## line 214

```
// Todo 323: immune to generated data, but for a narrower reason than M1
// above - iterm/terminal DO embed a generated view name (dataDirTag() +
// process.pid). It is immune only because that generator's charset
// cannot produce "-CC": dataDirTag() (src/dataDir.ts) is a sha256 hex
// digest, and Node's digest("hex") is always lowercase, and pid is
// decimal digits - neither can ever contain an uppercase "CC". This is
// the same trap as the found bug (attach-mode's own header comment,
// mkdtemp's uppercase-inclusive suffix), inverted: it holds here only
// because THIS generator's alphabet excludes upper case. A future
// dataDirTag() that used base62 or uuid would inherit the bug.
```

## line 236

```
// M2 (pad 80) is void, recorded rather than faked. Measured on this machine
// (see the comment above attachScripts, src/tmux.ts): despite running with
// no shell, iTerm's own command tokenizer strips single quotes and groups
// quoted spans exactly like a POSIX shell, and never treats a bare `;`
// specially either way, so renderAttachCommand's quoting does not need to
// differ between the two branches - there is no branch-specific quoting
// left to pin a test on. The only real difference between the two scripts
// is -CC, already covered by the three cases above.
```

## line 246

```
// Issue #117 counselors, F1. Both review seats independently refuted the
// pid-collision reasoning attachScripts' comment used to carry: a pid cannot
// collide with ANOTHER pid, but ensureAttached runs once per agent_spawn
// inside the long-lived MCP server (one pid for its whole life), so a SECOND
// spawn can find the FIRST spawn's own view still alive and try to recreate
// it under the identical name. Reproduced here directly: pre-create the
// session viewSessionName() would hand back for this test process's own pid,
// then confirm attachScripts bumps past it instead of colliding.
```

## line 263

```
// Grouped with base, matching the exact shape the real chain creates -
// a stray plain session named the same would not exercise the same
// has-session probe attachScripts actually runs.
```

## line 269

```
// Todo 323: immune to generated data by construction, not by luck -
// the pattern is built FROM firstView, the same generated value the
// haystack would contain, so the two cannot diverge for an unrelated
// reason the way a hand-written literal could.
```

## line 290

```
// Issue #117 counselors. A two-process race fixture for attachScripts lived
// in test/attach-view-race.test.mjs for three CI rounds and flaked on
// alternating ubuntu legs each time - round 2 red on node 22 and green on
// node 24, round 3 the opposite, same commit shape, no product change
// between rounds. The failure was the child dying at process startup
// (empty stdout, exit 1, well under half a second), never an assertion
// about base clients - harness instability, not the concurrency property
// finding anything. It was cut deliberately rather than chased further: the
// invariant it asserted is ORDER-INSENSITIVE (counselors, opus), so a
// single process proves the same thing a race would, and what the race
// fixture actually added beyond M1-M3 above was reading LIVE tmux state
// instead of the emitted string - which is what this test keeps. The
// sibling race block for resolveAttachTarget in attach-view-race.test.mjs
// predates this lane, was never the one flaking, and is untouched. Do not
// rebuild the attachScripts race fixture on the strength of this comment
// alone; it did not hold still across three real attempts.
```

## line 320

```
// -C, not the product's own -CC: the transport that lets a headless
// client exist with no tty, orthogonal to what is under test (the
// sibling race block's own comment makes the identical point).
```

## line 324

```
// zsh when it exists, else sh - the leading-'=' EQUALS-expansion trap
// renderAttachCommand quotes for is a zsh behaviour and invisible to
// sh, but every other property this test checks is shell-agnostic.
```

## line 343

```
// show-options' -t does not accept the "=" exact-match form other
// targets in this file use (measured against a real, live,
// client-attached view where has-session/list-clients/list-windows
// all succeed with it) - bare here, deliberately.
```

## line 372

```
// Todo 294. sessionName() reads process.env.HIVE_DATA_DIR in THIS
// process, not the runCli child's own env (that gets it only via
// opts.dataDir below) - every sibling case in this file sets it here
// before computing session for exactly that reason. Omitting it left
// `session` computed against whatever the previous case's assignment
// happened to leave behind, so cleanup(session) below killed the wrong
// name and the real session (and its server) outlived the file.
```

## line 382

```
// `new-session -t`, not `attach -t`: todo 279 collapsed the two attach
// branches into the view-session one, so the printed hint carries the
// same chain the spawn path runs. What this case is about is the -CC
// prefix and nothing else, so it asserts the prefix against whatever
// subcommand follows it.
```

## line 403

```
// No `hive setup --attach` yet (issue #81 step 3): write the config the
// same way that command will, by calling setAttachMode against the same
// store the child process resolves.
```

## line 454

```
// Smoke-test finding against the branch build: cmdAttach's non-TTY hint used
// to be hand-built (`tmux attach -t <session>`) with no idea of the
// project's window or an already-attached base session, so it could walk a
// human into the exact current-window fight this lane exists to prevent
// (pad 71's opening complaint - two pieces of hive's own advice pointing
// opposite ways). Fixed by making resolveAttachTarget (src/tmux.ts) the ONE
// source both the spawn path and this print path read from; these two
// cases are the ones that could never have been wrong before the reversal
// (there was no window/view awareness to be wrong about) and are the ones
// that regressed.
```

## line 481

```
// The window ID, qualified with the VIEW session the chain creates
// rather than with the base session's name (todo 279): every attach
// takes a view now, and a base-qualified select-window is the yank
// this round removed. The view is named for the CLI child's own pid,
// which this process cannot know, so the session part is matched
// loosely and the window id exactly.
```

## line 506

```
// A headless control-mode client, the standing way this suite forces a
// session to already have one (test/view-session.test.mjs).
```
