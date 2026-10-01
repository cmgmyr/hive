#!/usr/bin/env node

import { readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, parse, relative, sep } from "node:path";
import { awaitingFirstPromptSql } from "./firstPrompt.js";
import { liveBackgroundTasks, SUBAGENT_LATCH_SQL, withholdsIdle } from "./backgroundTasks.js";

interface HookPayload {
  message?: unknown;
  reason?: unknown;
  notification_type?: unknown;
  background_tasks?: unknown;
  session_id?: unknown;
  transcript_path?: unknown;
}

interface HookOwnerRow {
  kind: string;
  command: string;
  codex_home: string;
  session_id: string;
}

function canonicalPathWithMissingSuffix(input: string): string | null {
  if (!isAbsolute(input) || input.includes("\0")) return null;
  let current = parse(input).root;
  const missing: string[] = [];
  try {
    current = realpathSync(current);
  } catch {
    return null;
  }

  for (const part of input.slice(parse(input).root.length).split(sep)) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (missing.length) missing.pop();
      else current = dirname(current);
      continue;
    }
    if (missing.length) {
      missing.push(part);
      continue;
    }
    const candidate = join(current, part);
    try {
      current = realpathSync(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return null;
      missing.push(part);
    }
  }
  return join(current, ...missing);
}

function acceptsWorkerHook(
  row: HookOwnerRow | undefined,
  payload: HookPayload,
  sessionsRoot: string | undefined,
): boolean {
  if (!row || row.kind !== "agent" || row.codex_home === "" || sessionsRoot === undefined) return true;

  const transcript = payload.transcript_path;
  if (typeof transcript === "string" && transcript !== "") {
    const canonicalRoot = canonicalPathWithMissingSuffix(sessionsRoot);
    const canonicalTranscript = canonicalPathWithMissingSuffix(transcript);
    if (canonicalRoot === null || canonicalTranscript === null) return false;
    const rel = relative(canonicalRoot, canonicalTranscript);
    return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
  }
  if (transcript !== undefined && transcript !== null && transcript !== "") return false;
  return (
    typeof row.session_id === "string" && row.session_id !== "" &&
    typeof payload.session_id === "string" && payload.session_id !== "" &&
    row.session_id === payload.session_id
  );
}

