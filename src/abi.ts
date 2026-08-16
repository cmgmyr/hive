import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { cliPath, dispatcherPath, readDispatcher } from "./dispatcher.js";

const requireFromHere = createRequire(import.meta.url);

export type AbiStatus = {

  addon: string | null;

  running: number;

  builtFor: number | null;

  nodeApi: number | null;

  nodeApiRequired: number | null;

  failure: "missing" | "napi" | "mismatch" | "load" | null;
  ok: boolean;
  error: string | null;
};

export function classifyAddonLoadError(error: string): "mismatch" | "load" {
  return /NODE_MODULE_VERSION \d+|Module did not self-register/i.test(error) ? "mismatch" : "load";
}

export function requiredNodeApi(): number | null {
  try {
    const root = dirname(requireFromHere.resolve("better-sqlite3/package.json"));
    const found = /NAPI_VERSION=(\d+)/.exec(readFileSync(join(root, "binding.gyp"), "utf8"));
    return found ? Number(found[1]) : null;
  } catch {
    return null;
  }
}

const NODE_API_STARTS: Record<number, string[]> = {
  10: ["22.14.0", "23.6.0"],
};

function describeNodeApi(napi: number | null): string {
  return napi === null ? "none reported" : String(napi);
}

export function nodeRangeForNodeApi(napi: number): string | null {
  const starts = NODE_API_STARTS[napi];
  if (!starts) return null;
  return starts.map((v, i) => (i === starts.length - 1 ? `>=${v}` : `^${v}`)).join(" || ");
}

function isLinuxMusl(): boolean {
  if (process.platform !== "linux") return false;
  const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined;
  return !report?.header?.glibcVersionRuntime;
}

function addonPath(): string | null {
  try {
    const root = dirname(requireFromHere.resolve("better-sqlite3/package.json"));
    if (["linux", "darwin", "win32"].includes(process.platform) && ["x64", "arm64"].includes(process.arch)) {
      const target = `${isLinuxMusl() ? "linuxmusl" : process.platform}-${process.arch}`;
      const prebuild = join(root, "prebuilds", `${target}.node`);
      if (existsSync(prebuild)) return prebuild;
    }
    for (const build of ["Debug", "Release"]) {
      const file = join(root, "build", build, "better_sqlite3.node");
      if (existsSync(file)) return file;
    }
    return null;
  } catch {
    return null;
  }
}

export function checkAbi(): AbiStatus {
  const running = Number(process.versions.modules);

  const napi = Number(process.versions.napi);
  const nodeApi = Number.isFinite(napi) ? napi : null;
  const nodeApiRequired = requiredNodeApi();
  const addon = addonPath();
  if (!addon) {
    return {
      addon: null,
      running,
      nodeApi,
      nodeApiRequired,
      builtFor: null,
      failure: "missing",
      ok: false,
      error: "better-sqlite3's native addon is missing; it has not been built here",
    };
  }

  if (nodeApiRequired !== null && (nodeApi === null || nodeApi < nodeApiRequired)) {
    return {
      addon,
      running,
      nodeApi,
      nodeApiRequired,
      builtFor: null,
      failure: "napi",
      ok: false,
      error: `better-sqlite3's addon is built against Node-API ${nodeApiRequired}; this Node provides Node-API ${describeNodeApi(nodeApi)}`,
    };
  }
  try {
    requireFromHere(addon);

    return { addon, running, nodeApi, nodeApiRequired, builtFor: null, failure: null, ok: true, error: null };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);

    const found = [...error.matchAll(/NODE_MODULE_VERSION (\d+)/g)].map((m) => Number(m[1]));
    return {
      addon,
      running,
      nodeApi,
      nodeApiRequired,
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

    return status.nodeApiRequired === null
      ? `addon loaded under this interpreter (NODE_MODULE_VERSION ${status.running})`
      : `addon loaded; built against Node-API ${status.nodeApiRequired}, this interpreter provides Node-API ${describeNodeApi(status.nodeApi)}`;
  }
  if (status.failure === "napi") {
    const need = status.nodeApiRequired;
    const range = need === null ? null : nodeRangeForNodeApi(need);
    return (
      `addon is built against Node-API ${need}${range ? ` (needs Node ${range})` : ""},` +
      ` this interpreter provides Node-API ${describeNodeApi(status.nodeApi)}`
    );
  }
  if (status.failure === "mismatch" && status.builtFor === null) {
    return `addon did not register under this interpreter (NODE_MODULE_VERSION ${status.running}); its built-for version is not reported`;
  }
  if (status.builtFor === null) return status.error ?? "addon did not load";
  return `addon built for NODE_MODULE_VERSION ${status.builtFor}, this interpreter needs ${status.running}`;
}

