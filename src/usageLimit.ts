import { closeSync, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { isAbsolute, join, relative, sep } from "node:path";
import { db } from "./db.js";
import { codexHomeDir } from "./codexHome.js";
import { transcriptDir } from "./transcript.js";
import { harnessFor } from "./harnesses.js";
import { awaitingFirstPrompt } from "./firstPrompt.js";
import { readHandoffGate } from "./leadHandoffState.js";
import { PANE_LEASE_SETTLE_MS, releasePaneLease, tryAcquirePaneLease } from "./leaseStore.js";
import { capturePane, liveTargets, paneInCopyMode, rowOwnership, sendText, sleep } from "./tmux.js";

const UNKNOWN_RESET_MS = 6 * 60 * 60 * 1000;
const RESET_GRACE_MS = 60 * 1000;
const MAX_TAIL_BYTES = 256 * 1024;

type JsonObject = Record<string, unknown>;
type AgentRow = {
  id: number; project_id: number; actor_id: string; kind: string; status: string;
  command: string; cwd: string; session_id: string; transcript_path: string;
  codex_home: string; pane_pid: string; tmux_socket: string; tmux_target: string;
  resumed_at: string;
};
type Episode = {
  project_id: number; harness: string; pane_pid: string; session_id: string;
  signal_key: string; observed_at: string; reset_at: string | null;
  expires_at: string; released_at: string | null; continue_claimed_at: string | null;
};

function currentTranscriptOwner(row: AgentRow): AgentRow | null {
  if (row.kind !== "lead") return row;
  const turn = db.prepare("SELECT pane_pid, session_id, transcript_path FROM lead_turn_state WHERE agent_id = ?")
    .get(row.id) as { pane_pid: string; session_id: string; transcript_path: string } | undefined;
  if (!turn || turn.pane_pid !== row.pane_pid || !turn.session_id) return null;
  return { ...row, session_id: turn.session_id, transcript_path: turn.transcript_path };
}

function object(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonObject : null;
}

function canonical(path: string): string | null {
  try { return requireRealpath(path); } catch { return null; }
}

function requireRealpath(path: string): string {
  return realpathSync(path);
}

function isWithin(root: string, path: string): boolean {
  if (!isAbsolute(path) || path.includes("\0")) return false;
  const base = canonical(root);
  const target = canonical(path);
  if (base === null || target === null) return false;
  const rel = relative(base, target);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function tail(path: string): string[] {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - MAX_TAIL_BYTES);
    const buffer = Buffer.alloc(size - start);
    const bytes = readSync(fd, buffer, 0, buffer.length, start);
    const lines = buffer.subarray(0, bytes).toString("utf8").split("\n");
    if (start > 0) lines.shift();
    return lines.filter(Boolean);
  } catch {
    return [];
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function parsedLines(path: string): JsonObject[] {
  const records: JsonObject[] = [];
  const lines = tail(path);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    try {
      const value = object(JSON.parse(line));
      if (value) records.push(value);
    } catch {
      if (i === lines.length - 1) return [];
    }
  }
  return records;
}

function last<T>(values: T[]): T | undefined { return values.at(-1); }

function claudeEvidence(row: AgentRow, nowMs: number): { signal: string; resetMs: number | null; progressed: boolean } | null {
  const expected = transcriptDir(row.cwd);
  const path = row.transcript_path || (row.session_id ? join(expected, `${row.session_id}.jsonl`) : "");
  if (!path || !isWithin(expected, path)) return null;
  const records = parsedLines(path);
  const record = last(records.filter((candidate) => candidate.type === "assistant"));
  if (!record) return null;
  if (typeof record.sessionId === "string" && record.sessionId !== row.session_id) return null;
  const quota = object(record.quotaLimits);
  if (record.type === "assistant" && record.error === "rate_limit" && quota?.status === "rejected" && record.isApiErrorMessage === true) {
    const reset = quota.resetsAt;
    const resetMs = typeof reset === "number" && Number.isFinite(reset) && reset > 0 ? reset * 1000 : null;
    return { signal: `claude:${row.session_id}:${createHash("sha256").update(JSON.stringify(record)).digest("hex")}`, resetMs, progressed: false };
  }
  if (record.error === "rate_limit" && record.apiError === "usage_limit_reached") {
    const ownership = rowOwnership(row, liveTargets());
    if (ownership !== "live") return null;
    let screen = "";
    try { screen = capturePane(row.tmux_target, 80); } catch { return null; }
    if (!/usage limit reached\s*[·•]\s*limit resets/i.test(screen)) return null;
    const content = object(record.message)?.content;
    const text = Array.isArray(content)
      ? content.map((part) => typeof object(part)?.text === "string" ? object(part)?.text as string : "").join("\n")
      : "";
    const resetValue = quota?.resetsAt;
    const resetMs = typeof resetValue === "number" && Number.isFinite(resetValue) && resetValue > 0
      ? resetValue * 1000
      : parseResetText(text || screen, nowMs);
    return { signal: `claude:${row.session_id}:${createHash("sha256").update(JSON.stringify(record)).digest("hex")}`, resetMs, progressed: false };
  }
  if (record.type === "assistant" && record.error !== "rate_limit" && record.isApiErrorMessage !== true) {
    return { signal: "", resetMs: null, progressed: true };
  }
  return { signal: "", resetMs: null, progressed: false };
}

function codexEvidence(row: AgentRow): { signal: string; resetMs: number | null; progressed: boolean } | null {
  const root = join(codexHomeDir(row.codex_home), "sessions");
  if (!row.codex_home || !row.transcript_path || !isWithin(root, row.transcript_path)) return null;
  const name = row.transcript_path.split(/[\\/]/).at(-1) ?? "";
  if (!/^rollout-.*\.jsonl$/.test(name) || (row.session_id && !name.includes(row.session_id))) return null;
  const ownership = rowOwnership(row, liveTargets());
  if (ownership !== "live") return null;
  let screen = "";
  try { screen = capturePane(row.tmux_target, 80); } catch { return null; }
  const token = last(parsedLines(row.transcript_path).filter((record) => {
    const payload = object(record.payload);
    return record.type === "event_msg" && payload?.type === "token_count" && object(payload.rate_limits) !== null;
  }));
  const rateLimits = object(object(token?.payload)?.rate_limits);
  if (!rateLimits) return null;
  const primary = object(rateLimits.primary);
  const secondary = object(rateLimits.secondary);
  const reached = typeof rateLimits.rate_limit_reached_type === "string" && rateLimits.rate_limit_reached_type !== "";
  const exhausted = [primary, secondary].some((window) => typeof window?.used_percent === "number" && window.used_percent >= 100);
  if (!/hit your usage limit/i.test(screen)) {
    return !reached && !exhausted ? { signal: "", resetMs: null, progressed: true } : { signal: "", resetMs: null, progressed: false };
  }
  if (!reached && !exhausted) return null;
  const resets = [primary, secondary].flatMap((window) => {
    if (typeof window?.used_percent !== "number" || window.used_percent < 100) return [];
    const value = window?.resets_at;
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? [value * 1000] : [];
  });
  const resetMs = resets.length ? Math.max(...resets) : null;
  return { signal: `codex:${row.session_id}:${createHash("sha256").update(JSON.stringify(token)).digest("hex")}`, resetMs, progressed: false };
}

function parseResetText(text: string, nowMs: number): number | null {
  const match = /resets\s+(?:(\w{3})\s+)?(?:(\w{3})\s+(\d{1,2})\s+at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)(?:\s*\(([^)]+)\))?/i.exec(text);
  if (!match) return null;
  const [, weekday, month, day, hourRaw, minuteRaw, meridiem, zone] = match;
  const hour = Number(hourRaw) % 12 + (/pm/i.test(meridiem) ? 12 : 0);
  const minute = Number(minuteRaw ?? 0);
  let formatter: Intl.DateTimeFormat;
  let current: Record<string, string>;
  try {
    formatter = new Intl.DateTimeFormat("en-US", {
      ...(zone ? { timeZone: zone } : {}),
      year: "numeric", month: "numeric", day: "numeric", weekday: "short",
    });
    current = Object.fromEntries(formatter.formatToParts(new Date(nowMs)).map((part) => [part.type, part.value]));
  } catch { return null; }
  let year = Number(current.year);
  let monthIndex = Number(current.month) - 1;
  let date = Number(current.day);
  if (month && day) {
    monthIndex = new Date(`${month} 1, 2000`).getMonth();
    date = Number(day);
    if (monthIndex < Number(current.month) - 1 || (monthIndex === Number(current.month) - 1 && date < Number(current.day))) year++;
  } else if (weekday) {
    const weekdays = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
    const target = weekdays.indexOf(weekday.toLowerCase().slice(0, 3));
    if (target < 0) return null;
    const currentDay = weekdays.indexOf(current.weekday.toLowerCase().slice(0, 3));
    date += (target - currentDay + 7) % 7;
  }
  const wallTime = Date.UTC(year, monthIndex, date, hour, minute);
  if (zone) {
    try {
      const clock = new Intl.DateTimeFormat("en-US", { timeZone: zone, year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", hourCycle: "h23" });
      let candidate = wallTime;
      for (let i = 0; i < 4; i++) {
        const parts = Object.fromEntries(clock.formatToParts(new Date(candidate)).map((part) => [part.type, part.value]));
        const represented = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute));
        const correction = wallTime - represented;
        if (correction === 0) break;
        candidate += correction;
      }
      const check = Object.fromEntries(clock.formatToParts(new Date(candidate)).map((part) => [part.type, part.value]));
      if (Number(check.year) !== year || Number(check.month) !== monthIndex + 1 || Number(check.day) !== date ||
          Number(check.hour) !== hour || Number(check.minute) !== minute) return null;
      if (!month && !weekday && candidate <= nowMs) candidate += 24 * 60 * 60 * 1000;
      return candidate;
    } catch { return null; }
  }
  const result = new Date(year, monthIndex, date, hour, minute).getTime();
  if (!month && !weekday && result <= nowMs) return result + 24 * 60 * 60 * 1000;
  return result;
}

