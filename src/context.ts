import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { userInfo } from "node:os";
import { basename, dirname, resolve, sep } from "node:path";
import { db } from "./db.js";

export interface Project {
  id: number;
  name: string;
  path: string;
  created_at: string;
}

let selectedId: number | null = null;
let cachedActorId: string | null = null;
let lastTouchMs = 0;
const TOUCH_INTERVAL_MS = 30_000;

export function currentActor(): string {
  if (cachedActorId) {
    // last_seen_at is advisory; avoid a write transaction on every tool call.
    if (Date.now() - lastTouchMs > TOUCH_INTERVAL_MS) {
      db.prepare("UPDATE actors SET last_seen_at = datetime('now') WHERE id = ?").run(cachedActorId);
      lastTouchMs = Date.now();
    }
    return cachedActorId;
  }
  const envId = process.env.HIVE_AGENT_ID;
  const id = envId ?? `user:${userInfo().username}`;
  const name = process.env.HIVE_AGENT_NAME ?? id;
  const kind = envId ? "agent" : "human";
  db.prepare(
    `INSERT INTO actors (id, name, kind, tmux_pane) VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       last_seen_at = datetime('now'),
       tmux_pane = COALESCE(excluded.tmux_pane, actors.tmux_pane)`,
  ).run(id, name, kind, process.env.TMUX_PANE ?? null);
  cachedActorId = id;
  lastTouchMs = Date.now();
  return id;
}

export function listProjects(): Project[] {
  return db.prepare("SELECT * FROM projects ORDER BY id").all() as Project[];
}

export function getProject(id: number): Project | undefined {
  return db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as Project | undefined;
}

export function addProject(path?: string, name?: string): Project {
  let resolved: string;
  try {
    resolved = realpathSync(path ?? process.cwd());
  } catch {
    throw new Error(`Path does not exist: ${path}`);
  }
  const existing = db.prepare("SELECT * FROM projects WHERE path = ?").get(resolved) as
    | Project
    | undefined;
  if (existing) return existing;
  const info = db
    .prepare("INSERT INTO projects (name, path) VALUES (?, ?)")
    .run(name ?? basename(resolved), resolved);
  return getProject(Number(info.lastInsertRowid))!;
}

// The single gate for reaching a project by id: it must exist, and a locked
// session may only touch its home project.
function assertAccessible(id: number): Project {
  const project = getProject(id);
  if (!project) throw new Error(`Unknown project_id ${id}. Call project_list to see options.`);
  if (projectLock && id !== resolveHomeProject()) {
    throw new Error(
      `This session is locked to project ${resolveHomeProject()} (HIVE_PROJECT_LOCK=1). Cross-project access is disabled.`,
    );
  }
  return project;
}

export function selectProjectById(id: number): Project {
  const project = assertAccessible(id);
  selectedId = id;
  return project;
}

function matchRegistered(dir: string): number | null {
  let best: Project | null = null;
  for (const p of listProjects()) {
    if (dir === p.path || dir.startsWith(p.path + sep)) {
      if (!best || p.path.length > best.path.length) best = p;
    }
  }
  return best?.id ?? null;
}

// For a git checkout, the project is the repo root. For a linked worktree,
// --git-common-dir points into the PRIMARY checkout, so worktree sessions
// resolve to the same project as the main repo.
function gitPrimaryRoot(dir: string): string | null {
  try {
    const commonDir = execFileSync("git", ["rev-parse", "--git-common-dir"], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!commonDir.endsWith(".git")) return null;
    return realpathSync(dirname(resolve(dir, commonDir)));
  } catch {
    return null;
  }
}

function detectFromCwd(): number | null {
  let cwd: string;
  try {
    cwd = realpathSync(process.cwd());
  } catch {
    return null;
  }
  const direct = matchRegistered(cwd);
  if (direct != null) return direct;
  const root = gitPrimaryRoot(cwd);
  return root ? matchRegistered(root) : null;
}

const projectLock = process.env.HIVE_PROJECT_LOCK === "1";

function resolveHomeProject(): number {
  if (selectedId != null) return selectedId;
  const detected = detectFromCwd();
  if (detected != null) {
    selectedId = detected;
    return detected;
  }
  // Never fall back to an unrelated project: state must stay scoped to the
  // directory the session is working in. New projects register at the git
  // primary root when there is one, so worktrees and subdirectories share
  // the main checkout's project.
  selectedId = addProject(gitPrimaryRoot(process.cwd()) ?? process.cwd()).id;
  return selectedId;
}

export function effectiveProjectId(override?: number): number {
  if (override != null) {
    assertAccessible(override);
    return override;
  }
  return resolveHomeProject();
}

export function resolveProject(override?: number): Project {
  return getProject(effectiveProjectId(override))!;
}

export function trySelectedProject(): Project | null {
  try {
    return getProject(effectiveProjectId()) ?? null;
  } catch {
    return null;
  }
}
