import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { db } from "../db.js";
import { currentActor, effectiveProjectId, resolveProject } from "../context.js";
import { matchesAnyTag, parseTags, run } from "../result.js";
import { idParam, limitParam, offsetParam, projectIdParam } from "./params.js";

export interface PadRow {
  id: number;
  project_id: number;
  name: string;
  content: string;
  revision: number;
  tags: string;
  archived: number;
  updated_by: string | null;
  updated_at: string;
}

type PadMeta = Pick<PadRow, "id" | "name" | "revision" | "archived">;

function selectPad<T>(projectId: number, padId: number, columns: string): T {
  const row = db
    .prepare(`SELECT ${columns} FROM scratchpads WHERE project_id = ? AND id = ?`)
    .get(projectId, padId) as T | undefined;
  if (!row) throw new Error(`No pad with id ${padId} in project ${projectId}. Call pad_list.`);
  return row;
}

function getPad(projectId: number, padId: number): PadRow {
  return selectPad<PadRow>(projectId, padId, "*");
}

// Pads hold the large blobs in this store; mutations that never touch the
// content skip fetching it. Exported for test/pad-revision-race.test.mjs:
// the real race window is a handful of synchronous SQL statements wide,
// too narrow to hit reliably by racing two real OS processes (their IPC and
// scheduling jitter is milliseconds; the window is sub-microsecond), so that
// test reconstructs the interleaving directly by calling this and bumpPad
// as a deliberately-raced pair of sessions rather than chasing a flaky
// racer - see that file's own comment.
export function getPadMeta(projectId: number, padId: number): PadMeta {
  return selectPad<PadMeta>(projectId, padId, "id, name, revision, archived");
}

// Shared by checkRevision's early check and bumpPad/deletePad's SQL-level
// guard below, so a caller sees the same sentence whether the mismatch was
// visible from our own read or only showed up in the WHERE clause. `current
// == null` means the row is gone entirely (deleted by a concurrent write
// between our read and this one), which is a different fact than a changed
// revision and gets its own message.
function revisionMismatchError(padId: number, expected: number | undefined, current: number | null): Error {
  if (current == null) {
    return new Error(
      `Pad ${padId} no longer exists; it may have just been deleted by another write. Call pad_list to confirm.`,
    );
  }
  return new Error(
    `Revision mismatch for pad ${padId}: expected ${expected}, current ${current}. Re-read with pad_read and retry.`,
  );
}

function currentRevisionOrDeleted(padId: number): number | null {
  const row = db.prepare("SELECT revision FROM scratchpads WHERE id = ?").get(padId) as
    | { revision: number }
    | undefined;
  return row?.revision ?? null;
}

// Shared by bumpPad and pad_delete's own guarded DELETE: both run a
// predicate-conditioned write and need the identical "0 rows changed" throw.
function assertRowChanged(padId: number, predicateRevision: number | undefined, changed: boolean): void {
  if (!changed) {
    throw revisionMismatchError(padId, predicateRevision, currentRevisionOrDeleted(padId));
  }
}

// The friendly PRE-check: rejects early, with a clear message, when the
// caller supplied expected_revision and it already disagrees with our own
// read. This cannot be the actual guard - another write can still land
// between this check and the UPDATE below - so bumpPad's WHERE clause is
// what a concurrent write is actually checked against.
function checkRevision(pad: PadMeta, expected: number | undefined, required: boolean): void {
  if (expected == null) {
    if (required) {
      throw new Error(
        `expected_revision is required to overwrite pad ${pad.id}. Current revision: ${pad.revision}. Read it first with pad_read.`,
      );
    }
    return;
  }
  if (expected !== pad.revision) {
    throw revisionMismatchError(pad.id, expected, pad.revision);
  }
}

// Every pad mutation bumps the revision and stamps the writer. When
// predicateRevision is given, the UPDATE itself is conditioned on it (`AND
// revision = ?`), so a write that raced in between checkRevision's read and
// this statement makes THIS call a no-op instead of silently overwriting it
// - the actual guard, not just the friendly pre-check above. RETURNING hands
// back the authoritative post-write revision instead of a value computed
// from a stale read, which is also why a caller with no predicate (pad_append
// with no expected_revision, pad_archive) still goes through this path
// rather than a bare .run(): the previous version discarded the write's own
// row count and could report success for zero rows changed. Exported for the
// same test as getPadMeta above.
export function bumpPad(padId: number, predicateRevision: number | undefined, set: string, ...params: unknown[]): number {
  const where = predicateRevision != null ? "id = ? AND revision = ?" : "id = ?";
  const whereParams = predicateRevision != null ? [padId, predicateRevision] : [padId];
  const row = db
    .prepare(
      `UPDATE scratchpads SET ${set}, revision = revision + 1,
       updated_by = ?, updated_at = datetime('now') WHERE ${where} RETURNING revision`,
    )
    .get(...params, currentActor(), ...whereParams) as { revision: number } | undefined;
  assertRowChanged(padId, predicateRevision, row != null);
  return row!.revision;
}

