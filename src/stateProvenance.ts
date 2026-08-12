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
// Consequence for deriveProvenance()/StateProvenance specifically (fix round
// 1, item 3 narrowed this from a module-wide claim, which lastLogEvent below
// now makes false as written): AGE NEVER DEPENDS ON THE LOG THERE.
// age_seconds and since come only from state_changed_at. Only the EVENT that
// explains the current state can be missing, and when it is, that is
// reported as its own named answer (source "no-record") rather than as an
// age of zero or a guess.
//
// lastLogEvent (below) is the DELIBERATE exception, for a different question
// entirely: not "how old is the latch" but "how old is the log's own last
// row". Its age_seconds comes from agent_state_log.created_at on purpose --
// that is the whole point of the function, see its own comment. The
// retention argument above does not sink this: a row that has been evicted
// is reported as null (absence), never as a fabricated age of zero, and
// deriveProvenance's own latch age on the line above is completely
// unaffected by whether that log row still exists.
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
import { sanitizeEventForDisplay, type Liveness } from "./tmux.js";

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
  //
  // Fix round 1, item 4. This used to be `!isClaudeCommand(row.command) ||
  // row.kind === LEAD_KIND` -- a blocklist naming leads specifically, and
  // wrong for a kind='command' row (a hive.yml process started by `hive
  // start`, src/cli.ts): launchAgent gives a non-'agent' kind no
  // HIVE_AGENT_ID and no --settings (src/spawn.ts), so a kind='command' row
  // running `claude -p '...'` can never write a hook row or a log row
  // either, exactly like a lead. The old gate let it fall through to the
  // instrumented branch below and report "no-record" forever -- "a claude
  // worker that hasn't checked in yet" -- which is precisely the misreport
  // DECISION 4 fixed for the lead, just for a different kind. Now shares
  // reportsAgentStateLog (below) with agent_list/hive status/hive doctor, an
  // ALLOWLIST on kind='agent' rather than a lead-specific exclusion, so the
  // two cannot independently drift onto different readings of the same row
  // again, and a future third kind defaults to not-instrumented rather than
  // to no-record by accident.
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

// Issue #72. A SEPARATE reader from deriveProvenance above, on purpose: this
// module's own docstring already names why. deriveProvenance's `event`
// answers "which row explains the CURRENT latch value" and stops looking the
// instant it finds one, which is a different question from "what did this
// actor's log most recently record, full stop". A worker stuck on a dialog
// for 40 minutes has a latch that has not moved and a matching log row that
// has not moved either, so deriveProvenance reports it correctly as
// `waiting (notify, 40m ago)` -- and #72's whole premise is that a
// correct-looking provenance line is exactly what a lead keeps missing here,
// because nothing about it says the age is worth a second look. This
// function reports the same underlying row a different way: not "what
// explains the latch" but "the single most recent thing this actor's log
// holds", so a caller can show it on its own line instead of overloading a
// field named for a different purpose.
//
// Reports, never infers. There is no "stale" or "stuck" verdict here, same
// rule as deriveProvenance and for the same reason -- a caller judges the
// age for themselves.
export interface LastLogEvent {
  event: string;
  state: string;
  age_seconds: number;
  at: string;
}

// null means no row for this actor. Callers report that as its own named
// fact (mirroring deriveProvenance's "no-record"), never as an age of zero:
// retention (pruneStateLog, src/scheduler.ts) deletes agent_state_log by a
// GLOBAL id span across every actor's rows together, not per actor, so a
// quiet actor's last-ever row can be evicted by a completely unrelated
// actor's churn. null can mean "this actor has never reported" or "it did,
// and retention already took it" -- indistinguishable from inside this
// table alone, which is why it is reported as absence rather than guessed at.
export function lastLogEvent(actorId: string, now: number = Date.now()): LastLogEvent | null {
  const row = stmt(
    "SELECT event, state, created_at FROM agent_state_log WHERE actor_id = ? ORDER BY id DESC LIMIT 1",
  ).get(actorId) as { event: string; state: string; created_at: string } | undefined;
  if (!row) return null;
  return { event: row.event, state: row.state, age_seconds: ageSecondsSince(row.created_at, now), at: row.created_at };
}

