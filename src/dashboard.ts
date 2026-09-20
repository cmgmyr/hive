import { createHash } from "node:crypto";
import { db } from "./db.js";
import { getProject } from "./context.js";
import type { PaneVisibility } from "./tmux.js";

// The dashboard's own input contract, defined here so this file keeps no runtime dependency on the
// tmux-aware producer (src/processes.ts) that fills it.
export interface ProcessSnapshot {
  name: string;
  running: boolean;
  visibility: PaneVisibility | null;
  startedAt: string | null;
}

export const describeVisibility = (visibility: PaneVisibility | null): string =>
  visibility === null ? "running" : visibility === "window" ? "own window" : visibility;

export function processCounts(procs: ProcessSnapshot[]): {
  running: number;
  hidden: number;
  unlocated: number;
  notStarted: number;
} {
  return {
    running: procs.filter((p) => p.running).length,
    hidden: procs.filter((p) => p.visibility === "hidden").length,
    unlocated: procs.filter((p) => p.running && p.visibility === null).length,
    notStarted: procs.filter((p) => !p.running).length,
  };
}

import { awaitingFirstPrompt } from "./firstPrompt.js";

import { SLUG_MAX_LEN, cutToUnitBudget } from "./slug.js";

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

function mono(text: string): string {
  return `<span class="mono">${escapeHtml(text)}</span>`;
}

function icon(name: string): string {
  return `<svg class="icon" aria-hidden="true"><use href="#i-${name}"></use></svg>`;
}

type StatusLevel = "ok" | "warn" | "fail" | "live";

function statusBadge(level: StatusLevel, text: string): string {
  return `<span class="status status-${level}">${escapeHtml(text)}</span>`;
}

