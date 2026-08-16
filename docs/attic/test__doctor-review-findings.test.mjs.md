# Attic: test/doctor-review-findings.test.mjs

Comments removed from `test/doctor-review-findings.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 17

```
// Todo 349 (pad 104, phase B2-ENCODE): "a wave must not close with untriaged
// review findings outstanding", made mechanically checkable. Pad 130's D1-D4.
//
// THE HEADLINE ASSERTION, stated so it can be checked rather than assumed:
// a store with tagged findings and no triage must produce the untriaged
// report, and a store with NO tagged findings at all must say so distinctly
// rather than reading as clean - the exact false-green
// .claude/sessions/dead-ends/2026-08-03-negative-control-that-disabled-its-own-check.md
// describes. Red-proved by hand against a build with the check's body
// commented out: every test below failed, including the zero-tagged one
// (the info line disappeared entirely rather than reading "0 tracked").
```

## line 41

```
// Resolved once, from THIS process's own real PATH, not hardcoded - tmux
// lives at /opt/homebrew/bin on a Mac dev machine and /usr/bin on CI's
// Ubuntu runner (apt-get install tmux, .github/workflows/ci.yml). A fixed
// guess picks one and silently FAILs "tmux" on the other, which would have
// blocked "All good." below for a reason that has nothing to do with this
// check - measured while writing this test: /usr/bin:/bin alone left tmux
// unresolved on this Mac.
```

## line 50

```
// Lead's fix-round correction: a bare `runCli` picks up whatever this
// developer's own machine happens to have - a dispatcher pinned to a
// different build (a GATING warn), a real registration, a `claude` binary
// that CI never installs at all (doctor-strict.test.mjs's own comment: "CI
// already exits 1 over a missing claude binary"). Any of those makes "All
// good." unreachable for a reason that has nothing to do with this check,
// which is exactly the saturated-comparison shape test/CLAUDE.md warns
// about - an assertion that can't fail proves nothing.
//
// So this builds a genuinely clean baseline, not just a non-gating one:
// CLAUDE_CONFIG_DIR/HIVE_BIN_DIR isolate away the real registration and
// dispatcher (same as doctor-strict.test.mjs), and PATH carries only what
// this specific run needs to resolve - node itself, tmux, and a fake
// `claude` stub (makeFakeClaude, the project's own existing fixture for
// exactly this) - rather than the real PATH, which would also carry
// whatever `hive` dispatcher this developer has pinned.
```

## line 73

```
// TMPDIR too (todo 375): doctor now reports orphaned scratch tmux
// servers, which it finds by reading os.tmpdir(). Without this, the
// "All good." control below asserts a fact about the DEVELOPER'S temp
// directory - one aged scratch socket left by any earlier run makes it
// unreachable, which is the same saturated-baseline shape this helper
// already exists to close for the dispatcher, the registration and the
// claude binary.
```

## line 84

```
// dirname(process.execPath) so `runCli` can still spawn `node` itself
// (it resolves the bare command name via this PATH, not
// process.execPath directly) - dropping it reproduces exactly the
// ENOENT test/CLAUDE.md warns a hostile-PATH fixture must not hide.
// /usr/bin:/bin stays on the end for `which` itself (doctor's own
// "claude" check shells out to it) - universal on both a Mac and CI's
// Ubuntu runner, unlike tmux, which is the one binary that actually
// moves between them (hence TMUX_DIR, resolved above rather than
// guessed).
```

## line 102

```
// An ordinary, untagged todo: present in the store, invisible to this
// check by design (D1's stated weakness), and must not be counted.
```

## line 107

```
// Never assert doctor's global exit code (test/CLAUDE.md) - an unrelated
// check (no `claude` binary on a bare CI runner, say) can fail it
// regardless of anything this test seeded.
```

## line 144

```
// Positive control, proven FIRST: in this isolated env, with nothing
// seeded yet, doctor genuinely prints "All good." - establishing that
// the negative assertion below actually discriminates, rather than
// failing to match for a reason that has nothing to do with this check
// (an ambient dispatcher warn on a bare runCli, or a missing `claude`
// binary - test/CLAUDE.md's "saturated comparison" shape, one level up
// from an exit code).
```

## line 166

```
// The lead's own correction on this lane: D1 originally listed five reader
// tags and omitted from-sideproj, which is a real gap - a live
// from-sideproj finding in this project (todo 339) had zero comments and
// was invisible to the check as first shipped. This pins the fix rather
// than only widening REVIEW_FINDING_TAGS and hoping the wildcard regexes
// above happen to still match.
```

## line 181

```
// Counselors, all three seats independently, on this lane's own diff:
// matchesAnyTag matches whole tags, so a finding filed as a per-run-
// numbered variant (from-counselors-23, say) reads as UNTAGGED to this
// check even though it was deliberately tagged - and the live store
// proves the shape is real, not hypothetical (todo 298 carries
// from-counselors-22, no bare from-counselors tag). Worse than D1's own
// stated weakness: an untagged finding at least makes the total read
// zero; a suffixed one keeps the total honest-looking while dropping the
// one finding that matters, silently. Red-proved: reverting
// isReviewFindingTag to matchesAnyTag(t.tags, REVIEW_FINDING_TAGS) makes
// this fail, reporting "0 tracked" instead of "1 tracked ... 1
// untriaged".
```

## line 204

```
// The companion negative control: a tag that merely CONTAINS a reader
// name must not match. `from-gatekeeper` is not `from-gate`, and prefix
// matching without the `-` separator would wrongly conflate them.
```

## line 225

```
// --strict changes what a warn counts for, not what prints: same warn
// count either way.
```

## line 228

```
// THE CASE THAT MATTERS: if this warn gated, --strict's problem count
// would be one higher than plain's. It is not - matching doctor-strict.
// test.mjs's own pattern for the identical claim on a different warn.
```
