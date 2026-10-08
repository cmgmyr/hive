import { db } from "./db.js";
import { listProjects } from "./context.js";
import { existsSync } from "node:fs";
import { parseTags } from "./result.js";
import { OPEN_BLOCKERS_SQL } from "./tools/todos.js";
import { leadSessionEnded, readLeadTurnState } from "./leadState.js";
import { liveTargets, ownershipLiveness, rowOwnership, type AliveSnapshot } from "./tmux.js";

export type PortfolioLane = "waiting_on_you" | "stuck" | "moving" | "quiet";

export const PORTFOLIO_REASONS = [
  "needs_human",
  "dead_lead_pane",
  "missing_root_with_work",
  "worker_needs_input",
  "wake_overdue_5m",
  "in_progress_blocked",
  "all_active_todos_blocked",
  "stale_in_progress_48h",
  "worker_working",
  "todo_in_progress",
  "wake_due_24h",
  "quiet",
] as const;
export type PortfolioReason = (typeof PORTFOLIO_REASONS)[number];

export const NEEDS_HUMAN_TAG = "needs-human";
const NEEDS_HUMAN_ITEM_CAP = 5;
const WAKE_OVERDUE_GRACE = "-5 minutes";
const STALE_IN_PROGRESS = "-48 hours";
const WAKE_UPCOMING = "+24 hours";

export const ACTIVE_WAKE_WHERE = "cancelled_at IS NULL AND (fired_at IS NULL OR repeat_every_ms IS NOT NULL)";

export type PortfolioLeadTurn = "working" | "turn_ended" | "unknown";

export function leadText(p: Pick<PortfolioProject, "lead">): string {
  return p.lead.state === "alive" && p.lead.turn !== "unknown"
    ? `alive, turn ${p.lead.turn === "working" ? "working" : "ended"}`
    : p.lead.state;
}

function leadTurnFor(agentId: number, panePid: string): PortfolioLeadTurn {
  const row = readLeadTurnState(agentId);
  if (row === null || row.pane_pid !== panePid) return "unknown";
  return row.state === "working" ? "working" : row.state === "idle" ? "turn_ended" : "unknown";
}

export interface PortfolioProject {
  id: number;
  name: string;
  root: string;
  root_exists: boolean;
  lane: PortfolioLane;
  reasons: PortfolioReason[];
  lead: { state: "alive" | "dead_pane" | "dormant" | "none" | "unknown"; agent_id: number | null; turn: PortfolioLeadTurn; ended_at: string | null };
  workers: {
    working: number;
    idle: number;
    needs_input: number;
    other: number;
    unreachable: number;
    unconfirmed: number;
  };
  todos: { open: number; in_progress: number; blocked: number; blocked_in_progress: number; high: number };
  needs_human: number;
  needs_human_items: { todo_id: number; title: string; slug: string | null; updated_at: string }[];
  last_activity_at: string;
  wakes: { pending: number; overdue: number };
}

export interface PortfolioReport {
  schema_version: 1;
  as_of: string;
  totals: { projects: number; lanes: Record<PortfolioLane, number> };
  projects: PortfolioProject[];
}

interface TodoRow {
  id: number;
  title: string;
  slug: string;
  priority: string;
  status: string;
  tags: string;
  updated_at: string;
  blocked: number;
}

interface AgentRow {
  id: number;
  kind: string;
  agent_state: string;
  tmux_target: string;
  tmux_socket: string;
  pane_pid: string;
}

const ONE = (sql: string, ...params: unknown[]): unknown => db.prepare(sql).get(...params);

function shiftedClock(now: string, modifier: string): string {
  return (ONE("SELECT datetime(?, ?) AS t", now, modifier) as { t: string }).t;
}

