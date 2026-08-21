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

// Every field interpolated into text that hive types into a pane goes through here. A raw control byte
// reaches tmux as a keystroke rather than as text, so a \r in an interpolated name or body submits the
// prompt early and splits the message; flattening half a string is worse than none, because the next
// reader stops looking. Wider than stripControlChars above, which is the slug path and stays as it is.
export const flatten = (text: string): string =>
  text.replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim();