function emptyState(message: string, hint: string): string {
  return (
    `<div class="empty">${icon("inbox")}<p class="empty-title">${escapeHtml(message)}</p>` +
    `<p class="empty-hint">${escapeHtml(hint)}</p></div>`
  );
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

// The clock alone would read as today for a timestamp that is not, and state AGE
// is the whole point of the line this renders.
function shortWhenEl(utc: string | null): string {
  if (!utc) return '<span class="muted">-</span>';
  const d = new Date(`${utc.replace(" ", "T")}Z`);
  if (Number.isNaN(d.getTime())) return `<span class="time">${escapeHtml(utc)}</span>`;
  const local = formatDate(d);
  const isToday = local.slice(0, 10) === formatDate(new Date()).slice(0, 10);
  const text = isToday ? local.slice(11) : local.slice(5);
  return `<span class="time" title="${escapeHtml(utc)} UTC">${escapeHtml(text)}</span>`;
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

// kind='command' is excluded here and rendered in its own section: a hive.yml process has no state
// channel, so in the workers card it showed as a worker with "no log event recorded" forever.
function fetchNowAgents(projectId: number): RunningAgentRow[] {
  return db
    .prepare(
      `SELECT id, name, kind, actor_id, agent_state, resumed_at, state_changed_at, created_at
       FROM agents WHERE project_id = ? AND status = 'running' AND kind != 'command' ORDER BY created_at`,
    )
    .all(projectId) as RunningAgentRow[];
}

function fetchNextWake(projectId: number): NextWakeBrief | undefined {
  return db
    .prepare(
      `SELECT kind, due_at, max_wait_at, deliver_actor FROM wakes
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

function kindEl(a: RunningAgentRow): string {
  return a.kind === a.name ? "" : `<span class="kind">${escapeHtml(a.kind)}</span>`;
}

function renderWorkerRow(a: RunningAgentRow): string {
  if (!hasStateChannel(a.kind)) {
    const last = fetchLastLogEvent(a.actor_id);
    const meta = last
      ? `last event: ${escapeHtml(last.event)} · ${shortWhenEl(last.created_at)}`
      : "no log event recorded";
    return (
      `<li class="worker"><span class="worker-head">${mono(a.name)}${kindEl(a)}</span>` +
      `<span class="worker-meta">${meta}</span></li>`
    );
  }
  return (
    `<li class="worker"><span class="worker-head">${agentStateBadge(a)}${mono(a.name)}${kindEl(a)}</span>` +
    `<span class="worker-meta">since ${shortWhenEl(a.state_changed_at ?? a.created_at)}</span></li>`
  );
}

function renderNowAgentsLine(agents: RunningAgentRow[]): string {
  if (agents.length === 0) return `<p class="stat-empty">no workers running</p>`;
  const shown = agents.slice(0, AGENT_CAP);
  return (
    capNote(shown.length, agents.length, "running agents") +
    `<ul class="stat-workers">${shown.map(renderWorkerRow).join("")}</ul>`
  );
}

function renderNowWakeLine(next: NextWakeBrief | undefined): string {
  if (!next) return `<p class="stat-figure stat-none">—</p><p class="stat-empty">nothing scheduled</p>`;
  const when = next.kind === "delay" ? next.due_at : next.max_wait_at;
  const day = when ? formatLocal(when).slice(0, 10) : "-";
  return (
    `<p class="stat-figure">${shortWhenEl(when)}</p>` +
    `<p class="stat-sub">${escapeHtml(day)} local → ${mono(next.deliver_actor)}</p>`
  );
}

const PULSE_HOURS = 24;

interface PulseBucket {
  bucket: string;
  n: number;
}

export const PULSE_SQL = `
  WITH RECURSIVE h(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM h WHERE i < ${PULSE_HOURS - 1}),
  -- Hours are subtracted in UTC and only then converted for the label. Doing the
  -- arithmetic in local time instead spans 23 or 25 real hours across a DST
  -- change, which invents an hour that never happened and drops a real one.
  buckets AS (
    SELECT datetime('now', '-' || (${PULSE_HOURS - 1} - i) || ' hours') AS starts_at,
           strftime('%Y-%m-%d %H', datetime('now', '-' || (${PULSE_HOURS - 1} - i) || ' hours'), 'localtime') AS bucket
      FROM h
  ),
  -- The leading edge of the window, and LOAD-BEARING: the oldest bucket starts
  -- mid-hour, so an event earlier in that same local hour carries a label that
  -- is in the set and must still be excluded. Labels alone would over-count it.
  bound AS (SELECT MIN(starts_at) AS lo FROM buckets),
  events AS (
    SELECT strftime('%Y-%m-%d %H', c.created_at, 'localtime') AS bucket
      FROM todo_comments c JOIN todos t ON t.id = c.todo_id
     WHERE t.project_id = ? AND c.created_at >= (SELECT lo FROM bound)
    UNION ALL
    SELECT strftime('%Y-%m-%d %H', l.created_at, 'localtime') AS bucket
      FROM agent_state_log l
     WHERE l.created_at >= (SELECT lo FROM bound)
       AND EXISTS (SELECT 1 FROM agents a WHERE a.actor_id = l.actor_id AND a.project_id = ?)
  )
  -- Grouped by LABEL, not by hour: a fall-back day maps two UTC hours onto one
  -- local label, so the set is 23 bars that day rather than ${PULSE_HOURS}.
  SELECT b.bucket, (SELECT COUNT(*) FROM events e WHERE e.bucket = b.bucket) AS n
    FROM buckets b GROUP BY b.bucket ORDER BY MIN(b.starts_at)`;

export function fetchPulse(projectId: number): PulseBucket[] {
  return db.prepare(PULSE_SQL).all(projectId, projectId) as PulseBucket[];
}

const PULSE_WIDTH = 208;
const PULSE_HEIGHT = 44;

function buildPulse(buckets: PulseBucket[]): string {
  const gap = 2;
  const barWidth = (PULSE_WIDTH - gap * (buckets.length - 1)) / buckets.length;
  const maxValue = Math.max(1, ...buckets.map((b) => b.n));
  const baseline = PULSE_HEIGHT - 1;
  const bars = buckets
    .map((b, i) => {
      const x = i * (barWidth + gap);
      const hour = `${b.bucket.slice(11)}:00`;
      const title = `<title>${escapeHtml(hour)} · ${b.n} event${b.n === 1 ? "" : "s"}</title>`;
      if (b.n === 0) return `<rect class="pulse-none" x="${x.toFixed(1)}" y="${baseline - 1}" width="${barWidth.toFixed(1)}" height="1">${title}</rect>`;
      const height = Math.max(3, (b.n / maxValue) * (PULSE_HEIGHT - 4));
      return (
        `<rect class="pulse-bar" x="${x.toFixed(1)}" y="${(baseline - height).toFixed(1)}" ` +
        `width="${barWidth.toFixed(1)}" height="${height.toFixed(1)}" rx="2">${title}</rect>`
      );
    })
    .join("");
  return `<svg viewBox="0 0 ${PULSE_WIDTH} ${PULSE_HEIGHT}" class="pulse" preserveAspectRatio="none" role="img" aria-label="comments and worker state changes per hour over the last ${PULSE_HOURS} hours">${bars}</svg>`;
}

function statCard(id: string, label: string, iconName: string, body: string): string {
  return (
    `<article class="card stat" id="stat-${id}">` +
    `<h2 class="stat-label">${icon(iconName)}<span>${escapeHtml(label)}</span></h2>` +
    body +
    `</article>`
  );
}

function renderNowProcessesLine(procs: ProcessSnapshot[]): string {
  const { running, hidden, notStarted } = processCounts(procs);
  return (
    `<p class="stat-figure">${running}<span class="stat-unit">running</span></p>` +
    `<p class="stat-sub">${hidden} hidden · ${notStarted} not started</p>`
  );
}

function renderNowStrip(projectId: number, procs: ProcessSnapshot[]): string {
  const agents = fetchNowAgents(projectId);
  const nextWake = fetchNextWake(projectId);
  const todos = fetchTodoCounts(projectId);
  const pulse = fetchPulse(projectId);
  const pulseTotal = pulse.reduce((sum, b) => sum + b.n, 0);
  return `<section class="now" aria-label="current status">
${statCard(
  "workers",
  "workers",
  "users",
  `<p class="stat-figure">${agents.length}</p>${renderNowAgentsLine(agents)}`,
)}
${statCard("wake", "next wake", "clock", renderNowWakeLine(nextWake))}
${statCard(
  "todos",
  "todos",
  "checklist",
  `<p class="stat-figure">${todos.open}<span class="stat-unit">open</span></p>` +
    `<p class="stat-sub">${todos.blocked} blocked · ${todos.completed7d} completed in 7d</p>`,
)}
${procs.length > 0 ? statCard("processes", "processes", "inbox", renderNowProcessesLine(procs)) + "\n" : ""}${statCard(
  "pulse",
  "pulse",
  "activity",
  `<p class="stat-figure">${pulseTotal}<span class="stat-unit">events in 24h</span></p>` +
    (pulseTotal > 0
      ? buildPulse(pulse)
      : `<p class="stat-empty">nothing in the last 24 hours</p>`),
)}
</section>`;
}

function renderBoardSection(index: SectionMeta[], projectId: number): string {
  const pad = db
    .prepare("SELECT content, revision, updated_at FROM pads WHERE project_id = ? AND name = 'board' AND archived = 0")
    .get(projectId) as { content: string; revision: number; updated_at: string } | undefined;
  const count = pad ? `rev ${pad.revision} · updated ${formatLocal(pad.updated_at)} local` : "no board pad";
  const body = pad
    ? `<p class="meta">revision ${pad.revision}, updated ${timeEl(pad.updated_at)}</p>` +
      `<pre class="board">${escapeHtml(pad.content)}</pre>`
    : emptyState(
        "This project has no board pad.",
        "The board pad is where a lead keeps the current state of play. Write one with pad_write.",
      );
  return section(index, "board", "Board", count, "board", null, body);
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

function renderTodosSection(index: SectionMeta[], projectId: number): string {
  const all = db.prepare(OPEN_TODOS_SQL).all(projectId) as OpenTodoRow[];
  const shown = all.slice(0, TODO_CAP);
  const blockersByTodo = fetchBlockersFor(shown.filter((t) => t.open_blockers > 0).map((t) => t.id));
  const blockedCount = all.filter((t) => t.open_blockers > 0).length;
  const rows = shown
    .map((t) => {
      const blocked = t.open_blockers > 0;
      const blockers = blocked
        ? (blockersByTodo.get(t.id) ?? []).map((b) => `${mono(`#${b.id}`)} ${prose(b.title)}`).join(", ")
        : "";
      const label = t.slug || truncateWithEllipsis(t.title, SLUG_MAX_LEN);
      const body =
        `<div class="todo-body">${prose(t.title)}</div>` +
        (t.body ? `<div class="todo-body">${prose(t.body)}</div>` : "");
      return (
        `<li class="todo ${blocked ? "todo-blocked" : "todo-open"}">` +
        `<details class="todo-item" id="todo-${t.id}">` +
        `<summary class="row-summary"><span class="pb-label">` +
        `<span class="priority priority-${escapeHtml(t.priority)}">${escapeHtml(t.priority)}</span> ` +
        `${statusBadge(todoBadgeLevel(t.status, blocked), t.status)} ` +
        `${mono(`#${t.id}`)} ${prose(label)}` +
        (blocked ? ` <span class="chip chip-blocked">${icon("lock")}blocked</span>` : "") +
        `</span>${chevron()}</summary>` +
        `<div class="section-body">${body}</div>` +
        `</details>` +
        (blocked ? `<p class="blockers">blocked by ${blockers}</p>` : "") +
        `</li>`
      );
    })
    .join("\n");
  const filter =
    all.length > 0
      ? `<div class="filter"><label class="filter-field" for="todo-filter">${icon("search")}` +
        `<span class="sr-only">Filter todos</span>` +
        `<input type="search" id="todo-filter" placeholder="Filter todos by id, slug, title or body" autocomplete="off"></label>` +
        `<p class="filter-count" id="todo-filter-count" aria-live="polite"></p></div>` +
        `<p class="filter-none" id="todo-filter-none" hidden>No open todo matches that filter.</p>`
      : "";
  const body =
    filter +
    renderCappedList(
      shown.length,
      all.length,
      "open todos",
      "todos",
      rows,
      emptyState("No open todos.", "Every todo in this project is completed or archived. New ones land here."),
      "todo-list",
    );
  return section(index, "todos", "Todos", `${all.length} open, ${blockedCount} blocked`, "checklist", String(shown.length), body);
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

const CHART_WIDTH = 960;
const CHART_HEIGHT = 244;
const CHART_PAD_LEFT = 40;
const CHART_PAD_RIGHT = 18;
const PANEL_HEIGHT = 78;
const PANEL_A_TOP = 22;
const PANEL_B_TOP = 138;
const CHART_LABEL_Y = 236;

interface PanelSpec {
  top: number;
  title: string;
  series: "1" | "2";
  values: number[];
}

function buildPanel(spec: PanelSpec, stats: DayStats[]): string {
  const plotWidth = CHART_WIDTH - CHART_PAD_LEFT - CHART_PAD_RIGHT;
  const stepX = stats.length > 1 ? plotWidth / (stats.length - 1) : 0;
  const baseline = spec.top + PANEL_HEIGHT;
  const maxValue = Math.max(1, ...spec.values);
  const xAt = (i: number): number => CHART_PAD_LEFT + i * stepX;
  const yAt = (v: number): number => baseline - (v / maxValue) * (PANEL_HEIGHT - 8);
  const points = spec.values.map((v, i) => `${xAt(i).toFixed(1)},${yAt(v).toFixed(1)}`);
  const last = spec.values.length - 1;
  const dots = spec.values
    .map(
      (v, i) =>
        `<circle class="dot dot-${spec.series}" cx="${xAt(i).toFixed(1)}" cy="${yAt(v).toFixed(1)}" ` +
        `r="${i === last ? 4.5 : 3}" />`,
    )
    .join("");
  return (
    `<text class="panel-title" x="${CHART_PAD_LEFT}" y="${spec.top - 8}">${escapeHtml(spec.title)}</text>` +
    `<line class="grid" x1="${CHART_PAD_LEFT}" y1="${yAt(maxValue).toFixed(1)}" ` +
    `x2="${CHART_PAD_LEFT + plotWidth}" y2="${yAt(maxValue).toFixed(1)}" />` +
    `<line class="axis" x1="${CHART_PAD_LEFT}" y1="${baseline}" x2="${CHART_PAD_LEFT + plotWidth}" y2="${baseline}" />` +
    `<text class="tick" x="${CHART_PAD_LEFT - 8}" y="${baseline + 3}" text-anchor="end">0</text>` +
    `<text class="tick" x="${CHART_PAD_LEFT - 8}" y="${(yAt(maxValue) + 3).toFixed(1)}" text-anchor="end">${maxValue}</text>` +
    `<path class="area area-${spec.series}" d="M${CHART_PAD_LEFT},${baseline} L${points.join(" L")} ` +
    `L${xAt(last).toFixed(1)},${baseline} Z" />` +
    `<polyline class="line line-${spec.series}" points="${points.join(" ")}" />` +
    dots +
    `<text class="point-label" x="${(xAt(last) - 8).toFixed(1)}" y="${(yAt(spec.values[last]) - 9).toFixed(1)}" ` +
    `text-anchor="end">${spec.values[last]}</text>`
  );
}

function buildThroughputChart(stats: DayStats[]): string {
  const plotWidth = CHART_WIDTH - CHART_PAD_LEFT - CHART_PAD_RIGHT;
  const stepX = stats.length > 1 ? plotWidth / (stats.length - 1) : 0;
  const xAt = (i: number): number => CHART_PAD_LEFT + i * stepX;

  const dayLabels = stats
    .map((s, i) => {
      const isToday = i === stats.length - 1;
      const label = escapeHtml(s.day.slice(5)) + (isToday ? "*" : "");
      const anchor = i === 0 ? "start" : isToday ? "end" : "middle";
      return `<text class="tick" x="${xAt(i).toFixed(1)}" y="${CHART_LABEL_Y}" text-anchor="${anchor}">${label}</text>`;
    })
    .join("");

  const hits = stats
    .map((s, i) => {
      const x = Math.max(CHART_PAD_LEFT, xAt(i) - stepX / 2);
      const width = Math.min(stepX || plotWidth, CHART_PAD_LEFT + plotWidth - x);
      return (
        `<rect class="hit" x="${x.toFixed(1)}" y="${PANEL_A_TOP - 6}" width="${width.toFixed(1)}" ` +
        `height="${PANEL_B_TOP + PANEL_HEIGHT - PANEL_A_TOP + 12}">` +
        `<title>${escapeHtml(s.day)} · ${s.completed} completed · ${s.backlog} backlog</title></rect>`
      );
    })
    .join("");

  return `<svg viewBox="0 0 ${CHART_WIDTH} ${CHART_HEIGHT}" class="chart" role="img" aria-label="7-day todo throughput and backlog, bucketed by local day; the same numbers are in the table below">
${buildPanel({ top: PANEL_A_TOP, title: "completed that day", series: "1", values: stats.map((s) => s.completed) }, stats)}
${buildPanel({ top: PANEL_B_TOP, title: "open backlog at end of day", series: "2", values: stats.map((s) => s.backlog) }, stats)}
${dayLabels}
${hits}
</svg>`;
}

function buildThroughputTable(stats: DayStats[]): string {
  const head = stats
    .map((s, i) => `<th scope="col">${escapeHtml(s.day.slice(5))}${i === stats.length - 1 ? "*" : ""}</th>`)
    .join("");
  const completed = stats.map((s) => `<td>${s.completed}</td>`).join("");
  const backlog = stats.map((s) => `<td>${s.backlog}</td>`).join("");
  return (
    `<table class="chart-table"><caption class="sr-only">7-day completed and backlog counts by local day</caption>` +
    `<thead><tr><th scope="col">day</th>${head}</tr></thead>` +
    `<tbody><tr><th scope="row"><span class="swatch swatch-1"></span>completed</th>${completed}</tr>` +
    `<tr><th scope="row"><span class="swatch swatch-2"></span>backlog</th>${backlog}</tr></tbody></table>`
  );
}

function renderThroughputSection(index: SectionMeta[], stats: DayStats[]): string {
  const totalCompleted7d = stats.reduce((sum, s) => sum + s.completed, 0);
  const currentBacklog = stats[stats.length - 1].backlog;
  const body =
    `<p class="meta">Two measures on two scales, so each panel carries its own axis. ` +
    `Bucketed by LOCAL calendar day. Today (*) is still in progress, not a full day.</p>` +
    buildThroughputChart(stats) +
    buildThroughputTable(stats);
  return section(
    index,
    "throughput",
    "Throughput",
    `${totalCompleted7d} completed 7d · ${currentBacklog} backlog now`,
    "chart",
    null,
    body,
  );
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

function renderWakesSection(index: SectionMeta[], projectId: number): string {
  const all = db
    .prepare(
      `SELECT id, kind, body, owner, deliver_actor, due_at, max_wait_at, fire_count, repeat_every_ms, held_at
       FROM wakes WHERE project_id = ? AND ${PENDING_WAKE_WHERE}
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
        `<li class="wake"><span class="row-main">${status} ${mono(`#${w.id}`)} ` +
        `<span class="kind">${escapeHtml(w.kind)}</span> <span class="muted">${when}</span></span>` +
        `<span class="wake-body">${prose(truncated)}</span>` +
        `<span class="muted row-meta">owner ${mono(w.owner)} → ${mono(w.deliver_actor)}</span></li>`
      );
    })
    .join("\n");
  const body = renderCappedList(
    shown.length,
    all.length,
    "pending wakes",
    "wakes",
    rows,
    emptyState("No pending wakes.", "Scheduled and idle-triggered check-ins from wake_set show up here."),
  );
  return section(index, "wakes", "Wakes", `${all.length} pending`, "bell", String(shown.length), body);
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
        `<li class="activity"><span class="row-main"><span class="tag tag-comment">comment</span> ` +
        `${mono(r.author)} <span class="muted">on</span> ${mono(`#${r.todo_id}`)} ${prose(r.todo_title)}</span>` +
        `<span class="muted row-meta">${timeEl(r.created_at)}</span>` +
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
      `<li class="activity"><span class="row-main"><span class="tag tag-state">state</span> ` +
      `${mono(r.agent_name)} → ${mono(r.state)} <span class="muted">(${escapeHtml(r.event)})</span></span>` +
      `<span class="muted row-meta">${timeEl(r.created_at)}</span></li>`,
  }));
  return { entries, total };
}

function renderActivitySection(index: SectionMeta[], projectId: number): string {
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
    emptyState("No recent activity.", "Todo comments and worker state transitions stream into this list."),
  );
  return section(index, "activity", "Activity", `${total} recent`, "activity", String(shown.length), body);
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
  SELECT name, content, revision, updated_at FROM pads
  WHERE project_id = ? AND archived = 0 AND name != 'board'
  ORDER BY name`;

function renderPadsSection(index: SectionMeta[], projectId: number): string {
  const pads = db.prepare(PADS_LIST_SQL).all(projectId) as PadListRow[];
  const intro = `<p class="meta">Active pads other than "board" (shown in its own section above).</p>`;
  const list =
    pads.length > 0
      ? pads
          .map((p) => {
            const size = formatBytes(Buffer.byteLength(p.content, "utf8"));
            const count = `rev ${p.revision} · updated ${formatLocal(p.updated_at)} local · ${size}`;
            return (
              `<details class="pad-item" id="pad-${slugForId(p.name)}">` +
              `<summary class="row-summary"><span class="pb-label">${icon("file")}${prose(p.name)}</span>` +
              `<span class="pb-count">${escapeHtml(count)}</span>${chevron()}</summary>` +
              `<div class="section-body"><pre class="board">${escapeHtml(p.content)}</pre></div>` +
              `</details>`
            );
          })
          .join("\n")
      : emptyState("No other active pads.", "Plans, findings and lessons written with pad_write collect here.");
  return section(index, "pads", "Pads", `${pads.length} pad${pads.length === 1 ? "" : "s"}`, "file", String(pads.length), intro + list);
}

function processStateEl(p: ProcessSnapshot): string {
  return p.running
    ? statusBadge("live", describeVisibility(p.visibility))
    : statusBadge("warn", "not started");
}

function renderProcessesSection(index: SectionMeta[], procs: ProcessSnapshot[]): string {
  const { running, notStarted } = processCounts(procs);
  const rows = procs
    .map((p) => {
      const when = p.startedAt ? `started ${timeEl(p.startedAt)}` : `<span class="muted">start with hive start</span>`;
      return (
        `<li class="wake"><span class="row-main">${processStateEl(p)} ${mono(p.name)} ` +
        `<span class="muted">${when}</span></span></li>`
      );
    })
    .join("\n");
  return section(
    index,
    "processes",
    "Processes",
    `${running} running, ${notStarted} not started`,
    "inbox",
    String(running),
    `<ul class="rows wakes">${rows}</ul>`,
  );
}

function capNote(shown: number, total: number, pluralNoun: string): string {
  if (shown >= total) return "";
  return `<p class="cap-note">${icon("info")}Showing ${shown} of ${total} ${pluralNoun} (capped).</p>`;
}

function renderCappedList(
  shownCount: number,
  total: number,
  pluralNoun: string,
  listClass: string,
  rowsHtml: string,
  emptyHtml: string,
  listId?: string,
): string {
  return (
    capNote(shownCount, total, pluralNoun) +
    (shownCount > 0
      ? `<ul class="rows ${listClass}"${listId ? ` id="${listId}"` : ""}>${rowsHtml}</ul>`
      : emptyHtml)
  );
}

function chevron(): string {
  return `<span class="chev">${icon("chevron")}</span>`;
}

interface SectionMeta {
  id: string;
  title: string;
  iconName: string;
  navCount: string | null;
}

const DEFAULT_OPEN_SECTIONS = new Set(["throughput", "board", "todos"]);

function section(
  index: SectionMeta[],
  id: string,
  title: string,
  countText: string,
  iconName: string,
  navCount: string | null,
  body: string,
): string {
  index.push({ id, title, iconName, navCount });
  const open = DEFAULT_OPEN_SECTIONS.has(id) ? " open" : "";
  return (
    `<details class="section" id="section-${id}"${open}>` +
    `<summary><span class="sec-icon">${icon(iconName)}</span>` +
    `<span class="pb-label">${escapeHtml(title)}</span>` +
    `<span class="pb-count">${escapeHtml(countText)}</span>${chevron()}</summary>` +
    `<div class="section-body">${body}</div></details>`
  );
}

function renderSectionNav(metas: SectionMeta[]): string {
  const links = metas
    .map(
      (m) =>
        `<li><a class="navchip" href="#section-${m.id}" data-section="${m.id}">${icon(m.iconName)}` +
        `<span class="navchip-label">${escapeHtml(m.title)}</span>` +
        (m.navCount === null
          ? ""
          : `<span class="navchip-count" id="navcount-${m.id}">${escapeHtml(m.navCount)}</span>`) +
        `</a></li>`,
    )
    .join("");
  return `<nav class="secnav" aria-label="dashboard sections"><ul>${links}</ul></nav>`;
}

const SPRITE = `<svg class="sprite" aria-hidden="true" focusable="false"><defs>
<symbol id="i-chevron" viewBox="0 0 16 16"><path d="M4 6.5 8 10.5l4-4"/></symbol>
<symbol id="i-users" viewBox="0 0 16 16"><circle cx="6" cy="5.2" r="2.4"/><path d="M1.9 13.4a4.1 4.1 0 0 1 8.2 0"/><path d="M11 3.2a2.4 2.4 0 0 1 0 4.4"/><path d="M12.1 9.6a4.1 4.1 0 0 1 2 3.8"/></symbol>
<symbol id="i-clock" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.2"/><path d="M8 4.4V8l2.6 1.7"/></symbol>
<symbol id="i-checklist" viewBox="0 0 16 16"><path d="M2.2 4.6 3.6 6l2.4-2.6"/><path d="M2.2 11.4 3.6 12.8l2.4-2.6"/><path d="M8.4 4.8h5.4M8.4 11.6h5.4"/></symbol>
<symbol id="i-chart" viewBox="0 0 16 16"><path d="M2.4 2.2v11.6h11.4"/><path d="M4.8 11V7.6M7.6 11V4.6M10.4 11V8.8M13.2 11V6"/></symbol>
<symbol id="i-bell" viewBox="0 0 16 16"><path d="M4 6.8a4 4 0 0 1 8 0c0 3 .9 4.2 1.5 4.8H2.5C3.1 11 4 9.8 4 6.8Z"/><path d="M6.6 13.6a1.6 1.6 0 0 0 2.8 0"/></symbol>
<symbol id="i-activity" viewBox="0 0 16 16"><path d="M1.6 8h3l1.7-4.6L9.6 12l1.5-4h3.3"/></symbol>
<symbol id="i-board" viewBox="0 0 16 16"><rect x="2.1" y="2.6" width="11.8" height="10.8" rx="1.6"/><path d="M2.1 6.1h11.8M6.4 6.1v7.3"/></symbol>
<symbol id="i-file" viewBox="0 0 16 16"><path d="M9 1.9H4.6a1.6 1.6 0 0 0-1.6 1.6v9a1.6 1.6 0 0 0 1.6 1.6h6.8a1.6 1.6 0 0 0 1.6-1.6V5.6Z"/><path d="M9 1.9v3.7h4"/></symbol>
<symbol id="i-search" viewBox="0 0 16 16"><circle cx="7.1" cy="7.1" r="4.6"/><path d="m10.5 10.5 3.2 3.2"/></symbol>
<symbol id="i-lock" viewBox="0 0 16 16"><rect x="3.2" y="7" width="9.6" height="6.6" rx="1.4"/><path d="M5.5 7V5.2a2.5 2.5 0 0 1 5 0V7"/></symbol>
<symbol id="i-inbox" viewBox="0 0 16 16"><path d="M1.9 9.2h3.3l1 2h3.6l1-2h3.3"/><path d="M3.6 2.9h8.8l1.7 6.3v3.3a1.6 1.6 0 0 1-1.6 1.6H3.5a1.6 1.6 0 0 1-1.6-1.6V9.2Z"/></symbol>
<symbol id="i-info" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.2"/><path d="M8 7.4v3.6M8 5.2v.1"/></symbol>
</defs></svg>`;

const STYLE = `
  :root {
    color-scheme: light dark;
    --font-mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    --font-sans: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    --bg: #f5f7fa;
    --panel: #ffffff;
    --panel-sunken: #f1f4f8;
    --fg: #171a1f;
    --fg-muted: #5c6672;
    --fg-subtle: #6e7885;
    --border: #e4e8ee;
    --border-strong: #d2d8e0;
    --ok: #0f7a4d;
    --warn: #8a5300;
    --fail: #b4271c;
    --live: #1f5fd0;
    --ok-bg: #e6f4ec;
    --warn-bg: #fbf0dd;
    --fail-bg: #fceceb;
    --live-bg: #e8f0fd;
    --accent: #1f5fd0;
    --focus: #1f5fd0;
    --series-1: #2a78d6;
    --series-2: #eb6834;
    --grid: #e4e8ee;
    --hover: #f1f4f8;
    --hit: #171a1f;
    --shadow: 0 1px 2px rgba(19, 26, 38, 0.06), 0 2px 8px rgba(19, 26, 38, 0.05);
    --card-border: transparent;
    --r-card: 14px;
    --r-ctl: 9px;
    --r-pill: 999px;
    --ease-out: cubic-bezier(0.23, 1, 0.32, 1);
    --header-offset: 7.5rem;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #101317;
      --panel: #171b21;
      --panel-sunken: #1c2129;
      --fg: #e8ebef;
      --fg-muted: #9aa5b1;
      --fg-subtle: #8b95a1;
      --border: #262c35;
      --border-strong: #333b46;
      --ok: #4cc98d;
      --warn: #e0a548;
      --fail: #f0736a;
      --live: #6aa6ee;
      --ok-bg: #14291f;
      --warn-bg: #2c2213;
      --fail-bg: #2e1a19;
      --live-bg: #16233a;
      --accent: #6aa6ee;
      --focus: #6aa6ee;
      --series-1: #3987e5;
      --series-2: #d95926;
      --grid: #262c35;
      --hover: #1c2129;
      --hit: #e8ebef;
      --shadow: none;
      --card-border: #262c35;
    }
  }

  *, *::before, *::after { box-sizing: border-box; }
  [hidden] { display: none !important; }
  html { -webkit-text-size-adjust: 100%; }
  body {
    font-family: var(--font-sans);
    font-size: 0.9375rem;
    line-height: 1.5;
    margin: 0;
    padding: 0 0 4rem;
    background: var(--bg);
    color: var(--fg);
    accent-color: var(--accent);
  }
  ::selection { background: var(--live-bg); color: var(--fg); }
  svg.sprite { position: absolute; width: 0; height: 0; overflow: hidden; }
  .icon { width: 1em; height: 1em; flex: 0 0 auto; fill: none; stroke: currentColor;
    stroke-width: 1.4; stroke-linecap: round; stroke-linejoin: round; }
  .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
    overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
  .mono { font-family: var(--font-mono); font-size: 0.9em; font-variant-numeric: tabular-nums; }
  .prose { overflow-wrap: anywhere; }

  .skip { position: absolute; left: -999px; top: 0; z-index: 10;
    background: var(--panel); color: var(--fg); padding: 0.6rem 0.9rem; border-radius: var(--r-ctl); }
  .skip:focus { left: 0.75rem; top: 0.75rem; outline: 2px solid var(--focus); outline-offset: 2px; }

  .wrap { max-width: 76rem; margin: 0 auto; padding: 0 1.25rem; }

  .topbar { position: sticky; top: 0; z-index: 5; background: var(--bg);
    border-bottom: 1px solid var(--border); }
  .topbar-inner { display: flex; align-items: center; justify-content: space-between;
    gap: 1rem; flex-wrap: wrap; padding: 0.85rem 0 0.7rem; }
  .brand { display: flex; align-items: center; gap: 0.7rem; min-width: 0; }
  .mark { width: 1.75rem; height: 1.75rem; flex: 0 0 auto; color: var(--accent); }
  h1 { font-size: 1.0625rem; font-weight: 650; letter-spacing: -0.011em; margin: 0; }
  .generated { color: var(--fg-muted); font-size: 0.78125rem; margin: 0.1rem 0 0; }

  .secnav { overflow-x: auto; scrollbar-width: none; }
  .secnav::-webkit-scrollbar { display: none; }
  .secnav ul { display: flex; gap: 0.3rem; list-style: none; margin: 0; padding: 0 0 0.6rem; }
  .secnav li { border: 0; padding: 0; }
  .navchip { display: inline-flex; align-items: center; gap: 0.35rem; white-space: nowrap;
    text-decoration: none; color: var(--fg-muted); font-size: 0.8125rem; font-weight: 500;
    padding: 0.32rem 0.62rem; border-radius: var(--r-pill); background: transparent;
    transition: background-color 130ms ease, color 130ms ease; }
  .navchip .icon { font-size: 0.9375rem; opacity: 0.8; }
  .navchip-count { font-family: var(--font-mono); font-size: 0.75rem; font-variant-numeric: tabular-nums;
    color: var(--fg-subtle); background: var(--panel-sunken); border-radius: var(--r-pill);
    padding: 0 0.36rem; min-width: 1.35rem; text-align: center; }
  .navchip[aria-current="true"] { background: var(--live-bg); color: var(--accent); }
  .navchip[aria-current="true"] .navchip-count { background: var(--panel); color: var(--accent); }
  .navchip:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }

  .live-toggle { display: inline-flex; align-items: center; gap: 0.45rem; cursor: pointer;
    font-size: 0.8125rem; font-weight: 500; color: var(--fg-muted); flex: 0 0 auto; user-select: none; }
  .live-toggle input[type="checkbox"] { appearance: none; -webkit-appearance: none; width: 2.15rem;
    height: 1.2rem; background: var(--border-strong); border-radius: var(--r-pill); position: relative;
    margin: 0; cursor: pointer; transition: background-color 160ms var(--ease-out); }
  .live-toggle input[type="checkbox"]::before { content: ""; position: absolute; top: 2px; left: 2px;
    width: 1rem; height: 1rem; border-radius: 50%; background: #ffffff;
    box-shadow: 0 1px 2px rgba(19, 26, 38, 0.28);
    transition: transform 160ms var(--ease-out); }
  .live-toggle input[type="checkbox"]:checked { background: var(--accent); }
  .live-toggle input[type="checkbox"]:checked::before { transform: translateX(0.95rem); }
  .live-toggle input[type="checkbox"]:active::before { width: 1.15rem; }
  .live-toggle input[type="checkbox"]:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
  .live-note { display: flex; align-items: baseline; gap: 0.4rem; color: var(--fg-subtle);
    font-size: 0.78125rem; margin: 0.9rem 0 0; }

  .card { background: var(--panel); border: 1px solid var(--card-border); border-radius: var(--r-card);
    box-shadow: var(--shadow); }

  .now { display: grid; gap: 0.75rem; margin: 0.9rem 0 1rem; align-items: stretch;
    grid-template-columns: repeat(auto-fit, minmax(13rem, 1fr)); }
  .stat { padding: 0.9rem 1rem 1rem; display: flex; flex-direction: column; min-width: 0; }
  .stat-label { display: flex; align-items: center; gap: 0.4rem; margin: 0 0 0.5rem;
    font-size: 0.71875rem; font-weight: 600; letter-spacing: 0.07em; text-transform: uppercase;
    color: var(--fg-subtle); }
  .stat-figure { font-size: 1.75rem; line-height: 1.1; font-weight: 620; letter-spacing: -0.022em;
    margin: 0; font-variant-numeric: tabular-nums; display: flex; align-items: baseline; gap: 0.4rem; }
  .stat-figure .time { font-size: 1.75rem; }
  .stat-unit { font-size: 0.78125rem; font-weight: 500; letter-spacing: 0; color: var(--fg-subtle);
    text-transform: none; }
  .stat-sub { color: var(--fg-muted); font-size: 0.8125rem; margin: 0.35rem 0 0; overflow-wrap: anywhere; }
  .stat-empty { color: var(--fg-subtle); font-size: 0.8125rem; margin: 0.35rem 0 0; }
  .stat-none { color: var(--fg-subtle); }
  .stat-workers { list-style: none; margin: 0.5rem 0 0; padding: 0; display: flex;
    flex-direction: column; gap: 0.5rem; max-height: 13rem; overflow: auto;
    overscroll-behavior: contain; }
  .worker { display: flex; flex-direction: column; gap: 0.1rem; padding: 0; border: 0;
    font-size: 0.8125rem; min-width: 0; }
  .worker + .worker { border-top: 1px solid var(--border); padding-top: 0.5rem; }
  .worker-head { display: flex; align-items: center; gap: 0.35rem; flex-wrap: wrap; min-width: 0; }
  .worker-head .mono { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .worker-meta { color: var(--fg-subtle); font-size: 0.75rem; }
  svg.pulse { width: 100%; height: 2.75rem; margin-top: auto; padding-top: 0.6rem; display: block; }
  .pulse-bar { fill: var(--series-1); }
  .pulse-none { fill: var(--border-strong); }

  .section { margin: 0 0 0.6rem; background: var(--panel); border: 1px solid var(--card-border);
    border-radius: var(--r-card); box-shadow: var(--shadow);
    scroll-margin-top: calc(var(--header-offset) + 0.75rem); }
  summary { cursor: pointer; list-style: none; }
  summary::-webkit-details-marker { display: none; }
  .section > summary { display: flex; align-items: center; gap: 0.55rem; padding: 0.85rem 1rem;
    border-radius: var(--r-card); font-size: 0.9375rem;
    transition: background-color 130ms ease; }
  .sec-icon { display: inline-flex; color: var(--accent); font-size: 1.0625rem; }
  .section > summary .pb-label { font-weight: 600; letter-spacing: -0.006em; }
  .pb-count { color: var(--fg-subtle); font-size: 0.78125rem; font-variant-numeric: tabular-nums;
    margin-left: auto; text-align: right; }
  .chev { display: inline-flex; color: var(--fg-subtle); font-size: 1rem; margin-left: 0.15rem;
    transition: transform 180ms var(--ease-out); }
  details[open] > summary .chev { transform: rotate(180deg); }
  summary:focus-visible { outline: 2px solid var(--focus); outline-offset: -2px; border-radius: var(--r-ctl); }
  .section-body { padding: 0 1rem 1rem; }
  .section > .section-body { border-top: 1px solid var(--border); padding-top: 0.9rem; margin-top: -0.15rem; }

  .row-summary { display: flex; align-items: center; gap: 0.5rem; padding: 0.5rem 0.6rem;
    border-radius: var(--r-ctl); font-size: 0.875rem;
    transition: background-color 130ms ease; }
  .row-summary .pb-label { display: flex; align-items: center; gap: 0.42rem; flex-wrap: wrap;
    min-width: 0; }
  .row-summary .icon { color: var(--fg-subtle); }
  details.pad-item, details.todo-item { margin: 0; }
  details.pad-item > .section-body, details.todo-item > .section-body { padding: 0.1rem 0.6rem 0.7rem 0.6rem; }
  .todo-body { overflow-wrap: anywhere; white-space: pre-wrap; color: var(--fg-muted);
    font-size: 0.875rem; }
  .todo-body + .todo-body { margin-top: 0.55rem; }

  .meta, .muted { color: var(--fg-muted); }
  .meta { font-size: 0.8125rem; margin: 0 0 0.75rem; max-width: 72ch; }
  .muted { font-size: 0.8125rem; }
  .cap-note { display: flex; align-items: center; gap: 0.4rem; color: var(--fg-subtle);
    font-size: 0.78125rem; margin: 0 0 0.6rem; }
  pre.board { white-space: pre; overflow: auto; max-height: 60vh; background: var(--panel-sunken);
    border: 1px solid var(--border); border-radius: var(--r-ctl); padding: 0.85rem;
    font-family: var(--font-mono); font-size: 0.8125rem; line-height: 1.5; margin: 0;
    overscroll-behavior: contain; }

  ul.rows { list-style: none; margin: 0; padding: 0; }
  ul.rows > li { padding: 0.35rem 0; border-bottom: 1px solid var(--border);
    display: flex; flex-direction: column; gap: 0.15rem; }
  ul.rows > li:last-child { border-bottom: none; }
  ul.rows > li.todo, ul.rows > li:has(> details) { padding: 0.1rem 0; }
  .row-main { display: flex; align-items: center; gap: 0.42rem; flex-wrap: wrap; }
  .row-meta { font-size: 0.78125rem; color: var(--fg-subtle); }
  .kind { color: var(--fg-subtle); font-size: 0.78125rem; }

  .status { display: inline-flex; align-items: center; gap: 0.3rem; font-size: 0.71875rem;
    font-weight: 600; letter-spacing: 0.01em; padding: 0.12rem 0.5rem; border-radius: var(--r-pill);
    white-space: nowrap; }
  .status::before { content: ""; width: 0.4rem; height: 0.4rem; border-radius: 50%;
    background: currentColor; flex: 0 0 auto; }
  .status-ok { color: var(--ok); background: var(--ok-bg); }
  .status-warn { color: var(--warn); background: var(--warn-bg); }
  .status-fail { color: var(--fail); background: var(--fail-bg); }
  .status-live { color: var(--live); background: var(--live-bg); }

  .chip { display: inline-flex; align-items: center; gap: 0.28rem; font-size: 0.71875rem;
    font-weight: 600; padding: 0.12rem 0.48rem; border-radius: var(--r-pill); white-space: nowrap; }
  .chip-blocked { color: var(--warn); background: var(--warn-bg); }
  .chip-blocked .icon { stroke-width: 1.6; }

  .tag { font-size: 0.6875rem; font-weight: 600; letter-spacing: 0.05em; text-transform: uppercase;
    padding: 0.1rem 0.4rem; border-radius: 5px; background: var(--panel-sunken); color: var(--fg-subtle); }

  .priority { font-size: 0.6875rem; font-weight: 650; letter-spacing: 0.04em; text-transform: uppercase; }
  .priority-high { color: var(--fail); }
  .priority-medium { color: var(--fg-muted); }
  .priority-low { color: var(--fg-subtle); }
  .blockers { font-size: 0.8125rem; color: var(--fg-muted); margin: 0 0 0.45rem 0.6rem; }
  .wake-body { color: var(--fg); font-size: 0.875rem; overflow-wrap: anywhere; }
  .activity-body { font-size: 0.8125rem; color: var(--fg-muted); white-space: pre-wrap;
    overflow-wrap: anywhere; margin-top: 0.1rem; }

  .filter { display: flex; align-items: center; gap: 0.75rem; flex-wrap: wrap; margin-bottom: 0.75rem; }
  .filter-field { display: flex; align-items: center; gap: 0.45rem; flex: 1 1 18rem;
    background: var(--panel-sunken); border: 1px solid var(--border); border-radius: var(--r-ctl);
    padding: 0.4rem 0.65rem; color: var(--fg-subtle);
    transition: border-color 130ms ease, background-color 130ms ease; }
  .filter-field:focus-within { border-color: var(--accent); background: var(--panel); }
  .filter-field input { flex: 1 1 auto; min-width: 0; border: 0; background: transparent;
    font: inherit; font-size: 0.875rem; color: var(--fg); outline: none; padding: 0; }
  .filter-field input::placeholder { color: var(--fg-subtle); }
  .filter-field input::-webkit-search-cancel-button { -webkit-appearance: none; appearance: none; }
  .filter-count { color: var(--fg-subtle); font-size: 0.78125rem; font-variant-numeric: tabular-nums;
    margin: 0; flex: 0 0 auto; }
  .filter-none { color: var(--fg-muted); font-size: 0.875rem; margin: 0.5rem 0; }

  .empty { text-align: center; padding: 1.75rem 1rem 1.85rem; color: var(--fg-muted); }
  .empty .icon { font-size: 1.5rem; color: var(--fg-subtle); stroke-width: 1.2; }
  .empty-title { margin: 0.55rem 0 0.2rem; font-weight: 600; color: var(--fg); font-size: 0.9375rem; }
  .empty-hint { margin: 0; font-size: 0.8125rem; color: var(--fg-subtle); max-width: 42ch;
    margin-inline: auto; }

  svg.chart { width: 100%; height: auto; display: block; margin: 0 0 0.9rem;
    color: var(--fg-muted); }
  .chart .panel-title { font-size: 13px; font-weight: 600; fill: var(--fg-muted);
    font-family: var(--font-sans); letter-spacing: 0.01em; }
  .chart .tick { font-size: 12px; fill: var(--fg-subtle); font-family: var(--font-sans);
    font-variant-numeric: tabular-nums; }
  .chart .point-label { font-size: 13px; font-weight: 600; fill: var(--fg-muted);
    font-family: var(--font-sans); font-variant-numeric: tabular-nums; }
  .chart .grid { stroke: var(--grid); stroke-dasharray: 3 4; }
  .chart .axis { stroke: var(--border-strong); }
  .line { fill: none; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
  .line-1 { stroke: var(--series-1); }
  .line-2 { stroke: var(--series-2); }
  .area { stroke: none; }
  .area-1 { fill: var(--series-1); fill-opacity: 0.13; }
  .area-2 { fill: var(--series-2); fill-opacity: 0.13; }
  .dot { stroke: var(--panel); stroke-width: 2; }
  .dot-1 { fill: var(--series-1); }
  .dot-2 { fill: var(--series-2); }
  .hit { fill: var(--hit); fill-opacity: 0; }
  .hit:hover { fill-opacity: 0.045; }

  .chart-table { width: 100%; border-collapse: collapse; font-size: 0.8125rem;
    font-variant-numeric: tabular-nums; }
  .chart-table th, .chart-table td { padding: 0.35rem 0.4rem; text-align: right;
    border-bottom: 1px solid var(--border); }
  .chart-table thead th { color: var(--fg-subtle); font-weight: 600; font-size: 0.75rem; }
  .chart-table thead th:first-child { text-align: left; }
  .chart-table tbody th { text-align: left; font-weight: 500; color: var(--fg-muted); }
  .chart-table tr:last-child th, .chart-table tr:last-child td { border-bottom: 0; }
  .swatch { display: inline-block; width: 0.6rem; height: 0.6rem; border-radius: 3px;
    margin-right: 0.4rem; vertical-align: baseline; }
  .swatch-1 { background: var(--series-1); }
  .swatch-2 { background: var(--series-2); }

  @media (hover: hover) and (pointer: fine) {
    .section > summary:hover { background: var(--hover); }
    .row-summary:hover { background: var(--hover); }
    .navchip:hover { background: var(--hover); color: var(--fg); }
  }
  .section > summary:active, .row-summary:active { transform: scale(0.995); }
  .navchip:active { transform: scale(0.97); }

  @media (max-width: 40rem) {
    .wrap { padding: 0 0.9rem; }
    .now { grid-template-columns: 1fr; }
    .pb-count { font-size: 0.75rem; }
    .navchip-label { position: absolute; width: 1px; height: 1px; padding: 0;
      margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
  }

  @media (prefers-reduced-motion: reduce) {
    * { transition: none !important; animation: none !important; }
    .section > summary:active, .row-summary:active, .navchip:active { transform: none; }
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
    // A toggle the SCRIPT caused is not the reader's choice. The flag is
    // one-shot and set only when the forced value differs, so it cannot leak.
    var suppressPersist = {};
    document.querySelectorAll("details[id]").forEach(function (el) {
      var stored = state.sections && state.sections[el.id];
      if (stored !== undefined) el.open = stored;
      el.addEventListener("toggle", function () {
        if (suppressPersist[el.id]) { delete suppressPersist[el.id]; return; }
        var s = load();
        s.sections = s.sections || {};
        s.sections[el.id] = el.open;
        save(s);
      });
    });

    // Client-side todo filter. sessionStorage, never localStorage: Chrome treats
    // file:// as an opaque origin and localStorage is unreliable there.
    var filterInput = document.getElementById("todo-filter");
    var filterCount = document.getElementById("todo-filter-count");
    var filterNone = document.getElementById("todo-filter-none");
    var todoList = document.getElementById("todo-list");
    var todoNavCount = document.getElementById("navcount-todos");
    var todoRows = todoList ? todoList.querySelectorAll("li.todo") : [];
    var todoText = [];
    for (var t = 0; t < todoRows.length; t++) {
      todoText.push((todoRows[t].textContent || "").toLowerCase().replace(/\\s+/g, " "));
    }

    function applyFilter(query) {
      var needle = String(query || "").trim().toLowerCase();
      var shown = 0;
      for (var i = 0; i < todoRows.length; i++) {
        var hit = needle === "" || todoText[i].indexOf(needle) !== -1;
        todoRows[i].hidden = !hit;
        if (hit) shown++;
      }
      if (filterCount) {
        filterCount.textContent = needle === ""
          ? todoRows.length + " shown"
          : shown + " of " + todoRows.length + " shown";
      }
      if (filterNone) filterNone.hidden = !(needle !== "" && shown === 0);
      if (todoNavCount) todoNavCount.textContent = String(shown);
    }

    if (filterInput) {
      var storedFilter = typeof state.filter === "string" ? state.filter : "";
      filterInput.value = storedFilter;
      applyFilter(storedFilter);
      if (storedFilter !== "") {
        var todosSection = document.getElementById("section-todos");
        if (todosSection && !todosSection.open) {
          suppressPersist["section-todos"] = true;
          todosSection.open = true;
        }
      }
      // Restore the caret only if the box actually had focus when the page went
      // away, so a reload never steals focus from wherever the reader is.
      if (state.filterFocused && filterInput.focus) {
        try {
          filterInput.focus({ preventScroll: true });
          if (filterInput.setSelectionRange) {
            var caret = typeof state.filterCaret === "number" ? state.filterCaret : storedFilter.length;
            filterInput.setSelectionRange(caret, caret);
          }
        } catch (e) {}
      }
      filterInput.addEventListener("input", function () {
        var s = load();
        s.filter = filterInput.value;
        s.filterCaret = filterInput.selectionStart;
        save(s);
        applyFilter(filterInput.value);
        deferReload();
      });
    }

    // The sticky header wraps at narrow widths, so its height is measured, not
    // guessed. One number, read by scroll-margin-top and by paintNav alike.
    var headerOffset = 120;
    function measureHeader() {
      var bar = document.getElementById("topbar");
      if (!bar || !bar.getBoundingClientRect) return;
      headerOffset = Math.round(bar.getBoundingClientRect().height);
      var root = document.documentElement;
      if (root && root.style) root.style.setProperty("--header-offset", headerOffset + "px");
    }
    measureHeader();

    // Section nav: mark the section the reader is currently in.
    var navLinks = document.querySelectorAll(".navchip");
    function paintNav() {
      var best = null;
      for (var i = 0; i < navLinks.length; i++) {
        var target = document.getElementById("section-" + navLinks[i].getAttribute("data-section"));
        if (target && target.getBoundingClientRect().top <= headerOffset + 20) best = navLinks[i];
      }
      for (var j = 0; j < navLinks.length; j++) {
        if (navLinks[j] === best) navLinks[j].setAttribute("aria-current", "true");
        else navLinks[j].removeAttribute("aria-current");
      }
    }
    if (navLinks.length > 0) {
      paintNav();
      var ticking = false;
      window.addEventListener("scroll", function () {
        if (ticking) return;
        ticking = true;
        requestAnimationFrame(function () { paintNav(); ticking = false; });
      }, { passive: true });
      window.addEventListener("resize", function () { measureHeader(); paintNav(); });
    }

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
    // Typing restarts the 10s rather than suspending it, so "refreshes every
    // 10s" stays true - it is measured from the last keystroke, not from load.
    function deferReload() {
      if (!live) return;
      clearReload();
      armReload();
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
      if (filterInput) {
        s.filterFocused = document.activeElement === filterInput;
        s.filterCaret = filterInput.selectionStart;
      }
      save(s);
    });
  })();
`;

const BRAND_MARK = `<svg class="mark" viewBox="0 0 32 32" role="img" aria-label="hive">
<path d="M16 3.2 27 9.6v12.8L16 28.8 5 22.4V9.6Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" />
<path d="M16 11 21 14v6l-5 3-5-3v-6Z" fill="currentColor" fill-opacity="0.22" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" />
</svg>`;

function buildDashboard(projectId: number, procs: ProcessSnapshot[]): {
  projectName: string;
  sections: string;
  html: string;
} {
  const project = fetchProject(projectId);
  const stats = fetchDayStats(projectId);
  const index: SectionMeta[] = [];
  const cards = [
    renderThroughputSection(index, stats),
    renderBoardSection(index, projectId),
    renderTodosSection(index, projectId),
    ...(procs.length > 0 ? [renderProcessesSection(index, procs)] : []),
    renderPadsSection(index, projectId),
    renderWakesSection(index, projectId),
    renderActivitySection(index, projectId),
  ];
  const nav = renderSectionNav(index);
  const sections = [renderNowStrip(projectId, procs), ...cards].join("\n");
  const generatedLocal = formatDate(new Date());

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>hive dashboard - ${escapeHtml(project.name)}</title>
<style>${STYLE}</style>
</head>
<body>
${SPRITE}
<a class="skip" href="#main">Skip to content</a>
<header class="topbar" id="topbar">
<div class="wrap">
<div class="topbar-inner">
<div class="brand">${BRAND_MARK}<div><h1>${escapeHtml(project.name)}</h1>
<p class="generated" id="generated-stamp" data-time="${escapeHtml(generatedLocal)}">generated ${escapeHtml(generatedLocal)} local, refreshes every 10s. Read-only: nothing here writes back to the store.</p></div></div>
<label class="live-toggle"><input type="checkbox" id="live-toggle" role="switch" checked><span>Live</span></label>
</div>
${nav}
</div>
</header>
<main id="main" class="wrap">
<p class="live-note">${icon("info")}Turning Live off stops this page from reloading; the scheduler keeps the file itself up to date either way - a browser page cannot signal it back without a server.</p>
${sections}
</main>
<script>${SCRIPT}</script>
</body>
</html>
`;
  return { projectName: project.name, sections, html };
}

export function renderDashboard(projectId: number, procs: ProcessSnapshot[] = []): string {
  return buildDashboard(projectId, procs).html;
}

export function renderDashboardForWrite(
  projectId: number,
  procs: ProcessSnapshot[] = [],
): { html: string; contentHash: string } {
  const { projectName, sections, html } = buildDashboard(projectId, procs);
  const contentHash = createHash("sha256").update(projectName).update("\0").update(sections).digest("hex");
  return { html, contentHash };
}
