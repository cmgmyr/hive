#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
export const REPO_DIR = join(SCRIPT_DIR, "..");
export const SRC_DIR = join(REPO_DIR, "src");
export const DIST_DIR = join(REPO_DIR, "dist");

const SOCKET_PATH_LIMIT = 100;

let cachedStatePath;
function statePath() {
  if (!cachedStatePath) {
    const tag = createHash("sha256").update(realpathSync(REPO_DIR)).digest("hex").slice(0, 8);
    cachedStatePath = join(tmpdir(), `hive-isolated-instance-${tag}.json`);
  }
  return cachedStatePath;
}

function readState() {
  try {
    return JSON.parse(readFileSync(statePath(), "utf8"));
  } catch {
    return null;
  }
}

function writeState(state) {
  writeFileSync(statePath(), JSON.stringify(state, null, 2), { flag: "wx" });
}

function clearState() {
  rmSync(statePath(), { force: true });
}

async function loadHiveDist(distDir) {
  const missing = checkDistBuilt(distDir) ?? checkDistFresh(distDir, SRC_DIR);
  if (missing) throw new Error(missing);
  const [dataDirMod, tmuxMod] = await Promise.all([
    import(pathToFileURL(join(distDir, "dataDir.js")).href),
    import(pathToFileURL(join(distDir, "tmux.js")).href),
  ]);
  return {
    isDefaultStore: dataDirMod.isDefaultStore,
    tmuxSocketPath: tmuxMod.tmuxSocketPath,
    defaultTmuxSocketPath: tmuxMod.defaultTmuxSocketPath,
    privateTmuxSocket: tmuxMod.privateTmuxSocket,
    shellQuote: tmuxMod.shellQuote,
  };
}

const DIST_FILES = ["index.js", "cli.js", "dataDir.js", "tmux.js"];

export function checkDistBuilt(distDir, exists = existsSync) {
  if (DIST_FILES.some((f) => !exists(join(distDir, f)))) {
    return `refuses: no built dist at ${distDir}. Run \`npm install && npm run build\` in this worktree first.`;
  }
  return null;
}

export function checkDistFresh(distDir, srcDir, files = DIST_FILES) {
  const oldestDist = Math.min(...files.map((f) => statSync(join(distDir, f)).mtimeMs));
  const newestSrc = newestSourceMtime(srcDir);
  if (newestSrc > oldestDist) {
    return `refuses: dist/ at ${distDir} is older than src/. Run \`npm run build\` in this worktree before using it.`;
  }
  return null;
}

function newestSourceMtime(dir) {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) newest = Math.max(newest, newestSourceMtime(full));
    else if (entry.name.endsWith(".ts")) newest = Math.max(newest, statSync(full).mtimeMs);
  }
  return newest;
}

async function loadTmuxGeometry(distDir) {
  const missing = checkDistBuilt(distDir);
  if (missing) throw new Error(missing);
  const tmuxMod = await import(pathToFileURL(join(distDir, "tmux.js")).href);
  return { tmuxSocketPath: tmuxMod.tmuxSocketPath, privateTmuxSocket: tmuxMod.privateTmuxSocket };
}

export function killSocket(state, { privateTmuxSocket, tmuxSocketPath }, exists = existsSync) {
  if (!exists(state.tmuxTmpDir)) return null;
  if (!privateTmuxSocket(undefined, state.tmuxTmpDir)) return null;
  return tmuxSocketPath(undefined, state.tmuxTmpDir);
}

export function scratchPaths(root) {
  return { root, dataDir: join(root, "data"), tmuxTmpDir: join(root, "tmux") };
}

const MARKER_FILE = ".hive-isolated-instance";

function writeMarker(dir) {
  writeFileSync(join(dir, MARKER_FILE), "hive isolated instance -- created by scripts/isolated-hive.mjs\n");
}

function hasMarker(dir, exists = existsSync) {
  return exists(join(dir, MARKER_FILE));
}

function checkWorkerRootRemovable(workerRoot, exists = existsSync) {
  if (typeof workerRoot !== "string" || !exists(workerRoot)) return null;
  if (!hasMarker(workerRoot, exists)) {
    return (
      `refuses: ${workerRoot} has no hive-isolated marker, so it may not be something \`up\` created. ` +
      "Refusing to delete it; remove the state file by hand if it is stale."
    );
  }
  return null;
}

function rmRoots(dirs) {
  for (const dir of dirs) {
    if (typeof dir === "string") rmSync(dir, { recursive: true, force: true });
  }
}

export function workerProjectRoot(repoDir = REPO_DIR) {
  return realpathSync(mkdtempSync(join(repoDir, ".claude", "hive-iso-project-")));
}

export const MCP_CONFIG_FILE = "mcp-config.json";

