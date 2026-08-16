# Attic: src/profiles.ts

Comments removed from `src/profiles.ts` by todo 436, verbatim. Line numbers are
positions in the pre-strip file at fed8064.

## line 7

```
// Profiles: a named set of standing instructions shared across projects.
//
//   <checkout>/profiles/<name>/<file>   hive's defaults, upgraded by git pull
//   <dataDir>/profiles/<name>/<file>    your overrides, copy-on-write
//
// Resolution is per FILE, not per profile, so a file you never forked keeps
// tracking hive's default while the ones you did are yours.
//
// Like dataDir.ts and tmux.ts, this module opens no database: kickoff has to
// answer "does this profile exist" before it is worth touching the store.
```

## line 21

```
// dist/profiles.js sits one level under the checkout root, next to the
// profiles/ and claude-plugin/ directories that ship with it. One place
// encodes that layout; `hive init` prints a path under it too.
```

## line 26

```
// A function, not a const: the store is chosen when someone asks, not when
// this module happens to load. See src/dataDir.ts.
```

## line 30

```
// hive.yml is repo-controlled and the resolved posture file is fed to claude
// as a system prompt, so a profile name must never be able to walk out of
// these two directories.
```

## line 67

```
// Read a profile file and substitute the project's vars. Every profile file
// goes through this: posture.md, runbook.md, and worker.md all advertise the
// same {{var}} and <!--if:--> syntax, so none of them may quietly not have it.
```

## line 79

```
// A profile exists as soon as either layer has a directory for it. A user
// directory holding only worker.md is still that profile; the other files
// resolve to hive's defaults.
```

## line 101

```
// What a fork was copied from, so `hive profile list` and `hive doctor` can
// say "upstream moved since you forked" without ever overwriting your copy.
```

## line 130

```
// True when this file is forked AND hive's shipped version changed after
// the fork. Reported, never acted on: the fork is the user's.
```

## line 133

```
// Fraction (0..1) of lines with no match between your fork and hive's
// CURRENT shipped file. null when this file is not forked, or the shipped
// side is unreadable. Independent of upstreamMoved/origins: upstreamMoved
// compares a hash recorded at fork time against hive's default today, which
// says whether hive moved but nothing about how far your fork is from it.
// This compares live content instead, so a doctor check can tell "you
// edited a few lines" from "this is a different document".
```

## line 151

```
// Order-blind, O(n+m): counts lines with no match on the other side rather
// than aligning them positionally (an LCS-based diff would, at O(n*m)).
// Exact alignment buys nothing here - the only question this feeds is
// whether a fork reads as an edited copy or a different document, and that
// distinction survives reordering fine. doctor runs often and a profile file
// has no size ceiling, so the cheap approximation is the deliberate choice.
```

## line 174

```
// Past this fraction of lines with no match on either side, a fork reads as a
// different document rather than an edited copy of hive's default: below it,
// most lines are still shared (drift); above it, most are not (rewrite). The
// midpoint is the natural place to draw that line and is not tuned to any one
// project's numbers - hive's own orchestration fork measures 77-99% per file,
// well clear of either side of it either way.
```

## line 216

```
// Copy-on-write: one file or the whole profile, never overwriting a fork you
// already have.
```

## line 265

```
// --- template rendering -------------------------------------------------
//
// {{var}} and not <VAR>: the runbook already uses <branch>, <N>, <files/area>
// as placeholders the MODEL fills from context, and substituting into those
// would corrupt the doc.
```

## line 278

```
// Line-based so blocks can nest: a section is kept only when every enclosing
// <!--if:--> is satisfied. Marker lines never survive. An unclosed block runs
// to the end of the file rather than throwing; a runbook that renders a
// little wrong beats one that refuses to print.
```

## line 300

```
// An undefined var stays visible as {{name}} rather than collapsing to an
// empty string: a runbook missing a value should look wrong, not silently
// read as though it had one.
```

## line 307

```
// A dropped section leaves the blank lines that framed it behind.
```

## line 312

```
// Every var a template references, in either form. `hive doctor` compares
// this against what the project defines.
```

## line 324

```
// `hive doctor` scans the same rendered profile text for pad and path
// references, so a referenced-but-missing pad or file announces itself the way
// a referenced-but-unset var already does. High-confidence shapes only: a
// fork's own prose is covered for free, at the cost of missing a bare unmarked
// mention like "the lessons pad". That miss is deliberate, not an oversight -
// it is what keeps this cheap enough to run unconditionally as a note.
```

## line 344

```
// Backticked only, deliberately: every real path reference in this project's
// own profiles is backticked, and restricting to it is what keeps a shell
// command or a prose sentence with a stray "/" from reading as a path. A
// token qualifies as path-shaped when it has no spaces, resolves as
// repo-relative (no leading `/` or `~`, so an absolute or home-relative path
// is out of scope on purpose - it is not "the project"), and contains a `/`.
//
// MEASURED, NOT SPECULATIVE: the plan for this check also allowed a bare
// filename with a known extension and no `/` (a `CLAUDE.md`-shaped
// reference). Run against the real orchestration fork at
// ~/.hive/profiles/orchestration, that branch's only catch was a false
// positive: runbook.md's "Read `working-on.md`" leans on a directory named
// one sentence earlier (`.claude/sessions/`) and means
// `.claude/sessions/working-on.md`, not a project-root file. Neither
// regression-bar path case (`.claude/rules/`, `scripts/covering-rules.mjs`)
// needs the bare-extension branch - both already contain a `/` - so it was
// dropped rather than special-cased. Narrowing per the plan's own license to
// do so on measurement, never to widen without saying why.
```
