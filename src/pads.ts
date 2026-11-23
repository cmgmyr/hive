import { db } from "./db.js";
import { currentActor } from "./context.js";

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

export type PadMeta = Pick<PadRow, "id" | "name" | "revision" | "archived">;

export function splitsSurrogatePair(content: string, index: number): boolean {
  if (index <= 0 || index >= content.length) return false;
  const before = content.charCodeAt(index - 1);
  const after = content.charCodeAt(index);
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
}

function selectPad<T>(projectId: number, padId: number, columns: string): T {
  const row = db.prepare(`SELECT ${columns} FROM pads WHERE project_id = ? AND id = ?`).get(projectId, padId) as T | undefined;
  if (!row) throw new Error(`No pad with id ${padId} in project ${projectId}. Call pad_list.`);
  return row;
}

export function getPad(projectId: number, padId: number): PadRow {
  return selectPad<PadRow>(projectId, padId, "*");
}

export function getPadMeta(projectId: number, padId: number): PadMeta {
  return selectPad<PadMeta>(projectId, padId, "id, name, revision, archived");
}

function revisionMismatchError(padId: number, expected: number | undefined, current: number | null): Error {
  if (current == null) {
    return new Error(`Pad ${padId} no longer exists; it may have just been deleted by another write. Call pad_list to confirm.`);
  }
  return new Error(`Revision mismatch for pad ${padId}: expected ${expected}, current ${current}. Re-read with pad_read and retry.`);
}

function currentRevisionOrDeleted(padId: number): number | null {
  const row = db.prepare("SELECT revision FROM pads WHERE id = ?").get(padId) as { revision: number } | undefined;
  return row?.revision ?? null;
}

export function assertRowChanged(padId: number, predicateRevision: number | undefined, changed: boolean): void {
  if (!changed) throw revisionMismatchError(padId, predicateRevision, currentRevisionOrDeleted(padId));
}

export function checkRevision(pad: PadMeta, expected: number | undefined, required: boolean): void {
  if (expected == null) {
    if (required) throw new Error(`expected_revision is required to overwrite pad ${pad.id}. Current revision: ${pad.revision}. Read it first with pad_read.`);
    return;
  }
  if (expected !== pad.revision) throw revisionMismatchError(pad.id, expected, pad.revision);
}

export function bumpPad(padId: number, predicateRevision: number | undefined, set: string, ...params: unknown[]): number {
  const where = predicateRevision != null ? "id = ? AND revision = ?" : "id = ?";
  const whereParams = predicateRevision != null ? [padId, predicateRevision] : [padId];
  const row = db.prepare(`UPDATE pads SET ${set}, revision = revision + 1,
       updated_by = ?, updated_at = datetime('now') WHERE ${where} RETURNING revision`).get(...params, currentActor(), ...whereParams) as { revision: number } | undefined;
  assertRowChanged(padId, predicateRevision, row != null);
  return row!.revision;
}

export const APPEND_WITH_SEPARATOR_SET =
  "content = content || (CASE WHEN content = '' OR substr(content, -1) = char(10) THEN '' ELSE char(10) END) || ?";

export function getActivePadByName(projectId: number, name: string): PadRow | undefined {
  return db.prepare("SELECT * FROM pads WHERE project_id = ? AND name = ? AND archived = 0").get(projectId, name) as PadRow | undefined;
}

export type PadListRow = Pick<PadRow, "name" | "revision" | "updated_by" | "updated_at"> & { content_length: number };

export function listActivePads(projectId: number): PadListRow[] {
  return db.prepare(`SELECT name, revision, length(content) AS content_length, updated_by, updated_at
       FROM pads WHERE project_id = ? AND archived = 0 ORDER BY name`).all(projectId) as PadListRow[];
}

export function overwritePadContent(projectId: number, padId: number, content: string, expectedRevision: number): number {
  const pad = getPadMeta(projectId, padId);
  checkRevision(pad, expectedRevision, true);
  return bumpPad(padId, pad.revision, "content = ?", content);
}

export function createPad(projectId: number, name: string, content: string, tags: string[]): number | null {
  const row = db.prepare(`INSERT OR IGNORE INTO pads (project_id, name, content, tags, updated_by)
       VALUES (?, ?, ?, ?, ?) RETURNING id`).get(projectId, name, content, JSON.stringify(tags), currentActor()) as { id: number } | undefined;
  return row?.id ?? null;
}
