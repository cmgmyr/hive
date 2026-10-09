import { existsSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { db } from "./db.js";
import { SECTION_STYLE, SPRITE, renderBoardPadsTodos, sectionScript } from "./dashboard.js";
import type { QueenAuditRow } from "./queenAudit.js";
import type { PortfolioLane, PortfolioProject, PortfolioReason, PortfolioReport } from "./portfolio.js";

export const QUEEN_BRIEF_KEY = "queen:brief";

export interface QueenBriefPick {
  project_id: number;
  todo_id: number | null;
  action: string;
  reason: string;
}

export interface QueenBrief {
  schema_version: 1;
  written_at: string;
  summary: string;
  picks: QueenBriefPick[];
  lanes_at_brief: Record<string, PortfolioLane>;
}

export type QueenBriefState =
  | { kind: "ready"; brief: QueenBrief }
  | { kind: "missing" }
  | { kind: "invalid"; reason: "malformed" | "wrong_version" };

const LANE_ORDER: PortfolioLane[] = ["waiting_on_you", "stuck", "moving", "quiet"];
const LANE_RANK: Record<string, number> = { waiting_on_you: 0, stuck: 1, moving: 2, quiet: 3 };
const TIMESTAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const PROJECT_ID_KEY = /^[1-9]\d*$/;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const positiveInt = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;
const plainText = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
const hasExactKeys = (o: Record<string, unknown>, keys: string[]): boolean =>
  Object.keys(o).length === keys.length && keys.every((k) => Object.hasOwn(o, k));
const isLane = (v: unknown): v is PortfolioLane => typeof v === "string" && Object.hasOwn(LANE_RANK, v);

export function parseQueenBrief(raw: string): QueenBriefState {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { kind: "invalid", reason: "malformed" };
  }
  if (!isRecord(value) || !Object.hasOwn(value, "schema_version")) return { kind: "invalid", reason: "malformed" };
  if (value.schema_version !== 1) return { kind: "invalid", reason: "wrong_version" };
  const malformed: QueenBriefState = { kind: "invalid", reason: "malformed" };

  if (!hasExactKeys(value, ["schema_version", "written_at", "summary", "picks", "lanes_at_brief"])) return malformed;
  if (typeof value.written_at !== "string" || !TIMESTAMP.test(value.written_at)) return malformed;
  if (!plainText(value.summary)) return malformed;
  if (!Array.isArray(value.picks) || !isRecord(value.lanes_at_brief)) return malformed;

  const picks: QueenBriefPick[] = [];
  for (const p of value.picks) {
    if (!isRecord(p) || !hasExactKeys(p, ["project_id", "todo_id", "action", "reason"])) return malformed;
    if (!positiveInt(p.project_id)) return malformed;
    if (p.todo_id !== null && !positiveInt(p.todo_id)) return malformed;
    if (!plainText(p.action) || !plainText(p.reason)) return malformed;
    picks.push({ project_id: p.project_id, todo_id: p.todo_id, action: p.action, reason: p.reason });
  }

  const lanes: Record<string, PortfolioLane> = {};
  for (const [key, lane] of Object.entries(value.lanes_at_brief)) {
    if (!PROJECT_ID_KEY.test(key) || !Number.isSafeInteger(Number(key)) || !isLane(lane)) return malformed;
    lanes[key] = lane;
  }
  return {
    kind: "ready",
    brief: { schema_version: 1, written_at: value.written_at, summary: value.summary, picks, lanes_at_brief: lanes },
  };
}

export function readQueenBrief(queenProjectId: number, asOf: string): QueenBriefState {
  const row = db
    .prepare("SELECT value FROM kv WHERE project_id = ? AND key = ? AND (expires_at IS NULL OR expires_at >= ?)")
    .get(queenProjectId, QUEEN_BRIEF_KEY, asOf) as { value: string } | undefined;
  return row ? parseQueenBrief(row.value) : { kind: "missing" };
}

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const LANE_TITLE: Record<PortfolioLane, string> = {
  waiting_on_you: "Waiting on you",
  stuck: "Stuck",
  moving: "Moving",
  quiet: "Quiet",
};
const LANE_RULE: Record<PortfolioLane, string> = {
  waiting_on_you: "a needs-human todo and nothing else moving",
  stuck: "a stall, or blocked or stale work",
  moving: "a worker or an unblocked todo in progress",
  quiet: "nothing asked, nothing broken",
};
const LANE_COLOR: Record<PortfolioLane, string> = {
  waiting_on_you: "var(--warn)",
  stuck: "var(--fail)",
  moving: "var(--live)",
  quiet: "var(--border-strong)",
};
const REASON_LABEL: Record<PortfolioReason, string> = {
  needs_human: "Needs-human todo",
  dead_lead_pane: "Lead pane is dead",
  missing_root_with_work: "Project folder is missing",
  worker_needs_input: "A worker is waiting for input",
  wake_overdue_5m: "A wake is overdue",
  in_progress_blocked: "An in-progress todo is blocked",
  all_active_todos_blocked: "Every active todo is blocked",
  stale_in_progress_48h: "In-progress work untouched for 48 hours",
  worker_working: "A worker is working",
  todo_in_progress: "A todo is in progress",
  wake_due_24h: "A wake is due within 24 hours",
  quiet: "Nothing asked, nothing broken",
};
const REASON_SEVERE: ReadonlySet<PortfolioReason> = new Set([
  "dead_lead_pane",
  "missing_root_with_work",
  "wake_overdue_5m",
]);