// Fix round 1, both counselor seats independently. pad_append's own content
// concatenation is safe against the live column, but the SEPARATOR used to
// be decided in JS from `pad.content` AS READ - a `joined` variable computed
// once, well before this statement runs. Two sessions both reading content
// that ends in a newline both decide joined = "", and whichever writes
// second glues its entry onto the first's with no separator at all ("alpha\n"
// + A's "" + "A-entry" landing on top of B's own already-appended
// "alpha\nB-entry" produces "alpha\nB-entryA-entry"). The CASE here reads
// the live `content` column in the SAME statement as the append, so there is
// no read-then-decide step left to go stale - exactly the property pad_append
// already had for the append itself, extended to the separator too.
// Exported so test/pad-append-live-separator.test.mjs exercises the real
// fragment rather than a copy of it.
export const APPEND_WITH_SEPARATOR_SET =
  "content = content || (CASE WHEN content = '' OR substr(content, -1) = char(10) THEN '' ELSE char(10) END) || ?";

// Shared with the CLI (hive pad): exact-name lookup among active pads.
export function getActivePadByName(projectId: number, name: string): PadRow | undefined {
  return db
    .prepare("SELECT * FROM scratchpads WHERE project_id = ? AND name = ? AND archived = 0")
    .get(projectId, name) as PadRow | undefined;
}

// Shared with the CLI (hive pads).
export type PadListRow = Pick<PadRow, "name" | "revision" | "updated_by" | "updated_at"> & {
  content_length: number;
};

export function listActivePads(projectId: number): PadListRow[] {
  return db
    .prepare(
      `SELECT name, revision, length(content) AS content_length, updated_by, updated_at
       FROM scratchpads WHERE project_id = ? AND archived = 0 ORDER BY name`,
    )
    .all(projectId) as PadListRow[];
}

// Shared with the CLI (hive pad --save): revision-guarded overwrite.
// Returns the new revision.
export function overwritePadContent(
  projectId: number,
  padId: number,
  content: string,
  expectedRevision: number,
): number {
  const pad = getPadMeta(projectId, padId);
  checkRevision(pad, expectedRevision, true);
  return bumpPad(padId, pad.revision, "content = ?", content);
}

// Shared with the CLI (hive init). Returns null when an active pad already
// holds the name; the partial unique index enforces that race-free.
export function createPad(
  projectId: number,
  name: string,
  content: string,
  tags: string[],
): number | null {
  const row = db
    .prepare(
      `INSERT OR IGNORE INTO scratchpads (project_id, name, content, tags, updated_by)
       VALUES (?, ?, ?, ?, ?) RETURNING id`,
    )
    .get(projectId, name, content, JSON.stringify(tags), currentActor()) as
    | { id: number }
    | undefined;
  return row?.id ?? null;
}

