# Attic: test/doctor-profile-references.test.mjs

Comments removed from `test/doctor-profile-references.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 8

```
// Todo 332. `hive doctor` already reports referenced-but-unset profile VARS
// (doctor-profile.test.mjs's sibling checks); a referenced-but-missing PAD or
// PATH is the same class of fact with a different noun, and nothing reported
// it. sideproj hit four of these adopting the orchestration profile in one
// night: pads "goal-prompts" and "lane-ledger", and paths `.claude/rules/`
// and `scripts/covering-rules.mjs`. Those four are the regression bar this
// file pins.
//
// The design is Option A (scan resolved profile prose for high-confidence
// shapes), not Option B (profiles declare their expected pads/paths) - see
// plan-332-doctor-references and todo 332 comment for the argument. THIS IS A
// NOTE, NEVER A GATE: decisions/2026-08-07-strict-promotes-only-gating-warns.md.
```

## line 47

```
// The one path reference in this fixture that genuinely exists in the
// project, so a real hit proves the "found and present" half stays quiet.
```

## line 54

```
// Baseline BEFORE the profile is wired up, so the failure/warning
// comparison below is a real delta from this check's own output, not a
// no-op comparison of "out" against itself.
```

## line 67

```
// Both regression-bar pads, sorted, and nothing else - "board" already
// exists (hive init seeds it), so it must not appear here.
```

## line 73

```
// Both regression-bar paths, sorted, and nothing else - `docs/notes.md`
// genuinely exists in this scratch project, so it must not appear here.
```

## line 81

```
// NON-GATING: an info-level note changes neither count.
```

## line 103

```
// Same reasoning as check 1/2 above (doctor-profile.test.mjs): checks
// that only need hive.yml must not gate on `here`. An unregistered
// project has no project row to look pads up against at all, so every
// referenced pad would trivially read "missing" - noise, not a finding -
// and the pad half is skipped entirely rather than reporting that.
```
