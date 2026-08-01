import type { Statement } from "better-sqlite3";
import { dataDir, db, storeReplaced } from "./db.js";
import { maybeBackupHourly } from "./backup.js";
import { closeAgentRow } from "./spawn.js";
import {
  capturePane,
  liveTargets,
  maskChoiceMarker,
  paneAwaitingChoice,
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
  typed_at: string | null;
  held_at: string | null;
  held_reason: string | null;
  confirmed_at: string | null;
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

// Issue #27. Bookkeeping about a delivery, never delivery itself: same
// precedent as src/hook.ts's record() (.claude/rules/worker-state.md). A
// throw from a write like this must cost only the write, never abort the
// rest of a tick's candidates or turn an already-successful delivery into a
// thrown exception. Every write this lane added to the scheduler (held_at,
// typed_at, confirmed_at) is exactly this shape, so it is one function
// rather than the same try/catch retyped at each call site.
function bestEffortRun(sql: string, ...params: unknown[]): void {
  try {
    stmt(sql).run(...params);
  } catch {
    // Best-effort bookkeeping; see comment above.
  }
}

let ticking = false;
let schedulerInterval: NodeJS.Timeout | undefined;

export function startScheduler(intervalMs = 3000): void {
  // unref: the scheduler must never keep an orphaned server process alive
  // after its Claude session closes stdin.
  schedulerInterval = setInterval(() => {
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

// Retention for agent_state_log, which nothing else bounds because nothing ever
// updates or deletes a row in it.
//
// Seven days because the question this table answers is always "what happened
// during that lane", and a lane is hours. Twenty thousand rows as the second
// bound because time alone does not cap a busy week: a worker writes two to
// four rows per turn, so the cap is roughly a week of heavy use and the payload
// cap in hook.ts keeps the worst case near 200MB rather than unbounded. Those
// two constants multiply, so moving either one moves that figure: see
// PAYLOAD_LIMIT in src/hook.ts.
// Exported (counselors A6) so wake_list's recently_delivered section can
// bound itself by the same window: past this, checkConfirmations() can never
// find a matching prompt row again regardless, so a stale one-shot's
// "unconfirmed" would otherwise mean "hive stopped looking days ago" rather
// than "waiting on an ack", the exact ambiguity the tri-state exists to
// remove.
export const LOG_RETENTION = "-7 days";
const LOG_MAX_ROWS = 20_000;

// In tick() rather than in janitor(), and that is not tidiness. janitor answers
// a tmux-liveness question and returns early when the probe fails, so retention
// living inside it would stop happening exactly when tmux is unreachable, which
// is the state a machine can sit in for days. This sweep touches no tmux and
// has no reason to care.
//
// Each bound is checked with a read before it writes. A DELETE that matches
// nothing still opens a write transaction, and every hive session ticks against
// one shared store, so the common case must not take the write lock at all.
//
// Runs every tick, with no interval gate. Both bounds are days and tens of
// thousands of rows, so a gate was considered and dropped: with the three reads
// below all resolving as index seeks, the idle cost is microseconds, and a
// counter that makes "did retention run" depend on how many ticks happened
// earlier in the process is a worse thing to own than the cost it saves.
function pruneStateLog(): void {
  try {
    const stale = stmt(
      "SELECT 1 AS hit FROM agent_state_log WHERE created_at < datetime('now', ?) LIMIT 1",
    ).get(LOG_RETENTION);
    if (stale) {
      stmt("DELETE FROM agent_state_log WHERE created_at < datetime('now', ?)").run(LOG_RETENTION);
    }
    // MAX - MIN over-counts once rows have been deleted, so the cap can prune
    // early. That is the safe direction for a bound whose job is to stop the
    // table growing.
    //
    // Two statements rather than one SELECT MAX(id), MIN(id), and this is
    // measured rather than assumed. SQLite's min/max optimisation applies only
    // when the single result column is min(X) or max(X); two aggregates in one
    // SELECT disables it and the plan becomes a full covering-index scan, which
    // is the SAME plan as the COUNT(*) an earlier version of this comment
    // claimed to be avoiding. Split, each one is a SEARCH. Both stay in the
    // stmt() cache.
    const hi = (stmt("SELECT MAX(id) AS v FROM agent_state_log").get() as { v: number | null }).v;
    const lo = (stmt("SELECT MIN(id) AS v FROM agent_state_log").get() as { v: number | null }).v;
    if (hi != null && lo != null && hi - lo >= LOG_MAX_ROWS) {
      stmt("DELETE FROM agent_state_log WHERE id <= ?").run(hi - LOG_MAX_ROWS);
    }
  } catch {
    // Housekeeping. It must never take a tick down, and a store that has not
    // run this migration yet is one of the ways it can throw.
  }
}

// Issue #27. Confirmation is an OBSERVATION - a UserPromptSubmit (event
// 'prompt') row in agent_state_log for deliver_actor, at or after typed_at -
// never inferred from an absent row. A busy pane queues a paste for minutes,
// so silence is not evidence of loss; this drives REPORTING only and must
// never drive retry.
//
// Counselors A1. (actor, time) ALONE is a proxy, not an observation: any
// prompt row for deliver_actor at or after typed_at matched, including one
// caused by something else entirely - two wakes to one pane where the first
// answers a dialog nobody read while the second's legitimate prompt row
// confirms it, or a background subagent's task-notification landing as a
// fresh user turn with no wake involved at all. The discriminator was sitting
// unused: deliver() (below) always prefixes what it types with
// `[hive wake #<id>...] `, and Claude Code's UserPromptSubmit payload carries
// the exact text submitted in its "prompt" field, so agent_state_log.payload
// (src/hook.ts's record(), stored raw) contains that prefix verbatim whenever
// the wake's own paste is what got submitted. PAYLOAD_LIMIT truncates the
// TAIL (src/hook.ts), so the prefix - which starts the prompt field - always
// survives. Two terminator forms because the prefix is either
// `#<id>] ` (no note) or `#<id>, <note>] ` (maybeFireIdle's "max wait
// reached"): matching only `#<id>]` would silently miss every idle/max-wait
// wake.
//
// confirmed_at is written HERE, by the scheduler, and nowhere else. The hook
// (src/hook.ts) never learns timers exist: it runs on every turn of every
// worker, is deliberately minimal, and already swallows its own failures:
// making it a second writer of delivery state would be a second thing to
// reconcile, for the same reason record() stays ignorant of everything but
// the state it just decided.
//
// Why a stored column at all, rather than a plain join at read time in
// wake_list/status: pruneStateLog (above) deletes by a GLOBAL id span across
// EVERY actor (LOG_MAX_ROWS), not per-actor, so a quiet actor's own prompt
// row can be evicted by a completely unrelated actor's churn while the timer
// row it confirmed sits untouched. A confirmation computed fresh on every
// read would then silently regress from confirmed back to unconfirmed the
// moment that eviction happens - the exact class of small lie #27 exists to
// remove, just moved from "fired means delivered" to "confirmed sometimes
// un-confirms itself". Stamping it once, the first tick that observes it,
// makes the fact durable against a table that owes it nothing. Positive-only
// and one-way WITHIN one delivery: this UPDATE never clears a confirmed_at
// it did not just set, and nothing here can move a timer OUT of the WHERE
// clause's confirmed_at IS NULL once IN. That promise is about one delivery,
// not about a row a REPEATING timer reuses across many - fireDelay's own
// claim (below) resets confirmed_at to NULL at the start of each new cycle,
// counselors A3, precisely so a stale confirmation from cycle N-1 cannot
// outlive cycle N.
//
// Bounded to timers typed within LOG_RETENTION, the same window
// pruneStateLog uses to decide what agent_state_log itself still owes an
// answer for - a typed_at older than that can never find its prompt row
// again regardless, confirmed or not, so there is nothing to keep scanning
// for. Runs every tick, unconditionally, for the same reason pruneStateLog
// does: it touches no tmux and has no reason to wait on one being reachable.
//
// One correlated UPDATE rather than a SELECT-then-loop-then-UPDATE: the
// candidate set here is normally single digits (typed-but-unconfirmed wakes
// within the retention window), so this is not a hot-path optimisation, but
// a single statement is also simply less code than the three-way split it
// replaced. The subquery's MIN(created_at) is the EARLIEST matching prompt
// row, matching the original loop's ORDER BY ... LIMIT 1. A timer with no
// matching row gets confirmed_at set to NULL, which it already is - a
// harmless no-op, not a violation of "positive-only, never cleared": nothing
// here can ever move a timer OUT of the WHERE clause's confirmed_at IS NULL
// once it has been set.
//
// Counselors A5. That "harmless no-op" is still a WRITE: an UPDATE opens its
// transaction at statement start regardless of whether any row's value
// actually changes, and nothing prunes `timers` (no DELETE FROM timers
// anywhere in src/), so the typed-but-unconfirmed set only grows - until L4
// lands, every lead-targeted wake is permanently unconfirmable and
// accumulates for the whole retention window. pruneStateLog, just above,
// states the rule this used to violate: "A DELETE that matches nothing still
// opens a write transaction... so the common case must not take the write
// lock at all." Same shape here: a cheap read-first guard (SELECT 1 LIMIT 1)
// decides whether there is anything to confirm at all before the UPDATE ever
// runs, and AND EXISTS inside the UPDATE itself means even a false positive
// from the read-then-write race (a matching row evicted in between) still
// touches no row. That race is benign for the same reason it is in
// pruneStateLog: a missed pass is corrected by the next tick, 3 seconds
// later. Deliberately NOT adding an index here even though the read is still
// a full scan when it DOES find something to do: that is a second migration,
// #15 (todo_archive) is already queued behind this one, and two lanes
// appending to MIGRATIONS concurrently collide at rebase.
// Exported so a test can pin the AND EXISTS guard's row count directly via
// SQLite's changes(), rather than through tick()'s noisy total_changes()
// (janitor, pruneStateLog and maybeBackupHourly all write independently of
// this).
export function checkConfirmations(): void {
  const confirmationQuery = `
       SELECT MIN(created_at) FROM agent_state_log
        WHERE actor_id = timers.deliver_actor AND event = 'prompt' AND created_at >= timers.typed_at
          AND (payload LIKE '%[hive wake #' || timers.id || ']%'
               OR payload LIKE '%[hive wake #' || timers.id || ',%')`;
  try {
    const pending = stmt(
      `SELECT 1 AS hit FROM timers
        WHERE typed_at IS NOT NULL AND confirmed_at IS NULL AND typed_at >= datetime('now', ?) LIMIT 1`,
    ).get(LOG_RETENTION);
    if (!pending) return;
    stmt(
      `UPDATE timers SET confirmed_at = (${confirmationQuery})
       WHERE typed_at IS NOT NULL AND confirmed_at IS NULL AND typed_at >= datetime('now', ?)
         AND EXISTS (${confirmationQuery.replace("MIN(created_at)", "1")})`,
    ).run(LOG_RETENTION);
  } catch {
    // Best-effort bookkeeping, same precedent as bestEffortRun above: a
    // failure here costs only this tick's confirmation pass, never delivery,
    // and the next tick tries again.
  }
}

// One sweep-and-fire pass. The snapshot is a parameter for the same reason
// janitor's is: it is the one input that decides everything here, and handing
// it in is the difference between driving a tick and simulating a tmux.
export async function tick(snapshot?: AliveSnapshot | null): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    // Issue #49: once the store on disk was replaced (a restore landed while
    // this session had it open), a wake fired from here would be derived
    // from state nobody is reading any more, typed into a live tmux pane as
    // a real user turn, and recorded as fired where no one will see it. Stop
    // ticking rather than throwing, per CLAUDE.md's "the scheduler must
    // never throw and must stay unref()'d" - clear the interval so it stops
    // permanently instead of raising. Checked BEFORE liveTargets() below,
    // which forks a real tmux subprocess: no reason to pay for a probe whose
    // result is about to be thrown away.
    if (storeReplaced()) {
      clearInterval(schedulerInterval);
      schedulerInterval = undefined;
      return;
    }
    // undefined (the argument omitted) means "ask tmux"; an explicit null
    // means "the caller already knows liveness is unknown", and must stay
    // null rather than be resolved here.
    if (snapshot === undefined) snapshot = liveTargets();
    janitor(snapshot);
    // Before pruneStateLog, not after: a prompt row about to be evicted this
    // very tick (LOG_MAX_ROWS is a global cap, so a quiet actor's row can be
    // the one that falls off the end) still gets its one chance to confirm a
    // wake before it is gone for good. That ordering is the entire reason
    // checkConfirmations stamps a durable memo rather than being a plain
    // read - reversed, this tick could delete the only evidence it was ever
    // going to see.
    checkConfirmations();
    pruneStateLog();
    // Issue #23: hourly, rate-limited across every concurrent instance by an
    // atomic claim inside maybeBackupHourly itself. Placed beside the other
    // per-tick housekeeping for the same reason pruneStateLog is: it must
    // run regardless of whether tmux answered this tick.
    //
    // NOTE (PR #36, counselors N1, not fixed here - deliberately out of
    // scope for this lane, flagged for a follow-up issue): this call is
    // synchronous and runs BEFORE timer delivery below. A slow VACUUM INTO
    // (a large store, a slow disk) blocks this tick's event loop turn and
    // delays every due wake-up behind it, even though the try/catch below
    // still prevents it from ever swallowing a tick permanently. Making the
    // backup path non-blocking relative to timer delivery is an
    // architectural change - reordering, or moving the vacuum off this
    // synchronous path entirely - not a fix that belongs in this diff.
    maybeBackupHourly(db, dataDir);
    const now = (stmt("SELECT datetime('now') AS now").get() as { now: string }).now;
    const candidates = stmt(
      `SELECT * FROM timers WHERE cancelled_at IS NULL AND (
         (kind = 'delay' AND due_at <= datetime('now')
           AND (fired_at IS NULL OR repeat_every_ms IS NOT NULL))
         OR (kind != 'delay' AND fired_at IS NULL)
       )`,
    ).all() as TimerRow[];
    // Scoped to this tick: a dialog that clears between ticks must be seen.
    const choices: ChoiceCache = new Map();
    for (const timer of candidates) {
      if (timer.kind === "delay") await fireDelay(timer, snapshot, choices);
      else await maybeFireIdle(timer, snapshot, now, choices);
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
// One capture-pane answer per pane per tick. Liveness on the line above is
// already resolved from a single batched snapshot for exactly this reason, and
// forking tmux per timer would have thrown that away: a lead's wakes all target
// the lead's own pane, so N ready timers meant N identical captures, and a timer
// held by a dialog re-forks every three seconds for as long as the dialog is up.
//
// INVALIDATED BY OUR OWN DELIVERIES, which the first version of this cache was
// not, and that made it manufacture the exact false negative the guard exists to
// prevent. Deliveries in a tick are serial and each one costs a claim, up to
// three capture-pane forks, a paste and a hard 300ms sleep. So wake #7 delivers,
// the lead's session takes that turn and raises a permission prompt, and wake
// #11 is then judged against a screen read seconds earlier and types its Enter
// into the dialog. Typing into a pane is the one thing inside a tick that can
// change that pane's answer, so forgetting the answer after typing is the exact
// scope of the repair: the batching still holds for panes nothing was delivered
// to, and for a timer held by a dialog, which is where it was worth having.
type ChoiceCache = Map<string, boolean | null>;

function awaitingChoice(pane: string, cache: ChoiceCache): boolean | null {
  let answer = cache.get(pane);
  if (answer === undefined) {
    answer = paneAwaitingChoice(pane);
    cache.set(pane, answer);
  }
  return answer;
}

function deliverable(timer: TimerRow, snapshot: AliveSnapshot | null, choices: ChoiceCache): boolean {
  const live = snapshot ? targetAlive(timer.deliver_pane, snapshot) : targetLive(timer.deliver_pane);
  if (live === null) return false;
  if (!live) {
    cancelTimer(timer.id);
    return false;
  }
  // Todo 65. A pane sitting on a modal choice eats the paste and reads the
  // Enter as an answer, so delivering into one loses the wake AND approves
  // whatever claude has highlighted. Wait instead: not cancelled, not claimed,
  // just still pending, so the next tick tries again once the dialog is gone
  // and a lead can see it outstanding in wake_list meanwhile.
  //
  // Above claimOneShot for the same reason the liveness check is: after the
  // claim, "not now" and "never" are the same thing.
  if (awaitingChoice(timer.deliver_pane, choices) === true) {
    // Issue #27. This records that a hold happened; it does not change the
    // answer above, which was already false before this line. The most
    // recent hold only, not a count: a wake stuck behind a dialog for an
    // hour writes the same row every tick, not one per tick.
    //
    // deliverable() used to be a pure predicate; this write makes it one
    // with a side effect, and that side effect must never cost more than
    // itself. Several MCP server instances tick concurrently against the
    // same WAL store, so every one of them writes this same row on every
    // tick a dialog stays up - SQLITE_BUSY here is the ordinary case, not
    // the exotic one. Before this write existed, a modal pane could not
    // abort the rest of this tick's candidates; a throw escaping this
    // UPDATE would newly let it, which is a behaviour change this lane's
    // "reporting only" boundary does not allow. bestEffortRun is the same
    // precedent as src/hook.ts's record() (see .claude/rules/worker-state.md):
    // this is forensics about a hold, not the hold itself, so a failure to
    // record it costs the record, never the candidates after it in this tick.
    //
    // Counselors A4. GUARDED by due_at, the same optimistic token fireDelay's
    // own claim already uses - the write used to carry no guard at all.
    // `timer` here is the row THIS tick read at its candidates SELECT, and a
    // concurrent instance can claim and fully deliver the SAME repeating
    // timer (a one-shot never stays a candidate past its claim, so only a
    // repeating timer is exposed) in the gap between that read and this
    // write: this tick's own earlier candidates each cost a claim, several
    // capture-pane forks and sendText's real ENTER_DELAY_MS sleep, so by the
    // time this timer is reached its due_at may already have moved on. Without
    // the guard, that write lands anyway and reports a wake that delivered on
    // schedule as stuck behind a dialog - `hive status` then shows "(1 held)"
    // for nothing, and for a repeating timer nothing clears it until the next
    // cycle, potentially the whole repeat period. WHERE due_at = ? makes the
    // write a no-op exactly when a concurrent claim has already moved this row
    // past the state this tick observed.
    bestEffortRun(
      `UPDATE timers SET held_at = datetime('now'), held_reason = ?
       WHERE id = ? AND cancelled_at IS NULL
         AND (fired_at IS NULL OR (repeat_every_ms IS NOT NULL AND due_at = ?))`,
      HELD_REASON_MODAL_CHOICE,
      timer.id,
      timer.due_at,
    );
    return false;
  }
  return true;
}

const HELD_REASON_MODAL_CHOICE = "pane is awaiting a modal choice (folder-trust or /model picker)";

async function fireDelay(
  timer: TimerRow,
  snapshot: AliveSnapshot | null,
  choices: ChoiceCache,
): Promise<void> {
  if (!deliverable(timer, snapshot, choices)) return;
  let claimed: boolean;
  if (timer.repeat_every_ms != null) {
    const seconds = Math.max(1, Math.round(timer.repeat_every_ms / 1000));
    // Issue #27, counselors A3. A repeating timer reuses one row across many
    // deliveries, and this claim - not deliver()'s post-send write - is where
    // a NEW delivery cycle begins. The previous version only reset these
    // columns after sendText returned, so a THROWING sendText on cycle 5 left
    // cycle 1's typed_at/confirmed_at in place: fire_count advanced, the
    // claim succeeded, and wake_list reported a cycle that was never typed as
    // confirmed. Resetting here means a failed send leaves exactly the same
    // signal a one-shot's failed send does - fired_at set, everything else
    // NULL - instead of stale success data from a previous cycle.
    claimed =
      stmt(
        `UPDATE timers SET due_at = datetime('now', printf('+%d seconds', ?)),
           fired_at = datetime('now'), fire_count = fire_count + 1,
           typed_at = NULL, confirmed_at = NULL, held_at = NULL, held_reason = NULL
         WHERE id = ? AND due_at = ? AND cancelled_at IS NULL`,
      ).run(seconds, timer.id, timer.due_at).changes === 1;
  } else {
    claimed = claimOneShot(timer.id);
  }
  if (claimed) await deliver(timer, "", choices);
}

function claimOneShot(timerId: number): boolean {
  return (
    stmt(
      `UPDATE timers SET fired_at = datetime('now'), fire_count = fire_count + 1
       WHERE id = ? AND fired_at IS NULL AND cancelled_at IS NULL`,
    ).run(timerId).changes === 1
  );
}

// A watched agent that is not there any more. Nothing left to wait for, so the
// two ways of reaching it share one value.
const GONE: WatchedState = { idle: true, gone: true, since: null };

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
    if (!agent || agent.status !== "running") return GONE;
    if (!targetAlive(agent.tmux_target, snapshot)) {
      // The same spawn race the janitor guards against: a row inserted before
      // its window exists is not gone, it is not born yet. Without this an
      // idle_any wake set during another session's spawn fires immediately.
      if (!agent.settled) return { idle: false, gone: false, since: null };
      return GONE;
    }
    return { idle: agent.agent_state === "idle", gone: false, since: agent.state_changed_at };
  });
}

async function maybeFireIdle(
  timer: TimerRow,
  snapshot: AliveSnapshot | null,
  now: string,
  choices: ChoiceCache,
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
    // idle_any: agents already idle when the timer was set do not count; wait
    // for a fresh transition (or a watched agent going away entirely). >= not >:
    // timestamps have one-second granularity, and a transition in the same
    // second as timer creation must fire rather than hang until max-wait.
    ready =
      timer.kind === "idle_any"
        ? states.some((s) => s.gone || (s.idle && s.since != null && s.since >= timer.created_at))
        : states.length > 0 && states.every((s) => s.idle);
  }
  if (ready && deliverable(timer, snapshot, choices) && claimOneShot(timer.id)) {
    await deliver(timer, timedOut ? "max wait reached" : "", choices);
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
        // Round 2, D5. This embeds a worker's screen into a wake body that
        // hive itself types into the LEAD's pane next. A worker sitting on a
        // real dialog carries "Esc to cancel" in its tail, so without the
        // mask the lead's own pane would end up showing hive's own dialog
        // marker, and deliver()'s cache invalidation guarantees the very
        // next tick re-reads it. D5 already stops that pane from being
        // misread as a dialog (the lead's input box is on screen too), but
        // masking it here is one line and does not depend on that holding.
        tail = maskChoiceMarker(sanitizeTail(capturePane(agent.tmux_target, tailCaptureLines())));
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
//
// Forgets what this pane looked like, because it does not look like that any
// more: a user turn was just submitted into it and whatever that turn does next
// is unknown to this process. Any later timer in the same tick re-reads.
//
// THIS NARROWS THE WINDOW, IT DOES NOT CLOSE IT, and saying so is the point.
// The check sits above claimOneShot, so between deciding and the Enter that
// sendText sends 300ms after its paste there is a gap nothing here can hold
// shut. Reading a terminal to decide whether typing at it is safe is
// check-then-act against a program that does not answer, and closing it needs
// delivery to stop meaning "typed at a terminal" (issue #27). What is fixed is
// the part hive causes itself.
async function deliver(timer: TimerRow, note: string, choices: ChoiceCache): Promise<void> {
  const tail = watchedTail(timer);
  const prefix = `[hive wake #${timer.id}${note ? `, ${note}` : ""}] `;
  try {
    await sendText(timer.deliver_pane, prefix + timer.body + tail, true);
  } finally {
    // Unchanged from before this lane: a throw out of sendText still
    // propagates from here, past the typed_at write below, so typed_at
    // stays NULL exactly as the column's acceptance requires. Cache
    // invalidation runs on both the success and the throw path, exactly as
    // it did before typed_at existed.
    choices.delete(timer.deliver_pane);
  }
  // Issue #27. typed_at is the attempt, set only once sendText above has
  // returned without throwing. This write sits OUTSIDE the try/finally on
  // purpose: sendText has already succeeded by this line, so a failure
  // recording that fact must cost the record, never retroactively turn an
  // already-successful delivery into a thrown exception that aborts the
  // rest of this tick's candidates (bestEffortRun is the same precedent as
  // deliverable()'s held_at write, above, and src/hook.ts's record(); see
  // .claude/rules/worker-state.md). held_at/held_reason are cleared on the
  // same write, since a hold that is now resolved should stop being
  // reported as the wake's current state.
  //
  // confirmed_at IS ALSO CLEARED HERE, redundantly for a repeating timer -
  // the due_at claim UPDATE above (fireDelay) already reset it, along with
  // typed_at/held_at/held_reason, the moment this cycle was claimed, which is
  // where a NEW delivery cycle actually begins (counselors A3: a throwing
  // sendText must not leave a previous cycle's success recorded against this
  // one). For a ONE-SHOT wake, claimOneShot never touches these columns, so
  // this line is the only place held_at/held_reason get cleared once a
  // previously-held wake finally delivers - not a no-op there. "Positive-only,
  // never cleared" (the comment on checkConfirmations, above) is a promise
  // about ONE delivery, not about a row a repeating timer reuses across many;
  // "resets confirmed_at on every re-delivery of a repeating timer" in
  // test/delivery-state.test.mjs is the test that pins both halves.
  //
  // MILLISECONDS, matching agent_state_log.created_at's own
  // strftime('%Y-%m-%d %H:%M:%f', 'now') exactly, not datetime('now')'s
  // whole seconds. checkConfirmations compares created_at >= typed_at as an
  // EXACT match, not a lenient one (the part C gate's fired_at-vs-created_at
  // false red, fixed in #63, is the opposite case: floor to the coarser
  // resolution when a lenient match is wanted). A whole-second typed_at
  // would match any prompt row in the same wall second, including one
  // written up to 999ms before this line ever ran, and that is a FALSE
  // CONFIRMED - a target's own unrelated turn read as having acknowledged a
  // wake it had not been sent yet. typed_at is brand new in this lane and
  // nothing else reads its format, so there is no compatibility reason to
  // keep it coarse.
  bestEffortRun(
    `UPDATE timers SET typed_at = strftime('%Y-%m-%d %H:%M:%f', 'now'),
       held_at = NULL, held_reason = NULL, confirmed_at = NULL WHERE id = ?`,
    timer.id,
  );
}
