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

export const HELD_REASON_HANDOFF =
  "the lead is winding down for an automatic handoff; held so nothing interrupts it, and delivered to the " +
  "lead row (its successor, once it starts) when the handoff completes, fails or releases its hold";

// A wake addressed to a lead row is held while that lead's handoff holds automation, except the
// current request wake itself, which still passes every human-input and ownership guard.
export function handoffHoldsWake(wakeId: number, deliverRowId: number | null): boolean {
  if (deliverRowId === null) return false;
  const gate = readHandoffGate(deliverRowId);
  return gate !== null && gate.holdAutomation && gate.requestWakeId !== wakeId;
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

export const REQUEST_BODY_PREFIX = "hive lead handoff request #";

export const HANDOFF_HEADINGS = [
  "IN FLIGHT",
  "WAITING ON",
  "QUEUED NEXT",
  "OPEN QUESTIONS FOR THE HUMAN",
  "HUMAN INSTRUCTIONS THIS SESSION",
  "HUMAN'S LAST REQUEST",
  "VERIFY ON ARRIVAL",
  "DON'T REDO",
  "SESSION WORK TO RESTORE",
] as const;

export function requestBody(row: Pick<HandoffRow, "id" | "pass" | "reason">, turns: number | null): string {
  const policy = passPolicy(row.pass, row.reason);
  return [
    `${REQUEST_BODY_PREFIX}${row.id} (pass ${row.pass}, ${row.reason === "stop" ? "stop" : "warn"} budget` +
      `${turns === null ? "" : `, ${turns} turns`}). hive will replace this session with a fresh one in the same pane.`,
    "",
    "1. Finish or park any write you have in progress, so the project's own records are current.",
    `2. Write the pad "${HANDOFF_PAD_NAME}" with exactly these headings, in this order. "none" is a valid entry; ` +
      "point into the store rather than copying it, and keep it under about 8,000 characters:",
    ...HANDOFF_HEADINGS.map((h) => `   ${h}`),
    "   Under SESSION WORK TO RESTORE list every /loop, cron, ScheduleWakeup, monitor or in-session task list " +
      "and how to re-arm it; none of them survive the new session. Re-arm what you can as hive wakes now.",
    "3. Read the pad back and note its id and revision.",
    `4. Tell the human in plain words: "I will hand off after ${policy.graceSeconds} quiet seconds. Human input postpones it."`,
    `5. Run: hive lead-handoff --request ${row.id} --pad <pad id> --revision <revision>`,
    "",
    "If you cannot write the pad, say so and do not run the command; this session stays as it is.",
  ].join("\n");
}

const NOW_SQL = "strftime('%Y-%m-%d %H:%M:%f', 'now')";

function olderThan(ts: string | null, seconds: number): boolean {
  if (ts === null) return true;
  return (db.prepare("SELECT (julianday('now') - julianday(?)) * 86400 >= ? AS old").get(ts, seconds) as { old: number }).old === 1;
}

// Automated deliveries to the lead other than the handoff's own request wakes.
export function automationBlocker(lead: { id: number; actor_id: string }, seconds: number | null): string | null {
  const inFlight = db
    .prepare(
      `SELECT 1 AS hit FROM agent_messages WHERE to_agent_id = ? AND delivery_status IN ('socket-pending', 'fallback-claimed')
        AND created_at >= datetime('now', '-7 days')
       UNION ALL
       SELECT 1 FROM wakes WHERE deliver_actor = ? AND body NOT LIKE ? AND fired_at IS NOT NULL AND cancelled_at IS NULL
        AND delivery_method LIKE 'socket%' AND confirmed_at IS NULL AND socket_attempt_at >= datetime('now', '-7 days')
       LIMIT 1`,
    )
    .get(lead.id, lead.actor_id, `${REQUEST_BODY_PREFIX}%`);
  if (inFlight !== undefined) return "a delivery to the lead is still in flight";
  if (seconds === null) return null;
  const window = `-${seconds} seconds`;
  const recent = db
    .prepare(
      `SELECT 1 AS hit FROM wakes WHERE deliver_actor = ? AND body NOT LIKE ?
         AND (fired_at >= datetime('now', ?) OR typed_at >= datetime('now', ?) OR socket_attempt_at >= datetime('now', ?))
       UNION ALL
       SELECT 1 FROM agent_messages WHERE to_agent_id = ? AND created_at >= datetime('now', ?)
       LIMIT 1`,
    )
    .get(lead.actor_id, `${REQUEST_BODY_PREFIX}%`, window, window, window, lead.id, window);
  return recent === undefined ? null : `an automated delivery reached the lead in the last ${seconds} s`;
}

interface Blocker {
  reason: string;
  background: boolean;
}

function requestBlocker(
  lead: { id: number; actor_id: string },
  row: HandoffRow,
  snapshot: (LeadTurnState & LeadSafetySnapshot) | null,
): Blocker | null {
  if (snapshot === null || snapshot.state !== "idle") return { reason: "the lead's turn has not ended", background: false };
  const background = backgroundVeto(snapshot);
  if (background !== null) return { reason: background, background: true };
  const policy = passPolicy(row.pass, row.reason);
  if (!policy.requestNeedsQuiet) return null;
  if (!olderThan(snapshot.human_prompt_at, policy.humanQuietSeconds)) {
    return { reason: `a human prompt arrived in the last ${policy.humanQuietSeconds} s`, background: false };
  }
  const automation = automationBlocker(lead, policy.automationQuietSeconds);
  return automation === null ? null : { reason: automation, background: false };
}

const requestTransaction = db.transaction((row: HandoffRow, lead: { id: number; actor_id: string; tmux_target: string }, turns: number | null): boolean => {
  const current = readHandoff(row.id);
  if (current === null || current.state !== row.state || current.pass !== row.pass) return false;
  const waiting = current.request_wake_id === null
    ? undefined
    : (db
        .prepare("SELECT id FROM wakes WHERE id = ? AND due_at IS NULL AND fired_at IS NULL AND cancelled_at IS NULL")
        .get(current.request_wake_id) as { id: number } | undefined);
  let wakeId: number;
  if (waiting !== undefined) {
    db.prepare("UPDATE wakes SET due_at = datetime('now'), body = ? WHERE id = ?").run(requestBody(current, turns), waiting.id);
    wakeId = waiting.id;
  } else {
    wakeId = (
      db
        .prepare(
          `INSERT INTO wakes (project_id, owner, body, kind, deliver_actor, deliver_pane, due_at)
           VALUES (?, ?, ?, 'delay', ?, ?, datetime('now')) RETURNING id`,
        )
        .get(current.project_id, lead.actor_id, requestBody(current, turns), lead.actor_id, lead.tmux_target) as { id: number }
    ).id;
  }
  const holds = passPolicy(current.pass, current.reason).holdsFromRequest;
  return casHandoff(
    current.id,
    [current.state],
    {
      state: "requested",
      request_wake_id: wakeId,
      hold_released_at: null,
      hold_since: holds ? (db.prepare(`SELECT ${NOW_SQL} AS now`).get() as { now: string }).now : null,
      blocked_reason: null,
    },
    { pass: current.pass },
  );
});

function maintainHold(row: HandoffRow, reason: string | null): void {
  const holds = handoffHoldsAutomation(row);
  if (holds && row.hold_since === null) {
    casHandoff(row.id, [row.state], { hold_since: (db.prepare(`SELECT ${NOW_SQL} AS now`).get() as { now: string }).now }, { hold_since: null });
    return;
  }
  if (holds && row.state !== "grace" && olderThan(row.hold_since, STOP_HOLD_CAP_SECONDS)) {
    casHandoff(
      row.id,
      [row.state],
      { hold_released_at: (db.prepare(`SELECT ${NOW_SQL} AS now`).get() as { now: string }).now, blocked_reason: reason ?? "no quiet moment" },
      { hold_released_at: null },
    );
    return;
  }
  if (reason !== row.blocked_reason && reason !== null) casHandoff(row.id, [row.state], { blocked_reason: reason });
}

// The scheduler's WHEN: arm at warn, wind down at stop, request at the pass's quiet moment, escalate
// a pass that found none in 10 minutes, and release a hold that has lasted 15. Never touches a pane.
export function driveLeadHandoff(actorId: string, budgetFor: (projectPath: string) => LeadTurnBudget | null): void {
  const lead = db
    .prepare(
      `SELECT a.id, a.project_id, a.actor_id, a.command, a.pane_pid, a.tmux_target, a.tmux_socket, p.path
         FROM agents a JOIN projects p ON p.id = a.project_id
        WHERE a.actor_id = ? AND a.kind = 'lead' AND a.status = 'running'`,
    )
    .get(actorId) as (LeadForHandoff & { actor_id: string; path: string }) | undefined;
  if (lead === undefined) return;
  const budget = budgetFor(lead.path);
  const snapshot = readLeadSafetySnapshot(lead.id);
  let row = readActiveHandoff(lead.id);
  if (row === null) {
    const eligibility = handoffEligibility(lead, budget, snapshot);
    if (!eligibility.eligible) return;
    armHandoffRequest({
      lead,
      ownerActor: lead.actor_id,
      reason: eligibility.reason,
      epoch: eligibility.epoch,
      requestBody: (id) => requestBody({ id, pass: 1, reason: eligibility.reason }, eligibility.turns),
    });
    row = readActiveHandoff(lead.id);
    if (row === null) return;
  }
  if (!PRE_RESPAWN_STATES.includes(row.state)) return;
  if (budget?.auto_handoff !== true) {
    failHandoff(row.id, "lead_turn_budget.auto_handoff is no longer on");
    return;
  }
  if (lead.pane_pid !== row.predecessor_pane_pid || snapshot?.session_id !== row.predecessor_session_id) {
    failHandoff(row.id, "the lead's pane or session changed before the handoff (a restart, /clear or /resume)");
    return;
  }
  if (row.state === "grace") return;
  const eligibility = handoffEligibility(lead, budget, snapshot);
  if (eligibility.eligible && eligibility.reason === "stop" && row.reason === "warn") {
    casHandoff(row.id, [row.state], { reason: "stop", ...(row.state === "pending" ? { state: "wind_down" } : {}) }, { reason: "warn" });
    row = readHandoff(row.id)!;
  }
  const blocker = requestBlocker(lead, row, snapshot);
  if (row.state === "requested") {
    maintainHold(row, blocker?.reason ?? null);
    return;
  }
  if (blocker === null) {
    requestTransaction.immediate(row, lead, eligibility.eligible ? eligibility.turns : null);
    return;
  }
  if (!blocker.background && olderThan(row.pass_started_at, PASS_TIMEOUT_SECONDS)) {
    casHandoff(
      row.id,
      [row.state],
      {
        pass: row.pass + 1,
        pass_started_at: (db.prepare(`SELECT ${NOW_SQL} AS now`).get() as { now: string }).now,
        hold_since: null,
        hold_released_at: null,
        blocked_reason: blocker.reason,
      },
      { pass: row.pass },
    );
    return;
  }
  maintainHold(row, blocker.reason);
}
