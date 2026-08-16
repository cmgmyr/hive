#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { db } from "./db.js";
import { awaitingFirstPromptSql } from "./firstPrompt.js";

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

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "canceled", "killed", "error"]);

function waitingOnSubagents(payload: HookPayload): boolean {
  const tasks = payload.background_tasks;
  if (!Array.isArray(tasks)) return false;
  return tasks.some((entry) => {
    const task = entry as { type?: unknown; status?: unknown } | null;
    if (task?.type !== "subagent") return false;
    return !TERMINAL_STATUSES.has(String(task?.status ?? ""));
  });
}

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

function stateFor(event: string): string | null {
  switch (event) {
    case "prompt":
      return "working";
    case "stop":

      return waitingOnSubagents(readPayload()) ? "working" : "idle";
    case "notify":
      return stateForNotification(readPayload());
    default:
      return "waiting";
  }
}

try {
  const actorId = process.env.HIVE_AGENT_ID;
  if (actorId) {
    const event = process.argv[2] ?? "";
    const state = stateFor(event);
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