function parseUtc(ts: string): number {
  return Date.parse(`${ts.replace(" ", "T")}Z`);
}

function age(from: string, asOf: string): string {
  const seconds = Math.max(0, Math.floor((parseUtc(asOf) - parseUtc(from)) / 1000));
  if (!Number.isFinite(seconds)) return "unknown";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  if (m > 0) return `${m}m`;
  return "now";
}

function ageClass(from: string, asOf: string): string {
  const seconds = (parseUtc(asOf) - parseUtc(from)) / 1000;
  if (seconds >= 2 * 86400) return " age-fail";
  if (seconds >= 4 * 3600) return " age-hot";
  return "";
}

function dashboardHref(root: string): string | null {
  try {
    const file = join(root, ".hive", "dashboard.html");
    if (!existsSync(file)) return null;
    const real = realpathSync(file);
    const base = realpathSync(root);
    return real.startsWith(base + sep) ? pathToFileURL(real).href : null;
  } catch {
    return null;
  }
}

function projectLink(p: PortfolioProject, href: (p: PortfolioProject) => string | null): string {
  const url = href(p);
  return url === null
    ? `<span class="proj">${esc(p.name)}</span>`
    : `<a class="proj" href="${esc(url)}" title="Open ${esc(p.name)}’s dashboard">${esc(p.name)}</a>`;
}

function turnText(p: PortfolioProject): string {
  return p.lead.turn === "working" ? "working" : p.lead.turn === "turn_ended" ? "turn ended" : "";
}

function turnPill(p: PortfolioProject): string {
  const t = turnText(p);
  return t === "" ? "" : ` <span class="turn turn-${p.lead.turn === "working" ? "work" : "end"}">${esc(t)}</span>`;
}

function leadPill(p: PortfolioProject): string {
  switch (p.lead.state) {
    case "alive":
      return `<span class="status status-ok">lead up</span>${turnPill(p)}`;
    case "dead_pane":
      return '<span class="status status-fail">lead dead</span>';
    case "dormant":
      return '<span class="status status-off">lead dormant</span>';
    case "unknown":
      return '<span class="status status-off">lead unknown</span>';
    default:
      return '<span class="status status-off">no lead</span>';
  }
}

function workersCell(p: PortfolioProject): string {
  const w = p.workers;
  const out: string[] = [];
  if (w.working) out.push(`<span class="w w-work">${w.working} working</span>`);
  if (w.needs_input) out.push(`<span class="w w-input">${w.needs_input} needs input</span>`);
  if (w.idle) out.push(`<span class="w w-idle">${w.idle} idle</span>`);
  if (w.unreachable) out.push(`<span class="w w-input">${w.unreachable} unreachable</span>`);
  if (w.unconfirmed) out.push(`<span class="w w-idle">${w.unconfirmed} unconfirmed</span>`);
  if (w.other) out.push(`<span class="w w-idle">${w.other} other</span>`);
  return out.length ? `<span class="workers">${out.join("")}</span>` : '<span class="zero">no workers</span>';
}

const num = (n: number, cls = ""): string =>
  n ? `<span class="${cls}">${n}</span>` : '<span class="zero">0</span>';

function wakesCell(p: PortfolioProject): string {
  const { pending, overdue } = p.wakes;
  if (overdue) {
    const rest = pending - overdue;
    return `<span class="n-high">${overdue} late</span>${rest > 0 ? ` +${rest}` : ""}`;
  }
  return num(pending);
}

function wakesText(p: PortfolioProject): string {
  const { pending, overdue } = p.wakes;
  if (pending === 0) return "";
  if (overdue) return `<span><span class="n-high">${overdue} wake late</span></span>`;
  return `<span>${pending} wake${pending > 1 ? "s" : ""} pending</span>`;
}

function footCounts(p: PortfolioProject, asOf: string, rank: number): string {
  const t = p.todos;
  return (
    `<span>${t.open} open</span><span>${t.in_progress} doing</span>` +
    (t.blocked ? `<span class="n-blocked">${t.blocked} blocked</span>` : "") +
    (t.high ? `<span class="n-high">${t.high} high</span>` : "") +
    wakesText(p) +
    (rank ? `<span class="age">seen ${esc(age(p.last_activity_at, asOf))}</span>` : "")
  );
}

