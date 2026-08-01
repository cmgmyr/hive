// Every state hive reports is a LATCH read at a distance: agents.agent_state
// is one row, overwritten in place by hooks Claude Code fires on its own
// schedule (src/hook.ts). This module is the one place that turns that latch,
// plus what else the store knows about the same actor, into something a
// reader can judge for themselves instead of trusting blindly. It reports;
// it never judges. There is no bound, threshold, or "stuck" verdict here and
// there must never be one added -- that is lane L2 (design-worker-state pad),
// and it was redesigned away from a bound after a query against the live
// store. Every surface that shows a worker's state calls deriveProvenance()
// so the clock arithmetic and the source labelling exist in exactly one
// place; five surfaces each doing their own is how they drift apart.
//
// THE LATCH IS AUTHORITATIVE, THE LOG IS FORENSICS, IN THAT ORDER, ON
// PURPOSE. agents.agent_state + state_changed_at is written first and never
// lost. agent_state_log is written second, in its own try/catch
// (src/hook.ts's record()), specifically so a log that cannot be written
// costs the diagnosis and never the worker's actual state. It is also pruned
// by a GLOBAL id span across every actor and project (pruneStateLog,
// src/scheduler.ts), so a quiet worker's own rows can be evicted by a
// completely different actor's churn while its latch survives untouched.
// Consequence for this module: AGE NEVER DEPENDS ON THE LOG. age_seconds and
// since come only from state_changed_at. Only the EVENT that explains the
// current state can be missing, and when it is, that is reported as its own
// named answer (source "no-record") rather than as an age of zero or a
// guess.
//
// THE FRESH-PROVENANCE TRAP. Under a /goal, Claude Code fires Stop after
// every turn while immediately starting another, so a worker can sit through
// nine consecutive false idles in fifty seconds (worker-state.md). Every one
// of those rows is real and every one is honest about the row and worthless
// about the worker: "idle, from a stop row, 2s ago" reads as MORE
// trustworthy than a bare "idle" did, precisely because it is fresh. This
// module cannot detect that condition -- a fresh, correctly-recorded stop row
// is indistinguishable here from a fresh, correctly-recorded stop row that
// happens to sit under a /goal -- and must not pretend to. Say so at the
// point a reader will see it: this comment is that point.
//
// WHAT L2 WILL NEED THAT THIS MODULE DOES NOT GIVE IT. L2's firing condition
// is "a worker sits in `working` with no STOP ROW SINCE THE LAST PROMPT, and
// then an idle_prompt notify arrives" -- a predicate over the ORDERED
// SEQUENCE of an actor's recent agent_state_log rows, not over a single
// latest-matching-row lookup. deriveProvenance()'s `event` field answers
// "which row explains the CURRENT state" and is the wrong tool for that: it
// deliberately stops looking once it finds a row whose state matches the
// latch, which is not the same query as "has a stop row appeared since the
// last prompt". L2 should query agent_state_log directly for the sequence it
// needs rather than build on this field.
import type { Statement } from "better-sqlite3";
import { db } from "./db.js";
import { isClaudeCommand } from "./brief.js";
import { LEAD_KIND } from "./spawn.js";
import type { Liveness } from "./tmux.js";

// Lazily cached rather than prepared at module scope: this module loads
// before migrate() runs (same reasoning as src/scheduler.ts's own stmt()),
// so preparing against tables that may not exist yet would throw on a fresh
// database. deriveProvenance can run once per row in an agent_list loop, so
// re-preparing identical SQL on every call -- rather than compiling it once
// and reusing the plan -- is real, avoidable cost there.
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
}

// The fields deriveProvenance needs off an agents row. AgentRow (src/tools/
// agents.ts) is a superset and satisfies this structurally; kickoff's
// narrower SELECT is written to include exactly these.
export interface ProvenanceRow {
  actor_id: string;
  command: string;
  agent_state: string;
  state_changed_at: string | null;
  kind: string;
}

// SQLite's datetime('now') and this schema's other timestamp columns are
// UTC with no timezone marker ("2026-07-31 03:58:07"). Parsed as-is that
// reads as local time and comes out hours off; the "T"+"Z" round-trip is
// what makes it parse as the UTC instant it actually is. Also handles
// agent_state_log's millisecond variant ("...07.123") unchanged, should a
// future caller ever need it here.
function parseStoreTimestamp(ts: string): number {
  return new Date(`${ts.replace(" ", "T")}Z`).getTime();
}

export function ageSecondsSince(storeTimestamp: string, now: number = Date.now()): number {
  return Math.max(0, Math.round((now - parseStoreTimestamp(storeTimestamp)) / 1000));
}

// One humanising function, boundary-tested, so every surface renders the
// same age the same way.
export function humanizeAge(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h`;
}

// alive is the caller's own tmux liveness read (isLive/summaryLiveness in
// src/tools/agents.ts), passed in rather than probed here: this module stays
// a pure reader of rows it is given, and a surface that has already decided
// not to shell out to tmux (kickoff, deliberately -- see kickoff.ts) can
// pass null and get an honest "not probed" rather than a wrong "gone".
//
// now is exposed for tests: age must be computed from a fixed instant, never
// from a real clock a test has no control over.
export function deriveProvenance(
  row: ProvenanceRow,
  alive: Liveness,
  now: number = Date.now(),
): StateProvenance {
  const lastSeenRow = stmt("SELECT last_seen_at FROM actors WHERE id = ?").get(row.actor_id) as
    | { last_seen_at: string }
    | undefined;
  const last_seen = lastSeenRow?.last_seen_at ?? null;

  // The tmux probe is a second, independent source of truth about the same
  // field agentSummary already overwrites with "gone" (src/tools/agents.ts).
  // When it is what answered, it must be named as the source: stamping "hook"
  // on an observation a hook never made attributes it to the wrong witness.
  if (alive === false) {
    return { state: "gone", source: "tmux-probe", event: null, since: null, age_seconds: null, last_seen };
  }

  // A non-claude worker never receives --settings (src/tools/agents.ts,
  // gated on isClaudeCommand) and so writes NO hook row, ever, by design.
  // That must read as a permanent, uninteresting fact, never as staleness.
  //
  // A lead is the same shape for a different reason: it DOES get --settings
  // and its hook DOES fire, but src/hook.ts's agent_state UPDATE is scoped to
  // kind = 'agent' (worker-state.md), so agent_state never leaves its
  // 'unknown' default. isClaudeCommand(row.command) alone cannot tell that
  // apart from a genuinely fresh, about-to-report worker - which is exactly
  // "no-record"'s meaning, and reporting a lead that way (issue #27's L4 fix
  // round, DECISION 4) reads as a worker that just hasn't checked in yet
  // rather than one with no state channel at all, permanently, by design.
  if (!isClaudeCommand(row.command) || row.kind === LEAD_KIND) {
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

  // The log row that actually explains the current latch value: the most
  // recent row for this actor whose OWN state matches agent_state now. Not
  // simply "the last row for the actor" -- a notify that left the latch
  // alone is logged with the literal state "unchanged" (src/hook.ts's
  // UNCHANGED sentinel), which is not a value agent_state can ever hold, and
  // the true explaining row can be an OLDER one that retention has not yet
  // reached. Skipped entirely when the latch itself has never changed, since
  // no log row could possibly match a state that was never written.
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
  };
}

// Human-facing, one line, for surfaces that render for a terminal (hive
// status, kickoff, doctor). MCP surfaces report the StateProvenance fields
// directly instead of this string: a caller parsing JSON should not have to
// re-derive a sentence hive already threw away.
export function describeForHuman(prov: StateProvenance, now: number = Date.now()): string {
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