// One human-facing formatter for lastLogEvent, same reason describeForHuman
// exists above: `hive status`, `hive doctor` and the wake body scheduler.ts
// types into the lead's pane all render this line, and a second surface
// hand-rolling the string is how they drift apart.
//
// log.event is process.argv[2] verbatim (src/hook.ts), attacker-influenced
// with no validation, and every one of those three callers embeds this
// function's return value somewhere hive did not fully control - two of them
// an operator's own terminal, one a pane hive types into as a user turn.
// sanitizeEventForDisplay (src/tmux.ts) caps and cleans the EVENT before it
// is formatted, not the finished sentence, so hive's own "(<age> ago)" can
// never be pushed out of view or duplicated; see that function's own comment
// for the full reasoning. Sanitizing here, in the one formatter all three
// callers share, is what makes "fix both CLI sites too" a one-line change
// rather than three copies of the same guard.
export function describeLastLogEvent(log: LastLogEvent | null): string {
  return log ? `${sanitizeEventForDisplay(log.event)} (${humanizeAge(log.age_seconds)} ago)` : "no record";
}

// The one fact "does this row have a state log worth reporting" reduces to,
// shared so agent_list, hive status and hive doctor cannot drift onto three
// slightly different tests of it. An allowlist on kind (not a lead-specific
// exclusion) on purpose, matching src/hook.ts's own UPDATE scope
// (worker-state.md): a future third kind defaults to no report, not to
// reporting by accident. A lead DOES write agent_state_log rows of its own
// (worker-state.md's goal-churn section), which is deliberately not what
// this predicate is about -- #72's surface is for a worker's liveness, not a
// lead's, and a lead's own churn is out of scope for it.
export function reportsAgentStateLog(row: { kind: string; command: string }): boolean {
  return row.kind === "agent" && isClaudeCommand(row.command);
}

// Issue #156, D3. THE ONE DEFINITION OF "resumed, and not yet spoken to",
// shared for exactly the reason the header above gives about deriveProvenance:
// this module exists so surfaces reading the same latch cannot drift onto
// slightly different tests of it, and this fact has three readers.
//
// WHY IT IS A FACT AND NOT THE VERDICT THIS FILE FORBIDS. The header rules out
// a bound, a threshold, or a "stuck" verdict, and this is none of them: it
// restates one column with no clock arithmetic and no interpretation.
// `resumed_at` is stamped by resumeAgent (src/spawn.ts) and cleared by
// src/hook.ts on the first `prompt` event, so the column already IS the fact
// and this is its name.
//
// WHAT IT IS FOR. `claude --resume` replays the restored conversation, ends
// that turn, and fires a Stop hook, so a resumed worker goes idle - genuinely,
// freshly - for a turn nobody asked for. Reporting that as a finish tells a
// lead a worker is done before it has been given anything, and a lead that
// trusts it tears the worker down. Every surface that would answer "this
// worker is idle, act on it" has to ask this first.
//
// THE THREE READERS, named because enumerating them by hand is how the third
// was missed on this lane's first pass: standingIdleRows and watchedStates
// (src/scheduler.ts, the standing watch and the one-shot), and
// wake_when_idle's own mode="all" already_satisfied shortcut
// (src/tools/wakes.ts), which never reaches the scheduler at all and would
// otherwise answer "Act now" off the restore turn. A fourth surface,
// agent_status/agent_list, deliberately keeps reporting the plain latch: it
// shows what the row says rather than deciding anything on it, which is this
// module's whole stance.
export function awaitingFirstPostResumePrompt(row: { resumed_at: string }): boolean {
  return row.resumed_at !== "";
}
