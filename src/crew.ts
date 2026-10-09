import { execFileSync } from "node:child_process";
import type Database from "better-sqlite3";
import { db } from "./db.js";
import { type Project, isLinkedWorktree } from "./context.js";
import { awaitingFirstPrompt } from "./firstPrompt.js";
import { heldReasonLabel } from "./heldLabel.js";
import { harnessFor, paneClassifierFor } from "./harnesses.js";
import { NEEDS_HUMAN_TAG } from "./portfolio.js";
import { loadProjectYml } from "./projectYml.js";
import { parseTags } from "./result.js";
import { ACTIVE_TIMER_WHERE } from "./scheduler.js";
import { reportsAgentStateLog } from "./stateProvenance.js";
import { liveTargets, rowOwnership, type AliveSnapshot } from "./tmux.js";
import {
  SKILL_TOOL,
  lastComponent,
  readContextFill,
  readRecentToolCalls,
  type ContextFill,
  type TranscriptToolCall,
} from "./transcript.js";

export interface CrewActivity {
  label: string;
  since: string | null;
  lower_bound: boolean;
}

export interface CrewWorker {
  id: number;
  name: string;
  model: string | null;
  harness: string;
  state: string;
  created_at: string;
  state_changed_at: string | null;
  session_id: string;
  age_seconds: number;
  activity: CrewActivity;
  context_fill: ContextFill | null;
  your_turn: boolean;
  commits_ahead: number | null;
}

export interface CrewLane {
  todo: { id: number; slug: string; status: string } | null;
  pad?: string;
  worker: CrewWorker | null;
}

export interface CrewSnapshot {
  schema_version: 1;
  project: { id: number; name: string };
  read_at: string;
  lanes: CrewLane[];
  needs_you: { id: number; slug: string }[];
  wakes: {
    pending: number;
    next: { id: number; label: string; due_at: string | null; generated: boolean; held: string | null } | null;
    watching: { id: number; label: string; kind: string; scope: string; max_wait_at: string | null }[];
    watched_worker_ids: number[];
  };
  context_checkpoint_percent: number | null;
}

export function crewStoreProblem(database: Database.Database = db): string | null {
  const tables = new Set(
    (database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(
      (r) => r.name,
    ),
  );
  for (const need of ["projects", "agents", "todos", "wakes"]) {
    if (!tables.has(need)) return `the store has no ${need} table`;
  }
  const columns = database.prepare("SELECT name FROM pragma_table_info('agents')").all() as { name: string }[];
  if (!columns.some((c) => c.name === "todo_id")) return "the store predates the worker-to-todo link (agents.todo_id)";
  return null;
}

function isoUtc(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(/(Z|[+-]\d\d:?\d\d)$/.test(value) ? value : `${value.replace(" ", "T")}Z`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

const WAKE_LABEL_MAX = 60;

function wakeLabel(body: string): string {
  const line = body.split("\n").map((l) => l.trim()).find((l) => l !== "") ?? "";
  return line.slice(0, WAKE_LABEL_MAX);
}

interface WakeRow {
  id: number;
  body: string;
  kind: string;
  watch_scope: string | null;
  max_wait_at: string | null;
  held_at: string | null;
  held_reason: string | null;
  parent_wake_id: number | null;
  watch: string;
  deliver_actor: string;
  due: string | null;
}

// Worker ids named by pending one-shot idle wakes that report to the lead; notices (parent set) watch nothing.
function oneShotWatched(pending: WakeRow[]): number[] {
  return pending
    .filter((w) => w.kind !== "delay" && w.parent_wake_id === null && w.deliver_actor.startsWith("lead:"))
    .flatMap((w) => {
      try {
        const ids: unknown = JSON.parse(w.watch);
        return Array.isArray(ids) ? ids.filter((x): x is number => typeof x === "number") : [];
      } catch {
        return [];
      }
    });
}

function stripped(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const { GIT_DIR: _gitDir, GIT_COMMON_DIR: _gitCommonDir, GIT_WORK_TREE: _gitWorkTree, ...rest } = env;
  return rest;
}

function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
      env: stripped(process.env),
    }).trim();
  } catch {
    return null;
  }
}

