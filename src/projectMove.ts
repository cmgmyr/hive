import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseToml } from "smol-toml";
import { agentProjectPin, assertQueenCrossProjectWrite, getProject, getProjectByPath, gitPrimaryRoot, listProjects, type Project } from "./context.js";
import { codexHomeDir } from "./codexHome.js";
import { db } from "./db.js";
import { claudeConfigDir } from "./claudeDir.js";
import { codexConfigPath, hiveRegistrations, codexHiveRegistrations } from "./mcpConfig.js";
import { dispatcherPath, readDispatcher } from "./dispatcher.js";

type MoveOptions = { projectId?: number; apply: boolean };
type FileChange = { path: string; before: string; after: string };
type WorktreePlan = { main: string; commonDir: string; linked: string[] };
type ClaudeDirectoryMap = { source: string; target: string; rename: boolean };
type MovePlan = {
  project: Project;
  oldRoot: string;
  newRoot: string;
  sameRoot: boolean;
  renameCheckout: boolean;
  claudeDirs: ClaudeDirectoryMap[];
  fileChanges: FileChange[];
  worktree: WorktreePlan | null;
  worktreeBackups: FileChange[];
  codexConfigFiles: string[];
  recovery: string;
};

const within = (path: string, root: string): boolean => path === root || path.startsWith(`${root}${sep}`);
function canonicalKey(path: string): string {
  const absolute = resolve(path);
  try { return realpathSync(absolute); } catch { return absolute; }
}
const pathIsPresent = (path: string): boolean => {
  try { lstatSync(path); return true; } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw error;
  }
};

function requireRegularFile(path: string, label: string): void {
  const stat = lstatSync(path);
  if (!stat.isFile()) throw new Error(`${label} is not a regular file: ${path}`);
}

function requireDirectory(path: string, label: string): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory()) throw new Error(`${label} is not a directory: ${path}`);
}

function canonicalExistingOrChild(path: string): string {
  const absolute = resolve(path);
  if (pathIsPresent(absolute)) return realpathSync(absolute);
  const parent = realpathSync(dirname(absolute));
  return join(parent, basename(absolute));
}

function mapPath(path: string, oldRoot: string, newRoot: string): string {
  if (path === oldRoot) return newRoot;
  if (path.startsWith(`${oldRoot}${sep}`)) return `${newRoot}${path.slice(oldRoot.length)}`;
  return path;
}

function claudeProjectKey(path: string): string {
  const cleaned = path.replace(/[^a-zA-Z0-9]/g, "-");
  if (cleaned.length <= 200) return cleaned;
  let hash = 0;
  for (let i = 0; i < path.length; i++) hash = (hash << 5) - hash + path.charCodeAt(i) | 0;
  return `${cleaned.slice(0, 200)}-${Math.abs(hash).toString(36)}`;
}

function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function recoveryText(newRoot: string, projectId: number): string {
  return `cd ${shellQuote(newRoot)} && hive project mv ${shellQuote(newRoot)} --project-id ${projectId} --apply`;
}

function fail(message: string, recovery?: string): never {
  throw new Error(recovery ? `${message}\nRecovery: ${recovery}` : message);
}

function parseArgs(argv: string[]): { target: string; options: MoveOptions } {
  let target: string | undefined;
  let projectId: number | undefined;
  let dryRun = false;
  let apply = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--apply") apply = true;
    else if (arg === "--project-id") {
      const value = argv[++i];
      if (!value || !/^\d+$/.test(value)) throw new Error("--project-id requires a positive integer.");
      projectId = Number(value);
      if (!Number.isSafeInteger(projectId) || projectId < 1) throw new Error("--project-id requires a positive integer.");
    } else if (arg.startsWith("-")) throw new Error(`Unknown project mv option: ${arg}`);
    else if (target === undefined) target = arg;
    else throw new Error("Usage: hive project mv <new-path> [--project-id <id>] [--dry-run | --apply]");
  }
  if (!target) throw new Error("Usage: hive project mv <new-path> [--project-id <id>] [--dry-run | --apply]");
  if (dryRun && apply) throw new Error("Use either --dry-run or --apply, not both.");
  return { target, options: { projectId, apply } };
}

function selectProject(projectId?: number): Project {
  if (process.env.HIVE_PROJECT_LOCK === "1" || process.env.HIVE_AGENT_ID || agentProjectPin() != null) {
    throw new Error("hive project mv is a human CLI command and cannot run from a locked worker session.");
  }
  if (projectId !== undefined) {
    const project = getProject(projectId);
    if (!project) throw new Error(`No registered project has id ${projectId}; no project was registered.`);
    assertQueenCrossProjectWrite("hive project mv", project.id, {});
    return project;
  }
  let cwd: string;
  try { cwd = realpathSync(process.cwd()); } catch { throw new Error("The current directory does not exist."); }
  const root = gitPrimaryRoot(cwd) ?? cwd;
  const project = getProjectByPath(root);
  if (!project) throw new Error(`No project is registered at the exact checkout path ${root}; pass --project-id after a hand move.`);
  assertQueenCrossProjectWrite("hive project mv", project.id, {});
  return project;
}

