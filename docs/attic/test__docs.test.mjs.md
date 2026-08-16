# Attic: test/docs.test.mjs

Comments removed from `test/docs.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 8

```
// runCli spawns hive, whose commands probe tmux; isolate first (see helpers.mjs).
```

## line 12

```
// A command nobody can find is not shipped. The list of commands lives in one
// place in the source, so both checks read it from there rather than keeping a
// copy that drifts the first time someone adds a command.
```

## line 18

```
// A rule is now TWO files: the eager prohibitions under .claude/rules/ and the
// evidence behind them in the hive-internals skill, which loads only when
// something invokes it (todo 437). The assertions below pin that a claim is
// WRITTEN DOWN and that what it cites exists - questions about the pair, not
// about which half a sentence landed in. Asserting against the remnant alone
// would make every future move of a paragraph between the two a test failure.
```

## line 26

```
// Shared by the CLAUDE.md-table-vs-frontmatter pin below and its red-proof:
// both pull the list of backtick-quoted globs out of one table cell's text.
```

## line 29

```
// Also shared by both: the row-splitting regex that captures a rule's path
// and its Fires-on CELL separately. The red-proof below exists specifically
// because an earlier version ran backtickPaths() over a whole row string
// instead of through this regex first, and silently included the row's own
// `.claude/rules/x.md` path-cell as a phantom extra glob - see that test's
// own comment.
```

## line 43

```
// Same argument as COMMANDS, one surface over: the tmux settings hive tells a
// raw-attach user to set are the ones docs/tmux.md has to explain. IMPORTED,
// not transcribed and not scraped, so a fourth setting added to the CLI and
// not to the doc fails rather than shipping unexplained.
```

## line 65

```
// Guard the loop before trusting it: a for-loop over an empty array passes
// while proving nothing, which is the first of the false-green shapes
// test/CLAUDE.md names.
```

## line 73

```
// The WHOLE line, not the option name. Pinning the name alone would let
// the doc recommend pane-border-status bottom while the CLI prints top,
// and pass.
```

## line 82

```
// Moved from the README's own "Attach mode" section, which folded into
// this existing page rather than becoming a new one (the pad's plan for
// todo 380).
```

## line 88

```
// A doesNotMatch(/pane-border-status top.*~\/\.tmux\.conf/) used to sit
// here, guarding against telling a raw-attach user to add
// `pane-border-status top` to their own ~/.tmux.conf, back when README
// contained NEITHER string. docs/tmux.md is a full page about tmux
// options and legitimately contains both now, on unrelated lines (the
// list of settings hive sets automatically; a separate sentence saying
// hive never writes to ~/.tmux.conf) - `.` never crosses a newline, so
// this could only fail if both phrases later landed on ONE line, and
// would stay green even if the exact regression it was written for (that
// instruction, added on its own line) shipped. Removed rather than kept
// as a check that cannot fire on the failure it names.
```

## line 105

```
// Todo 275 (topology-3c). Sessions are one per STORE now, not one per
// project (`hive-main`, not `hive-<project_id>`); a doc still teaching the
// old naming sends a reader to attach at a session that does not exist.
// `\d+\b` alone would also flag the current, correct `hive-main` or a
// scratch store's hash-tagged `hive-<tag>-main` (the tag mixes letters and
// digits, and `\b` never falls inside one \w run), so this only matches
// what the old naming actually looked like: a project id, digits alone
// right after the prefix, or the literal `<project_id>` placeholder.
```

## line 128

```
// The Updating section used to promise no reinstall and no
// re-registration "on any machine". True until npm install rebuilds the
// addon under a different Node than the one the dispatcher names.
//
// The recipe invokes setup as `node dist/cli.js setup`, not bare `hive
// setup`: typing `hive setup` runs through the dispatcher, which execs
// the OLD pinned interpreter, and that interpreter may no longer be able
// to load the addon this same recipe just rebuilt -- src/cli.ts imports
// db.js at module scope, so guardAbi() would exit before cmdSetup ever
// ran. Verified by hand: reproduced that exact failure, then confirmed
// `node dist/cli.js setup` bypasses it and re-pins correctly.
```

## line 145

```
// Moved out of CLAUDE.md into a path-scoped rule, so it now has to be
// asserted where it actually lives. The claim is the mechanism ("does NOT
// load the addon"), not the consequence: a reader who only learns that
// require is insufficient still does not know what to run instead.
//
// Issue #105 lane B. better-sqlite3 13 moved to N-API, which is
// deliberately ABI-stable across Node majors, so the addon no longer
// cares which interpreter built it - the rule's opening claim changed
// with it (see the rule itself for the measurement). The lazy-binding
// trap this test exists for is unchanged, so that half is still pinned.
```

## line 161

```
// Issue #105 lane B1. "ABI-stable across Node majors" is true and, left
// unscoped, is what the rule used to say - it called the mismatch
// unreachable "on any platform" while Node 22.5.0 to 22.13.x segfaulted.
// The scope is the claim now, so it is pinned like one.
```

## line 167

```
// The other overclaim, which contradicted the issue #51 bullet in the same
// list: npm never invokes node-gyp for this package, so nothing falls back
// to a source build on its own.
```

## line 175

```
// CLAUDE.md used to assert "real data stays untouched" as a property when
// it was a convention, and it was false on the day it mattered. The
// invariant names what enforces it instead, which is only worth more than
// the old sentence for as long as the things it names are real.
```

## line 182

```
// The exact old claim, not the phrase: the rule quotes it to say what it
// replaced, and a check that cannot tell a quotation from a claim is the
// kind that gets deleted rather than satisfied.
```

## line 188

```
// The guards themselves, by name. Losing any of these means the rule
// stopped saying where the enforcement lives.
```

## line 199

```
// The root CLAUDE.md was cut from ~22k to ~6k by moving invariants into
// .claude/rules/, which only helps while the rules still fire and a reader
// can still find them. Three ways that silently stops being true, all
// checked here.
```

## line 210

```
// 1. A rule with no paths frontmatter never fires at all.
```

## line 216

```
// 2. A glob matching nothing is a dead rule, and nothing else would ever
// report it. This is the shape a renamed source file creates: the rule
// keeps existing, stops firing, and the invariant quietly leaves the
// project. Same family as the dead alternation branch in test/CLAUDE.md.
```

## line 225

```
// 3. Every repo path the prose cites must exist, same as for CLAUDE.md.
// OVER THE PAIR, not the remnant. Todo 437 moved the evidence into the
// skill and took 68 of the 78 citations with it, leaving 10 under this
// check: rename src/firstPrompt.ts and six references would go on citing
// a file that does not exist, with the suite green, which is the exact
// rot this is for. The reference half is required to exist, so a rule
// shipped without one fails here rather than silently losing its
// evidence.
```

## line 241

```
// 4. A rule the root does not index is invisible while planning, which
// is exactly when you need to know it exists: rules fire on file access,
// and planning happens before that.
```

## line 248

```
// Todo 354, the third recorded failure: PR #159's first doc commit
// (61b6f6d) added src/cli.ts to tmux-and-panes.md's own frontmatter but
// left CLAUDE.md's table (the "Fires on" column, a second hand-maintained
// copy of the same list) naming the old four files. Nothing caught it --
// test/docs.test.mjs pinned the frontmatter's STRUCTURE, not its
// agreement with the table, and covering-rules.mjs can't see CLAUDE.md's
// table either, since a table cell isn't `paths:` frontmatter. A second
// commit (0caa3fc) fixed just that row by hand.
//
// THE DESIGN CHOICE the todo asks for, made here rather than left silent:
// PIN the two hand-maintained copies against each other, don't GENERATE
// the column from frontmatter. Generating would delete the drift outright
// (this project's stated preference: 2026-08-05, "remove the decision
// rather than guard it") and was considered, but the table's "Covers"
// column is prose no generator can produce, so a generated "Fires on"
// would still sit beside a hand-maintained "Covers" in the same row --
// half-generated, not drift-proof, and the row-rewriting script that
// would require is a second surface this deliberately narrow lane (one
// script plus tests, per the todo) does not need. A test that fails loudly
// when the two disagree costs one assertion and pins both columns exactly
// like every other doc-consistency check already in this file.
```

## line 293

```
// Red-proof (todo 354): this is the real row and the real frontmatter as
// they stood at 61b6f6d, one commit before 0caa3fc fixed the row -- copied
// by hand from `git show 61b6f6d:CLAUDE.md` and `git show
// 61b6f6d:.claude/rules/tmux-and-panes.md` (verified interactively, not
// re-derived live here: both commits are unreachable from any branch or
// tag after PR #159's squash-merge, so a `git show` against them would not
// survive a fresh clone or a `git gc`, and this suite runs from exactly
// those). The point of freezing it as a fixture is that the comparison
// above is proven to fire on the actual historical miss, not just on a
// case built to satisfy it.
//
// Counselors (todo 354) found this test's first version was itself a
// false green (test/CLAUDE.md shape 7): it ran backtickPaths() over the
// whole `preFixRow` string, including column 1, so `tableGlobs` always
// carried the row's own `.claude/rules/tmux-and-panes.md` path as an extra
// element neither list could ever share -- `notDeepEqual` passed on that
// artifact alone, even with a Fires-on cell rigged to hold the exact,
// correct six-glob answer (verified by hand: swapping the cell for the
// fully-fixed one still left the assertion green). Fixed by running the
// fixture through the SAME `RULE_ROW_RE` the live test above uses, so this
// proves the extraction, not just a hand-picked pair of arrays.
```

## line 330

```
// Codex is a counselors review seat and reads AGENTS.md, not CLAUDE.md.
// Verified empirically: it loads both the root and the nested one without
// being asked to. Symlinks rather than copies, because two files with the
// same job drift, and the drift is silent until a reviewer argues from a
// stale invariant.
```

## line 340

```
// Codex has no equivalent of .claude/rules' paths globs, so the rules are
// invisible to it. src/AGENTS.md is what closes that gap; without it a
// codex seat reviews src/ with none of the invariants that constrain it.
```

## line 346

```
// Codex also has no skill mechanism, so the evidence behind each rule
// (todo 437) is equally invisible unless this file names the reference
// path beside it.
```

## line 359

```
// The root CLAUDE.md was cut from ~22k to ~11k by moving the suite's rules
// into test/CLAUDE.md, which only helps for as long as a reader can still
// find them. A pointer nobody checks is how the old "real data stays
// untouched" claim rotted: the file kept saying it long after it stopped
// being true. So pin the hop, not just the destination.
```

## line 368

```
// The two guards named in the root invariant have to be the two this file
// explains, or the pointer sends a reader somewhere that argues for
// something else.
```

## line 373

```
// The rules that exist because breaking them damaged the machine, rather
// than merely failing a test. Losing any of these silently is the whole
// risk of having moved them out of the always-loaded file.
```

## line 380

```
// Same citation rule as above: every repo path this file names must exist,
// since a renamed test file is exactly what leaves a doc naming a guard
// nobody can find.
```

## line 390

```
// Issue #83. The CLI half above has been pinned for a while; this is the same
// idiom applied to the MCP half, which never had it: 42 tools registered
// across src/tools/*.ts, a README table describing them, and src/help.ts
// naming them in prose, with nothing connecting the three before this.
//
// toolRegistrationsByFile() and registeredToolNames() (test/helpers.mjs) do
// the parsing, shared with test/tool-registration.test.mjs, so this file and
// that one read one list rather than keeping two copies of the same regex
// that could silently agree on the same wrong answer. See that function's own
// comment for why a second copy of the pattern is the exact risk this lane
// exists to remove.
//
// THE HONEST LIMIT, stated here because this is where a reader lands after
// trusting a green run: every assertion below is ONE-DIRECTIONAL. It catches
// "the registration names something the docs never mention" (or the reverse,
// where the two-way checks below say so explicitly). It cannot catch a doc
// paragraph that is simply WRONG about what a tool does or how a variable
// behaves - that is a prose-accuracy question, and no regex answers it. A
// green suite here means the surface is not silently omitted, not that the
// words next to it are correct.
```

## line 414

```
// The Tools table moved to its own page (todo 380/382), so this reads
// docs/tools.md rather than README.md now. The section runs from the page's
// own heading to the end of the file, since nothing else shares the page.
```

## line 422

```
// A tool row is "| `tool_name` | ...". The group header rows ("|
// **pads** | | |") carry no backtick name and never match this pattern.
```

## line 427

```
// Guard the extraction before trusting it, matching the loop-over-empty-
// array shape test/CLAUDE.md names as the first false-green.
```

## line 430

```
// The same blind spot tool-registration.test.mjs guards against: a tool
// name this regex cannot see (a digit or hyphen in the literal) makes
// registerTool( occurrences outnumber parsed names. Checked independently
// here so this file's own pin does not depend on that file having run.
```

## line 441

```
// Two-way, or the check rots: a one-way "every tool is documented" still
// passes after a tool is deleted and its row left behind, same as the
// CLI shape above.
```

## line 464

```
// Issue #83 item 3. Every HIVE_* variable actually read from process.env
// under src/ has to appear in README or src/help.ts, or be on the
// exemption list below with a reason. The exemption list is the feature:
// it turns an undocumented variable into a line someone deliberately
// wrote, rather than a gap nobody saw.
```

## line 475

```
// src/backup.ts's envInt(name, fallback) reads process.env[name] where
// name arrives as a string literal one call away; a bare
// process.env.HIVE_X scan never sees through that indirection, so it
// is matched here by the call site instead.
```

## line 484

```
// HIVE_PROJECT_ID is deliberately undocumented (issue #63): src/context.ts
// and src/spawn.ts mention it only inside comments explaining why a
// worker's project pin does NOT come from it. It is never actually read
// from process.env, so HIVE_ENV_VARS above never contains it today - the
// negative assertion below checks that directly, so the day someone wires
// it up for real the exemption stops applying instead of grandfathering
// the omission in silently.
```

## line 514

```
// Issue #83 item 4. The table names 13 of the 30 files under src/*.ts,
// and always has, including files (src/spawn.ts, src/strictInput.ts)
// other rules treat as load-bearing - an exhaustive table would need
// every file added since, which this project does not do at this
// granularity anywhere else. Curated is the decision; this line is what
// stops an absent file from reading as an oversight.
```
