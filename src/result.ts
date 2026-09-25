import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { Project } from "./context.js";
import { runningBuildChange, runningBuildNotice } from "./version.js";

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

const reportedBuilds = new Set<string>();

type PendingNotices = { texts: string[]; build?: string };
const pendingNotices = new WeakMap<object, PendingNotices>();

function addNotice(result: CallToolResult, text: string, build?: string): void {
  result.content.push({ type: "text", text });
  const pending = pendingNotices.get(result) ?? { texts: [] };
  pending.texts.push(text);
  if (build) pending.build = build;
  pendingNotices.set(result, pending);
}

export function noticeFor(result: CallToolResult): string | undefined {
  return pendingNotices.get(result)?.texts.join("\n");
}

export function releaseNotice(result: CallToolResult): void {
  const build = pendingNotices.get(result)?.build;
  if (build) reportedBuilds.delete(build);
}

export async function appendRunningBuildNotice(result: CallToolResult, session?: string): Promise<CallToolResult> {
  try {
    const change = runningBuildChange();
    if (!change || reportedBuilds.has(change.disk.build_id)) return result;
    const actor = process.env.HIVE_AGENT_ID;
    if (actor) {
      const { db } = await import("./db.js");
      const row = db.prepare("SELECT kind FROM agents WHERE actor_id = ?").get(actor) as
        { kind: string } | undefined;
      if (row?.kind === "agent") return result;
    }
    if (reportedBuilds.has(change.disk.build_id)) return result;
    reportedBuilds.add(change.disk.build_id);
    addNotice(result, runningBuildNotice(change, session), change.disk.build_id);
  } catch {

  }
  return result;
}

export async function run(fn: () => unknown): Promise<CallToolResult> {

  const { storeReplaced } = await import("./db.js");
  if (storeReplaced()) {
    return appendRunningBuildNotice({ content: [{ type: "text", text: STORE_REPLACED_MESSAGE }], isError: true });
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
    addNotice(result, registrationNoticeText(notice));
  }
  return appendRunningBuildNotice(result);
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