export function abiFixLines(status: AbiStatus, pinned?: string | null): string[] {

  if (status.failure === "napi") {
    const need = status.nodeApiRequired;

    const range = need === null ? null : nodeRangeForNodeApi(need);
    const good = pinned ? `"${pinned}"` : `<a Node matching ${range ?? "that Node-API level"}>`;
    return [
      `better-sqlite3's addon is built against Node-API ${need}${range ? `, which only Node ${range} provides` : ""}.`,
      `This interpreter provides Node-API ${describeNodeApi(status.nodeApi)}, so the addon cannot load here.`,
      "Loading it anyway does not raise an error hive could report - the process dies",
      "inside dlopen - so hive refuses before the load rather than after.",
      "",
      "Rebuilding does NOT help: better-sqlite3's own binding.gyp requests the same",
      "Node-API level, so a build from source asks for exactly the same interpreter.",
      "",
      `Run hive under a Node matching ${range ?? "that Node-API level"}, and re-pin the \`hive\` command`,
      "to it (setup pins whatever Node runs it, so it has to be that one):",
      `  ${good} "${cliPath()}" setup`,
    ];
  }

  if (status.failure === "missing") {
    return [
      "Reinstall the package:  rm -rf node_modules/better-sqlite3 && npm install",
      "",
      "better-sqlite3 13 ships the addon prebuilt, so the file comes out of the",
      "tarball rather than a build. A plain `npm install` will NOT bring it back:",
      "with the package already unpacked at the locked version, npm reports `up to",
      "date` without ever looking at the addon. Removing the directory first is what",
      "makes npm fetch it again. `npm ci` does the same for the whole tree.",
      "hive's own `npm run build` only compiles TypeScript and is not part of this.",
      "",
      "If it is still missing after that, this platform/arch has no prebuild in the",
      "tarball, and the source build npm attempts during install did not succeed.",
      "Run it by hand inside the package, where its output is readable:",
      "  cd node_modules/better-sqlite3 && npm run build-release    (needs node-gyp)",
    ];
  }
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

function workingInterpreterFromDispatcher(): string | null {
  const node = readDispatcher(dispatcherPath())?.node;
  return node && node !== process.execPath && existsSync(node) ? node : null;
}

function prunedPinLines(): string[] {
  const node = readDispatcher(dispatcherPath())?.node;
  if (!node || existsSync(node)) return [];
  return [
    "",
    `The \`hive\` dispatcher pins ${node}, which is not on disk. A version manager can`,
    "remove one. That is also the interpreter hive's SessionStart hook re-execs into when a",
    "directory's own `node` cannot load the addon, so with it gone nothing caught this.",
  ];
}

export function guardAbi(): void {
  const status = checkAbi();
  if (status.ok) return;

  const doctor = process.argv[2] === "doctor";
  const headline =
    status.failure === "mismatch"
      ? "hive: cannot run under this Node."
      : status.failure === "napi"
        ? "hive: this Node is too old for better-sqlite3's native addon."
        : status.failure === "missing"
          ? "hive: better-sqlite3's native addon is not built here."
          : "hive: cannot load better-sqlite3's native addon.";
  const lines = [
    ...(doctor ? ["hive doctor", ""] : [headline, ""]),
    `  FAIL  node: ${describeInterpreter()}`,
    `  FAIL  better-sqlite3: ${describeAbi(status)}`,
    ...(status.addon ? [`        ${status.addon}`] : []),
    ...prunedPinLines(),
    "",
    ...abiFixLines(status, workingInterpreterFromDispatcher()),

    ...(doctor ? ["", "1 problem(s) found, 0 warning(s)."] : []),
  ];

  (doctor ? console.log : console.error)(lines.join("\n"));
  process.exit(1);
}
