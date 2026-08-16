import { homedir } from "node:os";
import { join, resolve } from "node:path";

export function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR ? resolve(process.env.CLAUDE_CONFIG_DIR) : join(homedir(), ".claude");
}
