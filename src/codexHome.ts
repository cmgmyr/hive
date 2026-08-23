import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gitPrimaryRoot } from "./context.js";
import { storeDir } from "./dataDir.js";
import { hookEntry } from "./hooks.js";

export interface CodexHomeInput {
  key: string;
  actorId: string;
  cwd: string;
  brief: string;

  // Overridable only for tests - production spawns never set this, so it always resolves to
  // Chris's real ~/.codex/auth.json.
  authSource?: string;
}

export function codexHomeDir(key: string): string {
  return join(storeDir(), "codex-homes", key);
}

// Built from character codes, not a literal \u escape range in source - see the reference on why.
const CONTROL_CHAR = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(0x1f)}${String.fromCharCode(0x7f)}]`,
  "g",
);

function tomlEscape(s: string, { allowLiteralNewline }: { allowLiteralNewline: boolean }): string {
  // Order matters: backslash/quote first, or the \u-escapes below get double-escaped.
  const backslashAndQuote = s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return backslashAndQuote.replace(CONTROL_CHAR, (ch) => {
    if (allowLiteralNewline && ch === "\n") return ch;
    if (ch === "\t") return "\\t";
    if (ch === "\n") return "\\n";
    if (ch === "\r") return "\\r";
    return `\\u${ch.codePointAt(0)!.toString(16).padStart(4, "0")}`;
  });
}

function tomlString(s: string): string {
  return `"${tomlEscape(s, { allowLiteralNewline: false })}"`;
}

function tomlMultilineString(s: string): string {
  // No trailing \n before the closing """, unlike the leading one - round-trips to the exact input.
  return `"""\n${tomlEscape(s, { allowLiteralNewline: true })}"""`;
}

// Must be written before any [section] header, or TOML nests it inside whichever table precedes it -
// accepted silently, delivered to nobody. See tmux-and-panes.md, "the brief-delivery TOML trap".
function configToml(input: {
  developerInstructions: string;
  projectRoot: string;
  nodeBin: string;
  indexJs: string;
  actorId: string;
}): string {
  return (
    [
      `developer_instructions = ${tomlMultilineString(input.developerInstructions)}`,
      "",
      `[projects.${tomlString(input.projectRoot)}]`,
      `trust_level = "trusted"`,
      "",
      `[mcp_servers.hive]`,
      `command = ${tomlString(input.nodeBin)}`,
      `args = [${tomlString(input.indexJs)}]`,
      "",
      `[mcp_servers.hive.env]`,
      `HIVE_AGENT_ID = ${tomlString(input.actorId)}`,
    ].join("\n") + "\n"
  );
}

// Generates a codex worker's per-worker home: auth.json symlinked (never copied) to the real
// ~/.codex/auth.json, hooks.json, and config.toml. Returns the launch flags this harness requires.
export function ensureCodexHome(input: CodexHomeInput): { extraArgs: string[] } {
  const home = codexHomeDir(input.key);
  mkdirSync(home, { recursive: true });

  const authSource = input.authSource ?? join(homedir(), ".codex", "auth.json");
  if (!existsSync(authSource)) {
    throw new Error(
      `hive: no codex credentials found at ${authSource}; run \`codex login\` before spawning a codex worker.`,
    );
  }
  const authLink = join(home, "auth.json");
  rmSync(authLink, { force: true });
  symlinkSync(authSource, authLink);

  // Only the two events R4 proved exact (prompt/stop) - the notify redesign and subagent latch are
  // todo 525's (C3's) to prove, not generated speculatively here.
  writeFileSync(
    join(home, "hooks.json"),
    JSON.stringify({ hooks: { Stop: [hookEntry("stop")], UserPromptSubmit: [hookEntry("prompt")] } }, null, 2) + "\n",
  );

  if (!existsSync(process.execPath)) {
    throw new Error(
      `hive: this process's own interpreter (${process.execPath}) no longer exists on disk; refusing to register a codex worker's MCP server under a path that would start nothing.`,
    );
  }
  const indexJs = join(dirname(fileURLToPath(import.meta.url)), "index.js");

  // Reuses context.ts's own worktree-aware root resolution rather than a second implementation.
  const root = gitPrimaryRoot(input.cwd);
  const commonDir = root ? join(root, ".git") : null;
  const projectRoot = root ?? input.cwd;

  writeFileSync(
    join(home, "config.toml"),
    configToml({
      developerInstructions: input.brief,
      projectRoot,
      nodeBin: process.execPath,
      indexJs,
      actorId: input.actorId,
    }),
  );

  return {
    extraArgs: [
      // Declining review of hive's OWN generated hooks.json, not a stranger's - see the reference.
      "--dangerously-bypass-hook-trust",
      // Not parity with claude's posture, and --add-dir below is NOT containment - see the
      // reference: both claims were wrong in an earlier version of this comment.
      "--dangerously-bypass-approvals-and-sandbox",
      // Inert alongside the flag above (see the reference) but kept: free, correct if a sandbox is
      // ever on, and its value also seeds config.toml's [projects.<root>] trust above.
      ...(commonDir ? ["--add-dir", commonDir] : []),
    ],
  };
}
