#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { db } from "./db.js";
import { awaitingFirstPromptSql } from "./firstPrompt.js";
import { liveBackgroundTasks, SUBAGENT_LATCH_MAX_AGE_SECONDS, withholdsIdle } from "./backgroundTasks.js";

interface HookPayload {
  message?: unknown;
  notification_type?: unknown;
  background_tasks?: unknown;
  session_id?: unknown;
}

let raw: string | null | undefined;
function readRaw(): string | null {
  if (raw === undefined) {
    try {
      raw = readFileSync(0, "utf8");
    } catch {
      raw = null;
    }
  }
  return raw;
}

let payload: HookPayload | undefined;
function readPayload(): HookPayload {
  if (payload === undefined) {
    try {
      payload = JSON.parse(readRaw() ?? "") as HookPayload;
    } catch {

      payload = {};
    }
  }
  return payload;
}

const PAYLOAD_LIMIT = 10_000;

const UNCHANGED = "unchanged";

function record(actorId: string, event: string, state: string): void {
  try {

    const payload = readRaw() ?? "";
    const stored =
      payload.length > PAYLOAD_LIMIT
        ? payload.slice(0, PAYLOAD_LIMIT) + `\n[hive: truncated at ${PAYLOAD_LIMIT} bytes]`
        : payload;
    db.prepare(
      "INSERT INTO agent_state_log (actor_id, event, state, payload) VALUES (?, ?, ?, ?)",
    ).run(actorId, event, state, stored);
  } catch {

  }
}

// Only a subagent withholds the latch. A shell or a monitor need never terminate, so latching on one
// would make a worker that leaves any long-running process never read idle - src/scheduler.ts names
// them in the standing notice instead (todo 468).
//
// Reads whichever channel the payload actually carries, never both: claude's Stop always carries
// background_tasks, codex's never does. Mechanism and rationale: hive-internals, worker-state.md.
function waitingOnSubagents(actorId: string, payload: HookPayload): boolean {
  if (payload.background_tasks !== undefined) {
    return liveBackgroundTasks(payload.background_tasks).some(withholdsIdle);
  }
  return hasOpenSubagent(actorId);
}

// Subagents are a SET keyed by agent_id, not a stack of one - reduces every subagent_start/stop row
// within SUBAGENT_LATCH_MAX_AGE_SECONDS in order, tracking which agent_ids are still unmatched.
//
// ACCEPTED, NOT OVERLOOKED: a subagent that genuinely outlives SUBAGENT_LATCH_MAX_AGE_SECONDS falls
// out of this window, and the worker reads idle while it is still live - a false idle, the exact
// direction this lane exists to prevent. Deliberate: latching forever is worse, and past this age
// hive already treats the worker as stall-worthy on its own. Retention evicting a row early cannot
// produce a NEW failure mode either, only an earlier instance of this same accepted one - see
// .claude/skills/hive-internals/references/worker-state.md for the residual this does not fully close.
function hasOpenSubagent(actorId: string): boolean {
  const rows = db
    .prepare(
      `SELECT event, payload FROM agent_state_log
        WHERE actor_id = ? AND event IN ('subagent_start', 'subagent_stop')
          AND created_at >= datetime('now', ?)
        ORDER BY id ASC`,
    )
    .all(actorId, `-${SUBAGENT_LATCH_MAX_AGE_SECONDS} seconds`) as { event: string; payload: string }[];

  const open = new Set<string>();
  for (const row of rows) {
    let agentId: unknown;
    try {
      agentId = (JSON.parse(row.payload) as { agent_id?: unknown }).agent_id;
    } catch {
      continue;
    }
    if (typeof agentId !== "string" || agentId === "") continue;
    if (row.event === "subagent_start") open.add(agentId);
    else open.delete(agentId);
  }
  return open.size > 0;
}

// Claude-Code-Notification-only. Proven unreachable for codex, not merely unused: codex's own
// hooks.json (src/codexHome.ts) never wires an event through the "notify" argv label, and never
// wires PermissionRequest at all - see test/codex-notify-unreachable.test.mjs, which pins the event
// list itself so a later lane adding an entry there has to decide this deliberately, not silently.
function stateForNotification(payload: HookPayload): string | null {
  const type = payload.notification_type;

  const idlePrompt =
    typeof type === "string"
      ? type === "idle_prompt"
      : /waiting for your input/i.test(String(payload.message ?? ""));
  return idlePrompt ? null : "waiting";
}

function reconcileSessionId(actorId: string, payload: HookPayload): void {
  const sessionId = typeof payload.session_id === "string" ? payload.session_id : "";
  if (!sessionId) return;
  db.prepare(
    "UPDATE agents SET session_id = ? WHERE actor_id = ? AND kind = 'agent' AND session_id IS NOT ?",
  ).run(sessionId, actorId, sessionId);
}

function stateFor(event: string, actorId: string): string | null {
  switch (event) {
    case "prompt":
      return "working";
    case "stop":

      return waitingOnSubagents(actorId, readPayload()) ? "working" : "idle";
    case "notify":
      return stateForNotification(readPayload());

    // Log-only, like idle_prompt's null above: nothing forces a state write when a subagent starts
    // or stops. hasOpenSubagent reads these rows back from agent_state_log at the next "stop" - the
    // record() call below writes the row regardless of what this case returns.
    case "subagent_start":
    case "subagent_stop":
      return null;

    // An event hive has no case for does nothing, rather than asserting a state it doesn't have.
    // Was "waiting" - proven indistinguishable from a real notify payload's own fallback (R4, TEST 3
    // vs TEST 4: a PermissionRequest payload and a wholly unmapped event produced the identical
    // "waiting"). That collision, not argv-vs-payload dispatch, was the actual defect.
    default:
      return null;
  }
}

try {
  const actorId = process.env.HIVE_AGENT_ID;
  if (actorId) {
    const event = process.argv[2] ?? "";
    const state = stateFor(event, actorId);
    if (state !== null) {
      db.prepare(
        "UPDATE agents SET agent_state = ?, state_changed_at = datetime('now') WHERE actor_id = ? AND kind = 'agent'",
      ).run(state, actorId);
    }

    if (event === "prompt") {
      db.prepare(

        `UPDATE agents SET resumed_at = '' WHERE actor_id = ? AND kind = 'agent' AND ${awaitingFirstPromptSql("agents")}`,
      ).run(actorId);
    }

    reconcileSessionId(actorId, readPayload());

    db.prepare("UPDATE actors SET last_seen_at = datetime('now') WHERE id = ?").run(actorId);

    record(actorId, event, state ?? UNCHANGED);
  }
} catch {

}
process.exit(0);