export function readCommitsAhead(cwd: string, projectRoot: string): number | null {
  if (!cwd || cwd === projectRoot || !isLinkedWorktree(cwd)) return null;
  const candidates: string[] = [];
  const remoteHead = git(cwd, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]);
  if (remoteHead) candidates.push(remoteHead);
  candidates.push("refs/heads/main", "refs/heads/master");
  for (const ref of candidates) {
    if (git(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]) === null) continue;
    const count = git(cwd, ["rev-list", "--count", `${ref}..HEAD`]);
    return count !== null && /^\d+$/.test(count) ? Number(count) : null;
  }
  return null;
}

type Vars = Record<string, string>;

export function reviewSkillsOf(vars: Vars): string[] {
  const value = vars.review_skills;
  return typeof value === "string" ? value.split(",").map((name) => name.trim()).filter((name) => name !== "") : [];
}

function heredocDelimiter(command: string, at: number): { delimiter: string; stripTabs: boolean; end: number } | null {
  let i = at + 2;
  if (command[i] === "<") return null;
  const stripTabs = command[i] === "-";
  if (stripTabs) i++;
  while (command[i] === " " || command[i] === "\t") i++;
  const quote = command[i] === "'" || command[i] === '"' ? command[i] : "";
  if (quote) i++;
  const start = i;
  while (i < command.length && (quote ? command[i] !== quote : /[\w.-]/.test(command[i]))) i++;
  if (i === start) return null;
  return { delimiter: command.slice(start, i), stripTabs, end: quote ? i + 1 : i };
}

function skipHeredocBody(command: string, from: number, heredoc: { delimiter: string; stripTabs: boolean }): number {
  let i = from;
  while (i < command.length) {
    const eol = command.indexOf("\n", i);
    const line = command.slice(i, eol === -1 ? command.length : eol);
    i = eol === -1 ? command.length : eol + 1;
    if ((heredoc.stripTabs ? line.replace(/^\t+/, "") : line) === heredoc.delimiter) break;
  }
  return i;
}

function splitSegments(command: string): string[] {
  const segments: string[] = [];
  const pending: { delimiter: string; stripTabs: boolean }[] = [];
  let current = "";
  let quote: string | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      current += ch;
      if (ch === "\\" && quote === '"' && i + 1 < command.length) current += command[++i];
      else if (ch === quote) quote = null;
    } else if (ch === "\\" && i + 1 < command.length) {
      current += ch + command[++i];
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
    } else if (ch === "<" && command[i + 1] === "<") {
      const heredoc = heredocDelimiter(command, i);
      if (heredoc) {
        pending.push(heredoc);
        current += command.slice(i, heredoc.end);
        i = heredoc.end - 1;
      } else {
        current += ch;
      }
    } else if (ch === ";" || ch === "\n" || (ch === "&" && command[i + 1] === "&")) {
      if (ch === "&") i++;
      segments.push(current);
      current = "";
      if (ch === "\n") {
        for (const heredoc of pending.splice(0)) i = skipHeredocBody(command, i + 1, heredoc) - 1;
      }
    } else {
      current += ch;
    }
  }
  segments.push(current);
  return segments;
}

function writesToFile(segment: string): boolean {
  let quote: string | null = null;
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (quote) {
      if (ch === "\\" && quote === '"') i++;
      else if (ch === quote) quote = null;
    } else if (ch === "\\") {
      i++;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (ch === ">") {
      let j = i + 1;
      if (segment[j] === ">") j++;
      if (segment[j] === "&") continue;
      while (segment[j] === " " || segment[j] === "\t") j++;
      const target = /^\S*/.exec(segment.slice(j))?.[0] ?? "";
      if (target !== "/dev/null") return true;
      i = j + target.length - 1;
    }
  }
  return false;
}

function tokenize(segment: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let open = false;
  let quote: string | null = null;
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === "\\" && quote === '"' && i + 1 < segment.length) current += segment[++i];
      else current += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      open = true;
    } else if (ch === "\\" && i + 1 < segment.length) {
      current += segment[++i];
      open = true;
    } else if (/\s/.test(ch)) {
      if (open) tokens.push(current);
      current = "";
      open = false;
    } else {
      current += ch;
      open = true;
    }
  }
  if (open) tokens.push(current);
  return tokens;
}

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

interface Segment {
  tokens: string[];
  writes: boolean;
}

function toSegment(segment: string): Segment {
  const tokens = tokenize(segment);
  let start = 0;
  while (start < tokens.length && ENV_ASSIGNMENT.test(tokens[start])) start++;
  const rest = tokens.slice(start);
  return { tokens: rest[0] === "cd" ? [] : rest, writes: writesToFile(segment) };
}