function lastActivity(projectId: number, countWakeFires = true): string {
  const row = ONE(
    `SELECT MAX(t) AS t FROM (
       SELECT created_at AS t FROM projects WHERE id = :pid
       UNION ALL SELECT updated_at FROM todos WHERE project_id = :pid
       UNION ALL SELECT c.created_at FROM todo_comments c JOIN todos t ON t.id = c.todo_id WHERE t.project_id = :pid
       UNION ALL SELECT updated_at FROM pads WHERE project_id = :pid
       UNION ALL SELECT created_at FROM agents WHERE project_id = :pid
       UNION ALL SELECT state_changed_at FROM agents WHERE project_id = :pid
       UNION ALL SELECT substr(l.created_at, 1, 19) FROM agent_state_log l
         WHERE l.actor_id IN (SELECT actor_id FROM agents WHERE project_id = :pid)
       UNION ALL SELECT created_at FROM wakes WHERE project_id = :pid
       ${countWakeFires ? "UNION ALL SELECT fired_at FROM wakes WHERE project_id = :pid" : ""}
     )`,
    { pid: projectId },
  ) as { t: string };
  return row.t;
}

function projectRow(
  project: { id: number; name: string; path: string },
  now: string,
  snapshot: AliveSnapshot | null,
): PortfolioProject {
  const rootExists = existsSync(project.path);

  const todoRows = db
    .prepare(
      `SELECT t.id, t.title, t.slug, t.priority, t.status, t.tags, t.updated_at,
              EXISTS (${OPEN_BLOCKERS_SQL}) AS blocked
         FROM todos t
        WHERE t.project_id = ? AND t.status IN ('open', 'in_progress') AND t.archived_at IS NULL`,
    )
    .all(project.id) as TodoRow[];

  const todos = { open: 0, in_progress: 0, blocked: 0, blocked_in_progress: 0, high: 0 };
  const tagged: TodoRow[] = [];
  for (const t of todoRows) {
    if (t.status === "open") todos.open++;
    else todos.in_progress++;
    if (t.blocked) {
      todos.blocked++;
      if (t.status === "in_progress") todos.blocked_in_progress++;
    }
    if (t.priority === "high") todos.high++;
    if (parseTags(t.tags).includes(NEEDS_HUMAN_TAG)) tagged.push(t);
  }
  tagged.sort((a, b) => (a.updated_at < b.updated_at ? -1 : a.updated_at > b.updated_at ? 1 : a.id - b.id));

  const agents = db
    .prepare(
      "SELECT id, kind, agent_state, tmux_target, tmux_socket, pane_pid FROM agents WHERE project_id = ? AND status = 'running' ORDER BY id",
    )
    .all(project.id) as AgentRow[];

  const liveness = (a: AgentRow): boolean | null => ownershipLiveness(rowOwnership(a, snapshot));

  const workers = { working: 0, idle: 0, needs_input: 0, other: 0, unreachable: 0, unconfirmed: 0 };
  let liveWorking = 0;
  let liveWaiting = 0;
  let lead: PortfolioProject["lead"] = { state: "none", agent_id: null, turn: "unknown", ended_at: null };
  for (const a of agents) {
    if (a.kind === "lead") {
      const ownership = rowOwnership(a, snapshot);
      const live = ownership === "live" ? true : ownership === "unknown" ? null : false;
      const ended = leadSessionEnded(a, ownership);
      lead = {
        state: live === true ? "alive" : live === false ? (ended ? "dormant" : "dead_pane") : "unknown",
        agent_id: a.id,
        turn: live === true ? leadTurnFor(a.id, a.pane_pid) : "unknown",
        ended_at: ended?.ended_at ?? null,
      };
      continue;
    }
    if (a.kind !== "agent") continue;
    const live = liveness(a);
    if (live === false) workers.unreachable++;
    else if (live === null) workers.unconfirmed++;
    else if (a.agent_state === "working") {
      workers.working++;
      liveWorking++;
    } else if (a.agent_state === "idle") workers.idle++;
    else if (a.agent_state === "waiting") {
      workers.needs_input++;
      liveWaiting++;
    } else workers.other++;
  }

  const overdueBefore = shiftedClock(now, WAKE_OVERDUE_GRACE);
  const upcomingUntil = shiftedClock(now, WAKE_UPCOMING);
  const wakeCounts = db
    .prepare(
      `SELECT COUNT(*) AS pending,
              COALESCE(SUM(held_at IS NULL AND COALESCE(due_at, max_wait_at) < ?), 0) AS overdue,
              COALESCE(SUM(held_at IS NULL AND COALESCE(due_at, max_wait_at) <= ?), 0) AS overdue_grace,
              COALESCE(SUM(COALESCE(due_at, max_wait_at) > ? AND COALESCE(due_at, max_wait_at) <= ?), 0) AS upcoming
         FROM wakes WHERE project_id = ? AND ${ACTIVE_WAKE_WHERE}`,
    )
    .get(now, overdueBefore, overdueBefore, upcomingUntil, project.id) as {
    pending: number;
    overdue: number;
    overdue_grace: number;
    upcoming: number;
  };

  const lastActivityAt = lastActivity(project.id);
  const staleClock = lastActivity(project.id, false);
  const staleBefore = shiftedClock(now, STALE_IN_PROGRESS);
  const activeTodos = todos.open + todos.in_progress;

  const found = new Set<PortfolioReason>();
  if (tagged.length > 0) found.add("needs_human");
  if ((lead.state === "dead_pane" || lead.state === "dormant") && (todos.in_progress > 0 || wakeCounts.pending > 0)) found.add("dead_lead_pane");
  if (!rootExists && (activeTodos > 0 || wakeCounts.pending > 0)) found.add("missing_root_with_work");
  if (liveWaiting > 0) found.add("worker_needs_input");
  if (wakeCounts.overdue_grace > 0) found.add("wake_overdue_5m");
  if (todos.blocked_in_progress > 0) found.add("in_progress_blocked");
  if (activeTodos > 0 && todos.blocked === activeTodos) found.add("all_active_todos_blocked");
  if (todos.in_progress > 0 && liveWorking === 0 && staleClock <= staleBefore) found.add("stale_in_progress_48h");
  if (liveWorking > 0) found.add("worker_working");
  if (todos.in_progress > 0) found.add("todo_in_progress");
  if (wakeCounts.upcoming > 0) found.add("wake_due_24h");

  const HARD_STALL: PortfolioReason[] = [
    "dead_lead_pane",
    "missing_root_with_work",
    "worker_needs_input",
    "wake_overdue_5m",
  ];
  const TODO_GRAPH: PortfolioReason[] = ["in_progress_blocked", "all_active_todos_blocked", "stale_in_progress_48h"];
  const freshInProgress = todos.in_progress > todos.blocked_in_progress && !found.has("stale_in_progress_48h");
  const movingSignal = liveWorking > 0 || freshInProgress;
  let lane: PortfolioLane;
  if (HARD_STALL.some((r) => found.has(r))) lane = "stuck";
  else if (movingSignal) lane = "moving";
  else if (found.has("needs_human")) lane = "waiting_on_you";
  else if (TODO_GRAPH.some((r) => found.has(r))) lane = "stuck";
  else {
    lane = "quiet";
    found.add("quiet");
  }

  return {
    id: project.id,
    name: project.name,
    root: project.path,
    root_exists: rootExists,
    lane,
    reasons: PORTFOLIO_REASONS.filter((r) => found.has(r)),
    lead,
    workers,
    todos,
    needs_human: tagged.length,
    needs_human_items: tagged.slice(0, NEEDS_HUMAN_ITEM_CAP).map((t) => ({
      todo_id: t.id,
      title: t.title,
      slug: t.slug === "" ? null : t.slug,
      updated_at: t.updated_at,
    })),
    last_activity_at: lastActivityAt,
    wakes: { pending: wakeCounts.pending, overdue: wakeCounts.overdue },
  };
}

export function collectPortfolio(now?: string): PortfolioReport {
  const asOf = now ?? (ONE("SELECT datetime('now') AS now") as { now: string }).now;
  const snapshot = liveTargets();
  const projects = listProjects().map((p) => projectRow(p, asOf, snapshot));
  const lanes: Record<PortfolioLane, number> = { waiting_on_you: 0, stuck: 0, moving: 0, quiet: 0 };
  for (const p of projects) lanes[p.lane]++;
  return { schema_version: 1, as_of: asOf, totals: { projects: projects.length, lanes }, projects };
}