function movingBadges(p: PortfolioProject): string {
  if (p.lane !== "moving") return "";
  return (
    (p.needs_human > 0 ? `<span class="n-needs">${p.needs_human} need you</span>` : "") +
    (p.todos.blocked_in_progress > 0 ? `<span class="n-muted">${p.todos.blocked_in_progress} blocked</span>` : "")
  );
}

function card(
  p: PortfolioProject,
  report: PortfolioReport,
  rank: number,
  href: (p: PortfolioProject) => string | null,
): string {
  const asOf = report.as_of;
  const items: string[] = [];
  for (const it of p.needs_human_items) {
    items.push(
      `<li><span><span class="ref">#${it.todo_id}</span> ${esc(it.title)}</span>` +
        `<span class="age${ageClass(it.updated_at, asOf)}">${esc(age(it.updated_at, asOf))}</span></li>`,
    );
  }
  if (p.needs_human > p.needs_human_items.length) {
    items.push(`<li><span class="ref">+${p.needs_human - p.needs_human_items.length} more</span></li>`);
  }
  for (const r of p.reasons) {
    if (r === "needs_human" || r === "quiet") continue;
    const cls = REASON_SEVERE.has(r) ? " age-fail" : "";
    items.push(`<li><span class="${cls.trim()}">${esc(REASON_LABEL[r])}</span></li>`);
  }
  return (
    `<article class="card pc" style="--lane:${LANE_COLOR[p.lane]}" data-project="${p.id}">` +
    `<div class="pc-top">${projectLink(p, href)}` +
    (rank
      ? `<span class="pc-pick">brief pick ${rank}</span>`
      : `<span class="age">${esc(age(p.last_activity_at, asOf))}</span>`) +
    "</div>" +
    `<div class="pc-badges">${leadPill(p)}${workersCell(p)}${movingBadges(p)}</div>` +
    (items.length ? `<ul class="pc-items">${items.join("")}</ul>` : "") +
    `<a class="pc-foot" href="#row-${p.id}" data-jump="${p.id}" title="Show ${esc(p.name)}’s row in the grid below">` +
    `${footCounts(p, asOf, rank)}</a></article>`
  );
}

function quietList(
  list: PortfolioProject[],
  asOf: string,
  href: (p: PortfolioProject) => string | null,
): string {
  return (
    '<section class="card"><ul class="quiet-list">' +
    list
      .map((p) => {
        const sub = `${p.lead.state === "alive" ? (turnText(p) ? `lead up, ${turnText(p)}` : "lead up") : p.lead.state === "dead_pane" ? "lead dead" : p.lead.state === "dormant" ? "lead dormant" : p.lead.state === "unknown" ? "lead unknown" : "no lead"}, ${p.todos.open} open`;
        return (
          `<li data-project="${p.id}"><span>${projectLink(p, href)}` +
          `<a class="sub" href="#row-${p.id}" data-jump="${p.id}">${esc(sub)}</a></span>` +
          `<span class="age">${esc(age(p.last_activity_at, asOf))}</span></li>`
        );
      })
      .join("") +
    "</ul></section>"
  );
}

function gridRow(p: PortfolioProject, asOf: string, href: (p: PortfolioProject) => string | null): string {
  const t = p.todos;
  const note = p.root_exists ? "" : '<span class="g-note">project folder is missing</span>';
  return (
    `<div class="g-row" role="row" id="row-${p.id}" style="--lane:${LANE_COLOR[p.lane]}">` +
    `<span class="c-name g-name">${projectLink(p, href)}${note}</span>` +
    `<span class="c-lead">${leadPill(p)}</span>` +
    `<span class="c-work">${workersCell(p)}</span>` +
    `<span class="c-n g-num">${num(t.open)}</span><span class="c-n g-num">${num(t.in_progress)}</span>` +
    `<span class="c-n g-num">${num(t.blocked, "n-blocked")}</span><span class="c-n g-num">${num(t.high, "n-high")}</span>` +
    `<span class="c-n g-num">${num(p.needs_human, "n-needs")}</span><span class="c-n g-num c-wake">${wakesCell(p)}</span>` +
    `<span class="c-last g-num age">${esc(age(p.last_activity_at, asOf))}</span>` +
    '<span class="c-nums">' +
    `<span>${t.open} open</span><span>${t.in_progress} doing</span>` +
    (t.blocked ? `<span class="n-blocked">${t.blocked} blocked</span>` : "") +
    (t.high ? `<span class="n-high">${t.high} high</span>` : "") +
    (p.needs_human ? `<span class="n-needs">${p.needs_human} need you</span>` : "") +
    wakesText(p) +
    "</span></div>"
  );
}

const GRID_HEAD =
  '<div class="g-row g-head" role="row"><span>Project</span><span>Lead</span><span>Workers</span>' +
  '<span class="g-num">Open</span><span class="g-num">Doing</span><span class="g-num">Blocked</span>' +
  '<span class="g-num">High</span><span class="g-num">Needs you</span><span class="g-num c-wake">Wakes</span>' +
  '<span class="g-num">Last seen</span></div>';

