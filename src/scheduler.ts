import type { Statement } from "better-sqlite3";
import { dataDir, db, storeReplaced } from "./db.js";
import { maybeBackupHourly } from "./backup.js";
import { closeAgentRow, isLeadActorId, LEAD_ACTOR_PREFIX, LEAD_KIND } from "./spawn.js";
import {
  ageSecondsSince,
  describeLastLogEvent,
  humanizeAge,
  lastLogEvent,
  reportsAgentStateLog,
} from "./stateProvenance.js";
import {
  capturePane,
  foreignSocket,
  inputBoxState,
  liveTargets,
  maskChoiceMarker,
  paneAwaitingChoice,
  rowAlive,
  rowLive,
  sanitizeTail,
  sendText,
  tailCaptureLines,
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
  typed_busy: number | null;
  // Issue #73, D6. Joined from agents.tmux_socket via deliver_actor, never a
  // column on timers itself - see the candidates query in tick() and the
  // janitor's own timers sweep above. Coalesced to '' in SQL for a join miss
  // (a plain `user:` target with no agents row), so this reads exactly like
  // the '' "no fact recorded" case at every call site - D2 - with one
  // representation of "unset" instead of two.
  deliver_socket: string;
}

// Shared by the janitor's timers sweep and tick()'s candidates query, the
// same reason ACTIVE_TIMER_WHERE (below) is named rather than retyped in
// both: a timer names a pane, not an agents row, so its own recorded socket
// (issue #73, D6) has to be reached through deliver_actor.
//
// Resolves the PREFERRED agents row for deliver_actor rather than filtering
// rows out - that distinction is the fix (counselors round 2, R2-1). The
// first version of this join filtered with `AND agents.status = 'running'`
// on the theory that a closed row sharing an actor_id with a running
// successor should never be allowed to answer for it (see F1's reasoning
// below). But closeAgentRow() (src/spawn.ts) never cancels that actor's
// timers, so a timer can go on being active after ITS OWN owning row closes
// with no running successor at all. Filtered out, that join misses
// entirely, deliver_socket reads '' (D2's "no fact recorded"), and the
// closed row's real, possibly-foreign recorded socket is silently treated
// as local: rowAlive() then judges the pane against THIS process's own
// server, where a small pane id can easily name a live stranger's pane.
// Before the filter existed the closed row matched and the wake was held;
// the filter traded the laundering hole F1 fixed for a new hole in the same
// function. The subquery below still prefers a running row when one shares
// the actor_id (the ORIGINAL F1 scenario: a closed row must not outvote a
// live successor), falling back to the most recently created row - closed
// or not - only when no running row exists, so a lone closed row keeps its
// own fact readable instead of being discarded.
//
// F1's original comment claimed the running-only filter made this join
// "at most one-to-one, since idx_agents_running_name permits only one
// running row per name". That claim was WRONG (counselors round 2, R2-2):
// the index is UNIQUE(project_id, name COLLATE NOCASE) WHERE
// status='running' - it constrains NAME, not actor_id or kind, and
// ensureLeadRow's own comment (src/cli.ts) documents a reachable path where
// a pre-fix server leaves TWO running kind='lead' rows in one project,
// because the index has nothing to say about kind. If the second inherits
// the first's actor_id - exactly what ensureLeadRow's own reuse rule
// produces whenever a closed predecessor's actor_id is non-empty - the join
// is one-to-many again regardless of any status filter, and nothing today
// has a fixture for that shape. The one-to-one guarantee this code actually
// needs comes from LIMIT 1 on the subquery, not from any index: whichever
// row SQLite's ORDER BY picks, it can only ever pick one.
export const DELIVER_SOCKET_JOIN = `LEFT JOIN agents ON agents.id = (
  SELECT a.id FROM agents a WHERE a.actor_id = timers.deliver_actor
   ORDER BY (a.status = 'running') DESC, a.id DESC LIMIT 1
)`;

