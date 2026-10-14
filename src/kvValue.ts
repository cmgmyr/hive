export function decodeKvValue(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
