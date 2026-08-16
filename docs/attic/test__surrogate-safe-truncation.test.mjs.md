# Attic: test/surrogate-safe-truncation.test.mjs

Comments removed from `test/surrogate-safe-truncation.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 6

```
// Todo 411. Three truncation helpers - dashboard.ts's truncateWithEllipsis,
// kickoff.ts's truncate, wakes.ts's truncateBody - sliced on raw UTF-16 code
// units, so a cut landing inside an astral character (a surrogate PAIR) could
// emit a lone surrogate half: not valid UTF-16, not round-trippable through
// UTF-8, and JSON.stringify has to escape it. src/slug.ts's fallbackSlug
// already had a surrogate-safe walk (todo 318); this lane extracted it as
// cutToUnitBudget and wired all three sites to it, keeping each site's own
// suffix and bound exactly as they were. Every function exercised here is
// pure - no tmux reached, no process spawned - but dist/tools/wakes.js's own
// import chain reaches src/db.js at module load, which refuses the real
// store under a test runner unless HIVE_DATA_DIR points at a scratch dir
// first (test/CLAUDE.md's store-isolation guard).
```

## line 22

```
// Mutation this file dies against: reverting any of the three call sites to
// its own naive `text.slice(0, N)` in place of `cutToUnitBudget(text, N)`.
```

## line 30

```
// Todo 411's own reproducer: 39 "e" then U+1F600 (an astral emoji, a UTF-16
// surrogate pair), then more text. A bound of 40 cuts exactly between the
// emoji's two halves under a naive code-unit slice: units 0-38 are the 39
// "e"s, units 39-40 are the emoji's high and low surrogate, and
// `.slice(0, 40)` keeps the high half and drops the low one.
```

## line 37

```
// cutToUnitBudget accumulates whole code points and stops BEFORE one that
// would overrun the budget (fallbackSlug's own documented behaviour) rather
// than including a partial one - so at the exact bug-reproducing offset (the
// emoji's own 2 units would push 39 e's to 41 against a 40 budget) the
// correct output drops the emoji whole instead of splitting it. To confirm
// the emoji survives when it actually FITS, `budget - 2` filler chars line
// it up so all of it lands inside the budget.
```

## line 68

```
// truncateBody has no parameter - its bound is fixed at 120, so the
// reproducer needs 119 filler chars rather than 39 to land the emoji
// exactly on that bound instead of the 40 the other two sites use.
```

## line 81

```
// Todo 411 warns against a user-visible length change as a side effect of
// the correctness fix. None of the three sites reserve budget for their
// suffix (unlike fallbackSlug, which has a zod round-trip constraint these
// sites don't share) - the suffix is appended AFTER the cut, so for
// BMP-only input the cut point, and therefore the whole output, must be
// byte-identical to what the old `.slice(0, N)` produced.
```