export function registerPads(server: McpServer): void {
  server.registerTool(
    "pad_write",
    {
      description:
        "Create a pad, or fully overwrite one by passing pad_id plus expected_revision. Pad names are unique per project. Prefer pad_append/pad_edit for targeted changes.",
      inputSchema: {
        name: z.string(),
        content: z.string(),
        tags: z.array(z.string()).optional(),
        pad_id: idParam.optional().describe("Pass with expected_revision to overwrite."),
        expected_revision: idParam.optional(),
        project_id: projectIdParam,
      },
    },
    (args) =>
      run(() => {
        const projectId = effectiveProjectId(args.project_id);
        if (args.pad_id != null) {
          const pad = getPadMeta(projectId, args.pad_id);
          checkRevision(pad, args.expected_revision, true);
          const revision = bumpPad(
            pad.id,
            pad.revision,
            "name = ?, content = ?, tags = COALESCE(?, tags)",
            args.name,
            args.content,
            args.tags ? JSON.stringify(args.tags) : null,
          );
          return { pad_id: pad.id, revision };
        }
        const padId = createPad(projectId, args.name, args.content, args.tags ?? []);
        if (padId == null) {
          throw new Error(
            `A pad named "${args.name}" already exists in this project. Read it with pad_read(name="${args.name}"), then overwrite with pad_id + expected_revision, or pick another name.`,
          );
        }
        return { pad_id: padId, revision: 1 };
      }),
  );

  server.registerTool(
    "pad_read",
    {
      description: "Read a pad's content, revision, and metadata by pad_id or name.",
      inputSchema: {
        pad_id: idParam.optional(),
        name: z.string().optional(),
        project_id: projectIdParam,
      },
    },
    (args) =>
      run(() => {
        const projectId = effectiveProjectId(args.project_id);
        let pad: PadRow;
        if (args.pad_id != null) {
          pad = getPad(projectId, args.pad_id);
        } else if (args.name) {
          const row = db
            .prepare("SELECT * FROM scratchpads WHERE project_id = ? AND name = ? AND archived = 0")
            .get(projectId, args.name) as PadRow | undefined;
          if (!row) throw new Error(`No active pad named "${args.name}". Call pad_list.`);
          pad = row;
        } else {
          throw new Error("Pass pad_id or name.");
        }
        return {
          pad_id: pad.id,
          name: pad.name,
          revision: pad.revision,
          tags: parseTags(pad.tags),
          updated_by: pad.updated_by,
          updated_at: pad.updated_at,
          content: pad.content,
        };
      }),
  );

  server.registerTool(
    "pad_append",
    {
      description:
        "Append content to the end of a pad. Optional expected_revision guards against concurrent writes.",
      inputSchema: {
        pad_id: idParam,
        content: z.string(),
        expected_revision: idParam.optional(),
        project_id: projectIdParam,
      },
    },
    (args) =>
      run(() => {
        const projectId = effectiveProjectId(args.project_id);
        // getPadMeta, not getPad: content is no longer read in JS at all
        // (see APPEND_WITH_SEPARATOR_SET) now that the separator decision
        // moved into the write statement itself, so there is nothing left
        // here that needs the content column.
        const pad = getPadMeta(projectId, args.pad_id);
        checkRevision(pad, args.expected_revision, false);
        // Predicate is the CALLER'S expected_revision, not our own read: the
        // append itself concatenates in SQL against the live row, so it never
        // clobbers a concurrent change and needs no guard when the caller
        // did not ask for one. When they did, the predicate closes the gap
        // between checkRevision's read above and this statement. The
        // separator is decided in the same statement too (see
        // APPEND_WITH_SEPARATOR_SET) - not from `pad.content` above, which
        // may already be stale by the time this runs.
        const revision = bumpPad(pad.id, args.expected_revision, APPEND_WITH_SEPARATOR_SET, args.content);
        return { pad_id: pad.id, revision };
      }),
  );

  server.registerTool(
    "pad_edit",
    {
      description:
        "Replace one literal occurrence of old_text with new_text in a pad. old_text must match exactly once; include surrounding context to disambiguate.",
      inputSchema: {
        pad_id: idParam,
        old_text: z.string(),
        new_text: z.string(),
        expected_revision: idParam.optional(),
        project_id: projectIdParam,
      },
    },
    (args) =>
      run(() => {
        const projectId = effectiveProjectId(args.project_id);
        const pad = getPad(projectId, args.pad_id);
        checkRevision(pad, args.expected_revision, false);
        const parts = pad.content.split(args.old_text);
        const occurrences = parts.length - 1;
        if (occurrences === 0) {
          throw new Error(`old_text not found in pad ${pad.id}. Re-read with pad_read.`);
        }
        if (occurrences > 1) {
          throw new Error(
            `old_text matches ${occurrences} places in pad ${pad.id}. Include more surrounding context so it matches exactly once.`,
          );
        }
        // Predicate is ALWAYS our own read revision, expected_revision or
        // not: old_text/new_text is computed here in JS against pad.content
        // as read above, so a write is lost exactly like pad_write's full
        // overwrite would be if this UPDATE were unconditional. An omitted
        // expected_revision means the caller stated no expectation, not that
        // losing a concurrent write is fine.
        const revision = bumpPad(pad.id, pad.revision, "content = ?", parts.join(args.new_text));
        return { pad_id: pad.id, revision };
      }),
  );

  server.registerTool(
    "pad_archive",
    {
      description:
        "Archive a pad (or unarchive with archived=false). Archiving frees the name for a new active pad; the old content stays readable by pad_id.",
      inputSchema: {
        pad_id: idParam,
        archived: z.boolean().optional().describe("Default true. Pass false to unarchive."),
        project_id: projectIdParam,
      },
    },
    (args) =>
      run(() => {
        const projectId = effectiveProjectId(args.project_id);
        const pad = getPadMeta(projectId, args.pad_id);
        const archived = args.archived ?? true;
        if ((pad.archived === 1) === archived) {
          return { pad_id: pad.id, archived, revision: pad.revision };
        }
        let revision: number;
        try {
          // No predicate: archived is a metadata flag, not content, so a
          // lost race here at worst flips it back and forth rather than
          // destroying anything - out of this fix's scope (todo 345/issue
          // #148 names pads.ts's content-rewriting writes, not this one).
          revision = bumpPad(pad.id, undefined, "archived = ?", archived ? 1 : 0);
        } catch (e) {
          if (e instanceof Error && e.message.includes("UNIQUE")) {
            throw new Error(
              `Cannot unarchive pad ${pad.id}: an active pad named "${pad.name}" already exists. Rename or archive that pad first.`,
            );
          }
          throw e;
        }
        return { pad_id: pad.id, archived, revision };
      }),
  );

  server.registerTool(
    "pad_delete",
    {
      description:
        "Permanently delete a pad. Irreversible; prefer pad_archive. Optional expected_revision guards against deleting a pad someone just updated.",
      inputSchema: {
        pad_id: idParam,
        expected_revision: idParam.optional(),
        project_id: projectIdParam,
      },
    },
    (args) =>
      run(() => {
        const projectId = effectiveProjectId(args.project_id);
        const pad = getPadMeta(projectId, args.pad_id);
        checkRevision(pad, args.expected_revision, false);
        // Predicate is always our own read revision, same reasoning as
        // pad_edit: delete is irreversible, so "expected_revision guards
        // against deleting a pad someone just updated" (the tool's own
        // description) has to hold whether or not the caller passed one.
        const info = db.prepare("DELETE FROM scratchpads WHERE id = ? AND revision = ?").run(pad.id, pad.revision);
        assertRowChanged(pad.id, pad.revision, info.changes > 0);
        return { pad_id: pad.id, deleted: true };
      }),
  );

  server.registerTool(
    "pad_list",
    {
      description:
        "List pads without full content. query matches names and content (returns a snippet); tags matches any listed tag.",
      inputSchema: {
        query: z.string().optional(),
        tags: z.array(z.string()).optional(),
        include_archived: z.boolean().optional(),
        limit: limitParam,
        offset: offsetParam,
        project_id: projectIdParam,
      },
    },
    (args) =>
      run(() => {
        const project = resolveProject(args.project_id);
        const limit = Math.min(args.limit ?? 50, 200);
        const offset = args.offset ?? 0;
        // Pads hold the large blobs in this store; only pull content when a
        // query needs a snippet.
        const columns = `id, name, revision, tags, archived, updated_by, updated_at,
          length(content) AS content_length${args.query ? ", content" : ""}`;
        let sql = `SELECT ${columns} FROM scratchpads WHERE project_id = ?`;
        const params: unknown[] = [project.id];
        if (!args.include_archived) sql += " AND archived = 0";
        if (args.query) {
          sql += " AND (name LIKE ? OR content LIKE ?)";
          params.push(`%${args.query}%`, `%${args.query}%`);
        }
        sql += " ORDER BY updated_at DESC";
        const rows = (
          db.prepare(sql).all(...params) as (Omit<PadRow, "content"> & {
            content_length: number;
            content?: string;
          })[]
        ).filter((r) => matchesAnyTag(r.tags, args.tags));
        const page = rows.slice(offset, offset + limit);
        return {
          project_id: project.id,
          project_name: project.name,
          total_count: rows.length,
          offset,
          limit,
          pads: page.map((r) => {
            let snippet: string | undefined;
            if (args.query && r.content != null) {
              const idx = r.content.toLowerCase().indexOf(args.query.toLowerCase());
              if (idx >= 0) {
                snippet = r.content.slice(Math.max(0, idx - 40), idx + args.query.length + 80);
              }
            }
            return {
              pad_id: r.id,
              name: r.name,
              revision: r.revision,
              tags: parseTags(r.tags),
              archived: r.archived === 1,
              content_length: r.content_length,
              updated_by: r.updated_by,
              updated_at: r.updated_at,
              ...(snippet ? { snippet } : {}),
            };
          }),
        };
      }),
  );
}
