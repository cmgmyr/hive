import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { claudeConfigDir } from "./claudeDir.js";
import { claudeWindowPath } from "./transcript.js";
import { shellQuote } from "./tmux.js";

export interface ClaudeStatusLine {
  type: "command";
  command: string;
  refreshInterval?: number;
  padding?: number;
  hideVimModeIndicator?: boolean;
}

export function effectiveClaudeStatusLine(cwd: string): ClaudeStatusLine | null {
  let setting: ClaudeStatusLine | null = null;
  for (const path of [
    join(claudeConfigDir(), "settings.json"),
    join(cwd, ".claude", "settings.json"),
    join(cwd, ".claude", "settings.local.json"),
  ]) {
    try {
      const value = JSON.parse(readFileSync(path, "utf8")).statusLine;
      if (value === undefined) continue;
      setting = value?.type === "command" && typeof value.command === "string" ? value : null;
    } catch {}
  }
  return setting;
}

export function recordClaudeWindowSize(actorId: string, statusLineInput: string): void {
  if (!actorId.startsWith("agent:")) return;
  let staging: string | undefined;
  try {
    const size: unknown = JSON.parse(statusLineInput)?.context_window?.context_window_size;
    if (typeof size !== "number" || !Number.isSafeInteger(size) || size <= 0) return;
    const path = claudeWindowPath(actorId);
    const body = JSON.stringify(size) + "\n";
    try {
      if (readFileSync(path, "utf8") === body) return;
    } catch {}
    mkdirSync(dirname(path), { recursive: true });
    staging = `${path}.${randomUUID()}.tmp`;
    writeFileSync(staging, body, { flag: "wx", mode: 0o600 });
    renameSync(staging, path);
  } catch {
  } finally {
    if (staging) {
      try { unlinkSync(staging); } catch {}
    }
  }
}

export function statusLineEntry(userSetting: ClaudeStatusLine | null): ClaudeStatusLine {
  const script = fileURLToPath(import.meta.url);
  return {
    ...userSetting,
    type: "command",
    command: `${shellQuote(process.execPath)} ${shellQuote(script)} ${shellQuote(userSetting?.command ?? "")}`,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const input = readFileSync(0);
    recordClaudeWindowSize(process.env.HIVE_AGENT_ID ?? "", input.toString("utf8"));
    const command = process.argv[2];
    if (command) {
      try {
        process.stdout.write(execFileSync("/bin/sh", ["-c", command], { input, stdio: ["pipe", "pipe", "inherit"] }));
      } catch (error) {
        const stdout = (error as { stdout?: Buffer }).stdout;
        if (stdout) process.stdout.write(stdout);
      }
    }
  } catch {}
}
