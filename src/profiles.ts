import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { storeDir } from "./dataDir.js";

// Profiles: a named set of standing instructions shared across projects.
//
//   <checkout>/profiles/<name>/<file>   hive's defaults, upgraded by git pull
//   <dataDir>/profiles/<name>/<file>    your overrides, copy-on-write
//
// Resolution is per FILE, not per profile, so a file you never forked keeps
// tracking hive's default while the ones you did are yours.
//
// Like dataDir.ts and tmux.ts, this module opens no database: kickoff has to
// answer "does this profile exist" before it is worth touching the store.

export const PROFILE_FILES = ["posture.md", "runbook.md", "worker.md"] as const;
export type ProfileFile = (typeof PROFILE_FILES)[number];

// dist/profiles.js sits one level under the checkout root, next to the
// profiles/ and claude-plugin/ directories that ship with it. One place
// encodes that layout; `hive init` prints a path under it too.
export const checkoutRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
export const shippedProfilesDir = join(checkoutRoot, "profiles");
// A function, not a const: the store is chosen when someone asks, not when
// this module happens to load. See src/dataDir.ts.
export const userProfilesDir = (): string => join(storeDir(), "profiles");

// hive.yml is repo-controlled and the resolved posture file is fed to claude
// as a system prompt, so a profile name must never be able to walk out of
// these two directories.
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export function isValidProfileName(name: string): boolean {
  return NAME_PATTERN.test(name) && !name.includes("..");
}

export interface ResolvedFile {
  file: ProfileFile;
  path: string;
  source: "user" | "shipped";
}

function candidate(dir: string, name: string, file: ProfileFile): string {
  return join(dir, name, file);
}

export function resolveProfileFile(name: string, file: ProfileFile): ResolvedFile | null {
  if (!isValidProfileName(name)) return null;
  const user = candidate(userProfilesDir(), name, file);
  if (existsSync(user)) return { file, path: user, source: "user" };
  const shipped = candidate(shippedProfilesDir, name, file);
  if (existsSync(shipped)) return { file, path: shipped, source: "shipped" };
  return null;
}

export function readProfileFile(name: string, file: ProfileFile): string | null {
  const resolved = resolveProfileFile(name, file);
  if (!resolved) return null;
  try {
    return readFileSync(resolved.path, "utf8");
  } catch {
    return null;
  }
}

// Read a profile file and substitute the project's vars. Every profile file
// goes through this: posture.md, runbook.md, and worker.md all advertise the
// same {{var}} and <!--if:--> syntax, so none of them may quietly not have it.
export function renderProfileFile(
  name: string,
  file: ProfileFile,
  vars: Record<string, string>,
): string | null {
  const template = readProfileFile(name, file);
  return template == null ? null : renderTemplate(template, vars);
}

// A profile exists as soon as either layer has a directory for it. A user
// directory holding only worker.md is still that profile; the other files
// resolve to hive's defaults.
export function profileExists(name: string): boolean {
  if (!isValidProfileName(name)) return false;
  return existsSync(join(userProfilesDir(), name)) || existsSync(join(shippedProfilesDir, name));
}

function namesIn(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && isValidProfileName(e.name))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

export function profileNames(): string[] {
  return [...new Set([...namesIn(shippedProfilesDir), ...namesIn(userProfilesDir())])].sort();
}

// What a fork was copied from, so `hive profile list` and `hive doctor` can
// say "upstream moved since you forked" without ever overwriting your copy.
const ORIGIN_FILE = ".hive-origin.json";

function contentHash(path: string): string | null {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex").slice(0, 16);
  } catch {
    return null;
  }
}

