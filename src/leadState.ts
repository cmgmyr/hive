import { liveBackgroundTasks } from "./backgroundTasks.js";
import { db } from "./db.js";
import { FIRST_MESSAGE_SHA_ENV, firstMessageDigest } from "./firstMessage.js";
import type { RowOwnership } from "./tmux.js";

export type LeadTurn = "unknown" | "working" | "idle";

export interface LeadTurnState {
  agent_id: number;
  pane_pid: string;
  session_id: string;
  state: LeadTurn;
  idle_seq: number;
  last_event: string;
  changed_at: string;
}

// The current epoch's safety evidence, kept beside the turn state. A handoff reads it to decide
// that nothing in the session would die with a respawn; it is never a source of working/idle.
export interface LeadSafetySnapshot {
  snapshot_pane_pid: string;
  snapshot_session_id: string;
  prompt_seq: number;
  human_prompt_seq: number;
  human_prompt_at: string | null;
  transcript_path: string;
  stop_prompt_seq: number | null;
  stop_background: string | null;
  stop_at: string | null;
  open_subagents: string;
}

interface LeadHookPayload {
  session_id?: unknown;
  prompt?: unknown;
  transcript_path?: unknown;
  background_tasks?: unknown;
  agent_id?: unknown;
}

export function readLeadTurnState(agentId: number): LeadTurnState | null {
  return (db.prepare("SELECT * FROM lead_turn_state WHERE agent_id = ?").get(agentId) as LeadTurnState | undefined) ?? null;
}

export function leadSessionEnded(
  row: { id: number; pane_pid: string },
  ownership: RowOwnership,
): { ended_at: string } | null {
  if ((ownership !== "gone" && ownership !== "reissued") || row.pane_pid === "") return null;
  const turn = readLeadTurnState(row.id);
  return turn?.last_event === "session_end" && turn.pane_pid === row.pane_pid ? { ended_at: turn.changed_at } : null;
}

