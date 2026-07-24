import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function ok(data: unknown): CallToolResult {
  const text = typeof data === "string" ? data : JSON.stringify(data, null, 1);
  return { content: [{ type: "text", text }] };
}

export async function run(fn: () => unknown): Promise<CallToolResult> {
  try {
    return ok(await fn());
  } catch (e) {
    return { content: [{ type: "text", text: errorMessage(e) }], isError: true };
  }
}

export function parseTags(text: string): string[] {
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function matchesAnyTag(rowTags: string, wanted: string[] | undefined): boolean {
  if (!wanted || wanted.length === 0) return true;
  const tags = parseTags(rowTags);
  return wanted.some((t) => tags.includes(t));
}