function laneName(lane: PortfolioLane): string {
  return LANE_TITLE[lane].toLowerCase();
}

function driftLine(brief: QueenBrief, report: PortfolioReport, queenHomeId: number | null): string {
  const then = brief.lanes_at_brief;
  const live = new Map(report.projects.map((p) => [String(p.id), p]));
  const changes: { rank: number; id: number; text: string }[] = [];
  for (const p of report.projects) {
    if (p.id === queenHomeId) continue;
    const before = then[String(p.id)];
    if (before === undefined) {
      changes.push({ rank: LANE_RANK[p.lane], id: p.id, text: `${esc(p.name)} is new since the brief` });
    } else if (before !== p.lane) {
      changes.push({
        rank: LANE_RANK[p.lane],
        id: p.id,
        text: `${esc(p.name)} moved from ${laneName(before)} to ${laneName(p.lane)}`,
      });
    }
  }
  for (const [key, before] of Object.entries(then)) {
    if (live.has(key) || key === String(queenHomeId)) continue;
    changes.push({
      rank: LANE_RANK[before] + LANE_ORDER.length,
      id: Number(key),
      text: `project #${key} is no longer registered (was ${laneName(before)})`,
    });
  }
  changes.sort((a, b) => a.rank - b.rank || a.id - b.id);
  const body = changes.length ? `${changes.map((c) => c.text).join("; ")}.` : "No project changed lanes since the brief.";
  return `<p class="drift"><strong>Since the brief:</strong> ${body}</p>`;
}

function briefSection(
  state: QueenBriefState,
  report: PortfolioReport,
  href: (p: PortfolioProject) => string | null,
  queenHomeId: number | null,
): string {
  const head = (stamp: string): string => `<div><h2>Picks today</h2>${stamp}</div>`;
  if (state.kind === "missing") {
    return `<section class="card c-brief">${head("")}<p class="brief-empty">No queen brief yet.</p></section>`;
  }
  if (state.kind === "invalid") {
    const msg = state.reason === "wrong_version" ? "Queen brief version is unsupported." : "Queen brief could not be read.";
    return `<section class="card c-brief">${head("")}<p class="brief-empty">${msg}</p></section>`;
  }
  const { brief } = state;
  const byId = new Map(report.projects.map((p) => [p.id, p]));
  const written = age(brief.written_at, report.as_of);
  const briefAge = written === "now" ? "just now" : `${written} ago`;
  const stale = (parseUtc(report.as_of) - parseUtc(brief.written_at)) / 1000 > 86400;
  const stamp =
    `<span class="brief-stamp${stale ? " brief-stale" : ""}" title="written ${esc(brief.written_at)} UTC">` +
    `written ${esc(briefAge)}</span>`;
  const picks = brief.picks
    .map((k) => {
      const p = byId.get(k.project_id);
      const who = p ? projectLink(p, href) : `<span class="proj">#${k.project_id} (not registered)</span>`;
      const todo = k.todo_id === null ? "" : ` <span class="ref">#${k.todo_id}</span>`;
      return `<li>${who}${todo} ${esc(k.action)}<span class="why">${esc(k.reason)}</span></li>`;
    })
    .join("");
  return (
    `<section class="card c-brief">${head(stamp)}` +
    `<p class="brief-summary">${esc(brief.summary)}</p>` +
    (picks ? `<ol>${picks}</ol>` : "") +
    `${driftLine(brief, report, queenHomeId)}</section>`
  );
}