function segmentsOf(command: string): Segment[] {
  return splitSegments(command).map(toSegment).filter((s) => s.tokens.length > 0);
}

const basename = (token: string): string => token.split("/").pop() ?? token;

interface Matcher {
  label: string;
  tokens: RegExp[];
}

const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function matcherFor(label: string, tokens: string[], wildcard: boolean): Matcher {
  const pattern = (token: string): string =>
    wildcard ? token.split("<file>").map(escapeRegex).join(".+") : escapeRegex(token);
  return { label, tokens: tokens.map((t) => new RegExp(`^${pattern(t)}$`)) };
}

function configuredMatchers(vars: Vars): Matcher[] {
  const matchers: Matcher[] = [];
  const add = (key: string, label: string, onlyLast: boolean) => {
    const value = vars[key];
    if (typeof value !== "string" || value.trim() === "") return;
    const segments = segmentsOf(value);
    for (const { tokens } of onlyLast ? segments.slice(-1) : segments) matchers.push(matcherFor(label, tokens, key === "test_one"));
  };
  add("test_one", "testing", true);
  add("test_all", "testing full suite", true);
  add("check", "building", false);
  add("install", "installing", false);
  return matchers.sort((a, b) => b.tokens.length - a.tokens.length);
}

function matchesPrefix(tokens: string[], matcher: Matcher): boolean {
  return tokens.length >= matcher.tokens.length && matcher.tokens.every((re, i) => re.test(tokens[i]));
}

const READING_EXES = new Set(["rg", "grep", "cat", "head", "tail", "sed"]);
const FALLBACK_SKIP = new Set(["printf", "echo", "true", ":"]);
const NODE_RUNNERS = new Set(["npm", "pnpm", "yarn"]);
const TEST_BINARIES = new Set(["pest", "phpunit", "vitest", "jest"]);
const BUILD_BINARIES = new Set(["pint", "phpstan"]);

function unwrap(tokens: string[]): string[] {
  if (tokens[0] === "npx") {
    let i = 1;
    while (i < tokens.length && tokens[i].startsWith("-")) i++;
    return tokens.slice(i);
  }
  if ((tokens[0] === "pnpm" || tokens[0] === "yarn") && tokens[1] === "exec") return tokens.slice(2);
  if (tokens[0] === "php" && tokens[1] && (TEST_BINARIES.has(basename(tokens[1])) || BUILD_BINARIES.has(basename(tokens[1])))) {
    return tokens.slice(1);
  }
  return tokens;
}

function genericLabel(tokens: string[]): string | null {
  const exe = basename(tokens[0]);
  const [, a, b] = tokens;
  if (exe === "git") {
    if (a === "status" || a === "diff" || a === "log" || a === "show") return "reading";
    return a === "commit" ? "committing" : null;
  }
  if (READING_EXES.has(exe)) return exe === "sed" && tokens.some((t) => /^(-i|--in-place)/.test(t)) ? null : "reading";
  if (NODE_RUNNERS.has(exe)) {
    if (a === "test" || (a === "run" && b === "test")) return "testing";
    if (a === "run" && (b === "check" || b === "build")) return "building";
    return a === "install" || a === "ci" ? "installing" : null;
  }
  if (exe === "task") {
    if (a === "test" || a?.startsWith("test:")) return "testing";
    return a === "check" || a === "build" ? "building" : null;
  }
  if (exe === "php" && a === "artisan" && b === "test") return "testing";
  if (exe === "node" && tokens.slice(1).includes("--test")) return "testing";
  if (TEST_BINARIES.has(exe)) return "testing";
  if (BUILD_BINARIES.has(exe)) return "building";
  if (exe === "composer") {
    if (a === "check") return "building";
    return a === "install" || a === "update" ? "installing" : null;
  }
  return null;
}

function segmentLabel({ tokens, writes }: Segment, matchers: Matcher[]): string | null {
  for (const matcher of matchers) if (matchesPrefix(tokens, matcher)) return matcher.label;
  const direct = genericLabel(tokens);
  if (direct) return direct === "reading" && writes ? "editing" : direct;
  const unwrapped = unwrap(tokens);
  return unwrapped !== tokens && unwrapped.length > 0 ? genericLabel(unwrapped) : null;
}

