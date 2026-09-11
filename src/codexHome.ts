import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseToml } from "smol-toml";
import { gitPrimaryRoot } from "./context.js";
import { storeDir } from "./dataDir.js";
import { hookEntry } from "./hooks.js";
import { shellQuote } from "./tmux.js";

export interface CodexHomeInput {
  key: string;
  actorId: string;
  cwd: string;
  brief: string;

  // Tests only; production never sets it, so it resolves to the real ~/.codex/auth.json.
  authSource?: string;

  // Tests only, as above. Read-only, and NEVER parse-and-merge the whole file: copy named keys
  // one at a time, or the hook-merge hazard per-worker homes exist to avoid comes back.
  realConfigSource?: string;

  // Lead homes only: wires SessionStart to kickoff. A worker's evaluate() no-ops anyway, so
  // wiring it there would fire and do nothing every turn.
  lead?: boolean;
  includePostToolUse?: boolean;
}

export function codexHomeDir(key: string): string {
  return join(storeDir(), "codex-homes", key);
}

export function codexRolloutsDir(key: string): string {
  return join(storeDir(), "codex-rollouts", key);
}

// undefined means transcriptPath does not point inside this home's sessions/.
export function preservedRolloutPath(key: string, transcriptPath: string): string | undefined {
  const sessionsPrefix = `${join(codexHomeDir(key), "sessions")}/`;
  if (!transcriptPath.startsWith(sessionsPrefix)) return undefined;
  return join(codexRolloutsDir(key), transcriptPath.slice(sessionsPrefix.length));
}

const ROLLOUT_FILE = /^rollout-.*\.jsonl$/;

// Dirent.isFile()/.isDirectory() answer about the entry itself, not its target, so a symlinked
// file or directory under sessions/ is neither and is silently skipped - never followed, never
// moved. That is what keeps this walk off the auth.json symlink without naming it specially.
function collectRolloutFiles(dir: string): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...collectRolloutFiles(full));
    else if (entry.isFile() && ROLLOUT_FILE.test(entry.name)) files.push(full);
  }
  return files;
}

// A throw here must reach reapCodexHome before its rmSync, so a durable root that cannot be
// written leaves the home in place rather than losing the only copy of its rollout.
export function preserveCodexRollouts(key: string): string[] {
  const sessionsDir = join(codexHomeDir(key), "sessions");
  if (!existsSync(sessionsDir)) return [];

  const sources = collectRolloutFiles(sessionsDir);
  const destRoot = codexRolloutsDir(key);
  const moved: string[] = [];

  for (const src of sources) {
    const dest = join(destRoot, relative(sessionsDir, src));
    mkdirSync(dirname(dest), { recursive: true });
    try {
      renameSync(src, dest);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      // ENOENT here is the close/janitor race, not a failure: a concurrent reap of this same key
      // already moved this file. Whichever process's rename won, the file ends up preserved once.
      if (code === "ENOENT") {
        if (existsSync(dest)) moved.push(dest);
        continue;
      }
      if (code === "EXDEV") {
        copyFileSync(src, dest);
        unlinkSync(src);
        moved.push(dest);
        continue;
      }
      throw e;
    }
    moved.push(dest);
  }
  return moved;
}