type JsonProperty = { key: string; keyStart: number; keyEnd: number; valueStart: number; valueEnd: number };

function jsonStringEnd(text: string, start: number): number {
  if (text[start] !== '"') throw new Error("Malformed JSON string token.");
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === "\\") { i++; continue; }
    if (text[i] === '"') return i + 1;
  }
  throw new Error("Unterminated JSON string.");
}

function skipJsonSpace(text: string, start: number): number {
  let i = start;
  while (/\s/.test(text[i] ?? "")) i++;
  return i;
}

function jsonValueEnd(text: string, start: number): number {
  const first = text[skipJsonSpace(text, start)];
  const i = skipJsonSpace(text, start);
  if (first === '"') return jsonStringEnd(text, i);
  if (first === "{" || first === "[") {
    const close = first === "{" ? "}" : "]";
    let cursor = i + 1;
    while (true) {
      cursor = skipJsonSpace(text, cursor);
      if (text[cursor] === close) return cursor + 1;
      if (first === "{" && text[cursor] === '"') {
        cursor = jsonStringEnd(text, cursor);
        cursor = skipJsonSpace(text, cursor);
        if (text[cursor] !== ":") throw new Error("Malformed JSON object.");
        cursor = jsonValueEnd(text, cursor + 1);
      } else if (first === "[") cursor = jsonValueEnd(text, cursor);
      else throw new Error("Malformed JSON collection.");
      cursor = skipJsonSpace(text, cursor);
      if (text[cursor] === ",") cursor++;
      else if (text[cursor] !== close) throw new Error("Malformed JSON collection delimiter.");
    }
  }
  let cursor = i;
  while (cursor < text.length && !/[\s,}\]]/.test(text[cursor])) cursor++;
  if (cursor === i) throw new Error("Malformed JSON value.");
  return cursor;
}

function jsonObjectProperties(text: string, objectStart: number): JsonProperty[] {
  if (text[objectStart] !== "{") throw new Error("Expected a JSON object.");
  const props: JsonProperty[] = [];
  let cursor = objectStart + 1;
  while (true) {
    cursor = skipJsonSpace(text, cursor);
    if (text[cursor] === "}") return props;
    const keyStart = cursor;
    const keyEnd = jsonStringEnd(text, keyStart);
    const key = JSON.parse(text.slice(keyStart, keyEnd)) as string;
    cursor = skipJsonSpace(text, keyEnd);
    if (text[cursor] !== ":") throw new Error("Malformed JSON object property.");
    const valueStart = skipJsonSpace(text, cursor + 1);
    const valueEnd = jsonValueEnd(text, valueStart);
    props.push({ key, keyStart, keyEnd, valueStart, valueEnd });
    cursor = skipJsonSpace(text, valueEnd);
    if (text[cursor] === ",") cursor++;
    else if (text[cursor] !== "}") throw new Error("Malformed JSON object delimiter.");
  }
}

function claudeConfigChanges(path: string, oldRoot: string, newRoot: string, checkoutAlreadyMoved: boolean): FileChange | null {
  if (!pathIsPresent(path)) return null;
  requireRegularFile(path, "Claude config");
  const before = readFileSync(path, "utf8");
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(before) as Record<string, unknown>; } catch { throw new Error(`Claude config is malformed JSON: ${path}`); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`Claude config root is not an object: ${path}`);
  const rootProps = jsonObjectProperties(before, skipJsonSpace(before, 0));
  const projectsProps = rootProps.filter((property) => property.key === "projects");
  if (projectsProps.length > 1) throw new Error(`Claude config has duplicate projects declarations: ${path}`);
  if (projectsProps.length === 0) return null;
  const projectsValue = parsed.projects;
  if (!projectsValue || typeof projectsValue !== "object" || Array.isArray(projectsValue)) throw new Error(`Claude config projects value is malformed: ${path}`);
  const lexicalProjects = jsonObjectProperties(before, projectsProps[0].valueStart);
  const seen = new Set<string>();
  const changes: Array<{ start: number; end: number; replacement: string }> = [];
  const mapped = new Map<string, string>();
  for (const property of lexicalProjects) {
    if (seen.has(property.key)) throw new Error(`Claude config has duplicate project key ${JSON.stringify(property.key)}: ${path}`);
    seen.add(property.key);
    const normalized = isAbsolute(property.key) ? canonicalKey(property.key) : property.key;
    if (!within(normalized, oldRoot)) continue;
    const target = mapPath(normalized, oldRoot, newRoot);
    const prior = mapped.get(target);
    if (prior && prior !== property.key) throw new Error(`Claude project keys map ambiguously to ${target}: ${path}`);
    mapped.set(target, property.key);
    changes.push({ start: property.keyStart, end: property.keyEnd, replacement: JSON.stringify(target) });
  }
  const moving = new Set(lexicalProjects.filter((property) => isAbsolute(property.key) && within(canonicalKey(property.key), oldRoot)).map((property) => property.key));
  if (changes.length === 0 && !checkoutAlreadyMoved) {
    const destinationKey = lexicalProjects.find((property) => isAbsolute(property.key) && within(canonicalKey(property.key), newRoot));
    if (destinationKey) throw new Error(`Claude project key already exists at the destination: ${destinationKey.key}`);
  }
  if (changes.length === 0) return null;
  for (const property of lexicalProjects) {
    if (!isAbsolute(property.key) || !within(canonicalKey(property.key), oldRoot)) continue;
    const target = mapPath(canonicalKey(property.key), oldRoot, newRoot);
    const collision = lexicalProjects.find((candidate) => !moving.has(candidate.key) && isAbsolute(candidate.key) && canonicalKey(candidate.key) === target);
    if (collision) throw new Error(`Claude project key collision at ${target}: ${path}`);
  }
  let after = before;
  for (const change of changes.sort((a, b) => b.start - a.start)) after = after.slice(0, change.start) + change.replacement + after.slice(change.end);
  JSON.parse(after);
  return { path, before, after };
}