const CSS = `${SECTION_STYLE}
:root { color-scheme: light;
  --font-mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  --font-sans: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --bg: #f5f7fa; --panel: #ffffff; --panel-sunken: #f1f4f8;
  --fg: #171a1f; --fg-muted: #5c6672; --fg-subtle: #6e7885;
  --border: #e4e8ee; --border-strong: #d2d8e0;
  --ok: #0f7a4d; --warn: #8a5300; --fail: #b4271c; --live: #1f5fd0;
  --ok-bg: #e6f4ec; --warn-bg: #fbf0dd; --fail-bg: #fceceb; --live-bg: #e8f0fd;
  --accent: #1f5fd0; --focus: #1f5fd0; --hover: #f1f4f8;
  --shadow: 0 1px 2px rgba(19, 26, 38, 0.06), 0 2px 8px rgba(19, 26, 38, 0.05);
  --card-border: transparent; --r-card: 14px; --r-ctl: 9px; --r-pill: 999px;
  --ease-out: cubic-bezier(0.23, 1, 0.32, 1); --header-offset: 5rem; }
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) { color-scheme: dark;
    --bg: #101317; --panel: #171b21; --panel-sunken: #1c2129;
    --fg: #e8ebef; --fg-muted: #9aa5b1; --fg-subtle: #8b95a1;
    --border: #262c35; --border-strong: #333b46;
    --ok: #4cc98d; --warn: #e0a548; --fail: #f0736a; --live: #6aa6ee;
    --ok-bg: #14291f; --warn-bg: #2c2213; --fail-bg: #2e1a19; --live-bg: #16233a;
    --accent: #6aa6ee; --focus: #6aa6ee; --hover: #1c2129; --shadow: none; --card-border: #262c35; } }
:root[data-theme="dark"] { color-scheme: dark;
  --bg: #101317; --panel: #171b21; --panel-sunken: #1c2129;
  --fg: #e8ebef; --fg-muted: #9aa5b1; --fg-subtle: #8b95a1;
  --border: #262c35; --border-strong: #333b46;
  --ok: #4cc98d; --warn: #e0a548; --fail: #f0736a; --live: #6aa6ee;
  --ok-bg: #14291f; --warn-bg: #2c2213; --fail-bg: #2e1a19; --live-bg: #16233a;
  --accent: #6aa6ee; --focus: #6aa6ee; --hover: #1c2129; --shadow: none; --card-border: #262c35; }
*, *::before, *::after { box-sizing: border-box; }
body { font-family: var(--font-sans); font-size: 0.9375rem; line-height: 1.5; margin: 0; padding-block: 0 4rem;
  background: var(--bg); color: var(--fg); accent-color: var(--accent); }
a { color: inherit; }
a:focus-visible, button:focus-visible, input:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
.wrap { max-width: 76rem; margin: 0 auto; padding-inline: 1.25rem; }
@media (max-width: 30rem) { .wrap { padding-inline: 1rem; } }
.topbar { border-bottom: 1px solid var(--border); background: var(--bg); position: sticky; top: 0; z-index: 5; }
.topbar-inner { display: flex; align-items: center; justify-content: space-between; gap: 1rem; flex-wrap: wrap; padding-block: 0.8rem 0.7rem; }
.brand { display: flex; align-items: center; gap: 0.7rem; min-width: 0; }
.mark { width: 1.75rem; height: 1.75rem; flex: 0 0 auto; color: var(--accent); }
h1 { font-size: 1.0625rem; font-weight: 650; letter-spacing: -0.011em; margin: 0; }
.generated { color: var(--fg-muted); font-size: 0.78125rem; margin: 0.1rem 0 0; }
.live-toggle { display: inline-flex; align-items: center; gap: 0.45rem; cursor: pointer; font-size: 0.8125rem; font-weight: 500; color: var(--fg-muted); user-select: none; }
.live-toggle input { appearance: none; -webkit-appearance: none; width: 2.15rem; height: 1.2rem; background: var(--border-strong); border-radius: var(--r-pill); position: relative; margin: 0; cursor: pointer; transition: background-color 160ms var(--ease-out); }
.live-toggle input::before { content: ""; position: absolute; top: 2px; left: 2px; width: 1rem; height: 1rem; border-radius: 50%; background: var(--panel); box-shadow: 0 1px 2px rgba(19, 26, 38, 0.28); transition: transform 160ms var(--ease-out); }
.live-toggle input:checked { background: var(--accent); }
.live-toggle input:checked::before { transform: translateX(0.95rem); }
h2 { font-size: 0.9375rem; font-weight: 650; margin: 0; letter-spacing: -0.005em; display: flex; align-items: baseline; gap: 0.5rem; }
h2 .count { font-family: var(--font-mono); font-size: 0.78125rem; color: var(--fg-subtle); font-weight: 500; }
.card { background: var(--panel); border: 1px solid var(--card-border); border-radius: var(--r-card); box-shadow: var(--shadow); }
.card-head { display: flex; align-items: baseline; justify-content: space-between; gap: 0.75rem; flex-wrap: wrap; padding: 0.9rem 1.1rem 0.5rem; }
.card-sub { font-size: 0.78125rem; color: var(--fg-muted); }
.status { display: inline-flex; align-items: center; gap: 0.3rem; font-size: 0.71875rem; font-weight: 600; padding: 0.12rem 0.5rem; border-radius: var(--r-pill); white-space: nowrap; }
.status::before { content: ""; width: 0.4rem; height: 0.4rem; border-radius: 50%; background: currentColor; }
.status-ok { color: var(--ok); background: var(--ok-bg); }
.status-warn { color: var(--warn); background: var(--warn-bg); }
.status-fail { color: var(--fail); background: var(--fail-bg); }
.status-off { color: var(--fg-subtle); background: var(--panel-sunken); }
.proj { font-weight: 600; text-decoration: none; overflow-wrap: anywhere; }
a.proj:hover { color: var(--accent); text-decoration: underline; text-underline-offset: 2px; }
.ref { font-family: var(--font-mono); font-size: 0.8125rem; color: var(--fg-subtle); }
.age { font-family: var(--font-mono); font-size: 0.8125rem; color: var(--fg-muted); white-space: nowrap; font-variant-numeric: tabular-nums; }
.age-hot { color: var(--warn); font-weight: 600; }
.age-fail { color: var(--fail); font-weight: 600; }
.brief-stamp { font-size: 0.78125rem; font-weight: 400; color: var(--fg-muted); }
.brief-stamp.brief-stale { color: var(--warn); }
.drift { margin: 0.5rem 0 0; grid-column: 1 / -1; padding: 0.55rem 0.75rem; border-radius: var(--r-ctl); background: var(--warn-bg); color: var(--fg); font-size: 0.8125rem; }
.drift strong { color: var(--warn); font-weight: 650; }
.grid { display: grid; }
.g-row { display: grid; grid-template-columns: minmax(8.5rem, 1.3fr) 10.5rem minmax(8rem, 1.2fr) repeat(4, 3.2rem) 4.6rem 5.2rem 5.6rem; align-items: center; gap: 0.6rem; padding: 0.5rem 1.1rem; border-top: 1px solid var(--border); font-size: 0.875rem; }
.g-row:hover:not(.g-head) { background: var(--hover); }
.g-head { font-size: 0.75rem; color: var(--fg-subtle); font-weight: 550; border-top: 0; padding-block: 0.2rem 0.4rem; }
.g-num { font-family: var(--font-mono); font-variant-numeric: tabular-nums; text-align: right; }
.g-head .g-num { font-family: var(--font-sans); }
.zero { color: var(--fg-subtle); opacity: 0.55; }
.n-high { color: var(--fail); font-weight: 650; }
.n-muted { color: var(--fg-muted); }
.n-blocked { color: var(--warn); font-weight: 650; }
.n-needs { color: var(--warn); font-weight: 700; }
.workers { display: flex; gap: 0.45rem; flex-wrap: wrap; font-size: 0.8125rem; color: var(--fg-muted); }
.w { display: inline-flex; align-items: center; gap: 0.25rem; white-space: nowrap; }
.w::before { content: ""; width: 0.45rem; height: 0.45rem; border-radius: 50%; background: currentColor; }
.w-work { color: var(--live); }
.w-idle { color: var(--fg-subtle); }
.w-input { color: var(--warn); font-weight: 600; }
.g-name { display: flex; flex-direction: column; min-width: 0; }
.g-note { font-size: 0.75rem; color: var(--fg-subtle); }
.c-nums { display: none !important; gap: 0.35rem 0.8rem; flex-wrap: wrap; font-size: 0.8125rem; color: var(--fg-muted); }
.c-nums span { white-space: nowrap; }
@media (max-width: 52rem) {
  .g-head { display: none; }
  .g-row { grid-template-columns: minmax(0, 1fr) auto; grid-template-areas: "name last" "lead lead" "work work" "nums nums"; gap: 0.35rem 0.75rem; padding-block: 0.75rem; }
  .g-row > .c-name { grid-area: name; }
  .g-row > .c-last { grid-area: last; }
  .g-row > .c-lead { grid-area: lead; }
  .g-row > .c-work { grid-area: work; }
  .g-row > .c-n { display: none; }
  .g-row > .c-nums { grid-area: nums; display: flex !important; }
}
.freshnote { font-size: 0.75rem; color: var(--fg-subtle); padding: 0.6rem 1.1rem 0.9rem; margin: 0; }
.c-brief { margin-top: 1.25rem; padding: 0.85rem 1.1rem; display: grid; grid-template-columns: minmax(0, 15rem) minmax(0, 1fr); gap: 0.4rem 1.25rem; }
.c-brief ol { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 0.9rem; counter-reset: pick; }
.c-brief > div:first-child { grid-row: 1 / span 2; }
.c-brief ol { grid-column: 2; }
.c-brief li { counter-increment: pick; font-size: 0.875rem; min-width: 0; overflow-wrap: anywhere; }
.c-brief li::before { content: counter(pick); font-family: var(--font-mono); font-weight: 650; color: var(--accent); margin-right: 0.4rem; }
.c-brief .why { display: block; color: var(--fg-muted); font-size: 0.8125rem; margin-top: 0.15rem; }
.brief-summary, .brief-empty { margin: 0; font-size: 0.875rem; color: var(--fg-muted); grid-column: 2; min-width: 0; overflow-wrap: anywhere; }
.brief-summary { color: var(--fg); }
@media (max-width: 52rem) {
  .c-brief { grid-template-columns: minmax(0, 1fr); }
  .c-brief > div:first-child { grid-row: auto; }
  .c-brief ol { grid-template-columns: minmax(0, 1fr); gap: 0.6rem; grid-column: 1; }
  .brief-summary, .brief-empty { grid-column: 1; }
}
.lanes { display: grid; grid-template-columns: 1.15fr 1.15fr 1fr 0.8fr; gap: 1rem; margin-top: 1rem; align-items: start; }
@media (max-width: 64rem) { .lanes { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); } }
@media (max-width: 36rem) { .lanes { grid-template-columns: minmax(0, 1fr); } }
.lane { display: grid; gap: 0.6rem; min-width: 0; }
.lane-head { display: flex; align-items: baseline; gap: 0.5rem; padding: 0 0.2rem; }
.lane-head h2::before { content: ""; display: inline-block; width: 0.55rem; height: 0.55rem; border-radius: 50%; margin-right: 0.1rem; background: var(--lane); align-self: center; }
.lane-rule { font-size: 0.75rem; color: var(--fg-subtle); padding: 0 0.2rem; margin: -0.4rem 0 0; }
.pc { padding: 0.8rem 0.95rem; display: grid; gap: 0.45rem; border-top: 3px solid var(--lane); }
.pc-top { display: flex; justify-content: space-between; align-items: baseline; gap: 0.5rem; }
.pc-badges { display: flex; gap: 0.5rem; flex-wrap: wrap; align-items: center; }
.pc-items { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.35rem; }
.pc-items li { font-size: 0.8125rem; display: flex; justify-content: space-between; gap: 0.6rem; }
.pc-items li span:first-child { min-width: 0; overflow-wrap: anywhere; }
.pc-foot { display: flex; gap: 0.3rem 0.8rem; flex-wrap: wrap; font-size: 0.75rem; color: var(--fg-muted); padding-top: 0.4rem; border-top: 1px solid var(--border); text-decoration: none; border-radius: 0 0 var(--r-ctl) var(--r-ctl); }
.pc-foot span { white-space: nowrap; }
.pc-foot:hover { color: var(--accent); }
.pc-foot::after { content: "row"; margin-left: auto; color: var(--fg-subtle); font-size: 0.71875rem; }
.pc-foot:hover::after { color: var(--accent); text-decoration: underline; text-underline-offset: 2px; }
.pc-pick { font-size: 0.71875rem; font-weight: 650; color: var(--accent); background: var(--live-bg); border-radius: var(--r-pill); padding: 0.05rem 0.45rem; white-space: nowrap; }
.quiet-list { list-style: none; margin: 0; padding: 0.3rem 0; }
.quiet-list li { display: flex; justify-content: space-between; gap: 0.6rem; align-items: baseline; padding: 0.45rem 0.95rem; border-top: 1px solid var(--border); font-size: 0.8125rem; }
.quiet-list li:first-child { border-top: 0; }
.quiet-list .sub { display: block; color: var(--fg-subtle); font-size: 0.75rem; text-decoration: none; }
a.sub:hover { color: var(--accent); text-decoration: underline; text-underline-offset: 2px; }
.turn { font-size: 0.75rem; color: var(--fg-muted); }
.turn-work { color: var(--live); }
.c-audit { margin-top: 1.5rem; padding-bottom: 0.85rem; }
.c-audit .audit-list, .c-audit .brief-empty { padding: 0 1.1rem; }
.audit-list { list-style: none; margin: 0.5rem 0 0; padding: 0; display: grid; gap: 0.4rem; font-size: 0.8125rem; }
.audit-list li { display: flex; flex-wrap: wrap; gap: 0.15rem 0.75rem; align-items: baseline; }
.audit-op { font-weight: 600; }
.audit-sum { color: var(--fg-muted); min-width: 0; overflow-wrap: anywhere; }
.d-grid { margin-top: 1.5rem; }
.home { margin-top: 1.5rem; }
.home-head { padding: 0 0.2rem 0.6rem; }
.d-grid .g-row:not(.g-head) { box-shadow: inset 3px 0 0 var(--lane, transparent); }
.d-grid .g-row { scroll-margin-top: 6rem; transition: background-color 600ms ease; }
.d-grid .g-row.is-flash { background: var(--live-bg); transition: none; }
.no-projects { margin-top: 1.25rem; padding: 1.25rem 1.1rem; color: var(--fg-muted); }
@media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
`;

