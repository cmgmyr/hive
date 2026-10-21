import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gitOut } from "./git.js";

const moduleDir = dirname(fileURLToPath(import.meta.url));
const checkoutRoot = join(moduleDir, "..");

export interface BuildInfo {
  version: string;
  sha: string | null;
  dirty: boolean;
  build_id: string;
}

interface GitState {
  sha: string;
  dirty: boolean;
}

function readBuildInfo(): BuildInfo | null {
  try {
    const raw = JSON.parse(readFileSync(join(moduleDir, "build-info.json"), "utf8"));
    return typeof raw.version === "string" ? raw : null;
  } catch {
    return null;
  }
}

function readRunningBuild(): BuildInfo | null {
  const info = readBuildInfo();
  return info && typeof info.build_id === "string" && info.build_id.trim() !== "" &&
    (info.sha === null || typeof info.sha === "string") && typeof info.dirty === "boolean"
    ? info : null;
}

const loadedBuild = readRunningBuild();
let diskSignature: string | undefined;
let diskBuild: BuildInfo | null = null;

export interface RunningBuildChange {
  loaded: BuildInfo;
  disk: BuildInfo;
}

export function runningBuildChange(): RunningBuildChange | null {
  try {
    if (!loadedBuild) return null;
    const stat = statSync(join(moduleDir, "build-info.json"));
    const signature = `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    if (signature !== diskSignature) {
      diskBuild = readRunningBuild();
      diskSignature = signature;
    }
    return diskBuild && diskBuild.build_id !== loadedBuild.build_id
      ? { loaded: loadedBuild, disk: diskBuild } : null;
  } catch {
    diskSignature = undefined;
    diskBuild = null;
    return null;
  }
}

export function runningBuildNotice(change: RunningBuildChange, session?: string): string {
  const subject = session ? `session ${JSON.stringify(session)}'s` : "this session's";
  const detail = (info: BuildInfo) => info.sha === null ? "no git sha" : describe(info.sha, info.dirty);
  const sameDescription = change.loaded.version === change.disk.version && detail(change.loaded) === detail(change.disk);
  const label = (info: BuildInfo) =>
    `hive ${info.version} (${detail(info)}${sameDescription ? `, build ${info.build_id.slice(0, 8)}` : ""})`;
  return `hive: ${subject} hive server loaded ${label(change.loaded)}; ` +
    `the build on disk changed to ${label(change.disk)}. ` +
    "Restart this session, or reconnect hive in /mcp, to pick it up.";
}

function packageVersion(): string {
  try {
    const raw = JSON.parse(readFileSync(join(checkoutRoot, "package.json"), "utf8"));
    return typeof raw.version === "string" ? raw.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export function hiveVersion(): string {
  return readBuildInfo()?.version ?? packageVersion();
}

function currentGit(): GitState | null {
  const sha = gitOut(checkoutRoot, ["rev-parse", "--short", "HEAD"]);
  const status = gitOut(checkoutRoot, ["status", "--porcelain"]);
  return sha === null || status === null ? null : { sha, dirty: status.length > 0 };
}

const describe = (sha: string, dirty: boolean) => `${sha}${dirty ? "-dirty" : ""}`;

export interface VersionInfo {
  line: string;
  drift: string | null;
}

export function versionInfo(): VersionInfo {
  const info = readBuildInfo();
  const version = hiveVersion();

  if (!info || info.sha == null) {
    const now = currentGit();
    return now
      ? { line: `hive ${version} (${describe(now.sha, now.dirty)})`, drift: null }
      : { line: `hive ${version} (build unknown; not built from a git checkout)`, drift: null };
  }

  const line = `hive ${version} (${describe(info.sha, info.dirty)})`;
  const now = currentGit();
  if (now && (now.sha !== info.sha || now.dirty !== info.dirty)) {
    return { line, drift: `checkout has moved since this build: now ${describe(now.sha, now.dirty)}` };
  }
  return { line, drift: null };
}
