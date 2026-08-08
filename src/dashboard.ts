import { createHash } from "node:crypto";
import { db } from "./db.js";
import { getProject } from "./context.js";

// Pure: reads the store for one project and returns a complete, self-contained
// HTML document as a string. Never touches the filesystem and never decides
// WHEN to run - that is step 2's job (the scheduler hook that writes this to
// disk). Everything below is read-only SQL plus string building.

// Caps for the sections that have no natural bound. Exported so tests assert
// against the real constant rather than a copy of the number that can drift.
// "Cap the unbounded sections AND say on the page that they are capped" - a
// silent top-N reads as "this is everything", which is the defect PR #44
// nearly shipped.
export const TODO_CAP = 100;
export const AGENT_CAP = 50;
export const WAKE_CAP = 50;
export const ACTIVITY_SOURCE_LIMIT = 30; // per source (comments, state log), before merge
export const ACTIVITY_DISPLAY_CAP = 40; // after merge, what actually renders

// Not src/tools/wakes.ts's own truncateBody: that file pulls in agents.ts,
// scheduler.ts and tmux.ts transitively, which is exactly the coupling
// dashboard.ts is deliberately free of (see the module header comment).
// Same shape, different cap per call site (wake bodies vs comment bodies),
// kept local rather than imported.
function truncateWithEllipsis(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Visual redesign (Chris's request after seeing PR #127): the page now
// draws a hard line between DATA (labels, status, counts, ids, the board -
// the instrument parts, monospace) and PROSE (a todo title, a comment or
// wake body, a pad's own name - human-written text, sans-serif). body's
// default font is the mono stack; this wraps the specific spans that are
// prose. One split, applied consistently, is the whole type system - see
// the STYLE comment below for why that is deliberately the only one.
function prose(text: string): string {
  return `<span class="prose">${escapeHtml(text)}</span>`;
}

type StatusLevel = "ok" | "warn" | "fail" | "live";

// hive doctor's own vocabulary (src/cli.ts's report()/warn()/fail() family):
// a status word, lowercase except FAIL, prefixing the thing it describes.
// Chris's instruction is explicit - reuse this rather than inventing badge
// words - so every status concept on the page (a todo blocked or not, an
// agent's state, a wake held or not) maps onto these three, plus "live",
// this page's own addition for something that is currently RUNNING rather
// than passed or failed (a working agent, a pending wake): doctor has no
// occasion to say that, a read-only status page does.
function statusBadge(level: StatusLevel, text: string): string {
  const word = level === "fail" ? "FAIL" : level;
  return `<span class="status status-${level}">${word}</span> ${escapeHtml(text)}`;
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

// Formatted by hand rather than through toLocaleString: a fixed, deterministic
// layout that does not depend on the runtime's ICU data or default locale, so
// the same input renders identically on any machine in the same zone. Shared
// by formatLocal (below) and renderDashboard's own "generated at" stamp -
// one formatting implementation for every Date this file ever prints.
function formatDate(d: Date): string {
  return (
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
    `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
  );
}

// Store timestamps are UTC ('YYYY-MM-DD HH:MM:SS', or with a milliseconds
// suffix for agent_state_log). Rendered in the reading machine's local zone,
// labelled explicitly as "local" so a reader hours away from UTC is never
// left guessing which zone a bare time is in - getting this wrong makes the
// wakes section worse than useless (plan-dashboard-v1).
function formatLocal(utc: string | null): string {
  if (!utc) return "-";
  const d = new Date(`${utc.replace(" ", "T")}Z`);
  if (Number.isNaN(d.getTime())) return utc;
  return formatDate(d);
}

function timeEl(utc: string | null): string {
  if (!utc) return '<span class="muted">-</span>';
  return `<span class="time" title="${escapeHtml(utc)} UTC">${escapeHtml(formatLocal(utc))} local</span>`;
}

// Normalizes a stored timestamp to a sortable key. todo_comments.created_at is
// whole-second ('...SS'); agent_state_log.created_at carries milliseconds
// ('...SS.mmm'). String-compared as-is, a whole-second row and a millisecond
// row sharing the same second sort with the whole-second one first regardless
// of which actually happened later (a shorter string that is a prefix of a
// longer one always sorts first). Padding the whole-second form to the same
// width removes that tie-break bug without changing what is displayed.
function sortKey(createdAt: string): string {
  return createdAt.includes(".") ? createdAt : `${createdAt}.000`;
}

// Shared with every other caller in src/ (src/cli.ts, src/tools/agents.ts):
// context.ts already owns project lookups. getProject touches no tmux/spawn
// machinery - only db.js and node builtins - so importing it here does not
// reopen the scheduler/tmux coupling dashboard.ts is deliberately free of.
function fetchProject(projectId: number): { id: number; name: string } {
  const row = getProject(projectId);
  if (!row) throw new Error(`No project ${projectId}.`);
  return row;
}

// ---------------------------------------------------------------------------
// Mirrors ACTIVE_TIMER_WHERE in src/scheduler.ts (one-shot pending, or
// repeating and not cancelled), spelled out locally rather than imported.
// dashboard.ts must not import scheduler.ts: that module pulls in tmux.ts and
// spawn.ts, and step 1's whole point is a generator with no scheduler and no
// tmux dependency at all. If ACTIVE_TIMER_WHERE's definition ever changes,
// this copy has to change with it by hand. Shared by the NOW strip's own
// "next wake" query and renderWakesSection below.
const PENDING_WAKE_WHERE = "cancelled_at IS NULL AND (fired_at IS NULL OR repeat_every_ms IS NOT NULL)";

// working is the one state that means "actually running right now" -
// everything else on the page that gets the "live" accent (a pending wake)
// shares that same "in progress, not a verdict" meaning. idle is a plain
// pass (ok); waiting is a worker stalled on a prompt, worth a glance (warn);
// an unrecognised state - a future dist adding one, or the hook's payload
// contract drifting - reads as warn rather than silently as ok, so a real
// problem does not read as fine by default.
function agentStatusLevel(state: string): StatusLevel {
  if (state === "working") return "live";
  if (state === "idle") return "ok";
  if (state === "waiting") return "warn";
  return "warn";
}

// Chris, looking at a real render: a lead shows "unknown" and it reads as
// broken. It is not - src/hook.ts's agent_state UPDATE is scoped `WHERE ...
// AND kind = 'agent'` (worker-state.md), so any row that is not kind='agent'
// (today only 'lead', but the scoping is symmetric with the hook's own and
// not a lead-specific carve-out) never gets that latch written at all.
// agent_state reads 'unknown' forever for such a row by DESIGN: the absence
// of a channel, not an unhealthy worker. Rendering a status badge for it
// would invent a fact the store has no answer for, so this predicate exists
// to gate that badge off entirely - see its two call sites below.
function hasStateChannel(kind: string): boolean {
  return kind === "agent";
}

interface LastLogEvent {
  event: string;
  created_at: string;
}

// The one real fact the store DOES have for a row with no state channel:
// what it last logged, and when (agent_state_log, never gated on kind -
// every actor's hook writes here regardless). Deliberately NOT
// src/stateProvenance.ts's own lastLogEvent/describeLastLogEvent, which
// hive doctor uses for the same sentence ("last log event: notify (38m
// ago)"): that module imports src/tmux.ts for its event-sanitizing
// formatter, and dashboard.ts must stay free of any tmux dependency (see
// this file's own header comment) - a plain SELECT plus this file's own
// escapeHtml is sufficient for an HTML surface, where stateProvenance's
// pane-typing safety concerns do not apply.
function fetchLastLogEvent(actorId: string): LastLogEvent | undefined {
  return db
    .prepare("SELECT event, created_at FROM agent_state_log WHERE actor_id = ? ORDER BY id DESC LIMIT 1")
    .get(actorId) as LastLogEvent | undefined;
}

// ---------------------------------------------------------------------------
// The NOW strip. Added on Chris's request after the initial visual review:
// "it's a lot of info on screen even when pads are collapsed" - the fix is
// hierarchy, not less data. This is the ONLY thing expanded by default, has
// no collapse state of its own (it is not a <details> at all), and has to
// answer "is anything running, and what's next" in the time it takes to
// glance at a phone screen. Everything else on the page is drill-down.

interface RunningAgentBrief {
  name: string;
  kind: string;
  agent_state: string;
}

interface NextWakeBrief {
  kind: string;
  due_at: string | null;
  max_wait_at: string | null;
  deliver_actor: string;
}

interface TodoCounts {
  open: number;
  blocked: number;
  completed7d: number;
}

function fetchNowAgents(projectId: number): RunningAgentBrief[] {
  return db
    .prepare(
      `SELECT name, kind, agent_state FROM agents WHERE project_id = ? AND status = 'running' ORDER BY created_at`,
    )
    .all(projectId) as RunningAgentBrief[];
}

function fetchNextWake(projectId: number): NextWakeBrief | undefined {
  return db
    .prepare(
      `SELECT kind, due_at, max_wait_at, deliver_actor FROM timers
       WHERE project_id = ? AND ${PENDING_WAKE_WHERE}
       ORDER BY COALESCE(due_at, max_wait_at, created_at) LIMIT 1`,
    )
    .get(projectId) as NextWakeBrief | undefined;
}

// completed7d mirrors the chart's own COMPLETED-ON-DAY-D definition, summed
// over the same CHART_DAYS window (see fetchDayStats below), computed here
// as one direct range query rather than by summing fetchDayStats's own
// per-day rows - this line does not need the day-by-day breakdown, only the
// total, and a >= comparison against six days ago is the same "local day"
// reasoning in one query instead of seven.
function fetchTodoCounts(projectId: number): TodoCounts {
  return db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM todos WHERE project_id = ? AND archived_at IS NULL AND status != 'completed') AS open,
         (SELECT COUNT(*) FROM todos t WHERE t.project_id = ? AND t.archived_at IS NULL AND t.status != 'completed'
            AND EXISTS (
              SELECT 1 FROM todo_blockers b JOIN todos bt ON bt.id = b.blocker_id
               WHERE b.todo_id = t.id AND bt.status != 'completed'
            )) AS blocked,
         (SELECT COUNT(*) FROM todos
            WHERE project_id = ? AND completed_at IS NOT NULL
              AND date(completed_at, 'localtime') >= date('now', 'localtime', '-6 days')) AS completed7d`,
    )
    .get(projectId, projectId, projectId) as TodoCounts;
}

// Capped at 5 names: past that, a name list stops being a 3-second scan and
// the Agents section below is where the full list already lives.
const NOW_AGENTS_SHOWN = 5;

// A row with no state channel (hasStateChannel, above - today only a lead)
// gets no badge here at all, name alone: the NOW strip is one line for
// every running row, with no room for "last event: ... local" without
// defeating its own "3-second scan" purpose. That fuller detail is what
// the In Flight section below is for; see renderAgentRow.
function renderNowAgentsLine(agents: RunningAgentBrief[]): string {
  if (agents.length === 0) return "no workers running";
  const shown = agents.slice(0, NOW_AGENTS_SHOWN);
  const parts = shown.map((a) =>
    hasStateChannel(a.kind)
      ? `${escapeHtml(a.name)} ${statusBadge(agentStatusLevel(a.agent_state), a.agent_state)}`
      : escapeHtml(a.name),
  );
  const extra = agents.length > shown.length ? `, +${agents.length - shown.length} more` : "";
  return parts.join(", ") + extra;
}

function renderNowWakeLine(next: NextWakeBrief | undefined): string {
  if (!next) return "nothing scheduled";
  const when = next.kind === "delay" ? timeEl(next.due_at) : timeEl(next.max_wait_at);
  return `${when} → ${escapeHtml(next.deliver_actor)}`;
}

// Sparkline scale on purpose: no axis lines, no numbers, no legend - just
// shape. A reader who wants the exact counts and the labelled axis has the
// Throughput section below; this is "is it trending up or down", answered
// in the same half-second as the rest of the strip.
const SPARK_WIDTH = 220;
const SPARK_HEIGHT = 30;

function buildSparkline(stats: DayStats[]): string {
  const maxValue = Math.max(1, ...stats.map((s) => s.completed), ...stats.map((s) => s.backlog));
  const stepX = stats.length > 1 ? SPARK_WIDTH / (stats.length - 1) : 0;
  const drawHeight = SPARK_HEIGHT - 6;
  const xAt = (i: number): number => i * stepX;
  const yAt = (v: number): number => 3 + drawHeight - (v / maxValue) * drawHeight;
  const polyline = (values: number[]): string =>
    values.map((v, i) => `${xAt(i).toFixed(1)},${yAt(v).toFixed(1)}`).join(" ");
  return `<svg viewBox="0 0 ${SPARK_WIDTH} ${SPARK_HEIGHT}" class="spark" role="img" aria-label="7-day trend: completed vs backlog, see Throughput below for the labelled chart">
<polyline points="${polyline(stats.map((s) => s.backlog))}" fill="none" stroke="${CHART_BACKLOG_COLOR}" stroke-width="1.5" />
<polyline points="${polyline(stats.map((s) => s.completed))}" fill="none" stroke="${CHART_COMPLETED_COLOR}" stroke-width="1.5" />
</svg>`;
}

// stats is the SAME fetchDayStats() result renderThroughputSection uses
// below - computed once in buildDashboard and threaded through both, so the
// sparkline and the detailed chart can never show different numbers for the
// same render, and the 7-query cost is paid once, not twice.
function renderNowStrip(projectId: number, stats: DayStats[]): string {
  const agents = fetchNowAgents(projectId);
  const nextWake = fetchNextWake(projectId);
  const todos = fetchTodoCounts(projectId);
  return `<section class="now" aria-label="current status">
<div class="now-row"><span class="now-label">workers</span><span>${renderNowAgentsLine(agents)}</span></div>
<div class="now-row"><span class="now-label">next wake</span><span>${renderNowWakeLine(nextWake)}</span></div>
<div class="now-row"><span class="now-label">todos</span><span>${todos.open} open, ${todos.blocked} blocked, ${todos.completed7d} completed (7d)</span></div>
<div class="now-row now-chart"><span class="now-label">trend</span>${buildSparkline(stats)}</div>
</section>`;
}

// ---------------------------------------------------------------------------
// Section: the board pad, rendered in full.

function renderBoardSection(projectId: number): string {
  const pad = db
    .prepare("SELECT content, revision, updated_at FROM scratchpads WHERE project_id = ? AND name = 'board' AND archived = 0")
    .get(projectId) as { content: string; revision: number; updated_at: string } | undefined;
  const count = pad ? `rev ${pad.revision} · updated ${formatLocal(pad.updated_at)} local` : "no board pad";
  const body = pad
    ? `<div class="meta">revision ${pad.revision}, updated ${timeEl(pad.updated_at)}</div>` +
      `<pre class="board">${escapeHtml(pad.content)}</pre>`
    : `<p class="muted">No pad named "board" in this project.</p>`;
  return section("board", "Board", count, body);
}

// ---------------------------------------------------------------------------
// Section: open todos in queue order.

interface OpenTodoRow {
  id: number;
  title: string;
  status: string;
  priority: string;
  open_blockers: number;
}

interface BlockerRef {
  id: number;
  title: string;
}

// "Queue order": priority first (a todo you would work sooner sorts first),
// then id, so ties within a priority read oldest-first - the order a human
// would actually pull from the queue. Blocked and dispatchable share this one
// order rather than being split into two lists: the pad's own wording is
// explicit that visual distinctness, not a separate ordering, is what marks a
// blocked todo.
const OPEN_TODOS_SQL = `
  SELECT t.id, t.title, t.status, t.priority,
    (SELECT COUNT(*) FROM todo_blockers b JOIN todos bt ON bt.id = b.blocker_id
      WHERE b.todo_id = t.id AND bt.status != 'completed') AS open_blockers
  FROM todos t
  WHERE t.project_id = ? AND t.archived_at IS NULL AND t.status != 'completed'
  ORDER BY CASE t.priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, t.id`;

// One batched query for every SHOWN blocked todo, not one query per todo:
// up to TODO_CAP (100) round-trips otherwise, and the caller only ever has
// this many ids to ask about at once anyway.
function fetchBlockersFor(todoIds: number[]): Map<number, BlockerRef[]> {
  const byTodo = new Map<number, BlockerRef[]>();
  if (todoIds.length === 0) return byTodo;
  const placeholders = todoIds.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT b.todo_id, t.id, t.title FROM todo_blockers b JOIN todos t ON t.id = b.blocker_id
       WHERE b.todo_id IN (${placeholders}) AND t.status != 'completed'`,
    )
    .all(...todoIds) as (BlockerRef & { todo_id: number })[];
  for (const row of rows) {
    const list = byTodo.get(row.todo_id) ?? [];
    list.push({ id: row.id, title: row.title });
    byTodo.set(row.todo_id, list);
  }
  return byTodo;
}

function renderTodosSection(projectId: number): string {
  const all = db.prepare(OPEN_TODOS_SQL).all(projectId) as OpenTodoRow[];
  const shown = all.slice(0, TODO_CAP);
  const blockersByTodo = fetchBlockersFor(shown.filter((t) => t.open_blockers > 0).map((t) => t.id));
  const blockedCount = all.filter((t) => t.open_blockers > 0).length;
  const rows = shown
    .map((t) => {
      const blocked = t.open_blockers > 0;
      const blockers = blocked
        ? (blockersByTodo.get(t.id) ?? []).map((b) => `#${b.id} ${prose(b.title)}`).join(", ")
        : "";
      return (
        `<li class="todo ${blocked ? "todo-blocked" : "todo-open"}">` +
        `${statusBadge(blocked ? "warn" : "ok", blocked ? "blocked" : "open")} ` +
        `<span class="priority priority-${escapeHtml(t.priority)}">${escapeHtml(t.priority)}</span> ` +
        `#${t.id} ${prose(t.title)} ` +
        `<span class="muted">(${escapeHtml(t.status)})</span>` +
        (blocked ? `<div class="blockers">blocked by ${blockers}</div>` : "") +
        `</li>`
      );
    })
    .join("\n");
  const body = renderCappedList(shown.length, all.length, "open todos", "todos", rows, "No open todos.");
  return section("todos", "Todos", `${all.length} open, ${blockedCount} blocked`, body);
}

// ---------------------------------------------------------------------------
// Additional section, added on Chris's request: a 7-day rolling chart of
// throughput against backlog. The detailed, axis-labelled version lives in
// its own collapsed section below; a small sparkline version of the exact
// same data is in the NOW strip above (buildSparkline, fetchDayStats shared
// between both via buildDashboard).

export const CHART_DAYS = 7;

interface DayStats {
  day: string; // YYYY-MM-DD, LOCAL calendar day
  completed: number;
  backlog: number;
}

// Two series, defined exactly this way rather than two "count per day"
// series that would not tell a reader anything they cannot already see from
// the Todos section above:
//   COMPLETED ON DAY D - throughput: todos whose completed_at falls on D.
//   OPEN BACKLOG AT END OF DAY D - todos created on or before D, not yet
//     completed by the end of D (or never completed), and not currently
//     archived. `date(created_at, 'localtime') <= D` is equivalent to
//     "created_at <= end of local day D" (any timestamp ON day D or earlier
//     is <= D's last instant); `date(completed_at, 'localtime') > D` is
//     equivalent to "completed_at > end of local day D" for the identical
//     reason. Both simplifications only hold because D is itself already a
//     LOCAL calendar day, never a UTC one - see the bucketing note below.
//
// BUCKETED BY LOCAL DAY, NOT UTC DAY, and this is the part that is silently
// wrong if you get it wrong rather than loudly wrong: store timestamps are
// UTC, so on a UTC-4 box, work done after 20:00 local already carries
// tomorrow's UTC date. Every date() call below carries the 'localtime'
// modifier for exactly this reason, and every day boundary is computed via
// SQLite's OWN `date('now', 'localtime', ...)`, not via JS Date math - one
// clock decides both "which day is this" and "does this row fall in it", so
// there is no way for Node's and SQLite's notions of local time to disagree
// with each other even if they were ever configured differently. Measured
// directly (not assumed): mutating process.env.TZ mid-process changes what
// better-sqlite3's own 'localtime' modifier reports on the very next query,
// confirming this doesn't need to be read only at process start.
const DAY_STATS_SQL = `SELECT
  date('now', 'localtime', '-' || ? || ' days') AS day,
  (SELECT COUNT(*) FROM todos
     WHERE project_id = ? AND completed_at IS NOT NULL
       AND date(completed_at, 'localtime') = date('now', 'localtime', '-' || ? || ' days')) AS completed,
  (SELECT COUNT(*) FROM todos
     WHERE project_id = ? AND archived_at IS NULL
       AND date(created_at, 'localtime') <= date('now', 'localtime', '-' || ? || ' days')
       AND (completed_at IS NULL OR date(completed_at, 'localtime') > date('now', 'localtime', '-' || ? || ' days'))
  ) AS backlog`;

// One query per day (not one query with a generated date series): CHART_DAYS
// is a small constant (7), so this is seven cheap indexed lookups, and each
// day's "day" label and both its counts come from ONE statement - so a
// single moment's `'now'` decides all three, never two statements whose
// `'now'` could in principle straddle a boundary between them.
// Exported so tests can assert on the actual computed local-day buckets
// directly, rather than reverse-engineering SVG coordinates or regexing the
// generated markup for its own sake (test/CLAUDE.md's own bar) - this is the
// seam that actually varies with the timezone-sensitive behaviour under
// test, per .claude/sessions/dead-ends/2026-08-05-helper-whose-parameters-
// cannot-disagree.md's own lesson: make the thing that DIFFERS the unit.
export function fetchDayStats(projectId: number): DayStats[] {
  const stats: DayStats[] = [];
  for (let offset = CHART_DAYS - 1; offset >= 0; offset--) {
    const row = db.prepare(DAY_STATS_SQL).get(offset, projectId, offset, projectId, offset, offset) as DayStats;
    stats.push(row);
  }
  return stats;
}

const CHART_WIDTH = 640;
const CHART_HEIGHT = 200;
const CHART_PAD_LEFT = 34;
const CHART_PAD_RIGHT = 10;
const CHART_PAD_TOP = 10;
const CHART_PAD_BOTTOM = 26;
const CHART_COMPLETED_COLOR = "#2f9e63"; // matches --ok
const CHART_BACKLOG_COLOR = "#3a7dc4"; // matches --live

// Hand-drawn, inline SVG - no chart library, no CDN (plan-dashboard-v1
// decision 5: the page is one self-contained file that has to work from
// file:// with no network). Axes are sized to whatever the real data is
// (no hardcoded scale): the y-axis max is the largest value EITHER series
// actually reaches this render, with a little headroom so the top point's
// own dot never clips against the plot's edge. Every one of the
// CHART_DAYS days is always plotted, including a day whose count is
// genuinely zero - the data is never filtered down to "days with activity",
// so a zero renders as a point sitting on the baseline, not as a gap in the
// line.
function buildThroughputChart(stats: DayStats[]): string {
  const plotWidth = CHART_WIDTH - CHART_PAD_LEFT - CHART_PAD_RIGHT;
  const plotHeight = CHART_HEIGHT - CHART_PAD_TOP - CHART_PAD_BOTTOM;
  const drawHeight = plotHeight - 6; // headroom so a max-value point's dot never clips the top edge
  const maxValue = Math.max(1, ...stats.map((s) => s.completed), ...stats.map((s) => s.backlog));
  const stepX = stats.length > 1 ? plotWidth / (stats.length - 1) : 0;
  const xAt = (i: number): number => CHART_PAD_LEFT + i * stepX;
  const yAt = (v: number): number => CHART_PAD_TOP + 3 + drawHeight - (v / maxValue) * drawHeight;
  const baselineY = CHART_PAD_TOP + plotHeight;

  const polyline = (values: number[]): string =>
    values.map((v, i) => `${xAt(i).toFixed(1)},${yAt(v).toFixed(1)}`).join(" ");
  const dots = (values: number[], color: string): string =>
    values
      .map((v, i) => `<circle cx="${xAt(i).toFixed(1)}" cy="${yAt(v).toFixed(1)}" r="2.5" fill="${color}" />`)
      .join("");

  const dayLabels = stats
    .map((s, i) => {
      const isToday = i === stats.length - 1;
      const label = escapeHtml(s.day.slice(5)) + (isToday ? "*" : ""); // MM-DD, today marked partial
      return (
        `<text x="${xAt(i).toFixed(1)}" y="${CHART_HEIGHT - 8}" font-size="10" ` +
        `text-anchor="middle" fill="currentColor">${label}</text>`
      );
    })
    .join("");

  return `<svg viewBox="0 0 ${CHART_WIDTH} ${CHART_HEIGHT}" class="chart" role="img" aria-label="7-day todo throughput and backlog, bucketed by local day">
<line x1="${CHART_PAD_LEFT}" y1="${CHART_PAD_TOP}" x2="${CHART_PAD_LEFT}" y2="${baselineY}" stroke="currentColor" stroke-opacity="0.4" />
<line x1="${CHART_PAD_LEFT}" y1="${baselineY}" x2="${CHART_PAD_LEFT + plotWidth}" y2="${baselineY}" stroke="currentColor" stroke-opacity="0.4" />
<text x="${CHART_PAD_LEFT - 4}" y="${baselineY}" font-size="10" text-anchor="end" fill="currentColor">0</text>
<text x="${CHART_PAD_LEFT - 4}" y="${CHART_PAD_TOP + 8}" font-size="10" text-anchor="end" fill="currentColor">${maxValue}</text>
<polyline points="${polyline(stats.map((s) => s.backlog))}" fill="none" stroke="${CHART_BACKLOG_COLOR}" stroke-width="2" />
<polyline points="${polyline(stats.map((s) => s.completed))}" fill="none" stroke="${CHART_COMPLETED_COLOR}" stroke-width="2" />
${dots(stats.map((s) => s.backlog), CHART_BACKLOG_COLOR)}
${dots(stats.map((s) => s.completed), CHART_COMPLETED_COLOR)}
${dayLabels}
</svg>`;
}

function renderThroughputSection(stats: DayStats[]): string {
  const totalCompleted7d = stats.reduce((sum, s) => sum + s.completed, 0);
  const currentBacklog = stats[stats.length - 1].backlog;
  const body =
    `<p class="muted">` +
    `<span class="legend-swatch" style="background:${CHART_COMPLETED_COLOR}"></span> completed that day (throughput) &nbsp; ` +
    `<span class="legend-swatch" style="background:${CHART_BACKLOG_COLOR}"></span> open backlog at end of day &nbsp; ` +
    `&mdash; bucketed by LOCAL calendar day. Today (*) is still in progress, not a full day.</p>` +
    buildThroughputChart(stats);
  return section("throughput", "Throughput", `${totalCompleted7d} completed 7d · ${currentBacklog} backlog now`, body);
}

// ---------------------------------------------------------------------------
// Section: in flight - running agents and their live state.

interface RunningAgentRow {
  id: number;
  name: string;
  kind: string;
  actor_id: string;
  agent_state: string;
  state_changed_at: string | null;
  created_at: string;
}

// hasStateChannel's own comment has the full reasoning. For a row with none
// (today only a lead), the badge and its "since" line are replaced with the
// last thing this actor actually logged, which is real and does exist
// (agent_state_log carries no kind gate at all - every actor's hook writes
// there) - never a fabricated "unknown" status.
function renderAgentRow(a: RunningAgentRow): string {
  if (!hasStateChannel(a.kind)) {
    const last = fetchLastLogEvent(a.actor_id);
    const lastLine = last
      ? `last event: ${escapeHtml(last.event)}, ${timeEl(last.created_at)}`
      : "no log event recorded";
    return (
      `<li class="agent">${escapeHtml(a.name)} <span class="muted">(${escapeHtml(a.kind)})</span> ` +
      `<span class="muted">${lastLine}</span></li>`
    );
  }
  return (
    `<li class="agent">${statusBadge(agentStatusLevel(a.agent_state), a.agent_state)} ` +
    `${escapeHtml(a.name)} <span class="muted">(${escapeHtml(a.kind)})</span> ` +
    `<span class="muted">since ${timeEl(a.state_changed_at ?? a.created_at)}</span></li>`
  );
}

function renderAgentsSection(projectId: number): string {
  const all = db
    .prepare(
      `SELECT id, name, kind, actor_id, agent_state, state_changed_at, created_at
       FROM agents WHERE project_id = ? AND status = 'running' ORDER BY created_at`,
    )
    .all(projectId) as RunningAgentRow[];
  const shown = all.slice(0, AGENT_CAP);
  const rows = shown.map(renderAgentRow).join("\n");
  const body = renderCappedList(shown.length, all.length, "running agents", "agents", rows, "No agents running.");
  return section("agents", "In Flight", `${all.length} running`, body);
}

// ---------------------------------------------------------------------------
// Section: pending wakes, with local fire times.

interface WakeRow {
  id: number;
  kind: string;
  body: string;
  owner: string;
  deliver_actor: string;
  due_at: string | null;
  max_wait_at: string | null;
  fire_count: number;
  repeat_every_ms: number | null;
  held_at: string | null;
}

function renderWakesSection(projectId: number): string {
  const all = db
    .prepare(
      `SELECT id, kind, body, owner, deliver_actor, due_at, max_wait_at, fire_count, repeat_every_ms, held_at
       FROM timers WHERE project_id = ? AND ${PENDING_WAKE_WHERE}
       ORDER BY COALESCE(due_at, max_wait_at, created_at)`,
    )
    .all(projectId) as WakeRow[];
  const shown = all.slice(0, WAKE_CAP);
  const rows = shown
    .map((w) => {
      const truncated = truncateWithEllipsis(w.body, 160);
      const when =
        w.kind === "delay"
          ? `fires ${timeEl(w.due_at)}${w.repeat_every_ms ? ` <span class="muted">(repeats)</span>` : ""}`
          : `fires when watched agents go idle, by ${timeEl(w.max_wait_at)} at the latest`;
      // A held wake (stuck behind a dialog, or unsubmitted input in its
      // target pane - src/scheduler.ts's deliverable()) is worth a glance in
      // a way an ordinary pending one is not, so it reads warn rather than
      // live: "this one needs a human", not "this one is on schedule".
      const status = statusBadge(w.held_at ? "warn" : "live", w.held_at ? "held" : "pending");
      return (
        `<li class="wake">${status} #${w.id} <span class="muted">[${escapeHtml(w.kind)}]</span> ${when}` +
        `<span class="wake-body">${prose(truncated)}</span> ` +
        `<span class="muted">owner ${escapeHtml(w.owner)} → ${escapeHtml(w.deliver_actor)}</span></li>`
      );
    })
    .join("\n");
  const body = renderCappedList(shown.length, all.length, "pending wakes", "wakes", rows, "No pending wakes.");
  return section("wakes", "Wakes", `${all.length} pending`, body);
}

// ---------------------------------------------------------------------------
// Section: recent activity - todo comments and agent_state_log transitions,
// merged into one reverse-chronological list.

interface ActivityEntry {
  created_at: string;
  html: string;
}

interface CommentActivityRow {
  id: number;
  body: string;
  author: string;
  created_at: string;
  todo_id: number;
  todo_title: string;
}

interface StateLogActivityRow {
  id: number;
  event: string;
  state: string;
  created_at: string;
  agent_name: string;
}

interface ActivitySource {
  entries: ActivityEntry[];
  total: number;
}

function fetchCommentActivity(projectId: number): ActivitySource {
  // COUNT(*) OVER () rather than a second COUNT(*) query: it is evaluated
  // over every row matching the WHERE/JOIN before ORDER BY/LIMIT truncates
  // the OUTPUT, so it carries the TRUE total on every returned row - one
  // scan instead of two. Verified directly (not assumed): 35 comments
  // seeded, LIMIT 30, every one of the 30 returned rows read total_count
  // 35, not 30.
  const rows = db
    .prepare(
      `SELECT c.id, c.body, c.author, c.created_at, t.id AS todo_id, t.title AS todo_title,
         COUNT(*) OVER () AS total_count
       FROM todo_comments c JOIN todos t ON t.id = c.todo_id
       WHERE t.project_id = ?
       ORDER BY c.created_at DESC, c.id DESC LIMIT ${ACTIVITY_SOURCE_LIMIT}`,
    )
    .all(projectId) as (CommentActivityRow & { total_count: number })[];
  const total = rows.length > 0 ? rows[0].total_count : 0;
  const entries = rows.map((r) => {
    const truncated = truncateWithEllipsis(r.body, 200);
    return {
      created_at: r.created_at,
      html:
        `<li class="activity"><span class="tag">[comment]</span> ${timeEl(r.created_at)} ` +
        `<span class="muted">${escapeHtml(r.author)}</span> on #${r.todo_id} ${prose(r.todo_title)}` +
        `<div class="activity-body">${prose(truncated)}</div></li>`,
    };
  });
  return { entries, total };
}

// Joins each log row to the one agents row that owns its actor_id today,
// preferring a running row over a closed one and the highest id among ties -
// the same join shape as DELIVER_SOCKET_JOIN in src/scheduler.ts, copied
// rather than imported for the same reason PENDING_WAKE_WHERE is copied
// above. agent_state_log carries no project_id of its own by design (see the
// migration's comment in src/db.ts): a hook must never fail, and a foreign
// key to a row that can be closed and swept would risk exactly that.
function fetchStateLogActivity(projectId: number): ActivitySource {
  // Same COUNT(*) OVER () consolidation as fetchCommentActivity above, and
  // more load-bearing here: agent_state_log is append-only and can hold up
  // to LOG_MAX_ROWS (20,000, src/scheduler.ts) rows, and the correlated
  // actor_id -> agents join has no index to drive a LIMIT-style early exit.
  // A separate COUNT(*) query paid for that full join twice on every
  // regenerate; one query pays for it once.
  const rows = db
    .prepare(
      `SELECT l.id, l.event, l.state, l.created_at, a.name AS agent_name,
         COUNT(*) OVER () AS total_count
       FROM agent_state_log l
       JOIN agents a ON a.id = (
         SELECT ag.id FROM agents ag WHERE ag.actor_id = l.actor_id
          ORDER BY (ag.status = 'running') DESC, ag.id DESC LIMIT 1
       )
       WHERE a.project_id = ?
       ORDER BY l.created_at DESC, l.id DESC LIMIT ${ACTIVITY_SOURCE_LIMIT}`,
    )
    .all(projectId) as (StateLogActivityRow & { total_count: number })[];
  const total = rows.length > 0 ? rows[0].total_count : 0;
  const entries = rows.map((r) => ({
    created_at: r.created_at,
    html:
      `<li class="activity"><span class="tag">[state]</span> ${timeEl(r.created_at)} ` +
      `${escapeHtml(r.agent_name)} → ${escapeHtml(r.state)} <span class="muted">(${escapeHtml(r.event)})</span></li>`,
  }));
  return { entries, total };
}

// The cap note's "total" is the TRUE count from both sources (COUNT(*),
// unbounded), never merged.length. merged.length is bounded twice over - once
// by each source's own ACTIVITY_SOURCE_LIMIT, once by the slice below - and
// reporting it as "total" would silently hide whatever a source's own LIMIT
// already dropped before the merge ever saw it: the two-stage version of the
// exact silent-cap defect this whole file's cap notes exist to prevent.
function renderActivitySection(projectId: number): string {
  const comments = fetchCommentActivity(projectId);
  const stateLog = fetchStateLogActivity(projectId);
  const total = comments.total + stateLog.total;
  const merged = [...comments.entries, ...stateLog.entries].sort((a, b) =>
    sortKey(b.created_at).localeCompare(sortKey(a.created_at)),
  );
  const shown = merged.slice(0, ACTIVITY_DISPLAY_CAP);
  const body = renderCappedList(
    shown.length,
    total,
    "recent activity entries",
    "activities",
    shown.map((e) => e.html).join("\n"),
    "No recent activity.",
  );
  return section("activity", "Activity", `${total} recent`, body);
}

// ---------------------------------------------------------------------------
// Additional section, added on Chris's request: every active pad, listed and
// individually expandable. Placed after Activity - reference material for
// browsing, not part of the "what's going on, what's next" narrative the
// earlier sections answer.

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Pad names are unique per project (idx_scratchpads_active_name), but two
// DIFFERENT names could in principle slug to the same id after stripping -
// accepted rather than guarded against: the only consequence is that two
// such pads would share one sessionStorage expand/collapse entry, a cosmetic
// residual on a read-only page, not a correctness one.
function slugForId(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "-");
}

interface PadListRow {
  name: string;
  content: string;
  revision: number;
  updated_at: string;
}

// ACTIVE PADS ONLY (archived = 0): an archived pad is not live state, and
// inlining it too would roughly triple this section's size for data nobody
// reading "what's going on right now" needs - measured on the real store
// this lane targets, 9 active pads besides the board run ~388KB; adding
// archived ones was measured at 1.25MB. `board` is excluded outright: it
// already has its own section above, in full, and inlining its ~53KB a
// second time here would be silly - the intro line below says so in one
// line rather than leaving the omission to speak for itself.
const PADS_LIST_SQL = `
  SELECT name, content, revision, updated_at FROM scratchpads
  WHERE project_id = ? AND archived = 0 AND name != 'board'
  ORDER BY name`;

function renderPadsSection(projectId: number): string {
  const pads = db.prepare(PADS_LIST_SQL).all(projectId) as PadListRow[];
  const intro = `<p class="muted">Active pads other than "board" (shown in its own section above).</p>`;
  const list =
    pads.length > 0
      ? pads
          .map((p) => {
            const size = formatBytes(Buffer.byteLength(p.content, "utf8"));
            const count = `rev ${p.revision} · updated ${formatLocal(p.updated_at)} local · ${size}`;
            return (
              `<details class="pad-item" id="pad-${slugForId(p.name)}">` +
              `<summary class="pane-border pane-border-sub"><span class="pb-label">${prose(p.name)}</span>` +
              `<span class="pb-count">${escapeHtml(count)}</span></summary>` +
              `<div class="section-body"><pre class="board">${escapeHtml(p.content)}</pre></div>` +
              `</details>`
            );
          })
          .join("\n")
      : `<p class="muted">No other active pads.</p>`;
  return section("pads", "Pads", `${pads.length} pad${pads.length === 1 ? "" : "s"}`, intro + list);
}

// ---------------------------------------------------------------------------
// Shared page chrome.

// pluralNoun is the whole plural phrase ("open todos", "recent activity
// entries"), not a singular auto-pluralized with a bare "s" - "entry" + "s"
// reads as "entrys", and that bug is exactly the shape a fixture too small to
// reach the cap would hide (test/CLAUDE.md's shape 6).
function capNote(shown: number, total: number, pluralNoun: string): string {
  if (shown >= total) return "";
  return `<p class="cap-note">Showing ${shown} of ${total} ${pluralNoun} (capped).</p>`;
}

// The shape every list section shares: a cap note (empty when nothing was
// dropped) followed by either the rendered list or an empty-state message.
// Only the CSS class, plural noun, rows markup, and empty message differ
// per section.
function renderCappedList(
  shownCount: number,
  total: number,
  pluralNoun: string,
  listClass: string,
  rowsHtml: string,
  emptyMessage: string,
): string {
  return (
    capNote(shownCount, total, pluralNoun) +
    (shownCount > 0 ? `<ul class="${listClass}">${rowsHtml}</ul>` : `<p class="muted">${emptyMessage}</p>`)
  );
}

// <details> gives collapse/expand for free with no JS required for the
// mechanism itself; the inline script below only persists which elements are
// open across the 10s meta-refresh, which <details> does not do on its own.
//
// countText is the thing a CLOSED section still says out loud ("todos — 4
// open, 1 blocked"): Chris's own framing is that a collapsed section telling
// you nothing is just a wall of chrome, so every summary carries one. Always
// plain text (escaped here, like title), never HTML the caller half-built -
// every count on this page is numbers and fixed words, never user data, so
// there is nothing a caller would ever need to pass pre-escaped.
//
// The summary is styled as a tmux pane-border-status line (`.pane-border` in
// STYLE below) rather than a boxed card header - hive's own vernacular
// instead of invented dashboard chrome, per Chris's instruction.
//
// defaultOpen is what the HTML says BEFORE sessionStorage has a chance to
// run - the state a reader with no stored preference (or a fresh tab) sees.
// EVERY section defaults CLOSED now (the visual redesign's own point: the
// NOW strip above is the only thing expanded by default, full stop) - and
// because that default lives in the markup itself, not in SCRIPT, a reader
// whose JavaScript fails to run still sees a closed, uncluttered page rather
// than one silently defaulting back open. SCRIPT's restore step always runs
// after this markup lands, so a reader who has actually toggled a section
// keeps getting THEIR choice back, every refresh; this default only governs
// the very first render of a session with no stored preference at all.
function section(id: string, title: string, countText: string, body: string, defaultOpen = false): string {
  return (
    `<details class="section" id="section-${id}"${defaultOpen ? " open" : ""}>` +
    `<summary class="pane-border"><span class="pb-label">${escapeHtml(title)}</span>` +
    `<span class="pb-count">${escapeHtml(countText)}</span></summary>` +
    `<div class="section-body">${body}</div></details>`
  );
}

// Colors map onto hive's own ok/warn/fail/live vocabulary rather than an
// invented palette (Chris's instruction) - four hues total, plus neutrals.
// Full light palette on :root, dark values overridden only where they
// differ (prefers-color-scheme, no toggle - this is a generated static
// file, not an Artifact with a runtime theme switch). body gets an explicit
// background so it can never inherit the viewer's own page color. Avoided
// on purpose: acid green on near-black (the default "hacker terminal"
// look) and cream-with-terracotta (the default "warm SaaS" look) - neither
// says anything about this tool. Dark mode is graphite, not black; every
// status hue is muted rather than neon.
const STYLE = `
  :root {
    color-scheme: light dark;
    --font-mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    --font-sans: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    --bg: #f6f7f8;
    --panel: #ffffff;
    --fg: #1b1e22;
    --fg-muted: #5b6470;
    --border: #d5d9de;
    --ok: #1f7a4d;
    --warn: #9a5b00;
    --fail: #a4291f;
    --live: #1f5fa8;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #14171a;
      --panel: #1b1f24;
      --fg: #e7e9ec;
      --fg-muted: #9aa3ad;
      --border: #2b3138;
      --ok: #4fbf87;
      --warn: #d99a3d;
      --fail: #e2685f;
      --live: #5b9bd8;
    }
  }
  *, *::before, *::after { box-sizing: border-box; }
  body { font-family: var(--font-mono); margin: 0; padding: 0.75rem 1rem 3rem;
    background: var(--bg); color: var(--fg); line-height: 1.45; }
  .prose { font-family: var(--font-sans); }
  h1 { font-size: 1rem; margin: 0 0 0.2rem; font-weight: 600; }
  .generated { color: var(--fg-muted); font-size: 0.78rem; margin-bottom: 0.75rem; }

  .now { background: var(--panel); border-top: 2px solid var(--live); padding: 0.7rem 0.85rem 0.8rem;
    margin-bottom: 1rem; }
  .now-row { padding: 0.15rem 0; display: flex; gap: 0.5rem; align-items: baseline; flex-wrap: wrap; }
  .now-label { color: var(--fg-muted); font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.05em;
    min-width: 5.2rem; flex: 0 0 auto; }
  .now-chart { align-items: center; }
  svg.spark { flex: 1 1 auto; min-width: 100px; max-width: 260px; height: 32px; display: block; }

  summary { cursor: pointer; }
  summary::-webkit-details-marker { display: none; }
  summary.pane-border { list-style: none; display: flex; align-items: baseline; padding: 0.55rem 0;
    font-family: var(--font-mono); font-size: 0.95rem; color: var(--fg); }
  summary.pane-border::before { content: "▸ ─"; color: var(--fg-muted); margin-right: 0.5rem; flex: 0 0 auto; }
  details[open] > summary.pane-border::before { content: "▾ ─"; }
  summary.pane-border .pb-label { font-weight: 600; flex: 0 0 auto; }
  summary.pane-border .pb-count { color: var(--fg-muted); font-size: 0.78rem; margin-left: 0.55rem;
    flex: 0 0 auto; white-space: nowrap; }
  summary.pane-border::after { content: ""; flex: 1 1 auto; border-top: 1px solid var(--border);
    margin-left: 0.6rem; align-self: center; min-width: 1rem; }
  summary:focus-visible { outline: 2px solid var(--live); outline-offset: 2px; }
  summary.pane-border-sub { font-size: 0.85rem; padding: 0.4rem 0; }

  details.section { margin: 0 0 0.25rem; }
  .section-body { padding: 0.35rem 0 0.85rem; }
  details.pad-item { margin: 0.2rem 0; }
  details.pad-item .section-body { padding: 0.3rem 0 0.6rem; }

  .meta, .muted { color: var(--fg-muted); font-size: 0.82rem; }
  .cap-note { color: var(--fg-muted); font-size: 0.8rem; font-style: italic; }
  pre.board { white-space: pre; overflow-x: auto; background: var(--panel); border: 1px solid var(--border);
    padding: 0.7rem; font-family: var(--font-mono); }
  ul { list-style: none; margin: 0; padding: 0; }
  li { padding: 0.35rem 0; border-bottom: 1px solid var(--border); }
  li:last-child { border-bottom: none; }

  .status { font-weight: 700; }
  .status-ok { color: var(--ok); }
  .status-warn { color: var(--warn); }
  .status-fail { color: var(--fail); }
  .status-live { color: var(--live); }
  .tag { color: var(--fg-muted); }

  .priority-high { color: var(--fail); font-weight: bold; }
  .priority-medium { color: var(--warn); }
  .priority-low { color: var(--fg-muted); }
  .blockers { font-size: 0.85rem; color: var(--fg-muted); margin-left: 1.4rem; }
  .wake-body { display: block; margin-top: 0.15rem; }
  .activity-body { font-size: 0.85rem; margin-left: 1.4rem; margin-top: 0.15rem; white-space: pre-wrap; }

  svg.chart { width: 100%; height: auto; display: block; margin-top: 0.35rem; }
  .legend-swatch { display: inline-block; width: 0.7rem; height: 0.7rem; margin-right: 0.2rem;
    vertical-align: middle; }

  .header-row { display: flex; align-items: baseline; justify-content: space-between; gap: 0.75rem;
    flex-wrap: wrap; }
  .live-toggle { display: inline-flex; align-items: center; gap: 0.4rem; cursor: pointer;
    font-size: 0.82rem; color: var(--fg-muted); flex: 0 0 auto; }
  .live-toggle input[type="checkbox"] { appearance: none; -webkit-appearance: none; width: 2.1rem;
    height: 1.15rem; background: var(--border); border-radius: 999px; position: relative; margin: 0;
    cursor: pointer; transition: background 0.15s ease; }
  .live-toggle input[type="checkbox"]::before { content: ""; position: absolute; top: 2px; left: 2px;
    width: 0.95rem; height: 0.95rem; border-radius: 50%; background: var(--panel);
    transition: transform 0.15s ease; }
  .live-toggle input[type="checkbox"]:checked { background: var(--live); }
  .live-toggle input[type="checkbox"]:checked::before { transform: translateX(0.95rem); }
  .live-toggle input[type="checkbox"]:focus-visible { outline: 2px solid var(--live); outline-offset: 2px; }
  .live-note { color: var(--fg-muted); font-size: 0.76rem; margin: 0.2rem 0 0.75rem; }

  @media (prefers-reduced-motion: reduce) {
    * { transition: none !important; animation: none !important; }
  }
`;

// Persists scroll position, every <details>'s open/closed state, and the
// Live toggle in sessionStorage, restored on load. Required because a
// reload (meta refresh originally, now this file's own timer below) is a
// full navigation: without this the page scroll-jumps to the top and
// re-expands every section on every cycle, which is unusable at this data
// volume (plan-dashboard-v1).
//
// Selects every "details[id]", not just "details.section": the pads section
// (renderPadsSection) nests one <details id="pad-..."> per pad, and a reader
// who expands one wants it to stay expanded across the reload exactly the
// way a top-level section does - one mechanism, not two, and a future
// nested <details> with an id is covered automatically with no second edit
// here.
//
// RESTORE RUNS FIRST, as the very first statements in this IIFE, with
// nothing gating it behind DOMContentLoaded or load: every cycle is now a
// full navigation, so scroll position and section state have to be fixed up
// before the reader can perceive the reset the reload just did, not after
// the whole document (and whatever future feature gets added below this
// comment) has settled. Keep new code AFTER this block, never before it.
const SCRIPT = `
  (function () {
    var KEY = "hive-dashboard-state";
    function load() {
      try { return JSON.parse(sessionStorage.getItem(KEY) || "{}"); } catch (e) { return {}; }
    }
    function save(state) {
      try { sessionStorage.setItem(KEY, JSON.stringify(state)); } catch (e) {}
    }
    var state = load();
    document.querySelectorAll("details[id]").forEach(function (el) {
      var stored = state.sections && state.sections[el.id];
      if (stored !== undefined) el.open = stored;
      el.addEventListener("toggle", function () {
        var s = load();
        s.sections = s.sections || {};
        s.sections[el.id] = el.open;
        save(s);
      });
    });
    if (typeof state.scrollY === "number") window.scrollTo(0, state.scrollY);

    // Live toggle. Replaces <meta http-equiv="refresh">, which the browser
    // schedules at PARSE TIME - removing the tag afterward does not cancel
    // it, so a toggle could never turn it off. A setTimeout can be cleared,
    // so this is a timer instead, stored in a variable for exactly that.
    // location.reload() is a NAVIGATION, not a fetch(), so it still works
    // from file:// - the fetch() restriction that forced meta refresh in
    // the first place (plan-dashboard-v1, decision 6) does not apply to it.
    var reloadTimer = null;
    function armReload() {
      if (reloadTimer !== null) return;
      reloadTimer = setTimeout(function () { location.reload(); }, 10000);
    }
    function clearReload() {
      if (reloadTimer !== null) { clearTimeout(reloadTimer); reloadTimer = null; }
    }
    var toggle = document.getElementById("live-toggle");
    var stamp = document.getElementById("generated-stamp");
    var stampTime = stamp ? stamp.getAttribute("data-time") : "";
    function paintStamp(live) {
      if (!stamp) return;
      stamp.textContent = live
        ? "generated " + stampTime + " local, refreshes every 10s. Read-only: nothing here writes back to the store."
        : "paused, generated " + stampTime + " local. Read-only: nothing here writes back to the store.";
    }
    var live = typeof state.live === "boolean" ? state.live : true;
    if (toggle) toggle.checked = live;
    paintStamp(live);
    if (live) armReload(); else clearReload();
    if (toggle) {
      toggle.addEventListener("change", function () {
        var s = load();
        s.live = toggle.checked;
        save(s);
        paintStamp(toggle.checked);
        if (toggle.checked) armReload(); else clearReload();
      });
    }

    window.addEventListener("beforeunload", function () {
      var s = load();
      s.scrollY = window.scrollY;
      save(s);
    });
  })();
`;

// Counselors (brief-dashboard-successor items 2-4, both seats,
// independently). The dashboard_meta.last_mark column used to hold a
// hand-picked set of MAX() columns (see dashboard_meta's own migration
// comment in src/db.ts for that design's history) that was a SHADOW of
// exactly what the render functions above actually read - and the shadow
// was already wrong four ways: wake_update(body) changes rendered text
// (renderWakesSection) but touches none of the timer columns the old mark
// watched; agent_rename writes agents.name with no timestamp at all;
// pad_delete is a hard DELETE, so MAX(updated_at) stays monotonic and can go
// on describing a pad that no longer exists; and two writes inside one
// whole-second timestamp can make the second one invisible. None of those
// were "stale for one interval" - they were stale until some UNRELATED
// watched value happened to change, which on a quiet project could be
// never. And per counselors' own finding 5, the shadow was not even cheap:
// its state_log_mark clause ran the identical expensive correlated join
// fetchStateLogActivity does, once per agent_state_log row, defeating its
// own purpose.
//
// Replaced with a hash of the RENDERED CONTENT itself - correct by
// construction, since there is no second query to drift out of sync with
// what actually gets rendered. renderDashboardForWrite is the one function
// that does this: it renders every section and the project name exactly
// once, returns both the finished HTML (for the caller to maybe write) and
// a hash of that same render (for the caller to compare against
// dashboard_meta.last_mark) - so scheduler.ts's dirty check no longer costs
// a second render the way the old mark query effectively did.
//
// THE STAMP-EXCLUSION TRAP, decided deliberately rather than discovered by
// a failing test: renderDashboard's own output embeds a "generated at"
// timestamp (see the `generatedLocal` line below), which changes on every
// single call. Hashing the FULL html including that stamp would make the
// hash differ every render, permanently defeat the dirty check, and write
// the file every scheduler tick forever - the identical self-defeating
// bookkeeping shape that killed this table's own total_changes() design
// (src/db.ts's dashboard_meta comment: "the dirty check was defeated by its
// own bookkeeping, forever"). So the hash is computed over the project name
// and the rendered SECTIONS only, joined with a NUL separator (content
// this page's own escapeHtml never produces, so two different underlying
// renders cannot collide onto the same joined string by accident) - never
// over the timestamp. The timestamp is appended to the html AFTER hashing,
// in the same render pass, so what gets hashed and what gets displayed stay
// derived from one single set of section renders.
//
// The NOW strip, the throughput chart (in both its sparkline and detailed
// forms) and the pads list are all built from STORE data and from LOCAL
// CALENDAR DAY boundaries that only change once every 24h - none of them
// reads wall-clock "now" into its own displayed content the way the page's
// "generated at" stamp does, so none of them defeats this hash the way a
// naive full-html hash would.
function buildDashboard(projectId: number): {
  projectName: string;
  sections: string;
  html: string;
} {
  const project = fetchProject(projectId);
  const stats = fetchDayStats(projectId);
  const sections = [
    renderNowStrip(projectId, stats),
    renderBoardSection(projectId),
    renderTodosSection(projectId),
    renderThroughputSection(stats),
    renderAgentsSection(projectId),
    renderWakesSection(projectId),
    renderActivitySection(projectId),
    renderPadsSection(projectId),
  ].join("\n");
  const generatedLocal = formatDate(new Date());
  // No <meta http-equiv="refresh"> here any more - SCRIPT's own timer
  // replaces it, precisely so the Live toggle can turn it off (see SCRIPT's
  // own comment for why a meta tag could not support that). The checkbox
  // defaults `checked` in the markup itself, matching every other on/off
  // default on this page (section()'s own defaultOpen): a reader whose
  // JavaScript never runs still sees a page that LOOKS live, even though
  // without JS nothing here ever reloads or toggles - the honest limit of a
  // "no libraries, self-contained" page.
  const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>hive dashboard - ${escapeHtml(project.name)}</title>
<style>${STYLE}</style>
</head>
<body>
<h1>hive dashboard - ${escapeHtml(project.name)}</h1>
<div class="header-row">
<div class="generated" id="generated-stamp" data-time="${escapeHtml(generatedLocal)}">generated ${escapeHtml(generatedLocal)} local, refreshes every 10s. Read-only: nothing here writes back to the store.</div>
<label class="live-toggle"><input type="checkbox" id="live-toggle" role="switch" checked><span>Live</span></label>
</div>
<p class="live-note">Turning Live off stops this page from reloading; the scheduler keeps the file itself up to date either way - a browser page cannot signal it back without a server.</p>
${sections}
<script>${SCRIPT}</script>
</body>
</html>
`;
  return { projectName: project.name, sections, html };
}

// Render the project's store as one self-contained HTML document. Read-only:
// no forms, no writes, no editing anywhere on the page.
export function renderDashboard(projectId: number): string {
  return buildDashboard(projectId).html;
}

// src/scheduler.ts's write hook. One render produces both values it needs:
// the html to (maybe) write, and a hash of that render's content - excluding
// the "generated at" stamp, see buildDashboard's own comment above for why -
// to compare against dashboard_meta.last_mark.
export function renderDashboardForWrite(projectId: number): { html: string; contentHash: string } {
  const { projectName, sections, html } = buildDashboard(projectId);
  const contentHash = createHash("sha256").update(projectName).update("\0").update(sections).digest("hex");
  return { html, contentHash };
}
