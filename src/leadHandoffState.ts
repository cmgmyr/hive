import { db } from "./db.js";
import { HELD_REASON_HANDOFF } from "./wakeSql.js";

export { HELD_REASON_HANDOFF } from "./wakeSql.js";

export type HandoffReason = "warn" | "stop";
export type HandoffState =
  | "pending"
  | "wind_down"
  | "requested"
  | "grace"
  | "postponed"
  | "respawning"
  | "started"
  | "completed"
  | "failed"
  | "ambiguous";

export const PRE_RESPAWN_STATES: readonly HandoffState[] = ["pending", "wind_down", "requested", "grace", "postponed"];

export const PASS_TIMEOUT_SECONDS = 10 * 60;
export const STOP_HOLD_CAP_SECONDS = 15 * 60;
// The fence trigger's ceiling on lead_handoffs.updated_at age (src/db.ts); change both together.
export const HOLD_CEILING_SECONDS = 3600;
export const SUCCESSOR_NOT_READY = "the successor has not completed its first turn";

export interface PassPolicy {
  graceSeconds: number;
  humanQuietSeconds: number;
  // null: the holds make the lead quiet, so no automation-quiet window is required.
  automationQuietSeconds: number | null;
  holdsFromRequest: boolean;
  requestNeedsQuiet: boolean;
}

// The policy the request body quoted, never one recomputed after a warn->stop upgrade.
export const quotedPolicy = (row: Pick<HandoffRow, "pass" | "reason" | "request_reason">): PassPolicy =>
  passPolicy(row.pass, row.request_reason ?? row.reason);

export function passPolicy(pass: number, reason: HandoffReason): PassPolicy {
  if (reason === "stop" || pass >= 4) {
    return { graceSeconds: 45, humanQuietSeconds: 60, automationQuietSeconds: null, holdsFromRequest: true, requestNeedsQuiet: false };
  }
  if (pass === 3) {
    return { graceSeconds: 60, humanQuietSeconds: 75, automationQuietSeconds: 30, holdsFromRequest: true, requestNeedsQuiet: false };
  }
  if (pass === 2) {
    return { graceSeconds: 90, humanQuietSeconds: 150, automationQuietSeconds: 60, holdsFromRequest: true, requestNeedsQuiet: false };
  }
  return { graceSeconds: 120, humanQuietSeconds: 300, automationQuietSeconds: 120, holdsFromRequest: false, requestNeedsQuiet: true };
}

export interface HandoffRow {
  id: number;
  project_id: number;
  lead_agent_id: number;
  pane_target: string;
  tmux_socket: string;
  predecessor_pane_pid: string;
  predecessor_session_id: string;
  reason: HandoffReason;
  state: HandoffState;
  pass: number;
  request_reason: HandoffReason | null;
  pass_started_at: string | null;
  request_wake_id: number | null;
  attempt: number;
  owner_token: string | null;
  owner_pid: number | null;
  grace_seconds: number | null;
  grace_started_at: string | null;
  human_prompt_baseline: number | null;
  pad_id: number | null;
  pad_revision: number | null;
  pad_length: number | null;
  pad_sha256: string | null;
  respawn_claimed_at: string | null;
  predecessor_turns: number | null;
  hold_since: string | null;
  hold_released_at: string | null;
  blocked_reason: string | null;
  successor_pane_pid: string | null;
  successor_session_id: string | null;
  delivered_pad_id: number | null;
  delivered_pad_revision: number | null;
  started_at: string | null;
  completed_at: string | null;
  failure: string | null;
  created_at: string;
  updated_at: string;
}

export function readHandoff(id: number): HandoffRow | null {
  return (db.prepare("SELECT * FROM lead_handoffs WHERE id = ?").get(id) as HandoffRow | undefined) ?? null;
}

export function readActiveHandoff(leadAgentId: number): HandoffRow | null {
  return (
    (db
      .prepare("SELECT * FROM lead_handoffs WHERE lead_agent_id = ? AND state NOT IN ('completed', 'failed')")
      .get(leadAgentId) as HandoffRow | undefined) ?? null
  );
}

