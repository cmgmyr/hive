import { createHash } from "node:crypto";
import { db } from "./db.js";
import { harnessFor } from "./harnesses.js";
import { type LeadSafetySnapshot, type LeadTurnState, readLeadSafetySnapshot } from "./leadState.js";
import type { LeadTurnBudget } from "./projectYml.js";
import { readTurnCount } from "./turnCount.js";

export const HANDOFF_PAD_NAME = "hive-lead-handoff";

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

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

export function handoffHoldsAutomation(row: HandoffRow): boolean {
  switch (row.state) {
    case "grace":
      return true;
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
type Binding = Partial<Record<keyof HandoffRow, string | number | null>>;

const failTransaction = db.transaction((id: number, failure: string, from: readonly HandoffState[], where: Binding): boolean => {
  if (!casHandoff(id, from, { state: "failed", failure, owner_token: null, owner_pid: null }, where)) return false;
  db.prepare(
    `UPDATE wakes SET cancelled_at = datetime('now'), held_reason = ?
      WHERE id = (SELECT request_wake_id FROM lead_handoffs WHERE id = ?) AND fired_at IS NULL AND cancelled_at IS NULL`,
  ).run(`lead handoff #${id} failed: ${failure}`, id);
  return true;
});

export function failHandoff(
  id: number,
  failure: string,
  from: readonly HandoffState[] = PRE_RESPAWN_STATES,
  where: Binding = {},
): boolean {
  return failTransaction.immediate(id, failure, from, where);
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

// After the destructive claim nothing is retried: a successor the row no longer names fails the row,
// and a respawn that never settled releases its holds after the cap.
function settleAfterRespawn(row: HandoffRow, lead: { pane_pid: string }): void {
  if (row.state === "started" && row.successor_pane_pid !== null && lead.pane_pid !== row.successor_pane_pid) {
    casHandoff(row.id, ["started"], { state: "failed", failure: "the lead pane no longer runs the successor this handoff started" });
    return;
  }
  if ((row.state === "respawning" || row.state === "ambiguous") && row.hold_released_at === null && olderThan(row.updated_at, STOP_HOLD_CAP_SECONDS)) {
    casHandoff(row.id, [row.state], { hold_released_at: nowSql(), blocked_reason: row.failure ?? "the respawn never settled" });
  }
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
    `${REQUEST_BODY_PREFIX}${row.id} (pass ${row.pass}, ${row.reason} budget` +
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
      request_reason: current.reason,
      request_wake_id: wakeId,
      hold_released_at: null,
      // The stop-hold clock runs across passes; only re-arming a released hold restarts it.
      hold_since: !holds ? null : current.hold_released_at !== null || current.hold_since === null ? nowSql() : current.hold_since,
      blocked_reason: null,
    },
    { pass: current.pass },
  );
});

function maintainHold(row: HandoffRow, reason: string | null): void {
  const holds = handoffHoldsAutomation(row);
  if (holds && row.hold_since === null) {
    casHandoff(row.id, [row.state], { hold_since: nowSql() }, { hold_since: null });
    return;
  }
  if (holds && row.state !== "grace" && olderThan(row.hold_since, STOP_HOLD_CAP_SECONDS)) {
    casHandoff(
      row.id,
      [row.state],
      { hold_released_at: nowSql(), blocked_reason: reason ?? "no quiet moment" },
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
  if (!PRE_RESPAWN_STATES.includes(row.state)) {
    settleAfterRespawn(row, lead);
    return;
  }
  if (budget?.auto_handoff !== true) {
    failHandoff(row.id, "lead_turn_budget.auto_handoff is no longer on");
    return;
  }
  if (lead.pane_pid !== row.predecessor_pane_pid || snapshot?.session_id !== row.predecessor_session_id) {
    failHandoff(row.id, "the lead's pane or session changed before the handoff (a restart, /clear or /resume)");
    return;
  }
  if (row.state === "grace") {
    const deadline = (row.grace_seconds ?? 120) + RESPAWN_WAIT_LIMIT_SECONDS + 120;
    const dead = row.owner_pid !== null && !processAlive(row.owner_pid);
    if (dead || olderThan(row.grace_started_at, deadline)) {
      failHandoff(row.id, dead ? "the grace owner process died" : "the grace ran far past its deadline", ["grace"], {
        attempt: row.attempt,
        owner_token: row.owner_token,
      });
    }
    return;
  }
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
        pass_started_at: nowSql(),
        blocked_reason: blocker.reason,
      },
      { pass: row.pass },
    );
    return;
  }
  maintainHold(row, blocker.reason);
}