const SCRIPT = `(function () {
  var KEY = "queen-autoreload", box = document.getElementById("autoreload"), timer = null;
  function arm() { clearTimeout(timer); timer = box.checked ? setTimeout(function () { location.reload(); }, 60000) : null; }
  box.checked = true;
  try { box.checked = sessionStorage.getItem(KEY) !== "0"; } catch (e) {}
  box.addEventListener("change", function () { try { sessionStorage.setItem(KEY, box.checked ? "1" : "0"); } catch (e) {} arm(); });
  arm();
  document.addEventListener("click", function (e) {
    var j = e.target.closest && e.target.closest("[data-jump]");
    if (!j) return;
    var row = document.getElementById("row-" + j.getAttribute("data-jump"));
    if (!row) return;
    e.preventDefault();
    var still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    row.scrollIntoView({ behavior: still ? "auto" : "smooth", block: "center" });
    row.classList.add("is-flash");
    setTimeout(function () { row.classList.remove("is-flash"); }, 900);
  });
})();`;

const SECTIONS_SCRIPT = `(function () {
${sectionScript("hive-queen-state")}
})();`;

const MARK =
  '<symbol id="mark" viewBox="0 0 32 32"><path d="M16 3.2 27 9.6v12.8L16 28.8 5 22.4V9.6Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M16 11 21 14v6l-5 3-5-3v-6Z" fill="currentColor" fill-opacity="0.22" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></symbol>';

