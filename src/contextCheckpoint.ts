import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { storeDir } from "./dataDir.js";
import { readContextFill, type ContextFill } from "./transcript.js";

export function contextCheckpointAdditionalContext(actorId: string, thresholdPercent: number, fill: ContextFill): string | null {
  if (!actorId.startsWith("agent:") || !Number.isInteger(thresholdPercent) || thresholdPercent < 1 || thresholdPercent > 100) return null;
  if (!Number.isSafeInteger(fill.used_tokens) || fill.used_tokens < 0 || !Number.isSafeInteger(fill.window_tokens) || fill.window_tokens <= 0) return null;
  try {
    const path = join(storeDir(), "context-checkpoints", `${encodeURIComponent(actorId)}.fired`);
    if (fill.used_tokens * 100 < fill.window_tokens * thresholdPercent) {
      if (existsSync(path)) unlinkSync(path);
      return null;
    }
    if (existsSync(path)) return null;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "", { flag: "wx", mode: 0o600 });
    return `Context is at ${fill.used_percent}% of its ${fill.window_tokens}-token window; the configured checkpoint threshold is ${thresholdPercent}%.`;
  } catch {
    return null;
  }
}

export function runContextCheckpointHook(kind: string | undefined): void {
  const thresholdText = process.env.HIVE_CONTEXT_CHECKPOINT_PERCENT;
  if (!thresholdText || !/^\d+$/.test(thresholdText)) return;
  const threshold = Number(thresholdText);
  if (!Number.isInteger(threshold) || threshold < 1 || threshold > 100) return;
  const actorId = process.env.HIVE_AGENT_ID ?? "";
  if (!actorId.startsWith("agent:") || (kind !== "claude" && kind !== "codex")) return;
  try {
    const payload = JSON.parse(readFileSync(0, "utf8"));
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return;
    const fill = readContextFill(kind, {
      actor_id: actorId,
      cwd: typeof payload.cwd === "string" ? payload.cwd : "",
      session_id: typeof payload.session_id === "string" ? payload.session_id : "",
      transcript_path: typeof payload.transcript_path === "string" ? payload.transcript_path : "",
    });
    if (fill === null) return;
    const additionalContext = contextCheckpointAdditionalContext(actorId, threshold, fill);
    if (additionalContext !== null) {
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext } }));
    }
  } catch {}
}
