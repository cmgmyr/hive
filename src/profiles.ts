import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { storeDir } from "./dataDir.js";

export const PROFILE_FILES = ["posture.md", "runbook.md", "worker.md"] as const;
export type ProfileFile = (typeof PROFILE_FILES)[number];

export const checkoutRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
export const shippedProfilesDir = join(checkoutRoot, "profiles");

export const userProfilesDir = (): string => join(storeDir(), "profiles");

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export function isValidProfileName(name: string): boolean {
  return NAME_PATTERN.test(name) && !name.includes("..");
}

const FILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/;
export function isValidProfileFileName(file: string): boolean {
  return FILE_NAME_PATTERN.test(file) && !file.includes("..");
}

export interface ResolvedFile {
  file: string;
  path: string;
  source: "user" | "shipped";
}

function candidate(dir: string, name: string, file: string): string {
  return join(dir, name, file);
}

export function resolveProfileFile(name: string, file: string): ResolvedFile | null {
  if (!isValidProfileName(name) || !isValidProfileFileName(file)) return null;
  const user = candidate(userProfilesDir(), name, file);
  if (existsSync(user)) return { file, path: user, source: "user" };
  const shipped = candidate(shippedProfilesDir, name, file);
  if (existsSync(shipped)) return { file, path: shipped, source: "shipped" };
  return null;
}

export function readProfileFile(name: string, file: string): string | null {
  const resolved = resolveProfileFile(name, file);
  if (!resolved) return null;
  try {
    return readFileSync(resolved.path, "utf8");
  } catch {
    return null;
  }
}

export function renderProfileFile(
  name: string,
  file: string,
  vars: Record<string, string>,
): string | null {
  const template = readProfileFile(name, file);
  return template == null ? null : renderTemplate(template, vars);
}

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

function mdFilesIn(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && isValidProfileFileName(e.name))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

export function profileFileNames(name: string): string[] {
  if (!isValidProfileName(name)) return [];
  const present = new Set([
    ...mdFilesIn(join(shippedProfilesDir, name)),
    ...mdFilesIn(join(userProfilesDir(), name)),
  ]);
  const known = PROFILE_FILES.filter((f) => present.has(f));
  const extra = [...present].filter((f) => !(PROFILE_FILES as readonly string[]).includes(f)).sort();
  return [...known, ...extra];
}

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

  upstreamMoved: boolean;

  divergence: number | null;
}

function readFileSafe(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function lineDivergence(a: string, b: string): number {
  const linesA = a.split("\n");
  const linesB = b.split("\n");
  const counts = new Map<string, number>();
  for (const line of linesA) counts.set(line, (counts.get(line) ?? 0) + 1);
  let common = 0;
  for (const line of linesB) {
    const n = counts.get(line) ?? 0;
    if (n > 0) {
      common += 1;
      counts.set(line, n - 1);
    }
  }
  const total = linesA.length + linesB.length;
  return total === 0 ? 0 : 1 - (2 * common) / total;
}

export const REWRITE_THRESHOLD = 0.5;

export function profileStatus(name: string): { name: string; files: ProfileFileStatus[] } {
  const origins = readOrigins(name);
  const files: ProfileFileStatus[] = [];
  for (const file of profileFileNames(name)) {
    const resolved = resolveProfileFile(name, file);
    if (!resolved) continue;
    const shippedPath = candidate(shippedProfilesDir, name, file);
    const shippedNow = contentHash(shippedPath);
    let divergence: number | null = null;
    if (resolved.source === "user") {
      const userText = readFileSafe(resolved.path);
      const shippedText = readFileSafe(shippedPath);
      if (userText != null && shippedText != null) divergence = lineDivergence(userText, shippedText);
    }
    files.push({
      ...resolved,
      upstreamMoved:
        resolved.source === "user" && origins[file] != null && shippedNow != null && shippedNow !== origins[file],
      divergence,
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

const VAR_REF = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;
const IF_LINE = /^[ \t]*<!--\s*if:([A-Za-z_][A-Za-z0-9_]*)\s*-->[ \t]*$/;
const END_LINE = /^[ \t]*<!--\s*end\s*-->[ \t]*$/;

const isSet = (vars: Record<string, string>, key: string) =>
  vars[key] != null && String(vars[key]).trim() !== "";

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

export function renderTemplate(text: string, vars: Record<string, string>): string {
  return (
    renderConditionals(text, vars)
      .replace(VAR_REF, (match, key: string) => (isSet(vars, key) ? vars[key] : match))

      .replace(/\n{3,}/g, "\n\n")
  );
}

export function templateVars(text: string): string[] {
  const found = new Set<string>();
  for (const line of text.split("\n")) {
    const open = IF_LINE.exec(line);
    if (open) found.add(open[1]);
  }
  for (const match of text.matchAll(VAR_REF)) found.add(match[1]);
  return [...found].sort();
}

const PAD_NAME = "[A-Za-z0-9][A-Za-z0-9_.-]*";
const HIVE_PAD_CMD = new RegExp(`\`hive pad (${PAD_NAME})`, "g");
const PAD_TOOL_CALL = /\bpad_(?:read|write)\([^)]*name\s*=\s*"([^"]+)"/g;
const QUOTED_PAD_BEFORE = new RegExp(`"(${PAD_NAME})"\\s+pad\\b`, "gi");
const QUOTED_PAD_AFTER = new RegExp(`\\bpad\\s+"(${PAD_NAME})"`, "gi");

export function referencedPads(text: string): string[] {
  const found = new Set<string>();
  for (const re of [HIVE_PAD_CMD, PAD_TOOL_CALL, QUOTED_PAD_BEFORE, QUOTED_PAD_AFTER]) {
    for (const m of text.matchAll(re)) found.add(m[1]);
  }
  return [...found].sort();
}

const PATH_TOKEN = /^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.*-]+)+\/?$/;

export function referencedPaths(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(/`([^`\n]+)`/g)) {
    const token = m[1].trim();
    if (!PATH_TOKEN.test(token)) continue;
    found.add(token);
  }
  return [...found].sort();
}
