import { existsSync, statSync } from "node:fs";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DISPATCHER_MARKER = "# hive dispatcher";

export const dispatcherDir = (): string =>
  process.env.HIVE_BIN_DIR || join(homedir(), ".local", "bin");
export const dispatcherPath = (): string => join(dispatcherDir(), "hive");
export const cliPath = (): string => fileURLToPath(new URL("./cli.js", import.meta.url));

function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function dispatcherScript(node: string, cli: string): string {
  return [
    "#!/bin/sh",
    DISPATCHER_MARKER,
    "# Written by `hive setup`. It runs hive under one fixed interpreter, so a",
    "# version manager resolving `node` per directory cannot land hive on a Node",
    "# better-sqlite3's addon refuses to load under.",
    "# Regenerate after every update: npm install && npm run build && hive setup",
    `exec ${shQuote(node)} ${shQuote(cli)} "$@"`,
    "",
  ].join("\n");
}

export type Dispatcher = { file: string; mine: boolean; node: string | null; cli: string | null };

export function readDispatcher(file: string): Dispatcher | null {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  if (!text.includes(DISPATCHER_MARKER)) return { file, mine: false, node: null, cli: null };
  const exec = /^exec '(.*)' '(.*)' "\$@"$/m.exec(text);
  const unquote = (s: string) => s.replace(/'\\''/g, "'");
  return exec
    ? { file, mine: true, node: unquote(exec[1]), cli: unquote(exec[2]) }
    : { file, mine: true, node: null, cli: null };
}

const WORKTREE_PATH_FRAGMENTS = ["/.agents/worktrees/", "/.claude/worktrees/"] as const;

export type WorktreePin = {
  linked: boolean;
  via: "git-file" | "path-fragment" | null;
  durableRoot: string | null;
};

function nearestGitEntry(startDir: string): { path: string; isFile: boolean } | null {
  let dir = startDir;
  for (;;) {
    const gitPath = join(dir, ".git");
    try {
      return { path: gitPath, isFile: statSync(gitPath).isFile() };
    } catch {

    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function gitdirTarget(gitFilePath: string): string | null {
  let text: string;
  try {
    text = readFileSync(gitFilePath, "utf8");
  } catch {
    return null;
  }
  const m = /^gitdir:\s*(.+?)\s*$/m.exec(text);
  return m ? m[1] : null;
}

function worktreeRoot(gitFilePath: string, target: string): string | null {
  const resolved = resolve(dirname(gitFilePath), target);
  if (basename(dirname(resolved)) !== "worktrees" || basename(dirname(dirname(resolved))) !== ".git") return null;
  return dirname(dirname(dirname(resolved)));
}

export function linkedWorktreePin(cli: string): WorktreePin {
  if (existsSync(cli)) {
    const entry = nearestGitEntry(dirname(cli));
    if (entry?.isFile) {
      const target = gitdirTarget(entry.path);
      const root = target ? worktreeRoot(entry.path, target) : null;
      if (root) return { linked: true, via: "git-file", durableRoot: root };
    }
    return { linked: false, via: null, durableRoot: null };
  }
  const fragment = WORKTREE_PATH_FRAGMENTS.some((f) => cli.includes(f));
  return fragment
    ? { linked: true, via: "path-fragment", durableRoot: null }
    : { linked: false, via: null, durableRoot: null };
}

export function firstHiveOnPath(): string | null {
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (!dir) continue;
    const candidate = join(dir, "hive");
    try {
      if (statSync(candidate).mode & 0o111) return candidate;
    } catch {

    }
  }
  return null;
}

const VERSION_MANAGER_DIRS = [
  ["/.asdf/", "asdf"],
  ["/.nvm/", "nvm"],
  ["/.volta/", "volta"],
  ["/.fnm/", "fnm"],
  ["/fnm_multishells/", "fnm"],
  ["/mise/installs/", "mise"],
  ["/Herd/config/nvm/", "Herd"],
  ["/n/versions/", "n"],
] as const;

export function versionManagerOwning(nodePath: string): string | null {
  return VERSION_MANAGER_DIRS.find(([fragment]) => nodePath.includes(fragment))?.[1] ?? null;
}

export function durabilityLines(node: string): string[] {
  const manager = versionManagerOwning(node);
  if (manager) {
    return [
      `! This Node lives inside ${manager}'s install directory. The pin is stable until`,
      `  that version is removed: uninstalling it through ${manager} later breaks the`,
      "  dispatcher with a confusing exec error. A Homebrew or system Node cannot be",
      "  removed that way.",

      "  To pin a different one, run setup WITH it - setup pins whatever Node",
      "  runs it, so naming it is the whole instruction:",

      `    /opt/homebrew/bin/node "${cliPath()}" setup`,
    ];
  }

  return [
    "This Node is not in any install directory hive recognizes as a version",
    "manager's, so it is probably yours to keep. Check before relying on that.",
  ];
}

export function pathAdvice(dir: string, file: string): string[] {
  const first = firstHiveOnPath();
  if (first === file) return [`${dir} comes first on PATH, so \`hive\` runs the pinned interpreter.`];
  if (!(process.env.PATH ?? "").split(":").includes(dir)) {
    return [
      `${dir} is not on PATH. Add it AHEAD of your version manager's shims,`,
      "which usually prepend themselves:",
      `  export PATH="${dir}:$PATH"`,
    ];
  }
  return [
    `${first} comes first on PATH, so that one wins instead (npm link writes one).`,
    `  Put ${dir} ahead of it: export PATH="${dir}:$PATH"`,
  ];
}