function claudeStorageMoves(path: string, oldRoot: string, newRoot: string, checkoutAlreadyMoved: boolean): ClaudeDirectoryMap[] {
  const config = pathIsPresent(path) ? JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown> : {};
  const projects = config.projects;
  if (projects != null && (!projects || typeof projects !== "object" || Array.isArray(projects))) throw new Error(`Claude config projects value is malformed: ${path}`);
  const keys = projects ? Object.keys(projects as Record<string, unknown>) : [];
  const moving = keys.filter((key) => isAbsolute(key) && within(canonicalKey(key), oldRoot));
  const storageRoot = join(claudeConfigDir(), "projects");
  const moves = new Map<string, ClaudeDirectoryMap>();
  const sources = new Map<string, string>();
  const associatedKeys = new Set<string>();
  const mappings = new Map<string, { targetKey: string; hasSourceKey: boolean }>();
  for (const key of moving) {
    associatedKeys.add(key);
    mappings.set(canonicalKey(key), { targetKey: mapPath(canonicalKey(key), oldRoot, newRoot), hasSourceKey: true });
  }
  const exactStorage = canonicalKey(oldRoot);
  if (!mappings.has(exactStorage)) mappings.set(exactStorage, { targetKey: newRoot, hasSourceKey: false });
  for (const key of keys.filter((candidate) => isAbsolute(candidate) && within(canonicalKey(candidate), newRoot))) {
    associatedKeys.add(key);
    const newKey = canonicalKey(key);
    const oldKey = mapPath(newKey, newRoot, oldRoot);
    if (!mappings.has(oldKey)) mappings.set(oldKey, { targetKey: newKey, hasSourceKey: false });
  }
  for (const [sourceKey, mapping] of mappings) {
    const targetKey = mapping.targetKey;
    const source = join(storageRoot, claudeProjectKey(sourceKey));
    const target = join(storageRoot, claudeProjectKey(targetKey));
    const prior = sources.get(source);
    if (prior && prior !== sourceKey) throw new Error(`Claude storage ownership is ambiguous between ${prior} and ${sourceKey}: ${source}`);
    sources.set(source, sourceKey);
    if (source === target) { moves.set(source, { source, target, rename: false }); continue; }
    const collidingSource = keys.find((candidate) => !associatedKeys.has(candidate) && isAbsolute(candidate) && join(storageRoot, claudeProjectKey(canonicalKey(candidate))) === source);
    if (collidingSource) throw new Error(`Claude storage ownership is ambiguous between ${sourceKey} and ${collidingSource}: ${source}`);
    const collidingTarget = keys.find((candidate) => !associatedKeys.has(candidate) && isAbsolute(candidate) && join(storageRoot, claudeProjectKey(canonicalKey(candidate))) === target);
    if (collidingTarget) throw new Error(`Claude storage destination collides with ${collidingTarget}: ${target}`);
    const oldExists = pathIsPresent(source);
    const newExists = pathIsPresent(target);
    if (oldExists) requireDirectory(source, "Claude storage");
    if (newExists) requireDirectory(target, "Claude storage destination");
    if (oldExists && newExists) throw new Error(`Both Claude storage directories exist (${source}, ${target}); no merging was attempted.`);
    if (oldExists && !mapping.hasSourceKey) throw new Error(`Claude storage exists without a matching .claude.json project key; ownership is ambiguous: ${source}`);
    if (newExists && !mapping.hasSourceKey && !checkoutAlreadyMoved) throw new Error(`Claude storage exists at the destination without an observed completed move: ${target}`);
    moves.set(source, { source, target, rename: oldExists });
  }
  return [...moves.values()];
}

