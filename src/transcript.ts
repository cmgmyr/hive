import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

// Mirrors cli.ts's claudeConfigDir(): Claude Code relocates its whole state
// tree, transcripts included, when CLAUDE_CONFIG_DIR is set. Duplicated
// rather than imported, on purpose: src/cli.ts belongs to issue #16 for this
// wave, and importing it here would drag the CLI's own module graph (readline,
// spawnSync, and db.js's module-load-time store choice) into every MCP server
// process just to read one env var. Unify the two after #16 merges; until
// then this is the CLAUDE_CONFIG_DIR half of that function, kept in sync by
// hand.
function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR ? resolve(process.env.CLAUDE_CONFIG_DIR) : join(homedir(), ".claude");
}

// Claude Code's own project-transcript encoding (issue #5), reverse-engineered
// against real directories under ~/.claude/projects rather than assumed:
// every `/` and every `.` in the absolute cwd becomes `-`. `/.claude` in a
// worktree path is therefore two dashes, one per character, not one merged
// separator. This is a private convention of Claude Code, not a documented
// API -- resolveTranscriptDir below is what keeps that honest.
export function transcriptDirName(cwd: string): string {
  return cwd.replace(/[/.]/g, "-");
}

export function transcriptDir(cwd: string): string {
  return join(claudeConfigDir(), "projects", transcriptDirName(cwd));
}

// D5: a heuristic that admits it, and admits it precisely. The stat below
// proves only "a directory by this name exists", not "this is that worker's
// transcript" -- the encoding is not injective, since both `/` and `.`
// collapse to the same `-`, so "/a/b.c" and "/a/b/c" both encode to
// "-a-b-c". A stat cannot tell a directory that exists for a colliding cwd
// from one that exists for this one; nothing on hive's side can, since the
// encoding belongs to Claude Code and hive only reads it. What this function
// CAN rule out, and the only thing it claims, is the absent case: null means
// nothing was ever written under this name.
export function resolveTranscriptDir(cwd: string): string | null {
  const dir = transcriptDir(cwd);
  return existsSync(dir) ? dir : null;
}
