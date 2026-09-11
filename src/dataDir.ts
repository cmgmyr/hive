import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_DATA_DIR = join(homedir(), ".hive");

function resolveDataDir(): string {
  return process.env.HIVE_DATA_DIR ? resolve(process.env.HIVE_DATA_DIR) : DEFAULT_DATA_DIR;
}

const canonical = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

export function isDefaultStore(dir: string): boolean {
  return dir === DEFAULT_DATA_DIR || canonical(dir) === canonical(DEFAULT_DATA_DIR);
}

export function underTestRunner(): boolean {
  return process.env.NODE_TEST_CONTEXT != null || process.execArgv.includes("--test");
}

function productEntryPoints(): string[] {
  const dist = dirname(fileURLToPath(import.meta.url));
  return [
    join(dist, "cli.js"),
    join(dist, "index.js"),
    join(dist, "hook.js"),
    join(dist, "statusline.js"),
    join(dist, "kickoff.js"),
    join(dist, "..", "claude-plugin", "kickoff.mjs"),
  ];
}

export function isProductEntryPoint(): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  const entry = canonical(argv1);
  return productEntryPoints().some((p) => canonical(p) === entry);
}

export function storeDir(): string {
  const dir = resolveDataDir();
  const reason = defaultStoreRefusal(dir);
  if (reason) throw new Error(refusal(reason));
  return dir;
}

export function guardStoreDir(): string {
  const dir = resolveDataDir();
  const reason = defaultStoreRefusal(dir);
  if (reason) {
    console.error(`hive: ${refusal(reason)}`);
    process.exit(1);
  }
  return dir;
}

function defaultStoreRefusal(dir: string): "test-runner" | "not-product-entry" | null {
  if (!isDefaultStore(dir)) return null;
  if (underTestRunner()) return "test-runner";
  if (isProductEntryPoint()) return null;
  if (process.env.HIVE_ALLOW_DEFAULT_STORE === "1") return null;
  return "not-product-entry";
}

function refusal(reason: "test-runner" | "not-product-entry"): string {
  const why =
    reason === "test-runner"
      ? "hive refuses the real store whenever a test runner is the entry point " +
        "(NODE_TEST_CONTEXT is set), because a suite that reaches it can destroy live state."
      : "hive refuses the real store from any process that is not its own CLI, MCP server, " +
        "or hooks, because a hand-rolled script that opens it to seed or inspect a row can " +
        "write to live state by accident. Set HIVE_ALLOW_DEFAULT_STORE=1 if this really is a " +
        "deliberate one-off against the real store.";
  return (
    `refused to use its real store at ${DEFAULT_DATA_DIR}. Set HIVE_DATA_DIR to a directory ` +
    "this run may write to, and pass it to every process spawned from here. " +
    why
  );
}

export function tagFor(dir: string): string {
  const resolved = canonical(dir);
  return isDefaultStore(resolved)
    ? ""
    : `${createHash("sha256").update(resolved).digest("hex").slice(0, 8)}-`;
}

export function dataDirTag(): string {
  return tagFor(storeDir());
}