function tomlSectionKey(line: string): { key: string; start: number; end: number } | null {
  const match = /^(\s*\[\s*projects\s*\.\s*)("(?:\\.|[^"\\])*"|'[^']*')/.exec(line);
  if (!match) return null;
  if (!/^\s*(?:\.|\])/.test(line.slice(match[0].length))) return null;
  let key: string;
  try { key = (parseToml(`value = ${match[2]}`) as { value: string }).value; } catch { return null; }
  return { key, start: match[1].length, end: match[1].length + match[2].length };
}

function codexConfigChanges(path: string, oldRoot: string, newRoot: string, checkoutAlreadyMoved: boolean): FileChange | null {
  if (!pathIsPresent(path)) return null;
  requireRegularFile(path, "Codex config");
  const before = readFileSync(path, "utf8");
  let parsed: Record<string, unknown>;
  try { parsed = parseToml(before) as Record<string, unknown>; } catch { throw new Error(`Codex config is malformed TOML: ${path}`); }
  const projects = parsed.projects;
  if (projects == null) return null;
  if (typeof projects !== "object" || Array.isArray(projects)) throw new Error(`Codex projects config is malformed: ${path}`);
  const projectKeys = Object.keys(projects as Record<string, unknown>);
  const matching = projectKeys.filter((key) => isAbsolute(key) && within(canonicalKey(key), oldRoot));
  if (matching.length === 0) {
    if (!checkoutAlreadyMoved) {
      const destinationKey = projectKeys.find((key) => isAbsolute(key) && within(canonicalKey(key), newRoot));
      if (destinationKey) throw new Error(`Codex project key already exists at the destination: ${destinationKey}`);
    }
    return null;
  }
  const targets = new Set(matching.map((key) => mapPath(canonicalKey(key), oldRoot, newRoot)));
  if (targets.size !== matching.length) throw new Error(`Codex project keys map ambiguously in ${path}`);
  for (const target of targets) {
    if (projectKeys.some((key) => !matching.includes(key) && isAbsolute(key) && canonicalKey(key) === target)) throw new Error(`Codex project key collision at ${target}: ${path}`);
  }
  const editedKeys = new Set<string>();
  const edits: Array<{ start: number; end: number; text: string }> = [];
  let offset = 0;
  for (const line of before.split(/(?<=\n)/)) {
    const content = line.endsWith("\n") ? line.slice(0, -1) : line;
    const section = tomlSectionKey(content);
    if (section) {
      if (matching.includes(section.key)) {
        const target = mapPath(canonicalKey(section.key), oldRoot, newRoot);
        edits.push({ start: offset + section.start, end: offset + section.end, text: JSON.stringify(target) });
        editedKeys.add(section.key);
      }
    }
    offset += line.length;
  }
  if (editedKeys.size !== matching.length) throw new Error(`Codex project keys cannot be safely edited as bounded table headers: ${path}`);
  let after = before;
  for (const edit of edits.sort((a, b) => b.start - a.start)) after = after.slice(0, edit.start) + edit.text + after.slice(edit.end);
  parseToml(after);
  return { path, before, after };
}

function referencesOldRoot(value: string, oldRoot: string): boolean {
  return (isAbsolute(value) && within(canonicalKey(value), oldRoot)) || value.includes(oldRoot + sep) || value === oldRoot;
}

function jsonHasOldExecutableReference(value: unknown, oldRoot: string): boolean {
  if (typeof value === "string") return referencesOldRoot(value, oldRoot);
  if (Array.isArray(value)) return value.some((item) => jsonHasOldExecutableReference(item, oldRoot));
  if (value && typeof value === "object") return Object.values(value).some((item) => jsonHasOldExecutableReference(item, oldRoot));
  return false;
}

function assertClaudeProjectRegistrations(oldRoot: string): void {
  const configPath = join(resolve(process.env.CLAUDE_CONFIG_DIR || homedir()), ".claude.json");
  if (!pathIsPresent(configPath)) return;
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>; } catch { throw new Error(`Claude config is malformed JSON: ${configPath}`); }
  const projects = parsed.projects;
  if (projects == null) return;
  if (!projects || typeof projects !== "object" || Array.isArray(projects)) throw new Error(`Claude config projects value is malformed: ${configPath}`);
  for (const [projectPath, value] of Object.entries(projects as Record<string, unknown>)) {
    if (!isAbsolute(projectPath) || !within(canonicalKey(projectPath), oldRoot) || !value || typeof value !== "object" || Array.isArray(value)) continue;
    const servers = (value as Record<string, unknown>).mcpServers;
    if (!servers || typeof servers !== "object" || Array.isArray(servers)) continue;
    for (const [name, raw] of Object.entries(servers as Record<string, unknown>)) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const registration = raw as { command?: unknown; args?: unknown };
      const args = Array.isArray(registration.args) ? registration.args.filter((item): item is string => typeof item === "string") : [];
      if (name === "hive" && [registration.command, ...args].some((item) => typeof item === "string" && referencesOldRoot(item, oldRoot))) {
        throw new Error(`Claude MCP registration ${name} in ${configPath} for ${projectPath} points under the old project root.`);
      }
    }
  }
}

