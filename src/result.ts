import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
// Type-only: erased at compile time, so this does not reintroduce the
// eager-store-open problem the lazy `await import("./context.js")` below
// exists to avoid.
import type { Project } from "./context.js";

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function ok(data: unknown): CallToolResult {
  const text = typeof data === "string" ? data : JSON.stringify(data, null, 1);
  return { content: [{ type: "text", text }] };
}

// Issue #49. run() is the choke point every registered tool's handler routes
// through, verified per file, so it is the one place a guard covers new
// tools for free. Checked before fn() runs, for every call including reads:
// a read served off an orphaned inode is stale state reported as current,
// the same defect class this guard exists to catch, not a lesser one.
// Distinguishing reads from writes here would need a per-tool annotation,
// reintroducing the "someone adds a tool later and forgets" failure the
// choke point was chosen to avoid.
const STORE_REPLACED_MESSAGE =
  "hive: the store on disk was replaced out from under this session (likely a restore). " +
  "This session has been writing to a file that no longer exists on disk; up to one tick " +
  "of writes may already be lost. Restart this session before doing anything else.";

// Shared with src/cli.ts's own resolveProject, which reaches the same
// resolveHomeProject fallback through effectiveProjectId and is not covered
// by this file's run() choke point (run() only wraps the MCP tool layer).
export function registrationNoticeText(notice: Pick<Project, "id" | "path">): string {
  return (
    `hive: no registered project matched this session's working directory, so it created ` +
    `project ${notice.id} at "${notice.path}". If that's unintended: project_prune removes ` +
    `it if it owns nothing yet, run the session from the intended directory, or call ` +
    `project_select.`
  );
}

export async function run(fn: () => unknown): Promise<CallToolResult> {
  // Imported lazily, not at module top level: result.ts is pulled in by
  // modules (projectYml.ts) that must NOT open the store merely by being
  // imported (see test/store-isolation.test.mjs, "naming a store is not
  // opening one"). db.ts opens the database in its own module body, so a
  // static import here would make importing result.js do the same. A real
  // tool call already needs a live store to do anything, so deferring the
  // import to here costs nothing a genuine call wasn't already going to pay.
  const { storeReplaced } = await import("./db.js");
  if (storeReplaced()) {
    return { content: [{ type: "text", text: STORE_REPLACED_MESSAGE }], isError: true };
  }
  // Imported here, AFTER the guard above, not concurrently with db.js's own
  // import: context.ts opens the store the same way db.js does (see the
  // comment above), so starting its module load before storeReplaced() has
  // had a chance to refuse would run that load ahead of the exact guard it
  // exists to respect. Nothing pins that context.ts's module body stays that
  // cheap. Overlapping the two imports was never worth that risk anyway:
  // context.js is already in the module cache by the time a genuine tool
  // call reaches here (every src/tools/*.ts file imports it statically), so
  // this import() call never does real work, only resolves an
  // already-cached entry - the only case where starting it early would have
  // saved anything real is the one case it is not safe to run early in.
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

// Terminal output and files both want exactly one trailing newline, and an
// empty string wants none: `hive pad` on an empty pad should print nothing,
// not a blank line.
export function withTrailingNewline(text: string): string {
  return text === "" || text.endsWith("\n") ? text : `${text}\n`;
}
