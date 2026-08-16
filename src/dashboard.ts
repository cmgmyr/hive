import { createHash } from "node:crypto";
import { db } from "./db.js";
import { getProject } from "./context.js";

import { awaitingFirstPrompt } from "./firstPrompt.js";

import { cutToUnitBudget, fallbackSlug } from "./slug.js";

export const TODO_CAP = 100;
export const AGENT_CAP = 50;
export const WAKE_CAP = 50;
export const ACTIVITY_SOURCE_LIMIT = 30;
export const ACTIVITY_DISPLAY_CAP = 40;

export function truncateWithEllipsis(text: string, maxLength: number): string {
  return text.length > maxLength ? `${cutToUnitBudget(text, maxLength)}…` : text;
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function prose(text: string): string {
  return `<span class="prose">${escapeHtml(text)}</span>`;
}

type StatusLevel = "ok" | "warn" | "fail" | "live";

function statusBadge(level: StatusLevel, text: string): string {
  const word = level === "fail" ? "FAIL" : level;
  return `<span class="status status-${level}">${word}</span> ${escapeHtml(text)}`;
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

function formatDate(d: Date): string {
  return (
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
    `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
  );
}

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

function sortKey(createdAt: string): string {
  return createdAt.includes(".") ? createdAt : `${createdAt}.000`;
}

function fetchProject(projectId: number): { id: number; name: string } {
  const row = getProject(projectId);
  if (!row) throw new Error(`No project ${projectId}.`);
  return row;
}

const PENDING_WAKE_WHERE = "cancelled_at IS NULL AND (fired_at IS NULL OR repeat_every_ms IS NOT NULL)";

function agentStatusLevel(state: string): StatusLevel {
  if (state === "working") return "live";
  if (state === "idle") return "ok";
  if (state === "waiting") return "warn";
  return "warn";
}

function agentStateBadge(a: { agent_state: string; resumed_at: string }): string {
  return awaitingFirstPrompt(a) && a.agent_state === "idle"
    ? statusBadge("live", "idle (no assignment yet)")
    : statusBadge(agentStatusLevel(a.agent_state), a.agent_state);
}

function hasStateChannel(kind: string): boolean {
  return kind === "agent";
}

interface LastLogEvent {
  event: string;
  created_at: string;
}

function fetchLastLogEvent(actorId: string): LastLogEvent | undefined {
  return db
    .prepare("SELECT event, created_at FROM agent_state_log WHERE actor_id = ? ORDER BY id DESC LIMIT 1")
    .get(actorId) as LastLogEvent | undefined;
}

interface RunningAgentBrief {
  name: string;
  kind: string;
  agent_state: string;
  resumed_at: string;
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
      `SELECT name, kind, agent_state, resumed_at FROM agents
       WHERE project_id = ? AND status = 'running' ORDER BY created_at`,
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

const NOW_AGENTS_SHOWN = 5;

function renderNowAgentsLine(agents: RunningAgentBrief[]): string {
  if (agents.length === 0) return "no workers running";
  const shown = agents.slice(0, NOW_AGENTS_SHOWN);
  const parts = shown.map((a) =>
    hasStateChannel(a.kind)
      ? `${escapeHtml(a.name)} ${agentStateBadge(a)}`
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

interface OpenTodoRow {
  id: number;
  title: string;
  body: string;
  slug: string;
  status: string;
  priority: string;
  open_blockers: number;
}

interface BlockerRef {
  id: number;
  title: string;
}

const OPEN_TODOS_SQL = `
  SELECT t.id, t.title, t.body, t.slug, t.status, t.priority,
    (SELECT COUNT(*) FROM todo_blockers b JOIN todos bt ON bt.id = b.blocker_id
      WHERE b.todo_id = t.id AND bt.status != 'completed') AS open_blockers
  FROM todos t
  WHERE t.project_id = ? AND t.archived_at IS NULL AND t.status != 'completed'
  ORDER BY CASE t.priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, t.id`;

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

function todoBadgeLevel(status: string, blocked: boolean): StatusLevel {
  if (blocked) return "warn";
  return status === "in_progress" ? "live" : "ok";
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
      const slug = t.slug || fallbackSlug(t.title) || `todo ${t.id}`;
      const body =
        `<div class="todo-body">${prose(t.title)}</div>` +
        (t.body ? `<div class="todo-body">${prose(t.body)}</div>` : "");
      return (
        `<li class="todo ${blocked ? "todo-blocked" : "todo-open"}">` +
        `<details class="todo-item" id="todo-${t.id}">` +
        `<summary class="pane-border pane-border-sub"><span class="pb-label">` +
        `${statusBadge(todoBadgeLevel(t.status, blocked), t.status)} ` +
        `<span class="priority priority-${escapeHtml(t.priority)}">${escapeHtml(t.priority)}</span> ` +
        `#${t.id} ${prose(slug)}` +
        `</span></summary>` +
        `<div class="section-body">${body}</div>` +
        `</details>` +
        (blocked ? `<div class="blockers">blocked by ${blockers}</div>` : "") +
        `</li>`
      );
    })
    .join("\n");
  const body = renderCappedList(shown.length, all.length, "open todos", "todos", rows, "No open todos.");
  return section("todos", "Todos", `${all.length} open, ${blockedCount} blocked`, body);
}