export const QUEEN_GENERATED_MARKER = "data-generated";

function auditSection(audit: QueenAuditRow[], report: PortfolioReport): string {
  const names = new Map(report.projects.map((p) => [p.id, p.name]));
  const body = audit.length
    ? '<ul class="audit-list">' +
      audit
        .map(
          (a) =>
            `<li><span class="age">${esc(a.created_at)} UTC</span>` +
            `<span class="proj">${esc(names.get(a.target_project_id) ?? `project #${a.target_project_id}`)}</span>` +
            `<span class="audit-op">${esc(a.operation)}</span>` +
            `<span class="ref">${esc(a.resource_type)} #${a.resource_id}</span>` +
            `<span class="audit-sum">${esc(a.summary)}</span></li>`,
        )
        .join("") +
      "</ul>"
    : '<p class="brief-empty">No queen actions recorded yet.</p>';
  return `<section class="card c-audit"><div class="card-head"><h2>Recent queen actions</h2><span class="card-sub">the newest writes the queen made into other projects</span></div>${body}</section>`;
}

export function renderQueenDashboard(
  report: PortfolioReport,
  briefState: QueenBriefState,
  href: (p: PortfolioProject) => string | null = (p) => dashboardHref(p.root),
  audit: QueenAuditRow[] = [],
  queenHomeId: number | null = null,
): string {
  const asOf = report.as_of;
  const byLane = new Map<PortfolioLane, PortfolioProject[]>(LANE_ORDER.map((l) => [l, []]));
  for (const p of report.projects) byLane.get(p.lane)?.push(p);
  const ordered = LANE_ORDER.flatMap((l) => byLane.get(l) ?? []);

  const rank = new Map<number, number>();
  if (briefState.kind === "ready") {
    briefState.brief.picks.forEach((k, i) => {
      if (!rank.has(k.project_id)) rank.set(k.project_id, i + 1);
    });
  }

  const n = report.totals.projects;
  const lanes = LANE_ORDER.map((lane) => {
    const list = byLane.get(lane) ?? [];
    const body =
      lane === "quiet"
        ? list.length
          ? quietList(list, asOf, href)
          : ""
        : list.map((p) => card(p, report, rank.get(p.id) ?? 0, href)).join("");
    return (
      `<section class="lane" data-lane="${lane}" style="--lane:${LANE_COLOR[lane]}"><div class="lane-head"><h2>${LANE_TITLE[lane]} ` +
      `<span class="count">${report.totals.lanes[lane]}</span></h2></div>` +
      `<p class="lane-rule">${LANE_RULE[lane]}</p>${body}</section>`
    );
  }).join("");

  const home =
    queenHomeId === null
      ? ""
      : `<div class="home"><div class="home-head"><h2>Queen home project</h2></div>${renderBoardPadsTodos(queenHomeId)}</div>`;

  const main =
    n === 0
      ? `${briefSection(briefState, report, href, queenHomeId)}<section class="card no-projects"><h2>No projects registered</h2><p>Run <code>hive lead</code> in a project folder to register it, and it will appear here.</p></section>`
      : `${briefSection(briefState, report, href, queenHomeId)}<div class="lanes">${lanes}</div>` +
        `<section class="card d-grid"><div class="card-head"><h2>Every project <span class="count">${n}</span></h2>` +
        '<span class="card-sub">in lane order; a name opens that project’s dashboard</span></div>' +
        `<div class="grid" role="table">${GRID_HEAD}${ordered.map((p) => gridRow(p, asOf, href)).join("")}</div>` +
        '<p class="freshnote">Every row here is read from the store when the page is written. Only the picks are written by a model, which is why they carry a time.</p></section>' +
        auditSection(audit, report);
  const page = main + home;

  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">' +
    `<title>All projects</title><style>${CSS}</style></head><body>` +
    SPRITE +
    `<svg style="position:absolute;width:0;height:0" aria-hidden="true"><defs>${MARK}</defs></svg>` +
    '<header class="topbar" id="topbar"><div class="wrap topbar-inner"><div class="brand">' +
    '<svg class="mark" role="img" aria-label="hive"><use href="#mark"/></svg><div><h1>All projects</h1>' +
    `<p class="generated" ${QUEEN_GENERATED_MARKER}>Live rows as of ${esc(asOf)} UTC. ${n} project${n === 1 ? "" : "s"} on this machine.</p></div></div>` +
    '<label class="live-toggle" title="Off stops this page reloading. The scheduler still rewrites the file.">' +
    '<input type="checkbox" id="autoreload"> Reload every minute</label></div></header>' +
    `<main class="wrap">${page}</main><script>${SCRIPT}\n${SECTIONS_SCRIPT}</script></body></html>\n`
  );
}
