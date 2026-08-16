import { existsSync } from "node:fs";
import { join } from "node:path";
import { claudeConfigDir } from "./claudeDir.js";

export function transcriptDirName(cwd: string): string {
  return cwd.replace(/[/.]/g, "-");
}

export function transcriptDir(cwd: string): string {
  return join(claudeConfigDir(), "projects", transcriptDirName(cwd));
}

export function resolveTranscriptDir(cwd: string): string | null {
  const dir = transcriptDir(cwd);
  return existsSync(dir) ? dir : null;
}
