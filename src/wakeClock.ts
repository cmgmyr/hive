const MINUTE_MS = 60_000;
const SEARCH_BEFORE_MS = 26 * 60 * MINUTE_MS;
const SEARCH_AFTER_MS = 74 * 60 * MINUTE_MS;

export class InvalidClockRuleError extends Error {}

function invalidRule(): never {
  throw new InvalidClockRuleError("invalid clock schedule");
}

function partsAt(formatter: Intl.DateTimeFormat, instant: number): Record<string, string> {
  return Object.fromEntries(formatter.formatToParts(new Date(instant)).map(({ type, value }) => [type, value]));
}

function clockFormatter(at: string, zone: string): Intl.DateTimeFormat {
  if (!/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/.test(at) || !zone) invalidRule();
  try {
    const formatter = new Intl.DateTimeFormat("en-US-u-ca-iso8601-nu-latn", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    formatter.format(new Date(0));
    return formatter;
  } catch {
    return invalidRule();
  }
}

export function validateClockRule(at: string, zone: string): void {
  clockFormatter(at, zone);
}

export function nextClockDue(at: string, zone: string, afterMs: number): string {
  if (!Number.isFinite(afterMs)) invalidRule();
  const formatter = clockFormatter(at, zone);
  try {
    formatter.format(new Date(afterMs));
  } catch {
    return invalidRule();
  }

  const [hour, minute] = at.split(":").map(Number);
  const firstByDate = new Map<string, number>();
  const start = Math.floor(afterMs / MINUTE_MS) * MINUTE_MS - SEARCH_BEFORE_MS;
  const end = Math.floor(afterMs / MINUTE_MS) * MINUTE_MS + SEARCH_AFTER_MS;

  for (let instant = start; instant <= end; instant += MINUTE_MS) {
    const parts = partsAt(formatter, instant);
    if (Number(parts.hour) !== hour || Number(parts.minute) !== minute) continue;
    const date = `${parts.year}-${parts.month}-${parts.day}`;
    if (!firstByDate.has(date)) firstByDate.set(date, instant);
  }

  const next = [...firstByDate.values()].find((instant) => instant > afterMs);
  if (next === undefined) return invalidRule();
  return new Date(next).toISOString().slice(0, 19).replace("T", " ");
}
