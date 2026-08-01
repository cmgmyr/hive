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

// True when `path` names `root` itself, or a directory nested under it.
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

// For a git checkout, the project is the repo root. For a linked worktree,
// --git-common-dir points into the PRIMARY checkout, so worktree sessions
// resolve to the same project as the main repo.
function gitPrimaryRoot(dir: string): string | null {
  try {
    const commonDir = execFileSync("git", ["rev-parse", "--git-common-dir"], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      // A cwd on a stalled network mount blocks `git` in the kernel, and a
      // PATH-provided git shim can hang outright; on main this path never ran
      // at all when a directly registered project matched. Both are now live
      // failure modes for callers that are not once-per-process (hive
      // statusline, the SessionStart hook), so this cannot be unbounded.
      timeout: 2000,
    }).trim();
    const resolvedCommonDir = resolve(dir, commonDir);
    // A genuine primary checkout's common dir is always exactly
    // `<root>/.git` - basename ".git", nothing else. `endsWith(".git")`
    // wrongly admitted two other real layouts whose common dir also happens
    // to end in those four letters but names something that is NOT a
    // checkout's own .git: `git init --separate-git-dir=X` points at an
    // arbitrary path like `repository.git`, and a bare repo's common dir IS
    // the bare repo itself, e.g. `proj.git`. Neither is a linked worktree,
    // and dirname()-ing either lands on a directory that contains neither a
    // working tree nor the checkout this function is meant to find - so
    // reject them by requiring the exact basename instead of a suffix.
    if (basename(resolvedCommonDir) !== ".git") return null;
    return realpathSync(dirname(resolvedCommonDir));
  } catch {
    return null;
  }
}

// The one resolution rule: a directory belongs to the project whose root is
// its LONGEST registered prefix, unless its git primary root names a project
// that is strictly more specific than that prefix match (equal to it, or
// nested under it) - the linked-worktree case, where --git-common-dir points
// OUTSIDE the worktree's own ancestry into the primary checkout. When that
// happens the git-root project wins; otherwise the prefix match stands, even
// when it is null.
//
// Plain "prefer the longer path" is wrong here: comparing two projects' path
// lengths only means something when they sit on the same chain. For a linked
// worktree of repo Y sitting inside an unrelated registered project X,
// length alone compares by character count, which is arbitrary. Containment
// (is git's path the direct match's path, or under it?) decides the
// cross-tree case deliberately instead of by accident.
//
// THIS WAS CLAIMED AS A NO-OP FOR EVERY ORDINARY CHECKOUT AND SUBDIRECTORY,
// AND THAT WAS FALSE: a `git init --separate-git-dir=X` checkout and a bare
// repo's linked worktree both produce a --git-common-dir that is NOT an
// ancestor of dir (it names X, or the bare repo itself), so gitPrimaryRoot
// used to resolve those to the wrong directory whenever a registered project
// happened to sit under it - a real regression from main, where `direct`
// always short-circuited first. The ancestry argument below was sound about
// its own premise (--git-common-dir ending in ".git" resolves to an
// ancestor); the premise was wrong, since a bare repo's or a separate git
// dir's common dir also ends in ".git" without being one.
//
// gitPrimaryRoot's basename check (exactly ".git", not merely ending in it)
// closes this: it now returns non-null ONLY for a genuine `<root>/.git`
// checkout layout, which is one of exactly two shapes - an ordinary
// checkout, where it resolves to an ANCESTOR of dir (verified: a
// subdirectory two levels into an ordinary checkout reports its
// grandparent's .git), or a linked worktree, where it resolves to the
// primary checkout, a sibling, NOT an ancestor (verified). A separate-git-dir
// checkout or a bare repo's worktree now gets null instead (verified against
// real repos of all four shapes), and null can never outrank `direct`.
//
// So the NO-OP claim is true again, restated correctly: for the two shapes
// where gitPrimaryRoot resolves at all, it is either an ancestor of dir
// (ordinary checkout - direct, already the longest registered prefix, can
// never be less specific) or the one deliberate exception (linked worktree).
// For the two shapes it now rejects, it returns null and cannot participate.
// The rule changes behaviour only for a genuine linked worktree.

// Whether some registered project could possibly outrank `directPath`.
// gitPrimaryRoot can only change detectFromDir's answer by naming a project
// that is STRICTLY more specific than `direct` (equal doesn't change the
// outcome, it names the same project). If no registered project's path is
// strictly under directPath, no git-root match could ever qualify, so
// forking git to find out is pure cost with no way to change the result.
function hasStricterMatch(projects: Project[], directPath: string): boolean {
  return projects.some((p) => p.path !== directPath && isSameOrUnder(p.path, directPath));
}

function detectFromDir(dir: string): Project | null {
  // One fetch, shared by both prefix scans below - detectFromDir used to
  // query listProjects() at most once per invocation (it returned as soon as
  // the direct match hit), so querying twice here would double a DB read
  // that was previously conditional.
  const projects = listProjects();
  const direct = bestPrefixMatch(projects, dir);
  // Skip the git fork outright when it cannot possibly change the answer.
  // findProjectForDir's callers are not once-per-process (hive statusline
  // re-runs it on every render, the SessionStart hook runs it once per
  // session, agent_spawn's cwd guard runs it per spawn), so a fork that used
  // to be conditional on `direct` missing must stay conditional now too.
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

// Non-registering lookup: resolves a directory to an already-registered
// project or null. Unlike effectiveProjectId, an unknown directory is never
// registered - callers on this path (agent_spawn's cwd guard, hive
// statusline) must never create a project row as a side effect of checking
// one.
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

function resolveHomeProject(): number {
  if (selectedId != null) return selectedId;
  const detected = detectFromCwd();
  if (detected != null) {
    selectedId = detected.id;
    return selectedId;
  }
  // Never fall back to an unrelated project: state must stay scoped to the
  // directory the session is working in. New projects register at the git
  // primary root when there is one, so worktrees and subdirectories share
  // the main checkout's project. This still agrees with detectFromDir's
  // rule above: reaching this line means detectFromCwd found neither a
  // direct prefix match NOR a registered project at the git root, so there
  // is nothing already registered to prefer over the git root - registering
  // there is the most specific project a first-time session can create.
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