function timestamp(value: string | null): number | null {
  if (!value) return null;
  const normalized = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value) ? value : `${value.replace(" ", "T")}Z`;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function writeEpisode(row: AgentRow, harness: string, signal: string, resetMs: number | null, nowMs: number): void {
  const existing = db.prepare("SELECT * FROM agent_usage_limits WHERE agent_id = ?").get(row.id) as Episode | undefined;
  const identityMatches = existing?.project_id === row.project_id && existing.pane_pid === row.pane_pid && existing.session_id === row.session_id;
  if (identityMatches && existing?.signal_key === signal) return;
  const expiresMs = resetMs === null ? nowMs + UNKNOWN_RESET_MS : resetMs + RESET_GRACE_MS;
  db.prepare(`INSERT INTO agent_usage_limits
      (agent_id, project_id, harness, pane_pid, session_id, signal_key, observed_at, reset_at, expires_at, released_at, continue_claimed_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime(?, 'unixepoch'), ?, datetime(?, 'unixepoch'), NULL, NULL)
    ON CONFLICT(agent_id) DO UPDATE SET project_id=excluded.project_id, harness=excluded.harness,
      pane_pid=excluded.pane_pid, session_id=excluded.session_id, signal_key=excluded.signal_key,
      observed_at=excluded.observed_at, reset_at=excluded.reset_at, expires_at=excluded.expires_at,
      released_at=NULL, continue_claimed_at=NULL
    WHERE EXISTS (
      SELECT 1 FROM agents a
      WHERE a.id = excluded.agent_id AND a.project_id = excluded.project_id
        AND a.pane_pid = excluded.pane_pid AND a.status = 'running'
        AND ((a.kind = 'agent' AND a.session_id = excluded.session_id) OR (a.kind = 'lead' AND EXISTS (
          SELECT 1 FROM lead_turn_state t
          WHERE t.agent_id = a.id AND t.pane_pid = a.pane_pid AND t.session_id = excluded.session_id
        )))
    )`)
    .run(row.id, row.project_id, harness, row.pane_pid, row.session_id, signal, nowMs / 1000,
      resetMs === null ? null : new Date(resetMs).toISOString(), expiresMs / 1000);
}

