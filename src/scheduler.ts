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
const howToClearIt = (name: string, isLead: boolean): string =>
  isLead
    ? `That target is a LEAD session, so agent_send's keys path is refused against it from a worker: a human ` +
      `at that terminal, or another lead, has to answer the dialog.`
    : `Read its pane with agent_output(agent: "${name}") FIRST, since this notice can arrive after the dialog ` +
      `was already answered, and if it is still up answer it with agent_send(agent: "${name}", keys: ["1", ` +
      `"Enter"]) or whichever keys that dialog wants - keys is the only supported way to answer one, because ` +
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
// Liveness is deliberately NOT checked here. deliverable() asks that question
// about this pane on the notification's own tick, off the snapshot the tick
// already has, so asking it here would buy nothing and cost a tmux fork in
// the hottest loop hive has.
// The raw lookup: the pane of the session that SET this wake, or null if it
// has no running agents row to name one. The running filter, ORDER BY id DESC
// and LIMIT 1 are resolveDelivery's own convention (src/tools/wakes.ts) - one
// rule for which row speaks for an actor, not two that can disagree.
function ownerPane(timer: TimerRow): string | null {
  const row = stmt(
    `SELECT tmux_target FROM agents WHERE actor_id = ? AND status = 'running'
      ORDER BY id DESC LIMIT 1`,
  ).get(timer.owner) as { tmux_target: string } | undefined;
  return row?.tmux_target || null;
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
function ownerPaneToTell(timer: TimerRow): string | null {
  if (timer.owner === timer.deliver_actor) return null;
  const pane = ownerPane(timer);
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
function insertNotice(timer: TimerRow, pane: string, body: string): void {
  stmt(
    `INSERT INTO timers (project_id, owner, body, kind, deliver_actor, deliver_pane, due_at)
     VALUES (?, ?, ?, 'delay', ?, ?, datetime('now'))`,
  ).run(timer.project_id, timer.owner, body, timer.owner, pane);
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
    insertNotice(timer, pane, body);
    return true;
  },
);

// The whole attempt is best-effort in exactly the sense bestEffortRun is: a
// failure anywhere here must cost the notification, never the hold and never
// the rest of this tick's candidates. Every path that does not notify falls
// through to the same holdTimer call this function replaced, so the hold
// itself behaves precisely as it did before todo 314 - including for a wake
// with nobody to tell, which is most of them.
function noteModalHold(timer: TimerRow): void {
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
      const pane = ownerPaneToTell(timer);
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
function blockedWatchedAgents(
  timer: TimerRow,
  snapshot: AliveSnapshot,
): { id: number; name: string; pane: string; blockedSince: string }[] {
  const ids = JSON.parse(timer.watch) as number[];
  if (ids.length === 0) return [];
  const rows = stmt(
    `SELECT id, name, tmux_target, tmux_socket, COALESCE(state_changed_at, '') AS blocked_since
       FROM agents
      WHERE id IN (${ids.map(() => "?").join(",")})
        AND status = 'running' AND agent_state = 'waiting'`,
  ).all(...ids) as {
    id: number;
    name: string;
    tmux_target: string;
    tmux_socket: string;
    blocked_since: string;
  }[];
  return rows
    // Issue #73's discipline, the same one watchedTail applies before its own
    // capture: never read a pane on a socket this process cannot see into,
    // and treat unknown as "no fact" rather than as a live pane.
    .filter((r) => rowAlive(r.tmux_socket, r.tmux_target, snapshot) === true)
    .map((r) => ({ id: r.id, name: r.name, pane: r.tmux_target, blockedSince: r.blocked_since }));
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
  (timer: TimerRow, agentId: number, blockedSince: string, pane: string, body: string): boolean => {
    if (!stillPending(timer.id)) return false;
    if (!claimBlockNotice(timer.id, agentId, blockedSince)) return false;
    insertNotice(timer, pane, body);
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
    const tellPane = ownerPane(timer);
    if (tellPane === null) return;
    for (const agent of blockedWatchedAgents(timer, snapshot)) {
      // Telling a session about its own pane, reached here through the watch
      // list rather than through delivery: a session watching itself would
      // otherwise be told to answer the dialog it is looking at, by a paste
      // into that dialog.
      //
      // A CHAIN IS IMPOSSIBLE ON THIS PATH regardless, and structurally so: a
      // notification is inserted with kind 'delay' and the default empty
      // watch list, so it is never a candidate for maybeFireIdle at all and
      // blockedWatchedAgents would answer [] for it even if it were.
      if (agent.pane === tellPane) continue;
      if (alreadyToldAbout(timer.id, agent.id, agent.blockedSince)) continue;
      if (awaitingChoice(agent.pane, choices) !== true) continue;
      claimBlockNoticeWithNotice.immediate(
        timer,
        agent.id,
        agent.blockedSince,
        tellPane,
        blockNoticeBody(timer, agent.name),
      );
    }
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

// NEVER CALL THIS FROM INSIDE AN OPEN TRANSACTION (counselors, both seats).
// noteModalHold below opens one with `.immediate()` to take the store's
// writer slot, and better-sqlite3 turns a nested transaction into a SAVEPOINT
// rather than throwing - so a caller that wrapped its own tick in a
// transaction would silently remove the exclusion this depends on, with
// nothing failing to say so (.claude/rules/store-and-datadir.md names this
// hazard for withWindowClaim; it is the same one). tick() holds no
// transaction, and it is the only caller today.
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
    //
    // Todo 314: the same hold write, now routed through noteModalHold so the
    // TRANSITION into this reason also tells the wake's owner (above). The
    // write itself is unchanged whenever there is nobody to tell, and this
    // still returns false either way - what a notification changes is who
    // hears about the hold, never the hold.
    noteModalHold(timer);
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