export const HANDOFF_PAD_SOFT_CAP = 8_000;
const POLL_MS = 1_000;
const RESPAWN_WAIT_LIMIT_SECONDS = 10 * 60;

export function missingHeadings(content: string): string[] {
  const lines = content.split("\n").map((l) => l.replace(/^[#\s*_]+|[\s*_:]+$/g, "").toUpperCase());
  const missing: string[] = [];
  let from = 0;
  for (const heading of HANDOFF_HEADINGS) {
    const at = lines.indexOf(heading, from);
    if (at === -1) missing.push(heading);
    else from = at + 1;
  }
  return missing;
}

export function successorPrompt(row: Pick<HandoffRow, "id" | "predecessor_session_id" | "predecessor_turns" | "reason" | "pass">): string {
  return [
    `You are taking over as this project's lead from session ${row.predecessor_session_id} (hive handoff #${row.id}).`,
    `Read the "${HANDOFF_PAD_NAME}" handoff hive injected at session start (if none arrived, pad_read it by name), ` +
      "then the project's durable state.",
    "Open your first reply with exactly one line:",
    `"Took over from session ${row.predecessor_session_id} at turn ${row.predecessor_turns ?? "?"} (${row.reason}, pass ${row.pass}). ` +
      'Carried over: <a> in flight, <b> queued, <c> questions for you."',
    "counting the IN FLIGHT, QUEUED NEXT and OPEN QUESTIONS FOR THE HUMAN entries, then quote OPEN QUESTIONS FOR THE HUMAN verbatim.",
    "Re-arm everything under SESSION WORK TO RESTORE, check VERIFY ON ARRIVAL, then continue with QUEUED NEXT.",
  ].join("\n");
}

function flags(argv: string[], names: readonly string[]): Record<string, string> | string {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i].replace(/^--/, "");
    if (!argv[i].startsWith("--") || !names.includes(name) || argv[i + 1] === undefined) return `unexpected argument "${argv[i]}"`;
    out[name] = argv[++i];
  }
  const absent = names.filter((n) => out[n] === undefined);
  return absent.length > 0 ? `missing --${absent.join(", --")}` : out;
}

const intFlag = (value: string): number | null => (/^\d+$/.test(value) ? Number(value) : null);

const nowSql = (): string => (db.prepare(`SELECT ${NOW_SQL} AS now`).get() as { now: string }).now;

interface RunningLead extends LeadForHandoff {
  actor_id: string;
  path: string;
  name: string;
}

function runningLeadByActor(actorId: string): RunningLead | undefined {
  return db
    .prepare(
      `SELECT a.id, a.project_id, a.actor_id, a.command, a.pane_pid, a.tmux_target, a.tmux_socket, p.path, p.name
         FROM agents a JOIN projects p ON p.id = a.project_id
        WHERE a.actor_id = ? AND a.kind = 'lead' AND a.status = 'running'`,
    )
    .get(actorId) as RunningLead | undefined;
}

function runningLeadById(id: number): RunningLead | undefined {
  return db
    .prepare(
      `SELECT a.id, a.project_id, a.actor_id, a.command, a.pane_pid, a.tmux_target, a.tmux_socket, p.path, p.name
         FROM agents a JOIN projects p ON p.id = a.project_id WHERE a.id = ? AND a.kind = 'lead' AND a.status = 'running'`,
    )
    .get(id) as RunningLead | undefined;
}

interface PadRow {
  id: number;
  project_id: number;
  name: string;
  archived: number;
  revision: number;
  content: string;
}

const readPad = (id: number): PadRow | undefined =>
  db.prepare("SELECT id, project_id, name, archived, revision, content FROM pads WHERE id = ?").get(id) as PadRow | undefined;

function padProblem(pad: PadRow | undefined, projectId: number, revision: number): string | null {
  if (pad === undefined || pad.project_id !== projectId) return "that pad does not exist in this project";
  if (pad.name !== HANDOFF_PAD_NAME || pad.archived !== 0) return `that pad is not the active "${HANDOFF_PAD_NAME}" pad`;
  if (pad.revision !== revision) return `that pad is at revision ${pad.revision}, not ${revision}; read it back and pass its current revision`;
  if (pad.content.trim() === "") return "the pad is empty";
  return null;
}

// `hive lead-handoff`: the lead's own confirmation that its handoff is persisted. It validates the
// caller, epoch and exact pad revision, claims one attempt, and hands the grace to one detached owner.
export async function cmdLeadHandoff(argv: string[]): Promise<number> {
  const { randomUUID } = await import("node:crypto");
  const { spawn } = await import("node:child_process");
  const { openSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { cliPath } = await import("./dispatcher.js");
  const { dataDir } = await import("./db.js");
  const { rowOwnership } = await import("./tmux.js");
  const refuse = (why: string): number => {
    console.error(`hive lead-handoff: ${why}. This session stays as it is.`);
    return 1;
  };
  const parsed = flags(argv, ["request", "pad", "revision"]);
  if (typeof parsed === "string") return refuse(`${parsed}; usage: hive lead-handoff --request <id> --pad <id> --revision <n>`);
  const [requestId, padId, revision] = [intFlag(parsed.request), intFlag(parsed.pad), intFlag(parsed.revision)];
  if (requestId === null || padId === null || revision === null) return refuse("--request, --pad and --revision take whole numbers");
  const actor = process.env.HIVE_AGENT_ID ?? "";
  const lead = process.env.HIVE_LEAD === "1" ? runningLeadByActor(actor) : undefined;
  if (lead === undefined) return refuse("only a running lead can hand itself off");
  if ((process.env.TMUX_PANE ?? "") !== lead.tmux_target || rowOwnership(lead) !== "live") {
    return refuse("this is not running in the lead's own recorded pane");
  }
  const row = readHandoff(requestId);
  if (row === null || row.lead_agent_id !== lead.id) return refuse(`there is no handoff request #${requestId} for this lead`);
  if (row.state !== "requested") return refuse(`handoff #${requestId} is ${row.state}, not waiting for this command`);
  const snapshot = readLeadSafetySnapshot(lead.id);
  if (lead.pane_pid !== row.predecessor_pane_pid || snapshot?.session_id !== row.predecessor_session_id) {
    return refuse(`handoff #${requestId} was requested for a different session of this lead`);
  }
  const pad = readPad(padId);
  const problem = padProblem(pad, lead.project_id, revision);
  if (problem !== null) return refuse(problem);
  if (row.pad_id === pad!.id && row.pad_revision !== null && pad!.revision <= row.pad_revision) {
    return refuse("this attempt was postponed, so refresh the pad (write it again) and pass the new revision");
  }
  const missing = missingHeadings(pad!.content);
  if (missing.length > 0) return refuse(`the pad is missing these headings, in this order: ${missing.join("; ")}`);
  const inFlight = automationBlocker(lead, null);
  if (inFlight !== null) return refuse(`${inFlight}; run this command again in a minute`);

  const token = randomUUID();
  const policy = quotedPolicy(row);
  const claimed = casHandoff(
    row.id,
    ["requested"],
    {
      state: "grace",
      attempt: row.attempt + 1,
      owner_token: token,
      grace_seconds: policy.graceSeconds,
      grace_started_at: nowSql(),
      human_prompt_baseline: snapshot!.human_prompt_seq,
      pad_id: pad!.id,
      pad_revision: pad!.revision,
      pad_length: pad!.content.length,
      pad_sha256: sha256(pad!.content),
      predecessor_turns: readTurnCount(snapshot!.transcript_path),
      hold_since: row.hold_since ?? nowSql(),
      hold_released_at: null,
    },
    { attempt: row.attempt },
  );
  if (!claimed) return refuse(`handoff #${requestId} changed while this command ran`);
  const attempt = row.attempt + 1;
  try {
    const log = openSync(join(dataDir, `lead-handoff-${row.id}.log`), "a");
    const child = spawn(
      process.execPath,
      [cliPath(), "lead-handoff-grace", "--request", String(row.id), "--attempt", String(attempt), "--token", token],
      { detached: true, stdio: ["ignore", log, log], env: process.env },
    );
    child.unref();
    if (child.pid === undefined) throw new Error("no process id");
    casHandoff(row.id, ["grace"], { owner_pid: child.pid }, { attempt, owner_token: token });
  } catch (e) {
    failHandoff(row.id, `the grace owner could not start: ${e instanceof Error ? e.message : String(e)}`, ["grace"], {
      attempt,
      owner_token: token,
    });
    return refuse("the grace owner could not start, so the handoff failed");
  }
  if (pad!.content.length > HANDOFF_PAD_SOFT_CAP) {
    console.log(`! the pad is ${pad!.content.length} characters, over the ${HANDOFF_PAD_SOFT_CAP}-character guide; point into the store instead of copying it.`);
  }
  console.log(
    `Handoff #${row.id} armed (attempt ${attempt}, pad #${pad!.id} revision ${pad!.revision}). hive replaces this session in ` +
      `${policy.graceSeconds} s if nothing happens; any human input postpones it. End your turn now.`,
  );
  return 0;
}

function postpone(row: HandoffRow, token: string, reason: string, escalate: boolean): void {
  casHandoff(
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
    { attempt: row.attempt, owner_token: token },
  );
}

type Verdict = { go: true } | { wait: string } | { postpone: string; escalate: boolean } | { fail: string };

// The final quiet check. A screen or probe that cannot be read waits; it never establishes quiet.
async function respawnVerdict(row: HandoffRow, lead: RunningLead | undefined, budget: LeadTurnBudget | null): Promise<Verdict> {
  const { rowOwnership, paneInCopyMode, holdsHumanInput, tmuxSocketPath } = await import("./tmux.js");
  const { paneClassifierFor } = await import("./harnesses.js");
  if (budget?.auto_handoff !== true) return { fail: "lead_turn_budget.auto_handoff is no longer on" };
  if (lead === undefined || lead.pane_pid !== row.predecessor_pane_pid || lead.tmux_target !== row.pane_target) {
    return { fail: "the lead row no longer names the pane this handoff was requested for" };
  }
  if (tmuxSocketPath(process.env.TMUX, process.env.TMUX_TMPDIR) !== row.tmux_socket) {
    return { fail: "the grace owner is not talking to the lead's tmux server" };
  }
  const snapshot = readLeadSafetySnapshot(lead.id);
  if (snapshot?.session_id !== row.predecessor_session_id) return { fail: "the lead's session changed" };
  if (snapshot.human_prompt_seq !== row.human_prompt_baseline) return { postpone: "a human prompt arrived during grace", escalate: true };
  const ownership = rowOwnership(lead);
  if (ownership === "unknown") return { wait: "the lead's pane ownership reads unknown" };
  if (ownership !== "live") return { fail: `the lead's pane is ${ownership}` };
  if (snapshot.state !== "idle") return { wait: "the lead's turn has not ended" };
  const background = backgroundVeto(snapshot);
  if (background !== null) return { wait: background };
  const pad = row.pad_id === null ? undefined : readPad(row.pad_id);
  if (padProblem(pad, lead.project_id, row.pad_revision ?? -1) !== null) {
    return { postpone: "the handoff pad changed after the command", escalate: false };
  }
  const policy = quotedPolicy(row);
  if (!olderThan(snapshot.human_prompt_at, policy.humanQuietSeconds)) {
    return { wait: `a human prompt arrived in the last ${policy.humanQuietSeconds} s` };
  }
  const automation = automationBlocker(lead, policy.automationQuietSeconds);
  if (automation !== null) return { wait: automation };
  if (paneInCopyMode(lead.tmux_target) !== false) return { wait: "the lead's pane is in copy mode or unreadable" };
  const classifier = paneClassifierFor(lead.command);
  if (!classifier) return { fail: "hive cannot classify the lead's screen" };
  const choice = classifier.choiceCheck(lead.tmux_target).awaitingChoice;
  if (choice !== false) return { wait: choice ? "the lead's pane is waiting on a choice" : "the lead's pane could not be read" };
  const box = classifier.inputBoxState(lead.tmux_target);
  if (holdsHumanInput(box)) return { postpone: "unsubmitted text is in the lead's input box", escalate: true };
  if (box === null || (box.state !== "empty" && box.state !== "ghost")) return { wait: "the lead's input box could not be read" };
  return { go: true };
}

// Prepared before the destructive claim: a launch that cannot be built leaves the predecessor alive.
async function successorLaunch(row: HandoffRow, lead: RunningLead, attempt: number, token: string): Promise<{ launch: string; env: string[] }> {
  const { loadProjectYml } = await import("./projectYml.js");
  const { appendClaudeLeadArgs, crewPluginDir, isTrusted, leadIdentityEnv, renderLeadPosture } = await import("./leadLaunch.js");
  const { ensureLeadHooksFile } = await import("./hooks.js");
  const { cliPath } = await import("./dispatcher.js");
  const { FIRST_MESSAGE_SHA_ENV, firstMessageDigest } = await import("./firstMessage.js");
  const { buildEnvFlags } = await import("./spawn.js");
  const { shellQuote } = await import("./tmux.js");
  const config = loadProjectYml(lead.path).config;
  let command = "claude";
  if (config?.lead) {
    if (!isTrusted(lead.project_id, "lead", config.lead, null, {})) throw new Error("the configured lead command is not trusted");
    command = config.lead;
  }
  const harness = harnessFor(command);
  if (harness.name !== "claude" || !harness.briefDelivery) throw new Error("the configured lead command is not a Claude lead");
  const firstMessage = successorPrompt(row);
  const built = appendClaudeLeadArgs({
    command,
    harness,
    projectId: lead.project_id,
    projectName: lead.name,
    hooksPath: ensureLeadHooksFile(lead.project_id, config?.quiet_messaging === true),
    sidebarPluginDir: config?.lead_sidebar === true ? crewPluginDir() : null,
    posture: renderLeadPosture(config).rendered,
    firstMessage,
  });
  const bootstrap = [process.execPath, cliPath(), "lead-handoff-start", "--request", String(row.id), "--attempt", String(attempt), "--token", token]
    .map(shellQuote)
    .join(" ");
  return {
    launch: `${bootstrap} && exec ${built.command}${built.promptSuffix}`,
    env: buildEnvFlags({ ...leadIdentityEnv(lead.actor_id), [FIRST_MESSAGE_SHA_ENV]: firstMessageDigest(firstMessage) }),
  };
}

const sleepMs = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// `hive lead-handoff-grace`: the one detached owner of an attempt. It never outlives a changed
// attempt or token, and after it claims the respawn it never repeats the kill.
export async function runHandoffGrace(argv: string[]): Promise<number> {
  try {
    return await graceLoop(argv);
  } catch (e) {
    const parsed = flags(argv, ["request", "attempt", "token"]);
    const id = typeof parsed === "string" ? null : intFlag(parsed.request);
    const attempt = typeof parsed === "string" ? null : intFlag(parsed.attempt);
    if (id !== null && attempt !== null && typeof parsed !== "string") {
      failHandoff(id, `the grace owner failed: ${e instanceof Error ? e.message : String(e)}`, ["grace"], {
        attempt,
        owner_token: parsed.token,
      });
    }
    return 1;
  }
}

async function graceLoop(argv: string[]): Promise<number> {
  const { loadProjectYml } = await import("./projectYml.js");
  const { tmux, TmuxTimeoutError } = await import("./tmux.js");
  const parsed = flags(argv, ["request", "attempt", "token"]);
  if (typeof parsed === "string") return 1;
  const id = intFlag(parsed.request);
  const attempt = intFlag(parsed.attempt);
  const token = parsed.token;
  if (id === null || attempt === null) return 1;
  const own = (row: HandoffRow | null): row is HandoffRow =>
    row !== null && row.state === "grace" && row.attempt === attempt && row.owner_token === token;
  let waitingSince: number | null = null;
  for (;;) {
    const row = readHandoff(id);
    if (!own(row)) return 0;
    const lead = runningLeadById(row.lead_agent_id);
    const snapshot = lead === undefined ? null : readLeadSafetySnapshot(lead.id);
    if (snapshot !== null && row.human_prompt_baseline !== null && snapshot.human_prompt_seq > row.human_prompt_baseline) {
      postpone(row, token, "a human prompt arrived during grace", true);
      return 0;
    }
    if (!olderThan(row.grace_started_at, row.grace_seconds ?? 120)) {
      await sleepMs(POLL_MS);
      continue;
    }
    const budget = lead === undefined ? null : (loadProjectYml(lead.path).config?.lead_turn_budget ?? null);
    const verdict = await respawnVerdict(row, lead, budget);
    if ("fail" in verdict) {
      failHandoff(row.id, verdict.fail, ["grace"], { attempt, owner_token: token });
      return 0;
    }
    if ("postpone" in verdict) {
      postpone(row, token, verdict.postpone, verdict.escalate);
      return 0;
    }
    if ("wait" in verdict) {
      waitingSince ??= Date.now();
      if (row.blocked_reason !== verdict.wait) casHandoff(row.id, ["grace"], { blocked_reason: verdict.wait }, { attempt, owner_token: token });
      if (Date.now() - waitingSince >= RESPAWN_WAIT_LIMIT_SECONDS * 1000) {
        postpone(row, token, verdict.wait, false);
        return 0;
      }
      await sleepMs(POLL_MS);
      continue;
    }
    let launch: { launch: string; env: string[] };
    try {
      launch = await successorLaunch(row, lead!, attempt, token);
    } catch (e) {
      failHandoff(row.id, `the successor launch could not be prepared: ${e instanceof Error ? e.message : String(e)}`, ["grace"], {
        attempt,
        owner_token: token,
      });
      return 0;
    }
    if (!casHandoff(row.id, ["grace"], { state: "respawning", owner_pid: process.pid, respawn_claimed_at: nowSql() }, { attempt, owner_token: token })) return 0;
    try {
      tmux("respawn-pane", "-k", "-t", row.pane_target, "-c", lead!.path, ...launch.env, launch.launch);
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      if (e instanceof TmuxTimeoutError) {
        casHandoff(row.id, ["respawning"], { state: "ambiguous", failure: `respawn-pane timed out; the pane's owner is unknown: ${detail}` }, { attempt, owner_token: token });
      } else {
        failHandoff(row.id, `respawn-pane refused: ${detail}`, ["respawning"], { attempt, owner_token: token });
      }
    }
    return 0;
  }
}

// `hive lead-handoff-start`: runs in the respawned pane before Claude. It publishes the successor's
// pid on the same lead row by CAS against the predecessor, and only then lets the shell exec Claude.
export async function runHandoffStart(argv: string[]): Promise<number> {
  const { panePidForRecord } = await import("./tmux.js");
  const parsed = flags(argv, ["request", "attempt", "token"]);
  const refuse = (why: string, id?: number): number => {
    if (id !== undefined) {
      casHandoff(id, ["respawning", "ambiguous"], { state: "failed", failure: `the successor bootstrap refused: ${why}`, owner_token: null, owner_pid: null });
    }
    console.error(`hive lead-handoff-start: ${why}. The handoff pad stays active; run hive lead to start a lead.`);
    return 1;
  };
  if (typeof parsed === "string") return refuse(parsed);
  const id = intFlag(parsed.request);
  const attempt = intFlag(parsed.attempt);
  if (id === null || attempt === null) return refuse("bad arguments");
  const row = readHandoff(id);
  if (row === null || (row.state !== "respawning" && row.state !== "ambiguous") || row.attempt !== attempt || row.owner_token !== parsed.token) {
    return refuse("this bootstrap does not own a respawning handoff");
  }
  const pane = process.env.TMUX_PANE ?? "";
  if (pane !== row.pane_target) return refuse("this is not the pane the handoff respawned", id);
  const pid = panePidForRecord(pane);
  if (pid === "" || pid !== String(process.ppid)) return refuse("the pane's process id does not match this bootstrap's shell", id);
  const publish = db.transaction((): boolean => {
    const moved = db
      .prepare(
        `UPDATE agents SET pane_pid = ?, claude_messaging_socket = '', claude_messaging_pane_pid = ''
          WHERE id = ? AND kind = 'lead' AND status = 'running' AND tmux_target = ? AND pane_pid = ?`,
      )
      .run(pid, row.lead_agent_id, row.pane_target, row.predecessor_pane_pid).changes;
    if (moved !== 1) return false;
    const started = casHandoff(
      id,
      ["respawning", "ambiguous"],
      { state: "started", successor_pane_pid: pid, started_at: nowSql(), owner_token: null, owner_pid: null, failure: null },
      { attempt, owner_token: parsed.token },
    );
    if (!started) throw new Error("handoff changed");
    return true;
  });
  let published: boolean;
  try {
    published = publish.immediate();
  } catch {
    published = false;
  }
  if (!published) return refuse("the lead row could not be moved to the new pane process", id);
  console.log(`hive: handoff #${id}: starting a fresh lead session in this pane.`);
  return 0;
}

const MARKER_SECONDS = 30 * 60;

// The SessionStart payload for a starting lead whose project holds an active handoff pad: the pad in
// full, plus what hive itself knows. Never truncated; never shown to a worker.
export function handoffInjection(leadActor: string): string | null {
  const lead = runningLeadByActor(leadActor);
  if (lead === undefined) return null;
  const pad = db
    .prepare("SELECT id, revision, content, updated_at FROM pads WHERE project_id = ? AND name = ? AND archived = 0")
    .get(lead.project_id, HANDOFF_PAD_NAME) as { id: number; revision: number; content: string; updated_at: string } | undefined;
  if (pad === undefined) return null;
  const row = db
    .prepare(
      `SELECT * FROM lead_handoffs WHERE lead_agent_id = ? AND pad_id = ?
         AND (state IN ('started', 'ambiguous') OR (state = 'failed' AND respawn_claimed_at IS NOT NULL))
       ORDER BY id DESC LIMIT 1`,
    )
    .get(lead.id, pad.id) as HandoffRow | undefined;
  if (row === undefined) return null;
  const workers = db
    .prepare("SELECT name, agent_state FROM agents WHERE project_id = ? AND kind = 'agent' AND status = 'running' ORDER BY id")
    .all(lead.project_id) as { name: string; agent_state: string }[];
  const pending = (
    db
      .prepare("SELECT COUNT(*) AS n FROM wakes WHERE deliver_actor = ? AND fired_at IS NULL AND cancelled_at IS NULL")
      .get(lead.actor_id) as { n: number }
  ).n;
  const heldWakes = (
    db.prepare("SELECT COUNT(*) AS n FROM wakes WHERE deliver_actor = ? AND held_reason = ? AND cancelled_at IS NULL").get(lead.actor_id, HELD_REASON_HANDOFF) as {
      n: number;
    }
  ).n;
  const heldMessages = (
    db
      .prepare("SELECT COUNT(*) AS n FROM agent_messages WHERE to_agent_id = ? AND delivery_status = 'fallback-pending' AND created_at >= datetime('now', '-7 days')")
      .get(lead.id) as { n: number }
  ).n;
  const lines = [`[hive] LEAD HANDOFF: pad "${HANDOFF_PAD_NAME}" #${pad.id} revision ${pad.revision}, written ${pad.updated_at} UTC.`];
  {
    lines.push(
      `Handed off by session ${row.predecessor_session_id} at turn ${row.predecessor_turns ?? "?"} (${row.reason}, pass ${row.pass})` +
        `${row.started_at ? ` at ${row.started_at} UTC` : ""}; handoff #${row.id} is ${row.state}.`,
    );
  }
  lines.push(
    workers.length === 0 ? "Workers: none running." : `Workers: ${workers.map((w) => `${w.name} [${w.agent_state}]`).join(", ")}.`,
    `Wakes pending for this lead: ${pending}. Held for the handoff and released to you now: ${heldWakes} wake(s), ${heldMessages} message(s).`,
    row.state === "started"
      ? `hive archives this pad after your first completed turn. Then append one line to it with ` +
        `pad_append(pad_id: ${pad.id}): "missing from the handoff: <what you had to find yourself>" or "missing from the handoff: none".`
      : `This handoff did not complete (${row.state}${row.failure ? `: ${row.failure}` : ""}), so hive will not archive the pad; ` +
        `archive it with pad_archive(pad_id: ${pad.id}) once you have taken it over.`,
    "",
    pad.content,
  );
  return lines.join("\n");
}

// An appended line (the successor's gaps note) keeps the delivered text as a prefix and still archives.
function stillDelivered(row: HandoffRow): { revision: number } | null {
  if (row.pad_id === null || row.pad_revision === null || row.pad_length === null || row.pad_sha256 === null) return null;
  const pad = readPad(row.pad_id);
  if (pad === undefined || pad.archived !== 0 || pad.name !== HANDOFF_PAD_NAME || pad.revision < row.pad_revision) return null;
  return sha256(pad.content.slice(0, row.pad_length)) === row.pad_sha256 ? { revision: pad.revision } : null;
}

const completeTransaction = db.transaction((row: HandoffRow, sessionId: string): void => {
  const current = stillDelivered(row);
  const archived =
    current !== null &&
    db
      .prepare(
        `UPDATE pads SET archived = 1, revision = revision + 1, updated_by = 'hive', updated_at = datetime('now')
          WHERE id = ? AND revision = ? AND archived = 0 AND name = ?`,
      )
      .run(row.pad_id, current.revision, HANDOFF_PAD_NAME).changes === 1;
  casHandoff(row.id, ["started"], {
    state: "completed",
    successor_session_id: sessionId,
    completed_at: nowSql(),
    delivered_pad_id: archived ? row.pad_id : null,
    delivered_pad_revision: archived ? row.pad_revision : null,
    failure: archived ? null : "the delivered handoff text was edited after the command, so the pad was left active",
  });
});

// The successor's first completed turn: a Stop in a new session on the successor's pane, after at
// least one prompt there, with no background work. Anything else leaves the pad active.
export function completeHandoffOnStop(actorId: string): boolean {
  const lead = runningLeadByActor(actorId);
  if (lead === undefined) return false;
  const row = db.prepare("SELECT * FROM lead_handoffs WHERE lead_agent_id = ? AND state = 'started'").get(lead.id) as HandoffRow | undefined;
  if (row === undefined || lead.pane_pid !== row.successor_pane_pid) return false;
  const snapshot = readLeadSafetySnapshot(lead.id);
  if (
    snapshot === null ||
    snapshot.pane_pid !== lead.pane_pid ||
    snapshot.snapshot_session_id !== snapshot.session_id ||
    snapshot.session_id === row.predecessor_session_id ||
    snapshot.stop_prompt_seq === null ||
    snapshot.stop_prompt_seq < 1 ||
    snapshot.stop_prompt_seq !== snapshot.prompt_seq
  ) {
    return false;
  }
  completeTransaction.immediate(row, snapshot.session_id);
  return readHandoff(row.id)?.state === "completed";
}

export function handoffStatusSegment(leadAgentId: number): string | null {
  const row = readActiveHandoff(leadAgentId);
  if (row !== null) {
    if (row.hold_released_at !== null) return `handoff blocked: ${row.blocked_reason ?? "no quiet moment"}`;
    if (row.state === "grace") return "handoff in grace";
    return `handoff ${row.state.replace("_", " ")}`;
  }
  const done = db
    .prepare(
      `SELECT CAST((julianday('now') - julianday(completed_at)) * 86400 AS INTEGER) AS age FROM lead_handoffs
        WHERE lead_agent_id = ? AND state = 'completed' ORDER BY id DESC LIMIT 1`,
    )
    .get(leadAgentId) as { age: number } | undefined;
  if (done === undefined || done.age > MARKER_SECONDS) return null;
  return `handed off ${done.age < 60 ? `${done.age}s` : `${Math.floor(done.age / 60)}m`} ago`;
}
