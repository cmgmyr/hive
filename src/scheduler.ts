import type { Statement } from "better-sqlite3";
import { existsSync, mkdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { dataDir, db, storeReplaced } from "./db.js";
import { maybeBackupHourly } from "./backup.js";
import { renderDashboardForWrite } from "./dashboard.js";
import { loadProjectYml } from "./projectYml.js";
import { listProjects } from "./context.js";
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
  holdsHumanInput,
  inputBoxState,
  liveTargets,
  maskChoiceMarker,
  paneAwaitingChoice,
  paneReissued,
  rowAlive,
  rowAliveProbe,
  rowLive,
  rowLiveProbe,
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
  // Todo 336. Joined from agents.pane_pid via deliver_actor, the same shape
  // as deliver_socket immediately above and for the same reason: a pane id
  // only means something relative to the tmux GENERATION that issued it, and
  // nothing on a timer row said which generation until this join. '' means
  // "no fact recorded" (a pre-migration row, or a deliver_actor with no
  // agents row at all) and must never read as a mismatch - see
  // deliverable()'s own use of it. Coalesced to '' in SQL for the identical
  // join-miss reason deliver_socket already is.
  deliver_pane_pid: string;
  // Todo 315. NULL for every wake but a standing watch; see src/db.ts's own
  // migration for why this is a flag on an idle_any row rather than a kind.
  watch_scope: string | null;
  // Todo 315. Set on a FINISH notice a standing watch filed, NULL on
  // everything else - todo 314's own notices, and (todo 321) a standing
  // watch's BLOCK notices, which are filed with no parent while todo 322
  // decides whether they should have one. So a null here does not mean "not
  // from a standing watch"; it means "not covered by the parent link", which
  // is what noticeStillDeliverable and wake_cancel's cascade both key on.
  parent_timer_id: number | null;
}

// Todo 315. The one value watch_scope takes today. Membership is a PARAMETER
// - project, group or list (.claude/sessions/decisions/2026-08-08-watch-
// membership-is-a-parameter.md) - and only the crew ships, so the membership
// query below has no branch in it. Groups are blocked on agent labels, which
// do not exist; list scope is what a one-shot already does.
export const WATCH_SCOPE_PROJECT = "project";

const isStandingWatch = (timer: TimerRow): boolean => timer.watch_scope === WATCH_SCOPE_PROJECT;

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
    `SELECT id, tmux_target, tmux_socket, pane_pid FROM agents WHERE status = 'running' AND kind != ? AND tmux_target != ''
     AND created_at < datetime('now', ?)`,
  ).all(LEAD_KIND, SETTLE_WINDOW) as {
    id: number;
    tmux_target: string;
    tmux_socket: string;
    pane_pid: string;
  }[];
  for (const agent of agents) {
    // Issue #73, D2/D4/D6: a foreign socket reads unknown (null), never dead,
    // so this loop must sweep only an explicit `false` - the same trap the
    // old `!targetAlive(...)` truthiness check would otherwise fall into the
    // moment rowAlive starts answering null for a row this process cannot
    // honestly judge.
    //
    // Issue #149 (todo 348). rowAliveProbe rather than plain rowAlive: a
    // reissued pane reads `live: true` (see paneReissued's own comment,
    // src/tmux.ts), so a row whose recorded pane_pid no longer matches the
    // live pane at that target is reaped here too, not only a row whose pane
    // is dead outright. Without this half, a reissued worker row kept
    // reporting "running" to agent_list, let agent_send's requireLive type
    // into a stranger's pane, and let watchedTail capture-pane a stranger's
    // screen into a wake body - all true even once deliverable() (below)
    // holds the delivery itself.
    const probe = rowAliveProbe(agent.tmux_socket, agent.tmux_target, snapshot);
    if (probe.live === false || paneReissued(agent.pane_pid, probe)) {
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
  // Issue #149 (todo 348). Deliberately NOT widened with paneReissued the way
  // the agents sweep above was. A reissued pane is not gone - deliverable()
  // (below) now holds a timer in that state for every actor, lead or not,
  // rather than cancelling it, specifically because a hold is recoverable
  // and visible in wake_list while a cancel silently destroys a wake a human
  // asked for. Cancelling it HERE, before it is even due, would reach the
  // identical outcome the hold decision was chosen to avoid, by a route that
  // never lets deliverable() make the call. The dead-pane cancellation this
  // sweep already performs is for a genuinely different condition - a pane
  // that reads unambiguously gone - and stays, with one exemption directly
  // below.
  //
  // Fix round 1, finding 1 (counselors). That dead-pane cancellation used to
  // be unconditional, and it reaches a timer this SAME sweep held for
  // pane-reissue on an earlier tick just as easily as it reaches an ordinary
  // one: the pane the wake was reissued to is its own process, and nothing
  // stops IT from exiting too, often within minutes for a transient shell.
  // When that happens the hold above becomes a cancel one tick later,
  // through this exact branch - the silent-disappearance outcome the hold
  // decision was chosen to avoid, reached by a different door. held_reason
  // is the durable signal that tells the two conditions apart: a timer whose
  // last hold names the reissue condition (wasHeldForPaneReissue) is not
  // "back to ordinary dead", it is the same incident continuing, so it stays
  // held - now with an updated reason naming both facts - rather than being
  // cancelled with no trace.
  const timers = stmt(
    `SELECT timers.id, timers.due_at, timers.held_reason, timers.deliver_pane,
            COALESCE(agents.tmux_socket, '') AS deliver_socket
       FROM timers ${DELIVER_SOCKET_JOIN}
      WHERE ${ACTIVE_TIMER_WHERE} AND timers.deliver_actor NOT LIKE ?
        AND timers.created_at < datetime('now', ?)`,
  ).all(`${LEAD_ACTOR_PREFIX}%`, SETTLE_WINDOW) as {
    id: number;
    due_at: string | null;
    held_reason: string | null;
    deliver_pane: string;
    deliver_socket: string;
  }[];
  for (const timer of timers) {
    if (rowAlive(timer.deliver_socket, timer.deliver_pane, snapshot) === false) {
      if (wasHeldForPaneReissue(timer.held_reason)) {
        holdTimer(timer, HELD_REASON_PANE_REISSUED_THEN_DEAD);
      } else {
        cancelTimer(timer.id);
        cancelledTimers += 1;
      }
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
    // Todo 314. wake_block_notices grows by one row per (wake, blocked
    // agent, block episode) and nothing else ever deletes from it - timers
    // rows are never deleted in src/, so its ON DELETE CASCADE is hygiene
    // rather than a live path. LOG_RETENTION, the same window as the rows
    // above, because the two answer the same kind of question about the same
    // window of work and a second retention constant is a second thing to
    // reason about. The one behaviour this buys, stated so it reads as a
    // choice: a worker blocked continuously for longer than the retention
    // window has its key pruned and its owner told a second time, which is
    // the right direction for a notice nobody acted on in seven days. So
    // "one notice per real block" has one stated exception - a block that
    // outlives the retention window is reported again, once per window.
    //
    // READ BEFORE WRITE, the rule this function states forty lines above and
    // that this DELETE broke on its first version (counselors round 2, both
    // seats). A DELETE matching nothing still opens a write transaction and
    // takes SQLite's single machine-wide writer slot, and this table is
    // empty on nearly every machine while every session's scheduler runs
    // this every three seconds. notified_at is not indexed either (the PK is
    // the episode key), so the matching case is a scan - which is fine once
    // a week and not fine as an unconditional per-tick write.
    const staleNotices = stmt(
      "SELECT 1 AS hit FROM wake_block_notices WHERE notified_at < datetime('now', ?) LIMIT 1",
    ).get(LOG_RETENTION);
    if (staleNotices) {
      stmt("DELETE FROM wake_block_notices WHERE notified_at < datetime('now', ?)").run(LOG_RETENTION);
    }
    // Todo 315. wake_idle_notices grows by one row per (standing watch, crew
    // member, condition, episode) and nothing else deletes from it. Same
    // window and same read-before-write discipline as the table above, for
    // the same reasons - and with the same one stated consequence: a finish
    // whose cursor row is pruned can be reported a second time. That needs a
    // watch to outlive the retention window, which a lifetime measured in
    // hours does not, so it is a bound rather than a behaviour anyone will
    // meet.
    const staleIdleNotices = stmt(
      "SELECT 1 AS hit FROM wake_idle_notices WHERE notified_at < datetime('now', ?) LIMIT 1",
    ).get(LOG_RETENTION);
    if (staleIdleNotices) {
      stmt("DELETE FROM wake_idle_notices WHERE notified_at < datetime('now', ?)").run(LOG_RETENTION);
    }
  } catch {
    // Housekeeping. It must never take a tick down, and a store that has not
    // run this migration yet is one of the ways it can throw.
  }
}

// Todo 309, step 2 of the dashboard lane. Writes src/dashboard.ts's
// renderDashboard() output to <project root>/.claude/dashboard/index.html
// for every project that has opted in, on the same "must never throw" terms
// as maybeBackupHourly above: file IO is a new throw surface in a function
// that had none before this lane, so every failure mode below is caught at
// the narrowest point that can catch it, never allowed to reach tick()'s own
// try/catch as the thing that actually protects the interval.
//
// THE ENABLE GATE IS hive.yml's `dashboard` KEY, not a directory's presence.
// Chris's own call, superseding plan-dashboard-v1's original decision 3 (a
// directory switch) after the pad was already written - the pad has since
// been corrected and this comment states the current design, not the
// abandoned one. src/projectYml.ts resolves absent, null, and false all to
// the same `false`, so this is a plain truthy check with no null-handling
// of its own to get wrong. Because the KEY is now the switch, this function
// CREATES the directory (recursive mkdir) the first time it finds the key
// true and the directory missing - the opposite of the old directory-switch
// design, where creating it was forbidden. Absence now means "first run",
// never "not enabled".
const DASHBOARD_MIN_INTERVAL_SECONDS = 5;

// Counselors (brief-dashboard-successor, item A). Every tick's loop below
// calls loadProjectYml - a real readFileSync - for every registered project,
// dashboard-enabled or not, synchronously on the scheduler's own interval
// callback. A registered project on a stalled network mount blocks that
// callback for as long as the mount is stuck, and unref() does not help
// while a callback is already executing: it only lets the PROCESS exit early,
// not the callback return early. ACCEPTED, not fixed: every project this
// tool runs against today is local, and a stalled mount already breaks the
// store, the worktrees and the tmux paths (untrusted-server checks, pane
// probes) long before it would reach this read. Building async IO into the
// scheduler for a residual with no known instance is not worth the
// complexity. Honest addendum: the gate-before-claim ordering below widens
// this slightly versus claiming first - claim-first would rate-limit
// loadProjectYml to roughly once per DASHBOARD_MIN_INTERVAL_SECONDS per
// project (only after a successful claim), where gate-first pays it on every
// ~3s tick, for every project, forever. That trade was made deliberately,
// for the reason spelled out at the gate's own call site below: the
// alternative cost (a permanent periodic WAL write for a project that will
// never render) was judged worse than a slightly wider window on a residual
// that requires a stalled local filesystem to matter at all.

// Atomic conditional UPDATE, the same shape maybeBackupHourly (src/backup.ts)
// already uses for its own hourly claim and timers already use for wake
// claims (claimOneShot, above) - only the instance whose UPDATE actually
// changes a row proceeds, so N concurrent server instances ticking the same
// store never all regenerate the same project's file in the same window.
// Five seconds, not backup's hour: this is rate-limiting a cheap, harmless
// disk write, not a whole-store copy, and the page's own 10s meta-refresh
// only ever asks for one write for every two of its own reloads at most.
//
// Counselors (brief-dashboard-successor, item B). This is a RATE LIMIT, not
// mutual exclusion: a process paused past DASHBOARD_MIN_INTERVAL_SECONDS
// after winning this claim lets another instance win the next claim and
// regenerate concurrently, and if a store change lands in between, the
// second (newer) write can land before the first (older, stalled) one
// finishes and then be overwritten by it. TRUE, and accepted rather than
// fixed: with the content-hash dirty check below (dashboardMark's
// successor), the NEXT tick after either write sees a hash mismatch against
// what is actually on disk versus what the store now says, and re-renders -
// so the artefact self-corrects within one more claim window, and the page
// is a read-only view that is at worst a few seconds stale, never wrong in a
// way nothing fixes. This self-correction is the reason the residual is
// acceptable, and it only holds once the dirty check is a real hash of what
// was rendered rather than a hand-maintained shadow of it (see
// renderDashboardForWrite's own comment in src/dashboard.ts).
function claimDashboardAttempt(projectId: number): boolean {
  bestEffortRun("INSERT OR IGNORE INTO dashboard_meta (project_id) VALUES (?)", projectId);
  return (
    stmt(
      `UPDATE dashboard_meta SET last_attempt_at = datetime('now')
       WHERE project_id = ? AND (last_attempt_at IS NULL
         OR last_attempt_at <= datetime('now', '-${DASHBOARD_MIN_INTERVAL_SECONDS} seconds'))`,
    ).run(projectId).changes === 1
  );
}

// Write a temp file in the SAME directory as the target, then rename over
// it. Meta refresh (src/dashboard.ts's own <meta http-equiv="refresh">) reads
// this file at arbitrary times with no coordination with hive at all, and a
// rename is the one write mode POSIX guarantees a concurrent reader can never
// observe as partial - a reader either sees the old complete file or the new
// complete one, never a half-written one. Same directory is required for the
// rename to be atomic in the first place: renaming across a filesystem
// boundary silently degrades to copy-then-delete on some platforms, which
// reopens exactly the half-written window this exists to close.
//
// A failed write or rename must not leave the temp file sitting in the
// dashboard directory for the next attempt to trip over, or for a human
// browsing the folder to wonder about. The unlink is itself best-effort and
// swallowed: a cleanup failure must never hide the original error, which is
// what the caller actually needs to see.
function writeDashboardAtomically(dashboardDir: string, html: string): void {
  const target = join(dashboardDir, "index.html");
  const temp = join(dashboardDir, `.index.html.tmp-${process.pid}`);
  try {
    writeFileSync(temp, html);
    renameSync(temp, target);
  } catch (e) {
    try {
      unlinkSync(temp);
    } catch {
      // Best effort; the original error below is what matters.
    }
    throw e;
  }
}

// Counselors P1 (both seats, brief-dashboard-successor item 1). A repo can
// commit `dashboard: true` in hive.yml plus `.claude/dashboard` as a SYMLINK
// pointing outside the project - `.claude/` is only gitignored by pattern
// (.gitignore:10), which does not stop an already-tracked or force-added
// path from being committed. mkdirSync/writeFileSync/renameSync all follow a
// directory symlink with no containment check of their own, so a cloned repo
// could redirect hive's write to an arbitrary path outside the project.
//
// The precedent for this check already exists in this file's neighbour
// rather than being invented here: src/projectYml.ts's resolveCommandDir
// does `realpathSync(resolve(projectPath, dir))` then refuses unless the
// result equals projectPath or starts with `projectPath + sep`. CLAUDE.md
// states the same invariant for hive.yml's `dir`; this lane's directory
// simply never inherited it.
//
// UNLIKE resolveCommandDir, BOTH sides of the comparison are realpath'd
// here, not just the child. resolveCommandDir can assume its projectPath
// argument is already canonical; this function cannot make that same
// assumption project-wide, and measured directly on this machine: macOS
// resolves os.tmpdir() under `/var`, itself a symlink to `/private/var`, so
// a project whose registered path is the un-canonicalised `/var/...` spelling
// would realpath its OWN dashboard directory to `/private/var/...` and fail
// this comparison every time, even with no attacker involved at all - a
// false positive that would silently disable every such project's
// dashboard. Comparing two realpaths keeps this "canonicalise the
// COMPARISON" per the dead-end below, never "canonicalise a path a caller
// hands back": the value this function RETURNS is still the plain
// join()-built dashboardDir, untouched.
//
// MUST NOT CREATE ANYTHING BEFORE THE CHECK. realpathSync requires every
// path component to already exist, so a naive "mkdir then realpath" order
// would let a symlinked ANCESTOR (say `.claude` itself, committed as a
// symlink with no `dashboard` entry inside it yet) be silently walked INTO
// by mkdirSync's own recursive creation before this function ever gets a
// chance to refuse - the escape would happen at mkdir time, not write time.
// So this walks UP from the target to the nearest already-existing ancestor
// first, realpath-checks only that ancestor, and returns null (refuse, skip,
// never mkdir) before any directory this project does not already have gets
// created. Once an existing, safe ancestor is confirmed, every path
// component below it is guaranteed absent, so the caller's own
// `mkdirSync(dir, { recursive: true })` can only ever create plain
// directories under a location already proven to be inside the project
// root.
//
// See .claude/sessions/dead-ends/2026-07-29-canonicalising-resolvedatadir.md
// before touching this: canonicalise the COMPARISON only. The value this
// function returns is the plain `join()`-built path, never `realpathSync`'s
// output, so every consumer downstream (writeDashboardAtomically, the tests)
// keeps seeing the same spelling it always has.
function resolveDashboardDir(projectPath: string): string | null {
  const dashboardDir = join(projectPath, ".claude", "dashboard");
  let ancestor = dashboardDir;
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) break; // filesystem root; existsSync(projectPath) should stop this first
    ancestor = parent;
  }
  const resolvedAncestor = realpathSync(ancestor);
  const resolvedProjectPath = realpathSync(projectPath);
  if (resolvedAncestor !== resolvedProjectPath && !resolvedAncestor.startsWith(resolvedProjectPath + sep)) {
    return null;
  }
  return dashboardDir;
}

