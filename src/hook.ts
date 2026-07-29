#!/usr/bin/env node
// Claude Code hook entry point. Writes exact agent state into the hive DB.
// Wired by ~/.hive/hooks.json, which agent_spawn passes via --settings.
// Usage: node hook.js <stop|prompt|notify>; the hook payload arrives on stdin.
import { readFileSync } from "node:fs";
import { db } from "./db.js";

interface HookPayload {
  message?: unknown;
  background_tasks?: unknown;
}

// stdin is a one-shot read, so both consumers below share this rather than
// each reaching for fd 0.
function readPayload(): HookPayload {
  try {
    return JSON.parse(readFileSync(0, "utf8")) as HookPayload;
  } catch {
    // stdin unavailable or not JSON.
    return {};
  }
}

// Issue #24. The Stop hook fires when the worker's TURN ends, and that is not
// the same event as its work ending. A worker that launched background
// subagents and is waiting on them has ended its turn, so hive recorded idle,
// and a lead's wake_when_idle fired on a lane that was not finished.
//
// The payload can tell the two apart. Stop carries background_tasks: [] when
// nothing is in flight and one entry per live background task when something
// is. Captured against Claude Code 2.1.220, headless and in a real tmux pane;
// the payloads are on todo 57.
//
// Only subagents count, deliberately. A backgrounded Bash tool call rides in
// the same array tagged type "shell", and counting those would leave a worker
// running `npm run watch` permanently non-idle, so every wake set on it would
// ride to max_wait instead of firing. The asymmetry is structural rather than
// stylistic: a subagent always terminates, and when it does Claude Code injects
// a task-notification into its parent as a fresh user turn, which fires
// UserPromptSubmit ("working") and then a Stop carrying an empty array
// ("idle"). So "working" always resolves on its own. A background shell makes
// no such promise; `sleep infinity` never ends and never re-prompts anything.
// The type filter is a WHITELIST and the status filter is a DENYLIST, and they
// point opposite ways on purpose. The safe direction is different for each,
// because the two mistakes cost different things.
//
// An unrecognised TYPE must not count. Over-counting types strands a worker as
// permanently non-idle and every wake set on it rides to max_wait, which is
// worse than the bug being fixed.
//
// An unrecognised STATUS must count. This shipped as `status === "running"`,
// which treats every other value as not-in-flight, so a payload of
// [{type:"subagent", status:"queued"}] for a subagent that is launched but not
// yet started writes "idle", the lead's wake fires, and the lane is reviewed
// with zero subagent output. That is issue #24 verbatim, re-opened by the fix
// for it. Statuses grow vocabulary far more readily than types do.
//
// The asymmetry that makes the denylist safe is the same one the type filter
// rests on: once type says subagent, the task is guaranteed to terminate and
// to re-prompt its parent with a task-notification when it does, which fires
// UserPromptSubmit and then a Stop carrying an empty array. So an unrecognised
// status read as running is self-correcting within one subagent's lifetime.
// Read as idle it is not self-correcting at all; it is the false wake.
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

// One dispatch, so each event's whole answer is in one place. The previous
// shape picked a default in a ternary chain and then overrode it in an if/else
// nine lines below, which meant "notify defaults to waiting" and "notify
// becomes idle when Claude is asking" were written far apart and a fourth
// event would have to be added to both.
function stateFor(event: string): string {
  switch (event) {
    case "prompt":
      return "working";
    case "stop":
      // A payload hive cannot read leaves the old answer in place: an absent
      // or unparseable background_tasks means "nothing says work is in
      // flight", which is what a turn ending has always meant here.
      return waitingOnSubagents(readPayload()) ? "working" : "idle";
    case "notify":
      return /waiting for your input/i.test(String(readPayload().message ?? "")) ? "idle" : "waiting";
    default:
      return "waiting";
  }
}

try {
  const actorId = process.env.HIVE_AGENT_ID;
  if (actorId) {
    const state = stateFor(process.argv[2] ?? "");
    db.prepare(
      "UPDATE agents SET agent_state = ?, state_changed_at = datetime('now') WHERE actor_id = ?",
    ).run(state, actorId);
    db.prepare("UPDATE actors SET last_seen_at = datetime('now') WHERE id = ?").run(actorId);
  }
} catch {
  // A hook must never break the agent session.
}
process.exit(0);