export function handoffHoldsAutomation(row: HandoffRow): boolean { // mirrored by trigger fence_handoff_held_claim (src/db.ts); change both via a NEW migration
  switch (row.state) {
    case "grace":
      return row.hold_released_at === null && !olderThan(row.grace_started_at, STOP_HOLD_CAP_SECONDS);
    case "started":
      return !olderThan(row.updated_at, HOLD_CEILING_SECONDS);
    case "respawning":
    case "ambiguous":
      return row.hold_released_at === null;
    case "wind_down":
      return row.hold_released_at === null;
    case "requested":
      return row.hold_released_at === null && passPolicy(row.pass, row.reason).holdsFromRequest;
    case "postponed":
      return row.hold_released_at === null && row.reason === "stop";
    default:
      return false;
  }
}

export interface HandoffGate {
  requestId: number;
  requestWakeId: number | null;
  holdAutomation: boolean;
}

// The one predicate every automated lead delivery consults before it writes to the lead.
export function readHandoffGate(leadAgentId: number): HandoffGate | null {
  const row = readActiveHandoff(leadAgentId);
  return row === null
    ? null
    : { requestId: row.id, requestWakeId: row.request_wake_id, holdAutomation: handoffHoldsAutomation(row) };
}

// A wake addressed to a lead row is held while that lead's handoff holds automation, except the
// current request wake itself, which still passes every human-input and ownership guard.
export function handoffHoldsWake(wakeId: number, deliverRowId: number | null): boolean {
  if (deliverRowId === null) return false;
  const gate = readHandoffGate(deliverRowId);
  return gate !== null && gate.holdAutomation && gate.requestWakeId !== wakeId;
}

const NOW_SQL = "strftime('%Y-%m-%d %H:%M:%f', 'now')";

export function olderThan(ts: string | null, seconds: number): boolean {
  if (ts === null) return true;
  return (db.prepare("SELECT (julianday('now') - julianday(?)) * 86400 >= ? AS old").get(ts, seconds) as { old: number }).old === 1;
}

export const nowSql = (): string => (db.prepare(`SELECT ${NOW_SQL} AS now`).get() as { now: string }).now;

// Every transition is a compare-and-set on the row's state; callers bind any extra identity
// (attempt, owner token) through `where`.
export function casHandoff(
  id: number,
  from: readonly HandoffState[],
  set: Partial<Record<keyof HandoffRow, string | number | null>>,
  where: Partial<Record<keyof HandoffRow, string | number | null>> = {},
): boolean {
  const setKeys = Object.keys(set);
  const whereKeys = Object.keys(where);
  const sql =
    `UPDATE lead_handoffs SET ${[...setKeys.map((k) => `${k} = ?`), "updated_at = strftime('%Y-%m-%d %H:%M:%f', 'now')"].join(", ")}
      WHERE id = ? AND state IN (${from.map(() => "?").join(", ")})` +
    whereKeys.map((k) => ` AND ${k} IS ?`).join("");
  const result = db
    .prepare(sql)
    .run(...setKeys.map((k) => set[k as keyof HandoffRow] ?? null), id, ...from, ...whereKeys.map((k) => where[k as keyof HandoffRow] ?? null));
  return result.changes === 1;
}

// The one writer of the grace -> postponed transition; `where` binds the caller's identity, and pass is always bound.
export function postponeGrace(
  row: HandoffRow,
  where: Partial<Record<keyof HandoffRow, string | number | null>>,
  reason: string,
  escalate: boolean,
): boolean {
  return casHandoff(
    row.id,
    ["grace"],
    {
      state: "postponed",
      pass: escalate ? row.pass + 1 : row.pass,
      pass_started_at: nowSql(),
      owner_token: null,
      owner_pid: null,
      blocked_reason: reason,
    },
    { ...where, pass: row.pass },
  );
}
