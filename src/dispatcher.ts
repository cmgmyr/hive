import { statSync } from "node:fs";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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
