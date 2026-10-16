import { db } from "./db.js";
import { cutToUnitBudget, flatten } from "./slug.js";

export interface QueenWriteIdentity {
  actor_id: string;
  home_project_id: number;
}

export interface QueenAuditRow {
  id: number;
  actor_id: string;
  home_project_id: number;
  target_project_id: number;
  operation: string;
  resource_type: string;
  resource_id: number;
  summary: string;
  outcome: "confirmed" | "refused";
  problem: string;
  created_at: string;
}

export const QUEEN_AUDIT_SUMMARY_MAX = 160;
export const QUEEN_AUDIT_DEFAULT_LIMIT = 20;
export const QUEEN_AUDIT_MAX_LIMIT = 100;
export const QUEEN_AUDIT_RETENTION = "-30 days";
export const QUEEN_AUDIT_MAX_ROWS = 20_000;

export function insertQueenAuditRow(
  operation: string,
  targetProjectId: number,
  identity: QueenWriteIdentity,
  resourceType: string,
  resourceId: number,
  summary: string,
  outcome: QueenAuditRow["outcome"] = "confirmed",
  problem = "",
): void {
  db.prepare(
    `INSERT INTO queen_audit
       (actor_id, home_project_id, target_project_id, operation, resource_type, resource_id, summary, outcome, problem)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    identity.actor_id,
    identity.home_project_id,
    targetProjectId,
    operation,
    resourceType,
    resourceId,
    summary,
    outcome,
    problem,
  );
}

export function recordQueenRefusal(
  operation: string,
  targetProjectId: number,
  problem: string,
  identity: QueenWriteIdentity,
): void {
  const text = flatten(problem);
  const summaryText = `refused: ${text}`;
  const summary =
    summaryText.length <= QUEEN_AUDIT_SUMMARY_MAX
      ? summaryText
      : cutToUnitBudget(summaryText, QUEEN_AUDIT_SUMMARY_MAX - 1) + "…";
  insertQueenAuditRow(operation, targetProjectId, identity, "project", targetProjectId, summary, "refused", text);
}
