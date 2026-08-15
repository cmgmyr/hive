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
//
// Issue #105: better-sqlite3 13 moved to N-API (NAPI_VERSION=10 in its
// own binding.gyp, via node-addon-api). THAT DID NOT RETIRE THIS FILE, and an
// earlier revision of this comment claimed it had. N-API replaced an EQUALITY
// constraint with a MINIMUM one. The addon no longer has to match the running
// interpreter's NODE_MODULE_VERSION, but it does require a Node providing
// Node-API 10 - `^22.14.0 || >=23.6.0`, because a level starts once per
// release line and not once; see NODE_API_STARTS. The failure moved; it did
// not disappear, and hive declared `engines.node: ">=22.5.0"` for long enough
// to ship a range where the addon cannot load.
//
// The new failure is worse than the old one, and this is measured rather than
// reasoned. On Node 22.13.1 (Node-API 9), deterministic over three runs:
// requiring the shipped prebuilds/darwin-arm64.node exits 139 with empty
// stdout, empty stderr, and no error at all - INSIDE a try/catch. The process
// dies in dlopen. guardAbi() is not merely bypassed on a sub-floor Node, it
// is the crash site, and its catch cannot see anything. So checkAbi()
// compares Node-API levels BEFORE it requires the addon: after the require
// there is no process left to report from. process.versions.napi is readable
// with no native load of any kind, which is what makes the check possible.
//
// The old NODE_MODULE_VERSION mismatch is unreachable for any build this
// package can currently produce, on any platform it ships prebuilds for, ON A
// NODE THAT CLEARS THE NODE-API FLOOR. test/fixtures/native-addon-abi/ keeps
// that branch tested with a real pre-N-API build - see that README.
import { existsSync, readFileSync } from "node:fs";
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
  // Node-API level this interpreter provides, null when it reports none.
  nodeApi: number | null;
  // Node-API level the installed better-sqlite3 is built against, null when
  // the package does not state one (see requiredNodeApi).
  nodeApiRequired: number | null;
  // Why the addon is unavailable. Linux's dlopen error for an ABI mismatch
  // does not name either NODE_MODULE_VERSION, so builtFor alone cannot
  // distinguish that mismatch from a missing or otherwise broken addon.
  // "napi" is decided WITHOUT loading the addon, which is the only way it can
  // be decided at all - see this file's header.
  failure: "missing" | "napi" | "mismatch" | "load" | null;
  ok: boolean;
  error: string | null;
};

export function classifyAddonLoadError(error: string): "mismatch" | "load" {
  return /NODE_MODULE_VERSION \d+|Module did not self-register/i.test(error) ? "mismatch" : "load";
}

// The Node-API level the INSTALLED better-sqlite3 is built against, read from
// its own binding.gyp. Null when the package states none, which is the honest
// answer for a pre-N-API major: those are locked to a NODE_MODULE_VERSION
// instead, and checkAbi's mismatch branch is what catches them.
//
// NULL MEANS "PROCEED TO THE REQUIRE", WHICH IS A FAIL-OPEN, and on a
// sub-floor Node proceeding means exit 139. So it is worth being exact about
// when null can happen, because most of the ways it could are already closed
// by something other than this function:
//
//   - The package root does not resolve. addonPath() resolves through THE
//     SAME `requireFromHere.resolve("better-sqlite3/package.json")`, so it
//     returns null too, checkAbi reports "missing", and nothing is required
//     at all. That coupling is what makes the common case safe, and it is
//     load-bearing rather than incidental: keep the two resolving through the
//     same call, or this branch stops being covered.
//   - binding.gyp is absent or has no NAPI_VERSION. Legitimate for a
//     pre-N-API major - 12.11.1 states none - and refusing on it would break
//     every classic fixture in test/fixtures/native-addon-abi/ as well as any
//     real pre-13 install. Permissive on purpose.
//
// What is left is the real hole, stated rather than papered over: binding.gyp
// unreadable (permissions, a truncated write, a package manager mid-swap)
// WHILE the package root resolves AND a prebuild exists. Then hive proceeds
// to a require it cannot survive. Narrow, and not closable from here -
// distinguishing "unreadable" from "a pre-N-API package" needs a claim about
// which better-sqlite3 major is installed, and this function deliberately
// makes none. test/dependency-versions.test.mjs pins that the real installed
// package DOES state a level, so this can never quietly become hive's normal
// path.
//
// READ, NOT RECORDED, and the reason is the failure this whole guard exists
// for. hive's `engines.node` floor is DERIVED from this number: 22.14.0 is
// simply where Node-API 10 begins. A constant here would agree with a stale
// engines declaration by construction, so the day better-sqlite3 raises
// NAPI_VERSION and hive's package.json has not followed, a constant would let
// the segfault straight back in. Reading the dependency's own value means
// only the DECLARATION goes stale, and a stale declaration produces a clear
// refusal instead of exit 139 with empty output. binding.gyp is listed in
// better-sqlite3's own package.json "files", so it ships in the tarball.
export function requiredNodeApi(): number | null {
  try {
    const root = dirname(requireFromHere.resolve("better-sqlite3/package.json"));
    const found = /NAPI_VERSION=(\d+)/.exec(readFileSync(join(root, "binding.gyp"), "utf8"));
    return found ? Number(found[1]) : null;
  } catch {
    return null;
  }
}