function assertNoStrandedRegistrations(project: Project, oldRoot: string, newRoot: string): void {
  const cliRoot = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
  if (project.path === cliRoot) throw new Error("hive refuses to move its own checkout; its shim, hooks and MCP executables would be stranded.");
  const dispatcher = readDispatcher(dispatcherPath());
  if (dispatcher?.mine && dispatcher.cli && isAbsolute(dispatcher.cli) && within(resolve(dispatcher.cli), oldRoot)) {
    throw new Error(`hive dispatcher ${dispatcher.file} points under the old project root (${dispatcher.cli}); repair it before moving.`);
  }
  for (const projectPath of new Set([oldRoot, newRoot])) {
    const registrations = hiveRegistrations(projectPath);
    const stranded = registrations.find((registration) => [registration.command, ...registration.args].some((value) => referencesOldRoot(value, oldRoot)));
    if (stranded) throw new Error(`Claude MCP registration ${stranded.name} in ${stranded.source} points under the old project root.`);
  }
  assertClaudeProjectRegistrations(oldRoot);
  const codexRegistrations = codexHiveRegistrations();
  const codexStranded = codexRegistrations.find((registration) => [registration.command, ...registration.args].some((value) => referencesOldRoot(value, oldRoot)));
  if (codexStranded) throw new Error(`Codex MCP registration ${codexStranded.name} in ${codexStranded.source} points under the old project root.`);
  const homes = db.prepare("SELECT DISTINCT codex_home FROM agents WHERE project_id = ? AND codex_home <> ''").all(project.id) as Array<{ codex_home: string }>;
  for (const file of homes.map((row) => join(codexHomeDir(row.codex_home), "config.toml"))) {
    if (!pathIsPresent(file)) continue;
    let parsed: Record<string, unknown>;
    try { parsed = parseToml(readFileSync(file, "utf8")) as Record<string, unknown>; } catch { throw new Error(`Codex config is malformed TOML: ${file}`); }
    const servers = parsed.mcp_servers;
    if (!servers || typeof servers !== "object" || Array.isArray(servers)) continue;
    for (const [name, raw] of Object.entries(servers as Record<string, unknown>)) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const registration = raw as { command?: unknown; args?: unknown };
      const args = Array.isArray(registration.args) ? registration.args.filter((value): value is string => typeof value === "string") : [];
      if (name === "hive" && [registration.command, ...args].some((value) => typeof value === "string" && referencesOldRoot(value, oldRoot))) {
        throw new Error(`Codex MCP registration ${name} in ${file} points under the old project root.`);
      }
    }
  }
  const hooks = [join(claudeConfigDir(), "settings.json"), join(claudeConfigDir(), "settings.local.json"), ...[oldRoot, newRoot].flatMap((root) => [join(root, ".claude", "settings.json"), join(root, ".claude", "settings.local.json")])];
  for (const file of hooks) {
    if (!pathIsPresent(file)) continue;
    let value: unknown;
    try { value = JSON.parse(readFileSync(file, "utf8")); } catch { throw new Error(`Claude settings are malformed JSON: ${file}`); }
    const settings = value as Record<string, unknown>;
    if (settings.hooks && jsonHasOldExecutableReference(settings.hooks, oldRoot)) throw new Error(`Claude hook registration in ${file} points under the old project root.`);
  }
}

