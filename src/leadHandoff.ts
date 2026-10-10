import { db } from "./db.js";
import { harnessFor } from "./harnesses.js";
import { type LeadSafetySnapshot, type LeadTurnState, readLeadSafetySnapshot } from "./leadState.js";
import type { LeadTurnBudget } from "./projectYml.js";
import { readTurnCount } from "./turnCount.js";

export const HANDOFF_PAD_NAME = "hive-lead-handoff";

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

export interface PassPolicy {
  graceSeconds: number;
  humanQuietSeconds: number;
  // null: the holds make the lead quiet, so no automation-quiet window is required.
  automationQuietSeconds: number | null;
  holdsFromRequest: boolean;
  requestNeedsQuiet: boolean;
}

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

export function handoffHoldsAutomation(row: HandoffRow): boolean {
  switch (row.state) {
    case "grace":
    case "respawning":
    case "started":
    case "ambiguous":
      return true;
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

// The one predicate every automated lead delivery consults before it writes to the lead.
export function readHandoffGate(leadAgentId: number): { requestId: number; holdAutomation: boolean } | null {
  const row = readActiveHandoff(leadAgentId);
  return row === null ? null : { requestId: row.id, holdAutomation: handoffHoldsAutomation(row) };
}

export interface LeadForHandoff {
  id: number;
  project_id: number;
  command: string;
  pane_pid: string;
  tmux_target: string;
  tmux_socket: string;
}

export type Eligibility =
  | { eligible: true; reason: HandoffReason; turns: number; epoch: { pane_pid: string; session_id: string } }
  | { eligible: false; why: string };

export function handoffEligibility(
  lead: LeadForHandoff,
  budget: LeadTurnBudget | null,
  snapshot: (LeadTurnState & LeadSafetySnapshot) | null = readLeadSafetySnapshot(lead.id),
): Eligibility {
  if (budget === null || budget.auto_handoff !== true) return { eligible: false, why: "auto_handoff is not enabled" };
  if (harnessFor(lead.command).name !== "claude") return { eligible: false, why: "the lead is not a Claude lead" };
  if (lead.pane_pid === "") return { eligible: false, why: "the lead's pane pid is unknown" };
  if (
    snapshot === null ||
    snapshot.session_id === "" ||
    snapshot.pane_pid !== lead.pane_pid ||
    snapshot.snapshot_pane_pid !== lead.pane_pid ||
    snapshot.snapshot_session_id !== snapshot.session_id
  ) {
    return { eligible: false, why: "the lead's current epoch is unknown" };
  }
  const turns = readTurnCount(snapshot.transcript_path);
  if (turns === null) return { eligible: false, why: "the lead's turn count is unavailable" };
  if (turns < budget.warn) return { eligible: false, why: "below the warn budget" };
  return {
    eligible: true,
    reason: turns >= budget.stop ? "stop" : "warn",
    turns,
    epoch: { pane_pid: lead.pane_pid, session_id: snapshot.session_id },
  };
}

// Respawn safety, not idleness: any live background task of any type, a Stop without background
// evidence, a prompt newer than the last Stop, or an unmatched subagent_start vetoes. No expiry.
export function backgroundVeto(snapshot: (LeadTurnState & LeadSafetySnapshot) | null): string | null {
  if (snapshot === null || snapshot.snapshot_session_id !== snapshot.session_id || snapshot.session_id === "") {
    return "no background evidence for the current session";
  }
  if (snapshot.stop_prompt_seq === null) return "no completed turn yet in this session";
  if (snapshot.stop_prompt_seq !== snapshot.prompt_seq) return "a turn started after the last completed one";
  if (snapshot.stop_background === null) return "the last completed turn reported no background-task evidence";
  let live: { type: string }[];
  try {
    live = JSON.parse(snapshot.stop_background) as { type: string }[];
  } catch {
    return "the background-task evidence is unreadable";
  }
  if (live.length > 0) {
    const types = [...new Set(live.map((t) => t.type || "unknown"))].sort().join(", ");
    return `${live.length} background task${live.length === 1 ? "" : "s"} still live (${types})`;
  }
  let open: string[];
  try {
    open = JSON.parse(snapshot.open_subagents) as string[];
  } catch {
    return "the subagent evidence is unreadable";
  }
  if (open.length > 0) return `${open.length} subagent${open.length === 1 ? "" : "s"} started and not yet stopped`;
  return null;
}

export interface ArmInput {
  lead: LeadForHandoff;
  ownerActor: string;
  reason: HandoffReason;
  epoch: { pane_pid: string; session_id: string };
  requestBody: (requestId: number) => string;
}

// One request and one request wake per epoch. The wake carries no due_at: the scheduler sets it
// when the pass's quiet rule allows, so nothing ordinary can deliver it early.
const armTransaction = db.transaction((input: ArmInput): { requestId: number; created: boolean } => {
  const inserted = db
    .prepare(
      `INSERT INTO lead_handoffs (project_id, lead_agent_id, pane_target, tmux_socket, predecessor_pane_pid,
         predecessor_session_id, reason, state, pass, pass_started_at, hold_since)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, strftime('%Y-%m-%d %H:%M:%f', 'now'),
         CASE WHEN ? = 'stop' THEN strftime('%Y-%m-%d %H:%M:%f', 'now') END)
       ON CONFLICT DO NOTHING
       RETURNING id`,
    )
    .get(
      input.lead.project_id,
      input.lead.id,
      input.lead.tmux_target,
      input.lead.tmux_socket,
      input.epoch.pane_pid,
      input.epoch.session_id,
      input.reason,
      input.reason === "stop" ? "wind_down" : "pending",
      input.reason,
    ) as { id: number } | undefined;
  if (inserted === undefined) {
    const existing = db
      .prepare(
        `SELECT id FROM lead_handoffs WHERE project_id = ? AND lead_agent_id = ?
           AND predecessor_pane_pid = ? AND predecessor_session_id = ?`,
      )
      .get(input.lead.project_id, input.lead.id, input.epoch.pane_pid, input.epoch.session_id) as { id: number } | undefined;
    const active = existing ?? (readActiveHandoff(input.lead.id) as { id: number } | null) ?? undefined;
    return { requestId: active?.id ?? 0, created: false };
  }
  const wake = db
    .prepare(
      `INSERT INTO wakes (project_id, owner, body, kind, deliver_actor, deliver_pane, due_at)
       SELECT ?, ?, ?, 'delay', actor_id, tmux_target, NULL FROM agents WHERE id = ?
       RETURNING id`,
    )
    .get(input.lead.project_id, input.ownerActor, input.requestBody(inserted.id), input.lead.id) as { id: number };
  db.prepare("UPDATE lead_handoffs SET request_wake_id = ? WHERE id = ?").run(wake.id, inserted.id);
  return { requestId: inserted.id, created: true };
});

export function armHandoffRequest(input: ArmInput): { requestId: number; created: boolean } {
  return armTransaction.immediate(input);
}

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

// Definite failure before the destructive transition: record why, and the gate stops holding.
// The epoch's unique key means the scheduler never re-requests it.
const failTransaction = db.transaction((id: number, failure: string, from: readonly HandoffState[]): boolean => {
  if (!casHandoff(id, from, { state: "failed", failure, owner_token: null, owner_pid: null })) return false;
  db.prepare(
    `UPDATE wakes SET cancelled_at = datetime('now'), held_reason = ?
      WHERE id = (SELECT request_wake_id FROM lead_handoffs WHERE id = ?) AND fired_at IS NULL AND cancelled_at IS NULL`,
  ).run(`lead handoff #${id} failed: ${failure}`, id);
  return true;
});

export function failHandoff(id: number, failure: string, from: readonly HandoffState[] = PRE_RESPAWN_STATES): boolean {
  return failTransaction.immediate(id, failure, from);
}
