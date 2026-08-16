# Attic: test/covering-rules.test.mjs

Comments removed from `test/covering-rules.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 62

```
// The defect PR #93's gate caught: an earlier version matched via
// fs.globSync against the filesystem, so a changed path with no file
// backing it on disk -- exactly what a delete or a rename leaves behind
// in `git diff --name-only` -- silently matched nothing. The path here is
// deliberately one that does not exist anywhere on this machine, not just
// one absent from a fixture: a path that happens to be real in THIS repo
// (src/tmux.ts, say) would pass against the old fs.globSync code too,
// since old coveringRules() defaulted repoRoot to the real checkout and
// would find it there by accident, discriminating nothing.
```

## line 100

```
// Counselors (todo 354) measured three real, load-bearing shapes the
// original four-pair version missed: a `.claude/rules/*.md` path (the
// exact PR #159 CLAUDE.md-table shape, reached from another doc's prose
// about a rule rather than the rule's own frontmatter), and a `.md` file
// under src/ or test/ (src/AGENTS.md, test/CLAUDE.md), which the original
// pairs excluded purely because the extension didn't match that prefix.
```

## line 114

```
// Still excluded on purpose: a bare filename with no directory at all.
// Recognising it means matching against the real repo's file tree, not a
// fixed shape -- the "relevance ranking" escalation line the todo itself
// named. See MENTION_RE's own comment.
```

## line 122

```
// A glob-shaped mention (Hole B): the character class allows `*`, so
// `` `src/tools/*.ts` `` is captured as a mention now, not silently
// dropped. What it matches against a diff is nameOnlyMentions()'s job, via
// matchesGlob -- see that describe block below.
```

## line 130

```
// The index-vs-claim distinction (Chris, todo 354): a table row names
// your file because the table names EVERYTHING, which carries no
// information; a paragraph names your file because it is making a claim
// ABOUT it. Table-row is the cheap syntactic proxy, checked against all
// three recorded failures -- see TABLE_ROW_RE's own comment for which
// stayed caught and which was dropped, and why dropping the third one
// loses nothing.
```

## line 178

```
// Hole B (counselors, todo 354): the original `changedFiles.includes(path)`
// check was a plain string equality, so a glob-shaped mention could never
// match a literal changed file even after mentionedPaths() started
// extracting one. First fix matched through matchesGlob() instead, the
// same primitive coveringRules() already uses -- and Chris then measured
// that fix against real multi-file lanes (not this file's own small diff)
// and found it unusable: `src/tools/*.ts` matched almost any changed
// TypeScript file, because matchesGlob answers "is this file under this
// glob", not "did this glob's MEMBERSHIP change". A category statement
// can never be falsified by editing one member of the category, only by
// one being added or removed -- PR #147's real failure shape agrees:
// docs/reviewer-preamble.md said "four rule files", and what falsified it
// was a rule file being ADDED, not any existing one's content changing.
// So a glob mention now matches only against `structuralFiles` (added or
// deleted), the third argument, which defaults to `changedFiles` so every
// literal-only test above keeps passing unchanged.
```

## line 202

```
// src/tools/wakes.ts changed, but structuralFiles is empty -- nothing
// was added or deleted, so the category's membership is unchanged.
```

## line 208

```
// The PR #159 shape stays intact deliberately: a LITERAL mention is
// already a claim about that one specific file, so it is unaffected by
// the structural restriction and still matches on an ordinary modify --
// exactly the case that made tmux-and-panes.md's own prose stale.
```

## line 241

```
// Names alone would still pass if content were read from the wrong path
// or dropped entirely -- assert the actual bytes, not just that a doc
// with the right name showed up.
```

## line 272

```
// This is the exact two-dot-vs-three-dot trap: `git diff --name-only
// main..HEAD` would report main's own post-fork commit (c.txt) as
// changed on the branch, because it diffs tip-to-tip rather than from
// the point the branch actually diverged.
```

## line 294

```
// The defect PR #93's gate caught on e5afc45: git's own rename detection
// (diff.renames, on by default) collapses a `git mv` into just the NEW
// path, so a plain `git diff --name-only` never lists the OLD, possibly
// rule-covered name at all. Verified by hand first (see the header
// comment above changedFiles()) before writing this: default output
// prints only src/renamed.ts; --no-renames prints both.
```

## line 343

```
// A `git mv` under --no-renames is a delete-of-old plus an add-of-new,
// same reasoning as changedFiles()'s own rename test -- and the right
// answer for THIS function specifically, per its own header comment: a
// rename really does change glob membership at both the old path (leaves
// it) and the new path (joins it), so both must read as structural, never
// as a single M that report() would then treat as a non-event.
```

## line 408

```
// End-to-end version of the delete/rename gap PR #93's gate found: the
// file is genuinely gone from the lane's working tree by the time
// report() runs, not just absent from a synthetic fixture. A
// filesystem-based matcher fails this exactly because `git diff
// --name-only` still lists the path while nothing on disk backs it.
```

## line 431

```
// End-to-end version of the rename gap PR #93's gate found on e5afc45:
// the new name (src/renamed.ts) matches no rule at all, so this can only
// pass if the OLD, rule-covered name (src/tmux.ts) reaches
// coveringRules() too -- exactly what --no-renames in changedFiles() is
// for. #81's own incident was this shape: src/config.ts, a second
// consumer of store-and-datadir.md's guard, missing from that rule's
// frontmatter until it was added by hand.
```

## line 456

```
// End-to-end version of Hole 1/2 (todo 354): CLAUDE.md names a changed file
// in prose, and a rule's prose names a second changed file its own globs
// do not cover. Neither reaches the strong "covers" list above; both must
// still surface, in the separate weaker category.
```

## line 468

```
// Two changed files, the mentioned one listed SECOND -- git sorts
// `diff --name-only` output alphabetically, so "aaa-" sorts before
// "cli.ts" regardless of add/commit order. An implementation that only
// checked changedFiles[0] would pass every other test here and still
// miss this one (test/CLAUDE.md shape 6, a fixture too small to reach
// the bound).
```

## line 496

```
// End-to-end version of the measurement that blocked the first version of
// this lane from merging: Chris ran covering-rules.mjs against real,
// multi-file historical diffs and found a glob-shaped mention like
// `` `src/tools/*.ts` `` matching almost any changed file, since
// matchesGlob answers "is this file under the glob", not "did the glob's
// MEMBERSHIP change" -- wired here as a real `git diff --name-status`
// through report() itself, not a hand-built array, so the fix is proven
// at the layer it actually has to hold at.
```

## line 512

```
// A pure modify: wakes.ts's content changes, but the src/tools/*
// category gains and loses nothing.
```

## line 523

```
// Now add a second tool file on the same branch -- real category
// membership change, and this is the shape that should fire.
```

## line 536

```
// End-to-end version of the fix that reduced CLAUDE.md from a dozen paths
// to what a reader would actually open: a table row naming src/cli.ts
// (an INDEX, no information -- the table names every module) stays
// silent, while a paragraph naming the same file (a CLAIM about it)
// still fires. This is PR #159's own two failures side by side in one
// doc: the table half is dropped here because it's exactly covered by
// the frontmatter-vs-table pin test instead; the prose half stays caught.
```

## line 618

```
// loadDocs()'s CLAUDE.md-optional skip (see its own comment) is deliberate
// for scratch fixtures; this is the one assertion that makes the loud
// backstop for the REAL repo deliberate too, rather than incidental
// cross-coverage from test/docs.test.mjs's own unconditional reads
// (counselors, todo 354).
```

## line 624

```
// Todo 380/382/383 split the README into docs/*.md pages. Every one of
// them used to match tmux-and-panes.md's own "docs/*.md" glob, same as
// docs/tmux.md already did - the "mildly wasteful and not a defect" cost
// the plan pad for todo 380 already named. Todo 437 dropped that glob
// (a prohibition about panes does not need to fire on a doc file), so
// this loop is now direct coverage of CLAUDE.md's docs list rather than
// incidental cross-coverage of a rule's frontmatter.
//
// docs/reviewer-preamble.md moved to .github/docs/reviewer-preamble.md
// in the same lane (todo 383, from Chris): it briefs the PR review
// workflow, not a page for a human reading the project's own docs, and
// moving it out of docs/ is what drops it from this list and from the
// tmux-and-panes.md glob it used to incidentally match.
```

## line 657

```
// Red-proof (todo 354): the exact shape PR #159 nearly shipped. At commit
// 8440b59 -- the parent of 61b6f6d, the doc-fix commit -- tmux-and-panes.md's
// own prose already named src/cli.ts (`git show
// 8440b59:.claude/rules/tmux-and-panes.md`, verified interactively), but its
// frontmatter did not yet list it. PRE_FIX_PROSE below is that revision's
// real text, excerpted verbatim (only elided with "..." for length, never
// paraphrased); PRE_FIX_FRONTMATTER is its real paths list, src/cli.ts
// missing exactly as it was. Frozen as a fixture rather than a live `git
// show` for the same reason as docs.test.mjs's sibling check: 8440b59 is
// unreachable from any branch or tag after PR #159's squash-merge, so it
// would not survive a fresh clone or a `git gc`, and this suite has to.
```