export function observeClaudeStopFailure(agentId: number, payload: unknown, nowMs: number): void {
  const row = db.prepare("SELECT * FROM agents WHERE id = ? AND status = 'running'").get(agentId) as AgentRow | undefined;
  const input = object(payload);
  if (!row || !["agent", "lead"].includes(row.kind) || harnessFor(row.command).name !== "claude" || input?.error !== "rate_limit") return;
  const owner = currentTranscriptOwner(row);
  if (!owner) return;
  const transcript = typeof input.transcript_path === "string" ? input.transcript_path : owner.transcript_path;
  const expected = transcriptDir(owner.cwd);
  if (!transcript || !isWithin(expected, transcript)) return;
  const sessionId = typeof input.session_id === "string" ? input.session_id : owner.session_id;
  if (!sessionId || (owner.session_id && sessionId !== owner.session_id)) return;
  const text = typeof input.last_assistant_message === "string" ? input.last_assistant_message : "";
  const records = parsedLines(transcript);
  const latestAssistant = last(records.filter((record) => record.type === "assistant"));
  if (typeof latestAssistant?.sessionId === "string" && latestAssistant.sessionId !== sessionId) return;
  const rejected = latestAssistant?.error === "rate_limit" && latestAssistant.isApiErrorMessage === true &&
    object(latestAssistant.quotaLimits)?.status === "rejected" ? latestAssistant : undefined;
  if (!rejected && !/(?:session|weekly|opus|sonnet|usage) limit|limit resets/i.test(text)) return;
  const reset = object(rejected?.quotaLimits)?.resetsAt;
  const resetMs = typeof reset === "number" && Number.isFinite(reset) && reset > 0
    ? reset * 1000
    : parseResetText(text, nowMs);
  const signal = `claude:${sessionId}:${createHash("sha256").update(JSON.stringify(rejected ?? text)).digest("hex")}`;
  writeEpisode(owner, "claude", signal, resetMs, nowMs);
}

