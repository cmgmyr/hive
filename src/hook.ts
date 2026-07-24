#!/usr/bin/env node
// Claude Code hook entry point. Writes exact agent state into the hive DB.
// Wired by ~/.hive/hooks.json, which agent_spawn passes via --settings.
// Usage: node hook.js <stop|prompt|notify>; the hook payload arrives on stdin.
import { readFileSync } from "node:fs";
import { db } from "./db.js";

try {
  const actorId = process.env.HIVE_AGENT_ID;
  if (actorId) {
    const event = process.argv[2] ?? "";
    let state = event === "stop" ? "idle" : event === "prompt" ? "working" : "waiting";
    if (event === "notify") {
      try {
        const payload = JSON.parse(readFileSync(0, "utf8")) as { message?: unknown };
        if (/waiting for your input/i.test(String(payload.message ?? ""))) state = "idle";
      } catch {
        // stdin unavailable or not JSON; keep "waiting"
      }
    }
    db.prepare(
      "UPDATE agents SET agent_state = ?, state_changed_at = datetime('now') WHERE actor_id = ?",
    ).run(state, actorId);
    db.prepare("UPDATE actors SET last_seen_at = datetime('now') WHERE id = ?").run(actorId);
  }
} catch {
  // A hook must never break the agent session.
}
process.exit(0);