function worktreeList(root: string): WorktreePlan | null {
  const common = gitPrimaryRoot(root);
  if (!common) {
    if (pathIsPresent(join(root, ".git"))) throw new Error(`Git metadata exists but cannot be read safely at ${root}; no paths were changed.`);
    try {
      const inside = execFileSync("git", ["-C", root, "rev-parse", "--is-inside-work-tree"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim() === "true";
      if (inside) throw new Error(`Git layout at ${root} is unsupported; no paths were changed.`);
    } catch (error) {
      if (error instanceof Error && error.message.includes("unsupported")) throw error;
    }
    return null;
  }
  const commonDir = realpathSync(join(common, ".git"));
  let output: string;
  try { output = execFileSync("git", ["-C", root, "worktree", "list", "--porcelain", "-z"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
  catch { throw new Error(`Git worktree layout cannot be read safely at ${root}.`); }
  const linked: string[] = [];
  for (const entry of output.split("\0")) {
    if (!entry.startsWith("worktree ")) continue;
    const path = entry.slice("worktree ".length);
    if (path !== root) linked.push(path);
  }
  let gitEntryIsDirectory = false;
  try { gitEntryIsDirectory = lstatSync(join(root, ".git")).isDirectory(); } catch {}
  if (!gitEntryIsDirectory || !existsSync(join(root, ".git", "objects")) || existsSync(join(root, ".git", "commondir"))) {
    throw new Error(`Git layout at ${root} is unsupported; no paths were changed.`);
  }
  return { main: root, commonDir, linked };
}

function gitBackupSnapshots(worktree: WorktreePlan, oldRoot: string, newRoot: string): FileChange[] {
  const snapshots = new Map<string, string>();
  const commonDir = mapPath(worktree.commonDir, oldRoot, newRoot);
  for (const linked of worktree.linked) {
    const mapped = mapPath(linked, oldRoot, newRoot);
    const probe = pathIsPresent(mapped) ? mapped : linked;
    const gitFileSource = join(probe, ".git");
    const gitFileTarget = join(mapped, ".git");
    if (!pathIsPresent(gitFileSource)) throw new Error(`Git worktree pointer is missing for ${linked}; no paths were changed.`);
    requireRegularFile(gitFileSource, "Git worktree pointer");
    snapshots.set(gitFileTarget, readFileSync(gitFileSource, "utf8"));
    const relativeGit = relativeUnderCommon(worktree.commonDir, probe);
    if (!relativeGit) throw new Error(`Git worktree metadata cannot be mapped for ${linked}; no paths were changed.`);
    for (const name of ["gitdir", "commondir"]) {
      const source = join(worktree.commonDir, "worktrees", relativeGit, name);
      const target = join(commonDir, "worktrees", relativeGit, name);
      const existing = pathIsPresent(source) ? source : target;
      if (!pathIsPresent(existing)) throw new Error(`Git worktree ${name} metadata is missing for ${linked}; no paths were changed.`);
      requireRegularFile(existing, "Git worktree metadata");
      snapshots.set(target, readFileSync(existing, "utf8"));
    }
  }
  return [...snapshots].map(([path, before]) => ({ path, before, after: before }));
}

function relativeUnderCommon(commonDir: string, linked: string): string | null {
  const adminRoot = join(commonDir, "worktrees");
  let output: string;
  try { output = execFileSync("git", ["-C", linked, "rev-parse", "--git-dir"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }
  catch { return null; }
  const admin = resolve(linked, output);
  if (!within(admin, adminRoot)) return null;
  return admin.slice(adminRoot.length + 1);
}

function codexConfigFiles(project: Project): string[] {
  const files = new Set<string>([codexConfigPath()]);
  const rows = db.prepare("SELECT DISTINCT codex_home FROM agents WHERE project_id = ? AND codex_home <> ''").all(project.id) as Array<{ codex_home: string }>;
  for (const row of rows) files.add(join(codexHomeDir(row.codex_home), "config.toml"));
  return [...files];
}

function planMove(project: Project, targetPath: string): MovePlan {
  const oldRoot = project.path;
  const newRoot = canonicalExistingOrChild(targetPath);
  const sameRoot = oldRoot === newRoot;
  if (!sameRoot && (within(oldRoot, newRoot) || within(newRoot, oldRoot))) throw new Error("Source and destination paths overlap; no changes were made.");
  const others = listProjects().filter((candidate) => candidate.id !== project.id);
  const sourceOverlap = others.find((candidate) => within(candidate.path, oldRoot) || within(oldRoot, candidate.path));
  if (sourceOverlap) throw new Error(`Source overlaps registered project ${sourceOverlap.id} at ${sourceOverlap.path}; no changes were made.`);
  const occupied = others.find((candidate) => within(candidate.path, newRoot) || within(newRoot, candidate.path));
  if (occupied) throw new Error(`Destination overlaps registered project ${occupied.id} at ${occupied.path}; no changes were made.`);
  const oldExists = pathIsPresent(oldRoot);
  const newExists = pathIsPresent(newRoot);
  if (!sameRoot && oldExists === newExists) throw new Error(oldExists ? "Both source and destination checkouts exist; no changes were made." : "Neither source nor destination checkout exists; no changes were made.");
  if (oldExists && !lstatSync(oldRoot).isDirectory()) throw new Error(`Source checkout is not a directory: ${oldRoot}`);
  if (newExists && !lstatSync(newRoot).isDirectory()) throw new Error(`Destination checkout is not a directory: ${newRoot}`);
  assertNoStrandedRegistrations(project, oldRoot, newRoot);
  const running = db.prepare("SELECT id, name, kind FROM agents WHERE project_id = ? AND status = 'running' ORDER BY id").all(project.id) as Array<{ id: number; name: string; kind: string }>;
  if (running.length) throw new Error(`Project ${project.id} has running hive agents: ${running.map((row) => `${row.name} (${row.kind}, ${row.id})`).join(", ")}; close every agent before applying a move.`);

  const worktreeRootPath = oldExists ? oldRoot : newRoot;
  const worktree = sameRoot ? null : worktreeList(worktreeRootPath);
  if (worktree && worktree.main !== oldRoot && worktree.main !== newRoot) throw new Error(`Git primary root ${worktree.main} does not match project root ${oldRoot}; no changes were made.`);

  const configFile = join(resolve(process.env.CLAUDE_CONFIG_DIR || homedir()), ".claude.json");
  const fileChanges: FileChange[] = [];
  const checkoutAlreadyMoved = !oldExists && newExists;
  const claudeConfig = claudeConfigChanges(configFile, oldRoot, newRoot, checkoutAlreadyMoved);
  if (claudeConfig) fileChanges.push(claudeConfig);
  const claudeDirs = sameRoot ? [] : claudeStorageMoves(configFile, oldRoot, newRoot, !oldExists && newExists);

  const configs = !sameRoot ? codexConfigFiles(project) : [];
  for (const file of configs) {
    const change = codexConfigChanges(file, oldRoot, newRoot, checkoutAlreadyMoved);
    if (change) fileChanges.push(change);
  }
  const worktreeBackups = worktree ? gitBackupSnapshots(worktree, oldRoot, newRoot) : [];
  return { project, oldRoot, newRoot, sameRoot, renameCheckout: oldExists && !sameRoot, claudeDirs, fileChanges, worktree, worktreeBackups, codexConfigFiles: configs, recovery: recoveryText(newRoot, project.id) };
}

function printPlan(plan: MovePlan): void {
  console.log(`Project ${plan.project.id}: ${plan.project.name}`);
  console.log(`Checkout: ${plan.oldRoot} -> ${plan.newRoot}${plan.renameCheckout ? " (rename)" : " (already moved)"}`);
  console.log(plan.worktree ? `Git: repair ${plan.worktree.linked.length} linked worktree(s); external trees stay in place.` : "Git: no linked worktrees to repair.");
  const claudeRenames = plan.claudeDirs.filter((item) => item.rename);
  console.log(claudeRenames.length ? `Claude storage: ${claudeRenames.map((item) => `${item.source} -> ${item.target}`).join(", ")}` : "Claude storage: no directory rename needed.");
  console.log(plan.fileChanges.length ? `Config files to update: ${plan.fileChanges.map((item) => item.path).join(", ")}` : "Config files: no path keys to update.");
  console.log(`Claude config: ${join(resolve(process.env.CLAUDE_CONFIG_DIR || homedir()), ".claude.json")}`);
  console.log("Refusals: none found during preflight.");
  console.log(`Codex guidance: Use codex resume --all to find sessions saved under the old path.`);
  console.log("Precondition: exit Claude Code and Codex before applying; hive does not detect or stop them.");
  console.log(`Recovery command: ${plan.recovery}`);
}

function backupFile(path: string): string {
  const backup = `${path}.hive-mv-${randomUUID()}.bak`;
  const contents = readFileSync(path);
  writeFileSync(backup, contents, { flag: "wx", mode: 0o600 });
  try { chmodSync(backup, 0o600); } catch (error) { rmSync(backup, { force: true }); throw error; }
  return backup;
}

function atomicWrite(change: FileChange, recovery: string): string {
  requireRegularFile(change.path, "External config");
  const current = readFileSync(change.path, "utf8");
  if (digest(current) !== digest(change.before)) fail(`Input changed since preview: ${change.path}. No write was made.`, recovery);
  let backup: string;
  try { backup = backupFile(change.path); } catch (error) { fail(`Could not create a private backup for ${change.path}: ${String(error)}. No write was made.`, recovery); }
  console.log(`Backup: ${backup}`);
  const mode = lstatSync(change.path).mode & 0o777;
  const temp = `${change.path}.hive-mv-${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, change.after, { flag: "wx", mode });
    renameSync(temp, change.path);
  } catch (error) {
    rmSync(temp, { force: true });
    fail(`Could not update ${change.path}: ${String(error)}. Backup: ${backup}.`, recovery);
  }
  return backup;
}

function updateHiveRows(plan: MovePlan): void {
  const update = db.transaction(() => {
    const current = getProject(plan.project.id);
    if (!current || current.path !== plan.oldRoot) throw new Error(`Project ${plan.project.id} changed during the move; run ${plan.recovery}`);
    const collision = db.prepare("SELECT id FROM projects WHERE path = ? AND id <> ?").get(plan.newRoot, plan.project.id) as { id: number } | undefined;
    if (collision) throw new Error(`Project ${collision.id} now owns ${plan.newRoot}; run ${plan.recovery}`);
    const rows = db.prepare("SELECT id, cwd, transcript_path FROM agents WHERE project_id = ?").all(plan.project.id) as Array<{ id: number; cwd: string; transcript_path: string }>;
    for (const row of rows) {
      const cwd = mapPath(row.cwd, plan.oldRoot, plan.newRoot);
      let transcript = mapPath(row.transcript_path, plan.oldRoot, plan.newRoot);
      for (const directory of plan.claudeDirs) transcript = mapPath(transcript, directory.source, directory.target);
      if (cwd !== row.cwd || transcript !== row.transcript_path) db.prepare("UPDATE agents SET cwd = ?, transcript_path = ? WHERE id = ? AND project_id = ?").run(cwd, transcript, row.id, plan.project.id);
    }
    const leadRows = db.prepare("SELECT l.agent_id, l.transcript_path FROM lead_turn_state l JOIN agents a ON a.id = l.agent_id WHERE a.project_id = ?").all(plan.project.id) as Array<{ agent_id: number; transcript_path: string }>;
    for (const row of leadRows) {
      let transcript = mapPath(row.transcript_path, plan.oldRoot, plan.newRoot);
      for (const directory of plan.claudeDirs) transcript = mapPath(transcript, directory.source, directory.target);
      if (transcript !== row.transcript_path) db.prepare("UPDATE lead_turn_state SET transcript_path = ? WHERE agent_id = ?").run(transcript, row.agent_id);
    }
    db.prepare("UPDATE projects SET path = ? WHERE id = ? AND path = ?").run(plan.newRoot, plan.project.id, plan.oldRoot);
  });
  update.immediate();
}

function applyMove(plan: MovePlan): void {
  if (plan.sameRoot) { console.log("No changes."); return; }
  const runningNow = db.prepare("SELECT COUNT(*) AS n FROM agents WHERE project_id = ? AND status = 'running'").get(plan.project.id) as { n: number };
  if (runningNow.n !== 0) {
    fail("A hive agent started after preflight; nothing was changed. Close every project agent and retry.", plan.recovery);
  }
  const backups: string[] = [];
  if (plan.renameCheckout) {
    try { renameSync(plan.oldRoot, plan.newRoot); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EXDEV") fail(`The checkout crosses filesystems. Move it by hand, then rerun: ${plan.recovery}`);
      throw error;
    }
    console.log(`Renamed checkout: ${plan.newRoot}`);
  } else console.log("Checkout already moved; repairing recorded paths.");
  if (plan.worktree) {
    const movedTrees = plan.worktree.linked.map((path) => mapPath(path, plan.oldRoot, plan.newRoot)).filter((path) => path !== plan.newRoot && pathIsPresent(path));
    if (movedTrees.length) {
      for (const snapshot of plan.worktreeBackups) {
        try {
          const current = readFileSync(snapshot.path, "utf8");
          if (digest(current) !== digest(snapshot.before)) fail(`Git metadata changed after preflight: ${snapshot.path}. No repair was run.`, plan.recovery);
          const backup = backupFile(snapshot.path);
          backups.push(backup);
          console.log(`Backup: ${backup}`);
        } catch (error) { fail(`Could not back up Git metadata ${snapshot.path}: ${String(error)}. The checkout move is complete; retry after fixing the backup path.`, plan.recovery); }
      }
      try { execFileSync("git", ["-C", plan.newRoot, "worktree", "repair", ...movedTrees], { stdio: "pipe" }); }
      catch (error) { fail(`Git worktree repair failed after the checkout move: ${String(error)}.`, plan.recovery); }
    }
    for (const tree of [plan.newRoot, ...plan.worktree.linked.map((path) => mapPath(path, plan.oldRoot, plan.newRoot))]) {
      if (!pathIsPresent(tree)) continue;
      try {
        const common = execFileSync("git", ["-C", tree, "rev-parse", "--git-common-dir"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
        const resolved = realpathSync(resolve(tree, common));
        if (resolved !== realpathSync(join(plan.newRoot, ".git"))) throw new Error(`common dir is ${resolved}`);
      } catch (error) { fail(`Git worktree validation failed for ${tree}: ${String(error)}.`, plan.recovery); }
    }
  }
  for (const directory of plan.claudeDirs) {
    if (!directory.rename) continue;
    if (!pathIsPresent(directory.source) && pathIsPresent(directory.target)) continue;
    if (pathIsPresent(directory.source) && pathIsPresent(directory.target)) fail(`Claude storage collision appeared during apply: ${directory.target}`, plan.recovery);
    if (pathIsPresent(directory.source)) {
      try { requireDirectory(directory.source, "Claude storage"); }
      catch (error) { fail(`${String(error)}. No storage rename was made.`, plan.recovery); }
      renameSync(directory.source, directory.target);
    }
  }
  for (const change of plan.fileChanges) {
    const backup = atomicWrite(change, plan.recovery);
    backups.push(backup);
    console.log(`Updated config: ${change.path}`);
  }
  try { updateHiveRows(plan); }
  catch (error) { fail(`External paths moved but hive state was not repointed: ${String(error)}`, plan.recovery); }
  for (const backup of backups) void backup;
  console.log(`Project ${plan.project.id} now resolves at ${plan.newRoot}.`);
  console.log("Use codex resume --all to find sessions saved under the old path.");
}

export async function cmdProjectMove(argv: string[]): Promise<void> {
  const { target, options } = parseArgs(argv);
  const project = selectProject(options.projectId);
  const plan = planMove(project, target);
  printPlan(plan);
  if (!options.apply) {
    console.log("Preview only; no files, directories or store rows were changed. Pass --apply to continue.");
    return;
  }
  applyMove(plan);
}
