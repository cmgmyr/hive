// The dispatcher: a two-line shell script that runs hive's CLI under one fixed
// interpreter, instead of whatever `node` the working directory resolves to.
// `npm link` cannot do this. It writes its shim into the ACTIVE Node's global
// bin, which a version manager reshims per directory, so `hive` vanishes
// wherever another version is pinned.
//
// "the interpreter that built it" is what this said, and issue #105 lane B
// retired the claim under it: better-sqlite3 13 ships a prebuilt N-API addon,
// so nothing builds it here and it is not tied to one Node major. The pin is
// still the fix, for the OTHER half of the same sentence - a Node resolved per
// directory can be one the addon cannot load, which after the N-API move means
// one below its Node-API floor.
//
// The generated header below states that without a version range on purpose.
// The range lives in abi.ts, derived from better-sqlite3's own binding.gyp,
// and abi.ts imports THIS file for the escape hatch it prints - so naming the
// range here would either invert that dependency or hardcode a number that
// goes stale silently on a file already written to a user's disk.
//
// Everything here is pure filesystem and string work, with no store access, so
// abi.ts can name the escape hatch out of an ABI mismatch before the store is
// ever opened.
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

// POSIX single-quoting, unconditional. tmux.ts has a shellQuote() that leaves
// safe strings bare, which is right for a command line a human reads and wrong
// here: readDispatcher parses the exec line back out, and a bare operand would
// make hive's own dispatcher unrecognizable to it.
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

// mine: hive wrote this file. node/cli: what it currently runs, null when the
// exec line is in a shape this version does not recognize.
//
// Those are two questions, and answering them with one null conflates "this is
// someone else's hive" with "this is hive's, written by another version". Setup
// refuses to overwrite the first and must be free to repair the second, which
// is the entire job it exists for.
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

// The `hive` an interactive shell would actually run. PATH order is the whole
// question, so this walks PATH in order rather than asking `which`, which
// answers from its own shell's hash table.
export function firstHiveOnPath(): string | null {
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (!dir) continue;
    const candidate = join(dir, "hive");
    try {
      if (statSync(candidate).mode & 0o111) return candidate;
    } catch {
      // Not there.
    }
  }
  return null;
}

// Version managers install Nodes into directories they can also remove. The
// pin works either way; the difference is what happens months later, so setup
// says which kind it pinned instead of leaving it to be found through a
// confusing exec error. A miss only ever costs a hedge, never a false alarm:
// see the wording in cmdSetup.
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

// What the pin costs later, given the interpreter it landed on.
//
// Pure and exported so every branch can be driven from a test with a path of
// the test's choosing. The branch a machine happens to produce is not evidence
// about the others: a suite that asserted "one of these two appeared" passed on
// a laptop with a version-manager Node and broke on a CI runner whose Node is
// in a hosted toolcache, which is neither.
export function durabilityLines(node: string): string[] {
  const manager = versionManagerOwning(node);
  if (manager) {
    return [
      `! This Node lives inside ${manager}'s install directory. The pin is stable until`,
      `  that version is removed: uninstalling it through ${manager} later breaks the`,
      "  dispatcher with a confusing exec error. A Homebrew or system Node cannot be",
      "  removed that way.",
      // TWO THINGS WERE WRONG WITH THE ADVICE THIS REPLACED, and one of them
      // could not work at all. It read "rebuild under it and re-run setup:
      // /opt/homebrew/bin/node --version && npm install && npm run build &&
      // hive setup".
      //
      // The rebuild is from the retired model. better-sqlite3 13 ships a
      // prebuilt N-API addon and hive's own `npm run build` is tsc, so
      // neither step changes which Node can run hive; the pin is the only
      // thing being moved here.
      //
      // The trailing `hive setup` LOOPED. `hive` on PATH is this dispatcher,
      // still pinned to the interpreter the user is trying to move off, so
      // setup ran under it and re-pinned exactly the Node the advice exists to
      // replace. abi.ts's fix lines already carry this rule - setup pins
      // whatever Node runs it, so the way out always names an interpreter
      // explicitly - and this branch did not follow it.
      "  To pin a different one, run setup WITH it - setup pins whatever Node",
      "  runs it, so naming it is the whole instruction:",
      // QUOTED, like abi.ts's two copies of this instruction. cliPath() is an
      // absolute path from import.meta.url, so a checkout under a directory
      // with a space produces a command that breaks when pasted. The test
      // below pins the quotes rather than the shape, because the obvious
      // assertion (\S* between the interpreter and dist/cli.js) passes only
      // while no path has a space in it and would fail on the very case it is
      // meant to protect.
      `    /opt/homebrew/bin/node "${cliPath()}" setup`,
    ];
  }
  // Only ever a hedge. The detection is a list of known install paths, so it
  // can miss a version manager (nodenv, nvs, a relocated ASDF_DATA_DIR) but
  // never invent one. Claiming this Node is safe from removal is the one thing
  // this branch cannot support.
  return [
    "This Node is not in any install directory hive recognizes as a version",
    "manager's, so it is probably yours to keep. Check before relying on that.",
  ];
}

// One answer to "will typing `hive` reach this file", shared by setup and
// doctor so the advice cannot drift into two phrasings of the same fix.
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
