# Attic: src/slug.ts

Comments removed from `src/slug.ts` by todo 436, verbatim. Line numbers are
positions in the pre-strip file at fed8064.

## line 1

```
// A leaf module with no imports of its own. Split out of src/tools/todos.ts
// so src/dashboard.ts can reuse fallbackSlug without pulling
// in that file's `../tmux.js` import - dashboard.ts's own header comment
// documents why it stays free of that dependency, the same reason
// src/firstPrompt.ts exists rather than reading its predicate off
// src/stateProvenance.ts.
```

## line 8

```
// Full rationale (free text vs kebab-case, the character bound,
// why a fallback rather than a backfill) is in the migration's own comment
// in src/db.ts; not repeated at each site below.
```

## line 13

```
// Same character class findUnsafeControlChar (src/tmux.ts) REFUSES for a
// supplied slug, but REPLACED here rather than refused: `title` has no such
// guard and carries it for every title-only todo, so this fallback still has
// to produce something safe to carry into a wake body, which is delivered
// VERBATIM into a pane - a bare CR submits the line early. Collapses a run
// to one space rather than deleting, so the words on either side of a
// stripped character don't glue together.
```

## line 25

```
// The slug tool param bounds a SUPPLIED slug with zod's z.string().max(),
// which counts UTF-16 CODE UNITS (.length), not code points - so this
// fallback's own output must respect that same unit or a slug read back from
// todo_get and fed straight into todo_update({slug}) is refused by the tool
// that produced it. CUT_BUDGET reserves one unit for the appended ellipsis
// (U+2026, a single BMP code unit) so cut.length + 1 never exceeds
// SLUG_MAX_LEN.
```

## line 35

```
// Walks whole code points (a `for...of` over a string iterates by
// code point, the same as Array.from), accumulating until the NEXT one would
// push the running UTF-16-unit count past `budget`, rather than slicing at a
// fixed code-point count or a fixed code-unit count - either of those can
// still split a surrogate pair or overrun the unit bound. This is the one
// surrogate-safe cut in the codebase; every truncation site reuses it rather
// than reimplementing it slightly weaker (the failure a /simplify pass found
// one step earlier, with findUnsafeControlChar).
// Deliberately does ONLY the cut: no ellipsis, no word-boundary trimming,
// since callers disagree on both and those are policy, not the hazard.
```