function commandLabel(command: string, matchers: Matcher[]): string {
  const segments = segmentsOf(command);
  let recognized: string | null = null;
  for (const segment of segments) recognized = segmentLabel(segment, matchers) ?? recognized;
  if (recognized) return recognized;
  const fallback = segments.find((segment) => !FALLBACK_SKIP.has(basename(segment.tokens[0]))) ?? segments[0];
  return fallback ? `running ${basename(fallback.tokens[0])}` : "running shell";
}

const READ_TOOLS = new Set(["Read", "Glob", "Grep", "read_file", "view_image"]);
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "apply_patch"]);

function callLabel(call: TranscriptToolCall, matchers: Matcher[], reviewSkills: string[]): string {
  const { name, input } = call;
  if (READ_TOOLS.has(name)) return "reading";
  if (EDIT_TOOLS.has(name)) return "editing";
  if (name === SKILL_TOOL) return typeof input.skill === "string" && reviewSkills.includes(input.skill) ? "reviewing" : `running ${SKILL_TOOL}`;
  if ((name === "Agent" || name === "Task") && typeof input.subagent_type === "string" && /review/i.test(input.subagent_type)) {
    return "reviewing";
  }
  if (name === "Bash") return typeof input.command === "string" ? commandLabel(input.command, matchers) : "running shell";
  if (/_(get|read|list)$/.test(name)) return "reading";
  return `running ${lastComponent(name)}`;
}

export function classifyActivity(calls: TranscriptToolCall[], vars: Vars): CrewActivity {
  if (calls.length === 0) return { label: "", since: null, lower_bound: false };
  const matchers = configuredMatchers(vars);
  const reviewSkills = reviewSkillsOf(vars);
  const labels: string[] = [];
  let reviewing = false;
  for (const call of calls) {
    let label = callLabel(call, matchers, reviewSkills);
    if (label === "reviewing") reviewing = true;
    else if (label === "reading" && reviewing) label = "reviewing";
    else reviewing = false;
    labels.push(label);
  }
  const label = labels[labels.length - 1];
  let start = labels.length - 1;
  while (start > 0 && labels[start - 1] === label) start--;
  return { label, since: isoUtc(calls[start].at) ?? null, lower_bound: start === 0 };
}

interface AgentRowForCrew {
  id: number;
  actor_id: string;
  name: string;
  command: string;
  cwd: string;
  tmux_target: string;
  tmux_socket: string;
  pane_pid: string;
  model: string | null;
  created_at: string;
  state_changed_at: string | null;
  agent_state: string;
  session_id: string;
  transcript_path: string;
  resumed_at: string;
  todo_id: number | null;
}