export function observeUsageLimit(agentId: number, nowMs: number): void {
  const row = db.prepare("SELECT * FROM agents WHERE id = ? AND status = 'running'").get(agentId) as AgentRow | undefined;
  if (!row || !["agent", "lead"].includes(row.kind)) return;
  const owner = currentTranscriptOwner(row);
  if (!owner) return;
  const harness = harnessFor(row.command).name;
  const evidence = harness === "claude" ? claudeEvidence(owner, nowMs) : harness === "codex" ? codexEvidence(owner) : null;
  const existing = db.prepare("SELECT * FROM agent_usage_limits WHERE agent_id = ?").get(agentId) as Episode | undefined;
  if (existing && (existing.project_id !== owner.project_id || existing.pane_pid !== owner.pane_pid || existing.session_id !== owner.session_id)) {
    db.prepare(`UPDATE agent_usage_limits SET released_at = datetime(?, 'unixepoch')
      WHERE agent_id = ? AND project_id = ? AND pane_pid = ? AND session_id = ? AND released_at IS NULL
        AND EXISTS (
          SELECT 1 FROM agents a
          WHERE a.id = ? AND a.project_id = ? AND a.pane_pid = ? AND a.status = 'running'
            AND ((a.kind = 'agent' AND a.session_id = ?) OR (a.kind = 'lead' AND EXISTS (
              SELECT 1 FROM lead_turn_state t
              WHERE t.agent_id = a.id AND t.pane_pid = a.pane_pid AND t.session_id = ?
            )))
        )`)
      .run(nowMs / 1000, agentId, existing.project_id, existing.pane_pid, existing.session_id,
        owner.id, owner.project_id, owner.pane_pid, owner.session_id, owner.session_id);
  }
  if (evidence?.progressed && existing?.released_at === null && existing.project_id === owner.project_id &&
      existing.pane_pid === owner.pane_pid && existing.session_id === owner.session_id) {
    db.prepare(`UPDATE agent_usage_limits SET released_at = datetime(?, 'unixepoch')
      WHERE agent_id = ? AND project_id = ? AND pane_pid = ? AND session_id = ? AND released_at IS NULL
        AND EXISTS (
          SELECT 1 FROM agents a
          WHERE a.id = ? AND a.project_id = ? AND a.pane_pid = ? AND a.status = 'running'
            AND ((a.kind = 'agent' AND a.session_id = ?) OR (a.kind = 'lead' AND EXISTS (
              SELECT 1 FROM lead_turn_state t
              WHERE t.agent_id = a.id AND t.pane_pid = a.pane_pid AND t.session_id = ?
            )))
        )`)
      .run(nowMs / 1000, agentId, existing.project_id, existing.pane_pid, existing.session_id,
        owner.id, owner.project_id, owner.pane_pid, owner.session_id, owner.session_id);
    return;
  }
  if (!evidence?.signal) return;
  writeEpisode(owner, harness, evidence.signal, evidence.resetMs, nowMs);
}

