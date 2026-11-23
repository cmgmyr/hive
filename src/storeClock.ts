export function parseStoreTimestamp(value: string): number {
  const normalized = /(Z|[+-]\d\d:?\d\d)$/.test(value) ? value : `${value.replace(" ", "T")}Z`;
  return new Date(normalized).getTime();
}
