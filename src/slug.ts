// A leaf module with no imports of its own. Split out of src/tools/todos.ts
// so src/dashboard.ts can reuse fallbackSlug without pulling
// in that file's `../tmux.js` import - dashboard.ts's own header comment
// documents why it stays free of that dependency, the same reason
// src/firstPrompt.ts exists rather than reading its predicate off
// src/stateProvenance.ts.

// Full rationale (free text vs kebab-case, the character bound,
// why a fallback rather than a backfill) is in the migration's own comment
// in src/db.ts; not repeated at each site below.
export const SLUG_MAX_LEN = 40;

// Same character class findUnsafeControlChar (src/tmux.ts) REFUSES for a
// supplied slug, but REPLACED here rather than refused: `title` has no such
// guard and carries it for every title-only todo, so this fallback still has
// to produce something safe to carry into a wake body, which is delivered
// VERBATIM into a pane - a bare CR submits the line early. Collapses a run
// to one space rather than deleting, so the words on either side of a
// stripped character don't glue together.
const CONTROL_CHARS_RE = /[\x00-\x1F\x7F]+/g;
function stripControlChars(text: string): string {
  return text.replace(CONTROL_CHARS_RE, " ");
}

// The slug tool param bounds a SUPPLIED slug with zod's z.string().max(),
// which counts UTF-16 CODE UNITS (.length), not code points - so this
// fallback's own output must respect that same unit or a slug read back from
// todo_get and fed straight into todo_update({slug}) is refused by the tool
// that produced it. CUT_BUDGET reserves one unit for the appended ellipsis
// (U+2026, a single BMP code unit) so cut.length + 1 never exceeds
// SLUG_MAX_LEN.
const ELLIPSIS = "…";
const CUT_BUDGET = SLUG_MAX_LEN - 1;

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
export function cutToUnitBudget(text: string, budget: number): string {
  let cut = "";
  for (const ch of text) {
    if (cut.length + ch.length > budget) break;
    cut += ch;
  }
  return cut;
}

export function fallbackSlug(title: string): string {
  const trimmed = stripControlChars(title).trim();
  if (trimmed.length <= SLUG_MAX_LEN) return trimmed;
  const cut = cutToUnitBudget(trimmed, CUT_BUDGET);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > CUT_BUDGET / 2 ? cut.slice(0, lastSpace) : cut) + ELLIPSIS;
}
