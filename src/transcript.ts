import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync } from "node:fs";
import { join } from "node:path";
import { storeDir } from "./dataDir.js";
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

export const CONTEXT_TOKENS_TAIL_BYTES = 256 * 1024;

export type ContextRecordKind = "claude" | "codex";

export interface ContextFill {
  used_tokens: number;
  window_tokens: number;
  used_percent: number;
}

export interface ContextWorker {
  actor_id: string;
  cwd: string;
  session_id: string;
  transcript_path: string;
}

type JsonRecord = Record<string, unknown>;

function object(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null ? value as JsonRecord : null;
}

function tokenNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function usageTokens(record: JsonRecord): number | null {
  if (record.type !== "assistant") return null;
  const usage = object(object(record.message)?.usage);
  if (!usage) return null;
  const values = [usage.input_tokens, usage.cache_creation_input_tokens, usage.cache_read_input_tokens];
  if (values.some((value) => value !== undefined && !tokenNumber(value))) return null;
  const sum = values.reduce<number>((total, value) => total + (value as number | undefined ?? 0), 0);
  return tokenNumber(sum) && sum > 0 ? sum : null;
}

function tailRecords(path: string): JsonRecord[] {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - CONTEXT_TOKENS_TAIL_BYTES);
    const buffer = Buffer.alloc(size - start);
    const bytes = readSync(fd, buffer, 0, buffer.length, start);
    const lines = buffer.subarray(0, bytes).toString("utf8").split("\n");
    if (start > 0) lines.shift();
    const records: JsonRecord[] = [];
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const record = object(JSON.parse(lines[i]));
        if (record) records.push(record);
      } catch {}
    }
    return records;
  } catch {
    return [];
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function claudeTokens(records: JsonRecord[]): number | null {
  for (const record of records) {
    const tokens = usageTokens(record);
    if (tokens === null) continue;
    return tokens;
  }
  return null;
}

export function claudeWindowPath(actorId: string): string {
  return join(storeDir(), "context-windows", `${encodeURIComponent(actorId)}.json`);
}

function claudeWindow(actorId: string): number | null {
  if (!actorId) return null;
  try {
    const value: unknown = JSON.parse(readFileSync(claudeWindowPath(actorId), "utf8"));
    return tokenNumber(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

export function readContextFill(kind: ContextRecordKind, worker: ContextWorker): ContextFill | null {
  const path = worker.transcript_path || (kind === "claude" && worker.session_id
    ? join(transcriptDir(worker.cwd), `${worker.session_id}.jsonl`) : "");
  if (!path) return null;
  let window = kind === "claude" ? claudeWindow(worker.actor_id) : null;
  if (kind === "claude" && window === null) return null;
  const records = tailRecords(path);
  let used: number | null = null;
  if (kind === "claude") {
    used = claudeTokens(records);
  } else {
    for (const record of records) {
      const payload = object(record.payload);
      if (record.type !== "event_msg" || payload?.type !== "token_count") continue;
      const info = object(payload.info);
      const input = object(info?.last_token_usage)?.input_tokens;
      const size = info?.model_context_window;
      if (!tokenNumber(input) || !tokenNumber(size) || size === 0) continue;
      used = input;
      window = size;
      break;
    }
  }
  return used === null || window === null ? null : {
    used_tokens: used, window_tokens: window, used_percent: Math.round(used * 100 / window),
  };
}

export function readContextTokens(cwd: string, sessionId: string, transcriptPath = ""): number | null {
  if (!sessionId && !transcriptPath) return null;
  return claudeTokens(tailRecords(transcriptPath || join(transcriptDir(cwd), `${sessionId}.jsonl`)));
}
