import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

// Resolved on its own, with no database side effects, so tmux.ts can derive
// session names without opening the store.

export const DEFAULT_DATA_DIR = join(homedir(), ".hive");

// Where hive keeps its store. HIVE_DATA_DIR points tests and scratch
// instances at a private one.
//
// Read at CALL time. This was a module-level const, and a const is resolved
// once, at the first load of this module, from the env as it stood at that
// instant. Any import landing above the code that sets HIVE_DATA_DIR froze
// the answer for the whole process, and every later import silently agreed
// with it. That is not hypothetical: a static `import { configHash } from
// "../dist/projectYml.js"` at the top of test/helpers.mjs pulled this module
// in at hoist time, so dist/db.js opened the developer's real ~/.hive and the
// suite's between-test DELETEs ran there. Reading the env when someone asks
// removes the ordering question instead of leaving it to be gotten right.
//
// Deliberately NOT exported. It is storeDir() without the refusal, so an
// export would put the one call that reintroduces this whole class of bug in
// the public API, shorter than the guarded one and reading more obviously
// correct. Both consumers are in this file.
function resolveDataDir(): string {
  return process.env.HIVE_DATA_DIR ? resolve(process.env.HIVE_DATA_DIR) : DEFAULT_DATA_DIR;
}

// True when a test runner is the entry point of this process, or of the one
// that spawned it.
//
// node:test runs each test file in its own process and sets NODE_TEST_CONTEXT
// there; the value has changed between Node versions ("child", "child-v8"),
// so only its presence is load-bearing. It is an env var, so every CLI and
// server the suite spawns inherits it, which is what makes the guard below
// cover children that forgot to pass HIVE_DATA_DIR. Under
// --test-isolation=none the files run in the runner itself, which carries
// --test on execArgv instead.
export function underTestRunner(): boolean {
  return process.env.NODE_TEST_CONTEXT != null || process.execArgv.includes("--test");
}

// The data dir for anything that opens or writes the store, as opposed to
// merely naming something after it.
//
// resolveDataDir removes the trap that lost a live store, but only for code
// that asks after the env is set. A module that opens the store at its own
// load time still gets whatever the env said then, so a static
// `import "../dist/db.js"` above the line setting HIVE_DATA_DIR would still
// reach ~/.hive. Under a test runner there is no such thing as a legitimate
// reason to touch the real store, so this refuses rather than trusting the
// next author to have read this file.
//
// An explicit HIVE_DATA_DIR pointing at ~/.hive is refused too. A test that
// names the real store is the exact thing being prevented, not an exemption.
//
// Naming goes through here too, via dataDirTag. It used to be exempt on the
// grounds that building a string touches no disk, which answered the wrong
// question: a session name is the TARGET ARGUMENT for kill-session and
// respawn-pane. sessionName(1) under a test runner with no HIVE_DATA_DIR
// returned "hive-1", the live session of whatever real project is id 1, and
// agent_close would have killed it with its workers inside. Naming a store you
// are refused permission to open is not a case worth serving; tagFor takes a
// directory when a caller genuinely means one.
//
// Throws, because profiles.ts and brief.ts call it mid-command where exiting
// the process would be too blunt, and because a throw is what lets a test
// assert on the guard instead of dying with it. db.ts calls it during an
// import and needs the other treatment: see guardStoreDir below.
export function storeDir(): string {
  const dir = resolveDataDir();
  if (dir === DEFAULT_DATA_DIR && underTestRunner()) {
    throw new Error(refusal());
  }
  return dir;
}

// storeDir for a caller running inside an import, which today means db.ts.
//
// Same check, printed and exited rather than thrown, for exactly the reason
// guardAbi in src/abi.ts prints and exits: a throw out of an ESM module body
// reaches the user as a stack trace with hive's sentence buried in the middle
// of it, and nothing downstream can catch it to say anything better. The
// stdout/stderr split follows guardAbi too. Only the MCP server writes
// JSON-RPC on stdout, so the diagnostic goes to stderr where it cannot corrupt
// a protocol stream.
export function guardStoreDir(): string {
  const dir = resolveDataDir();
  if (dir === DEFAULT_DATA_DIR && underTestRunner()) {
    console.error(`hive: ${refusal()}`);
    process.exit(1);
  }
  return dir;
}

// One wording for both, so a test that pins the sentence pins both paths.
// Written for someone who has never read hive's source: the way out is an env
// var, and it is named before anything else.
function refusal(): string {
  return (
    `refused to use its real store at ${DEFAULT_DATA_DIR}. Set HIVE_DATA_DIR to a directory ` +
    "this run may write to, and pass it to every process spawned from here. " +
    "hive refuses the real store whenever a test runner is the entry point " +
    "(NODE_TEST_CONTEXT is set), because a suite that reaches it can destroy live state."
  );
}

// Project ids are SQLite row ids, unique only within one store: project 1 in
// a scratch store is a different project from project 1 in ~/.hive. tmux
// session names are built from those ids and share one machine-wide
// namespace, so an isolated store would otherwise resolve to -- and act on --
// the live session of whatever real project happens to be id 1. Tagging the
// name with the store keeps the default case readable (hive-1) and puts every
// other store somewhere it cannot collide.
//
// Pure, and takes the directory rather than resolving one, so a caller that
// means a specific store says which. Everything that means "this process's
// store" wants dataDirTag, which is guarded.
export function tagFor(dir: string): string {
  return dir === DEFAULT_DATA_DIR
    ? ""
    : `${createHash("sha256").update(dir).digest("hex").slice(0, 8)}-`;
}

// The tag for the store this process may use. Guarded, because the name it
// builds is what destructive tmux commands are pointed at: see storeDir.
export function dataDirTag(): string {
  return tagFor(storeDir());
}
