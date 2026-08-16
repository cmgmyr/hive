export const SLUG_MAX_LEN = 40;

const CONTROL_CHARS_RE = /[\x00-\x1F\x7F]+/g;
function stripControlChars(text: string): string {
  return text.replace(CONTROL_CHARS_RE, " ");
}

const ELLIPSIS = "…";
const CUT_BUDGET = SLUG_MAX_LEN - 1;

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