export function writeWorkerMcpConfig(workerRoot, distDir, execPath = process.execPath) {
  const path = join(workerRoot, MCP_CONFIG_FILE);
  const config = { mcpServers: { "hive-iso": { command: execPath, args: [join(distDir, "index.js")] } } };
  writeFileSync(path, JSON.stringify(config, null, 2));
  return path;
}

export function checkOwnsInstance(state, exists = existsSync) {
  if (!state || typeof state.root !== "string") {
    return "refuses: the state file is malformed (no usable root). Remove it by hand and run `up` again.";
  }
  const expected = scratchPaths(state.root);
  if (state.dataDir !== expected.dataDir || state.tmuxTmpDir !== expected.tmuxTmpDir) {
    return (
      `refuses: the state file's paths do not match what \`up\` creates for root ${state.root}. ` +
      "Refusing to delete or kill anything it names; remove the state file by hand if it is stale."
    );
  }
  if (!hasMarker(state.root, exists)) {
    return (
      `refuses: ${state.root} has no hive-isolated marker, so it may not be something \`up\` created. ` +
      "Refusing to delete or kill anything there; remove the state file by hand if it is stale."
    );
  }

  if (typeof state.workerRoot !== "string" || !hasMarker(state.workerRoot, exists)) {
    return (
      `refuses: the state file names no valid worker-facing project root (or its marker is missing). ` +
      "Refusing to delete anything there; remove the state file by hand if it is stale."
    );
  }
  return null;
}

export function checkNotDefaultStore(dataDir, isDefaultStore) {
  if (isDefaultStore(dataDir)) {
    return (
      `refuses: ${dataDir} resolves to hive's default store. An isolated instance ` +
      "must use a scratch HIVE_DATA_DIR, never the real one."
    );
  }
  return null;
}

export function checkAxesPresent({ dataDir, tmuxTmpDir }) {
  const missing = [!dataDir && "HIVE_DATA_DIR", !tmuxTmpDir && "TMUX_TMPDIR"].filter(Boolean);
  if (missing.length > 0) {
    return `refuses: missing ${missing.join(" and ")}. Isolation requires a scratch data dir and a private tmux socket dir together, never one alone.`;
  }
  return null;
}

export function checkTmuxTmpDirExists(tmuxTmpDir, exists = existsSync) {
  if (!exists(tmuxTmpDir)) {
    return (
      `refuses: TMUX_TMPDIR ${tmuxTmpDir} does not exist. tmux will not create it and ` +
      "silently falls back to the SHARED socket instead of erroring."
    );
  }
  return null;
}

export function checkSocketPathLength(tmuxTmpDir, tmuxSocketPath, limit = SOCKET_PATH_LIMIT) {
  const socket = tmuxSocketPath(undefined, tmuxTmpDir);
  const length = Buffer.byteLength(socket, "utf8");
  if (length > limit) {
    return (
      `refuses: the tmux socket path is ${length} bytes (${socket}), over this script's ` +
      `${limit}-byte limit (unix sockets cap near 104). Pick a shorter TMUX_TMPDIR.`
    );
  }
  return null;
}

function firstFailure(paths, deps) {
  return (
    checkAxesPresent(paths) ??
    checkNotDefaultStore(paths.dataDir, deps.isDefaultStore) ??
    checkTmuxTmpDirExists(paths.tmuxTmpDir) ??
    checkSocketPathLength(paths.tmuxTmpDir, deps.tmuxSocketPath)
  );
}

export function formatEnvBlock({ dataDir, tmuxTmpDir, distDir }, quote) {
  return [

    "unset TMUX TMUX_PANE",
    `export HIVE_DATA_DIR=${quote(dataDir)}`,
    `export TMUX_TMPDIR=${quote(tmuxTmpDir)}`,
    `export HIVE_ISO_DIST=${quote(distDir)}`,

    "export HIVE_AUTO_ATTACH=0",
    "",
    "# MCP server for this instance -- THIS BRANCH's dist, not the pinned `hive` shim:",
    `#   claude mcp add --scope local hive-iso -- "$(command -v node)" "$HIVE_ISO_DIST/index.js"`,
    "# CLI:",
    `#   node "$HIVE_ISO_DIST/cli.js" <command>`,
  ].join("\n");
}

function fail(message) {
  console.error(message);
  process.exitCode = 1;
}