export function collectCrew(project: Project, now: Date): CrewSnapshot {
  const { config } = loadProjectYml(project.path);
  const vars = config?.vars ?? {};
  const rows = db
    .prepare(
      `SELECT id, actor_id, name, command, cwd, tmux_target, tmux_socket, pane_pid, model, created_at,
              state_changed_at, agent_state, session_id, transcript_path, resumed_at, todo_id
       FROM agents WHERE project_id = ? AND status = 'running' AND kind = 'agent' ORDER BY id`,
    )
    .all(project.id) as AgentRowForCrew[];
  const todoStmt = db.prepare(
    "SELECT id, slug, status FROM todos WHERE id = ? AND project_id = ? AND archived_at IS NULL",
  );
  const inferredTodoStmt = db.prepare(
    `SELECT t.id, t.slug, t.status FROM todo_comments c
       JOIN todos t ON t.id = c.todo_id
      WHERE c.author = ? AND t.project_id = ? AND t.archived_at IS NULL
      GROUP BY t.id
      ORDER BY (t.status = 'in_progress') DESC, MAX(c.created_at) DESC, t.id DESC
      LIMIT 1`,
  );
  const inferredPadStmt = db.prepare(
    "SELECT name FROM pads WHERE project_id = ? AND updated_by = ? AND archived = 0 ORDER BY updated_at DESC, id DESC LIMIT 1",
  );

  let snapshot: AliveSnapshot | null | undefined;
  const commitsByCwd = new Map<string, number | null>();
  const staffed = new Set<number>();
  const lanes: CrewLane[] = [];

  for (const row of rows) {
    const todo = row.todo_id === null
      ? (inferredTodoStmt.get(row.actor_id, project.id) as { id: number; slug: string; status: string } | undefined) ?? null
      : (todoStmt.get(row.todo_id, project.id) as { id: number; slug: string; status: string } | undefined) ?? null;
    const pad = row.todo_id === null && !todo
      ? (inferredPadStmt.get(project.id, row.actor_id) as { name: string } | undefined)?.name
      : undefined;
    if (todo) staffed.add(todo.id);

    const harness = harnessFor(row.command);
    const kind = harness.contextRecord;
    const worker = { actor_id: row.actor_id, cwd: row.cwd, session_id: row.session_id, transcript_path: row.transcript_path };
    const calls = kind ? readRecentToolCalls(kind, worker, { reviewSkills: reviewSkillsOf(vars) }).calls : [];
    let state = row.agent_state;
    let activity = classifyActivity(calls, vars);
    if (activity.label === "") activity = { label: state, since: null, lower_bound: false };

    if (row.agent_state === "waiting") {
      if (snapshot === undefined) snapshot = liveTargets();
      const owned = rowOwnership(row, snapshot) === "live";
      if (owned && reportsAgentStateLog({ kind: "agent", command: row.command }) && paneClassifierFor(row.command)?.choiceCheck(row.tmux_target).awaitingChoice === true) {
        state = "blocked";
        activity = { label: "blocked", since: null, lower_bound: false };
      }
    }

    if (!commitsByCwd.has(row.cwd)) commitsByCwd.set(row.cwd, readCommitsAhead(row.cwd, project.path));
    lanes.push({
      todo,
      ...(pad ? { pad } : {}),
      worker: {
        id: row.id,
        name: row.name,
        model: row.model,
        harness: harness.name,
        state,
        created_at: isoUtc(row.created_at) ?? row.created_at,
        state_changed_at: isoUtc(row.state_changed_at),
        session_id: row.session_id,
        age_seconds: Math.max(0, Math.floor((now.getTime() - Date.parse(isoUtc(row.created_at) ?? "")) / 1000) || 0),
        activity,
        context_fill: kind ? readContextFill(kind, worker) : null,
        your_turn: row.agent_state === "idle" && !awaitingFirstPrompt(row),
        commits_ahead: commitsByCwd.get(row.cwd) ?? null,
      },
    });
  }

  const unstaffed = db
    .prepare(
      "SELECT id, slug, status FROM todos WHERE project_id = ? AND status = 'in_progress' AND archived_at IS NULL ORDER BY id",
    )
    .all(project.id) as { id: number; slug: string; status: string }[];
  for (const todo of unstaffed) if (!staffed.has(todo.id)) lanes.push({ todo, worker: null });

  const needsYou = (
    db
      .prepare(
        "SELECT id, slug, tags FROM todos WHERE project_id = ? AND status != 'completed' AND archived_at IS NULL ORDER BY id",
      )
      .all(project.id) as { id: number; slug: string; tags: string }[]
  )
    .filter((t) => parseTags(t.tags).includes(NEEDS_HUMAN_TAG))
    .map((t) => ({ id: t.id, slug: t.slug }));

  const wakeRows = db
    .prepare(
      `SELECT id, body, kind, watch_scope, max_wait_at, held_at, held_reason, parent_wake_id,
              watch, deliver_actor, COALESCE(due_at, max_wait_at) AS due FROM wakes
       WHERE project_id = ? AND ${ACTIVE_TIMER_WHERE}
       ORDER BY due IS NULL, due, id`,
    )
    .all(project.id) as WakeRow[];
  const standing = wakeRows.filter((w) => w.watch_scope);
  const pending = wakeRows.filter((w) => !w.watch_scope);

  return {
    schema_version: 1,
    project: { id: project.id, name: project.name },
    read_at: now.toISOString(),
    lanes,
    needs_you: needsYou,
    wakes: {
      pending: pending.length,
      next: pending[0]
        ? {
            id: pending[0].id,
            label: wakeLabel(pending[0].body),
            due_at: isoUtc(pending[0].due),
            generated: pending[0].parent_wake_id !== null,
            held: pending[0].held_at ? heldReasonLabel(pending[0].held_reason) : null,
          }
        : null,
      watched_worker_ids: [...new Set(oneShotWatched(pending))].sort((a, b) => a - b),
      watching: standing.map((w) => ({
        id: w.id,
        label: wakeLabel(w.body),
        kind: w.kind,
        scope: w.watch_scope ?? "",
        max_wait_at: isoUtc(w.max_wait_at),
      })),
    },
    context_checkpoint_percent: config?.context_checkpoint_percent ?? null,
  };
}
