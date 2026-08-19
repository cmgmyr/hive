import { closeSync, existsSync, fstatSync, openSync, readSync } from "node:fs";
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

// Transcripts reach 10MB; a whole-file read/parse per agent_status call does not scale. The last
// assistant record's usage always sits near the end, so only this trailing window is ever read.
export const CONTEXT_TOKENS_TAIL_BYTES = 256 * 1024;

function usageTokens(line: string): number | null {
  let record: unknown;
  try {
    record = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof record !== "object" || record === null) return null;
  const r = record as Record<string, unknown>;
  if (r.type !== "assistant") return null;
  const message = r.message;
  if (typeof message !== "object" || message === null) return null;
  const usage = (message as Record<string, unknown>).usage;
  if (typeof usage !== "object" || usage === null) return null;
  const u = usage as Record<string, unknown>;
  const numOr0 = (v: unknown) => (typeof v === "number" ? v : 0);
  const sum = numOr0(u.input_tokens) + numOr0(u.cache_creation_input_tokens) + numOr0(u.cache_read_input_tokens);
  // A real prompt is never free; 0 is Claude Code's synthetic mid-response API-error record
  // (model "<synthetic>", isApiErrorMessage: true), so treat it as no record and keep scanning.
  return sum === 0 ? null : sum;
}

export function readContextTokens(cwd: string, sessionId: string): number | null {
  if (!sessionId) return null;
  const path = join(transcriptDir(cwd), `${sessionId}.jsonl`);
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return null;
  }
  try {
    const size = fstatSync(fd).size;
    if (size === 0) return null;
    const start = Math.max(0, size - CONTEXT_TOKENS_TAIL_BYTES);
    const buffer = Buffer.alloc(size - start);
    readSync(fd, buffer, 0, buffer.length, start);
    const lines = buffer.toString("utf8").split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const trimmed = lines[i].trim();
      if (!trimmed) continue;
      const tokens = usageTokens(trimmed);
      if (tokens !== null) return tokens;
    }
    return null;
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}
