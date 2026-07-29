import type { Statement } from "better-sqlite3";
import { db } from "./db.js";
import { closeAgentRow } from "./spawn.js";
import {
  capturePane,
  liveTargets,
  sanitizeTail,
  sendText,
  tailCaptureLines,
  targetAlive,
  targetLive,
  type AliveSnapshot,
} from "./tmux.js";

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

// How long a just-inserted agent row is protected from liveness decisions: a
// spawn writes the row before its tmux window exists, and until the window is
// there "not in the snapshot" means "not born yet", not "gone". One window,
// three readers (janitor's two sweeps and the idle watcher), so one constant.
const SETTLE_WINDOW = "-15 seconds";

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
// timers whose delivery pane is gone. SETTLE_WINDOW avoids racing a spawn
// that has inserted its row but not yet created its window.
//
// A null snapshot means the probe failed and liveness is unknown, so sweep
// nothing. The costs are asymmetric: a missed sweep is corrected three
// seconds later by the next tick, while a wrong sweep closes live workers and
// destroys state nothing rebuilds. A reachable but empty server still returns
// an empty snapshot and still sweeps, which is the whole distinction.
export function janitor(snapshot: AliveSnapshot | null = liveTargets()): {
  closed_agents: number;
  cancelled_timers: number;
  probed: boolean;
} {
  // probed distinguishes "swept, nothing to do" from "could not look", which
  // are otherwise the same two zeros. hive doctor reports the difference.
  if (snapshot === null) return { closed_agents: 0, cancelled_timers: 0, probed: false };
  let closedAgents = 0;
  let cancelledTimers = 0;
  const agents = stmt(
    `SELECT id, tmux_target FROM agents WHERE status = 'running' AND tmux_target != ''
     AND created_at < datetime('now', ?)`,
  ).all(SETTLE_WINDOW) as { id: number; tmux_target: string }[];
  for (const agent of agents) {
    if (!targetAlive(agent.tmux_target, snapshot)) {
      closeAgentRow(agent.id);
      closedAgents += 1;
    }
  }
  const timers = stmt(
    `SELECT id, deliver_pane FROM timers WHERE ${ACTIVE_TIMER_WHERE}
     AND created_at < datetime('now', ?)`,
  ).all(SETTLE_WINDOW) as { id: number; deliver_pane: string }[];
  for (const timer of timers) {
    if (!targetAlive(timer.deliver_pane, snapshot)) {
      cancelTimer(timer.id);
      cancelledTimers += 1;
    }
  }
  return { closed_agents: closedAgents, cancelled_timers: cancelledTimers, probed: true };
}

function cancelTimer(timerId: number): void {
  stmt("UPDATE timers SET cancelled_at = datetime('now') WHERE id = ?").run(timerId);
}

// One sweep-and-fire pass. The snapshot is a parameter for the same reason
// janitor's is: it is the one input that decides everything here, and handing
// it in is the difference between driving a tick and simulating a tmux.
export async function tick(snapshot: AliveSnapshot | null = liveTargets()): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
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
      if (timer.kind === "delay") await fireDelay(timer, snapshot);
      else await maybeFireIdle(timer, snapshot, now);
    }
  } catch {
    // The scheduler must never take the server down.
  } finally {
    ticking = false;
  }
}

// Liveness of the delivery pane, resolved BEFORE the timer is claimed.
//
// Claiming is atomic and one-way: it sets fired_at and bumps fire_count so no
// other scheduler instance retries. Asking about the pane afterwards means an
// unanswered probe destroys a wake-up that was already spent, and for a
// repeating timer it destroys the whole schedule. Ask first: unknown leaves
// the row untouched for the next tick, and a pane tmux says is gone is
// cancelled as it always was.
//
// The tick's snapshot already answers this for every pane at once, so use it
// and only fall back to a single-target probe when there is no snapshot to
// read. A max-wait wake still has to fire when the batch probe failed, and
// that is the one path that needs its own fork.
function deliverable(timer: TimerRow, snapshot: AliveSnapshot | null): boolean {
  const live = snapshot ? targetAlive(timer.deliver_pane, snapshot) : targetLive(timer.deliver_pane);
  if (live === null) return false;
  if (!live) {
    cancelTimer(timer.id);
    return false;
  }
  return true;
}

async function fireDelay(timer: TimerRow, snapshot: AliveSnapshot | null): Promise<void> {
  if (!deliverable(timer, snapshot)) return;
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
    const agent = stmt(
      `SELECT *, created_at < datetime('now', ?) AS settled FROM agents WHERE id = ?`,
    ).get(SETTLE_WINDOW, id) as
      | {
          status: string;
          tmux_target: string;
          agent_state: string;
          state_changed_at: string | null;
          settled: number;
        }
      | undefined;
    if (!agent || agent.status !== "running") return { idle: true, gone: true, since: null };
    if (!targetAlive(agent.tmux_target, snapshot)) {
      // The same spawn race the janitor guards against: a row inserted before
      // its window exists is not gone, it is not born yet. Without this an
      // idle_any wake set during another session's spawn fires immediately.
      if (!agent.settled) return { idle: false, gone: false, since: null };
      return { idle: true, gone: true, since: null };
    }
    return { idle: agent.agent_state === "idle", gone: false, since: agent.state_changed_at };
  });
}

