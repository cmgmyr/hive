# Attic: test/doctor-profile.test.mjs

Comments removed from `test/doctor-profile.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 8

```
// Issue #43. `hive doctor` said nothing when a project's hive.yml named a
// profile this machine does not have, so a lead could start with no standing
// process (posture, runbook, kickoff) and no hint why: kickoff.ts's own
// silence there is correct, but nothing else looked either. These pin the
// three checks doctor gained for the current project: a named profile
// profileExists() cannot find, a profile directory that resolves nothing at
// all (never a legitimate partial fork, which resolves fine), and
// `profile: none` with no runbook pad.
```

## line 17

```
// doctor runs the janitor, which reaches tmux; isolate first (test/CLAUDE.md).
```

## line 25

```
// dataDir is read at import time, so the store must be pointed at scratch
// before dist/db.js loads.
```

## line 31

```
// TEST CAVEAT (issue #43, non-negotiable, also in test/CLAUDE.md): never
// assert doctor's global exit code. Two recorded instances of that shape have
// cost this project a red CI, and comparing two exit codes saturates at 1 so
// the test passes even after the thing under test breaks. Compare the
// FAILURE COUNT the summary line carries instead - failureCount is shared
// via test/helpers.mjs now that a second file needs it (issue #27's L4 fix
// round R7, todo 171).
```

## line 45

```
// No profile key at all: out of scope, deliberately, and the baseline this
// file's failure-count deltas are measured against.
```

## line 50

```
// Counselors review on PR #47, finding 2 (both seats independently): every
// other test in this file only ever compares a DELTA against baseline, so a
// baseline that already contains a spurious profile failure would be
// silently absorbed into every one of them rather than caught. Concretely,
// dropping `config?.profile === NO_PROFILE &&` from check 3's condition in
// cli.ts (leaving `else if (here && !getActivePadByName(...))`) makes
// doctor FAIL every project with no profile: key and no runbook pad -- the
// commonest state there is, and the baseline's own state -- while every
// delta-based assertion in this file keeps passing unchanged. Pin the
// baseline itself, once, so that mutation is caught here rather than nowhere.
```

## line 61

```
// IMMUNE to generated data, for every `/FAIL {2}profile/` check in this
// file (six total): baseline.stdout does carry a generated project path
// elsewhere in doctor's report, but this exact phrase is not composed
// with it. `report()` in src/cli.ts prints `  ${level}  ${label}: ...`,
// and every call site in the profile checks passes the LITERAL strings
// "FAIL" and "profile" as level/label - nothing interpolated ever lands
// between them. A match here can only mean doctor genuinely emitted a
// profile failure line, never a coincidence of scratch-path text.
```

## line 87

```
// Counselors review on PR #47, finding 3. Every other test in this file
// runs `hive init` in before(), which registers the project, before ever
// running doctor -- so nothing above could have caught this. On a fresh
// clone, before anything has registered the project (no `hive init`, no
// `hive lead`, no MCP tool call), findProjectForCwd() returns null and the
// old code gated checks 1 and 2 on `here && profile`, so both were skipped
// entirely: `hive doctor` printed "All good." while hive.yml named a
// profile this machine does not have, which is issue #43's own opening
// scenario. hive.yml is still readable from the cwd doctor is actually run
// from regardless of registration, so this test never calls `hive init` at
// all -- registering the project first would make the bug this test exists
// to catch unreachable.
```

## line 113

```
// Counselors review on PR #47, findings 5 and 6 (opus and codex
// independently converged on the same reframe). The original check was
// "files.length === 0", i.e. existence of a resolved PATH; that is not
// proof of usable content, and it was also all-or-nothing, so a profile
// resolving SOME files but not runbook.md stayed silent even though a lead
// using it ends up with no standing process, the identical end state
// check 3 FAILs for under profile: none.
//
// Six tests below: the original all-unreadable case broadened from "no
// path resolves" to "no readable content", a genuinely new case a
// path-only check could not catch (existence without usability), the new
// runbook.md-specific failure using hive's own shipped profiles/simple/ as
// the real-world trigger (not a synthetic fixture: `hive profile create`
// itself produces exactly this shape), and three "must stay quiet" cases
// -- a non-runbook file missing, a REAL user-layer fork of a shipped
// profile (which the previous "stays quiet" test never built, finding 7:
// it only ever selected all-shipped profiles/simple/, so it could not have
// failed if per-file shipped fallback broke), and a runbook.md-missing
// profile that has a runbook PAD instead. The last one is Chris's own
// catch, by running doctor rather than reading it: the runbook.md check
// must be gated on the same pad escape hatch check 3 depends on, or
// `profile: simple` -- a profile hive itself ships -- fails doctor for
// every project that legitimately keeps its process in a pad.
```

## line 147

```
// resolveProfileFile accepts any existing path, including one that is
// not a regular file. A directory named posture.md resolves a path and,
// before this reframe, reported healthy -- contradicting the "nothing
// usable" reasoning the comment above reportProfile actually claims.
```

## line 159

```
// The next two tests each register their OWN project, in the same store
// (dataDir: dirs.dataDir, a different projectDir), rather than reusing the
// shared `dirs` project: that project's runbook-pad state depends on
// where in this file's execution order check 3 has archived it, and
// reusing it here would silently couple two unrelated tests through pad
// lifecycle -- exactly the shape that made the first version of the
// "fails" test below pass for the wrong reason (the shared project still
// had its hive-init-seeded pad active at this point, so it never actually
// hit the runbook.md-missing failure it claimed to pin).
```

## line 169

```
// profiles/simple/ ships only posture.md -- not a synthetic fixture:
// `hive profile create` itself writes only posture.md by default
// (src/profiles.ts), so this is the shape that command actually
// produces. `hive runbook` already exits 1 for profile: simple today;
// doctor saying nothing about it was the gap.
```

## line 185

```
// What DOES resolve is still reported alongside the failure.
```

## line 190

```
// Chris caught this by running doctor by hand, and neither counselors
// seat nor the gate found it: `simple` is a profile hive itself ships,
// and the runbook.md check above must not fail a project whose process
// legitimately lives in a runbook pad instead -- the same escape hatch
// check 3 depends on three tests below. This is the false-positive
// direction, and it is the one that matters for hive's own out-of-box
// experience.
```

## line 201

```
// hive init already seeded a runbook pad for this project; leave it be.
```

## line 206

```
// IMMUNE to generated data; see the baseline test at the top of this
// file for why.
```

## line 216

```
// worker.md deliberately absent from both layers: legitimate partiality,
// the same as profiles/simple/ missing runbook.md and worker.md.
```

## line 221

```
// IMMUNE to generated data; see the baseline test at the top of this
// file for why.
```

## line 229

```
// A user profile directory that forks exactly one file of a shipped
// profile: prove the other two still resolve from shipped, not from
// nowhere. profiles/orchestration/ ships all three files, so this
// constructs an actual fork rather than reusing an all-shipped profile
// that could never exercise the fallback at all.
```

## line 239

```
// IMMUNE to generated data; see the baseline test at the top of this
// file for why.
```

## line 253

```
// hive init already seeded a runbook pad on this project (it runs before
// any profile is chosen), so profile: none is not yet the reportable
// state; a project with a real, un-archived runbook pad must stay quiet.
```

## line 257

```
// IMMUNE to generated data; see the baseline test at the top of this
// file for why.
```

## line 270

```
// Counselors review on PR #47, finding 2 (both seats independently).
// Dropping `config?.profile === NO_PROFILE &&` from this branch's
// condition (leaving only `here && !getActivePadByName(...)`) makes
// doctor FAIL every project with no profile: key at all and no runbook
// pad -- not just profile: none -- and every OTHER assertion in this
// file still passes unchanged, because this file's own baseline (no
// profile: key) has a real pad and so stays quiet either way. The only
// state that tells the two conditions apart is no profile: key WITHOUT a
// pad, which nothing above constructs. pad is still archived from the
// step above; only hive.yml changes.
```

## line 282

```
// IMMUNE to generated data; see the baseline test at the top of this
// file for why.
```

## line 292

```
// Todo 326 comment 721: "hive's default changed since you forked it" cannot
// ever clear for a fork that is a deliberate rewrite, because it fires again
// every time hive's shipped default moves -- 100% of this project's own
// doctor warning output, permanently, on a fork the board says must never be
// reconciled by copying. Below, both cases fake "upstream moved" the same way
// profiles.test.mjs does (a bogus recorded origin hash), because the two
// checks under test -- warn survives small drift, info replaces it past the
// rewrite threshold -- only ever fire once upstreamMoved is already true;
// what should change is which of the two this codepath picks, not whether it
// fires at all.
```
