// hive's store is better-sqlite3, whose native addon is compiled against one
// interpreter's ABI (NODE_MODULE_VERSION). Load it under a different Node and
// it refuses outright. That is not exotic: on any machine with a Node version
// manager the interpreter is picked from the working directory, so `cd` alone
// can point a different Node at the same compiled addon.
//
// Two things make this a module rather than a check inside hive doctor.
//
// `require("better-sqlite3")` does NOT load the addon. The binding loads
// lazily inside `new Database()` (better-sqlite3/lib/database.js), so a
// passing require proves nothing at all. Reading one as proof is how an
// interpreter that could not run hive got recommended as the fix.
//
// And db.ts opens the store in its module body. By the time any command's own
// code runs, the addon has either loaded or already thrown ERR_DLOPEN_FAILED
// out of an import, where nothing downstream can catch or explain it. So the
// load happens here, in a try/catch, and db.ts calls guardAbi() before it
// constructs a Database. Keep that call above the `new Database`.
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { cliPath, dispatcherPath, readDispatcher } from "./dispatcher.js";

const requireFromHere = createRequire(import.meta.url);

export type AbiStatus = {
  // Absolute path to better_sqlite3.node, or null when it is not built.
  addon: string | null;
  // NODE_MODULE_VERSION this interpreter requires.
  running: number;
  // NODE_MODULE_VERSION the addon was compiled for, null when unknowable.
  builtFor: number | null;
  // Why the addon is unavailable. Linux's dlopen error for an ABI mismatch
  // does not name either NODE_MODULE_VERSION, so builtFor alone cannot
  // distinguish that mismatch from a missing or otherwise broken addon.
  failure: "missing" | "mismatch" | "load" | null;
  ok: boolean;
  error: string | null;
};

export function classifyAddonLoadError(error: string): "mismatch" | "load" {
  return /NODE_MODULE_VERSION \d+|Module did not self-register/i.test(error) ? "mismatch" : "load";
}

function addonPath(): string | null {
  try {
    const pkg = requireFromHere.resolve("better-sqlite3/package.json");
    const file = join(dirname(pkg), "build", "Release", "better_sqlite3.node");
    return existsSync(file) ? file : null;
  } catch {
    return null;
  }
}

// Loads the addon for real. Cheap to call twice: the second one is a require
// cache hit, and better-sqlite3's own load of the same absolute path hits the
// same entry, so nothing is loaded twice.
export function checkAbi(): AbiStatus {
  const running = Number(process.versions.modules);
  const addon = addonPath();
  if (!addon) {
    return {
      addon: null,
      running,
      builtFor: null,
      failure: "missing",
      ok: false,
      error: "better-sqlite3's native addon is missing; it has not been built here",
    };
  }
  try {
    requireFromHere(addon);
    return { addon, running, builtFor: running, failure: null, ok: true, error: null };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    // Node names both sides in the dlopen error, compiled-against first and
    // required second: "was compiled against a different Node.js version
    // using NODE_MODULE_VERSION 137. This version of Node.js requires
    // NODE_MODULE_VERSION 147."
    const found = [...error.matchAll(/NODE_MODULE_VERSION (\d+)/g)].map((m) => Number(m[1]));
    return {
      addon,
      running,
      builtFor: found[0] ?? null,
      failure: classifyAddonLoadError(error),
      ok: false,
      error,
    };
  }
}

export function describeInterpreter(): string {
  return `${process.version} (NODE_MODULE_VERSION ${process.versions.modules}) at ${process.execPath}`;
}

export function describeAbi(status: AbiStatus): string {
  if (status.ok) {
    return `addon built for NODE_MODULE_VERSION ${status.builtFor}, matches this interpreter`;
  }
  if (status.failure === "mismatch" && status.builtFor === null) {
    return `addon did not register under this interpreter (NODE_MODULE_VERSION ${status.running}); its built-for version is not reported`;
  }
  if (status.builtFor === null) return status.error ?? "addon did not load";
  return `addon built for NODE_MODULE_VERSION ${status.builtFor}, this interpreter needs ${status.running}`;
}

// What a human has to know to get out of it. Kept separate from the printing
// so both the guard and its tests read the same words.
//
// pinned is the interpreter an existing dispatcher names, when there is one.
// It matters because the advice would otherwise be a loop: `hive setup` pins
// whatever Node runs it, so running it here would pin the broken one, and the
// `hive` on PATH is the command that just failed. The way out is always an
// explicit interpreter, so the fix names one.
export function abiFixLines(status: AbiStatus, pinned?: string | null): string[] {
  if (status.failure !== "mismatch") {
    return ["Build it:  npm install && npm run build"];
  }
  const good = pinned ? `"${pinned}"` : "<the Node that built it>";
  return [
    "better-sqlite3's addon is ABI-locked to the Node that compiled it, and a Node",
    "version manager resolves `node` from the working directory, so a `cd` is enough",
    "to swap it.",
    "",
    "Run hive under the Node it was built for, and re-pin the `hive` command to it",
    "(setup pins whatever Node runs it, so it has to be that one):",
    `  ${good} "${cliPath()}" setup`,
    "",
    "Or rebuild the addon for the Node you are on, and re-pin to that:",
    "  npm install && npm run build && hive setup",
  ];
}

// An interpreter worth naming in the advice: one an existing dispatcher pins,
// that still exists, and that is not the one that just failed.
function workingInterpreterFromDispatcher(): string | null {
  const node = readDispatcher(dispatcherPath())?.node;
  return node && node !== process.execPath && existsSync(node) ? node : null;
}

// Called by db.ts before it opens the store. Prints and exits rather than
// throwing: the alternative a caller sees is an ERR_DLOPEN_FAILED stack trace
// from inside an import, which is the thing this exists to prevent.
export function guardAbi(): void {
  const status = checkAbi();
  if (status.ok) return;
  // doctor's report belongs on stdout in doctor's own shape. Nothing else can
  // reach cmdDoctor to render it: this runs during db.ts's import, before any
  // command's code exists. Every other command is simply failing, and one of
  // them is the MCP server, whose stdout is a JSON-RPC stream.
  const doctor = process.argv[2] === "doctor";
  const headline =
    status.failure === "mismatch"
      ? "hive: cannot run under this Node."
      : status.failure === "missing"
        ? "hive: better-sqlite3's native addon is not built here."
        : "hive: cannot load better-sqlite3's native addon.";
  const lines = [
    ...(doctor ? ["hive doctor", ""] : [headline, ""]),
    `  FAIL  node: ${describeInterpreter()}`,
    `  FAIL  better-sqlite3: ${describeAbi(status)}`,
    ...(status.addon ? [`        ${status.addon}`] : []),
    "",
    ...abiFixLines(status, workingInterpreterFromDispatcher()),
    ...(doctor ? ["", "1 problem(s) found."] : []),
  ];
  // doctor's report belongs on stdout with the rest of its output. Every
  // other command is failing, and one of them is the MCP server, whose stdout
  // is a JSON-RPC stream.
  (doctor ? console.log : console.error)(lines.join("\n"));
  process.exit(1);
}