function readOrigins(name: string): Record<string, string> {
  try {
    const raw = JSON.parse(readFileSync(join(userProfilesDir(), name, ORIGIN_FILE), "utf8"));
    return raw && typeof raw === "object" ? (raw as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function writeOrigin(name: string, file: string, hash: string | null): void {
  if (hash == null) return;
  const origins = readOrigins(name);
  origins[file] = hash;
  writeFileSync(join(userProfilesDir(), name, ORIGIN_FILE), `${JSON.stringify(origins, null, 2)}\n`);
}

export interface ProfileFileStatus extends ResolvedFile {
  // True when this file is forked AND hive's shipped version changed after
  // the fork. Reported, never acted on: the fork is the user's.
  upstreamMoved: boolean;
}

export function profileStatus(name: string): { name: string; files: ProfileFileStatus[] } {
  const origins = readOrigins(name);
  const files: ProfileFileStatus[] = [];
  for (const file of PROFILE_FILES) {
    const resolved = resolveProfileFile(name, file);
    if (!resolved) continue;
    const shippedNow = contentHash(candidate(shippedProfilesDir, name, file));
    files.push({
      ...resolved,
      upstreamMoved:
        resolved.source === "user" && origins[file] != null && shippedNow != null && shippedNow !== origins[file],
    });
  }
  return { name, files };
}

export class ProfileError extends Error {}

function requireName(name: string): void {
  if (!isValidProfileName(name)) {
    throw new ProfileError(
      `"${name}" is not a valid profile name (letters, digits, dot, dash, underscore; no path separators).`,
    );
  }
}

// Copy-on-write: one file or the whole profile, never overwriting a fork you
// already have.
export function forkProfile(name: string, only?: ProfileFile): { copied: string[]; skipped: string[] } {
  requireName(name);
  if (!profileExists(name)) throw new ProfileError(`No profile named "${name}". List them with: hive profile list`);
  const targetDir = join(userProfilesDir(), name);
  mkdirSync(targetDir, { recursive: true });
  const copied: string[] = [];
  const skipped: string[] = [];
  for (const file of only ? [only] : PROFILE_FILES) {
    const source = candidate(shippedProfilesDir, name, file);
    if (!existsSync(source)) {
      if (only) throw new ProfileError(`Profile "${name}" ships no ${file}.`);
      continue;
    }
    const target = candidate(userProfilesDir(), name, file);
    if (existsSync(target)) {
      skipped.push(file);
      continue;
    }
    copyFileSync(source, target);
    writeOrigin(name, file, contentHash(source));
    copied.push(file);
  }
  return { copied, skipped };
}

export function createProfile(name: string, from?: string): string {
  requireName(name);
  const existing = join(userProfilesDir(), name);
  if (existsSync(existing)) {
    throw new ProfileError(`You already have a profile named "${name}" at ${existing}.`);
  }
  if (from != null && !profileExists(from)) {
    throw new ProfileError(`No profile named "${from}" to copy from.`);
  }
  const targetDir = join(userProfilesDir(), name);
  mkdirSync(targetDir, { recursive: true });
  if (from != null) {
    for (const file of PROFILE_FILES) {
      const resolved = resolveProfileFile(from, file);
      if (resolved) copyFileSync(resolved.path, join(targetDir, file));
    }
  } else {
    writeFileSync(join(targetDir, "posture.md"), `# ${name} posture\n\n<how a session running this profile should behave>\n`);
  }
  return targetDir;
}

// --- template rendering -------------------------------------------------
//
// {{var}} and not <VAR>: the runbook already uses <branch>, <N>, <files/area>
// as placeholders the MODEL fills from context, and substituting into those
// would corrupt the doc.

const VAR_REF = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;
const IF_LINE = /^[ \t]*<!--\s*if:([A-Za-z_][A-Za-z0-9_]*)\s*-->[ \t]*$/;
const END_LINE = /^[ \t]*<!--\s*end\s*-->[ \t]*$/;

const isSet = (vars: Record<string, string>, key: string) =>
  vars[key] != null && String(vars[key]).trim() !== "";

// Line-based so blocks can nest: a section is kept only when every enclosing
// <!--if:--> is satisfied. Marker lines never survive. An unclosed block runs
// to the end of the file rather than throwing; a runbook that renders a
// little wrong beats one that refuses to print.
function renderConditionals(text: string, vars: Record<string, string>): string {
  const out: string[] = [];
  const stack: boolean[] = [];
  for (const line of text.split("\n")) {
    const open = IF_LINE.exec(line);
    if (open) {
      stack.push(isSet(vars, open[1]));
      continue;
    }
    if (END_LINE.test(line)) {
      stack.pop();
      continue;
    }
    if (stack.every(Boolean)) out.push(line);
  }
  return out.join("\n");
}

// An undefined var stays visible as {{name}} rather than collapsing to an
// empty string: a runbook missing a value should look wrong, not silently
// read as though it had one.
export function renderTemplate(text: string, vars: Record<string, string>): string {
  return (
    renderConditionals(text, vars)
      .replace(VAR_REF, (match, key: string) => (isSet(vars, key) ? vars[key] : match))
      // A dropped section leaves the blank lines that framed it behind.
      .replace(/\n{3,}/g, "\n\n")
  );
}

// Every var a template references, in either form. `hive doctor` compares
// this against what the project defines.
export function templateVars(text: string): string[] {
  const found = new Set<string>();
  for (const line of text.split("\n")) {
    const open = IF_LINE.exec(line);
    if (open) found.add(open[1]);
  }
  for (const match of text.matchAll(VAR_REF)) found.add(match[1]);
  return [...found].sort();
}