export function usageLimitGate(agentId: number, nowMs: number): { held: boolean; until: string | null } {
  const episode = db.prepare("SELECT expires_at, released_at FROM agent_usage_limits WHERE agent_id = ?")
    .get(agentId) as Pick<Episode, "expires_at" | "released_at"> | undefined;
  const until = episode?.expires_at ?? null;
  return { held: episode?.released_at == null && (timestamp(until) ?? 0) > nowMs, until };
}

export function limitedHarness(projectId: number, harness: string, nowMs: number): { until: string } | null {
  const row = db.prepare(`SELECT u.expires_at FROM agent_usage_limits u JOIN agents a ON a.id = u.agent_id
    WHERE u.project_id = ? AND u.harness = ? AND u.released_at IS NULL AND a.status = 'running'
    ORDER BY u.expires_at, u.agent_id LIMIT 1`).get(projectId, harness) as { expires_at: string } | undefined;
  return row && (timestamp(row.expires_at) ?? 0) > nowMs ? { until: row.expires_at } : null;
}

export function observeProjectUsageLimits(projectId: number, harness: string, nowMs: number): void {
  const rows = db.prepare(`SELECT id FROM agents WHERE project_id = ? AND status = 'running' AND kind IN ('agent', 'lead')`)
    .all(projectId) as { id: number }[];
  for (const row of rows) {
    const current = db.prepare("SELECT command FROM agents WHERE id = ?").get(row.id) as { command: string } | undefined;
    if (current && harnessFor(current.command).name === harness) observeUsageLimit(row.id, nowMs);
  }
}

