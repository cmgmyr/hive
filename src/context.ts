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

let pendingRegistrationNotice: Project | null = null;

export function takeRegistrationNotice(): Project | null {
  const notice = pendingRegistrationNotice;
  pendingRegistrationNotice = null;
  return notice;
}

export const TOUCH_INTERVAL_MS = 30_000;

export function currentActor(): string {
  if (cachedActorId) {

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
  const existing = db.prepare("SELECT * FROM projects WHERE path = ?").get(resolved) as Project | undefined;
  if (existing) return existing;
  db.prepare("INSERT INTO projects (name, path) VALUES (?, ?) ON CONFLICT(path) DO NOTHING").run(
    name ?? basename(resolved),
    resolved,
  );
  return db.prepare("SELECT * FROM projects WHERE path = ?").get(resolved) as Project;
}

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

function isSameOrUnder(path: string, root: string): boolean {
  return path === root || path.startsWith(root + sep);
}

function bestPrefixMatch(projects: Project[], dir: string): Project | null {
  let best: Project | null = null;
  for (const p of projects) {
    if (isSameOrUnder(dir, p.path)) {
      if (!best || p.path.length > best.path.length) best = p;
    }
  }
  return best;
}

export function gitPrimaryRoot(dir: string): string | null {
  try {
    const commonDir = execFileSync("git", ["rev-parse", "--git-common-dir"], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],

      timeout: 2000,
    }).trim();
    const resolvedCommonDir = resolve(dir, commonDir);

    if (basename(resolvedCommonDir) !== ".git") return null;
    return realpathSync(dirname(resolvedCommonDir));
  } catch {
    return null;
  }
}

function gitDirs(dir: string): { gitDir: string; commonDir: string } | null {
  try {

    const { GIT_DIR: _gitDir, GIT_COMMON_DIR: _gitCommonDir, GIT_WORK_TREE: _gitWorkTree, ...env } = process.env;
    const out = execFileSync("git", ["rev-parse", "--git-dir", "--git-common-dir"], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
      env,
    })
      .trim()
      .split("\n");
    if (out.length !== 2) return null;
    return {
      gitDir: realpathSync(resolve(dir, out[0])),
      commonDir: realpathSync(resolve(dir, out[1])),
    };
  } catch {
    return null;
  }
}

export function isLinkedWorktree(dir: string): boolean {
  return linkedWorktreePrimaryRoot(dir) !== null;
}

export function linkedWorktreePrimaryRoot(dir: string): string | null {
  const dirs = gitDirs(dir);
  if (dirs === null || dirs.gitDir === dirs.commonDir) return null;
  return dirname(dirs.commonDir);
}

function hasStricterMatch(projects: Project[], directPath: string): boolean {
  return projects.some((p) => p.path !== directPath && isSameOrUnder(p.path, directPath));
}

function detectFromDir(dir: string): Project | null {

  const projects = listProjects();
  const direct = bestPrefixMatch(projects, dir);

  if (direct && !hasStricterMatch(projects, direct.path)) {
    return direct;
  }
  const root = gitPrimaryRoot(dir);
  const git = root ? bestPrefixMatch(projects, root) : null;
  if (git && (!direct || isSameOrUnder(git.path, direct.path))) {
    return git;
  }
  return direct;
}

function detectFromCwd(): Project | null {
  return findProjectForDir(process.cwd());
}

export function findProjectForDir(dir: string): Project | null {
  let resolved: string;
  try {
    resolved = realpathSync(dir);
  } catch {
    return null;
  }
  return detectFromDir(resolved);
}

export function findProjectForCwd(): Project | null {
  return findProjectForDir(process.cwd());
}

const projectLock = process.env.HIVE_PROJECT_LOCK === "1";

let pinFailure: Error | null = null;

function projectPathGuard(id: number): number {
  const expected = process.env.HIVE_PROJECT_PATH?.trim();
  if (!expected) return id;

  const project = getProject(id)!;
  let resolvedExpected: string;
  try {
    resolvedExpected = realpathSync(expected);
  } catch {
    resolvedExpected = expected;
  }
  if (resolvedExpected !== project.path) {
    pinFailure = new Error(
      `This worker's project pin (agents row -> project ${id} at "${project.path}") disagrees with its spawn path HIVE_PROJECT_PATH="${expected}". The store may have been swapped underneath a live worker - restart it.`,
    );
    throw pinFailure;
  }
  return id;
}

export function agentProjectPin(): number | null {
  if (pinFailure) throw pinFailure;

  const actorId = process.env.HIVE_AGENT_ID;
  if (!actorId || process.env.HIVE_PROJECT_LOCK !== "1") return null;

  const row = db
    .prepare(
      "SELECT project_id, status FROM agents WHERE actor_id = ? ORDER BY (status = 'running') DESC, id DESC LIMIT 1",
    )
    .get(actorId) as { project_id: number; status: string } | undefined;
  if (!row) {

    pinFailure = new Error(
      `HIVE_AGENT_ID=${actorId} names no agents row. This worker's store does not know it - most likely a rebuilt store. Restarting in this pane will not help: HIVE_AGENT_ID and HIVE_PROJECT_LOCK are set in the pane's own environment and survive a restart. Run "unset HIVE_AGENT_ID HIVE_PROJECT_LOCK HIVE_PROJECT_PATH" first, or open a new pane.`,
    );
    throw pinFailure;
  }
  if (row.status === "closed") {

    const expectedPath = process.env.HIVE_PROJECT_PATH?.trim();
    if (!expectedPath) return null;
    const byCwd = findProjectForCwd();
    if (byCwd) return byCwd.id;
    const byPath = findProjectForDir(expectedPath);
    if (byPath) return byPath.id;
    pinFailure = new Error(
      `HIVE_AGENT_ID=${actorId}'s agents row is closed. Its cwd resolves to no project, and its spawn path HIVE_PROJECT_PATH="${expectedPath}" no longer resolves to one either. Unset HIVE_AGENT_ID HIVE_PROJECT_LOCK HIVE_PROJECT_PATH in this pane, or start a new one.`,
    );
    throw pinFailure;
  }
  return projectPathGuard(row.project_id);
}

function resolveHomeProject(): number {
  if (selectedId != null) return selectedId;
  const pinned = agentProjectPin();
  if (pinned != null) {
    selectedId = pinned;
    return selectedId;
  }
  const detected = detectFromCwd();
  if (detected != null) {
    selectedId = detected.id;
    return selectedId;
  }

  const created = addProject(gitPrimaryRoot(process.cwd()) ?? process.cwd());
  selectedId = created.id;
  pendingRegistrationNotice = created;
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