function maybeGenerateDashboard(project: { id: number; path: string }): void {
  try {
    // THE GATE MUST RUN BEFORE THE CLAIM. This was inverted once already by
    // an earlier /simplify pass, on the reasoning that claiming first saves
    // loadProjectYml's readFileSync+parse on ticks the claim would have
    // rejected anyway - true, but it measures the wrong side. Apply "when
    // does the optimisation pay": for an ENABLED project both orderings do
    // the same work, so the saving is real but small. For a DISABLED
    // project (dashboard: false, or no hive.yml at all - the common case
    // for most registered projects), claiming first replaces "one file
    // read, zero writes, zero rows" with "a dashboard_meta row plus a
    // successful UPDATE every DASHBOARD_MIN_INTERVAL_SECONDS, forever" -
    // a permanent periodic WRITE to the WAL store every hive session on
    // the machine shares, to accomplish nothing. It pays least where it is
    // safe and costs most where no work should happen at all - the exact
    // shape named in .claude/sessions/decisions/2026-08-05-simplify-can-
    // move-a-line-across-a-guard.md: "it paid nothing when it was safe and
    // paid only when it was risky." Pinned by test/dashboard.test.mjs's
    // "never claims ... for a project the gate has already rejected" -
    // confirmed to fail red under the inverted ordering before this
    // comment existed, not merely written to pass.
    //
    // ACCEPTED RESIDUAL: loadProjectYml (a real readFileSync + YAML parse)
    // runs on every ~3s scheduler tick, for every registered project, gate
    // or no gate. At the project counts this tool runs at (single digits)
    // that cost is nothing; if it ever matters, cache the parsed config
    // keyed by hive.yml's mtime rather than reordering past this gate
    // again. See this file's own comment above claimDashboardAttempt (item
    // A) for the honest cost of this ordering versus claim-first.
    if (!loadProjectYml(project.path).config?.dashboard) return;
    // Already safe on its own: loadProjectYml catches its own read and
    // parse failures internally and returns { config: null, warnings }
    // rather than throwing, the same way every other caller in src/ treats
    // it (src/tools/agents.ts, src/cli.ts) - never wrapped, always called
    // plain. A project with no hive.yml at all resolves config to null
    // here, and `config?.dashboard` reads that exactly like an absent key:
    // false.
    //
    // Path containment runs BEFORE mkdir and BEFORE the claim, same
    // reasoning as the gate above: a project whose directory escapes the
    // root must never get a dashboard_meta row or a periodic write either,
    // it must simply never be touched again until the symlink is gone. See
    // resolveDashboardDir's own comment for the full mechanism.
    const dashboardDir = resolveDashboardDir(project.path);
    if (dashboardDir === null) return;
    // mkdirSync is what makes the key the switch rather than the
    // directory: the first tick after `dashboard: true` lands creates the
    // directory that used to be the opt-in itself. recursive: true makes a
    // second call a no-op, so this costs nothing on every later tick.
    // Inside the try, same reasoning as the claim below - a permissions
    // error or a plain file already sitting at .claude/dashboard must cost
    // only this project, not the tick. Safe to create here: resolveDashboardDir
    // has already proven every path component between the nearest existing
    // ancestor and this target is absent, so recursive mkdir can only
    // create plain directories inside the project root.
    mkdirSync(dashboardDir, { recursive: true });
    // The claim runs AFTER the gate, for the reason spelled out above it.
    // It runs a real statement (stmt(...).run(...), not just
    // bestEffortRun's own already-guarded INSERT OR IGNORE above it), so
    // it can throw - a store that has not run this dist's migration yet is
    // one live way - and a throw from outside this try would escape to
    // maybeGenerateDashboards' loop-level catch, aborting every REMAINING
    // project's attempt for the rest of this tick over one project's
    // failure.
    if (!claimDashboardAttempt(project.id)) return;
    // Counselors (brief-dashboard-successor items 2-4, both seats). Render
    // unconditionally - the claim above already rate-limits this to once
    // per DASHBOARD_MIN_INTERVAL_SECONDS per project - then compare the
    // rendered content's own hash to what was last WRITTEN. See
    // renderDashboardForWrite's own comment in src/dashboard.ts for why a
    // content hash replaced the old hand-maintained column-mark, and for
    // the stamp-exclusion trap it has to dodge to avoid being dirty on
    // every single render.
    const { html, contentHash } = renderDashboardForWrite(project.id);
    const known = stmt("SELECT last_mark FROM dashboard_meta WHERE project_id = ?").get(project.id) as {
      last_mark: string | null;
    };
    // existsSync(target): closes counselors P2 (a deleted index.html is
    // never regenerated). An unchanged store with a hash match used to be
    // sufficient to skip the write outright; now it is sufficient only when
    // the file is ALSO still there, so `git clean -xdf` (routine after a
    // lane; .gitignore:10 makes .claude/* ignored) removing the directory
    // gets it rewritten on the very next tick that finds it missing, not
    // held back until some unrelated store change happens to land.
    const target = join(dashboardDir, "index.html");
    if (known.last_mark === contentHash && existsSync(target)) return;
    writeDashboardAtomically(dashboardDir, html);
    bestEffortRun("UPDATE dashboard_meta SET last_mark = ? WHERE project_id = ?", contentHash, project.id);
  } catch {
    // A broken generator (bad row shape, a future migration this dist has
    // not seen), a broken filesystem (permissions, disk full, the directory
    // removed between mkdirSync above and the write), or a failed claim
    // must cost only this project's file, never the scheduler tick, and
    // never another project's file in the same tick - every one of this
    // function's own operations is caught right here, never left to escape
    // the loop in maybeGenerateDashboards below.
    //
    // Counselors (brief-dashboard-successor item C). A PERSISTENT failure
    // here - an unwritable directory, a full disk - is swallowed forever by
    // this same catch, and the browser keeps refreshing a stale-but-complete
    // page that looks identical to an idle project with nothing to report.
    // Accepted: this is the honest cost of CLAUDE.md's "the scheduler must
    // never throw", the same trade maybeBackupHourly already makes for
    // backup failures. See dashboard_meta's own migration comment in
    // src/db.ts for why no last_error/last_error_at column was added here,
    // and todo 311 (hive doctor should report PTY headroom) for the proposal
    // to teach `hive doctor` to surface exactly this class of silent
    // per-project failure, rather than a column nothing reads.
  }
}