function validCheckpointThreshold(): boolean {
  const text = process.env.HIVE_CONTEXT_CHECKPOINT_PERCENT;
  if (!text || !/^\d+$/.test(text)) return false;
  const value = Number(text);
  return Number.isInteger(value) && value >= 1 && value <= 100;
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
    .all(actorId, SUBAGENT_LATCH_SQL) as { event: string; payload: string }[];

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

// Each harness keys its own terminal-reason allowlist (HarnessCapabilities.terminalSessionEndReasons,
// src/harnesses.ts) rather than sharing one: claude's `clear`, `other`, and an unobserved reason all
// stop nothing (todo 765; test/fixtures/hook-payloads/README.md), and codex's vocabulary is disjoint
// from claude's rather than a superset of it (todo 782).
//
// ~/.hive/hooks.json is one file per store, shared by every lead and every worker of every project,
// so this event fires far more often than it acts. HIVE_LEAD is set only in a lead's own pane
// (src/cli.ts, cmdLead's envFlags), and the project comes from that lead's own row rather than cwd.
async function stopProcessesForEndedLead(actorId: string, payload: HookPayload): Promise<void> {
  if (process.env.HIVE_LEAD !== "1") return;
  if (typeof payload.reason !== "string") return;
  const row = db
    .prepare("SELECT project_id, command FROM agents WHERE actor_id = ? AND kind = 'lead' AND status = 'running'")
    .get(actorId) as { project_id: number; command: string } | undefined;
  if (!row) return;

  // Imported here and nowhere above: harnesses.ts itself pulls tmux at module scope, and every
  // other event in this file runs on every turn of every session without needing any of it.
  const { harnessFor } = await import("./harnesses.js");
  if (!harnessFor(row.command).terminalSessionEndReasons.includes(payload.reason)) return;

  const { stopAllProcesses, STOP_REASONS } = await import("./processes.js");
  stopAllProcesses(row.project_id, STOP_REASONS.leadSessionEnded);
}

function reconcileSessionId(actorId: string, payload: HookPayload): void {
  const sessionId = typeof payload.session_id === "string" ? payload.session_id : "";
  if (!sessionId) return;
  db.prepare(
    "UPDATE agents SET session_id = ? WHERE actor_id = ? AND kind = 'agent' AND session_id IS NOT ?",
  ).run(sessionId, actorId, sessionId);
}

// Claude's own payload carries transcript_path too (a directory-resolvable case hive already
// covers via cwd), so this stores it for whichever harness sends it rather than special-casing
// codex - the staleness reader is what decides which source to trust per harness (todo 591).
function reconcileTranscriptPath(actorId: string, payload: HookPayload): void {
  const path = typeof payload.transcript_path === "string" ? payload.transcript_path : "";
  if (!path) return;
  db.prepare(
    "UPDATE agents SET transcript_path = ? WHERE actor_id = ? AND kind = 'agent' AND transcript_path IS NOT ?",
  ).run(path, actorId, path);
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

if (process.argv[2] === "post_tool_use") {
  try {
    const kind = process.argv[3];
    const actorId = process.env.HIVE_AGENT_ID ?? "";
    let suppliedPayload: HookPayload | undefined;
    if (kind === "codex" && validCheckpointThreshold() && actorId.startsWith("agent:")) {
      suppliedPayload = readPayload();
      const { db } = await import("./db.js");
      const row = db.prepare("SELECT kind, command, codex_home, session_id FROM agents WHERE actor_id = ?")
        .get(actorId) as HookOwnerRow | undefined;
      if (row?.kind === "agent" && typeof row.codex_home === "string" && row.codex_home !== "") {
        const { harnessFor } = await import("./harnesses.js");
        if (harnessFor(row.command).name === "codex") {
          const { codexHomeDir } = await import("./codexHome.js");
          if (!acceptsWorkerHook(row, suppliedPayload, join(codexHomeDir(row.codex_home), "sessions"))) {
            process.exit(0);
          }
        }
      }
    }
    const { runContextCheckpointHook } = await import("./contextCheckpoint.js");
    if (suppliedPayload === undefined) runContextCheckpointHook(kind);
    else runContextCheckpointHook(kind, suppliedPayload);
  } catch {}
  process.exit(0);
}

const { db } = await import("./db.js");

try {
  const actorId = process.env.HIVE_AGENT_ID;
  if (actorId) {
    const event = process.argv[2] ?? "";
    const hookPayload = readPayload();
    const row = db.prepare("SELECT kind, command, codex_home, session_id FROM agents WHERE actor_id = ?")
      .get(actorId) as HookOwnerRow | undefined;
    let guarded = false;
    let state: string | null = null;
    if (row?.kind === "agent" && typeof row.codex_home === "string" && row.codex_home !== "") {
      const { harnessFor } = await import("./harnesses.js");
      if (harnessFor(row.command).name === "codex") {
        const { codexHomeDir } = await import("./codexHome.js");
        const result = db.transaction(() => {
          const current = db.prepare("SELECT kind, command, codex_home, session_id FROM agents WHERE actor_id = ?")
            .get(actorId) as HookOwnerRow | undefined;
          if (!current || current.kind !== "agent" || typeof current.codex_home !== "string" || !current.codex_home || harnessFor(current.command).name !== "codex") {
            return { status: "changed" as const, state: null };
          }
          const sessionsRoot = join(codexHomeDir(current.codex_home), "sessions");
          if (!acceptsWorkerHook(current, hookPayload, sessionsRoot)) return { status: "rejected" as const, state: null };
          const state = applyWorkerTransition(actorId, event);
          reconcileSessionId(actorId, hookPayload);
          reconcileTranscriptPath(actorId, hookPayload);
          db.prepare("UPDATE actors SET last_seen_at = datetime('now') WHERE id = ?").run(actorId);
          return { status: "accepted" as const, state };
        }).immediate();
        if (result.status === "rejected") process.exit(0);
        guarded = result.status === "accepted";
        state = result.state;
      }
    }

    if (!guarded) state = applyWorkerTransition(actorId, event);

    // A lead's turn state is its own table; agents.agent_state stays worker-only.
    if (process.env.HIVE_LEAD === "1" && (event === "prompt" || event === "stop" || event === "session_end")) {
      try {
        const { applyLeadHook } = await import("./leadState.js");
        applyLeadHook(actorId, event, readPayload(), () => waitingOnSubagents(actorId, readPayload()));
      } catch {

      }
    }

    if (event === "session_end") {
      try {
        await stopProcessesForEndedLead(actorId, readPayload());
      } catch {

      }
    }

    if (!guarded) {
      reconcileSessionId(actorId, hookPayload);
      reconcileTranscriptPath(actorId, hookPayload);
      db.prepare("UPDATE actors SET last_seen_at = datetime('now') WHERE id = ?").run(actorId);
    }

    record(actorId, event, state ?? UNCHANGED);
  }
} catch {

}
process.exit(0);

function applyWorkerTransition(actorId: string, event: string): string | null {
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

  return state;
}
