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

export function transcriptPath(cwd: string, sessionId: string, explicitPath = ""): string {
  return explicitPath || (sessionId ? join(transcriptDir(cwd), `${sessionId}.jsonl`) : "");
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
  return tailRead(path).records;
}

function tailRead(path: string): { records: JsonRecord[]; clipped: boolean } {
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
    return { records, clipped: start > 0 };
  } catch {
    return { records: [], clipped: false };
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

export function readContextTokens(cwd: string, sessionId: string, explicitPath = ""): number | null {
  if (!sessionId && !explicitPath) return null;
  return claudeTokens(tailRecords(transcriptPath(cwd, sessionId, explicitPath)));
}

export interface TranscriptToolCall {
  name: string;
  input: Record<string, unknown>;
  at: string | null;
}

export const RECENT_TOOL_CALLS = 8;

export const SKILL_TOOL = "Skill";

export interface ToolCallOptions {
  reviewSkills?: string[];
}

export function lastComponent(name: string): string {
  return name.split(/__|[.:/]/).filter(Boolean).pop() ?? name;
}

function timestamp(record: JsonRecord): string | null {
  return typeof record.timestamp === "string" && record.timestamp !== "" ? record.timestamp : null;
}

function reviewMarker(texts: unknown[], at: string | null, skills: string[]): TranscriptToolCall[] {
  for (const skill of skills) {
    const invocation = new RegExp(`^\\s*\\$${skill.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`, "m");
    if (texts.some((text) => typeof text === "string" && invocation.test(text))) {
      return [{ name: SKILL_TOOL, input: { skill }, at }];
    }
  }
  return [];
}

function claudeToolCalls(record: JsonRecord, options: ToolCallOptions): TranscriptToolCall[] {
  if (record.type !== "assistant") return [];
  const content = object(record.message)?.content;
  if (!Array.isArray(content)) return [];
  const at = timestamp(record);
  const calls: TranscriptToolCall[] = [];
  for (const part of content) {
    const block = object(part);
    if (!block) continue;
    if (block.type === "tool_use" && typeof block.name === "string") {
      calls.push({ name: block.name, input: object(block.input) ?? {}, at });
    } else if (block.type === "text") {
      calls.push(...reviewMarker([block.text], at, options.reviewSkills ?? []));
    }
  }
  return calls;
}

function codexToolCalls(record: JsonRecord, options: ToolCallOptions): TranscriptToolCall[] {
  const payload = object(record.payload);
  if (record.type !== "response_item" || !payload) return [];
  const at = timestamp(record);
  if (payload.type === "message") {
    if (payload.role !== "assistant" || !Array.isArray(payload.content)) return [];
    return reviewMarker(payload.content.map((part) => object(part)?.text), at, options.reviewSkills ?? []);
  }
  if (typeof payload.name !== "string") return [];
  const name = lastComponent(payload.name);
  if (payload.type === "custom_tool_call") {
    return [{ name, input: typeof payload.input === "string" ? { input: payload.input } : {}, at }];
  }
  if (payload.type !== "function_call") return [];
  if (name === "write_stdin") return [];
  let args: Record<string, unknown> = {};
  if (typeof payload.arguments === "string") {
    try {
      args = object(JSON.parse(payload.arguments)) ?? {};
    } catch {}
  }
  if (name === "exec_command") return typeof args.cmd === "string" ? [{ name: "Bash", input: { command: args.cmd }, at }] : [];
  return [{ name, input: args, at }];
}

export function readRecentToolCalls(
  kind: ContextRecordKind,
  worker: ContextWorker,
  options: ToolCallOptions = {},
): { calls: TranscriptToolCall[]; truncated: boolean } {
  const path = worker.transcript_path || (kind === "claude" && worker.session_id
    ? join(transcriptDir(worker.cwd), `${worker.session_id}.jsonl`) : "");
  if (!path) return { calls: [], truncated: false };
  const { records, clipped } = tailRead(path);
  const newestFirst: TranscriptToolCall[] = [];
  let capped = false;
  for (const record of records) {
    const calls = (kind === "claude" ? claudeToolCalls : codexToolCalls)(record, options);
    for (let i = calls.length - 1; i >= 0; i--) {
      if (newestFirst.length === RECENT_TOOL_CALLS) {
        capped = true;
        break;
      }
      newestFirst.push(calls[i]);
    }
    if (capped) break;
  }
  return { calls: newestFirst.reverse(), truncated: clipped || capped };
}
