import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
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

  // Overridable only for tests - production spawns never set this, so it always resolves to
  // Chris's real ~/.codex/auth.json.
  authSource?: string;

  // Overridable only for tests - production spawns never set this, so it always resolves to
  // Chris's real ~/.codex/config.toml. Read-only, and only individually named keys are ever pulled
  // out of it (status_line under [tui]; model_context_window and model_auto_compact_token_limit at
  // the top level - see readRealConfig below): the decision record
  // (.agents/sessions/decisions/2026-08-24-copy-named-keys-into-a-codex-worker-config-never-merge.md)
  // is the reason this must never become "parse and merge the whole file" - that reintroduces the
  // hook-merge hazard per-worker homes exist to avoid.
  realConfigSource?: string;

  // Set only for a codex LEAD's home (src/cli.ts cmdLead), never a worker's: wires SessionStart to
  // `hive kickoff --codex` the same way ensureHooksFile wires it for a claude lead's shared hooks
  // file. A worker never gets this - kickoff.ts's evaluate() already no-ops for a worker session
  // (HIVE_AGENT_ID set, HIVE_LEAD unset), so wiring it there would fire and do nothing on every
  // worker turn for no reason.
  lead?: boolean;
}

export function codexHomeDir(key: string): string {
  return join(storeDir(), "codex-homes", key);
}

// Removes a per-worker home OUTRIGHT, never its resolved contents: `rmSync` unlinks the directory
// entries it finds - including the auth.json SYMLINK - without ever following one to its target, so
// Chris's real ~/.codex/auth.json is untouched regardless of what points at it from here. Prove any
// change to this function against a real file behind a real symlink, not just against an empty dir.
export function reapCodexHome(key: string): void {
  rmSync(codexHomeDir(key), { recursive: true, force: true });
}

// todo 532's design checkpoint, so the next reader finds the reason rather than re-running it:
// codex 0.149.0 (checked live via `codex exec --strict-config`, not `doctor` - doctor silently
// ignores unrecognized top-level config.toml fields even under --strict-config) has exactly three
// redirectable paths: `sqlite_home`, `log_dir`, `model_catalog_json` (plus CODEX_SQLITE_HOME). None
// are wired here, on purpose:
//   - plugins/ and cache/ are the dominant cost (26 MB+ of a fresh, work-free home) and have NO
//     redirect at all - every plausible key (plugins_dir, cache_dir, cache_path, plugins_enabled,
//     ...) and every CODEX_* env var in the binary was checked; none exist in this version.
//   - sqlite_home is the one big redirect that DOES exist, but it backs codex's own session/
//     goals/memories tables. Pointing every worker's CODEX_HOME at ONE shared sqlite_home would
//     merge their session history into a single store - a worker-isolation regression, not a disk
//     optimization, for a few MB of WAL that isn't the actual cost.
//   - model_catalog_json (192-309k, OpenAI's public model list, no per-worker content) is the only
//     genuinely safe share, and it is under 1% of a home's footprint - not worth the extra moving
//     part. Reaping the whole home on close is the fix; see reapCodexHomeForClosedAgent (spawn.ts).

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

// Not built via hooks.ts's hookEntry(), which this lane does not own: points at kickoff.js
// directly (matching hookEntry's own direct-node-plus-script shape, not the `hive` PATH shim) so a
// codex lead's SessionStart hook survives the same minimal-PATH environments hookEntry's own
// comment warns about, rather than gaining a new dependency on `hive` resolving on PATH.
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

// Verified against codex 0.149.0 (todo 560 comment 1948, `codex exec --strict-config`): included in
// Chris's own real status_line, so known to be a value codex accepts here.
const HIVE_DEFAULT_STATUS_LINE = ["context-used"];

