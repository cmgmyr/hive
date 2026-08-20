import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const moduleDir = dirname(fileURLToPath(import.meta.url));
const checkoutRoot = join(moduleDir, "..");

interface BuildInfo {
  version: string;
  sha: string | null;
  dirty: boolean;
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

function packageVersion(): string {
  try {
    const raw = JSON.parse(readFileSync(join(checkoutRoot, "package.json"), "utf8"));
    return typeof raw.version === "string" ? raw.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function currentGit(): GitState | null {
  try {
    const sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: checkoutRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const status = execFileSync("git", ["status", "--porcelain"], {
      cwd: checkoutRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return { sha, dirty: status.trim().length > 0 };
  } catch {
    return null;
  }
}

const describe = (sha: string, dirty: boolean) => `${sha}${dirty ? "-dirty" : ""}`;

export interface VersionInfo {
  line: string;
  drift: string | null;
}

export function versionInfo(): VersionInfo {
  const info = readBuildInfo();
  const version = info?.version ?? packageVersion();

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