// Mirrors the exclusions conversationHoldsWake applies to agent_state_log (src/scheduler.ts).
// Mirrors the exclusions conversationHoldsWake applies to agent_state_log (src/scheduler.ts),
// including SQLite LIKE's ASCII case-insensitivity.
export function isHumanPrompt(prompt: string): boolean {
  const p = prompt.toLowerCase();
  if (p.includes("[hive wake #") || p.startsWith("[hive:") || p.startsWith("<task-notification>")) return false;
  return !/^<cross-session-message from="[\s\S]*" from-name="hive">\n\[hive:worker [\s\S]*\] \[message #[\s\S]*,[\s\S]*\n<\/cross-session-message>/.test(p);
}

function isHiveFirstMessage(payload: LeadHookPayload): boolean {
  if (typeof payload.prompt !== "string") return false;
  const prompt = payload.prompt.trim();
  const launched = process.env[FIRST_MESSAGE_SHA_ENV];
  return !!launched && firstMessageDigest(prompt) === launched;
}

// "idle" means the lead's turn ended after a prompt hive did not type itself, in this pane launch
// and this session. It never means the lead finished all its work.
export function nextLeadTurn(
  cur: Pick<LeadTurnState, "pane_pid" | "session_id" | "state" | "idle_seq"> | null,
  panePid: string,
  event: string,
  payload: LeadHookPayload,
  subagentsLive: () => boolean,
): { pane_pid: string; session_id: string; state: LeadTurn; idle_seq: number } | null {
  const sessionId = typeof payload.session_id === "string" ? payload.session_id : "";
  if (sessionId === "") return null;
  const sameEpoch = cur !== null && cur.pane_pid === panePid && cur.session_id === sessionId;
  const base = sameEpoch
    ? { pane_pid: panePid, session_id: sessionId, state: cur.state, idle_seq: cur.idle_seq }
    : { pane_pid: panePid, session_id: sessionId, state: "unknown" as LeadTurn, idle_seq: cur?.idle_seq ?? 0 };
  switch (event) {
    case "prompt":
      return isHiveFirstMessage(payload) ? base : { ...base, state: "working" };
    case "stop":
      if (base.state !== "working" || subagentsLive()) return base;
      return { ...base, state: "idle", idle_seq: base.idle_seq + 1 };
    case "session_end":
      if (cur === null || cur.session_id !== sessionId) return null;
      return { pane_pid: cur.pane_pid, session_id: sessionId, state: "unknown", idle_seq: cur.idle_seq };
    default:
      return null;
  }
}

export function readLeadSafetySnapshot(agentId: number): (LeadTurnState & LeadSafetySnapshot) | null {
  return (
    (db.prepare("SELECT * FROM lead_turn_state WHERE agent_id = ?").get(agentId) as
      | (LeadTurnState & LeadSafetySnapshot)
      | undefined) ?? null
  );
}

function applySnapshot(agentId: number, panePid: string, event: string, payload: LeadHookPayload): void {
  const row = readLeadSafetySnapshot(agentId);
  const sessionId = typeof payload.session_id === "string" ? payload.session_id : "";
  if (row === null || sessionId === "" || row.pane_pid !== panePid || row.session_id !== sessionId) return;
  const fresh = row.snapshot_pane_pid !== panePid || row.snapshot_session_id !== sessionId;
  const snap = {
    prompt_seq: fresh ? 0 : row.prompt_seq,
    human_prompt_seq: fresh ? 0 : row.human_prompt_seq,
    human_prompt_at: fresh ? null : row.human_prompt_at,
    transcript_path: fresh ? "" : row.transcript_path,
    stop_prompt_seq: fresh ? null : row.stop_prompt_seq,
    stop_background: fresh ? null : row.stop_background,
    stop_at: fresh ? null : row.stop_at,
    open: new Set<string>(fresh ? [] : (JSON.parse(row.open_subagents) as string[])),
  };
  if (typeof payload.transcript_path === "string" && payload.transcript_path !== "") {
    snap.transcript_path = payload.transcript_path;
  }
  const now = (db.prepare("SELECT strftime('%Y-%m-%d %H:%M:%f', 'now') AS now").get() as { now: string }).now;
  const subagentId = typeof payload.agent_id === "string" ? payload.agent_id : "";
  switch (event) {
    case "prompt":
      snap.prompt_seq += 1;
      if (typeof payload.prompt === "string" && !isHiveFirstMessage(payload) && isHumanPrompt(payload.prompt.trim())) {
        snap.human_prompt_seq += 1;
        snap.human_prompt_at = now;
        // A human prompt during grace postpones that attempt at once; the grace owner sees it too.
        db.prepare(
          `UPDATE lead_handoffs SET state = 'postponed', pass = pass + 1, pass_started_at = ?, owner_token = NULL,
             owner_pid = NULL, blocked_reason = 'a human prompt arrived during grace', hold_since = NULL,
             hold_released_at = NULL, updated_at = ?
           WHERE lead_agent_id = ? AND state = 'grace' AND predecessor_session_id = ?`,
        ).run(now, now, agentId, sessionId);
      }
      break;
    case "stop":
      snap.stop_prompt_seq = snap.prompt_seq;
      snap.stop_at = now;
      // No background_tasks in the payload is unknown evidence, never an empty list.
      snap.stop_background = payload.background_tasks === undefined
        ? null
        : JSON.stringify(liveBackgroundTasks(payload.background_tasks));
      break;
    case "subagent_start":
      if (subagentId !== "") snap.open.add(subagentId);
      break;
    case "subagent_stop":
      if (subagentId !== "") snap.open.delete(subagentId);
      break;
  }
  db.prepare(
    `UPDATE lead_turn_state SET snapshot_pane_pid = ?, snapshot_session_id = ?, prompt_seq = ?, human_prompt_seq = ?,
       human_prompt_at = ?, transcript_path = ?, stop_prompt_seq = ?, stop_background = ?, stop_at = ?, open_subagents = ?
     WHERE agent_id = ?`,
  ).run(
    panePid, sessionId, snap.prompt_seq, snap.human_prompt_seq, snap.human_prompt_at, snap.transcript_path,
    snap.stop_prompt_seq, snap.stop_background, snap.stop_at, JSON.stringify([...snap.open].sort()), agentId,
  );
}

// A late hook from a handed-off predecessor session must not reset or advance its successor.
function fromHandedOffPredecessor(agentId: number, payload: LeadHookPayload): boolean {
  return typeof payload.session_id === "string" && db
    .prepare(
      `SELECT 1 AS hit FROM lead_handoffs WHERE lead_agent_id = ? AND predecessor_session_id = ?
         AND state IN ('respawning', 'started', 'completed', 'ambiguous')`,
    )
    .get(agentId, payload.session_id) !== undefined;
}

const applyInTransaction = db.transaction(
  (agentId: number, panePid: string, event: string, payload: LeadHookPayload, subagentsLive: () => boolean): void => {
    if (fromHandedOffPredecessor(agentId, payload)) return;
    const cur = readLeadTurnState(agentId);
    const next = nextLeadTurn(cur, panePid, event, payload, subagentsLive);
    const unchanged =
      next === null ||
      (cur !== null &&
        cur.pane_pid === next.pane_pid &&
        cur.session_id === next.session_id &&
        cur.state === next.state &&
        cur.idle_seq === next.idle_seq &&
        (event !== "session_end" || cur.last_event === "session_end"));
    if (!unchanged) {
      db.prepare(
        `INSERT INTO lead_turn_state (agent_id, pane_pid, session_id, state, idle_seq, last_event, changed_at)
         VALUES (?, ?, ?, ?, ?, ?, strftime('%Y-%m-%d %H:%M:%f', 'now'))
         ON CONFLICT(agent_id) DO UPDATE SET pane_pid = excluded.pane_pid, session_id = excluded.session_id,
           state = excluded.state, idle_seq = excluded.idle_seq, last_event = excluded.last_event,
           changed_at = excluded.changed_at`,
      ).run(agentId, next.pane_pid, next.session_id, next.state, next.idle_seq, event);
    }
    applySnapshot(agentId, panePid, event, payload);
  },
);

export function applyLeadHook(actorId: string, event: string, payload: LeadHookPayload, subagentsLive: () => boolean): void {
  const lead = db
    .prepare("SELECT id, pane_pid FROM agents WHERE actor_id = ? AND kind = 'lead' AND status = 'running' ORDER BY id DESC LIMIT 1")
    .get(actorId) as { id: number; pane_pid: string } | undefined;
  if (!lead) return;
  applyInTransaction.immediate(lead.id, lead.pane_pid, event, payload, subagentsLive);
}