export async function cmdUp() {
  const existing = readState();
  if (existing) {
    if (existsSync(existing.root)) {
      fail(`refuses: an instance is already up at ${existing.root}. Run \`down\` first.`);
      return;
    }

    const workerRootProblem = checkWorkerRootRemovable(existing.workerRoot);
    if (workerRootProblem) {
      fail(workerRootProblem);
      return;
    }
    rmRoots([existing.workerRoot]);
    clearState();
  }

  let deps;
  try {
    deps = await loadHiveDist(DIST_DIR);
  } catch (e) {
    fail(e.message);
    return;
  }

  const root = realpathSync(mkdtempSync(join(tmpdir(), "hive-iso-")));
  writeMarker(root);
  const paths = scratchPaths(root);
  mkdirSync(paths.dataDir, { recursive: true });
  mkdirSync(paths.tmuxTmpDir, { recursive: true });

  const refusal = firstFailure(paths, deps);
  if (refusal) {
    rmRoots([root]);
    fail(refusal);
    return;
  }

  let workerRoot;
  try {
    workerRoot = workerProjectRoot();
    writeMarker(workerRoot);
    writeWorkerMcpConfig(workerRoot, DIST_DIR);
  } catch (e) {
    rmRoots([root, workerRoot]);
    fail(e.message);
    return;
  }

  try {
    writeState({
      root,
      dataDir: paths.dataDir,
      tmuxTmpDir: paths.tmuxTmpDir,
      workerRoot,
      createdAt: new Date().toISOString(),
    });
  } catch (e) {
    if (e.code === "EEXIST") {
      rmRoots([root, workerRoot]);
      fail("refuses: another `up` claimed the instance pointer first (a concurrent run won the race). Run `down` on that one, or try `up` again.");
      return;
    }
    throw e;
  }

  console.error(`isolated hive instance up at ${root}`);
  console.error(`worker-facing project root (pre-trusted, see header): ${workerRoot}\n`);
  console.log(formatEnvBlock({ ...paths, distDir: DIST_DIR }, deps.shellQuote));

  return { root, dataDir: paths.dataDir, tmuxTmpDir: paths.tmuxTmpDir, distDir: DIST_DIR, workerRoot };
}

async function cmdEnv() {
  const state = readState();
  if (!state) {
    fail("refuses: no instance is up. Run `up` first.");
    return;
  }

  let deps;
  try {
    deps = await loadHiveDist(DIST_DIR);
  } catch (e) {
    fail(e.message);
    return;
  }

  const refusal = firstFailure({ dataDir: state.dataDir, tmuxTmpDir: state.tmuxTmpDir }, deps);
  if (refusal) {
    fail(`${refusal} Run \`down\` then \`up\` again.`);
    return;
  }

  console.log(formatEnvBlock({ dataDir: state.dataDir, tmuxTmpDir: state.tmuxTmpDir, distDir: DIST_DIR }, deps.shellQuote));
}

export async function cmdDown(force) {
  const state = readState();
  if (!state) {
    console.log("nothing to tear down");
    return true;
  }
  if (typeof state.root === "string" && !existsSync(state.root)) {

    const workerRootProblem = checkWorkerRootRemovable(state.workerRoot);
    if (workerRootProblem) {
      fail(workerRootProblem);
      return false;
    }
    rmRoots([state.workerRoot]);
    clearState();
    console.log("nothing to tear down (scratch tree already gone)");
    return true;
  }

  const ownershipProblem = checkOwnsInstance(state);
  if (ownershipProblem) {
    fail(ownershipProblem);
    return false;
  }

  if (existsSync(state.tmuxTmpDir)) {
    let geometry;
    try {
      geometry = await loadTmuxGeometry(DIST_DIR);
    } catch (e) {

      fail(`${e.message} Cannot compute the private tmux socket without it, so the server is being left running rather than silently leaking it. Fix the build, then run \`down\` again.`);
      return false;
    }
    const socket = killSocket(state, geometry);
    if (socket) {
      const sessions = listLiveSessions(socket);

      if (sessions.length > 0 && !force) {
        fail(
          `refuses: ${sessions.length} tmux session(s) still running on the private server ` +
            `(${sessions.join(", ")}). A live MCP process or worker holding this scratch store ` +
            "will silently start reaching the SHARED tmux server once this teardown removes " +
            "TMUX_TMPDIR. Stop those sessions first, or run `down --force` to tear down anyway.",
        );
        return false;
      }
      if (sessions.length > 0) {

        console.error(`--force: tearing down ${sessions.length} live session(s) (${sessions.join(", ")}) anyway.`);
      }
      try {
        execFileSync("tmux", ["-S", socket, "kill-server"], { stdio: "ignore" });
      } catch {

      }
    }
  }

  rmRoots([state.root, state.workerRoot]);
  clearState();
  console.log(`torn down: ${state.root}`);
  return true;
}

function listLiveSessions(socket) {
  try {
    const out = execFileSync("tmux", ["-S", socket, "list-sessions", "-F", "#{session_name}"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return out.split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

const COMMANDS = Object.assign(Object.create(null), { up: cmdUp, env: cmdEnv, down: cmdDown });

async function main() {
  const command = COMMANDS[process.argv[2]];
  if (!command) {
    console.error("usage: isolated-hive.mjs <up|env|down>");
    process.exitCode = 1;
    return;
  }
  await command(process.argv.includes("--force"));
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) await main();
