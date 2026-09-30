import { captureQueenWriteIdentity, effectiveProjectId, isQueenLead, type QueenWriteIdentity } from "./context.js";
import { db } from "./db.js";
import { cutToUnitBudget, flatten } from "./slug.js";

export type { QueenWriteIdentity } from "./context.js";

export interface QueenAuditRow {
  id: number;
  actor_id: string;
  home_project_id: number;
  target_project_id: number;
  operation: string;
  resource_type: string;
  resource_id: number;
  summary: string;
  created_at: string;
}

type Receipt = Record<string, unknown>;
export interface QueenAuditOperation {
  mode: "database" | "external";
  resource(receipt: Receipt): { type: string; id: number } | null;
  summary(args: Receipt, receipt: Receipt): string;
}

export const QUEEN_AUDIT_SUMMARY_MAX = 160;
export const QUEEN_AUDIT_DEFAULT_LIMIT = 20;
export const QUEEN_AUDIT_MAX_LIMIT = 100;
export const QUEEN_AUDIT_RETENTION = "-30 days";
export const QUEEN_AUDIT_MAX_ROWS = 20_000;

function resource(type: string, value: unknown): { type: string; id: number } | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? { type, id: value } : null;
}

export const QUEEN_AUDIT_OPERATIONS: Readonly<Record<string, QueenAuditOperation>> = {
  todo_create: {
    mode: "database",
    resource: (r) => resource("todo", r.todo_id),
    summary: (a) => String(a.title),
  },
  todo_comment: {
    mode: "database",
    resource: (r) => resource("todo_comment", r.comment_id),
    summary: (a) => `todo #${a.todo_id}: ${a.body}`,
  },
  wake_set: {
    mode: "database",
    resource: (r) => resource("wake", r.wake_id),
    summary: (a, r) => `to ${r.deliver_to}: ${a.body}`,
  },
  wake_when_idle: {
    mode: "database",
    resource: (r) => r.status === "already_satisfied" ? null : resource("wake", r.wake_id),
    summary: (a, r) => `${a.mode ?? "any"} to ${r.deliver_to}: ${a.body}`,
  },
  wake_update: {
    mode: "database",
    resource: (r) => r.updated === true ? resource("wake", r.wake_id) : null,
    summary: (a) => `changed ${["body", "delay_seconds", "repeat_every_seconds"].filter((key) => a[key] !== undefined).join(", ")}${a.body === undefined ? "" : `: ${a.body}`}`,
  },
  wake_cancel: {
    mode: "database",
    resource: (r) => r.cancelled === true ? resource("wake", r.wake_id) : null,
    summary: (_a, r) => `cancelled; notices ${r.cancelled_notices ?? 0}`,
  },
  agent_send: {
    mode: "external",
    resource: (r) => r.sent === true ? resource("agent", r.agent_id) : null,
    summary: (a, r) => `agent #${r.agent_id} ${a.submit === false ? "pasted without submit" : "submitted"}: ${a.text}`,
  },
  "hive lead": {
    mode: "external",
    resource: (r) => r.disposition === "started" || r.disposition === "adopted" ? resource("agent", r.agent_id) : null,
    summary: (a, r) => `${r.disposition} lead #${r.agent_id}${a.detach ? " detached" : ""}`,
  },
};

function descriptor(operation: string): QueenAuditOperation {
  const found = Object.hasOwn(QUEEN_AUDIT_OPERATIONS, operation) ? QUEEN_AUDIT_OPERATIONS[operation] : undefined;
  if (!found) throw new Error(`[queen_audit:missing-coverage] ${operation} has no audit descriptor`);
  return found;
}

function insertAudit(operation: string, targetProjectId: number, args: Receipt, receipt: Receipt, identity: QueenWriteIdentity): void {
  const spec = descriptor(operation);
  const touched = spec.resource(receipt);
  if (!touched) return;
  const text = flatten(spec.summary(args, receipt));
  const summary = text.length <= QUEEN_AUDIT_SUMMARY_MAX ? text : cutToUnitBudget(text, QUEEN_AUDIT_SUMMARY_MAX - 1) + "…";
  db.prepare(
    `INSERT INTO queen_audit (actor_id, home_project_id, target_project_id, operation, resource_type, resource_id, summary)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(identity.actor_id, identity.home_project_id, targetProjectId, operation, touched.type, touched.id, summary);
}

export function commitQueenStateWrite<T extends Receipt>(operation: string, targetProjectId: number, args: Receipt, mutate: () => T): T {
  const identity = captureQueenWriteIdentity(targetProjectId);
  if (!identity) return mutate();
  const spec = descriptor(operation);
  if (spec.mode !== "database") throw new Error(`[queen_audit:wrong-mode] ${operation} is not a database write`);
  return db.transaction(() => {
    const receipt = mutate();
    insertAudit(operation, targetProjectId, args, receipt, identity);
    return receipt;
  }).immediate();
}

export function confirmQueenWrite(operation: string, targetProjectId: number, args: Receipt, receipt: Receipt, identity = captureQueenWriteIdentity(targetProjectId)): void {
  if (!identity) return;
  try {
    insertAudit(operation, targetProjectId, args, receipt, identity);
  } catch (e) {
    if (operation !== "agent_send") throw e;
    throw new Error(`[queen_audit:write-completed-audit-failed] agent #${receipt.agent_id}: the text already landed. Do not resend blindly. ${e instanceof Error ? e.message : String(e)}`);
  }
}

function positiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
}

export function recentQueenAudit(limit: number): QueenAuditRow[] {
  return db.prepare("SELECT * FROM queen_audit ORDER BY id DESC LIMIT ?").all(limit) as QueenAuditRow[];
}

export function listQueenAudit(options: { project_id?: number; limit?: number } = {}, homeProjectId?: number): { entries: QueenAuditRow[]; limit: number; project_id: number | null } {
  const requestedLimit = options.limit ?? QUEEN_AUDIT_DEFAULT_LIMIT;
  positiveInteger(requestedLimit, "limit");
  if (options.project_id !== undefined) positiveInteger(options.project_id, "project_id");
  const target = options.project_id === undefined ? null : effectiveProjectId(options.project_id);
  const queen = isQueenLead();
  const home = queen ? null : homeProjectId ?? effectiveProjectId();
  if (!queen && target !== null && target !== home) throw new Error("Queen audit access is limited to your own project");
  const projectId = target ?? home;
  const limit = Math.min(requestedLimit, QUEEN_AUDIT_MAX_LIMIT);
  const entries = (projectId === null
    ? db.prepare("SELECT * FROM queen_audit ORDER BY id DESC LIMIT ?").all(limit)
    : db.prepare("SELECT * FROM queen_audit WHERE target_project_id = ? ORDER BY id DESC LIMIT ?").all(projectId, limit)) as QueenAuditRow[];
  return { entries, limit, project_id: projectId };
}