// Every hive server instance ticks the WHOLE store, not just one project
// (tick()'s own candidates query below carries no project filter either) -
// so this iterates every registered project and lets each one's own
// hive.yml and claim decide independently whether it has anything to do.
// listProjects() (src/context.ts) is the same "for every project" lookup
// src/cli.ts and src/tools/meta.ts already use, rather than a third
// hand-written copy of the same SELECT.
function maybeGenerateDashboards(): void {
  try {
    for (const project of listProjects()) {
      maybeGenerateDashboard(project);
    }
  } catch {
    // The scheduler must never throw.
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
    // Todo 309. Same placement logic as maybeBackupHourly immediately above:
    // per-project housekeeping that must run regardless of whether tmux
    // answered this tick, rate-limited internally (claimDashboardAttempt) so
    // this call is cheap on every tick where nothing is due.
    maybeGenerateDashboards();
    const now = (stmt("SELECT datetime('now') AS now").get() as { now: string }).now;
    // LEFT JOIN for deliver_socket (issue #73, D6) and deliver_pane_pid
    // (todo 336): see TimerRow's own comments on both fields. timers.* keeps
    // every bare column reference below unambiguous against agents' own
    // id/project_id/kind/created_at columns.
    const candidates = stmt(
      `SELECT timers.*, COALESCE(agents.tmux_socket, '') AS deliver_socket,
              COALESCE(agents.pane_pid, '') AS deliver_pane_pid
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
// inventing a second signal. Which states count is holdsHumanInput's call,
// not this function's (src/tmux.ts, next to InputBoxState) - todo 317 added
// two more callers of the same policy and pulled it to one place before the
// three could drift onto three definitions of "a human is typing here".
//
// What is local here is the CACHING and the hold-vs-refuse choice. A pane
// with no box at all (null: a modal, or mid-turn) is not this function's
// concern; the modal case is already held above by awaitingChoice, and
// mid-turn is not a hold condition (this codebase's own position is
// well-established: a busy pane is fine to deliver into, only a pane with
// nowhere to put the paste is not).
function inputBoxHoldsWake(pane: string, cache: ChoiceCache): boolean {
  const entry = cacheEntry(pane, cache);
  if (entry.inputHeld === undefined) entry.inputHeld = holdsHumanInput(inputBoxState(pane));
  return entry.inputHeld;
}

// TODO 321. A BOUND ON THE ONE FORK NOTHING ELSE BOUNDS, and it is the only
// thing in this file that is a cache rather than a claim - so the argument for
// that has to be here, or the next reader deletes it as a bug.
//
// WHAT IS UNBOUNDED. noteBlockedWatched reads a pane for every crew member
// latched `waiting`, and the cheap gate in front of it (alreadyToldAbout)
// only covers a REPORTED block. A worker that answered its prompt and carried
// on still reads `waiting` - the latch is never cleared
// (.claude/rules/worker-state.md, issue #28) - and its pane has no dialog on
// it, so nothing is ever reported and nothing is ever skipped. The tick's
// ChoiceCache dedupes that read WITHIN one tick, across every wake watching
// the same pane; it is discarded at the end of the tick, so it bounds nothing
// ACROSS ticks. Todo 314 accepted the cost knowingly and argued the acceptance
// on the set being "bounded by watched agents with a pending idle wake, which
// is small by construction". PROJECT SCOPE IS EXACTLY WHAT REMOVED THAT
// BOUND: the set is now every latched crew member, and a standing watch stays
// a candidate for its whole life where a one-shot leaves at fired_at. At 3.5ms
// a capture-pane (measured, .claude/rules/tmux-and-panes.md), five workers and
// six sessions is ~105ms of forks every three seconds, forever, to re-learn a
// fact that has not changed.
//
// WHY THIS IS NOT WHAT TODO 314 REJECTED, which is the first thing it looks
// like. That rejection was of recording the negative under the SAME EPISODE
// KEY as the claim: "looked, no dialog" would then suppress a REAL dialog
// appearing later in the same episode, with nothing to un-suppress it - an
// unbounded silent false negative, in a feature whose whole defect is silence.
// The bound is the difference. Thirty seconds delays a real dialog by at most
// thirty seconds, against a fifteen-minute max_wait, against a standing
// watch's four-hour lifetime, and against a baseline of being told NOTHING.
// Different trade, not the same one re-argued.
//
// WHY IN-PROCESS, IN A FILE WHERE EVERY OTHER CLAIM IS ATOMIC AND IN THE
// STORE. Because this is not a claim. A store-level negative cache would take
// SQLite's single machine-wide writer slot on the COMMON case - every tick,
// every latched worker, forever - to save a fork that is process-local and
// costs 3.5ms of one process: a cheap local cost traded for a contended
// global one, and the exact inversion of the read-before-write discipline
// noteStandingTransitions states. Being wrong here costs one process a
// thirty-second delay. The actual claim, wake_block_notices, is untouched and
// stays atomic across instances, so nothing about correctness moves into
// memory. The precedent for an in-process rate limiter is src/context.ts's
// TOUCH_INTERVAL_MS; Date.now() is right here for the same reason it is there
// and wrong for anything the store has to compare against, which is why this
// file otherwise reads its clock from SQLite.
//
// NEGATIVE ONLY. A positive leads straight to the claim, which is idempotent,
// so caching it buys nothing and can only go stale in the direction that
// matters. `null` - an unanswered probe - is NOT cached either: that is "no
// fact", not "no dialog", the same rule rowAlive applies one line earlier.
const NO_DIALOG_TTL_MS = 30_000;

// A long-lived scheduler must not accumulate one entry per pane it has ever
// seen. Well above any real crew (`hive doctor` reports PTY headroom in the
// low hundreds), so the sweep below is a backstop rather than a working part.
const NO_DIALOG_MAX_ENTRIES = 512;

// KEYED ON THE PANE, WITH THE SOCKET IN THE VALUE AND CHECKED ON READ. A
// socket path is a location, not a server identity, and two servers reuse pane
// ids (.claude/rules/tmux-and-panes.md), so an answer recorded for %3 on one
// socket must not be believed for %3 on another - hence the check. Keeping the
// socket out of the KEY is what lets invalidation be an exact delete rather
// than a scan for a string convention: a same-id pane arriving on a second
// socket overwrites rather than coexisting, and the two then take turns
// missing, which costs exactly the one fork per pane the eviction rule already
// accepts and cannot produce a wrong answer.
//
// WHAT ACTUALLY BOUNDS A STALE ANSWER IS THE TTL, ALONE. An earlier version of
// this comment claimed the upstream rowAlive() filter made a collision
// unreachable, "so every entry written here carries this process's own
// socket". BOTH counselors seats refuted that, and they are right on two
// counts. foreignSocket("") is FALSE by design (issue #73's "no fact
// recorded", src/tmux.ts), so a pre-#73 agents row with an empty tmux_socket
// passes rowAlive and writes an entry whose socket is a SENTINEL, not this
// process's. And tmuxSocketPath() keeps the socket PATH and drops the server
// pid, so two different servers on the default path compare EQUAL - the check
// passes precisely in the case it was written for
// (.claude/rules/tmux-and-panes.md: "a socket path is a location, not a server
// identity"). The socket check separates a legacy empty row from a current
// one and nothing more. Worth knowing before anyone "restores" the old key:
// `${socket} ${pane}` had the IDENTICAL property (a legacy row keyed " %3",
// two servers keyed the same), so the /simplify pass lost nothing real - only
// a sentence that claimed a property this code never had.
const noDialogUntil = new Map<string, { socket: string; until: number }>();

function recentlyHadNoDialog(socket: string, pane: string): boolean {
  const seen = noDialogUntil.get(pane);
  if (seen === undefined || seen.socket !== socket) return false;
  if (seen.until > Date.now()) return true;
  noDialogUntil.delete(pane);
  return false;
}

function rememberNoDialog(socket: string, pane: string): void {
  const now = Date.now();
  if (noDialogUntil.size >= NO_DIALOG_MAX_ENTRIES) {
    for (const [key, seen] of noDialogUntil) if (seen.until <= now) noDialogUntil.delete(key);
    // Still full of LIVE entries, which means this process is watching more
    // panes than the cap. Drop everything rather than evict by an order this
    // Map does not promise: the only cost of forgetting is one fork per pane.
    if (noDialogUntil.size >= NO_DIALOG_MAX_ENTRIES) noDialogUntil.clear();
  }
  noDialogUntil.set(pane, { socket, until: now + NO_DIALOG_TTL_MS });
}

// HIVE TYPED INTO THIS PANE, so every remembered answer about it is void.
//
// ONE FUNCTION FOR ONE EVENT, rather than two calls a caller has to remember
// to pair. That is ChoiceCache's own stated rule ("both answers are
// invalidated by the identical event, and a second Map would just duplicate
// that invalidation logic") applied to a third answer it cannot itself hold -
// the tick cache dies with the tick and this one has to outlive it, so they
// cannot be one Map, but they can be one invalidation. A future typing path
// that remembered choices.delete and forgot the negative cache would be a
// silently stale suppression; now there is one call to remember.
//
// The pane is cleared whatever socket its answer was recorded under, because
// the caller cannot always name one: a timer whose deliver_actor has no agents
// row carries deliver_socket '' (tick()'s own COALESCE). Forgetting too much
// costs one capture-pane fork; forgetting too little costs a missed
// notification.
//
// WHAT THE SECOND HALF IS NOT PROTECTING, said plainly because the ChoiceCache
// half IS a safety property and the negative half is not. There a stale answer
// decides whether to TYPE into a pane, so it can paste a wake into a dialog.
// The negative cache decides only whether to NOTIFY about someone else's
// dialog, and the worst case is a notice up to thirty seconds late.
//
// ONLY deliver() CALLS THIS, AND FOUR OTHER PATHS TYPE INTO THESE SAME PANES
// (counselors round 1, opus F10): agent_send's text and keys paths,
// agent_rename, and the spawn announcement, all in this same process and all
// unable to reach a module-private function in the scheduler. So
// agent_send(text:...) -> the worker starts a turn -> a permission prompt goes
// up is a notice up to 30s late where before this lane it was 3s. ACCEPTED,
// NOT MISSED: the direction is safe (late, never wrong, and never a wake typed
// into a dialog), and exporting this into src/tools/agents.ts crosses a module
// boundary to buy 27 seconds on a dialog a human takes minutes to answer.
// REOPEN TRIGGER, and it is a measurement rather than a judgement: a real case
// where a block notice arriving 30s late actually cost something.
function forgetPaneAnswers(pane: string, choices: ChoiceCache): void {
  choices.delete(pane);
  noDialogUntil.delete(pane);
}

// Counselors R2-A on the L4 fix round's todo 161. The lead exemption below
// used to just `return false` with nothing written, so a lead wake blocked
// on a dead pane sat with typed_at, held_at and held_reason all NULL - the
// identical shape wake_list already uses for "not due yet", the exact
// ambiguity #27 shipped held_at/held_reason to remove. Recorded through the
// same guarded write the modal-choice hold below uses, not a second
// mechanism, with its own reason string.
// Pick<TimerRow, "id" | "due_at">, not the full TimerRow: janitor()'s timers
// sweep (issue #149, todo 348, fix round 1) selects a narrower row shape than
// the scheduler's own due-timer candidates query does, and holding it there
// needs no field this signature does not already ask for.
function holdTimer(timer: Pick<TimerRow, "id" | "due_at">, reason: string): void {
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
// Issue #149 (todo 348). Two reasons, not one, because the remedy differs:
// `hive lead` re-points every pending LEAD-owned wake to its fresh pane
// (issue #27 L4 R6, todo 166), so that remedy is honest to name. Nothing
// re-points a worker's wake the same way, so the worker-facing text says
// that plainly instead of pointing at a command that would not help -
// naming a remedy the caller cannot actually reach is exactly what
// tmux-and-panes.md's "a refusal has to name a remedy the caller can
// actually reach" already argues against for a synchronous refusal, and the
// same courtesy applies to a hold a human will eventually read in
// wake_list.
const HELD_REASON_PANE_REISSUED_PREFIX =
  "the pane id recorded for this wake now belongs to a different pane than the one it was set " +
  "against (its pid no longer matches, most likely a tmux server restart reissuing the id); held " +
  "rather than typed into the wrong pane - ";
const HELD_REASON_PANE_REISSUED_LEAD =
  `${HELD_REASON_PANE_REISSUED_PREFIX}run \`hive lead\` to re-point it at the live one`;
const HELD_REASON_PANE_REISSUED_WORKER =
  `${HELD_REASON_PANE_REISSUED_PREFIX}nothing re-points a worker's wake automatically, so cancel ` +
  "it with wake_cancel and set a fresh one once the worker's pane is confirmed live, or leave it: " +
  "it will keep holding rather than deliver wrongly";

// Issue #149 (todo 348) comment 763, fix round 1, finding 1 (counselors, both
// seats). Without this, a hold for pane-reissue was only ever a ONE-TICK
// promise: if the pane the wake was reissued to later exits on its own (a
// transient shell, minutes away for the common case), the janitor's timers
// sweep and deliverable()'s own dead-pane branch both see rowAlive === false
// and cancel the timer outright for a non-lead actor - unconditionally,
// because that branch predates this lane and knows nothing about a prior
// reissue hold. The wake then leaves ACTIVE_TIMER_WHERE with no fired_at, so
// it drops out of wake_list's pending section and hive status's heldWakes
// with nothing in recently_delivered either - gone silently, through the
// other door from the one the hold-vs-cancel decision was chosen to close.
//
// wasHeldForPaneReissue reads the durable signal both call sites already
// have for free: held_reason from the LAST tick this timer was held for
// exactly this condition. Recorded fact, not re-derived - a pane that was
// once reissued and has since gone fully dead is not "back to ordinary
// dead", it is the same incident continuing, and both sweeps now say so
// rather than erasing it.
// Built from HELD_REASON_PANE_REISSUED_PREFIX, not a fourth independent
// string: this reason has to keep satisfying wasHeldForPaneReissue on every
// later tick too, or the very next re-evaluation (deliverable() runs again
// this same tick, since a held-not-cancelled timer is still due and still
// active) reads its OWN just-written reason as an ordinary dead pane and
// cancels it right back - proven red by exactly that mutation before this
// comment was written.
const HELD_REASON_PANE_REISSUED_THEN_DEAD =
  `${HELD_REASON_PANE_REISSUED_PREFIX}the pane it was reissued to has since gone dead too; nothing ` +
  "re-points a worker's wake automatically, so cancel it with wake_cancel (any running lead may do " +
  "this even though the wake is not theirs) if it is no longer needed";
function wasHeldForPaneReissue(heldReason: string | null): boolean {
  return heldReason != null && heldReason.startsWith(HELD_REASON_PANE_REISSUED_PREFIX);
}

const HELD_REASON_UNSUBMITTED_INPUT =
  "the pane's input box has unsubmitted human text; delivering now would paste the wake body onto it " +
  "and submit both as one message";

// Todo 314, issue #28's fourth path. hive already DETECTS this condition -
// the hold below records HELD_REASON_MODAL_CHOICE and wake_get/wake_list
// already report it. What was missing is the PUSH: a lead sets a wake, goes
// quiet because the runbook tells it to, and is never told that the worker it
// is waiting on is sitting on a dialog waiting for a human. Nobody is told
// without asking, and the lead has been told not to ask.
//
// WHY THIS IS NOT THE WITHDRAWN also_when_stuck
// (.claude/sessions/dead-ends/2026-07-29-also-when-stuck-on-latched-waiting.md,
// whose closing constraint is "a wake must not fire on a state the worker
// will leave on its own within a turn"). That design fired a wake on
// `waiting`, a LATCHED store state nothing clears, so ten-minutes-stale and
// live were byte-identical in the store. This fires on a LIVE PANE READ that
// every tick re-evaluates, self-clearing by construction, and - the
// load-bearing half - it does not change when the ORIGINAL wake fires at all.
// That wake is not fired, not cancelled, not rescheduled: it stays pending
// and delivers on its own once the dialog goes, exactly as before. Anything
// that changes the original's firing condition is the withdrawn design coming
// back; stop and say so on todo 314 rather than building it.
// The one residual, stated rather than hidden: the pane read and the
// notification landing are seconds apart, so a human who answers the dialog
// in that gap gets told about a dialog that is already gone. Seconds of
// staleness on a self-clearing read, against the withdrawn design's
// unbounded staleness on a latch that nothing clears.
//
// THE NOTIFICATION IS A REAL WAKE ROW, due now, and that IS the mechanism.
// The next tick delivers it through fireDelay -> deliverable() ->
// claimOneShot -> deliver(), the same path every other wake takes, so it
// inherits deliverable()'s guards instead of re-stating them: if the OWNER's
// own pane is on a dialog or holds unsubmitted human text, the notification
// HOLDS rather than pasting into it, and retries on its own afterwards.
// Calling deliver() directly would have skipped exactly those guards -
// deliver() types, deliverable() decides - and "held" only means anything for
// a row a later tick can pick up again. No fifth path types into a pane
// (.claude/rules/tmux-and-panes.md): this adds none, it queues work for the
// one path that already exists.
// kind, not just the name (counselors round on this lane, opus 5). The held
// target can BE a lead - a worker is allowed to set a wake on the lead's own
// pane - and agent_send refuses `keys` on a kind='lead' target when the
// caller is a worker (.claude/rules/tmux-and-panes.md, R8/todo 175). Telling
// a worker to make a call hive will reject is worse than telling it nothing,
// so the body below says something different for that case.
function heldTarget(timer: TimerRow): {
  name: string;
  isLead: boolean;
  agentId: number | null;
  blockedSince: string;
} {
  const row = stmt(
    `SELECT id, name, kind, COALESCE(state_changed_at, '') AS blocked_since FROM agents WHERE actor_id = ?
      ORDER BY (status = 'running') DESC, id DESC LIMIT 1`,
  ).get(timer.deliver_actor) as
    | { id: number; name: string; kind: string; blocked_since: string }
    | undefined;
  return {
    name: row?.name ?? timer.deliver_actor,
    isLead: row?.kind === LEAD_KIND,
    // The other half of the block-notice key (see wake_block_notices in
    // src/db.ts). null means this delivery target has no agents row at all -
    // a plain `user:` session - and there is no key to de-duplicate against,
    // so the narrow path's held_reason claim is the whole debounce there.
    agentId: row?.id ?? null,
    blockedSince: row?.blocked_since ?? "",
  };
}

// Wake bodies are delivered VERBATIM into a terminal
// (.claude/rules/worker-state.md), so this is written to stand on its own for
// a reader with none of the context that produced it: which target, what is
// wrong with it, what happens to the wake, and the one action that fixes it.
// `keys` is named explicitly because it is the ONLY supported way out of a
// dialog - agent_send's `text` path refuses a pane sitting on one - and a
// lead that has been quiet for an hour will not remember that.
//
// IT SAYS "look first", and that ordering is load-bearing rather than polite
// (counselors, codex 1). This body is a snapshot of what hive saw at one
// tick, and it can be delivered late - the notification itself holds while
// the OWNER's pane is busy with a dialog of its own, and the target's dialog
// can be answered by a human in the meantime. A reader who sends keys without
// looking would be typing them into a pane that has moved on. Every wake body
// in hive is stale by nature; this one names the check that resolves it.
// THE TWO CALLS A READER IS TOLD TO MAKE, WRITTEN ONCE. Three bodies suggest
// them (this one, the standing roster below, and standingNoticeBody's advice
// line), and until todo 321 all three wrote them out by hand - which is how
// all three came to name a parameter no tool declares (`agent:` where
// agent_output and agent_send both take `name`), refused at runtime with a
// -32602 rather than coerced. test/wire-surface.test.mjs now catches a
// parameter that does not exist, but it cannot catch two bodies disagreeing
// about the keys, the order, or which tool to reach for first. One renderer
// can. This lane's own test file reached the identical conclusion about its
// matcher after the rename broke it (test/wake-hold-notify.test.mjs's
// readCall); this is that fix on the side that emits the string.
// JSON.stringify, NOT `"${name}"` (counselors round 1, codex 4).
// normalizeAgentName (src/tools/agents.ts) rejects CONTROL characters and
// nothing else, so a quote or a backslash is a legal agent name - and a worker
// called `qa"red` rendered agent_output(name: "qa"red"), which the reader
// cannot run. Same defect class as the `agent:` parameter, one layer down, and
// test/wire-surface.test.mjs cannot see it: that guard reads the TEMPLATE in
// source, never a rendered body. Output is byte-identical for every name
// without a quote or backslash in it.
const readPaneCall = (name: string) => `agent_output(name: ${JSON.stringify(name)})`;
const answerDialogCall = (name: string) => `agent_send(name: ${JSON.stringify(name)}, keys: ["1", "Enter"])`;

const howToClearIt = (name: string, isLead: boolean): string =>
  isLead
    ? `That target is a LEAD session, so agent_send's keys path is refused against it from a worker: a human ` +
      `at that terminal, or another lead, has to answer the dialog.`
    : `Read its pane with ${readPaneCall(name)} FIRST, since this notice can arrive after the dialog ` +
      `was already answered, and if it is still up answer it with ${answerDialogCall(name)} or whichever ` +
      `keys that dialog wants - keys is the only supported way to answer one, because ` +
      `agent_send's text path refuses a pane that is on a dialog.`;

function holdNoticeBody(timer: TimerRow, target: { name: string; isLead: boolean }): string {
  return (
    `"${target.name}" has a dialog up in its pane and is waiting for a human to answer it. hive is HOLDING ` +
    `wake #${timer.id} for it rather than typing the wake body into the dialog. That wake is not lost: it ` +
    `stays pending and delivers on its own once the dialog clears. ${howToClearIt(target.name, target.isLead)}`
  );
}

// The WIDE half's body (todo 314, amendment 1). Different situation, so a
// different sentence: this wake is not held, it is not even due. A
// wake_when_idle fires when a watched worker goes IDLE, and a worker sitting
// on a dialog is `waiting` forever - so without this the owner waits out
// max_wait_seconds (fifteen minutes by default) to be told that nothing
// happened, which is what amendment 1 exists to fix.
function blockNoticeBody(timer: TimerRow, name: string): string {
  return (
    `"${name}" is stopped on a dialog in its pane, waiting for a human to answer it, so it cannot go idle. ` +
    `wake #${timer.id} is waiting for exactly that, so it will not fire until the dialog is answered (or its ` +
    `max wait runs out, if it has one). The wake is not lost and nothing has been typed into the dialog. ` +
    `${howToClearIt(name, false)}`
  );
}

// THE STANDING WATCH'S OWN BODY, and it is a different sentence for the same
// reason the one above is: every clause of the one-shot's version is FALSE for
// a standing watch. It does not "fire"; its max_wait_at is a LIFETIME rather
// than a deadline it is racing to beat (an earlier version of this comment
// said it had "no max wait", which is false - every standing watch carries
// one, and reaching it ends the watch rather than delivering the wake); and
// it is not waiting on this particular worker - it reports each finish as it
// happens and goes on watching. Bodies are typed VERBATIM into a terminal
// (.claude/rules/worker-state.md), so a body that mis-describes its own wake
// is a small lie in a lead's session.
//
// A ROSTER RATHER THAN ONE WORKER, because this half is BATCHED (see
// claimBlockBatch) and the roster shape is used even for a crew of one, so
// there is one body to keep true rather than a singular and a plural that can
// drift. It is the same choice standingNoticeBody makes for finishes.
//
// THE "WHY" IS RESTATED HERE RATHER THAN SHARED WITH howToClearIt, and that is
// deliberate: howToClearIt is per-worker prose, and repeating it whole for
// every blocked worker would paste the same two paragraphs three times into a
// terminal. The per-worker line carries the two CALLS and this carries the two
// REASONS once. If you change one, read the other - they are one explanation
// split across two functions, unlike CHOICE_DIALOG's predicate, which is
// shared precisely because a predicate cannot be allowed to differ.
function standingBlockNoticeBody(timer: TimerRow, names: string[]): string {
  const lines = [
    `${names.length} crew member(s) in this project are stopped on a dialog in their pane, waiting for a ` +
      "human to answer it, so they cannot finish:",
  ];
  for (const name of names) {
    lines.push(
      `  ${name}: read its pane with ${readPaneCall(name)}, then answer the dialog with ` +
        `${answerDialogCall(name)} or whichever keys that dialog wants.`,
    );
  }
  lines.push(
    `Read each pane FIRST: this notice can arrive after a dialog was already answered. keys is the only ` +
      "supported way to answer one, because agent_send's text path refuses a pane that is on a dialog.",
  );
  lines.push(
    `Standing watch #${timer.id} is watching this project's crew and reports each finish as it happens, so ` +
      "it will report nothing about the workers above until their dialogs are answered (or a worker goes " +
      "away, which it reports as such). The watch is " +
      "unaffected - still watching, still pending - and nothing has been typed into any dialog.",
  );
  return lines.join("\n");
}

// Who to tell, and the three shapes of "nobody".
//
// THE FIRST IS THE RECURSION GUARD, and it is the only one that is genuinely
// structural: a notification is inserted with owner === deliver_actor (the
// INSERT below sets both to the held wake's owner), so a wake whose owner is
// also its delivery target is either a notification or a wake a session set
// for its own pane. Neither has anyone to tell - the reader would be told
// about the pane it is reading from - and the check holds no matter what
// happens to panes afterwards.
//
// The pane comparison under it is the SAME rule reached by value, and it is
// the weaker of the two: `timer.deliver_pane` was frozen when that row was
// written while the lookup below re-resolves the owner's pane now, so a lead
// restart or the two-running-lead-rows shape this file documents above
// (DELIVER_SOCKET_JOIN's own comment) can make them disagree. Counselors
// found the chain that opens - a notification whose owner row moved panes
// files a second notification - which is why the actor check above was added
// and is stated as the guard rather than this one. This still earns its place
// for the case the actor check cannot see: two different actors whose rows
// name one pane.
//
// The third is a wake whose owner has no running agents row at all - a plain
// `user:` session that set one from a bare terminal, or a lead mid-restart -
// which names no pane hive can reach. See noteModalHold on what that costs.
//
// LIVENESS IS CHECKED HERE NOW, and the paragraph that used to say it was
// deliberately not checked was wrong twice over. It argued that deliverable()
// asks the question on the notification's own tick - true, and too late: by
// then the claim is spent and a notice exists aimed at a pane nobody reads. It
// also argued a check would cost a tmux fork, which is false, because the
// tick's batched snapshot already answers it for every pane at once. Both
// callers below resolve the owner through ownerPaneIfLive, which takes that
// snapshot. The running filter, ORDER BY id DESC and LIMIT 1 are
// resolveDelivery's own convention (src/tools/wakes.ts) - one rule for which
// row speaks for an actor, not two that can disagree.

// THE WIDE PATH'S version, and the pane it answers was WRONG for one caller
// until todo 321 measured it (test/wake-hold-notify.test.mjs, "tells a rowless
// owner..."). ownerPane() above is a lookup in `agents`, so it answers null
// for a session with no running row - and resolveDelivery (src/tools/wakes.ts)
// DELIBERATELY supports exactly that caller, falling back to the TMUX_PANE the
// session is running in. So a plain `user:` session that set wake_when_idle
// had a perfectly good delivery pane recorded on its own wake and was told
// NOTHING about a worker stopped on a dialog: the silence this half exists to
// remove, in the same configuration todo 315 found the standing watch inert
// in.
//
// THE OWNER COMES FIRST AND THE DELIVERY TARGET IS THE FALLBACK, which is the
// opposite ordering from noteStandingTransitions' notices, and the difference
// is what the notice IS rather than a divergence to tidy up. A standing
// watch's finish notice is the wake's own PAYLOAD - the roster plus the
// caller's own body - so it belongs at the target the caller named and the
// receipt echoed. A block notice is a META-notice about the wake ("this cannot
// fire yet, and here is the one action that changes that"), so its reader is
// whoever is waiting on the wake, which is the owner.
//
// Switching this wholesale to deliver_pane was considered and REJECTED on a
// case with a test on it: a wake delivered TO the very worker that is blocked
// (test/wake-hold-notify.test.mjs, "does not double-notify when the same block
// reaches both paths in sequence") has deliver_pane == the dialogged pane, so
// the self-report skip in noteBlockedWatched would turn the only notice into
// silence, and the owner - a different session, watching and waiting - would
// hear nothing until some other watched agent went idle. That is this half's
// own defect reintroduced by its own generalisation.
//
// THE ACTOR AND THE PANE ALWAYS COME FROM THE SAME PLACE. Mixing them - one
// actor's pane filed as another actor - is what DELIVER_SOCKET_JOIN resolves
// the notice's tmux socket by and what checkConfirmations attributes it by, so
// a mixed pair is a notice that reads as delivered to a session that never got
// it.
// THE OWNER'S PANE HAS TO BE POSITIVELY LIVE, NOT MERELY RECORDED RUNNING
// (counselors round 1, codex 3, and it was this lane's own defect reintroduced
// by this lane's own targeting rule). ownerPane() asks `status = 'running'` and
// nothing else - and the janitor EXEMPTS kind='lead' rows, so a lead whose pane
// died keeps a running row naming a dead pane indefinitely. Owner-first then
// picked that dead pane over a LIVE deliver_to, claimed the episode against it,
// and nobody was ever told about the blocked worker: silence, which is the
// defect this whole half exists to remove.
//
// So the owner is preferred only while rowAlive() says TRUE - the same
// discipline every other pane read here already applies (issue #73: unknown is
// "no fact", never "live"), against the tick's own snapshot rather than a fresh
// fork. A dead, unknown, or foreign-socket owner pane falls through to the
// wake's own delivery target.
//
// THE CLAIM IS SPENT EITHER WAY, which is why this must be decided BEFORE the
// claim rather than after it. wake_block_notices is keyed on (timer, agent,
// episode) and nothing re-arms it inside an episode, so filing at a pane
// nobody reads consumes the one report that block was ever going to get.
// Resolving the target first means the episode is only claimed once there is
// somewhere to tell.
//
// It reads its own row rather than calling ownerPane() because it needs the
// SOCKET alongside the pane, and those two must come from one row: the same
// running/ORDER BY id DESC/LIMIT 1 rule, so this and ownerPane() can never
// disagree about which row speaks for an actor.
// The owner's pane, or null unless it is POSITIVELY live. One lookup for both
// callers below, because the running/ORDER BY id DESC/LIMIT 1 rule for which
// row speaks for an actor must not exist twice - what the two callers do with
// the answer is where they are allowed to differ.
//
// A NULL SNAPSHOT IS "NO FACT", NOT "PROBE IT". This runs in tick()'s hottest
// loop and the tick already paid for one batched probe; falling back to a
// per-timer fork here would be a tmux subprocess per held wake per tick. Both
// callers treat null conservatively, so a tick that could not see tmux simply
// does not act, and the next one does.
function ownerPaneIfLive(timer: TimerRow, snapshot: AliveSnapshot | null): string | null {
  const row = stmt(
    `SELECT tmux_target, tmux_socket FROM agents WHERE actor_id = ? AND status = 'running'
      ORDER BY id DESC LIMIT 1`,
  ).get(timer.owner) as { tmux_target: string; tmux_socket: string } | undefined;
  if (!row?.tmux_target || snapshot === null) return null;
  return rowAlive(row.tmux_socket, row.tmux_target, snapshot) === true ? row.tmux_target : null;
}

function blockNoticeTarget(timer: TimerRow, snapshot: AliveSnapshot): { actor: string; pane: string } | null {
  const pane = ownerPaneIfLive(timer, snapshot);
  if (pane !== null) return { actor: timer.owner, pane };
  return timer.deliver_pane ? { actor: timer.deliver_actor, pane: timer.deliver_pane } : null;
}

// THE HELD-WAKE PATH'S version, with that path's two guards on top.
//
// The owner === deliver_actor check belongs to THIS path only, and the
// distinction is the whole reason the two are separate functions rather than
// one with a flag. Here the thing being reported IS the delivery pane, so a
// wake whose owner is also its target has nobody to tell - the reader would
// be told about the pane it is reading from. The wide path below reports on a
// WATCHED agent's pane instead, and there `owner === deliver_actor` is the
// ordinary shape of every wake a lead sets for itself, so applying it there
// would silently disable the feature for its own main case.
// THE SAME DEAD-LEAD-PANE DEFECT blockNoticeTarget HAD, found by the PR gate
// on this lane after the sibling was fixed - and it resolves it the OPPOSITE
// way, which is why both directions are written down here rather than left to
// look inconsistent.
//
// blockNoticeTarget FALLS BACK to the wake's delivery target, because a block
// notice is about a THIRD pane (the watched worker's) and the delivery target
// is a live session that can act on it. THIS path must NOT fall back, because
// the thing it is reporting IS the delivery pane sitting on a dialog: filing
// there would paste a notice about a dialog into that same dialog, which is
// the case the pane comparison below already refuses.
//
// THE TWO PATHS CANNOT BOTH RUN IN ONE TICK, AND THAT IS THE ONLY THING THAT
// IS TRUE OF THEM. maybeFireIdle gates them on opposite sides of one
// condition - `if (!ready) noteBlockedWatched(...)` and then `if (ready &&
// deliverable(...))` - so within a tick exactly one can speak. They still
// reach the SAME (timer, agent, episode) key ACROSS ticks, which is why they
// claim through one table: claimBlockNotice's own comment sets out the
// sequence (the wide path speaks while the wake is not ready; later some other
// watched agent goes idle, the wake becomes ready, and this path sees the same
// dialog on the same pane), and `ready` is recomputed from live state every
// tick, so it can flip back - an agent that went idle and was then sent more
// work reads working again. Do not upgrade this into "they cannot collide":
// they can, in either order, and the order that matters here is modal-first,
// which burns the key before the wide half ever looks.
//
// SO IT RETURNS NULL, AND RETURNING NULL BEFORE THE CLAIM IS THE POINT.
// claimModalHoldWithNotice claims wake_block_notices on the same (timer, agent,
// episode) key the wide half uses, and nothing re-arms that key inside an
// episode. Filing at a dead pane therefore SPENT the one report that block was
// going to get: `hive lead`'s restart clears held_at/held_reason and re-points
// the pane, so the held_reason claim re-arms and this path runs again - and
// then loses the block key it burned while nobody was listening, so the
// returning lead is told nothing. Returning null leaves the key unclaimed and
// falls through to the plain holdTimer, which is this function's documented
// "nobody to tell" case and already accounted for.
function ownerPaneToTell(timer: TimerRow, snapshot: AliveSnapshot | null): string | null {
  if (timer.owner === timer.deliver_actor) return null;
  const pane = ownerPaneIfLive(timer, snapshot);
  if (pane === null || pane === timer.deliver_pane) return null;
  return pane;
}

// THE DEBOUNCE, and it has to be atomic rather than in-process: one scheduler
// instance runs per session and they all tick against the same store, so a
// guard that is correct only inside one process is not correct at all
// (CLAUDE.md: "wake-up claims are atomic conditional updates so concurrent
// scheduler instances never double-fire"). It does not exist for free either
// - holdTimer's own UPDATE rewrites held_at unconditionally on EVERY tick the
// condition holds, and a dialogged pane re-forks that check every three
// seconds for as long as the dialog is up, so a notification hung off that
// write would type into the lead's pane every three seconds forever.
//
// Same claim shape as claimOneShot: the UPDATE matches only while
// held_reason is not ALREADY the modal reason, so at most one instance on at
// most one tick sees changes === 1 per hold condition, however many instances
// are running and however long the dialog stays up. A hold condition ENDS
// when the wake finally delivers (deliver() clears held_at/held_reason), when
// a different hold reason takes over, or when `hive lead` restarts and clears
// held_at/held_reason for every wake aimed at the lead's pane (src/cli.ts's
// restart CAS - a third writer, found by counselors, and one per human
// restart rather than per tick). A dialog after any of those is a new
// condition and notifies again.
//
// AT MOST ONCE, NOT EXACTLY ONCE, and the difference is three cases where
// nobody is told at all. The latch this claim sets records that the row was
// CLAIMED, not that a notification was delivered, and holdTimer's fallback
// sets the same string, so:
//   - nobody to tell at the transition tick (ownerPaneToTell answers null -
//     most often a lead mid-restart with no running row), and the owner
//     coming back a tick later gets nothing, because the reason already reads
//     MODAL;
//   - the notification names a pane that dies before its first delivery, so
//     deliverable() cancels it (a non-lead target) and nothing retries;
//   - sendText throws on the notification, spending a one-shot that is never
//     retried.
// All three fail SILENT, which is exactly what this whole area did before
// this lane, so each is a narrower improvement rather than a regression -
// and none of them can produce a SECOND notification, which is the direction
// that costs a human's terminal. Closing them means recording delivery
// separately from the hold: a notified_at (or notice_timer_id) column, i.e.
// the schema migration todo 314 was scoped to avoid. REOPEN TRIGGER, not a
// judgement call: a real lane where a stuck worker went unreported through
// one of these three, observed rather than imagined.
//
// One more thing this is not: it is one notification per HELD WAKE, not per
// stuck worker. Three wakes set on the same worker produce three notices on
// the tick its dialog appears, each naming its own wake. De-duplicating
// across rows would need state that spans them, which is the same column
// above by another name.
//
// held_at STILL MEANS "last held at", unchanged by this lane, and that is a
// decision rather than an accident. This conditional claim on its own stops
// rewriting held_at every tick, which would quietly turn the column into
// "first held at" for a continuing hold - a behaviour change to a column
// wake_get/wake_list already report and test/wake-hold-unsubmitted-input.
// test.mjs already reads across ticks. So noteModalHold below falls back to
// holdTimer's unconditional write on every tick this claim does not match,
// which is every tick after the first: one write per tick either way, the
// same value in the column as before, and nothing that reads it has anything
// to notice.
//
// ONE TRANSACTION, because the claim IS the record that the notification was
// sent. Split in two, a throwing INSERT after a committed claim loses the
// notification permanently - held_reason already reads MODAL, so no later
// tick ever claims again. `.immediate()` for the reason withWindowClaim
// (src/spawn.ts) uses it, and this section obeys that lock's own rules
// (.claude/rules/store-and-datadir.md): two trivial writes, no subprocess,
// nothing that can block on a human, so the store's single machine-wide
// writer slot is held for microseconds.
// One INSERT, two callers (the held-wake path below and the blocked-watched
// path under it), because the row they write is the same row and a second
// copy of these six columns is a second thing to keep true.
//
// project_id is the WAKE's, not the owner's own: this notification is about
// that wake and belongs where a lead reading the project's wakes will see it,
// even in the cross-project case where a lead's agents row is scoped
// elsewhere (.claude/rules/project-scoping.md).
//
// owner and deliver_actor are BOTH the wake's owner, and the fact that they
// are equal is what ownerPaneToTell's first line turns into the recursion
// guard. Do not set one without the other.
//
// ACCEPTED RESIDUAL (counselors, opus 7): if the owner's row is on a foreign
// tmux socket, deliverable() answers null for this notification on every tick
// and the janitor's rowAlive answers null too, so it is never delivered and
// never cancelled - one permanently pending row per condition, visible in
// wake_list. That is issue #69/#73's existing accepted shape reached by a new
// door, not a new class of problem, and it costs a row rather than a pane
// being typed into.
//
// Todo 315 added parent_timer_id, a returned id, and an explicit DELIVERY
// ACTOR, and left every other column exactly as todo 314 wrote it. The two
// todo 314 callers pass timer.owner and null, which is byte-for-byte what they
// wrote before, so nothing about their notices changes.
//
// THAT RULE IS ABOUT PAYLOAD NOTICES, and todo 321 added the exception rather
// than breaking it (counselors round 1, opus F6). A standing watch's FINISH
// notice is the wake's own payload - the roster plus the caller's body - so it
// goes where the caller said. Its BLOCK notice is a meta-notice ABOUT the wake
// ("this cannot report anything while that dialog is up"), and it goes to the
// OWNER, deliberately overriding deliver_to, because the alternative was
// measured and is worse: a wake delivered TO the blocked worker files its only
// notice at the dialogged pane, where the self-report skip drops it and nobody
// is told at all. See blockNoticeTarget.
//
// THE DELIVERY ACTOR IS A PARAMETER BECAUSE A STANDING WATCH HAS A REAL
// TARGET (counselors, both seats, P1). todo 314's notices are always "tell the
// session that set this wake", so owner and deliver_actor being the same value
// was not a choice there, it was the only thing they could be. A standing
// watch resolves a delivery target at CREATION - its own session by default,
// or deliver_to - stores it, and echoes it in the receipt, so filing its
// notices at the owner instead sends them somewhere the caller was told they
// would not go. Passing it in is what lets the two differ where they should.
function insertNotice(
  timer: TimerRow,
  deliverActor: string,
  pane: string,
  body: string,
  parentTimerId: number | null,
): number {
  return (
    stmt(
      `INSERT INTO timers (project_id, owner, body, kind, deliver_actor, deliver_pane, due_at, parent_timer_id)
       VALUES (?, ?, ?, 'delay', ?, ?, datetime('now'), ?)
       RETURNING id`,
    ).get(timer.project_id, timer.owner, body, deliverActor, pane, parentTimerId) as { id: number }
  ).id;
}

// The block-notice claim, and the reason both halves of this feature route
// through it: it is the ONE place that records "the owner has been told that
// this agent is blocked, in this episode". INSERT OR IGNORE against the
// primary key is the atomic claim (changes === 1 exactly once across every
// concurrent instance), the same discipline as claimOneShot's conditional
// UPDATE, in the shape a table takes.
//
// THE TWO PATHS MUST NOT BOTH FIRE FOR ONE BLOCK, and this is what makes that
// structural rather than an argument about ordering. A wake_when_idle
// watching the same worker it delivers to reaches them ACROSS ticks: the wide
// path speaks while the wake is not ready, and later, once some other watched
// agent goes idle, the wake becomes ready and the held-wake path sees the
// same dialog on the same pane. (Within ONE tick they can no longer both run
// - maybeFireIdle skips the wide path when the wake is ready, counselors
// round 2 - so this claim is what covers the sequence, not the instant.) Both
// compute the same (timer, agent, episode) key, so the second one loses.
//
// ACCEPTED, SELF-CLOSING (counselors round 2, opus 5 / codex 1): a session
// still running the PREVIOUS commit ticks against the new schema with old
// code, and its held-wake path has no claim here at all. It can file a narrow
// notice and leave this key unclaimed, so a new-code instance's wide path
// then files a second one about the same block. Same family as the
// mixed-version windows this file already accepts for #71 and #75, it costs a
// duplicate paragraph in a pane rather than a lost wake, and it is gone once
// every session has restarted onto this code.
function claimBlockNotice(timerId: number, agentId: number, blockedSince: string): boolean {
  return (
    stmt(
      `INSERT OR IGNORE INTO wake_block_notices (timer_id, agent_id, blocked_since)
       VALUES (?, ?, ?)`,
    ).run(timerId, agentId, blockedSince).changes === 1
  );
}

const claimModalHoldWithNotice = db.transaction(
  (timer: TimerRow, pane: string, body: string, target: { agentId: number | null; blockedSince: string }): boolean => {
    // The optimistic token is EVERY field wake_update can change, not just
    // due_at, for the reason claimOneShot's own comment gives at length
    // (counselors on this lane, opus 4 / codex 3, and it is stricter than
    // holdTimer's guard on purpose): a wake_update landing between tick()'s
    // candidates SELECT and this write leaves holdTimer recording a wrong
    // column, but would leave THIS write typing a paragraph into a human's
    // pane about a wake that is no longer due for an hour. `IS` throughout,
    // never `=`: an idle_any/idle_all timer always has a NULL due_at and a
    // one-shot always has a NULL repeat_every_ms, and `= NULL` is never true.
    const claimed =
      stmt(
        `UPDATE timers SET held_at = datetime('now'), held_reason = ?
          WHERE id = ? AND cancelled_at IS NULL
            AND due_at IS ? AND body IS ? AND repeat_every_ms IS ?
            AND (fired_at IS NULL OR repeat_every_ms IS NOT NULL)
            AND held_reason IS NOT ?`,
      ).run(
        HELD_REASON_MODAL_CHOICE,
        timer.id,
        timer.due_at,
        timer.body,
        timer.repeat_every_ms,
        HELD_REASON_MODAL_CHOICE,
      ).changes === 1;
    if (!claimed) return false;
    // The held_reason claim above is this path's own debounce and is enough
    // on its own. This second claim is the INTEGRATION with the wide path:
    // when the delivery target has an agents row, the block episode is a key
    // both paths can compute, and losing it here means the owner has already
    // been told about this exact block by the other half. Returning false
    // after the hold has been recorded is deliberate - the hold is true and
    // belongs in the row; only the notification is a duplicate.
    //
    // A target with no agents row (a plain `user:` session) has no key, so
    // there is nothing to integrate with: the wide path only ever fires for
    // WATCHED AGENTS, which by definition have rows.
    //
    // AN EMPTY blockedSince IS NOT AN EPISODE and must not be claimed
    // (counselors round 2, opus 4). src/hook.ts writes state_changed_at only
    // `WHERE ... kind = 'agent'`, so a kind='lead' or kind='command' row
    // carries NULL for its whole life and coalesces to "" here. Claimed, that
    // constant key is consumed by the FIRST modal hold on this timer and
    // never re-armed, so every later hold on the same wake would win the
    // held_reason claim, lose this one, and say nothing - the exact silence
    // this lane exists to remove, aimed at the target most likely to have a
    // dialog up (a lead's fresh pane after `hive lead` restarts it, which
    // clears held_reason and re-arms the other claim). No key means nothing
    // to integrate with, the same rule as the rowless case above.
    if (
      target.agentId !== null &&
      target.blockedSince !== "" &&
      !claimBlockNotice(timer.id, target.agentId, target.blockedSince)
    ) {
      return false;
    }
    insertNotice(timer, timer.owner, pane, body, null);
    return true;
  },
);

// The whole attempt is best-effort in exactly the sense bestEffortRun is: a
// failure anywhere here must cost the notification, never the hold and never
// the rest of this tick's candidates. Every path that does not notify falls
// through to the same holdTimer call this function replaced, so the hold
// itself behaves precisely as it did before todo 314 - including for a wake
// with nobody to tell, which is most of them.
function noteModalHold(timer: TimerRow, snapshot: AliveSnapshot | null): void {
  // Counselors, codex 4. A CONTINUING hold - the overwhelmingly common case,
  // one per held wake per tick for as long as a dialog is up - must not pay
  // for the claim at all. `.immediate()` takes the store's single
  // machine-wide writer slot, so running it before every fallback would
  // double the writer acquisitions in the hottest loop hive has to learn
  // something this tick's own SELECT already read. This is a fast path, NOT
  // the guard: the row below is what this tick read, so it can be stale, and
  // a stale one costs one no-op claim exactly as before. The atomicity that
  // makes the debounce correct across instances is still the UPDATE's own
  // WHERE and nothing else.
  if (timer.held_reason !== HELD_REASON_MODAL_CHOICE) {
    try {
      const pane = ownerPaneToTell(timer, snapshot);
      if (pane !== null) {
        const target = heldTarget(timer);
        const body = holdNoticeBody(timer, target);
        if (claimModalHoldWithNotice.immediate(timer, pane, body, target)) return;
      }
    } catch {
      // Falls through to the plain hold below.
    }
  }
  holdTimer(timer, HELD_REASON_MODAL_CHOICE);
}

// THE WIDE HALF (todo 314, amendment 1), and the reason the narrow half above
// is not the fix on its own: maybeFireIdle gates on `ready` BEFORE it ever
// consults deliverable(), and for a wake_when_idle `ready` means a watched
// agent went IDLE. A worker stopped on a dialog is `waiting`, never idle, so
// that wake never becomes due, the hold above never happens, and the owner
// hears nothing until max_wait_seconds runs out - fifteen minutes by default.
// The narrow half turns "never told" into "told late"; this one tells the
// owner while it still matters.
//
// WHY THIS IS NOT THE WITHDRAWN also_when_stuck, which fired a wake on
// `waiting` and was withdrawn because a stale `waiting` and a live one are
// byte-identical in the store. THE LATCH NEVER DECIDES ANYTHING HERE. It
// decides only whether it is worth LOOKING; the pane read is what answers. A
// worker that resumed and is busy still reads `waiting` (nothing clears that
// latch) and produces a pane with no dialog on it, so nothing is sent. The
// store is never asked to tell a stale block from a live one, which is the
// exact question it cannot answer. And no wake fires on `waiting`: the
// original wake's firing condition is untouched, so the dead-end's closing
// constraint - a wake must not fire on a state the worker will leave on its
// own within a turn - is satisfied by construction rather than by argument.
//
// The failure direction is worth stating too. A latch that is stale the OTHER
// way (a dialog raised with no Notification hook, so the row still says
// working) means hive never looks and nobody is told - silence, which is what
// this whole area did before. Staleness here can cost a notification; it can
// never manufacture one.
//
// COST. Ordered so the cheap questions kill the expensive ones:
//   1. nobody to tell -> return, having read one indexed row;
//   2. no watched agent flagged `waiting` -> return, having read one indexed
//      query that the WHERE clause filters in SQL;
//   3. already told about this agent's current block -> skip, no pane read;
//   4. only then capture the pane, through the tick's own ChoiceCache, so one
//      tick never forks twice for the same pane no matter how many wakes
//      watch it.
// Step 3 matters more than it looks: without it a permanently stuck worker
// costs a capture-pane fork every three seconds forever, which is the version
// amendment 1 exists to avoid.
//
// WHAT STEP 3 DOES NOT COVER, said plainly because the first version of this
// comment read as if it did (counselors round 2, opus 2). Only a REPORTED
// block is recorded, so an agent whose latch says `waiting` while its pane
// has NO dialog on it - a worker that answered its prompt and carried on,
// which is the ordinary stale latch this design is built to tolerate, or
// issue #38's row stuck forever - is re-read on every tick, by every running
// instance, for as long as that latch and a pending idle wake on it both
// last. That is one capture-pane fork per such agent per tick per session.
// The alternative is recording the NEGATIVE observation under the same key,
// and it was rejected rather than missed: a "looked, no dialog" row would
// suppress a REAL dialog appearing later in the same episode, trading a
// bounded cost for a silent false negative, which is the wrong direction for
// a feature whose whole point is that silence is the bug. REOPEN TRIGGER: a
// project where this fork rate is actually measured as a problem, not
// imagined - the set is bounded by watched agents with a pending idle wake,
// which is small by construction.
//
// ONE MORE HONEST LIMIT ON THE EPISODE KEY (counselors round 2, both seats).
// state_changed_at is "when the state was last WRITTEN", not "when the block
// began": src/hook.ts rewrites it on every state-writing hook, and it writes
// `waiting` for any notification hive does not recognise as idle_prompt. If
// Claude Code emits two such notifications during ONE continuous dialog, the
// key moves and the owner is told twice about one block. Unmeasured - todo
// 313's capture saw exactly one Notification per prompt across seven blocks -
// and hive pins no Claude Code version, so this is the thing to watch rather
// than a fix to build now.
//
// What the liveness filter, the claim, the pane read and the body all need,
// selected identically by both membership queries below. One list, two WHERE
// clauses, for CREW_COLUMNS' own stated reason: both produce a BlockedRow, so
// a column added to one and not the other is a silent undefined at a call site
// that reads it.
//
// THE COLUMN LIST IS CREW_COLUMNS, THE SAME ONE BOTH HALVES OF THE STANDING
// WATCH ALREADY SELECT (defined with CrewRow further down, in todo 315's
// section - the block half is a standing-watch feature now, so it reads that
// section's vocabulary rather than growing a parallel one). The claim these
// queries make is that the block half and the finish half select from the SAME
// POPULATION; a second column list and a second row type would leave that as
// prose, and the next column either half needs would have to be added twice
// with silence as the failure mode.
//
// `episode` is the alias that hides the difference, exactly as it does for the
// finish half: state_changed_at for a block, state_changed_at for an idle,
// closed_at for a death.
//
// COALESCE(state_changed_at, '') rather than a NOT NULL filter, and this is
// the same call the shipped one-shot path already made. state_changed_at is
// the block EPISODE key (wake_block_notices.blocked_since), and src/hook.ts -
// its only writer - sets it in the same statement as agent_state, so a
// `waiting` row with a NULL stamp is not a shape that writer can produce. If
// one ever appears, '' is a constant key: the first block is reported and
// later ones on that row are not. Filtering the row out instead would report
// NONE of them, and this half exists because silence is the bug.
const BLOCKED_EPISODE = `COALESCE(a.state_changed_at, '') AS episode`;

const oneShotBlockedRows = (timer: TimerRow): CrewRow[] => {
  const ids = JSON.parse(timer.watch) as number[];
  if (ids.length === 0) return [];
  return stmt(
    `SELECT ${CREW_COLUMNS}, ${BLOCKED_EPISODE}
       FROM agents a
      WHERE a.id IN (${ids.map(() => "?").join(",")})
        AND a.status = 'running' AND a.agent_state = 'waiting'`,
  ).all(...ids) as CrewRow[];
};

const standingBlockedRows = (timer: TimerRow, tellActor: string): CrewRow[] =>
  stmt(
    `SELECT ${CREW_COLUMNS}, ${BLOCKED_EPISODE}
       FROM agents a
      WHERE a.project_id = ? AND a.kind = 'agent' AND a.status = 'running' AND a.actor_id != ?
        AND a.agent_state = 'waiting'
      ORDER BY a.id`,
  ).all(timer.project_id, tellActor) as CrewRow[];

// TODO 321: MEMBERSHIP IS THE WATCH'S OWN, WHICH IS WHAT MAKES THIS HALF WORK
// FOR A STANDING WATCH AT ALL. This used to be `JSON.parse(timer.watch)` and
// nothing else, returning [] for an empty list - and a standing watch stores
// watch='[]' because its MEMBERSHIP IS A QUERY rather than a list, which is a
// consequence of the design and not a protection anyone chose. (An earlier
// version of this comment called the empty list "load-bearing for
// mixed-version safety". That is FALSE and src/db.ts's own watch_scope
// migration says so in terms: what stops an old scheduler firing such a row
// early is maybeFireIdle's `states.length > 0` guard, which predates all of
// this. Read that paragraph before restating the claim - it corrected the
// same error once already, and this lane reintroduced it from its own brief.)
// So the whole half was STRUCTURALLY DEAD for a standing watch: a
// crew member sitting on a permission prompt is `waiting`, never idle, so the
// finish half cannot see it either, and the owner heard nothing until the
// watch expired - four hours by default. A lead that takes the advice this
// project now gives (one standing watch instead of N one-shots) lost a signal
// it had before.
//
// TWO WHERE CLAUSES SHARING ONE COLUMN LIST, not one clause with a scope
// branch inside it, which is CREW_COLUMNS' own split and for its reason: the
// two are allowed to differ only in which rows they select, so the column list
// is shared to make a divergence impossible, while the predicates stay
// separately readable. The standing clause is standingIdleRows' predicate with
// one substitution: agent_state 'waiting' where the finish half reads 'idle'.
//
// THEY ARE NOT ONE POPULATION, and an earlier version of this comment claimed
// they were (counselors round 1, codex 5b). The two exclude DIFFERENT actors -
// this half excludes the actor being TOLD, which blockNoticeTarget resolves
// owner-first, while the finish half excludes timer.deliver_actor - so they
// diverge exactly when owner != deliver_actor. That is correct in both places
// and for the same underlying rule (never tell a session about itself), but it
// means the shared column list is what is guaranteed here, not the row set.
//
// kind = 'agent' carries standingIdleRows' reasoning unchanged: src/hook.ts's
// agent_state UPDATE is scoped to kind='agent' (.claude/rules/worker-state.md),
// so a lead or a kind='command' row can never be `waiting` in the first place,
// and an allowlist means a future third kind defaults to silence.
//
// THE EXCLUDED ACTOR IS THE ONE BEING TOLD, not the wake's owner and not
// unconditionally its deliver_actor. standingIdleRows' comment states the rule
// ("a session is never told about itself, and the session being told is the
// delivery target"); since blockNoticeTarget resolves the owner FIRST here,
// the actor that satisfies that rule is whichever one it picked. The pane skip
// in noteBlockedWatched is the same rule reached by value, and it is kept for
// the case the actor check cannot see: two actors whose rows name one pane.
//
// A one-shot's list is NOT filtered by any of this. It is an explicit set the
// caller named, so a caller watching a lead-kind row, or its own delivery
// target, gets exactly what it asked for and the pane skip is the only guard -
// byte-identical to what shipped.
function blockedWatchedAgents(
  timer: TimerRow,
  snapshot: AliveSnapshot,
  tellActor: string,
): { id: number; name: string; pane: string; socket: string; blockedSince: string }[] {
  const rows = isStandingWatch(timer) ? standingBlockedRows(timer, tellActor) : oneShotBlockedRows(timer);
  return rows
    // Issue #73's discipline, the same one watchedTail applies before its own
    // capture: never read a pane on a socket this process cannot see into,
    // and treat unknown as "no fact" rather than as a live pane.
    .filter((r) => rowAlive(r.tmux_socket, r.tmux_target, snapshot) === true)
    .map((r) => ({
      id: r.id,
      name: r.name,
      pane: r.tmux_target,
      socket: r.tmux_socket,
      blockedSince: r.episode,
    }));
}

// The optimistic token this path needs, and counselors round 2 (opus 1) is
// right that it had none at all. Nothing else here re-reads the timer: this
// tick's candidates SELECT can be many timers and several of deliver()'s real
// 300ms Enter sleeps old by the time this runs, so a concurrent instance can
// have fired the wake, or wake_cancel can have cancelled it, in between. The
// held-wake path carries the full wake_update guard for exactly this reason;
// this one asks the narrower question that matches what its body claims -
// that the wake is still pending - inside the same transaction as the claim.
const stillPending = (timerId: number): boolean =>
  stmt(
    `SELECT 1 AS hit FROM timers WHERE id = ? AND cancelled_at IS NULL AND fired_at IS NULL`,
  ).get(timerId) !== undefined;

const claimBlockNoticeWithNotice = db.transaction(
  (
    timer: TimerRow,
    agentId: number,
    blockedSince: string,
    tell: { actor: string; pane: string },
    body: string,
  ): boolean => {
    if (!stillPending(timer.id)) return false;
    if (!claimBlockNotice(timer.id, agentId, blockedSince)) return false;
    insertNotice(timer, tell.actor, tell.pane, body, null);
    return true;
  },
);

// ONE NOTICE PER TICK FOR THE STANDING HALF, not one per blocked worker
// (lead review of todo 321 step 1), and it is claimStandingBatch's shape with
// the same reasoning behind it. Todo 315 had to build "a batch identity across
// agents" precisely because project scope removed the bound the one-shot's
// explicit list gave it, and this half inherited the scope without inheriting
// the batching. A notice is delivered by a PASTE into a pane, so three crew
// members blocked in one tick was three pastes and three user turns in a
// lead's session about one situation.
//
// THE CASE THAT DECIDED IT IS NOT THE RARE ONE. "Three workers hit a prompt in
// the same three-second tick" sounds unlikely; "a lead sets a standing watch
// while two workers are ALREADY sitting on prompts" is ordinary, and it is the
// identical shape - the first tick of a fresh watch sees the whole blocked
// crew at once. Measured while building this lane: one standing watch filed
// four block claims off a project whose crew had been left latched.
//
// THE ONE-SHOT PATH IS NOT BATCHED, and that asymmetry is the point rather
// than an oversight. Its membership is a list the caller wrote, so its notice
// count is bounded by what the caller asked for; project scope is what removed
// that bound. It also has to stay unchanged this lane
// (test/wake-hold-notify.test.mjs's three todo 314 fixtures assert its body
// and its per-wake counts), and there is no reader complaining about it.
//
// "UNCHANGED" MEANS ITS BODY AND ITS PER-WAKE COUNTS, NOT ITS TIMING
// (counselors round 1, opus F2). recentlyHadNoDialog sits in the SHARED loop
// above, so the 30-second bound applies to the one-shot half too: its block
// notice can now arrive up to 30s after the dialog goes up where it used to
// arrive on the first tick that saw it. That is a real behaviour change to a
// path this comment otherwise calls untouched, and it is deliberate - the
// bound is worth more than 27 seconds of latency on a dialog a human will take
// minutes to answer.
//
// WHAT BATCHING WIDENS, stated rather than discovered later: todo 314 accepted
// that a claim records "a notice was FILED", not "the owner was told", and a
// batch makes one lost notice cost N reports instead of one. The finish half
// buys its way out with wake_idle_notices.notice_timer_id and the
// NOTICE_RETRY_AFTER re-arm; wake_block_notices has no such column, and adding
// one is a migration for a residual todo 314 already accepted knowingly. The
// LOSS PATHS ARE MORE THAN ONE, and an earlier version of this comment named
// only a throwing sendText (counselors round 1, opus F4/codex 2). The second
// is already written down 400 lines above, at claimModalHoldWithNotice: a
// notice whose pane dies before its first delivery is CANCELLED by
// deliverable() for a non-lead target, and the janitor's timers sweep reaches
// it too, with nothing retrying either. With a batch that is N reports rather
// than one. The
// exposure is bounded the same way it is there: the notice is an ordinary
// timer row, so it holds rather than dying when the owner's pane is busy, and
// the only way to lose it is a throwing sendText.
const claimBlockBatch = db.transaction(
  (
    timer: TimerRow,
    tell: { actor: string; pane: string },
    blocked: { id: number; name: string; blockedSince: string }[],
  ): boolean => {
    if (!stillPending(timer.id)) return false;
    // Claim every one of them, then render the body from the WINNERS ONLY:
    // another instance may have claimed some of these in the same tick, and a
    // notice naming a worker this row did not win is a duplicate paragraph
    // about a block someone else has already reported.
    const won = blocked.filter((a) => claimBlockNotice(timer.id, a.id, a.blockedSince));
    if (won.length === 0) return false;
    insertNotice(
      timer,
      tell.actor,
      tell.pane,
      standingBlockNoticeBody(
        timer,
        won.map((a) => a.name),
      ),
      null,
    );
    return true;
  },
);

// Never throws, for the same reason nothing else in this file does: this runs
// inside tick()'s candidate loop, and an exception escaping here would cost
// every timer after it in the tick. It also writes nothing to the timer
// itself - not held_at, not held_reason, not fired_at - because this wake is
// neither due nor held, and marking it either would make wake_list and `hive
// status` report a delivery hive never attempted.
function noteBlockedWatched(timer: TimerRow, snapshot: AliveSnapshot, choices: ChoiceCache): void {
  try {
    const tell = blockNoticeTarget(timer, snapshot);
    if (tell === null) return;
    const tellPane = tell.pane;
    const batched: { id: number; name: string; blockedSince: string }[] = [];
    for (const agent of blockedWatchedAgents(timer, snapshot, tell.actor)) {
      // Telling a session about its own pane, reached here through the watch
      // list rather than through delivery: a session watching itself would
      // otherwise be told to answer the dialog it is looking at, by a paste
      // into that dialog.
      //
      // A CHAIN IS IMPOSSIBLE ON THIS PATH regardless, and structurally so -
      // but the FACT that makes it structural changed in todo 321 while the
      // conclusion did not, so read the reason rather than the shape. It used
      // to be "a notification carries the default EMPTY WATCH LIST, so
      // blockedWatchedAgents answers [] for it". An empty watch list is
      // exactly what stopped meaning "watches nothing" in this lane: for a
      // standing row it means "ask the project". What holds now is that
      // insertNotice sets neither watch nor watch_scope, and src/db.ts
      // declares watch NOT NULL DEFAULT '[]' and watch_scope NULLABLE with no
      // default - so a notice row carries watch_scope IS NULL, isStandingWatch
      // is false for it, and it stays on the id-IN branch with an empty list.
      // That, plus kind 'delay' keeping it out of maybeFireIdle entirely, is
      // two independent reasons. Pinned by the watch_scope assertion inside
      // test/wake-hold-notify.test.mjs's "files a block notice for a crew
      // member it never had in a watch list" - an earlier version of this
      // comment cited that assertion's own MESSAGE as if it were the test's
      // name, which is a citation the next reader cannot follow.
      if (agent.pane === tellPane) continue;
      if (alreadyToldAbout(timer.id, agent.id, agent.blockedSince)) continue;
      // The last cheap question before the only expensive one, and it is
      // asked for BOTH watch shapes on purpose: a one-shot's set is small by
      // construction (todo 314's own acceptance) but never zero-cost, and one
      // loop with one rule beats a bound that applies to whichever branch
      // someone remembered.
      //
      // IT SITS BELOW alreadyToldAbout AND NOT ABOVE IT, which /simplify
      // reads as backwards - a Map hit is cheaper than the SQLite read above
      // it, so cost-ordering alone says swap them. THE LADDER IS ORDERED BY
      // WHAT A RUNG PROVES, not only by what it costs. alreadyToldAbout
      // answers "should this be reported at all", which is the question this
      // loop exists to answer; this one answers only "is it worth looking
      // right now", which is a cost decision about an answer that may already
      // be irrelevant. The swap is behaviour-preserving (both only skip) and
      // buys a primary-key seek, three orders of magnitude below the 3.5ms
      // fork both rungs exist to avoid - so it moves a rung of a ladder whose
      // order is meaning in exchange for nothing measurable. Measured and
      // declined, twice, rather than not noticed.
      if (recentlyHadNoDialog(agent.socket, agent.pane)) continue;
      const choice = awaitingChoice(agent.pane, choices);
      if (choice !== true) {
        // Only a definite `false` is a fact worth remembering. null is an
        // unanswered probe.
        if (choice === false) rememberNoDialog(agent.socket, agent.pane);
        continue;
      }
      // EVERY PANE IS READ BEFORE THE TRANSACTION OPENS. The batch below takes
      // SQLite's single machine-wide writer slot, and .claude/rules/store-and-
      // datadir.md's rule for that slot is tmux forks only, only fast ones -
      // a capture-pane per crew member inside it would hold every hive process
      // on the machine for as long as the crew is big.
      if (isStandingWatch(timer)) {
        batched.push(agent);
        continue;
      }
      claimBlockNoticeWithNotice.immediate(
        timer,
        agent.id,
        agent.blockedSince,
        tell,
        blockNoticeBody(timer, agent.name),
      );
    }
    if (batched.length > 0) claimBlockBatch.immediate(timer, tell, batched);
  } catch {
    // Reporting about a block, never the block itself: same precedent as
    // holdTimer's own write and src/hook.ts's record().
  }
}

// The cheap half of the claim, run before the pane fork. The claim itself is
// still the authority - this is a read, so it can be stale, and a stale one
// costs one wasted fork and then loses the INSERT OR IGNORE.
function alreadyToldAbout(timerId: number, agentId: number, blockedSince: string): boolean {
  return (
    stmt(
      `SELECT 1 AS hit FROM wake_block_notices
        WHERE timer_id = ? AND agent_id = ? AND blocked_since = ?`,
    ).get(timerId, agentId, blockedSince) !== undefined
  );
}

// ===========================================================================
// TODO 315, THE STANDING WATCH.
//
// wake_when_idle is a one-shot: it fires once and stops watching. Between the
// fire and a re-arm nobody is watched, and the re-arm depends on the lead
// remembering. Observed with ONE worker and an attentive lead on 2026-08-08;
// at the three to five workers this tool is run with elsewhere it is close to
// a guarantee that a finish goes unseen. A standing watch never fires itself.
// It stays a candidate for its whole life and, on each tick, FILES a due-now
// notice to its owner naming every crew member that has finished or gone away
// since it last spoke.
//
// THE MECHANISM IS TODO 314's, POINTED AT A SECOND CONDITION, and the pieces
// that carry over are named so the next reader does not look for a second
// design: the atomic claim (INSERT OR IGNORE against a primary key), the
// read-gate in front of that claim so the common case never takes SQLite's
// single machine-wide writer slot, and delivery through a real timer row so
// no FIFTH path types into a pane (.claude/rules/tmux-and-panes.md). What
// todo 314 does NOT supply, and what the rest of this section is, is: a batch
// identity across agents, a cursor that survives a delivery failure, a parent
// link, a lifetime, a key for a worker that DIES, and the discrimination
// between a block notice and a finish notice.
//
// WHAT THIS IS NOT: the withdrawn also_when_stuck
// (.claude/sessions/dead-ends/2026-07-29-also-when-stuck-on-latched-waiting.md).
// That design fired on `waiting`, a latch nothing clears, so a stale block and
// a live one were byte-identical in the store. Nothing here fires on
// `waiting` at all. It fires on `idle`, which src/hook.ts writes on a Stop
// hook and then MOVES again on the next prompt, so the store is never asked to
// tell a stale one from a live one - and the /goal discriminator below is
// there precisely because the one case where `idle` CAN be restated without a
// real transition is the one case this design must not trust.
// ===========================================================================

const CONDITION_IDLE = "idle";
const CONDITION_GONE = "gone";

// A claim records "a notice was FILED", not "the owner was told" - counselors
// C3 on this design, and todo 314 accepted exactly this residual for a
// stuck-worker notice. THE ACCEPTANCE DOES NOT TRANSFER, because the thing
// lost here is the finish this whole feature exists to report. So a claim
// whose notice was spent WITHOUT EVER BEING TYPED - fired_at set (a claim
// committed), typed_at still NULL (sendText threw), not cancelled - stops
// counting as "already told" and the episode is reported again.
//
// THE AGE BOUND IS WHAT MAKES THAT SAFE ACROSS INSTANCES. Delivery is not
// atomic with the claim: instance A claims a notice and types it 300ms later
// (sendText's own ENTER_DELAY_MS), and instance B ticks in that gap. Without
// a bound, B would read a perfectly healthy in-flight delivery as failed and
// file a duplicate.
//
// WHAT SIXTY SECONDS HAS TO CLEAR, stated at the real worst case rather than
// the happy one. The claim-to-typed path is a handful of tmux forks plus
// sendText's own 300ms ENTER_DELAY_MS, which is milliseconds - but it can also
// queue behind SQLite's single machine-wide writer slot, and db.ts sets
// busy_timeout to FIVE SECONDS, so the bound this must sit above is seconds,
// not milliseconds. An earlier version of this comment said "two orders of
// magnitude above the whole claim-to-typed path", which is true only of the
// uncontended case and is the kind of margin that reads as proven and is not.
// Sixty seconds is an order of magnitude above the contended one. An in-flight
// notice cannot be re-armed, and a genuinely dead one is repaired within a
// minute.
//
// A HELD notice is NOT re-armed and needs no special case: deliverable()
// holds ABOVE claimOneShot, so a notice waiting on a dialogged owner pane has
// fired_at NULL and never matches this at all.
const NOTICE_RETRY_AFTER = "-60 seconds";

// The valid-until half of the parent link (counselors C4). wake_cancel now
// cascades to a watch's filed notices, but cancellation is not the only way a
// notice goes stale: `hive lead` re-points EVERY active lead-owned timer at
// the fresh pane on restart (src/cli.ts), and a lead-owned notice held on a
// dead pane is exempt from the janitor's cancel sweep, so one can sit pending
// indefinitely and then be delivered days later into a session that has moved
// on. An hour is well past any lane that a "worker X just finished" sentence
// is still true for, and this bound applies ONLY to rows that carry a parent
// - todo 314's notices have none, so their behaviour is untouched.
const NOTICE_MAX_AGE = "-1 hours";

// How many still-running crew members the roster names before summarising.
// The point of naming them at all is that a lead reading "2 finished" wants
// to know what is left without asking, which is the reason it stops polling;
// past a handful it is a wall of text pasted into a terminal.
const ROSTER_STILL_GOING = 8;

// The note delivered when the lifetime runs out. A silent expiry is the
// original bug with a timer on it - watched, then quietly not, with nothing
// saying so - so the expiry SPEAKS, through the existing max-wait branch.
const STANDING_EXPIRED_NOTE =
  "this standing watch has expired and nothing is watching now; set a new one if the crew is still working";

// The cursor read, stated once and shared by both conditions. It is a
// read-gate, not the authority: the claim below is, and a stale read here
// costs one losing INSERT OR IGNORE rather than a wrong answer. The
// join-and-NOT clause is the delivery-failure re-arm described at
// NOTICE_RETRY_AFTER; a row with no notice_timer_id yet (claimed inside a
// transaction that has not filed its notice) reads as reported, which is
// correct - it is about to be.
const unreported = (condition: string, episode: string): string => `NOT EXISTS (
    SELECT 1 FROM wake_idle_notices n LEFT JOIN timers nt ON nt.id = n.notice_timer_id
     WHERE n.timer_id = ? AND n.agent_id = a.id AND n.condition = '${condition}' AND n.episode = ${episode}
       AND NOT (nt.fired_at IS NOT NULL AND nt.typed_at IS NULL AND nt.cancelled_at IS NULL
                AND nt.fired_at < datetime('now', '${NOTICE_RETRY_AFTER}')))`;

// What stateNowClause needs plus what the liveness filter and the claim need,
// selected identically by both membership queries below. One list rather than
// two, because the two are only allowed to differ in the WHERE clause: they
// both produce a CrewRow, so a column added to one and not the other is a
// silent undefined at a call site that reads it.
//
// `episode` is aliased per query - state_changed_at for a finish, closed_at
// for a death - which is exactly the difference the alias exists to hide from
// everything downstream.
const CREW_COLUMNS =
  `a.id, a.name, a.actor_id, a.tmux_target, a.tmux_socket, a.agent_state,
   a.state_changed_at, a.status, a.command, a.kind`;

interface CrewRow {
  id: number;
  name: string;
  actor_id: string;
  tmux_target: string;
  tmux_socket: string;
  agent_state: string;
  state_changed_at: string | null;
  status: string;
  command: string;
  kind: string;
  episode: string;
}

// No `episode` of its own: it is always the row's, and a second copy is a
// second thing that can disagree with the value actually written to the
// cursor.
interface StandingCandidate {
  condition: string;
  row: CrewRow;
}

// THE MEMBERSHIP QUERY, AND IT HAS NO BRANCH IN IT. Scope is a parameter with
// one value today; if you are about to add a second membership shape here,
// read comment 631 on todo 315 first - groups are blocked on agent labels
// that do not exist AND on an undecided overlap-dedup rule, and neither is
// smuggled in as a WHERE clause.
//
// kind = 'agent': a lead writes no agent_state at all (src/hook.ts's UPDATE
// is scoped to kind='agent', .claude/rules/worker-state.md), so a lead could
// never be reported idle, and a kind='command' background process is not a
// worker anyone is waiting on. This is the same allowlist hook.ts uses, for
// the same reason: a future third kind defaults to silence.
//
// a.actor_id != the watch's DELIVERY ACTOR, not its owner: the exclusion
// exists so a session is never told about itself, and the session being told
// is the delivery target. Those are the same actor for the ordinary lead
// watching its own crew; they differ the moment deliver_to names a crew
// member, and it is that case the exclusion is actually for - a worker being
// told it went idle, by a paste into the pane it is reading from.
function standingIdleRows(timer: TimerRow): CrewRow[] {
  return stmt(
    `SELECT ${CREW_COLUMNS}, a.state_changed_at AS episode
       FROM agents a
      WHERE a.project_id = ? AND a.kind = 'agent' AND a.status = 'running' AND a.actor_id != ?
        AND a.agent_state = 'idle' AND a.state_changed_at IS NOT NULL
        AND ${unreported(CONDITION_IDLE, "a.state_changed_at")}
      ORDER BY a.id`,
  ).all(timer.project_id, timer.deliver_actor, timer.id) as CrewRow[];
}

// A WORKER THAT DIED, and this is the case project scope makes worse rather
// than better. Under the explicit-list wake this replaces, a watched worker
// that goes away still fires: it is still IN the list, and watchedStates
// answers GONE for it. Under project scope, membership is a query over
// RUNNING agents, so a dead worker does not merely lack a fresh latch - it
// DROPS OUT OF THE SET ENTIRELY and there is nothing left to ask about. That
// would be a strict regression on the exact case that makes watching from
// outside worth doing at all: a turn that dies mid-response (issue #38) is
// precisely the worker that cannot report itself.
//
// closed_at is the key, because it is the only value that moves. GONE's own
// `since` is null by construction, and agent_close/closeAgentRow never touch
// state_changed_at - src/hook.ts is its only writer. Re-arm is by
// construction too: a replacement worker is a new agents row with a new id,
// so its own death is a new key with nothing to clear.
//
// A DEATH BEFORE THE WATCH EXISTED IS NOT NEWS, and the way that bound is
// drawn is the fix rather than a preference (counselors, codex P2). It used to
// be `closed_at >= the watch's created_at`, and BOTH stamps are whole seconds
// (datetime('now')): a worker closed at 12:00:00.100 and a watch created at
// 12:00:00.900 store the identical value, so an already-dead worker was
// reported on the first tick despite the bound. Flipping to `>` is not the
// fix and was worked through before being rejected - it loses the opposite
// case, a worker that died 0.8s AFTER the watch was set, one the receipt had
// just named in watching_now, so the lead believed it was watched. Losing a
// real death is the worse direction.
//
// SO THERE IS NO TIMESTAMP COMPARISON HERE AT ALL. seedGoneCursor below runs
// in the same transaction as the watch's INSERT and writes a cursor row for
// every already-closed worker in the project, so "already dead when this
// watch was set" is a FACT RECORDED AT CREATION rather than a bound
// re-derived on every tick at a resolution that cannot carry it. Anything
// closed and not in the cursor is news, at any resolution. This deletes a
// class of reasoning instead of tuning it, which is why it is worth an
// INSERT..SELECT over a bounded set at creation.
//
// A CLOSE FROM `idle` IS NOT A DEATH, and this discriminator is what stops
// the intended loop from alarming (counselors, both seats). Worker finishes ->
// idle notice -> lead reads it, completes the todo, calls agent_close: without
// this the next tick files a SECOND notice about the same worker, saying it
// went away and its unwritten work is lost. At three to five workers that is
// two notices per worker lifecycle, half of them frightening and wrong, and
// the standing watch does it per close where the one-shot did it once.
//
// WHY THE ROW'S OWN STATE CAN ANSWER THAT. src/hook.ts is the ONLY writer of
// agents.agent_state (.claude/rules/worker-state.md, "enumerate every writer
// before picking one" - checked, not assumed: closeAgentRow in src/spawn.ts
// writes status and closed_at and never this column). So a closed row's state
// is FROZEN at whatever the worker last reported on its way out. `idle` means
// it had finished and this watch has already said so; `working` or `waiting`
// is the real death this half exists for - the turn that died mid-response
// (issue #38), which is precisely the worker that cannot report itself.
// An uninstrumented row reads 'unknown', which is not 'idle', so it still
// reports: the conservative direction, and it is safe from the NULL trap that
// silently inverts `!=` because src/db.ts declares this column NOT NULL
// DEFAULT 'unknown'.
//
// THE RESIDUAL, WHICH IS A JUDGEMENT AND NOT AN OVERSIGHT: a worker that goes
// idle and whose row closes before any tick REPORTED that idle is now silent
// - the pane died within the same three-second tick, say. The tighter-looking
// fix is to key on the cursor instead ("suppress only if we already filed an
// idle notice for its current episode"), and it is WRONG in two directions
// that matter more. The idle half is gated on a non-null tmux snapshot, so
// where the probe persistently fails no idle is ever reported, no cursor row
// exists, and every deliberate close alarms again - this defect back in full,
// in the exact environment the gone half was built to keep answering in. And
// a worker that finished, was told about, was sent more work and THEN died
// mid-turn has a cursor row from its earlier finish, so the cursor rule
// silences the issue #38 death this half exists to catch. Do not swap them.
//
// NO TMUX IS CONSULTED HERE, deliberately. The idle half needs the snapshot
// (a running row whose pane is dead should not be believed about its state),
// but this half is a store-and-clock question, so it still answers when the
// tmux probe cannot - which is a partial answer to the hole where a null
// snapshot means the standing watch observes nothing and says nothing. The
// janitor is what turns a dead pane into a closed row, so under a persistent
// null snapshot this reports only explicit closes; that is strictly more than
// silence, not a claim that it covers the case.
function standingGoneRows(timer: TimerRow): CrewRow[] {
  return stmt(
    `SELECT ${CREW_COLUMNS}, a.closed_at AS episode
       FROM agents a
      WHERE a.project_id = ? AND a.kind = 'agent' AND a.status = 'closed' AND a.actor_id != ?
        AND a.agent_state != 'idle'
        AND a.closed_at IS NOT NULL
        AND ${unreported(CONDITION_GONE, "a.closed_at")}
      ORDER BY a.id`,
  ).all(timer.project_id, timer.deliver_actor, timer.id) as CrewRow[];
}

// The other half of the bound above, run ONCE, inside the same transaction as
// the watch's own INSERT (src/tools/wakes.ts) so a worker cannot die in the
// gap between them and be counted as history.
//
// A seeded row carries notice_timer_id NULL, and that is exactly right rather
// than a placeholder: the read-gate reads a NULL notice as "reported" (there
// is no spent claim to re-arm from), and the claim's re-arm DELETE fires only
// when notice_timer_id IS NOT NULL, so a seeded row is never deleted and
// never re-armed. It simply says "this death is not this watch's news".
//
// DELIBERATELY A SUPERSET of what standingGoneRows can return - it does not
// repeat that query's deliver_actor or agent_state filters - because its job
// is to suppress, and suppressing a row the reader would have skipped anyway
// costs one row and cannot go wrong. Repeating the filters would make two
// queries that have to agree forever.
//
// ONLY 'gone'. There is no matching seed for 'idle', and adding one would
// silently revert decision A (todo 315 comment 638): a worker already idle
// when the watch was set IS reported on the first tick, on purpose, because
// that is the finish the one-shot loses.
//
// The one case it does not cover: LOG_RETENTION eventually prunes cursor rows,
// so a watch whose caller asked for a lifetime longer than that could see a
// seeded row expire and report an ancient death. The default lifetime is four
// hours against a seven-day retention, and every other cursor row in this
// table has the same property.
export function seedGoneCursor(timerId: number, projectId: number): void {
  stmt(
    `INSERT OR IGNORE INTO wake_idle_notices (timer_id, agent_id, condition, episode)
       SELECT ?, a.id, '${CONDITION_GONE}', a.closed_at
         FROM agents a
        WHERE a.project_id = ? AND a.kind = 'agent' AND a.status = 'closed'
          AND a.closed_at IS NOT NULL`,
  ).run(timerId, projectId);
}

// THE CURSOR CANNOT BE "THE TIMESTAMP MOVED", and this is the finding that
// most shapes this design (counselors C6). src/hook.ts writes
// `agent_state = ?, state_changed_at = datetime('now')` in one UPDATE
// whenever stateFor returns non-null - INCLUDING when the state it is writing
// is the one already there. Under a /goal, Claude Code fires Stop after every
// turn while immediately starting another, and .claude/rules/worker-state.md
// records nine consecutive false idles on agent:53 in fifty seconds with no
// prompt|working between them. Each one is a NEW timestamp, so each is a
// fresh key. A one-shot can emit at most one wake from that; a standing watch
// would emit nine and keep going.
//
// So the question is not "is this timestamp new" but "did this agent enter
// idle FROM something else". agent_state_log answers it: it is append-only,
// carries the event that decided each state, and is the reader this project
// already reaches for when a latch cannot be trusted
// (.claude/sessions/decisions/2026-07-29-append-only-state-transition-log.md).
// Used as a DISCRIMINATOR, not as the cursor - as the cursor it would
// re-report every false idle issue #24 produced, because the log records them
// and the latch self-corrects.
//
// TWO PLACES THIS DELIBERATELY FAILS OPEN, and both are the same rule: for a
// feature whose entire defect is silence, an unanswerable question must
// resolve to "report it".
//   - NO PREVIOUS EPISODE. There is no interval to look in, so there is
//     nothing to discriminate, and the first tick of a standing watch reports
//     a worker that was ALREADY idle when it was set. That is a deliberate
//     difference from mode=any's `state_changed_at >= timers.created_at`
//     test, decided on todo 315 (comment 638, decision A) rather than
//     inherited: that test is listed in the todo's own body as one of the
//     three ways the one-shot fails at N workers, and a design that fixes two
//     of three and re-ships the third is not the fix. The asymmetry decides
//     it - reporting a stale idle costs ONE EXTRA LINE in a notice; not
//     reporting it costs a silently missed finish.
//   - THE LOG CANNOT ANSWER FOR THIS INTERVAL, because retention truncated
//     its start. This is the case the FIRST version of this function got
//     wrong, and counselors found it on both seats. It failed open only when
//     the log held NO row after the previous episode - and pruneStateLog
//     deletes a PREFIX (`WHERE id <= hi - LOG_MAX_ROWS`, and by age), which is
//     the one shape that cannot produce. A prefix delete removes the OLDER
//     prompt|working row and KEEPS the newer stop|idle row, so the probe below
//     found no work, returned false, and the finish was lost for the watch's
//     whole life while wake_list showed it healthy. The test seeded a store
//     with zero log rows, pinning the unreachable branch.
//     THE CONDITION THAT ACTUALLY DECIDES IT is whether the log still covers
//     the interval's own start: if the oldest surviving row in the whole table
//     is NEWER than the previous episode, everything this probe would have
//     needed has been pruned, and the answer is unknowable. Global rather than
//     per-actor deliberately - the row-count bound deletes across every actor
//     by id, so an unrelated actor's churn is what evicts a quiet worker's
//     evidence, and a per-actor MIN would read a quiet worker's natural
//     silence as truncation. Indexed by idx_agent_state_log_created, so it is
//     a seek, and it REPLACES the old probe rather than adding a read.
//     THE OTHER DIRECTION IS NOW TIGHTER, and that is deliberate too
//     (counselors, codex P2): an INTACT log that simply records no work is
//     evidence, not absence of it, so a latch that moved with nothing logged
//     behind it is no longer reported as a finish. Untrusted log -> report;
//     trusted log with no work in it -> stay quiet.
//
// The upper bound is `< episode + 1 second`, not `<= episode`, because
// state_changed_at is whole seconds (datetime('now')) while this log carries
// milliseconds: a working row at 12:00:05.100 and an idle latch stamped
// 12:00:05 are a real transition that a plain `<=` would discard.
function idleIsAFreshTransition(timerId: number, row: CrewRow): boolean {
  const previous = (
    stmt(
      `SELECT MAX(episode) AS episode FROM wake_idle_notices
        WHERE timer_id = ? AND agent_id = ? AND condition = '${CONDITION_IDLE}'`,
    ).get(timerId, row.id) as { episode: string | null }
  ).episode;
  if (previous === null) return true;
  // THE SAME WHOLE-SECOND-VERSUS-MILLISECONDS TRAP the upper bound above
  // dodges, and it bit this check on its first version. `previous` is an
  // episode, i.e. a state_changed_at, written by datetime('now') in whole
  // seconds; this log's created_at carries milliseconds. The row that RECORDED
  // that episode therefore reads as newer than the episode itself, so a plain
  // `oldest > previous` calls a perfectly intact log truncated whenever its
  // oldest surviving row is the previous episode's own event - which is every
  // young store, and which silently turned the /goal suppression back off. The
  // bound is the END of previous's own second: a log starting inside that
  // second still covers the interval.
  const log = stmt(
    "SELECT MIN(created_at) AS oldest, datetime(?, '+1 seconds') AS bound FROM agent_state_log",
  ).get(previous) as { oldest: string | null; bound: string };
  if (log.oldest === null || log.oldest >= log.bound) return true;
  return (
    stmt(
      `SELECT 1 AS hit FROM agent_state_log
        WHERE actor_id = ? AND state IN ('working', 'waiting')
          AND created_at > ? AND created_at < datetime(?, '+1 seconds') LIMIT 1`,
    ).get(row.actor_id, previous, row.episode) !== undefined
  );
}

// A ROSTER, NOT AN EVENT, and the still-going half is what makes a batched
// body worth more than one line per worker: it is the crew status, which is
// the thing that removes the reason to poll in the first place.
//
// NOT `watch` REUSED (counselors C9). A notice carries the default EMPTY
// watch list, so deliver()'s watchedTail() answers "" for it and no
// capture-pane runs. Putting the crew in a notice's watch list instead would
// embed up to three worker SCREENS in a body typed into the lead's own pane,
// plus three tmux forks per notice in the hottest loop hive has - the exact
// outcome a compact roster exists to avoid.
//
// Wake bodies are delivered VERBATIM into a terminal
// (.claude/rules/worker-state.md), so this is written to stand on its own for
// a reader with none of the context that produced it: what happened, what is
// still running, what to read before acting, and how to stop it.
function standingNoticeBody(timer: TimerRow, finished: StandingCandidate[]): string {
  const lines = [
    `${finished.length} worker(s) in this project have finished or gone away since standing watch ` +
      `#${timer.id} last spoke:`,
  ];
  for (const c of finished) {
    lines.push(
      c.condition === CONDITION_GONE
        ? // WHAT HIVE OBSERVED, NOT WHAT IT INFERS WAS LOST. The gone half now
          // only fires for a row frozen mid-work (see standingGoneRows), so a
          // stronger sentence would be defensible - and it still must not be
          // written, because "its work is lost" is a claim about a branch, a
          // todo and a pad that this code has not looked at, and a notice that
          // asserts a fact hive cannot see is the shape
          // .claude/rules/worker-state.md rules out. Two observations and a
          // next action instead.
          `  ${c.row.name}: GONE - hive last read it as ${c.row.agent_state}, and its row was closed at ` +
          `${c.row.episode}, so there is no terminal left to read. Check its branch, its todo and any pad it ` +
          "was writing for what landed before it stopped."
        : `  ${c.row.name}: ${stateNowClause(c.row)}`,
    );
  }
  let shown: string[] = [];
  let more = 0;
  let asked = false;
  try {
    // Exactly the columns stateNowClause reads, and typed as those - the cast
    // used to claim a whole CrewRow, four fields of which this query does not
    // select at all, so a future reader could take id or tmux_target off it
    // and get undefined with the compiler agreeing.
    const rows = stmt(
      `SELECT a.name, a.actor_id, a.agent_state, a.state_changed_at, a.status, a.command, a.kind
         FROM agents a
        WHERE a.project_id = ? AND a.kind = 'agent' AND a.status = 'running'
          AND a.agent_state != 'idle' AND a.actor_id != ?
        ORDER BY a.id`,
    ).all(timer.project_id, timer.deliver_actor) as {
      name: string;
      actor_id: string;
      agent_state: string;
      state_changed_at: string | null;
      status: string;
      command: string;
      kind: string;
    }[];
    // SLICE BEFORE MAPPING. stateNowClause runs its own lastLogEvent query per
    // agent, so rendering the whole crew and then keeping eight throws away a
    // SELECT per worker past the cap - paid on every notice, in a project big
    // enough for the cap to matter, for text nobody reads. The full count is
    // still needed for "and N more", which is why the query keeps no LIMIT.
    more = Math.max(0, rows.length - ROSTER_STILL_GOING);
    shown = rows.slice(0, ROSTER_STILL_GOING).map((r) => `${r.name} (${stateNowClause(r)})`);
    // LAST, not before the map. `asked` is what licenses the "nothing else is
    // running" sentence below, and that sentence is a claim about the crew -
    // so it may only be said once this really did look at the crew and
    // finish looking. Set above the map, a throw halfway through rendering
    // would print it with several workers running.
    asked = true;
  } catch {
    // The roster's optional half: a failure here costs this clause, never the
    // notice, matching watchedTail's own contract for the same kind of read.
  }
  if (shown.length > 0) {
    lines.push(`Still going: ${shown.join("; ")}${more > 0 ? `, and ${more} more` : ""}.`);
  } else if (asked) {
    lines.push("Nothing else in this project is running right now.");
  }
  lines.push(
    'Read each finished worker with agent_output(name: "<name>") before acting on it. hive fires this on ' +
      "each worker's own hook state, so a terminal still showing work means that worker is NOT finished. A " +
      "worker reading `waiting` may be stopped on a dialog nobody has answered; read its pane.",
  );
  // THE CALLER'S OWN BODY, ON EVERY NOTICE (counselors, both seats, P1). body
  // is a REQUIRED parameter, help.ts teaches leads to write one, and
  // .claude/rules/worker-state.md tells them to make it self-contained - the
  // ids, the context, the next action. The first version of this function
  // never read timer.body at all, so a lead that wrote "read its diff,
  // complete its todo, and dispatch the one it unblocks" got a generic roster
  // on every finish and its own instruction exactly once, four hours later,
  // attached to the expiry. A required parameter that surfaces only when the
  // feature ends is a broken contract, and wake_update(body:) reporting
  // success while changing nothing anyone will read is worse.
  //
  // LAST, AND LABELLED. The roster above is hive's generated account of what
  // happened; this is the caller's own sentence, and the two must not read as
  // one voice. Last because it is the thing to ACT on once the news has been
  // read.
  lines.push(`--- what you asked to be told when this happened ---\n${timer.body}`);
  lines.push(
    `Wake #${timer.id} is STILL WATCHING this project and speaks again on the next finish - you do not have ` +
      `to re-arm it. It expires at ${timer.max_wait_at ?? "an unrecorded time"}; stop it with ` +
      `wake_cancel(wake_id: ${timer.id}).`,
  );
  return lines.join("\n");
}

// ONE TRANSACTION, ONE BATCH, ONE NOTICE. Everything about this claim is the
// shape claimBlockNoticeWithNotice already uses, with one addition: the batch.
// Every candidate this tick is claimed inside the same transaction, the body
// is rendered from the WINNERS ONLY, and the single notice's id is stamped
// back onto each winning cursor row - which is what gives a batch a durable
// identity, and what the delivery-failure re-arm above reads.
//
// PER-TICK COALESCING IS NOT STRUCTURAL ACROSS INSTANCES (counselors C5), and
// that is accepted rather than hidden. Every session runs its own scheduler
// against this store, so two instances can claim two DIFFERENT agents in the
// same tick and each file a notice naming its own. The claim still guarantees
// each finish is reported exactly once; what is not guaranteed is that two
// finishes in one tick arrive as one paste. The cost is an extra paragraph in
// a terminal, never a lost finish or a repeated one, and the alternative is a
// second lock over a batch that nothing else in this file takes.
//
// stillPending() is the read-gate the wake_cancel and expiry races need: the
// candidates SELECT that produced `timer` can be several deliveries and their
// real 300ms Enter sleeps old by the time this runs, so the watch may have
// been cancelled or expired in between. Inside the transaction, so a claim
// cannot outlive the watch it belongs to.
const claimStandingBatch = db.transaction(
  (timer: TimerRow, candidates: StandingCandidate[]): boolean => {
    if (!stillPending(timer.id)) return false;
    const won: StandingCandidate[] = [];
    for (const c of candidates) {
      // The re-arm, run unconditionally rather than only when the read-gate
      // above said the row was stale: the read is a hint, the claim is the
      // authority, and this is inside a transaction that only ever opens when
      // there is work to do - so it costs nothing on the quiet path and
      // cannot disagree with what the INSERT below then sees.
      stmt(
        `DELETE FROM wake_idle_notices
          WHERE timer_id = ? AND agent_id = ? AND condition = ? AND episode = ?
            AND notice_timer_id IS NOT NULL
            AND EXISTS (SELECT 1 FROM timers t WHERE t.id = wake_idle_notices.notice_timer_id
                          AND t.fired_at IS NOT NULL AND t.typed_at IS NULL AND t.cancelled_at IS NULL
                          AND t.fired_at < datetime('now', '${NOTICE_RETRY_AFTER}'))`,
      ).run(timer.id, c.row.id, c.condition, c.row.episode);
      const claimed =
        stmt(
          `INSERT OR IGNORE INTO wake_idle_notices (timer_id, agent_id, condition, episode)
           VALUES (?, ?, ?, ?)`,
        ).run(timer.id, c.row.id, c.condition, c.row.episode).changes === 1;
      if (claimed) won.push(c);
    }
    if (won.length === 0) return false;
    const noticeId = insertNotice(
      timer,
      timer.deliver_actor,
      timer.deliver_pane,
      standingNoticeBody(timer, won),
      timer.id,
    );
    for (const c of won) {
      stmt(
        `UPDATE wake_idle_notices SET notice_timer_id = ?
          WHERE timer_id = ? AND agent_id = ? AND condition = ? AND episode = ?`,
      ).run(noticeId, timer.id, c.row.id, c.condition, c.row.episode);
    }
    return true;
  },
);

// Never throws, and writes nothing to the watch itself - not fired_at, not
// held_at, not held_reason. A standing watch is never due and never held, and
// marking it either would make wake_list and `hive status` report a delivery
// hive never attempted, which is the class of misreporting #69, #70 and #75
// exist to stop.
//
// COST, ordered so the cheap questions kill the expensive ones. On a tick
// where nothing has finished this is two indexed SELECTs and no write at all,
// which is the case that runs every three seconds in every session forever.
// The claim - which takes SQLite's single machine-wide writer slot even when
// it IGNOREs - is reached only when there is something to report. That
// read-before-write ordering is the rule pruneStateLog states forty lines
// above its own DELETE, and it is not a redundant read to collapse: a
// /simplify pass looking at this will see a SELECT whose answer the INSERT OR
// IGNORE would give anyway.
//
// IT FILES AT timer.deliver_pane, NOT AT ownerPane(), AND THAT WAS A REAL
// DEFECT (counselors, both seats, P1). ownerPane() is `SELECT tmux_target FROM
// agents WHERE actor_id = ? AND status = 'running'`, so it answers null for a
// session with no agents row - and resolveDelivery (src/tools/wakes.ts)
// DELIBERATELY supports exactly that caller, falling back to the TMUX_PANE the
// session itself is running in. A plain claude session, or anything driving
// hive through the documented HIVE_AGENT_ID identity, therefore got a
// successful receipt listing the crew it was now watching, heard NOTHING for
// four hours, and was then told by the expiry - which reads deliver_pane and
// so worked - that the watch had ended. The same line silently discarded
// deliver_to: the target is resolved at creation, stored, and echoed in the
// receipt, and every notice went to the owner instead.
//
// So the pane is the one the wake ITSELF resolved. It is already validated at
// creation (resolveDelivery refuses a session it cannot deliver to at all),
// and `hive lead` re-points it on restart, which ownerPane's live lookup was
// the informal substitute for. The row.tmux_target skip below is what stops
// this telling a crew member about its own idle by pasting into its own pane -
// which only means anything now that the delivery target can BE a crew member.
function noteStandingTransitions(timer: TimerRow, snapshot: AliveSnapshot | null): void {
  try {
    const pane = timer.deliver_pane;
    const candidates: StandingCandidate[] = [];
    for (const row of standingGoneRows(timer)) {
      candidates.push({ condition: CONDITION_GONE, row });
    }
    // The idle half is the only one that needs tmux, and it needs it for the
    // reason watchedStates does: a running row whose pane this process cannot
    // see, or cannot see into (issue #73's foreign socket), must read as "no
    // fact" rather than as a finished worker.
    if (snapshot !== null) {
      for (const row of standingIdleRows(timer)) {
        if (row.tmux_target === pane) continue;
        if (rowAlive(row.tmux_socket, row.tmux_target, snapshot) !== true) continue;
        if (!idleIsAFreshTransition(timer.id, row)) continue;
        candidates.push({ condition: CONDITION_IDLE, row });
      }
    }
    if (candidates.length === 0) return;
    claimStandingBatch.immediate(timer, candidates);
  } catch {
    // Reporting about the crew, never the crew itself: same precedent as
    // noteBlockedWatched above and src/hook.ts's record().
  }
}

// A notice a standing watch filed is deliverable only while the watch that
// filed it still stands and the notice is still recent. Both halves are
// scoped to rows that CARRY a parent, so every wake that existed before this
// lane - including todo 314's own notices - answers true here and behaves
// exactly as it did.
//
// Fails OPEN on a throw, and that direction is deliberate: this runs between
// tick()'s candidates SELECT and a delivery, and an exception escaping it
// would cost every candidate after it in this tick. Delivering a notice that
// might be stale is a paragraph in a terminal; aborting the tick is every
// other wake in the store not firing.
function noticeStillDeliverable(timer: TimerRow): boolean {
  if (timer.parent_timer_id === null) return true;
  try {
    return (
      stmt(
        `SELECT 1 AS hit FROM timers p
          WHERE p.id = ? AND p.cancelled_at IS NULL AND ? >= datetime('now', ?)`,
      ).get(timer.parent_timer_id, timer.created_at, NOTICE_MAX_AGE) !== undefined
    );
  } catch {
    return true;
  }
}

// NEVER CALL THIS FROM INSIDE AN OPEN TRANSACTION (counselors, both seats).
// noteModalHold below opens one with `.immediate()` to take the store's
// writer slot, and better-sqlite3 turns a nested transaction into a SAVEPOINT
// rather than throwing - so a caller that wrapped its own tick in a
// transaction would silently remove the exclusion this depends on, with
// nothing failing to say so (.claude/rules/store-and-datadir.md names this
// hazard for withWindowClaim; it is the same one). tick() holds no
// transaction, and it is the only caller today.
function deliverable(timer: TimerRow, snapshot: AliveSnapshot | null, choices: ChoiceCache): boolean {
  // Todo 336, widened by issue #149 (todo 348). *Probe rather than plain
  // rowAlive/rowLive: the pane-identity check below needs the pane's CURRENT
  // pid, for every target now, and it has to come from this exact same tmux
  // read - a second probe taken later could observe a different pane
  // entirely if something closed and recreated it in between. For the
  // snapshot path it is a map lookup already paid for by the same list-panes
  // call `live` reads; for the no-snapshot path it rides on the one
  // list-panes fork targetLiveProbe already makes to answer `live`. Either
  // way there is no second fork paid for reading `.pid` unconditionally.
  const probe = snapshot
    ? rowAliveProbe(timer.deliver_socket, timer.deliver_pane, snapshot)
    : rowLiveProbe(timer.deliver_socket, timer.deliver_pane);
  const live = probe.live;
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
      //
      // Fix round 1, finding 1 (counselors), same exemption janitor()'s own
      // timers sweep now carries and for the identical reason: a timer this
      // very function held for pane-reissue on an earlier tick, whose target
      // has since gone from reissued to genuinely dead, is not an ordinary
      // dead-pane timer - cancelling it here erases that history exactly as
      // silently as the janitor sweep used to. Reached only in the narrow
      // window the janitor sweep's own SETTLE_WINDOW leaves open (a timer
      // younger than 15 seconds that is already due), so in practice the
      // janitor sweep is the one that usually gets here first; this stays as
      // the second, defensive copy of the identical check rather than a
      // second definition - both read wasHeldForPaneReissue over the same
      // held_reason column.
      if (wasHeldForPaneReissue(timer.held_reason)) {
        holdTimer(timer, HELD_REASON_PANE_REISSUED_THEN_DEAD);
      } else {
        cancelTimer(timer.id);
      }
    }
    return false;
  }
  // Todo 336, widened by issue #149 (todo 348). `live` above answers "does a
  // pane with this id exist", never "is it the pane we meant" - tmux pane
  // ids restart from %0 whenever the server that issued them is gone (a
  // reboot, an explicit kill-server, or simply the last session in the
  // store's namespace closing, all measured - see the migration's own
  // comment, src/db.ts), and the NEXT server hands a low id straight to
  // whatever pane it creates next. HELD_REASON_LEAD_PANE_DEAD above only
  // fires when the recorded pane reads DEAD; a reissued pane reads live, so
  // without this check a pending wake sails through and types into a
  // stranger's pane.
  //
  // NO LONGER GATED ON isLeadActorId. Todo 336 gated this to leads on the
  // stated grounds that "worker rows are already reaped by janitor()'s
  // sweep at the top of every tick" - true for a DEAD pane
  // (`rowAlive(...) === false`, the condition that sweep actually checks),
  // false for a REISSUED one, which reads live and is exactly the case this
  // check exists to catch. That gap is issue #149: the sweep cited to make
  // the gate safe was blind to precisely the condition pane_pid was added to
  // detect, so a worker's wake could sail through into whatever pane
  // inherited its id, and if that pane was a shell rather than claude the
  // paste would execute. deliver_pane_pid is written for every pane hive
  // records (src/spawn.ts), so the fact needed to refuse was already read
  // every tick and simply discarded for non-lead targets. paneReissued(),
  // above janitor(), is the same predicate both this check and the agents
  // sweep now share, so the two cannot drift onto different definitions of
  // "reissued".
  //
  // deliver_pane_pid === "" (no fact recorded: a pre-migration row, or a
  // deliver_actor with no agents row) and probe.pid === null (this exact
  // probe could not read a pid even though live read true - theoretically
  // possible if the pane closed in the gap between the two tmux reads
  // inside targetLiveProbe, though snapshot.pids is populated by the same
  // list-panes line that populates snapshot.panes and cannot disagree with
  // it) both mean "cannot judge identity" and MUST proceed exactly as
  // before this check existed, never read as a mismatch - an upgrade must
  // not hold or cancel every pre-existing wake in every store. paneReissued
  // already encodes both.
  //
  // HOLD, not cancel, matching HELD_REASON_LEAD_PANE_DEAD immediately
  // above, and now for every target, not only a lead's: a hold is
  // recoverable and visible in wake_list (project-scoped, not
  // owner-scoped - any session in the project can see it, and it also
  // widens `hive status`'s heldWakes count), a cancel destroys a wake a
  // human asked for with nothing left to show for it, and the two
  // conditions ("temporarily gone" and "reissued to someone else") are
  // close enough in shape - both symptoms of the same restart - to deserve
  // the same recoverable treatment rather than one silently outranking the
  // other in severity. Argued explicitly because the mechanism that makes
  // this safe for a lead does NOT exist for a worker: `hive lead`
  // re-points every pending lead-owned wake to its fresh pane in the same
  // transaction that records it (issue #27 L4 R6, todo 166); nothing does
  // the equivalent for a worker, so a held worker wake has no rescue and
  // sits until a human notices it in wake_list, cancels it, or its own
  // max_wait_at passes. Judged the better default anyway: silence (a
  // cancelled wake, gone with no trace once its owner stops watching) is
  // worse than a visible, if unrescued, loose end.
  //
  // PIDS WRAP. A reissued pane can in principle land on its predecessor's
  // exact pid, and this check passes and delivers wrongly exactly as it
  // does with no column at all. Guardrail against a confused machine, not a
  // guarantee and not a security boundary - do not read this as making
  // misdelivery impossible.
  if (paneReissued(timer.deliver_pane_pid, probe)) {
    holdTimer(
      timer,
      isLeadActorId(timer.deliver_actor)
        ? HELD_REASON_PANE_REISSUED_LEAD
        : HELD_REASON_PANE_REISSUED_WORKER,
    );
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
    //
    // Todo 314: the same hold write, now routed through noteModalHold so the
    // TRANSITION into this reason also tells the wake's owner (above). The
    // write itself is unchanged whenever there is nobody to tell, and this
    // still returns false either way - what a notification changes is who
    // hears about the hold, never the hold.
    noteModalHold(timer, snapshot);
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
  // Todo 315. A notice whose standing watch was cancelled, or that has sat
  // pending long enough to be about a lane that has moved on, is cancelled
  // rather than typed. Above deliverable() for the same reason every other
  // decision in that function sits above claimOneShot: after the claim, "not
  // now" and "never" are the same thing.
  //
  // THE CANCEL IS BEST-EFFORT, and that is the "the scheduler must never
  // throw" invariant rather than a style choice (CLAUDE.md; counselors,
  // codex). fireDelay is called from tick()'s candidate loop, so an exception
  // escaping here - SQLITE_BUSY outliving db.ts's 5s busy_timeout, an I/O
  // error - is caught by the outer catch and every LATER candidate in that
  // tick is skipped. A notice that keeps failing this write would starve every
  // unrelated wake in the store, on every tick, forever. Swallowing it costs
  // one row staying pending until the next tick tries again, and the next tick
  // will: it is still a candidate, and noticeStillDeliverable will still
  // refuse it. bestEffortRun is this file's existing precedent for exactly
  // this trade (see its own comment).
  if (!noticeStillDeliverable(timer)) {
    bestEffortRun("UPDATE timers SET cancelled_at = datetime('now') WHERE id = ?", timer.id);
    return;
  }
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
  // Todo 315. A standing watch shares this row shape and this dispatch, and
  // nothing else: it never becomes "ready", it files notices instead, and the
  // only thing that ever claims its own row is the expiry below.
  //
  // max_wait_at IS THE LIFETIME, reusing the column every idle wake already
  // carries rather than adding a second lifetime parameter that could
  // contradict it (counselors C2). That is not only cheaper, it is REQUIRED:
  // the timedOut branch below sets ready unconditionally for any non-delay
  // kind, so without this the max-wait firing would claim a standing watch
  // fifteen minutes in, set fired_at, drop it from the candidates query, and
  // leave a lead with one wake that looked healthy and a crew nobody was
  // watching - this todo's own defect, delivered by its own fix.
  //
  // THE EXPIRY SPEAKS, because a silent one is that same defect with a timer
  // on it. What it CANNOT do is speak in the one case it exists for: an
  // abandoned lead-owned notice is held on a dead pane (HELD_REASON_LEAD_
  // PANE_DEAD) and exempt from the janitor's cancel, so it sits pending and
  // unread. That costs a row rather than a pane being typed into, and it is
  // stated here rather than claimed away.
  //
  // REPORTING RUNS FIRST AND RUNS UNCONDITIONALLY, and the ordering is the
  // fix rather than a preference (counselors, opus 6). The first version read
  // `if (timedOut) { ...deliver...; return; }` ABOVE the reporting call, and
  // the expiry branch only completes when deliverable() says yes. So: max_wait
  // passes while the lead's input box holds unsubmitted human text.
  // deliverable() holds - indefinitely, by design
  // (.claude/rules/tmux-and-panes.md) - claimOneShot never runs, and from that
  // tick onward the early return meant no finish was ever reported again,
  // while wake_list still showed the watch pending. The crew unwatched, the
  // lead untold, and a wake that looks healthy: this todo's own defect, with a
  // timer on it, produced by the very branch STANDING_EXPIRED_NOTE exists to
  // prevent.
  //
  // A watch is done watching when its own row is CLAIMED, not when its clock
  // passes: fired_at is what removes it from tick()'s candidates, so as long
  // as it is still a candidate it still reports. That also closes the smaller
  // version of the same hole in the clean case - a finish landing in the very
  // tick that expires the watch used to be dropped with no final sweep.
  if (isStandingWatch(timer)) {
    noteStandingTransitions(timer, snapshot);
    // Todo 321, the block half, and the two conditions on it are the one-shot
    // branch's own conditions reached by a different route.
    //
    // A NULL SNAPSHOT MEANS NO PANE IS READ. blockedWatchedAgents filters on
    // rowAlive before anything captures a pane (issue #73: never read a pane
    // on a socket this process cannot see into), and it has no snapshot to
    // filter against here. The one-shot branch gets this from its own
    // `if (snapshot === null) return` above; this branch cannot borrow that,
    // because noteStandingTransitions' gone half deliberately still answers
    // with no tmux at all.
    //
    // `!timedOut` MIRRORS `!ready`, for the reason stated there rather than
    // by analogy: the notice makes a claim about the wake, and once the
    // lifetime has passed the true sentence is the expiry's, not this one's.
    // A watch whose expiry cannot be delivered yet (a held owner pane) stays
    // a candidate for more ticks, and it must not spend them filing notices
    // that say it is still watching.
    if (snapshot !== null && !timedOut) noteBlockedWatched(timer, snapshot, choices);
    if (timedOut && deliverable(timer, snapshot, choices) && claimOneShot(timer)) {
      await deliver(timer, STANDING_EXPIRED_NOTE, choices);
    }
    return;
  }
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
    // Todo 314, amendment 1, and it sits AFTER `ready` on purpose - the first
    // version ran it above and counselors round 2 (opus 1) found the false
    // alarm that opens. A mode=any wake watching A and B, where B is on a
    // dialog and A goes idle in this very tick, is READY: it fires this tick.
    // Filing a notice first means the owner is told "wake #N will not fire
    // until that dialog is answered" one tick after wake #N already fired.
    // The BLOCK question does not depend on whether the wake is about to
    // fire, but the notice's own sentence does, and it is a claim about this
    // wake. A ready wake needs no notice anyway: it is about to wake its
    // owner, and if its delivery pane is the dialogged one, the held-wake
    // path above says so with the right words.
    if (!ready) noteBlockedWatched(timer, snapshot, choices);
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
    // Todo 321: one call, both caches. Typing is the one thing that can change
    // a pane's answer, and forgetPaneAnswers is where that rule lives.
    forgetPaneAnswers(timer.deliver_pane, choices);
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