// Parses the real config exactly once so every named-key reader below shares one read. Missing
// file or unparseable TOML are the ordinary case (no config yet, or a shape codex itself would
// reject) - callers treat a null return exactly like "the key was absent", never a throw.
function readRealConfig(realConfigPath: string): Record<string, unknown> | null {
  if (!existsSync(realConfigPath)) return null;
  try {
    return parseToml(readFileSync(realConfigPath, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// Pulls ONLY [tui].status_line out of the real config - never the rest of that table (it also
// carries [tui.model_availability_nux], which is not a display key) and never any other top-level
// table. A status_line that is not a string array is the same ordinary case as it being absent.
function realStatusLine(realConfig: Record<string, unknown> | null): string[] | null {
  const statusLine = (realConfig as { tui?: { status_line?: unknown } } | null)?.tui?.status_line;
  if (!Array.isArray(statusLine) || !statusLine.every((v) => typeof v === "string")) return null;
  return statusLine as string[];
}

// Pulls a single top-level integer key out of the real config - model_context_window and
// model_auto_compact_token_limit both live there (verified live against Chris's own
// ~/.codex/config.toml), never under [tui]. Both are display/behavior keys, not hooks, so the
// 2026-08-24 decision's distinction (executable keys are the hook-merge hazard; display/behavior
// keys are safe to copy individually) covers copying them the same way it covers status_line. A
// missing key or a non-integer value is the ordinary "not set" case: return null so the caller
// omits the key and codex applies its own built-in default, never a throw or a partial write.
function realTopLevelInteger(realConfig: Record<string, unknown> | null, key: string): number | null {
  const value = realConfig?.[key];
  return typeof value === "number" && Number.isInteger(value) ? value : null;
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
  statusLine: string[];
  modelContextWindow: number | null;
  modelAutoCompactTokenLimit: number | null;
}): string {
  return (
    [
      `developer_instructions = ${tomlMultilineString(input.developerInstructions)}`,
      // Verified real (todo 560 comment 1948): makes codex fall back to CLAUDE.md as the project doc
      // when a project has no AGENTS.md, rather than a worker silently knowing nothing about the
      // project. Always set - unlike status_line, this is hive's own default, not copied from
      // anywhere.
      `project_doc_fallback_filenames = ${tomlStringArray(["CLAUDE.md"])}`,
      // Copied from the real config's own top-level keys when set (realTopLevelInteger above) -
      // never a hive default, unlike status_line: there is no context window size hive could sanely
      // choose on the user's behalf. Omitted entirely when absent or malformed, so codex applies its
      // own built-in default rather than this module ever emitting a partial or invalid value.
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
      // Verified real (todo 560 comment 1948): status_line is only accepted here, under [tui] - a
      // top-level status_line is an unknown field under --strict-config. Value comes from
      // realStatusLine() above: the real config's own [tui].status_line when set, else
      // HIVE_DEFAULT_STATUS_LINE.
      `[tui]`,
      `status_line = ${tomlStringArray(input.statusLine)}`,
    ].join("\n") + "\n"
  );
}

// The launch flags a codex invocation needs whenever it is about to read a per-worker home this
// module generated: hook-trust bypass, sandbox bypass, and the directory that seeds config.toml's
// own [projects.<root>] trust. Pure - computes and writes nothing - so agent_resume (src/tools/
// agents.ts, todo 563) can reuse it against an EXISTING home without re-running ensureCodexHome's
// file-writing half.
export function codexLaunchArgs(cwd: string): string[] {
  const root = gitPrimaryRoot(cwd);
  const commonDir = root ? join(root, ".git") : null;
  return [
    // Declining review of hive's OWN generated hooks.json, not a stranger's - see the reference.
    "--dangerously-bypass-hook-trust",
    // Not parity with claude's posture, and --add-dir below is NOT containment - see the
    // reference: both claims were wrong in an earlier version of this comment.
    "--dangerously-bypass-approvals-and-sandbox",
    // Inert alongside the flag above (see the reference) but kept: free, correct if a sandbox is
    // ever on, and its value also seeds config.toml's [projects.<root>] trust above.
    ...(commonDir ? ["--add-dir", commonDir] : []),
  ];
}

// Generates a codex worker's per-worker home: auth.json symlinked (never copied) to the real
// ~/.codex/auth.json, hooks.json, and config.toml. Returns the launch flags this harness requires.
export function ensureCodexHome(input: CodexHomeInput): { extraArgs: string[] } {
  // Every guard that can refuse this call runs BEFORE the first byte touches disk - two reviewers
  // independently found the previous ordering (this check sat after hooks.json/config.toml, so a
  // vanished interpreter still left auth.json and skills/cleanup written) leaves a partial home
  // that cmdLead's own try/catch (see the caller) cannot distinguish from a real one to reap by
  // key alone. The try/catch is defence in depth, not a reason to leave the ordering as-is.
  if (!existsSync(process.execPath)) {
    throw new Error(
      `hive: this process's own interpreter (${process.execPath}) no longer exists on disk; refusing to register a codex worker's MCP server under a path that would start nothing.`,
    );
  }

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

  // Lead-only, matching SessionStart above: a codex lead needs the same cleanup skill a claude
  // lead reaches through the installed plugin (claude-plugin/skills/cleanup). Only the "cleanup"
  // entry is touched - never the skills/ directory itself - so codex's own .system subdirectory
  // there survives untouched, the same reapCodexHome/auth.json symlink discipline as above.
  if (input.lead) {
    const cleanupSource = join(dirname(fileURLToPath(import.meta.url)), "..", "claude-plugin", "skills", "cleanup");
    // Codex derives the skill's namespace (`hive:cleanup`) from the plugin root this symlink
    // points into, so a dangling link does not just lose the skill quietly - it loses the
    // namespaced name a user would type. Fail fast, the same shape authSource gets above.
    if (!existsSync(cleanupSource)) {
      throw new Error(`hive: cleanup skill not found at ${cleanupSource}; this checkout's claude-plugin/ is missing or incomplete.`);
    }
    const skillsDir = join(home, "skills");
    mkdirSync(skillsDir, { recursive: true });
    const cleanupLink = join(skillsDir, "cleanup");
    rmSync(cleanupLink, { force: true });
    symlinkSync(cleanupSource, cleanupLink);
  }

  // prompt/stop: R4 proved exact. SubagentStart/SubagentStop: todo 525 (C3) rekeys the subagent
  // latch to these instead of the Stop payload's background_tasks, which codex never sends. No
  // Notification, no PermissionRequest - the notify branch is proven unreachable for codex on
  // purpose (test/codex-notify-unreachable.test.mjs); blocked-on-human comes from the pane title.
  writeFileSync(
    join(home, "hooks.json"),
    JSON.stringify(
      {
        hooks: {
          ...(input.lead ? { SessionStart: [kickoffHookEntry()] } : {}),
          Stop: [hookEntry("stop")],
          UserPromptSubmit: [hookEntry("prompt")],
          SubagentStart: [hookEntry("subagent_start")],
          SubagentStop: [hookEntry("subagent_stop")],
        },
      },
      null,
      2,
    ) + "\n",
  );

  const indexJs = join(dirname(fileURLToPath(import.meta.url)), "index.js");

  // Reuses context.ts's own worktree-aware root resolution rather than a second implementation.
  const projectRoot = gitPrimaryRoot(input.cwd) ?? input.cwd;

  const realConfigPath = input.realConfigSource ?? join(homedir(), ".codex", "config.toml");
  const realConfig = readRealConfig(realConfigPath);
  const statusLine = realStatusLine(realConfig) ?? HIVE_DEFAULT_STATUS_LINE;
  const modelContextWindow = realTopLevelInteger(realConfig, "model_context_window");
  const modelAutoCompactTokenLimit = realTopLevelInteger(realConfig, "model_auto_compact_token_limit");

  writeFileSync(
    join(home, "config.toml"),
    configToml({
      developerInstructions: input.brief,
      projectRoot,
      nodeBin: process.execPath,
      indexJs,
      actorId: input.actorId,
      statusLine,
      modelContextWindow,
      modelAutoCompactTokenLimit,
    }),
  );

  return { extraArgs: codexLaunchArgs(input.cwd) };
}
