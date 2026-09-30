import { db } from "./db.js";
import { TRIAGE_MESSAGE } from "./kickoff.js";

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

interface LeadHookPayload {
  session_id?: unknown;
  prompt?: unknown;
}

export function readLeadTurnState(agentId: number): LeadTurnState | null {
  return (db.prepare("SELECT * FROM lead_turn_state WHERE agent_id = ?").get(agentId) as LeadTurnState | undefined) ?? null;
}

function isHiveTriage(payload: LeadHookPayload): boolean {
  return typeof payload.prompt === "string" && payload.prompt.trim() === TRIAGE_MESSAGE;
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
      return isHiveTriage(payload) ? base : { ...base, state: "working" };
    case "stop":
      if (base.state !== "working" || subagentsLive()) return base;
      return { ...base, state: "idle", idle_seq: base.idle_seq + 1 };
    case "session_end":
      return { ...base, state: "unknown" };
    default:
      return null;
  }
}

const applyInTransaction = db.transaction(
  (agentId: number, panePid: string, event: string, payload: LeadHookPayload, subagentsLive: () => boolean): void => {
    const cur = readLeadTurnState(agentId);
    const next = nextLeadTurn(cur, panePid, event, payload, subagentsLive);
    if (next === null) return;
    if (
      cur !== null &&
      cur.pane_pid === next.pane_pid &&
      cur.session_id === next.session_id &&
      cur.state === next.state &&
      cur.idle_seq === next.idle_seq
    ) {
      return;
    }
    db.prepare(
      `INSERT INTO lead_turn_state (agent_id, pane_pid, session_id, state, idle_seq, last_event, changed_at)
       VALUES (?, ?, ?, ?, ?, ?, strftime('%Y-%m-%d %H:%M:%f', 'now'))
       ON CONFLICT(agent_id) DO UPDATE SET pane_pid = excluded.pane_pid, session_id = excluded.session_id,
         state = excluded.state, idle_seq = excluded.idle_seq, last_event = excluded.last_event,
         changed_at = excluded.changed_at`,
    ).run(agentId, next.pane_pid, next.session_id, next.state, next.idle_seq, event);
  },
);

export function applyLeadHook(actorId: string, event: string, payload: LeadHookPayload, subagentsLive: () => boolean): void {
  const lead = db
    .prepare("SELECT id, pane_pid FROM agents WHERE actor_id = ? AND kind = 'lead' AND status = 'running' ORDER BY id DESC LIMIT 1")
    .get(actorId) as { id: number; pane_pid: string } | undefined;
  if (!lead) return;
  applyInTransaction.immediate(lead.id, lead.pane_pid, event, payload, subagentsLive);
}