async function maybeFireIdle(
  timer: TimerRow,
  snapshot: AliveSnapshot | null,
  now: string,
): Promise<void> {
  const timedOut = timer.max_wait_at != null && timer.max_wait_at <= now;
  let ready = false;
  if (timedOut) {
    ready = true;
  } else {
    // A null snapshot means liveness is unknown, and every question this
    // branch asks is a liveness question: an unknown target used to read as
    // gone, which fired an idle_any wake the instant a probe hiccuped. Wait
    // for the next tick instead. Max-wait above is a clock decision and does
    // not consult tmux, so it still fires on time.
    if (snapshot === null) return;
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
  if (ready && deliverable(timer, snapshot) && claimOneShot(timer.id)) {
    await deliver(timer, timedOut ? "max wait reached" : "");
  }
}

// How many watched workers a wake reports on. Each costs one capture-pane
// fork and a handful of lines in the delivered body, and a lead watching more
// than three needs a summary rather than three screens.
const TAIL_AGENTS = 3;

// Issue #24: what hive saw on the watched workers, carried in the wake itself.
//
// This is not the fix. hook.ts is: an agent waiting on its own background
// subagents now records "working", so the idle signal means what a lead reads
// it to mean. This is what makes a regression in that signal loud instead of
// silent. The signal rests on an undocumented field in Claude Code's Stop
// payload; if that field is renamed or its status vocabulary changes, hive
// quietly goes back to reporting a worker as finished while its subagents run,
// and a lead holding nothing but "Act now" has no way to catch it. The pane
// tail is the same evidence agent_output would give, delivered without having
// to know to ask.
//
// Read at DELIVERY, not at the moment the wake was decided. capture-pane is
// live by nature, so the screen below is the current one, and the agent_state
// printed beside it is re-read to match rather than carried from the decision.
// Those are seconds apart at most, but they can disagree with the transition
// that fired the wake, and a note claiming to show the deciding moment while
// showing the delivering one is the kind of small lie this codebase keeps
// paying for. Hence "as this wake is delivered", and "state now".
//
// Never throws and never blocks delivery. This runs after the timer is claimed,
// so an exception escaping here would burn a wake that is already spent and
// deliver nothing in its place. Every read is individually optional: a pane
// that died between the decision and this call costs its own line, not the
// wake.
function watchedTail(timer: TimerRow): string {
  try {
    const ids = JSON.parse(timer.watch) as number[];
    if (ids.length === 0) return "";
    const shown: string[] = [];
    for (const id of ids.slice(0, TAIL_AGENTS)) {
      const agent = stmt(
        "SELECT name, tmux_target, agent_state, status FROM agents WHERE id = ?",
      ).get(id) as
        | { name: string; tmux_target: string; agent_state: string; status: string }
        | undefined;
      if (!agent) continue;
      if (agent.status !== "running") {
        shown.push(`${agent.name}: closed, so there is no terminal left to read.`);
        continue;
      }
      let tail = "";
      try {
        tail = sanitizeTail(capturePane(agent.tmux_target, tailCaptureLines()));
      } catch {
        // Pane gone or tmux unreachable; say so rather than dropping the agent.
      }
      shown.push(
        tail
          ? `${agent.name} (hive state now: ${agent.agent_state}), last lines of its terminal:\n${tail}`
          : `${agent.name} (hive state now: ${agent.agent_state}): its terminal could not be read.`,
      );
    }
    if (shown.length === 0) return "";
    const lines = ["--- what hive sees on the watched agents as this wake is delivered ---", ...shown];
    if (ids.length > TAIL_AGENTS) {
      lines.push(`(${ids.length - TAIL_AGENTS} more watched agent(s) not shown)`);
    }
    lines.push(
      "hive fires this on each worker's own hook state. If a terminal above shows work still running, that worker is not finished: read agent_output before acting on it.",
    );
    // Blank line first: the body is a sentence and this is a block under it.
    // Built by pushing rather than by filtering a sparse array, because the
    // filter that used to drop the optional line also silently ate this
    // separator and the two ran together in the delivered wake.
    return `\n\n${lines.join("\n")}`;
  } catch {
    return "";
  }
}

// The tail is a pure function of the timer, and watchedTail answers "" for a
// timer that watches nothing (delay wakes leave watch at its '[]' default),
// so this is not a per-call-site decision. A future wake kind that watches
// agents gets the evidence without having to remember to ask for it.
async function deliver(timer: TimerRow, note: string): Promise<void> {
  const tail = watchedTail(timer);
  const prefix = `[hive wake #${timer.id}${note ? `, ${note}` : ""}] `;
  await sendText(timer.deliver_pane, prefix + timer.body + tail, true);
}
