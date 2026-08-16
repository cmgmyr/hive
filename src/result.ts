import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { Project } from "./context.js";

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function ok(data: unknown): CallToolResult {
  const text = typeof data === "string" ? data : JSON.stringify(data, null, 1);
  return { content: [{ type: "text", text }] };
}

const STORE_REPLACED_MESSAGE =
  "hive: the store on disk was replaced out from under this session (likely a restore). " +
  "This session has been writing to a file that no longer exists on disk; up to one tick " +
  "of writes may already be lost. Restart this session before doing anything else.";

export function registrationNoticeText(notice: Pick<Project, "id" | "path">): string {
  return (
    `hive: no registered project matched this session's working directory, so it created ` +
    `project ${notice.id} at "${notice.path}". If that's unintended: project_prune removes ` +
    `it if it owns nothing yet, run the session from the intended directory, or call ` +
    `project_select.`
  );
}

export async function run(fn: () => unknown): Promise<CallToolResult> {

  const { storeReplaced } = await import("./db.js");
  if (storeReplaced()) {
    return { content: [{ type: "text", text: STORE_REPLACED_MESSAGE }], isError: true };
  }

  const { takeRegistrationNotice } = await import("./context.js");
  let result: CallToolResult;
  try {
    result = ok(await fn());
  } catch (e) {
    result = { content: [{ type: "text", text: errorMessage(e) }], isError: true };
  }
  const notice = takeRegistrationNotice();
  if (notice) {
    result.content.push({ type: "text", text: registrationNoticeText(notice) });
  }
  return result;
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

export function withTrailingNewline(text: string): string {
  return text === "" || text.endsWith("\n") ? text : `${text}\n`;
}