export async function continueLimitedCodexWorkers(nowMs: number): Promise<void> {
  const workers = db.prepare("SELECT id, command FROM agents WHERE status = 'running' AND kind = 'agent'")
    .all() as { id: number; command: string }[];
  for (const worker of workers) {
    if (harnessFor(worker.command).name === "codex") observeUsageLimit(worker.id, nowMs);
  }
  const due = db.prepare(`SELECT u.agent_id, u.signal_key FROM agent_usage_limits u
    JOIN agents a ON a.id = u.agent_id
    WHERE u.harness = 'codex' AND u.reset_at IS NOT NULL AND julianday(u.reset_at) <= julianday(datetime(?, 'unixepoch'))
      AND u.continue_claimed_at IS NULL AND u.released_at IS NULL AND a.kind = 'agent' AND a.status = 'running'
    ORDER BY u.expires_at, u.agent_id`).all(nowMs / 1000) as { agent_id: number; signal_key: string }[];
  for (const candidate of due) {
    try {
      const row = db.prepare("SELECT * FROM agents WHERE id = ? AND kind = 'agent' AND status = 'running'")
        .get(candidate.agent_id) as AgentRow | undefined;
      if (!row || harnessFor(row.command).name !== "codex" || awaitingFirstPrompt(row)) continue;
      if (readHandoffGate(row.id)?.holdAutomation) continue;
      const episode = db.prepare("SELECT * FROM agent_usage_limits WHERE agent_id = ? AND signal_key = ?")
        .get(row.id, candidate.signal_key) as Episode | undefined;
      if (!episode || episode.project_id !== row.project_id || episode.pane_pid !== row.pane_pid ||
          episode.session_id !== row.session_id || episode.reset_at === null || episode.released_at !== null ||
          (timestamp(episode.reset_at) ?? Infinity) > nowMs || episode.continue_claimed_at !== null) continue;
      const snapshot = liveTargets();
      if (rowOwnership(row, snapshot) !== "live") continue;
      const classifier = harnessFor(row.command).paneClassifier;
      if (!classifier || !limitStillVisible(row.tmux_target, classifier, true)) continue;
      const lease = tryAcquirePaneLease(row.project_id, row.tmux_socket, row.tmux_target, {
        id: `hive:usage-limit:${row.id}`,
        name: "hive usage-limit continuation",
        kind: "scheduler",
      });
      if (lease === null) continue;
      try {
        const current = db.prepare("SELECT * FROM agents WHERE id = ? AND kind = 'agent' AND status = 'running'")
          .get(row.id) as AgentRow | undefined;
        const currentEpisode = db.prepare("SELECT * FROM agent_usage_limits WHERE agent_id = ? AND signal_key = ?")
          .get(row.id, candidate.signal_key) as Episode | undefined;
        if (!current || current.tmux_target !== row.tmux_target || current.pane_pid !== row.pane_pid ||
            current.tmux_socket !== row.tmux_socket || current.session_id !== row.session_id ||
            awaitingFirstPrompt(current) || !currentEpisode || currentEpisode.continue_claimed_at !== null ||
            currentEpisode.released_at !== null || currentEpisode.reset_at === null ||
            (timestamp(currentEpisode.reset_at) ?? Infinity) > nowMs || readHandoffGate(row.id)?.holdAutomation ||
            rowOwnership(current, liveTargets()) !== "live" || !limitStillVisible(row.tmux_target, classifier, true)) continue;
        const claim = db.prepare(`UPDATE agent_usage_limits SET continue_claimed_at = datetime(?, 'unixepoch')
          WHERE agent_id = ? AND signal_key = ? AND harness = 'codex'
            AND julianday(reset_at) <= julianday(datetime(?, 'unixepoch'))
            AND continue_claimed_at IS NULL AND released_at IS NULL`)
          .run(nowMs / 1000, row.id, candidate.signal_key, nowMs / 1000);
        if (claim.changes !== 1) continue;
        let pasted = false;
        await sendText(row.tmux_target, "continue", true, () => { pasted = true; }, undefined, () => {
          const latest = db.prepare("SELECT * FROM agents WHERE id = ? AND kind = 'agent' AND status = 'running'")
            .get(row.id) as AgentRow | undefined;
          if (!latest || latest.tmux_target !== row.tmux_target || latest.pane_pid !== row.pane_pid ||
              latest.tmux_socket !== row.tmux_socket || latest.session_id !== row.session_id ||
              rowOwnership(latest, liveTargets()) !== "live" || awaitingFirstPrompt(latest) ||
              readHandoffGate(row.id)?.holdAutomation ||
              !limitStillVisible(row.tmux_target, classifier, !pasted, pasted ? "continue" : undefined)) {
            throw new Error("Codex usage-limit continuation lost its live-pane, assignment, or visible-limit guard");
          }
        });
        await sleep(PANE_LEASE_SETTLE_MS);
      } finally {
        releasePaneLease(row.project_id, row.tmux_socket, row.tmux_target, lease);
      }
    } catch (error) {
      console.error(`[usage-limit] Codex continuation for agent ${candidate.agent_id} was claimed and will not be retried: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function limitStillVisible(
  target: string,
  classifier: ReturnType<typeof harnessFor>["paneClassifier"],
  requireEmpty: boolean,
  ownSubmittedText?: string,
): boolean {
  if (!classifier) return false;
  if (paneInCopyMode(target) !== false) return false;
  const choice = classifier.choiceCheck(target).awaitingChoice;
  if (choice !== false) return false;
  if (requireEmpty) {
    const box = classifier.inputBoxState(target);
    if (box?.state !== "empty") return false;
  } else if (ownSubmittedText !== undefined) {
    const box = classifier.inputBoxState(target);
    if (box?.state !== "empty" && (box?.state !== "pending" || box.text !== ownSubmittedText)) return false;
  }
  try {
    return /hit your usage limit/i.test(capturePane(target, 80));
  } catch {
    return false;
  }
}