// Where a Node-API level starts - ONE POINT PER RELEASE LINE, not one
// version. This is the correction that matters, and getting it wrong once
// already reproduced this lane's own bug a release line over.
//
// nodejs.org/api/n-api.html's matrix: level 10 is "v22.14.0+, v23.6.0+ and
// all later versions"; level 9 was v18.17.0+, v20.3.0+, v21.0.0+. A level
// lands on the current line first and is backported to older lines later, so
// a single "lowest version" cannot express it. Recording only 22.14.0 made
// the declaration `">=22.14.0"`, which admits Node 23.0.0 through 23.5.0 -
// every one of them Node-API 9, every one of them unable to load the addon.
//
// Only the level hive depends on is recorded. An unknown level is reported by
// number, with no version range, because a guessed range in a diagnostic is
// worse than an unspecific one.
//
// Extend this when better-sqlite3 raises NAPI_VERSION, and the declaration
// follows automatically - test/dependency-versions.test.mjs derives what
// package.json must say from this array and fails until it matches.
const NODE_API_STARTS: Record<number, string[]> = {
  10: ["22.14.0", "23.6.0"],
};

// The semver range of Nodes providing a level, derived from the start points
// rather than recorded beside them, so the two cannot disagree.
//
// Every line but the last is bounded to its own major (`^22.14.0` stops at
// 23.0.0, which is correct: 23 does not reach level 10 until 23.6.0). The
// last start point is the matrix's "and all later versions", so it is `>=`.
// That rule is exactly what the matrix's wording means, and it is written
// here rather than left implicit because the next level will have its own
// list and someone will have to trust this.
// "9", or "none reported" - never the string "NaN", which is what reached a
// user's terminal before the level became nullable.
function describeNodeApi(napi: number | null): string {
  return napi === null ? "none reported" : String(napi);
}

export function nodeRangeForNodeApi(napi: number): string | null {
  const starts = NODE_API_STARTS[napi];
  if (!starts) return null;
  return starts.map((v, i) => (i === starts.length - 1 ? `>=${v}` : `^${v}`)).join(" || ");
}

// process.report.getReport() is a FULL diagnostic report - a heap walk and a
// libuv handle dump - and this runs on the module-load path of every hive
// process, including every SessionStart kickoff. better-sqlite3's own
// binding.js short-circuits on `process.platform === 'linux'` before calling
// it, and an earlier revision here did not, so every darwin and win32 process
// paid for a report whose only use is a glibc check that cannot apply to it.
// Keep the platform test first.
//
// Typed loosely on purpose: getReport() is declared as `object`, and
// binding.js reads .header.glibcVersionRuntime off it untyped too.
function isLinuxMusl(): boolean {
  if (process.platform !== "linux") return false;
  const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined;
  return !report?.header?.glibcVersionRuntime;
}