// Never follow a link out of here: auth.json is a SYMLINK to the real ~/.codex/auth.json, and
// rmSync unlinks entries rather than resolving them. Prove any change against a real symlink.
export function reapCodexHome(key: string): string[] {
  const preserved = preserveCodexRollouts(key);
  rmSync(codexHomeDir(key), { recursive: true, force: true });
  return preserved;
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

// Points at kickoff.js directly, never the `hive` PATH shim: this hook runs in the minimal-PATH
// environments hookEntry already warns about.
function kickoffHookEntry(): { hooks: { type: string; command: string }[] } {
  const kickoffScript = join(dirname(fileURLToPath(import.meta.url)), "kickoff.js");
  const node = shellQuote(process.execPath);
  return { hooks: [{ type: "command", command: `${node} ${shellQuote(kickoffScript)} --codex` }] };
}

function tomlString(s: string): string {
  return `"${tomlEscape(s, { allowLiteralNewline: false })}"`;
}

function tomlStringArray(items: string[]): string {
  return `[${items.map(tomlString).join(", ")}]`;
}

// Verified accepted by codex 0.149.0 under --strict-config.
const HIVE_DEFAULT_STATUS_LINE = ["context-used"];

// null is the ordinary case (no config yet, or TOML codex would reject), never an error.
function readRealConfig(realConfigPath: string): Record<string, unknown> | null {
  if (!existsSync(realConfigPath)) return null;
  try {
    return parseToml(readFileSync(realConfigPath, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// ONLY [tui].status_line, never the rest of that table: it also carries model_availability_nux,
// which is not a display key.
function realStatusLine(realConfig: Record<string, unknown> | null): string[] | null {
  const statusLine = (realConfig as { tui?: { status_line?: unknown } } | null)?.tui?.status_line;
  if (!Array.isArray(statusLine) || !statusLine.every((v) => typeof v === "string")) return null;
  return statusLine as string[];
}

// Top level, never under [tui]. null means "not set", so the caller omits the key and codex
// applies its own default rather than this module writing a partial one.
function realTopLevelInteger(realConfig: Record<string, unknown> | null, key: string): number | null {
  const value = realConfig?.[key];
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function tomlMultilineString(s: string): string {
  // No trailing \n before the closing """, unlike the leading one - round-trips to the exact input.
  return `"""\n${tomlEscape(s, { allowLiteralNewline: true })}"""`;
}

// codex has no AGENTS.local.md/CLAUDE.local.md of its own, so this order mirrors its real
// AGENTS.md-then-project_doc_fallback_filenames precedence rather than inventing a new one.
const LOCAL_OVERRIDE_FILENAMES = ["AGENTS.local.md", "CLAUDE.local.md"];

function readLocalOverride(projectRoot: string): { path: string; text: string } | null {
  for (const name of LOCAL_OVERRIDE_FILENAMES) {
    const path = join(projectRoot, name);
    try {
      return { path, text: readFileSync(path, "utf8") };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  return null;
}

// Names the primary checkout on purpose: a worktree cwd has no copy of this gitignored file, so a
// worker reading its own brief must not go looking for one under its own path.
function localOverrideHeading(path: string): string {
  return `# Repo-local instructions from ${path} (the primary checkout's gitignored file; a worktree cwd has no copy, so do not look for it under your own path)`;
}

export function codexInstructionsPhrase(layers: string[]): string | undefined {
  return layers.length ? `instructions: ${layers.join(", ")}` : undefined;
}

// Must be written before any [section] header, or TOML nests it inside whichever table precedes it -
// accepted silently, delivered to nobody. See tmux-and-panes.md, "the brief-delivery TOML trap".
function configToml(input: {
  developerInstructions: string;
  projectRoot: string;
  nodeBin: string;
  indexJs: string;
  actorId: string;
  statusLine: string[];
  modelContextWindow: number | null;
  modelAutoCompactTokenLimit: number | null;
}): string {
  return (
    [
      `developer_instructions = ${tomlMultilineString(input.developerInstructions)}`,
      // hive's own default, not copied: without it a worker in an AGENTS.md-less project reads no
      // project doc at all.
      `project_doc_fallback_filenames = ${tomlStringArray(["CLAUDE.md"])}`,
      // Copied when set, never defaulted: hive cannot choose a context window on anyone's behalf.
      ...(input.modelContextWindow !== null ? [`model_context_window = ${input.modelContextWindow}`] : []),
      ...(input.modelAutoCompactTokenLimit !== null
        ? [`model_auto_compact_token_limit = ${input.modelAutoCompactTokenLimit}`]
        : []),
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
      "",
      // Only accepted under [tui]; a top-level status_line is an unknown field to --strict-config.
      `[tui]`,
      `status_line = ${tomlStringArray(input.statusLine)}`,
    ].join("\n") + "\n"
  );
}

// Pure on purpose: agent_resume reuses it against an EXISTING home, so it must not write.
export function codexLaunchArgs(cwd: string): string[] {
  const root = gitPrimaryRoot(cwd);
  const commonDir = root ? join(root, ".git") : null;
  return [
    // Declining review of hive's OWN generated hooks.json, not a stranger's - see the reference.
    "--dangerously-bypass-hook-trust",
    // NOT parity with claude's posture, and --add-dir is NOT containment - see the reference.
    "--dangerously-bypass-approvals-and-sandbox",
    // Inert alongside the flag above, kept because its value seeds [projects.<root>] trust.
    ...(commonDir ? ["--add-dir", commonDir] : []),
  ];
}

export function ensureCodexHooksFile(key: string, options: { lead?: boolean; includePostToolUse?: boolean }): string[] {
  // Subagent hooks, not the Stop payload's background_tasks, which codex never sends. No
  // Notification: unreachable for codex by design (test/codex-notify-unreachable.test.mjs).
  const hooks = {
    // A worker's SessionEnd would be a no-op anyway (HIVE_LEAD gates stopProcessesForEndedLead
    // in src/hook.ts), so a worker home carries no hook that can never act.
    ...(options.lead ? { SessionStart: [kickoffHookEntry()], SessionEnd: [hookEntry("session_end")] } : {}),
    ...(!options.lead && options.includePostToolUse ? { PostToolUse: [hookEntry("post_tool_use", "codex")] } : {}),
    Stop: [hookEntry("stop")],
    UserPromptSubmit: [hookEntry("prompt")],
    SubagentStart: [hookEntry("subagent_start")],
    SubagentStop: [hookEntry("subagent_stop")],
  };
  writeFileSync(join(codexHomeDir(key), "hooks.json"), JSON.stringify({ hooks }, null, 2) + "\n");

  return Object.keys(hooks);
}

// Generates a per-worker home: auth.json symlinked (never copied), hooks.json, config.toml.
export function ensureCodexHome(
  input: CodexHomeInput,
): { extraArgs: string[]; hooksWired: string[]; instructionLayers: string[] } {
  // Keep every refusing guard ABOVE the first write: a throw after one leaves a partial home the
  // caller cannot tell from a real one.
  if (!existsSync(process.execPath)) {
    throw new Error(
      `hive: this process's own interpreter (${process.execPath}) no longer exists on disk; refusing to register a codex worker's MCP server under a path that would start nothing.`,
    );
  }

  // Read before any write: a real (non-ENOENT) read error here must not leave a partial home.
  const projectRoot = gitPrimaryRoot(input.cwd) ?? input.cwd;
  const localOverride = readLocalOverride(projectRoot);
  const developerInstructions = localOverride
    ? `${input.brief}\n\n${localOverrideHeading(localOverride.path)}\n\n${localOverride.text}`
    : input.brief;

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

  // GLOBAL layer: the user's own ~/.codex/AGENTS.md. Symlinked, never copied, for the same reason
  // auth.json is - a copy goes stale the moment the real file is edited. Absent is not an error:
  // no link, no message, same as auth.json's presence is required but this is not.
  const globalSource = join(dirname(authSource), "AGENTS.md");
  const globalLink = join(home, "AGENTS.md");
  rmSync(globalLink, { force: true });
  const hasGlobal = existsSync(globalSource);
  if (hasGlobal) symlinkSync(globalSource, globalLink);

  // Touch only the "cleanup" entry, never skills/ itself: codex keeps its own .system there.
  if (input.lead) {
    const cleanupSource = join(dirname(fileURLToPath(import.meta.url)), "..", "claude-plugin", "skills", "cleanup");
    // Codex derives the `hive:cleanup` namespace from the root this link points into, so a
    // dangling link loses the name a user types, not just the skill. Fail fast.
    if (!existsSync(cleanupSource)) {
      throw new Error(`hive: cleanup skill not found at ${cleanupSource}; this checkout's claude-plugin/ is missing or incomplete.`);
    }
    const skillsDir = join(home, "skills");
    mkdirSync(skillsDir, { recursive: true });
    const cleanupLink = join(skillsDir, "cleanup");
    rmSync(cleanupLink, { force: true });
    symlinkSync(cleanupSource, cleanupLink);
  }

  const hooksWired = ensureCodexHooksFile(input.key, input);

  const indexJs = join(dirname(fileURLToPath(import.meta.url)), "index.js");

  const realConfigPath = input.realConfigSource ?? join(homedir(), ".codex", "config.toml");
  const realConfig = readRealConfig(realConfigPath);
  const statusLine = realStatusLine(realConfig) ?? HIVE_DEFAULT_STATUS_LINE;
  const modelContextWindow = realTopLevelInteger(realConfig, "model_context_window");
  const modelAutoCompactTokenLimit = realTopLevelInteger(realConfig, "model_auto_compact_token_limit");

  writeFileSync(
    join(home, "config.toml"),
    configToml({
      developerInstructions,
      projectRoot,
      nodeBin: process.execPath,
      indexJs,
      actorId: input.actorId,
      statusLine,
      modelContextWindow,
      modelAutoCompactTokenLimit,
    }),
  );

  const instructionLayers = [...(hasGlobal ? ["global"] : []), ...(localOverride ? ["local"] : [])];

  return { extraArgs: codexLaunchArgs(input.cwd), hooksWired, instructionLayers };
}
