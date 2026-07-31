import { homedir } from "node:os";
import { join, resolve } from "node:path";

// Claude Code relocates its whole state tree -- transcripts, plugins,
// everything -- when CLAUDE_CONFIG_DIR is set. Keying off homedir() alone
// reports "not installed" to anyone using a custom config dir, points an
// install command at a symlink their claude will never look at, and resolves
// a worker's transcript directory to a path Claude Code never wrote.
//
// A module of its own rather than living in cli.ts, which is where both
// callers used to duplicate it: nothing in src/ imports cli.ts today, and
// cli.ts drags readline, spawnSync and db.js's module-load-time store choice
// into whatever imports it, a cost every MCP server process would otherwise
// pay to read one env var.
export function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR ? resolve(process.env.CLAUDE_CONFIG_DIR) : join(homedir(), ".claude");
}
