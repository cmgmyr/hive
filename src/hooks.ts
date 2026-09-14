import { existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { dataDir, db } from "./db.js";
import { shellQuote } from "./tmux.js";
import type { ContextRecordKind } from "./transcript.js";
import { effectiveClaudeStatusLine, statusLineEntry } from "./statusline.js";

export interface HookEntry {
  hooks: { type: string; command: string }[];
}

// The single builder every generated hooks file wires an event through - reused by ensureHooksFile
// (claude, one file per store) and ensureCodexHooksFile (codex, one file per worker CODEX_HOME),
// so the two can never drift into different nesting for the same event name. See
// .claude/skills/hive-internals/references/tmux-and-panes.md, "the hooks.json schema trap".
export function hookEntry(event: string, contextRecord?: ContextRecordKind): HookEntry {
  const hookScript = join(dirname(fileURLToPath(import.meta.url)), "hook.js");
  if (!existsSync(process.execPath)) {
    throw new Error(
      `hive: this process's own interpreter (${process.execPath}) no longer exists on disk; refusing to register worker-state hooks under a path that would start nothing.`,
    );
  }
  const node = shellQuote(process.execPath);
  return { hooks: [{ type: "command", command: `${node} ${shellQuote(hookScript)} ${event}${contextRecord ? ` ${contextRecord}` : ""}` }] };
}

export function ensureHooksFile(): string {
  const settings = stateHookSettings();
  const path = join(dataDir, "hooks.json");
  writeFileSync(path, JSON.stringify(settings, null, 2) + "\n");
  return path;
}

function stateHookSettings(): { hooks: Record<string, HookEntry[]> } {
  return {
    hooks: {
      Stop: [hookEntry("stop")],
      UserPromptSubmit: [hookEntry("prompt")],
      Notification: [hookEntry("notify")],
      SessionEnd: [hookEntry("session_end")],
    },
  };
}

export function ensureWorkerHooksFile(agentId: number, options: { includePostToolUse: boolean }): string {
  const worker = db.prepare("SELECT cwd FROM agents WHERE id = ? AND kind = 'agent'").get(agentId) as { cwd: string } | undefined;
  if (!worker) throw new Error(`hive: worker ${agentId} does not exist`);
  const settings = {
    ...stateHookSettings(),
    statusLine: statusLineEntry(effectiveClaudeStatusLine(worker.cwd)),
    permissions: { deny: ["SendMessage", "ListAgents"] },
    crossSessionInbound: "refuse",
  };
  if (options.includePostToolUse) settings.hooks.PostToolUse = [hookEntry("post_tool_use", "claude")];
  const path = join(dataDir, `worker-${agentId}-hooks.json`);
  writeFileSync(path, JSON.stringify(settings, null, 2) + "\n");
  return path;
}
