# Attic: scripts/covering-rules.mjs

Comments removed from `scripts/covering-rules.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 2

```
// Issue #84: makes "which rules cover this lane" mechanical instead of a
// memory exercise. Every .claude/rules/*.md file declares `paths:` globs in
// its frontmatter; this intersects a diff's changed files against those
// globs and prints which rules cover it, with no judgment required.
//
// Matches with node:path's matchesGlob, a pure string comparison, not
// fs.globSync. globSync answers "does this glob match a file that exists on
// disk right now", which is the right question for test/docs.test.mjs (is
// this rule dead, matching nothing real) and the wrong one here: a lane
// that DELETES a rule-covered file still has that path in changedFiles(),
// but the file is gone from the working tree, so a filesystem-based match
// silently drops it. That is the exact class of miss #84 exists to catch,
// reached through deletion instead of a missing frontmatter entry.
// matchesGlob asks the question this script actually has -- does this
// STRING match this pattern -- whether or not anything is there to back
// it. (An earlier version of this file used fs.globSync here too,
// reasoning that sharing docs.test.mjs's matcher couldn't disagree with
// it; that reasoning answered a different question than this one asks, and
// PR #93's gate caught the gap.)
//
// A RENAME is the same class of miss reached a second way, and matchesGlob
// alone does not cover it: git's own rename detection collapses a `git mv`
// (or a close-enough edit) into just the NEW path, so the old, rule-covered
// name never reaches changedFiles() at all. changedFiles() passes
// --no-renames to `git diff` specifically to stop that collapse -- see its
// own comment before treating that flag as a stray one to clean up.
//
// CLAUDE.md's Invariants section is named unconditionally, not matched
// against the diff: unlike a rule, it has no path scope; it applies to
// every lane by definition, so "no rule matched" is never the same as
// "nothing to re-read". README is deliberately not a candidate here: it is
// user-facing, changes for different reasons than an invariant does, and
// #83 pins its structure separately.
//
// Todo 354, second pass: coveringRules() above only sees a rule's `paths:`
// frontmatter, so a rule whose PROSE names a file its frontmatter does not
// glob is invisible to it -- exactly how PR #159 nearly shipped two
// sentences tmux-and-panes.md's own text had just made false, because
// src/cli.ts was not yet in that rule's paths list. mentionedPaths() /
// nameOnlyMentions() below are a second, deliberately weaker pass: they
// extract every backtick-quoted src/*.ts, test/*.mjs, scripts/*.mjs or
// docs/*.md path a doc's PROSE names, intersect that with the diff, and for
// a rule, subtract whatever its own globs already cover (no point telling a
// reader to re-check what coveringRules() already told them to). The
// candidate set is CLAUDE.md, docs/*.md, and every rule -- not just rules,
// since two of the three recorded failures were in CLAUDE.md and
// docs/reviewer-preamble.md, files coveringRules() never looked at because
// they carry no `paths:` frontmatter at all. README stays excluded, same
// reasoning as above. This is a mention scan, not a relevance ranker: it
// finds "this diff's file is named in this doc's text", nothing about
// whether the surrounding sentence is still true. Keep it that way -- do
// not grow this into a doc linter.
//
// MEASURED, twice, against four real historical multi-file bases (15ccdac,
// f97da4a, e37b312, 77401c0), not this file's own small diffs -- the first
// round (restricting glob mentions to add/delete-only, see
// nameOnlyMentions()'s own comment) cut paths-per-run by a fifth to a
// quarter but left doc-count nearly unchanged: 8-9 of 9 candidate docs named
// on every base. Reading the per-doc breakdown rather than the doc count
// found the real shape (Chris): it was never "nine walls", it was one wall
// (CLAUDE.md, a dozen paths) and eight one-or-two-line docs the count alone
// made look the same. The wall's cause was neither literal nor glob -- it
// was INDEX vs CLAIM. CLAUDE.md's architecture table and rules table exist
// to name every module and every rule's paths; naming your file carries
// zero information when the doc names everything. TABLE_ROW_RE (above)
// drops exactly that shape. Second round, same four bases: CLAUDE.md itself
// down to 1-2 paths, every other doc still one-or-two lines, weak-category
// section 8-9 lines total. Ships at that.
//
// This file needs Node 22.5.0: fs.globSync below landed in 22.0, and
// matchesGlob landed at 22.5.0 (backported to 20.17). package.json's
// engines.node used to claim ">=18", so a Node 18 or 20 run threw a
// SyntaxError at import before any code ran, including --help. A Node 20 leg
// was tried and failed on this file and on test/docs.test.mjs, which has
// depended on globSync all along without anything testing it -- that's what
// pushed the floor to 22.
//
// It no longer says ">=22.5.0", though: this comment made the exact mistake
// `.claude/rules/native-addon.md`'s own history warns about, twice over --
// counselors (todo 354) caught it stating a floor nothing ran. engines.node
// is now `"^22.14.0 || >=23.6.0"`, tightened for the ADDON's own ABI floor
// (Node-API 10), a stricter constraint than either version-gated API here
// ever needed. `.github/workflows/ci.yml` pins the primary leg at 22.14.0
// exactly (not a bare `22`, which silently resolves to whatever the latest
// 22.x is) and runs a dedicated `floor-boundary` job AT 22.13.1/23.5.0 and
// just above it at 23.6.0, so the floor is run, not reasoned about. See that
// rule file for the measurements; this file's own concern is narrower and
// still true on its own terms -- globSync/matchesGlob need at least 22.5.0,
// which the now-higher addon floor already clears.
```

## line 99

```
// Pulls the `paths:` glob list out of a rule file's frontmatter. Returns []
// for a file with no frontmatter or no paths, the same "never fires" case
// test/docs.test.mjs already flags as a dead rule.
```

## line 117

```
// A pure string match, deliberately not filesystem-based: see the header
// comment on why fs.globSync is wrong for this question. changedFiles here
// can include paths that no longer exist in the working tree (a delete or
// a rename shows up as one in `git diff --name-only`), and those still
// need to match.
```

## line 126

```
// Backtick-quoted repo paths only, and only these (dir, extension) pairs.
// Widened once already: counselors (todo 354) measured the original four
// pairs (src/*.ts, test/*.mjs, scripts/*.mjs, docs/*.md) against the real
// candidate set and found load-bearing misses the "no recorded failure
// needed it" reasoning had not accounted for -- test/CLAUDE.md and
// src/AGENTS.md (a `.md` under a prefix that only accepted a code
// extension), and every `.claude/rules/*.md` path (a prefix not in the set
// at all, which is the exact shape of PR #159's CLAUDE.md-table half: a
// rule file changes, and only a rule's own frontmatter, never another doc's
// PROSE about that rule, could be checked). The character class also now
// allows `*`, so a glob-shaped mention (`` `src/tools/*.ts` ``) is captured
// rather than silently dropped -- see nameOnlyMentions() below for how that
// mention is matched against the diff.
//
// Still narrower than the citation regexes elsewhere in this repo (which
// accept any dir/extension combination, because they only ask "does this
// cited path exist"): a bare filename with no directory at all (` `` `docs.
// test.mjs` `` `, ` `` `CLAUDE.md` `` `) is still invisible here, and stays
// that way on purpose. Recognising a bare basename means matching it against
// the real repo's file tree rather than a fixed shape, which is the
// "relevance ranking" this lane's own todo named as the line past which the
// fix becomes a different, harder problem, and beyond which this check
// starts becoming a doc linter. State the residual, don't chase it: run
// `covering-rules.mjs` and READ what it names, the same as any other rule it
// points at but cannot fully verify.
```

## line 154

```
// A markdown TABLE ROW, header or separator, per this repo's own
// convention: every one, in every file this script reads, starts with `|`
// (`| \`src/index.ts\` | ... |`, `|---|---|`). Chris measured the real gap
// after the add/delete-only fix (below): most docs on a real multi-file
// lane already named one or two paths, fine on their own, but CLAUDE.md
// alone still named a dozen, because its architecture table and rules table
// exist to name EVERY module and EVERY rule's paths -- an INDEX, which
// carries zero information by naming your file, since it names everything.
// A paragraph naming your file is making a CLAIM about it. Table-row is the
// cheap syntactic proxy for that distinction, checked against all three
// recorded failures before landing on it: PR #159's tmux-and-panes.md prose
// and PR #147's reviewer-preamble prose are both paragraphs, so both stay
// caught; PR #159's CLAUDE.md table IS a table row, so it is now dropped
// here -- and that loses nothing, because that exact case is already caught
// EXACTLY by the frontmatter-vs-table pin test in test/docs.test.mjs, which
// is strictly stronger than this pass's "go read this" hint. Two mechanisms
// on one failure, when one of them is exact, is redundant, not extra safety.
```

## line 182

```
// CLAUDE.md plus docs/*.md -- the two of the three recorded failures
// (PR #147, and the first half of PR #159's near-miss) that coveringRules()
// cannot see at all, since neither carries `paths:` frontmatter.
//
// CLAUDE.md's absence is skipped, not thrown on, deliberately -- and this is
// an asymmetry, not an oversight: `report()` below prints "CLAUDE.md
// Invariants section (always in scope)" unconditionally, the same
// assumption this script made before this pass existed (see that comment).
// A repo where CLAUDE.md does not exist is not one this script was written
// for, and every scratch fixture in this suite relies on the skip to avoid
// carrying a throwaway CLAUDE.md just to call report(). In the real repo
// this is backstopped, not merely assumed: test/docs.test.mjs reads
// CLAUDE.md unconditionally in a dozen places and fails loudly, before this
// script's own silence would ever be the only signal. docs/*.md never
// exercises this skip at all -- globSync only returns files that exist, so
// a missing docs/ directory already yields [] on its own.
```

## line 208

```
// The weaker pass Hole 1 needs: a doc "names" a changed file when its prose
// mentions a path that the diff also touched. `matchesGlob` is the same
// primitive coveringRules() above uses, and on a literal `path` with no
// wildcard it behaves as plain equality.
//
// A glob mention (`` `src/tools/*.ts` ``) is different, per
// changedFilesWithStatus()'s own comment: it is a category statement, so it
// only names a stale-claim risk against `structuralFiles` (an add or a
// delete -- membership changed), never against an ordinary modify. Measured
// on real multi-file lanes rather than assumed: matching a glob mention
// against EVERY changed file (`changedFiles`, the literal-mention pool)
// made every doc that names a category (CLAUDE.md's architecture table,
// above all) fire on nearly any diff, which is worse than not checking at
// all -- a report nobody reads is not a weaker signal, it is no signal.
// `structuralFiles` defaults to `changedFiles` so every literal-only test
// and call site keeps working unchanged; only report() below, which has
// real add/delete information, needs to pass it explicitly.
//
// For a doc with `globs` (a rule), a mention already matched by one of its
// own globs is dropped -- coveringRules() already surfaces that rule for
// that file, so repeating it here would only be noise. A doc with no
// `globs` (CLAUDE.md, docs/*.md; defaulted to `[]` so `.some()` is always
// false and every doc goes through the same line) has no coverage mechanism
// at all, so every mention that lands in the right pool is reported: that
// absence of a mechanism is Hole 2.
```

## line 246

```
// Triple-dot: diffs against the MERGE BASE with `base`, not against base's
// current tip. A two-dot diff on a branch that is behind base reports files
// on base as changed on the branch, which is not the question this answers.
//
// --no-renames is load-bearing, not a stray flag to tidy up. git's
// diff.renames defaults to on, so a `git mv` (or an edit similar enough for
// git's own heuristic to call it one) is reported as ONLY the new path;
// the old, rule-covered name never reaches changedFiles() at all, which
// drops a rule exactly as silently as the delete case above did. Verified
// against a real `git mv` in a scratch repo: default `--name-only` prints
// only the new path, `--name-status` shows R100 for the pair, and
// `--no-renames --name-only` prints both the old and the new path. This
// script wants the old path, so renames stay disabled here on purpose.
```

## line 267

```
// Chris measured this on real multi-file lanes (not this file's own small
// diff) and found the report unusable: a glob mention like CLAUDE.md's
// architecture-table `` `src/*.ts` `` matched via matchesGlob against
// almost any changed TypeScript file, since matchesGlob answers "is this
// file under this glob", not "did this glob's MEMBERSHIP change" -- a
// category statement is not a claim about any one file under it, and
// editing one file under a category can never falsify the category itself.
// PR #147's actual failure shape agrees: docs/reviewer-preamble.md said
// "four rule files" and what falsified it was a rule file being ADDED, not
// any existing rule file's contents changing.
//
// So a glob mention is only a stale-claim risk when the diff ADDS or
// DELETES a file the glob would match, never when it merely MODIFIES one --
// membership changed, not just content. A literal mention (`` `src/cli.ts`
// ``) is unaffected by this: it is already a claim about that one file, so
// it stays matched on any change, same as before.
//
// --name-status (not --name-only) is what tells the two apart, and
// --no-renames stays for the same reason changedFiles() above carries it: a
// `git mv` under --no-renames reports as D (old path) + A (new path), which
// is the right answer here too -- a rename removes the file from its old
// glob's membership and adds it to its new one, both real membership
// changes, neither of which --name-status under the default
// rename-detection would show at all (it would report the pair as a single
// R against the new path only, hiding that the old path's membership
// changed).
```

## line 343

```
// Checked separately from running the diff itself: an unresolved <base>
// otherwise reaches `git diff --name-only <base>...HEAD` as a bad rev, and
// git's own error names `git diff`, which points a reader at the wrong tool
// for a mistake made against this one.
```