// better-sqlite3 13 leads with N-API prebuilds shipped in the npm package: one
// file per platform+arch, picked by better-sqlite3/lib/binding.js#getPrebuildPath,
// never per Node version. This mirrors that lookup rather than importing it,
// because the subpath is not in the package's "exports" map.
//
// "dropped the node-gyp build entirely" is what this said, and it is not what
// 13 did. The package still ships binding.gyp, still declares build-release
// and build-debug, and still builds from source when asked. What changed is
// what the source build TARGETS - N-API rather than the V8 ABI - so a build is
// no longer the thing that ties an addon to one Node major.
//
// MIRRORS IT IN ORDER, WHICH IS THE POINT OF THE LOOP BELOW. binding.js falls
// back to build/Debug FIRST and only then build/Release, so a tree carrying a
// debug build and no release one loads fine for better-sqlite3 while an
// earlier revision here reported it "missing" and made guardAbi exit 1 on a
// working checkout. Any divergence between this function and binding.js shows
// up as hive refusing to start on a tree that works, which is a worse failure
// than the one the guard prevents.
//
// The build/* fallback is a real layout, and what puts something there is
// worth stating exactly, because the obvious reading is wrong in both
// directions. MEASURED against 13.0.3, npm 11.16.0:
//
//   `npm install` DOES invoke node-gyp for this package. v13 declares no
//   install script and sets gypfile:false, and npm synthesises
//   `install: node-gyp rebuild` anyway, because binding.gyp is in the tarball.
//   An earlier version of this comment concluded "npm never invokes node-gyp"
//   from the declaration, which is the right premise and the wrong conclusion.
//
//   That run compiles nothing when a prebuild for the host exists.
//   binding.gyp gates both targets on `force_build==1 or prebuild_exists==0`
//   and makes them 'type': 'none' otherwise, so build/ ends up holding
//   makefiles and two .stamp files. Deliberate upstream, and commented as
//   such in binding.gyp.
//
//   With no host prebuild, the same implicit run IS a full source build and
//   lands here. So this fallback is reached by an ordinary `npm install` on a
//   platform the tarball does not cover, not only by a hand build.
//
// A hand build (`npm run build-release` inside the package) passes
// --force_build=1 and lands here too, which is the route abiFixLines names
// when a platform has no prebuild and the implicit build did not happen.
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

