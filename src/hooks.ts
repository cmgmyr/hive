import { existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { dataDir } from "./db.js";
import { shellQuote } from "./tmux.js";

export interface HookEntry {
  hooks: { type: string; command: string }[];
}

// The single builder every generated hooks file wires an event through - reused by ensureHooksFile
// (claude, one file per store) and ensureCodexHooksFile (codex, one file per worker CODEX_HOME),
// so the two can never drift into different nesting for the same event name. See
// .claude/skills/hive-internals/references/tmux-and-panes.md, "the hooks.json schema trap".
export function hookEntry(event: string): HookEntry {
  const hookScript = join(dirname(fileURLToPath(import.meta.url)), "hook.js");
  if (!existsSync(process.execPath)) {
    throw new Error(
      `hive: this process's own interpreter (${process.execPath}) no longer exists on disk; refusing to register worker-state hooks under a path that would start nothing.`,
    );
  }
  const node = shellQuote(process.execPath);
  return { hooks: [{ type: "command", command: `${node} ${shellQuote(hookScript)} ${event}` }] };
}

export function ensureHooksFile(): string {
  const settings = {
    hooks: {
      Stop: [hookEntry("stop")],
      UserPromptSubmit: [hookEntry("prompt")],
      Notification: [hookEntry("notify")],
      SessionEnd: [hookEntry("session_end")],
    },
  };
  const path = join(dataDir, "hooks.json");
  writeFileSync(path, JSON.stringify(settings, null, 2) + "\n");
  return path;
}
