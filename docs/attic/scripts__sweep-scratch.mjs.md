# Attic: scripts/sweep-scratch.mjs

Comments removed from `scripts/sweep-scratch.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 2

```
// Todo 402. A dev-only sweep for what a full-suite run leaves behind on the
// machine that ran it: orphaned login shells still holding ptys, and old
// scratch tmux servers `hive doctor` already names but deliberately does not
// reap (test/CLAUDE.md, todo 375). NOT a CLI verb, NOT a doctor flag, NOT
// shipped - a script for people developing hive, because only they run the
// suite that causes this. The full spec and the manual sweep it replaces are
// on todo 402; this file implements it, it does not re-argue it.
//
// DRY RUN BY DEFAULT. `--kill` is required to touch anything. Read every
// comment below before changing what gets reaped or how - two dead-ends
// already paid for the two rules that matter most:
//   .claude/sessions/dead-ends/2026-08-07-killing-orphaned-tmux-servers-by-pid.md
//   .claude/sessions/dead-ends/2026-08-11-reaping-a-wedged-tmux-server-by-socket-alone.md
//
// dist/ imports are deferred into main() rather than hoisted, matching
// test/CLAUDE.md's "keep dist/ imports inside functions" - this script opens
// no store and sets no HIVE_DATA_DIR, but a top-level import would still run
// ahead of --help, which must work with no build present at all.
//
// A NOTE ON THIS FILE'S OWN SAFETY SHAPE, not a testing detail: this
// script's SAFE configuration (a realistic age floor) is the INCONVENIENT
// one to test against, because it makes the candidate list empty for
// anything a test just spawned, and an empty candidate list is an empty
// test. Its DANGEROUS configuration - a floor low enough to catch a fresh
// fixture - is the convenient one, and reaching for it while testing is the
// same mistake this script exists to prevent a human from making on a real
// machine, just moved into the test suite. It happened once while building
// this file (--age-hours=0 against the real shell population) and was one
// step from happening a second time while testing the guard below against
// it. `SWEEP_PS_ROWS_JSON` (liveShellRows) and `SWEEP_SUITE_LOCK_PATH`
// (liveSuiteLockHolder) exist so a test can stay at a realistic floor and
// still have something real to find: close the candidate set to exactly
// what the test owns instead of lowering the floor to catch it. Keep this
// shape for anything added later - if a new safe default is inconvenient to
// test honestly, that is the sign a seam is missing, not that the floor
// should move.
```

## line 57

```
// A JUDGEMENT, argued rather than inherited from the manual sweep that used
// it. This tool is destructive and runs on a machine that routinely carries
// several concurrent lanes plus a lead, each doing its own scoped runs,
// rebases and doctor calls over the course of a normal session - unlike
// doctor's own 1h floor (ORPHAN_MIN_AGE_MS, src/tmux.ts), which only has to
// outlive one ~3-minute suite run, this floor has to outlive a whole work
// session so a sibling's still-relevant debris is never mistaken for garbage.
// 12h comfortably clears an ordinary session while staying far short of the
// multi-day-old debris this script exists to remove (10.4h and 62.2h orphans
// observed the night this was specified, oldest from two days prior).
```

## line 70

```
// How long to wait for SIGTERM to land before escalating, per candidate.
// Short: everything observed the night this was specified died on TERM
// within a couple of poll intervals, and a wedge that needs KILL is the
// interesting case worth reporting, not one worth waiting out at length.
```

## line 91

```
// ---------------------------------------------------------------------------
// Population 1: orphaned login shells holding ptys.
// ---------------------------------------------------------------------------
```

## line 95

```
// pid + ppid + etime + tty + comm, in that order. `comm`/`args` is last and
// unanchored (it can contain spaces) - the same shape src/ptys.ts's own
// PS_LINE regex uses, one field wider.
```

## line 100

```
// Exported for the enumeration test: given ps(1) text, which rows does this
// parse - the fixture-testable half, per test/CLAUDE.md ("a test asserting a
// number read off the box it runs on cannot fail").
```

## line 114

```
// ps(1)'s etime: `SS`, `MM:SS`, `HH:MM:SS`, or `D-HH:MM:SS`. Exported for the
// same fixture-testable reason as parsePsRows.
```

## line 119

```
// bare seconds
```

## line 127

```
// SWEEP_PS_ROWS_JSON - see the file header for what this is really for.
```

## line 130

```
// `comm=` on darwin, `args=` on linux - src/ptys.ts's isOrphanLoginShell
// comment explains why: linux's `comm=` cannot carry a login shell's
// leading dash, only `args=` (reconstructed from argv[0]) can.
```

## line 141

```
// Reuses isOrphanLoginShell (src/ptys.ts) rather than a second copy of the
// ppid/dash predicate - one source of truth for what counts as orphaned,
// shared with `hive doctor`'s own count. The tty filter is this script's own
// addition on top, narrower than upstream and never wider: "holding a pty"
// is part of todo 402's own definition of the population, and excluding a
// non-pty row can only shrink the candidate set, never grow it.
```

## line 155

```
// SIGTERM first, always. Escalates to SIGKILL only if the process is still
// alive after the grace window, and says so - a script that reaches for -9
// by default hides the case where something was genuinely stuck (todo 402's
// own point: all 396 died on TERM the night this was specified).
```

## line 163

```
// already gone
```

## line 190

```
// ---------------------------------------------------------------------------
// Population 2: old scratch tmux servers.
// ---------------------------------------------------------------------------
```

## line 194

```
// THE GUARD A FULL SUITE RUN DEPENDS ON. orphanScratchServers() excludes only
// THIS process's own live socket (tmuxSocketPath against its own env) - it
// has no way to know about a SIBLING process's scratch socket, so another
// lane's full suite, mid-run, looks exactly like debris from here. Measured
// live: a dry run at --age-hours=0 against a real concurrently-running suite
// offered up that suite's own live scratch socket and eleven of its own
// freshly orphaned shells. At the 12h default this cannot happen, but the
// age floor is the ONLY thing standing between this script and a running
// suite, and the age floor is exactly the knob someone lowers when a machine
// is out of ptys - which is the moment a live suite is most likely to be the
// thing consuming them. todo 401's suite lock (scripts/suite-lock.mjs)
// already names a live holder for this exact reason; reusing it here rather
// than re-deriving "is a suite running" independently.
//
// SCOPED TO SERVERS, NOT SHELLS, on purpose. A server this population would
// reap is either live (an in-progress suite file's own socket, if it is the
// lock holder's) or wedged (already unreachable) - reaping a LIVE one is the
// direct hit the finding above describes. An orphaned shell (ppid 1) has
// already lost the tmux server that would have delivered anything to it;
// nothing a running suite still depends on is listening through it, so
// killing one mid-run costs nothing a live suite could notice. If that
// argument turns out wrong for some shell shape, it is a narrower fix than
// gating the whole script on the lock.
//
// FAILS OPEN, DELIBERATELY: if the lock check itself cannot run (no git, a
// transient fs error), this returns null rather than blocking every reap
// over a guard that is additive on top of the pre-existing socket-exclusion
// and wedged-pid safety net, not a replacement for it.
//
// `lockPath` is testing-only, exactly the shape HIVE_TMUX_TIMEOUT_MS already
// uses elsewhere in this project: the real path is ONE FILE SHARED BY EVERY
// WORKTREE of this checkout (resolveLockPath keys it on git-common-dir), so
// a test writing a fake holder record there would race whatever lane is
// actually running a suite on this machine right now - the exact hazard
// this guard exists to prevent, triggered by testing the guard itself.
// SWEEP_SUITE_LOCK_PATH lets a test point this at a throwaway file instead;
// left unset, production always resolves the real one.
```

## line 241

```
// A live (answering) candidate is reaped the recorded safe way - by SOCKET,
// never by pid (dead-ends/2026-08-07-killing-orphaned-tmux-servers-by-pid.md).
// A server that answered "no server running" between the probe and here is
// swallowed, not reported as a failure: it is the outcome we wanted, arrived
// at through a harmless race with whatever else is on the machine.
```

## line 256

```
// already gone
```

## line 261

```
// The wedged case: kill-server BLOCKS against a server that never answers,
// so it is never attempted here at all
// (dead-ends/2026-08-11-reaping-a-wedged-tmux-server-by-socket-alone.md). The
// fallback resolves BOTH live identifiers - socket (already excluded by
// orphanScratchServers' own enumeration, re-checked here as the dead-end
// asks) and the CURRENT process's own live server pid, when it is running
// inside one - and refuses to act unless lsof names exactly one pid for this
// specific socket file. An ambiguous or empty answer is left alone rather
// than guessed at; that is this population's version of the empty-list guard
// below, applied per-candidate instead of to the whole run.
```

## line 285

```
// Reporting only - a second, best-effort probe of a LIVE candidate for the
// session names a human reads to recognise what it is. orphanScratchServers'
// own probe already paid the cost of learning it answers; this is a second
// fork rather than plumbing the names through that return, because doctor's
// consumer has no use for them and this is the only caller that does.
```

## line 300

```
// best-effort: report the socket without names rather than fail the whole sweep over it
```

## line 313

```
// ---------------------------------------------------------------------------
// Live-session verification, run after EVERY destructive step, not once at
// the end (dead-ends/2026-08-11-reaping-a-wedged-tmux-server-by-socket-alone.md's
// own instruction). Safe on a machine with no hive session at all: no
// baseline means nothing to protect, never "reap everything".
// ---------------------------------------------------------------------------
```

## line 330

```
// no such session (or tmux not reachable) - nothing to verify
```

## line 335

```
// no live session existed before the sweep either
```

## line 348

```
// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
```

## line 359

```
// A deliberate one-off against the real store, exactly what storeDir()'s
// own refusal (src/dataDir.ts) names as the escape hatch for: sessionName()
// below only computes a TAG from the data dir path, it opens no database,
// but the guard is guilty-until-proven-innocent about anything outside
// hive's own CLI/MCP/hooks entrypoints. Set only if the caller has not
// already decided this for itself.
```

## line 386

```
// The parsed age, in the SAME unit as the threshold just printed above -
// not the raw etime. "age 01:56" beside "age >= 12h" reads as an hour
// fifty-six to a human deciding whether to pass --kill; it is one minute
// fifty-six. parseEtimeSeconds is already correct (etime is kept too,
// as the exact source value), this is a display fix only.
```

## line 402

```
// Checked once, up front, even in a dry run - a human deciding whether to
// pass --kill should see this before deciding, not discover it only after.
```

## line 417

```
// GUARD THE EMPTY-LIST CASE EXPLICITLY. Nothing below this line runs a
// tmux/kill call with an empty argument list - each loop below simply does
// not iterate when its population is empty, which is the same guarantee
// stated where it matters rather than left to fall out of the loop shape
// by accident. The message itself is gated the same way: printing
// "reaping..." with nothing to reap reads as an action that did not
// happen.
```

## line 471

```
// Only run when invoked directly, not when imported by a test.
```