export const CHART_DAYS = 7;

interface DayStats {
  day: string;
  completed: number;
  backlog: number;
}

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
const CHART_COMPLETED_COLOR = "#2f9e63";
const CHART_BACKLOG_COLOR = "#3a7dc4";

function buildThroughputChart(stats: DayStats[]): string {
  const plotWidth = CHART_WIDTH - CHART_PAD_LEFT - CHART_PAD_RIGHT;
  const plotHeight = CHART_HEIGHT - CHART_PAD_TOP - CHART_PAD_BOTTOM;
  const drawHeight = plotHeight - 6;
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
      const label = escapeHtml(s.day.slice(5)) + (isToday ? "*" : "");
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

interface RunningAgentRow {
  id: number;
  name: string;
  kind: string;
  actor_id: string;
  agent_state: string;
  resumed_at: string;
  state_changed_at: string | null;
  created_at: string;
}

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
    `<li class="agent">${agentStateBadge(a)} ` +
    `${escapeHtml(a.name)} <span class="muted">(${escapeHtml(a.kind)})</span> ` +
    `<span class="muted">since ${timeEl(a.state_changed_at ?? a.created_at)}</span></li>`
  );
}

function renderAgentsSection(projectId: number): string {
  const all = db
    .prepare(
      `SELECT id, name, kind, actor_id, agent_state, resumed_at, state_changed_at, created_at
       FROM agents WHERE project_id = ? AND status = 'running' ORDER BY created_at`,
    )
    .all(projectId) as RunningAgentRow[];
  const shown = all.slice(0, AGENT_CAP);
  const rows = shown.map(renderAgentRow).join("\n");
  const body = renderCappedList(shown.length, all.length, "running agents", "agents", rows, "No agents running.");
  return section("agents", "In Flight", `${all.length} running`, body);
}

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

function fetchStateLogActivity(projectId: number): ActivitySource {

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

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function slugForId(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "-");
}

interface PadListRow {
  name: string;
  content: string;
  revision: number;
  updated_at: string;
}

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

function capNote(shown: number, total: number, pluralNoun: string): string {
  if (shown >= total) return "";
  return `<p class="cap-note">Showing ${shown} of ${total} ${pluralNoun} (capped).</p>`;
}

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

function section(id: string, title: string, countText: string, body: string, defaultOpen = false): string {
  return (
    `<details class="section" id="section-${id}"${defaultOpen ? " open" : ""}>` +
    `<summary class="pane-border"><span class="pb-label">${escapeHtml(title)}</span>` +
    `<span class="pb-count">${escapeHtml(countText)}</span></summary>` +
    `<div class="section-body">${body}</div></details>`
  );
}

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
  details.todo-item { margin: 0.2rem 0; }
  details.todo-item .section-body { padding: 0.3rem 0 0.6rem; }
  .todo-body { white-space: pre-wrap; }
  .todo-body + .todo-body { margin-top: 0.5rem; }

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
    // schedules at PARSE TIME - removing the tag afterward does not cancel it,
    // so a toggle could never turn it off. A setTimeout can be cleared, so this
    // is a timer instead, stored in a variable for exactly that.
    // location.reload() is a NAVIGATION, not a fetch(), so it still works from
    // file:// - the fetch() restriction that forced meta refresh in the first
    // place does not apply to it.
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

export function renderDashboard(projectId: number): string {
  return buildDashboard(projectId).html;
}

export function renderDashboardForWrite(projectId: number): { html: string; contentHash: string } {
  const { projectName, sections, html } = buildDashboard(projectId);
  const contentHash = createHash("sha256").update(projectName).update("\0").update(sections).digest("hex");
  return { html, contentHash };
}
