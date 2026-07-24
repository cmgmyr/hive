import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { dataDir } from "./db.js";
import { shellQuote } from "./tmux.js";

// Generates the settings file that agent_spawn passes to claude via
// --settings. The hooks report exact session state (working/idle/waiting)
// into the hive DB, replacing output-quiescence heuristics.
export function ensureHooksFile(): string {
  const hookScript = join(dirname(fileURLToPath(import.meta.url)), "hook.js");
  const cmd = (event: string) => ({
    hooks: [{ type: "command", command: `node ${shellQuote(hookScript)} ${event}` }],
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