// Loads the addon for real. Cheap to call twice: the second one is a require
// cache hit, and better-sqlite3's own load of the same absolute path hits the
// same entry, so nothing is loaded twice.
export function checkAbi(): AbiStatus {
  const running = Number(process.versions.modules);
  // Null rather than NaN when the field is absent. `Number(undefined) < 10`
  // is FALSE, so a NaN here would slip straight past the comparison below and
  // reach the require - a fail-open in the one place this file exists to hold
  // shut. Anything that cannot report a Node-API level cannot load an N-API
  // addon either, so treating it as "below any requirement" is both safe and
  // true.
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
  // BEFORE the require, and that ordering is the whole point: on a Node below
  // the addon's Node-API level the require does not throw, it kills the
  // process inside dlopen with no output at all. Measured on Node 22.13.1
  // against better-sqlite3 13.0.3. Everything below this line assumes a
  // require that can only succeed or throw.
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
    // builtFor stays null on success, and that is a correction. It used to be
    // set to `running`, which nothing here measured: no code in this file
    // reads the addon's build ABI, so success reported the interpreter's own
    // number back as the addon's. For an N-API addon the claim is not merely
    // unmeasured, it is false - it is built for no NODE_MODULE_VERSION at
    // all. The honest report is that the addon loaded, plus the levels that
    // were genuinely compared; see describeAbi.
    return { addon, running, nodeApi, nodeApiRequired, builtFor: null, failure: null, ok: true, error: null };
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
    // Only what was actually established. The addon loaded, and the Node-API
    // levels are the two values the load was decided on - one read from
    // better-sqlite3's binding.gyp, one from this process. A NODE_MODULE_VERSION
    // is still printed when the package states no Node-API level, because a
    // pre-N-API addon really is locked to one, and it is the running
    // interpreter's number, named as such.
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

// What a human has to know to get out of it. Kept separate from the printing
// so both the guard and its tests read the same words.
//
// pinned is the interpreter an existing dispatcher names, when there is one.
// It matters because the advice would otherwise be a loop: `hive setup` pins
// whatever Node runs it, so running it here would pin the broken one, and the
// `hive` on PATH is the command that just failed. The way out is always an
// explicit interpreter, so the fix names one.
export function abiFixLines(status: AbiStatus, pinned?: string | null): string[] {
  // The one class where "npm install && npm run build" is actively wrong
  // advice, which is why it is branched before the generic case. A source
  // build reads the SAME binding.gyp that set the requirement, so it produces
  // an addon needing the same Node-API level. Nothing done to the tree fixes
  // this; only a different interpreter does.
  if (status.failure === "napi") {
    const need = status.nodeApiRequired;
    // The range, never a single "or newer" version. A Node-API level starts
    // at a different point on each release line, so "22.14.0 or newer" is
    // advice a user on Node 23.2 has already followed - and it is the advice
    // loop this file's header says the fix lines exist to avoid.
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
  // THIS BRANCH HAS NOW BEEN WRONG TWICE, in opposite directions, and both
  // versions were reasoned from a package.json field instead of measured.
  //
  // It first said "npm install && npm run build", and neither half produces
  // better_sqlite3.node. It was corrected to a bare "npm install" plus "The
  // package declares no install script, so npm builds nothing for it" - the
  // premise true, the conclusion false, and the ADVICE ITSELF INEFFECTIVE.
  // Measured against 13.0.3 with npm 11.16.0:
  //
  //   Delete the prebuild from an installed tree and run `npm install`: it
  //   prints "up to date, audited 102 packages" and does NOT restore the file.
  //   npm reconciles the tree against the lockfile; a package that is present
  //   at the right version is not re-examined, and the addon is inside it.
  //   So the one command this branch offered is the one that cannot work in
  //   the situation it fires in.
  //   Remove the package DIRECTORY and run `npm install`: restored in under a
  //   second, from the tarball, with no compiler.
  //   npm also runs an implicit `node-gyp rebuild` for this package on every
  //   install (see addonPath's comment). It compiles nothing where a prebuild
  //   exists and does a real source build where none does, so "npm builds
  //   nothing for it" is not a sentence to put in front of a user either.
  //
  // The remedy names the reinstall, and says why the obvious command is not
  // it, because a user who has already tried `npm install` needs to be told
  // that trying it again is not the missing step.
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

// An interpreter worth naming in the advice: one an existing dispatcher pins,
// that still exists, and that is not the one that just failed.
function workingInterpreterFromDispatcher(): string | null {
  const node = readDispatcher(dispatcherPath())?.node;
  return node && node !== process.execPath && existsSync(node) ? node : null;
}

// Named here, at the place the banner actually prints.
//
// The SessionStart hook is registered under a bare `node` (hooks.json is
// tracked in git and cannot carry an absolute path), so in a directory pinning
// a Node that cannot load the addon, the one thing standing between a session
// and this banner is claude-plugin/kickoff.mjs re-execing into the interpreter
// the dispatcher pins. When a version manager retires that interpreter the
// re-exec has nothing to run, and the banner returns on a machine where the
// fix is still in place - nothing undone, and no way to tell from the banner
// that the fix ever existed. That is the most confusing shape a regression can
// take, so the banner says it.
//
// HERE RATHER THAN IN kickoff.mjs, and that placement is the correction. The
// hook tried printing this itself for one commit, on the argument that the
// banner follows anyway; it does not always - db.js is imported lazily inside
// digest(), behind gates for the profile and the branch - so the hook could
// print into a session that was about to decline silently. This line cannot:
// it is part of the banner, so it exists exactly when the banner does, and it
// covers every command rather than one hook.
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
    // The same shape cmdDoctor's own summary line has, warn
    // count included. This path emits no warns and never can - it runs during
    // db.ts's import, before any check exists to warn - so the zero is a fact
    // rather than a placeholder. It matters because docs/troubleshooting.md's
    // "hive doctor is the first stop" entry now tells a script to read a
    // result off that line, and this is the renderer that
    // fires on exactly the run where the environment is broken.
    ...(doctor ? ["", "1 problem(s) found, 0 warning(s)."] : []),
  ];
  // doctor's report belongs on stdout with the rest of its output. Every
  // other command is failing, and one of them is the MCP server, whose stdout
  // is a JSON-RPC stream.
  (doctor ? console.log : console.error)(lines.join("\n"));
  process.exit(1);
}
