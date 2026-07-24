import type { Statement } from "better-sqlite3";
import { db } from "./db.js";
import { closeAgentRow } from "./spawn.js";
import { liveTargets, sendText, targetAlive, windowAlive, type AliveSnapshot } from "./tmux.js";

// Every hive MCP server instance runs this scheduler; SQLite conditional
// updates make timer claims atomic, so concurrent instances never
// double-fire. As long as any session with hive is open, timers fire.

export interface TimerRow {
  id: number;
  project_id: number;
  owner: string;
  body: string;
  kind: string;
  watch: string;
  deliver_actor: string;
  deliver_pane: string;
  due_at: string | null;
  max_wait_at: string | null;
  repeat_every_ms: number | null;
  created_at: string;
  fired_at: string | null;
  cancelled_at: string | null;
  fire_count: number;
}

// The single definition of "this timer is still live" (one-shot pending, or
// repeating and not cancelled). Shared with wake_list and hive status.
export const ACTIVE_TIMER_WHERE =
  "cancelled_at IS NULL AND (fired_at IS NULL OR repeat_every_ms IS NOT NULL)";

interface WatchedState {
  idle: boolean;
  gone: boolean;
  since: string | null;
}

// Statements are prepared lazily because this module loads before migrate().
const prepared = new Map<string, Statement>();
function stmt(sql: string): Statement {
  let s = prepared.get(sql);
  if (!s) {
    s = db.prepare(sql);
    prepared.set(sql, s);
  }
  return s;
}

let ticking = false;

export function startScheduler(intervalMs = 3000): void {
  // unref: the scheduler must never keep an orphaned server process alive
  // after its Claude session closes stdin.
  setInterval(() => {
    void tick();
  }, intervalMs).unref();
}

// Keep the store truthful: close agents whose tmux windows died and cancel
// timers whose delivery pane is gone. The age guard avoids racing a spawn
// that has inserted its row but not yet created its window.
export function janitor(snapshot: AliveSnapshot = liveTargets()): {
  closed_agents: number;
  cancelled_timers: number;
} {
  let closedAgents = 0;
  let cancelledTimers = 0;
  const agents = stmt(
    `SELECT id, tmux_target FROM agents WHERE status = 'running' AND tmux_target != ''
     AND created_at < datetime('now', '-15 seconds')`,
  ).all() as { id: number; tmux_target: string }[];
  for (const agent of agents) {
    if (!targetAlive(agent.tmux_target, snapshot)) {
      closeAgentRow(agent.id);
      closedAgents += 1;
    }
  }
  const timers = stmt(
    `SELECT id, deliver_pane FROM timers WHERE ${ACTIVE_TIMER_WHERE}
     AND created_at < datetime('now', '-15 seconds')`,
  ).all() as { id: number; deliver_pane: string }[];
  for (const timer of timers) {
    if (!targetAlive(timer.deliver_pane, snapshot)) {
      cancelTimer(timer.id);
      cancelledTimers += 1;
    }
  }
  return { closed_agents: closedAgents, cancelled_timers: cancelledTimers };
}

function cancelTimer(timerId: number): void {
  stmt("UPDATE timers SET cancelled_at = datetime('now') WHERE id = ?").run(timerId);
}

async function tick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    const snapshot = liveTargets();
    janitor(snapshot);
    const now = (stmt("SELECT datetime('now') AS now").get() as { now: string }).now;
    const candidates = stmt(
      `SELECT * FROM timers WHERE cancelled_at IS NULL AND (
         (kind = 'delay' AND due_at <= datetime('now')
           AND (fired_at IS NULL OR repeat_every_ms IS NOT NULL))
         OR (kind != 'delay' AND fired_at IS NULL)
       )`,
    ).all() as TimerRow[];
    for (const timer of candidates) {
      if (timer.kind === "delay") await fireDelay(timer);
      else await maybeFireIdle(timer, snapshot, now);
    }
  } catch {
    // The scheduler must never take the server down.
  } finally {
    ticking = false;
  }
}

async function fireDelay(timer: TimerRow): Promise<void> {
  let claimed: boolean;
  if (timer.repeat_every_ms != null) {
    const seconds = Math.max(1, Math.round(timer.repeat_every_ms / 1000));
    claimed =
      stmt(
        `UPDATE timers SET due_at = datetime('now', printf('+%d seconds', ?)),
           fired_at = datetime('now'), fire_count = fire_count + 1
         WHERE id = ? AND due_at = ? AND cancelled_at IS NULL`,
      ).run(seconds, timer.id, timer.due_at).changes === 1;
  } else {
    claimed = claimOneShot(timer.id);
  }
  if (claimed) await deliver(timer, "");
}

function claimOneShot(timerId: number): boolean {
  return (
    stmt(
      `UPDATE timers SET fired_at = datetime('now'), fire_count = fire_count + 1
       WHERE id = ? AND fired_at IS NULL AND cancelled_at IS NULL`,
    ).run(timerId).changes === 1
  );
}

function watchedStates(timer: TimerRow, snapshot: AliveSnapshot): WatchedState[] {
  const ids = JSON.parse(timer.watch) as number[];
  return ids.map((id) => {
    const agent = stmt("SELECT * FROM agents WHERE id = ?").get(id) as
      | { status: string; tmux_target: string; agent_state: string; state_changed_at: string | null }
      | undefined;
    if (!agent || agent.status !== "running" || !targetAlive(agent.tmux_target, snapshot)) {
      return { idle: true, gone: true, since: null };
    }
    return { idle: agent.agent_state === "idle", gone: false, since: agent.state_changed_at };
  });
}

async function maybeFireIdle(timer: TimerRow, snapshot: AliveSnapshot, now: string): Promise<void> {
  const timedOut = timer.max_wait_at != null && timer.max_wait_at <= now;
  let ready = false;
  if (timedOut) {
    ready = true;
  } else {
    const states = watchedStates(timer, snapshot);
    if (timer.kind === "idle_any") {
      // Agents already idle when the timer was set do not count; wait for a
      // fresh transition (or a watched agent going away entirely). >= not >:
      // timestamps have one-second granularity, and a transition in the same
      // second as timer creation must fire rather than hang until max-wait.
      ready = states.some((s) => s.gone || (s.idle && s.since != null && s.since >= timer.created_at));
    } else {
      ready = states.length > 0 && states.every((s) => s.idle);
    }
  }
  if (ready && claimOneShot(timer.id)) {
    await deliver(timer, timedOut ? "max wait reached" : "");
  }
}

async function deliver(timer: TimerRow, note: string): Promise<void> {
  if (!windowAlive(timer.deliver_pane)) {
    cancelTimer(timer.id);
    return;
  }
  const prefix = `[hive wake #${timer.id}${note ? `, ${note}` : ""}] `;
  await sendText(timer.deliver_pane, prefix + timer.body, true);
}
