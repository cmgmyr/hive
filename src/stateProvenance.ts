import type { Statement } from "better-sqlite3";
import { db } from "./db.js";
import { awaitingFirstPrompt } from "./firstPrompt.js";
import { harnessFor } from "./harnesses.js";
import { sanitizeEventForDisplay, type Liveness } from "./tmux.js";

const prepared = new Map<string, Statement>();
function stmt(sql: string): Statement {
  let s = prepared.get(sql);
  if (!s) {
    s = db.prepare(sql);
    prepared.set(sql, s);
  }
  return s;
}

export type ProvenanceSource = "hook" | "tmux-probe" | "not-instrumented" | "no-record";

export interface StateProvenance {
  state: string;
  source: ProvenanceSource;
  event: string | null;
  since: string | null;
  age_seconds: number | null;
  last_seen: string | null;

  awaiting_first_prompt?: true;
}

export interface ProvenanceRow {
  actor_id: string;
  command: string;
  agent_state: string;
  state_changed_at: string | null;
  kind: string;

  resumed_at: string;
}

function parseStoreTimestamp(ts: string): number {
  return new Date(`${ts.replace(" ", "T")}Z`).getTime();
}

export function ageSecondsSince(storeTimestamp: string, now: number = Date.now()): number {
  return Math.max(0, Math.round((now - parseStoreTimestamp(storeTimestamp)) / 1000));
}

export function humanizeAge(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h`;
}

export function deriveProvenance(
  row: ProvenanceRow,
  alive: Liveness,
  now: number = Date.now(),
): StateProvenance {
  const lastSeenRow = stmt("SELECT last_seen_at FROM actors WHERE id = ?").get(row.actor_id) as
    | { last_seen_at: string }
    | undefined;
  const last_seen = lastSeenRow?.last_seen_at ?? null;

  if (alive === false) {
    return { state: "gone", source: "tmux-probe", event: null, since: null, age_seconds: null, last_seen };
  }

  if (!reportsAgentStateLog(row)) {
    return {
      state: row.agent_state,
      source: "not-instrumented",
      event: null,
      since: null,
      age_seconds: null,
      last_seen,
    };
  }

  const since = row.state_changed_at;
  const age_seconds = since ? ageSecondsSince(since, now) : null;

  const logRow = since
    ? (stmt(
        "SELECT event FROM agent_state_log WHERE actor_id = ? AND state = ? ORDER BY id DESC LIMIT 1",
      ).get(row.actor_id, row.agent_state) as { event: string } | undefined)
    : undefined;

  return {
    state: row.agent_state,
    source: logRow ? "hook" : "no-record",
    event: logRow ? logRow.event : null,
    since,
    age_seconds,
    last_seen,

    ...(awaitingFirstPrompt(row) ? { awaiting_first_prompt: true as const } : {}),
  };
}

export function describeForHuman(prov: StateProvenance, now: number = Date.now()): string {

  if (prov.awaiting_first_prompt && prov.state === "idle") {
    return prov.age_seconds == null
      ? "idle (no assignment yet)"
      : `idle (no assignment yet, ${humanizeAge(prov.age_seconds)} ago)`;
  }
  switch (prov.source) {
    case "not-instrumented":
      return `${prov.state} (not instrumented)`;
    case "tmux-probe":
      return prov.last_seen
        ? `${prov.state} (last seen ${humanizeAge(ageSecondsSince(prov.last_seen, now))} ago)`
        : prov.state;
    case "no-record":
      return prov.age_seconds == null
        ? `${prov.state} (no record)`
        : `${prov.state} (no record, ${humanizeAge(prov.age_seconds)} ago)`;
    case "hook":
      return `${prov.state} (${prov.event}, ${humanizeAge(prov.age_seconds as number)} ago)`;
  }
}

export interface LastLogEvent {
  event: string;
  state: string;
  age_seconds: number;
  at: string;
}

export function lastLogEvent(actorId: string, now: number = Date.now()): LastLogEvent | null {
  const row = stmt(
    "SELECT event, state, created_at FROM agent_state_log WHERE actor_id = ? ORDER BY id DESC LIMIT 1",
  ).get(actorId) as { event: string; state: string; created_at: string } | undefined;
  if (!row) return null;
  return { event: row.event, state: row.state, age_seconds: ageSecondsSince(row.created_at, now), at: row.created_at };
}

export function describeLastLogEvent(log: LastLogEvent | null): string {
  return log ? `${sanitizeEventForDisplay(log.event)} (${humanizeAge(log.age_seconds)} ago)` : "no record";
}

export function reportsAgentStateLog(row: { kind: string; command: string }): boolean {
  return row.kind === "agent" && harnessFor(row.command).stateSource;
}

const PERMISSION_MODE_RE = /"permission_mode":"([a-zA-Z]+)"/;

// Regex over raw payload, not the last row's JSON.parse: a Notification row never carries this key.
export function lastPermissionMode(actorId: string): string | null {
  const row = stmt(
    "SELECT payload FROM agent_state_log WHERE actor_id = ? AND payload LIKE '%\"permission_mode\":%' ORDER BY id DESC LIMIT 1",
  ).get(actorId) as { payload: string } | undefined;
  const match = row ? PERMISSION_MODE_RE.exec(row.payload) : null;
  return match ? match[1] : null;
}
