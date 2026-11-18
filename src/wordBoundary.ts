export function cutAtWordBoundary(text: string, max: number): string {
  const chars = [...text];
  if (chars.length <= max) return text;

  const prefix = chars.slice(0, max);
  if (/\s/u.test(chars[max])) return prefix.join("").trimEnd();

  for (let i = prefix.length - 1; i >= 0; i--) {
    if (/\s/u.test(prefix[i])) return prefix.slice(0, i).join("").trimEnd();
  }
  return prefix.join("").trimEnd();
}
