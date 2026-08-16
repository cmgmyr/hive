import { existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { dataDir } from "./db.js";
import { shellQuote } from "./tmux.js";

export function ensureHooksFile(): string {
  const hookScript = join(dirname(fileURLToPath(import.meta.url)), "hook.js");

  if (!existsSync(process.execPath)) {
    throw new Error(
      `hive: this process's own interpreter (${process.execPath}) no longer exists on disk; refusing to register worker-state hooks under a path that would start nothing.`,
    );
  }
  const node = shellQuote(process.execPath);
  const cmd = (event: string) => ({
    hooks: [{ type: "command", command: `${node} ${shellQuote(hookScript)} ${event}` }],
  });
  const settings = {
    hooks: {
      Stop: [cmd("stop")],
      UserPromptSubmit: [cmd("prompt")],
      Notification: [cmd("notify")],
    },
  };
  const path = join(dataDir, "hooks.json");
  writeFileSync(path, JSON.stringify(settings, null, 2) + "\n");
  return path;
}