// Issue #73 counselors A2, accepted and recorded, not fixed here. A timer
// whose deliver_actor names no agents row at all - a wake set by a plain
// `user:` session - joins to nothing here, reads deliver_socket = '' (D2's
// "no fact recorded"), and is treated as local. Deriving the socket from
// deliver_actor cannot protect a rowless session; there is no row to derive
// it FROM. NOT a regression: timers had zero socket protection before this
// lane, and this join strictly narrows the gap (every timer that DOES join
// to an agents row is now covered) rather than widening it. A socket column
// on timers themselves would close this, and is a second migration for
// whoever picks it up next, not this lane.

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
  // kind != LEAD_KIND: issue #27's L4 fix round, DECISION 3. A reused lead
  // row's created_at is from its ORIGINAL insert, not this restart, so
  // SETTLE_WINDOW gives it no grace the way a freshly spawned worker gets one
  // - closing it here would cost the very identity ensureLeadRow (src/cli.ts)
  // exists to keep stable. See that function's comment for the accepted
  // consequence: a dead-paned lead row now stays 'running' until `hive lead`
  // re-records a live pane, and `hive doctor` reports that rather than this
  // sweep hiding it.
  const agents = stmt(
    `SELECT id, tmux_target, tmux_socket FROM agents WHERE status = 'running' AND kind != ? AND tmux_target != ''
     AND created_at < datetime('now', ?)`,
  ).all(LEAD_KIND, SETTLE_WINDOW) as { id: number; tmux_target: string; tmux_socket: string }[];
  for (const agent of agents) {
    // Issue #73, D2/D4/D6: a foreign socket reads unknown (null), never dead,
    // so this loop must sweep only an explicit `false` - the same trap the
    // old `!targetAlive(...)` truthiness check would otherwise fall into the
    // moment rowAlive starts answering null for a row this process cannot
    // honestly judge.
    if (rowAlive(agent.tmux_socket, agent.tmux_target, snapshot) === false) {
      closeAgentRow(agent.id);
      closedAgents += 1;
    }
  }
  // deliver_actor NOT LIKE LEAD_ACTOR_PREFIX + '%': the same defect wearing a
  // different hat. A wake set for the lead itself carries the lead's actor_id
  // in this column (wakes.ts's resolveDelivery), and a lead's pane can be
  // exactly as momentarily dead across a restart as its agents row's
  // tmux_target - for the identical reason, this sweep must not cancel it
  // just because the restart has not landed a fresh pane yet. deliverable()
  // below carries the matching exemption for the per-tick delivery-time
  // check.
  //
  // Accepted consequence, matching ensureLeadRow's for the agents row: a
  // lead-owned wake whose pane is gone is never cancelled by this sweep. It
  // sits pending (deliverable() below holds it, HELD_REASON_LEAD_PANE_DEAD)
  // until either a human runs wake_cancel, or the lead's next `hive lead`
  // reaches it - and as of issue #27's L4 fix round R6 (todo 166), `hive
  // lead` ACTUALLY re-points every pending lead-owned wake's deliver_pane to
  // the fresh pane in the same transaction that records it, rather than
  // merely hoping a future tick's own liveness probe would notice. So the
  // residual here is now only the genuinely-never-returns case - a lead
  // whose session is abandoned for good, not one that restarts - and
  // resolves the moment `hive lead` runs, not on some later tick. Unlike the
  // agents row, nothing surfaces the never-returns residual in hive doctor
  // today; a pending-forever wake is visible in wake_list, not silently
  // hidden, so that gap was judged the lesser one, not zero.
  // LEFT JOIN, not JOIN: a timer's deliver_actor can name a plain `user:`
  // session with no agents row at all, which has no recorded fact and must
  // behave exactly as before this lane (D2/D6) - COALESCE reads that join
  // miss as '' (the same "no fact recorded" case), so there is one
  // representation of "unset" for callers, not NULL from the join and '' from
  // the column.
  const timers = stmt(
    `SELECT timers.id, timers.deliver_pane, COALESCE(agents.tmux_socket, '') AS deliver_socket
       FROM timers ${DELIVER_SOCKET_JOIN}
      WHERE ${ACTIVE_TIMER_WHERE} AND timers.deliver_actor NOT LIKE ?
        AND timers.created_at < datetime('now', ?)`,
  ).all(`${LEAD_ACTOR_PREFIX}%`, SETTLE_WINDOW) as {
    id: number;
    deliver_pane: string;
    deliver_socket: string;
  }[];
  for (const timer of timers) {
    if (rowAlive(timer.deliver_socket, timer.deliver_pane, snapshot) === false) {
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
    // LEFT JOIN for deliver_socket (issue #73, D6): see TimerRow's own comment
    // on the field. timers.* keeps every bare column reference below
    // unambiguous against agents' own id/project_id/kind/created_at columns.
    const candidates = stmt(
      `SELECT timers.*, COALESCE(agents.tmux_socket, '') AS deliver_socket
         FROM timers ${DELIVER_SOCKET_JOIN}
        WHERE timers.cancelled_at IS NULL AND (
         (timers.kind = 'delay' AND timers.due_at <= datetime('now')
           AND (timers.fired_at IS NULL OR timers.repeat_every_ms IS NOT NULL))
         OR (timers.kind != 'delay' AND timers.fired_at IS NULL)
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
//
// Widened (todo 270) to carry a SECOND, independently-lazy answer alongside
// the choice one: whether the pane's input box holds real unsubmitted human
// text. One cache, not two, because both answers are invalidated by the
// identical event (this tick typed into the pane) and a second Map would
// just duplicate that invalidation logic for no reason. Each field is
// computed at most once per pane per tick, the same discipline the choice
// answer already had - inputBoxState costs its own capture-pane fork (it
// needs "-e" for the ghost/pending SGR discriminator, which paneAwaitingChoice's
// plain capture does not carry), so this does not save that fork, only caps
// it at one per pane per tick rather than one per due timer.
type ChoiceCache = Map<string, { choice?: boolean | null; inputHeld?: boolean }>;

function cacheEntry(pane: string, cache: ChoiceCache): { choice?: boolean | null; inputHeld?: boolean } {
  let entry = cache.get(pane);
  if (!entry) {
    entry = {};
    cache.set(pane, entry);
  }
  return entry;
}

function awaitingChoice(pane: string, cache: ChoiceCache): boolean | null {
  const entry = cacheEntry(pane, cache);
  if (entry.choice === undefined) entry.choice = paneAwaitingChoice(pane);
  return entry.choice;
}

// Todo 270. inputBoxState's OWN consumer (agent_status/agent_output's
// input_box field) already tells real unsubmitted text apart from claude's
// ghost hint and from empty; this reuses that same detector as a HOLD
// condition, exactly the way paneAwaitingChoice already is one, rather than
// inventing a second signal. Only "pending" (real, human-typed text) holds -
// "ghost" and "empty" must not, or every idle pane (which shows the ghost
// hint) would hold every wake forever, and "unknown" must not either: it
// means the detector's own chrome-matching drifted (issue #30's shape), and
// a hold that silently starts firing on every unrecognised screen is worse
// than a detector that silently stops - the loud failure here is
// input_box's own receipt field reporting "unknown", not a wake that quietly
// never fires. A pane with no box at all (null: a modal, or mid-turn) is not
// this function's concern; the modal case is already held above by
// awaitingChoice, and mid-turn is not a hold condition (this codebase's own
// position is well-established: a busy pane is fine to deliver into, only a
// pane with nowhere to put the paste is not).
function inputBoxHoldsWake(pane: string, cache: ChoiceCache): boolean {
  const entry = cacheEntry(pane, cache);
  if (entry.inputHeld === undefined) entry.inputHeld = inputBoxState(pane)?.state === "pending";
  return entry.inputHeld;
}

// Counselors R2-A on the L4 fix round's todo 161. The lead exemption below
// used to just `return false` with nothing written, so a lead wake blocked
// on a dead pane sat with typed_at, held_at and held_reason all NULL - the
// identical shape wake_list already uses for "not due yet", the exact
// ambiguity #27 shipped held_at/held_reason to remove. Recorded through the
// same guarded write the modal-choice hold below uses, not a second
// mechanism, with its own reason string.
function holdTimer(timer: TimerRow, reason: string): void {
  bestEffortRun(
    `UPDATE timers SET held_at = datetime('now'), held_reason = ?
     WHERE id = ? AND cancelled_at IS NULL
       AND (fired_at IS NULL OR (repeat_every_ms IS NOT NULL AND due_at = ?))`,
    reason,
    timer.id,
    timer.due_at,
  );
}

const HELD_REASON_MODAL_CHOICE = "pane is awaiting a modal choice (folder-trust or /model picker)";
const HELD_REASON_LEAD_PANE_DEAD =
  "the lead's pane is not live right now (likely mid-restart); lead-owned wakes are exempt from " +
  "cancellation for this alone, so it is held rather than lost";
const HELD_REASON_UNSUBMITTED_INPUT =
  "the pane's input box has unsubmitted human text; delivering now would paste the wake body onto it " +
  "and submit both as one message";

function deliverable(timer: TimerRow, snapshot: AliveSnapshot | null, choices: ChoiceCache): boolean {
  const live = snapshot
    ? rowAlive(timer.deliver_socket, timer.deliver_pane, snapshot)
    : rowLive(timer.deliver_socket, timer.deliver_pane);
  // Issue #69, accepted 2026-08-02, not fixed. live === null means the tmux
  // probe could not answer, and every due wake renders byte-identical to one
  // that is not due yet for as long as that holds - this branch records
  // nothing. Counselors round 1 (todo 209, item F) corrected this comment's
  // own boundary: the original text said null occurs ONLY when
  // untrustedTmuxServer() refuses a private tmux server paired with the
  // default store (.claude/rules/tmux-and-panes.md), and named any other
  // occurrence as this acceptance's reopen trigger. That is false as written
  // - targetLive()/liveTargets() (src/tmux.ts) also answer null for ANY
  // unexpected tmux error the caught exception does not recognise as "no
  // such pane" (tmuxSaysNothingThere returning false), so a correctly
  // configured, trusted shared server with a transiently erroring socket
  // hits this exact branch too, which is precisely the "outside that refused
  // configuration" case the old text said would trigger a reopen. The
  // refused pairing is still the common, by-design case this acceptance was
  // argued against; a transient probe error is rarer and, like the refused
  // pairing, self-corrects the next tick a live snapshot resolves this timer
  // again. The acceptance still stands under either cause: a correct fix
  // needs a hold that writes once per condition rather than once per tick
  // for every due wake from every concurrent instance - real design work in
  // the hottest loop hive has, bought for a state that is either refused by
  // design or transient. A THIRD source joined this acceptance's null case in
  // issue #73: deliver_socket disagreeing with this process's own socket
  // (D6/D2) - a wake whose pane lives on a server this process cannot see
  // into, never one this project has any business typing into either. Same
  // shape, same handling: held, not lost, and it clears the moment a tick with
  // the matching socket observes it. Reopen if a wake is ever observed
  // pending-and-invisible for more than a few ticks running - a probe error
  // that resolves within a tick or two is the expected, already-accounted-for
  // case, not this.
  if (live === null) return false;
  if (!live) {
    // A lead-owned wake gets the same exemption janitor()'s timer sweep does,
    // and for the same reason: this check has no SETTLE_WINDOW grace at all,
    // so a wake becoming due in the exact gap between the lead's old pane
    // dying and a restart recording the new one would otherwise be cancelled
    // outright rather than just held for a tick. Held, not silently skipped
    // (counselors R2-A): wake_list must be able to tell this apart from a
    // wake that simply is not due yet.
    if (isLeadActorId(timer.deliver_actor)) {
      holdTimer(timer, HELD_REASON_LEAD_PANE_DEAD);
    } else {
      // Issue #71, accepted 2026-08-02, no diff. A pre-#27 scheduler running
      // in another concurrent session has no isLeadActorId exemption above
      // and cancels a lead-owned wake outright the moment its pane reads
      // dead, exactly as this function used to for everyone. That window is
      // self-closing: it exists only while other sessions are still running
      // pre-#27 code, worst on the day this exemption lands and gone once
      // every session has restarted onto it. Decided not to build a soft
      // cancel to survive it - that would add a fourth axis to the same
      // delivery-state columns #69, #70 and #75 exist to stop misreporting,
      // the wrong trade for a transient condition. The asymmetry with
      // identity is deliberate: ensureLeadRow (src/cli.ts) reuses a closed
      // lead row's actor_id because an actor_id cannot be recreated by the
      // user, while a timer can - the recovery here is to call wake_set
      // again. Reopen if a lead-owned wake is ever observed cancelled during
      // a real restart outside this mixed-version window, not inside it.
      //
      // Counselors round 1 (todo 209, item D2) found a second mixed-version
      // window in this same self-closing family, on the typed_busy column
      // (#75) rather than this cancellation. A pre-#75 server's repeating-
      // timer claim UPDATE (fireDelay, below) has no `typed_busy = NULL`
      // clause in its compiled SQL - that clause did not exist yet - so when
      // such a server claims and delivers a LATER cycle of a repeating timer
      // whose EARLIER cycle a new-code server already delivered, SQLite
      // leaves typed_busy exactly as that earlier cycle set it. A reader on
      // new code then reports the later, unrelated cycle's confirmation
      // state using the earlier cycle's stale typed_busy. Unlike this
      // cancellation window, which errs toward LOSING a wake, this one errs
      // toward the QUIET direction: a cycle typed at a genuinely idle target
      // and genuinely lost can still read unconfirmed_busy, the reassuring
      // value, for what is the real alarm. Same self-closing argument, same
      // evidence: 82 timers created in this project's entire history, 0
      // repeating, 0 fired more than once (recorded above, dba5a29), so no
      // row has ever had a second cycle for a mixed-version claim to corrupt.
      // The one-shot direction stays clean regardless of server version -
      // claimOneShot never touches typed_busy, and an old-code deliver()
      // simply never sets it, so an old-code one-shot degrades to NULL
      // (plain unconfirmed), never a stale busy claim. ACCEPT AND RECORD;
      // reopen under the same trigger as #70, above: this project's first
      // repeating wake.
      cancelTimer(timer.id);
    }
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
  //
  // Issue #27's surviving residual, recorded here because #27 itself is being
  // closed (decided with Chris 2026-08-02) and an argument that lives only in
  // a closed issue is one refactor from being deleted as arbitrary. Every
  // timer routed through deliverable() is held here for as long as its target
  // pane has a dialog up, including an idle wake whose watched agents already
  // transitioned and including a plain delay wake, not only one whose watched
  // agents never went idle - under a permanent dialog, NO wake delivered
  // through this pane ever fires, and that is true regardless of timedOut.
  // What is unique to a timed-out idle_any wake specifically: maybeFireIdle's
  // own timedOut branch (below, line ~840) sets ready=true unconditionally
  // once max_wait_at has passed, and this hold still runs after that and
  // still wins, so such a wake is held past a bound the TIMER ITSELF declared
  // as its own guarantee of firing. It is deliberate, not an oversight: typing
  // into a dialog answers it with the wake body, which is the whole reason
  // this hold exists, and a wake is worth losing less than a dialog is worth
  // answering blind. Reopens only if a dialog is ever observed staying up long
  // enough that "held" stops reading as "will resolve" - i.e. if this project
  // ever needs a ceiling or a backoff on top of the hold, neither of which
  // lives here today.
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
    holdTimer(timer, HELD_REASON_MODAL_CHOICE);
    return false;
  }
  // Todo 270. The dialog check above guards a MODAL: the input box gone
  // entirely, replaced by a footer with nowhere to put a paste. This is its
  // sibling condition, not a reversal of it - a human mid-typing has an
  // input box very much present, so the modal check above cannot see this
  // case at all. Held for the identical reason and at the identical point
  // (ABOVE claimOneShot: after the claim, "not now" and "never" are the
  // same thing): delivery is a paste followed by Enter, and a box that
  // already has real text in it gets the wake body pasted onto the END of
  // that text, then both submitted as one message the instant Enter lands.
  //
  // ACCEPTED RESIDUAL, same shape as the dialog hold's own: text left
  // sitting in a box holds this wake forever, past max_wait_at, for as long
  // as it sits there. Not a timeout to invent - matching the dialog
  // precedent (.claude/rules/tmux-and-panes.md, "Open residuals") rather
  // than building a second policy for "a human is busy with this pane".
  if (inputBoxHoldsWake(timer.deliver_pane, choices)) {
    holdTimer(timer, HELD_REASON_UNSUBMITTED_INPUT);
    return false;
  }
  return true;
}

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
    //
    // Issue #70, accepted 2026-08-02, not fixed. deliverable() (above) can
    // run and hold this SAME row for cycle N+1 before this claim resets
    // typed_at and confirmed_at, so the hold it writes sits next to cycle N's
    // typed_at and confirmation until this claim finally succeeds - a held
    // repeating wake can report the previous cycle's confirmation as if it
    // belonged to the one currently held. Queried against the live store on
    // 2026-08-02: 82 timers created in this project's entire history, 0
    // repeating (repeat_every_ms IS NOT NULL), 0 that have fired more than
    // once (fire_count > 1). The repeating claim this defect depends on has
    // never run, so the hold-then-re-fire sequence it describes has never
    // been reachable. Not an argument the code is fine - an argument that
    // fixing it buys nothing today against a lane in the most contended loop
    // in the codebase, next to holdTimer()'s already-flagged SQLITE_BUSY
    // contention. Reopen if this project ever creates its first repeating
    // wake; the query above is the trigger, not a judgement call.
    //
    // Counselors round 1 (todo 209, item D1) extended this same acceptance to
    // typed_busy (#75), added to this claim's reset list below alongside
    // typed_at/confirmed_at/held_at/held_reason: it is reset by the exact
    // same claim, so it is held-stale by the exact same window, for the exact
    // same reason, covered by the exact same evidence above. No separate
    // acceptance needed; this is the same window, one more column wide.
    // Counselors round on #101, P1. This claim's own WHERE now guards every
    // field wake_update can touch, not just due_at - see claimOneShot's
    // comment below for why one column was not enough, including the
    // stale-branch scenario specific to this repeating path: a repeat-only
    // wake_update on an already-repeating wake changes repeat_every_ms
    // without touching due_at, and `seconds` above is computed from the
    // STALE in-memory value the moment this branch was chosen - guarding
    // repeat_every_ms here means that stale `seconds` can never be
    // committed; a concurrent change makes this claim a no-op, and the next
    // tick recomputes `seconds` from the row it reads fresh.
    claimed =
      stmt(
        `UPDATE timers SET due_at = datetime('now', printf('+%d seconds', ?)),
           fired_at = datetime('now'), fire_count = fire_count + 1,
           typed_at = NULL, confirmed_at = NULL, held_at = NULL, held_reason = NULL, typed_busy = NULL
         WHERE id = ? AND due_at IS ? AND body IS ? AND repeat_every_ms IS ? AND cancelled_at IS NULL`,
      ).run(seconds, timer.id, timer.due_at, timer.body, timer.repeat_every_ms).changes === 1;
  } else {
    claimed = claimOneShot(timer);
  }
  if (claimed) await deliver(timer, "", choices);
}

// Issue #96. wake_update is the first tool that can change a PENDING timer's
// due_at, body, or repeat_every_ms out from under a tick that already read
// this same row into its in-memory TimerRow at the candidates SELECT
// (tick(), above) - the exact staleness window the repeating claim above and
// holdTimer()'s own write already guard against.
//
// Counselors round on #101, P1. The CI review gate on this PR's first
// version of this fix caught the missing due_at guard; a follow-up
// counselors round on the FIX ITSELF found due_at alone was not enough. A
// wake_update that changes body or repeat_every_seconds WITHOUT touching
// due_at left a due_at-only guard satisfied while delivering the stale
// in-memory body - the identical bug, reached through a sibling field. Worse:
// fireDelay's own branch above (`timer.repeat_every_ms != null`) is decided
// from this SAME stale in-memory read, BEFORE either claim runs. A
// repeat-only wake_update landing on a due one-shot mid-tick left the branch
// decision stale too: the row took the ONE-SHOT branch below, claimOneShot
// set fired_at but left the now-overdue due_at untouched (only the repeating
// claim advances due_at), and the row's repeat_every_ms was already non-null
// by the time the NEXT tick ran its candidates query - `due_at <= now AND
// (fired_at IS NULL OR repeat_every_ms IS NOT NULL)` matched again
// immediately, firing the same wake a second time.
//
// The fix is the same shape scaled up: the claim's WHERE now checks every
// field wake_update can change (due_at, body, repeat_every_ms) against
// exactly what THIS tick read, not just one of them. A concurrent edit to
// ANY of them invalidates the claim - it does not matter which branch was
// chosen from the stale data, because a stale branch's own claim now fails
// too. `IS` rather than `=` throughout: idle_any/idle_all timers always have
// a NULL due_at (wake_when_idle never sets it) and a one-shot wake always has
// a NULL repeat_every_ms - `=` against a NULL parameter is never true in
// SQLite, so it would silently break every claim on an unedited row of
// either shape. `IS` compares NULL-to-NULL correctly while behaving
// identically to `=` for every non-null value. body is NOT NULL by schema,
// so `IS`/`=` are equivalent there, but `IS` throughout means one rule to
// state rather than two.
//
// A failed claim here behaves exactly like a claim another concurrent
// instance already won: this timer simply is not returned as claimed, tick()
// moves on to the next candidate, and the row - now carrying wake_update's
// new values - is picked up fresh on a later tick. Nothing here throws;
// CLAUDE.md's "the scheduler must never throw" holds.
function claimOneShot(timer: TimerRow): boolean {
  return (
    stmt(
      `UPDATE timers SET fired_at = datetime('now'), fire_count = fire_count + 1
       WHERE id = ? AND due_at IS ? AND body IS ? AND repeat_every_ms IS ?
         AND fired_at IS NULL AND cancelled_at IS NULL`,
    ).run(timer.id, timer.due_at, timer.body, timer.repeat_every_ms).changes === 1
  );
}

// A watched agent that is not there any more. Nothing left to wait for, so the
// two ways of reaching it share one value.
const GONE: WatchedState = { idle: true, gone: true, since: null };

// Not yet a fact this process can act on: a foreign socket (issue #73) and a
// row that has not settled yet (below) are different reasons for the same
// answer, so both share it rather than each spelling out the identical
// literal.
const UNKNOWN: WatchedState = { idle: false, gone: false, since: null };

function watchedStates(timer: TimerRow, snapshot: AliveSnapshot): WatchedState[] {
  const ids = JSON.parse(timer.watch) as number[];
  return ids.map((id) => {
    const agent = stmt(
      `SELECT *, created_at < datetime('now', ?) AS settled FROM agents WHERE id = ?`,
    ).get(SETTLE_WINDOW, id) as
      | {
          status: string;
          tmux_target: string;
          tmux_socket: string;
          agent_state: string;
          state_changed_at: string | null;
          settled: number;
        }
      | undefined;
    if (!agent || agent.status !== "running") return GONE;
    const alive = rowAlive(agent.tmux_socket, agent.tmux_target, snapshot);
    // Issue #73, D2/D4/D6: unknown (a foreign socket) is reported as UNKNOWN,
    // never folded into GONE. Collapsing it there would let a watched agent
    // this process cannot honestly judge fire an idle_any wake (via its own
    // `gone` disjunct) or silently drop out of an idle_all wait, exactly the
    // damage this lane exists to prevent, just reached through the idle-wake
    // door instead of the janitor's.
    if (alive === null) return UNKNOWN;
    if (!alive) {
      // The same spawn race the janitor guards against: a row inserted before
      // its window exists is not gone, it is not born yet. Without this an
      // idle_any wake set during another session's spawn fires immediately.
      if (!agent.settled) return UNKNOWN;
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
  if (ready && deliverable(timer, snapshot, choices) && claimOneShot(timer)) {
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
// Counselors round 1, both seats: the first version of this function reported
// ONLY describeLastLogEvent()'s fact and that hid the exact stall it was
// built to show. describeLastLogEvent() (stateProvenance.ts) answers "what did
// the log most recently record", and a Notification hive reads as
// idle_prompt writes a FRESH row with the literal state 'unchanged'
// (src/hook.ts's stateForNotification) - the latch itself never moves. Issue
// #38's own incident is exactly that shape: 75|prompt|working at 04:40:53,
// then 78|notify|unchanged at 05:17:50, 37 minutes later. Reporting only the
// last log event renders that as "last log event: notify (0s ago)", which
// reads as fresh and gives no hint the latch has not moved in 37 minutes.
//
// So this reports TWO facts, not one, neither inferring anything from the
// other:
//   - How long the CURRENT state has held, from agents.state_changed_at, the
//     authoritative latch (ageSecondsSince/humanizeAge, stateProvenance.ts -
//     the same source deriveProvenance() uses for age, reused directly here
//     rather than through that function, since its own `event` field
//     deliberately skips 'unchanged' rows and this needs the opposite). Only
//     while status='running' (round 2, both seats, P2): agent_close never
//     touches state_changed_at (hook.ts:285 is the only writer), so a closed
//     row's latch is frozen at whatever it read on its way out, and "now
//     minus that" ages a state nothing is observing any more - a worker that
//     entered 'working' at 12:00 and closed at 12:01 would otherwise report
//     "working for 1h" at 13:00. deriveProvenance refuses this exact
//     attribution (alive === false -> age_seconds: null,
//     src/stateProvenance.ts) and this matches it, gated on the row's own
//     status rather than a probed liveness, since watchedTail already reads
//     status straight off this same row.
//   - The log's own last row regardless of whether it moved the latch
//     (lastLogEvent(), #72), which says the session is still ALIVE and
//     emitting hooks even when the latch has not moved.
//
// WHAT THE PAIR ACTUALLY SEPARATES, AND WHAT IT DOES NOT. Round 2, both
// seats independently: the previous version of this comment stated a general
// rule ("divergence means stall, convergence means healthy") and both seats
// found a real worker it misclassifies. The pair reliably flags a stall ONLY
// when something has logged an event AFTER the state being reported - a
// fresh notify (or any other event) sitting on an old latch, #38's own
// shape. It does NOT separate:
//   - A worker genuinely, continuously busy for 40 minutes with no event
//     logged since, from a #38 worker whose turn died 40 minutes ago and has
//     logged nothing since either: both render byte-identical ("working for
//     40m, last log event: prompt (40m ago)"), because nothing here observes
//     the difference between "still running" and "stopped and nothing has
//     looked since". The PANE TAIL this clause sits beside in watchedTail's
//     output is the discriminator for that case, not this line.
//   - A 'waiting' worker whose permission prompt was already answered.
//     'waiting' is LATCHED and nothing clears it until the worker's turn
//     ends (worker-state.md), so a worker approved at 12:01 and busy running
//     the approved tool for 30 minutes still reads "waiting for 30m, last
//     log event: notify (30m ago)" - an actively working session presented
//     as blocked. Not a new residual: worker-state.md already documents
//     'waiting' as latched for every other reader of agent_state; this
//     clause inherits that property rather than introducing it.
// REPORT, DO NOT INFER still stands: this function states both facts and
// leaves the reader to judge; it does not itself decide "stalled" from
// either one.
//
// Gated on reportsAgentStateLog, the same gate every other reader of this log
// uses (stateProvenance.ts): plain agent_state for a row that never writes
// this log at all (a lead, a kind='command' process, a non-instrumented
// worker), never describeLastLogEvent's own "no record", because that string
// means an instrumented worker whose log row retention already evicted - a
// different fact from "this row was never in scope". describeLastLogEvent()
// itself now sanitizes and caps the event field before formatting it
// (sanitizeEventForDisplay, src/tmux.ts): it is process.argv[2] verbatim
// (src/hook.ts) and this function's result is typed into the lead's pane.
//
// TWO SEPARATE try/catches below, not one, so a failure in either clause
// costs only itself, never the other - matching this file's own contract
// that a lookup failure here costs its own clause, never the wake. Round 2
// (opus): the latch-age read used to sit OUTSIDE any try at all, so an
// exception there would escape this function entirely, be swallowed by
// watchedTail's outer catch, and drop the ENTIRE "what hive sees" block for
// every watched agent - exactly the failure mode deliver()'s own reliance on
// "a failure here costs its own clause" assumes cannot happen. Neither
// ageSecondsSince nor humanizeAge actually throws on a bad string (they
// return NaN), so Number.isFinite is the real guard against silently
// rendering "for NaNh"; the try is defence in depth for this read, matching
// every other read in this function.
function stateNowClause(agent: {
  agent_state: string;
  state_changed_at: string | null;
  status: string;
  actor_id: string;
  command: string;
  kind: string;
}): string {
  if (!reportsAgentStateLog(agent)) return agent.agent_state;

  let latchAge = "";
  try {
    if (agent.status === "running") {
      if (agent.state_changed_at) {
        const seconds = ageSecondsSince(agent.state_changed_at);
        // Round 2 (opus): a null latch used to drop this clause silently,
        // indistinguishable from "nothing to say" - exactly the broken-
        // instrumentation case (agent_state defaults to 'unknown',
        // state_changed_at has no default) where a lead most needs the
        // line to say something.
        latchAge = Number.isFinite(seconds) ? ` for ${humanizeAge(seconds)}` : " (latch age: unavailable)";
      } else {
        latchAge = " (latch age: no record)";
      }
    }
  } catch {
    latchAge = " (latch age: unavailable)";
  }

  let lastEvent = "";
  try {
    lastEvent = `, last log event: ${describeLastLogEvent(lastLogEvent(agent.actor_id))}`;
  } catch {
    // Individually optional, matching this function's own callers: a lookup
    // failure here costs its own clause, never the wake.
  }
  return `${agent.agent_state}${latchAge}${lastEvent}`;
}

function watchedTail(timer: TimerRow): string {
  try {
    const ids = JSON.parse(timer.watch) as number[];
    if (ids.length === 0) return "";
    const shown: string[] = [];
    for (const id of ids.slice(0, TAIL_AGENTS)) {
      const agent = stmt(
        "SELECT name, tmux_target, tmux_socket, agent_state, state_changed_at, status, actor_id, command, kind FROM agents WHERE id = ?",
      ).get(id) as
        | {
            name: string;
            tmux_target: string;
            tmux_socket: string;
            agent_state: string;
            state_changed_at: string | null;
            status: string;
            actor_id: string;
            command: string;
            kind: string;
          }
        | undefined;
      if (!agent) continue;
      // Counselors round 1, item 7. A wake firing BECAUSE a watched worker
      // went away is exactly a wake where "what was it doing" matters most,
      // so this carries the same fact every other branch below does rather
      // than narrowing the file's own "one added fact per watched agent"
      // claim to exclude it - closing a row does not erase its log history,
      // and the row read above already has everything stateNowClause needs.
      if (agent.status !== "running") {
        shown.push(`${agent.name} (hive state now: ${stateNowClause(agent)}): closed, so there is no terminal left to read.`);
        continue;
      }
      // Issue #73 counselors F2. This used to capturePane() any running row
      // with no socket check at all, so a foreign-socket watched agent (D6) -
      // one whose pane lives on a server this process cannot see into - had
      // its OWN tmux_target probed against THIS process's server instead.
      // Any pane genuinely alive here under that id gets captured and typed
      // into the wake this function builds, embedded as if it were that
      // agent's real screen: a stranger's terminal, mislabelled, delivered
      // into the lead's own pane next. foreignSocket() must gate the capture
      // the same way rowLive/rowAlive gate every other reader of this fact.
      if (foreignSocket(agent.tmux_socket)) {
        shown.push(
          `${agent.name} (hive state now: ${stateNowClause(agent)}): its terminal lives on a different tmux ` +
            "socket than this process, so it cannot honestly be read from here.",
        );
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
      const stateNow = stateNowClause(agent);
      shown.push(
        tail
          ? `${agent.name} (hive state now: ${stateNow}), last lines of its terminal:\n${tail}`
          : `${agent.name} (hive state now: ${stateNow}): its terminal could not be read.`,
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
  // Issue #75. typed_busy is an OBSERVATION, not a prediction: the target's
  // own last agent_state_log row, read right before typing. It records what
  // hive saw at the moment it typed - nothing about what happens afterward.
  //
  // Counselors round 1 (todo 209, item B) corrected the first version of
  // this comment, and the matching ones in src/db.ts's migration and
  // src/tools/wakes.ts's deliveryState(), all of which asserted that a busy
  // delivery "can never confirm" / "structurally" / "no acknowledgement was
  // ever possible". The code cannot see that; it saw one log row.
  // Everything after typing is a prediction, and four independent findings
  // showed the prediction unsafe in both directions - so state only the
  // observation and let a reader judge:
  //   - .claude/rules/tmux-and-panes.md:49-57 and this project's board
  //     disagree about whether a queued paste eventually confirms once the
  //     target's turn ends. Round 2 (opus): the citation used to point at
  //     line 43, the unrelated `display-message` paragraph, and the
  //     characterisation was stale - the rule file no longer claims
  //     verification on the confirms side of this; it now records a measured
  //     finding (wake 109, claude 2.1.220, tmux-and-panes.md:51) that a busy
  //     paste enters the running turn as an attachment and fires no
  //     UserPromptSubmit, and says plainly (tmux-and-panes.md:57) that its
  //     own earlier "verified twice against the transcript" claim was wrong.
  //     The board's claim is the one still standing unretracted, so this is
  //     no longer symmetric doubt - it is one measured account against one
  //     unretracted claim, and BOTH still rest on their own single
  //     observation. That conflict is recorded on the board, not settled
  //     here, and does not need to be: this value means the same thing under
  //     either reading, because it only describes what hive typed INTO,
  //     never what happens next. If a genuine prompt row does arrive later,
  //     confirmed_at is set exactly as it is for any other wake
  //     (checkConfirmations, above) and unconfirmed_busy is never reached -
  //     deliveryState() (wakes.ts) checks confirmed_at first.
  //   - A target latched into a stuck 'working' (issue #38: a turn that died
  //     mid-response and never recovers, or a dropped API response leaving a
  //     stale prompt|working row) reports unconfirmed_busy, the QUIET value,
  //     for what is actually the real alarm: a target that is not coming
  //     back, not one genuinely mid-turn. Item C1 (below) puts 'waiting' in
  //     this same busy bucket, so a permanently stuck 'waiting' (issue #28: a
  //     worker blocked on a permission prompt nobody ever answers - "'waiting'
  //     is LATCHED... nothing clears it") is the identical shape, not a
  //     separate residual. NAMED RESIDUAL, not fixed here: issue #72 (merged
  //     f1b805b, shortly before this lane) is the compensating control -
  //     last_log_event plus its age is surfaced in agent_list, `hive status`
  //     and `hive doctor`, so a stale 'working' or 'waiting' row is visible
  //     through a channel built to show staleness, even though typed_busy
  //     deliberately does not try (see stateProvenance.ts's own docstring on
  //     why a freshness bound does not belong here either). Reopen if
  //     unconfirmed_busy is ever the ONLY place a stuck target would have
  //     been visible - i.e. if #72's channel stops covering it.
  //   - The sample is taken before sendText, so the target can transition
  //     either way in the gap between this read and the paste landing.
  // typed_busy still does its one job under all of this: separating "typed
  // at a target whose last recorded state was mid-turn" from "typed at a
  // target whose last recorded state was not" - a fact hive can see - from a
  // claim about acknowledgement, which hive cannot make.
  //
  // 1/0/null, not a boolean: null means hive has no hook row for this actor
  // at all (never instrumented, e.g. a plain `user:` target with no agents
  // row, or an instrumented one that simply has not written its first row
  // yet) and must read as unknown, never coerced to "not busy" - that
  // coercion is exactly the inference .claude/rules/worker-state.md rules
  // out ("a debounce that waits and reports what it observed asserts
  // nothing... one that asserts a fact it cannot see is not legitimate").
  //
  // lastLogEvent (the LOG), deliberately, not agents.agent_state (the
  // LATCH) - despite stateProvenance.ts's own docstring ranking the latch
  // authoritative and the log forensics. That ranking holds for a worker,
  // but issue #75's own motivating case (wake 107) is a wake to the LEAD,
  // and src/hook.ts's agent_state UPDATE is scoped to `kind = 'agent'`: a
  // lead's latch stays 'unknown' forever by design (worker-state.md). Reading
  // the latch here would read every lead-targeted wake as never-busy,
  // silently no-oping this fix for the exact target the issue was filed
  // against. The log is the only channel a lead writes to at all.
  //
  // Counselors round 1, item C1: 'working' OR 'waiting' both count as busy.
  // The first version of this line read only literal 'working', arguing that
  // a blocking dialog is caught earlier and separately by deliverable()'s
  // own awaitingChoice() hold above. That argument covers the pane WHILE a
  // dialog is up; it says nothing about after. worker-state.md is explicit
  // that 'waiting' is LATCHED and nothing clears it until the worker's turn
  // ends - "however long the approved tool runs". So: a worker approves a
  // permission prompt, the dialog clears, and the worker stays mid-turn for
  // the whole length of whatever it just approved - a long test run, a build
  // - with its last log row still notify|waiting the entire time. That is
  // the single longest, most common busy window a worker has, and exactly
  // when a lead is likely to set a wake. Reading it as not-busy reported the
  // real alarm's opposite: a target unambiguously mid-turn as plain
  // "unconfirmed", byte-identical to a lost wake. Only a literal 'idle' row,
  // or the notify sentinel 'unchanged' (src/hook.ts's UNCHANGED, written
  // when a notification left the latch alone - the idle_prompt case, Claude
  // signalling it is genuinely free), now read as not-busy.
  //
  // Counselors round 1, item C2 - a STATED LIMIT, not a fix. Under a /goal,
  // Claude Code fires Stop after every turn while immediately starting
  // another, so a lead's log alternates stop|idle / prompt|working
  // continuously - worker-state.md measured nine consecutive false idles in
  // fifty seconds. A wake landing in one of those idle gaps reads
  // typed_busy=0 for a lead that is, in every practical sense, busy. NOT
  // fixable at this read site: stateProvenance.ts's own docstring names the
  // identical trap for a different reader and says the module "cannot detect
  // that condition... and must not pretend to" - adding a freshness bound or
  // an age threshold here to compensate would be exactly the inference that
  // docstring forbids, and stays out of scope for this lane for the same
  // reason. This bounds the fix for its own motivating case (a lead) without
  // claiming to close it.
  //
  // A THROW HERE MUST NOT COST THE DELIVERY (counselors round 1, item A,
  // both seats, the lane's only real bug). This read used to run unguarded
  // between the claim (fireDelay/claimOneShot, above) and sendText (below);
  // every other read or write in this function is guarded on exactly that
  // ground - watchedTail carries its own try/catch, the post-send write uses
  // bestEffortRun - because by this line the claim has already committed
  // fired_at: the timer is already spent. An unguarded throw here (SQLITE_
  // IOERR, SQLITE_BUSY, a schema broken under a running server, a store
  // replaced mid-tick) would reject deliver() before sendText ever ran,
  // which tick()'s own catch (far above) keeps the SERVER alive through but
  // does nothing for THIS delivery: a one-shot permanently reporting
  // fired_at set and typed_at forever NULL, never retried, plus every
  // candidate after it in this tick skipped. Fall back to null (unknown) on
  // any failure here - the same answer a genuinely absent hook row gets -
  // and let sendText run regardless. Pinned by
  // test/delivery-state.test.mjs's "does not turn a held timer into a
  // crash..." fixture, which now also drops agent_state_log itself.
  let typedBusy: number | null;
  try {
    const lastEvent = lastLogEvent(timer.deliver_actor);
    typedBusy = lastEvent == null ? null : lastEvent.state === "working" || lastEvent.state === "waiting" ? 1 : 0;
  } catch {
    typedBusy = null;
  }
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
  // typed_busy follows the identical cycle discipline, set here and reset to
  // NULL by the same due_at claim UPDATE above, for the same reason: it
  // describes THIS delivery's moment of typing, and a repeating timer must
  // not carry cycle N's busy observation into cycle N+1's report.
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
    `UPDATE timers SET typed_at = strftime('%Y-%m-%d %H:%M:%f', 'now'), typed_busy = ?,
       held_at = NULL, held_reason = NULL, confirmed_at = NULL WHERE id = ?`,
    typedBusy,
    timer.id,
  );
}
