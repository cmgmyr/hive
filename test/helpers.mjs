import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

export const REPO = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

const LEAK_MANIFEST = process.env.HIVE_TMUX_LEAK_MANIFEST;
export const DIST = join(REPO, "dist");
export const SERVER = join(DIST, "index.js");
export const CLI = join(DIST, "cli.js");

export const KICKOFF = join(DIST, "kickoff.js");

export function baseEnv() {
  return Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("HIVE_")));
}

export function clearHiveEnv() {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("HIVE_")) delete process.env[key];
  }
}

export async function seedTrustedYml({ db, projectId, projectDir, processes }) {
  const { configHash } = await import("../dist/projectYml.js");
  const lines = Object.entries(processes).map(([name, command]) => `  ${name}: ${command}`);
  writeFileSync(join(projectDir, "hive.yml"), `processes:\n${lines.join("\n")}\n`);
  for (const [name, command] of Object.entries(processes)) {
    db.prepare(
      "INSERT OR IGNORE INTO command_trust (project_id, name, config_hash) VALUES (?, ?, ?)",
    ).run(projectId, name, configHash(name, command, null, {}));
  }
}

export async function assertScratchStore() {
  const { storeDir, DEFAULT_DATA_DIR } = await import("../dist/dataDir.js");
  const resolved = storeDir();
  if (resolved === DEFAULT_DATA_DIR || resolved !== process.env.HIVE_DATA_DIR) {
    throw new Error(
      `Test store is not isolated: dist resolved the store to ${resolved}, expected ${process.env.HIVE_DATA_DIR}. ` +
        "Refusing to run against a store this test does not own.",
    );
  }
}

export function scratchDirs() {

  const root = realpathSync(mkdtempSync(join(tmpdir(), "hive-test-")));
  return {
    dataDir: join(root, "data"),
    projectDir: mkdtempSync(join(root, "project-")),
    tmp: mkdtempSync(join(root, "tmp-")),
  };
}

export function runFixture(tmp, name, source, env) {
  const file = join(tmp, `${name}.mjs`);
  writeFileSync(file, source);
  const result = spawnSync(process.execPath, [file], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
  });
  assert.equal(result.status, 0, `fixture ${name} failed: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

export function storeReplaceScript(dbPathExpr) {
  return (
    `const decoyPath = ${dbPathExpr} + ".decoy";\n` +
    `writeFileSync(decoyPath, "not a real sqlite file, only the inode matters here");\n` +
    `const tmpPath = ${dbPathExpr} + ".restoring";\n` +
    `cpSync(decoyPath, tmpPath);\n` +
    `renameSync(tmpPath, ${dbPathExpr});\n` +
    `for (const suffix of ["-wal", "-shm"]) rmSync(${dbPathExpr} + suffix, { force: true });\n`
  );
}

export const FS_SWAP_IMPORT = `import { cpSync, renameSync, rmSync, writeFileSync } from "node:fs";\n`;

export function makeFakeClaude(tmp) {
  let count = 0;
  return function fakeClaude(runs = "sleep 600") {
    const bin = join(tmp, `claude-${count++}`);
    mkdirSync(bin, { recursive: true });
    const path = join(bin, "claude");
    writeFileSync(path, `#!/bin/sh\nexec sh -c ${JSON.stringify(runs)}\n`);
    chmodSync(path, 0o755);
    return path;
  };
}

export function makeFakeOpen(tmp) {
  const bin = join(tmp, "fake-open-bin");
  const failBin = join(tmp, "fake-open-fail-bin");
  mkdirSync(bin, { recursive: true });
  mkdirSync(failBin, { recursive: true });
  const log = join(tmp, "fake-open.log");
  writeFileSync(join(bin, "open"), `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\nexit 0\n`);
  chmodSync(join(bin, "open"), 0o755);
  writeFileSync(join(failBin, "open"), "#!/bin/sh\nexit 1\n");
  chmodSync(join(failBin, "open"), 0o755);
  writeFileSync(log, "");
  return {
    bin,
    failBin,
    calls: () => readFileSync(log, "utf8").split("\n").filter(Boolean),
    reset: () => writeFileSync(log, ""),
  };
}

export function tmuxSocketUnder(tmuxTmpDir) {
  return join(tmuxTmpDir, `tmux-${process.getuid?.() ?? 0}`, "default");
}

function sharedTmuxSocket() {
  return tmuxSocketUnder(realpathSync("/tmp"));
}

// Mirrors tmuxSocketPath()'s precedence (src/tmux.ts): TMUX's first field wins, else a reachable
// TMUX_TMPDIR. Diverges on purpose where that function falls back to the shared default socket -
// this returns null instead, so callers refuse rather than silently resolving to it. Applies to BOTH
// branches: an inherited TMUX that happens to name the shared socket directly is exactly the "on the
// crew's server already" case this exists to catch, not something to trust because it came from TMUX.
// Canonicalise before comparing, exactly as canonicalSocketPath() does: /tmp and /private/tmp name
// one server, so a raw compare reads the shared socket as private.
function canonicalSocketPath(path) {
  const uidDir = dirname(path);
  const base = dirname(uidDir);
  let canonicalBase = base;
  try {
    canonicalBase = realpathSync(base);
  } catch {}
  return join(canonicalBase, basename(uidDir), basename(path));
}

export function resolvedTmuxSocket() {
  const shared = sharedTmuxSocket();
  const inherited = process.env.TMUX?.split(",")[0];
  if (inherited) {
    const canonical = canonicalSocketPath(inherited);
    return canonical === shared ? null : canonical;
  }
  if (!process.env.TMUX_TMPDIR) return null;
  try {
    const resolved = tmuxSocketUnder(realpathSync(process.env.TMUX_TMPDIR));
    return resolved === shared ? null : resolved;
  } catch {
    return null;
  }
}

export function recordScratchTmuxSocket(socket) {
  if (!LEAK_MANIFEST) return;
  try {
    appendFileSync(LEAK_MANIFEST, `${socket}\n`);
  } catch {

  }
}

export function isolateTmux(suite) {
  const tmuxTmp = mkdtempSync(join(tmpdir(), "hive-tmux-"));
  process.env.TMUX_TMPDIR = tmuxTmp;
  delete process.env.TMUX;
  delete process.env.TMUX_PANE;

  const socket = tmuxSocketUnder(tmuxTmp);

  recordScratchTmuxSocket(socket);

  let hasTmux = true;
  try {
    execFileSync("tmux", ["-V"], { stdio: "ignore" });
  } catch {
    hasTmux = false;
  }

  if (!hasTmux && process.env.CI) {
    throw new Error(`tmux is missing on CI; ${suite} cannot run. Restore the install step in ci.yml.`);
  }

  process.on("exit", () => {

    try {

      const left = execFileSync("tmux", ["-S", socket, "list-sessions", "-F", "#{session_name}"], {
        encoding: "utf8",
        timeout: 5000,
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
      if (left) {
        console.error(`${suite}: left tmux session(s) behind on its own private socket: ${left.split("\n").join(", ")}`);
        process.exitCode = 1;
      }
    } catch {

    }

    try {
      execFileSync("tmux", ["-S", socket, "kill-server"], { stdio: "ignore", timeout: 5000, killSignal: "SIGKILL" });
    } catch {

    }

    const answeredNoServer = /no server running|error connecting to/;
    const settle = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    const stillThere = () => {
      try {
        execFileSync("tmux", ["-S", socket, "list-sessions", "-F", "#{session_name}"], {
          encoding: "utf8",
          timeout: 2000,
          killSignal: "SIGKILL",
          stdio: ["ignore", "pipe", "pipe"],
        });
        return "is still answering";
      } catch (e) {

        if (e?.code === "ETIMEDOUT") return "did not answer (wedged)";

        if (e?.code === "ENOENT") return null;
        const stderr = (typeof e?.stderr === "string" ? e.stderr : e?.stderr?.toString() ?? "").trim();
        if (answeredNoServer.test(stderr)) return null;
        return `could not be probed (${stderr || e?.code || e?.message})`;
      }
    };
    let survivor = existsSync(socket) ? stillThere() : null;

    if (survivor !== null && survivor !== "did not answer (wedged)") {
      settle();
      survivor = stillThere();
    }
    if (survivor) {

      console.error(
        `${suite}: its tmux server ${survivor} after kill-server. Nothing has said it is gone, so ${tmuxTmp} ` +
          `stays in place and it remains reachable: tmux -S ${socket} kill-server`,
      );
      process.exitCode = 1;
      return;
    }
    try {
      rmSync(tmuxTmp, { recursive: true, force: true });
    } catch {

    }
  });

  const cleanup = (...sessions) => {
    if (sessions.length === 0) return;

    const target = resolvedTmuxSocket();
    if (!target) {
      console.error(
        `${suite}: cleanup() cannot resolve a reachable tmux socket (TMUX_TMPDIR=` +
          `${process.env.TMUX_TMPDIR ?? "unset"}); refusing to kill-session ${sessions.join(", ")} ` +
          "rather than fall through to the shared socket.",
      );
      process.exitCode = 1;
      return;
    }
    for (const session of sessions) {
      try {
        execFileSync("tmux", ["-S", target, "kill-session", "-t", `=${session}`], {
          stdio: "ignore",
          timeout: 5000,
          killSignal: "SIGKILL",
        });
      } catch {

      }
    }
  };
  return { hasTmux, cleanup };
}

export function scratchTmuxServer({ prefix = "hive-tmux-", session = "orphan", ageHours = 0 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), prefix));

  const socket = tmuxSocketUnder(realpathSync(dir));
  mkdirSync(dirname(socket), { recursive: true });

  recordScratchTmuxSocket(socket);
  execFileSync("tmux", ["-S", socket, "new-session", "-d", "-s", session, "sleep", "300"], {
    stdio: "ignore",
    timeout: 5000,
    killSignal: "SIGKILL",
  });

  if (ageHours > 0) {
    const when = new Date(Date.now() - ageHours * 3_600_000);
    utimesSync(socket, when, when);
  }
  const reap = () => {
    try {
      execFileSync("tmux", ["-S", socket, "kill-session", "-t", `=${session}`], {
        stdio: "ignore",
        timeout: 5000,
        killSignal: "SIGKILL",
      });
    } catch {

    }
    rmSync(dir, { recursive: true, force: true });
  };
  return { socket, dir, reap };
}

export function fakeHangingTmux({ hangOn, log } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "hive-hangingtmux-"));

  const record = log ? `printf '%s\\n' "$1" >> ${JSON.stringify(log)}\n` : "";
  const body = hangOn
    ? `#!/bin/sh\n${record}if [ "$1" = "${hangOn}" ]; then exec sleep 30; fi\nexec ${execFileSync("which", ["tmux"], { encoding: "utf8" }).trim()} "$@"\n`
    : `#!/bin/sh\n${record}exec sleep 30\n`;
  writeFileSync(join(dir, "tmux"), body, { mode: 0o755 });
  return dir;
}

// A pass-through tmux that records the argv of every call before running the real one, so a test can
// assert on the SEQUENCE hive issues rather than only on the state it leaves behind. Argv is recorded
// one call per line, fields separated by \x1f, because the arguments carry spaces and tabs of their own.
export function recordingTmux({ log }) {
  const dir = mkdtempSync(join(tmpdir(), "hive-recordingtmux-"));
  const real = execFileSync("which", ["tmux"], { encoding: "utf8" }).trim();
  const body =
    `#!/bin/sh\n{ printf '%s\\037' "$@"; printf '\\n'; } >> ${JSON.stringify(log)}\n` + `exec ${real} "$@"\n`;
  writeFileSync(join(dir, "tmux"), body, { mode: 0o755 });
  writeFileSync(log, "");
  return dir;
}

export function tmuxCallsIn(log) {
  return readFileSync(log, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("\x1f").filter((field) => field !== ""));
}

export function fakeFailingTmux({ failOn, stderr = "tmux: operation not permitted" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "hive-failingtmux-"));
  const fail = `printf '%s\\n' ${JSON.stringify(stderr)} >&2; exit 1`;
  const body = failOn
    ? `#!/bin/sh\nif [ "$1" = "${failOn}" ]; then ${fail}; fi\n` +
      `exec ${execFileSync("which", ["tmux"], { encoding: "utf8" }).trim()} "$@"\n`
    : `#!/bin/sh\n${fail}\n`;
  writeFileSync(join(dir, "tmux"), body, { mode: 0o755 });
  return dir;
}

// The most-used tmux helper in the suite, driving mutating verbs (kill-window, kill-pane, respawn-pane,
// split-window, set-option, new-session...) from dozens of files - exactly the shape that needs pinning
// most, per the same reasoning that already scopes cleanup()/createLiveAndDialogPanes()/
// repaintPaneAsSameWorker() to helpers.mjs rather than each call site.
export function tmux(...args) {
  const socket = resolvedTmuxSocket();
  if (!socket) {
    throw new Error(`tmux(): cannot resolve a reachable tmux socket (TMUX_TMPDIR=${process.env.TMUX_TMPDIR ?? "unset"})`);
  }
  return execFileSync("tmux", ["-S", socket, ...args], { encoding: "utf8", timeout: 5000, killSignal: "SIGKILL" })
    .replace(/\n$/, "");
}

export function windowOwners(session) {
  return tmux("list-windows", "-t", `=${session}`, "-F", "#{window_id}\t#{@hive-project-id}")
    .split("\n")
    .map((row) => row.split("\t"));
}

export function panesIn(target) {
  return tmux("list-panes", "-t", target, "-F", "#{pane_id}").split("\n").filter(Boolean);
}

export function paneField(pane, field) {
  return tmux("list-panes", "-t", pane, "-F", `#{pane_id}\t${field}`)
    .split("\n")
    .map((row) => row.split("\t"))
    .find(([id]) => id === pane)?.[1];
}

export function windowFor(session, projectId) {
  const owners = windowOwners(session);
  const match = owners.find(([, id]) => id === String(projectId));
  assert.ok(match, `expected a window stamped for project ${projectId}, got: ${JSON.stringify(owners)}`);
  return match[0];
}

export class McpClient {
  constructor({ cwd, dataDir, env = {} }) {
    this.child = spawn("node", [SERVER], {
      cwd,
      env: {
        ...baseEnv(),
        HIVE_DATA_DIR: dataDir,
        HIVE_AUTO_ATTACH: "0",
        ...env,
      },
      stdio: ["pipe", "pipe", "inherit"],
    });
    this.nextId = 1;
    this.pending = new Map();

    this.child.stdout.setEncoding("utf8");
    let buffer = "";
    this.child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        const resolve = this.pending.get(msg.id);
        if (resolve) {
          this.pending.delete(msg.id);
          resolve(msg);
        }
      }
    });
  }

  send(payload) {
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for ${method} (id ${id})`));
      }, 15000);
      this.pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  async start() {
    await this.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "hive-test", version: "0" },
    });
    this.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  }

  async call(name, args = {}) {
    const msg = await this.request("tools/call", { name, arguments: args });
    if (msg.error) throw new Error(msg.error.message);
    const text = msg.result?.content?.[0]?.text ?? "";
    if (msg.result?.isError) throw new Error(text);
    return text ? JSON.parse(text) : null;
  }

  async close() {
    this.child.stdin.end();
    const exited = new Promise((resolve) => this.child.once("exit", resolve));
    const timeout = new Promise((resolve) => setTimeout(resolve, 3000).unref());
    await Promise.race([exited, timeout]);
    if (this.child.exitCode == null) this.child.kill("SIGKILL");
  }
}

export async function liveAgentRow(mcp, name) {
  const row = (await mcp.call("agent_list")).agents.find((a) => a.name === name);
  assert.ok(row?.alive, `worker "${name}" should be running, got ${JSON.stringify(row)}`);
  return row;
}

export function runCli(args, opts = {}) {
  return runNode(CLI, args, opts);
}

export const summaryLine = (stdout) => stdout.trim().split("\n").pop();
export const failureCount = (stdout) => {
  const m = summaryLine(stdout).match(/^(\d+) problem/);
  return m ? Number(m[1]) : 0;
};

export const warningCount = (stdout) => {
  const m = summaryLine(stdout).match(/(\d+) warning\(s\)/);
  return m ? Number(m[1]) : 0;
};

export const promotedCount = (stdout) => {
  const m = summaryLine(stdout).match(/(\d+) promoted by --strict/);
  return m ? Number(m[1]) : 0;
};

export function runNode(script, args, { cwd, dataDir, tmp, env = {}, node = "node", stdin } = {}) {
  return new Promise((resolve) => {
    const child = spawn(node, [script, ...args], {
      cwd,
      env: {
        ...baseEnv(),
        HIVE_DATA_DIR: dataDir,
        HIVE_AUTO_ATTACH: "0",
        HIVE_EDITOR: "true",
        ...(tmp ? { TMPDIR: tmp } : {}),
        ...env,
      },
      stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    if (stdin !== undefined) child.stdin.end(stdin);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

export function alternateInterpreter() {
  const candidates = [
    process.env.HIVE_TEST_ALT_NODE,
    "/opt/homebrew/bin/node",
    "/usr/local/bin/node",
    "/usr/bin/node",
  ].filter((c) => c && existsSync(c));
  for (const candidate of candidates) {
    try {
      const modules = execFileSync(candidate, ["-p", "process.versions.modules"], { encoding: "utf8" }).trim();
      if (modules !== process.versions.modules) return { path: candidate, modules };
    } catch {

    }
  }
  return null;
}

const CLASSIC_ADDON_ABIS = [127, 137];
export function classicAddonFixture({ matches, against = process.versions.modules }) {
  const target = `${process.platform}-${process.arch}`;
  if (!["darwin-arm64", "linux-x64"].includes(target)) return null;
  const running = Number(against);
  const abi = matches
    ? CLASSIC_ADDON_ABIS.find((a) => a === running)
    : CLASSIC_ADDON_ABIS.find((a) => a !== running);
  if (abi === undefined) return null;
  return join(REPO, "test", "fixtures", "native-addon-abi", `${target}-abi${abi}.node`);
}

export function writeScratchAddon(root, { prebuild, classic = false, napiVersion, layout = "prebuilds" } = {}) {
  cpSync(DIST, join(root, "dist"), { recursive: true });
  const scratchModules = join(root, "node_modules");
  mkdirSync(scratchModules, { recursive: true });
  const realModules = join(REPO, "node_modules");
  for (const entry of readdirSync(realModules)) {
    if (entry === "better-sqlite3") continue;
    symlinkSync(join(realModules, entry), join(scratchModules, entry));
  }
  symlinkSync(join(REPO, "profiles"), join(root, "profiles"));

  cpSync(join(REPO, "claude-plugin"), join(root, "claude-plugin"), { recursive: true });

  const scratchAddon = join(scratchModules, "better-sqlite3");
  mkdirSync(scratchAddon, { recursive: true });
  if (classic) {
    const classicPkg = join(REPO, "test", "fixtures", "native-addon-abi", "classic-package");
    copyFileSync(join(classicPkg, "package.json"), join(scratchAddon, "package.json"));
    cpSync(join(classicPkg, "lib"), join(scratchAddon, "lib"), { recursive: true });

    for (const dep of readdirSync(join(classicPkg, "vendor"))) {

      const dest = join(scratchModules, dep);
      rmSync(dest, { recursive: true, force: true });
      cpSync(join(classicPkg, "vendor", dep), dest, { recursive: true });
    }
    if (prebuild) {
      mkdirSync(join(scratchAddon, "build", "Release"), { recursive: true });
      copyFileSync(prebuild, join(scratchAddon, "build", "Release", "better_sqlite3.node"));
    }
  } else {
    copyFileSync(join(realModules, "better-sqlite3", "package.json"), join(scratchAddon, "package.json"));
    cpSync(join(realModules, "better-sqlite3", "lib"), join(scratchAddon, "lib"), { recursive: true });

    const realGyp = readFileSync(join(realModules, "better-sqlite3", "binding.gyp"), "utf8");
    writeFileSync(
      join(scratchAddon, "binding.gyp"),
      napiVersion === undefined ? realGyp : realGyp.replace(/NAPI_VERSION=\d+/, `NAPI_VERSION=${napiVersion}`),
    );
    mkdirSync(join(scratchAddon, "prebuilds"), { recursive: true });
    if (prebuild && layout === "debug") {
      mkdirSync(join(scratchAddon, "build", "Debug"), { recursive: true });
      copyFileSync(prebuild, join(scratchAddon, "build", "Debug", "better_sqlite3.node"));
    } else if (prebuild) {
      copyFileSync(prebuild, join(scratchAddon, "prebuilds", `${process.platform}-${process.arch}.node`));
    }
  }

  return {
    dist: join(root, "dist"),
    cli: join(root, "dist", "cli.js"),
    kickoff: join(root, "dist", "kickoff.js"),
    kickoffMjs: join(root, "claude-plugin", "kickoff.mjs"),
  };
}

export function scratchGit(cwd, ...args) {
  return execFileSync(
    "git",
    ["-c", "commit.gpgsign=false", "-c", "gpg.format=openpgp", "-c", "core.hooksPath=/dev/null", ...args],
    {
      cwd,
      encoding: "utf8",
      env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
    },
  );
}

export function firedSessionStart(stdout) {
  const payload = JSON.parse(stdout);
  assert.equal(payload.hookSpecificOutput.hookEventName, "SessionStart");
  return payload.hookSpecificOutput;
}

export function insertStateLogRow(db, actorId, event, state, agoSeconds, payload = "{}") {
  db.prepare(
    "INSERT INTO agent_state_log (actor_id, event, state, payload, created_at) VALUES (?, ?, ?, ?, strftime('%Y-%m-%d %H:%M:%f', 'now', ?))",
  ).run(actorId, event, state, payload, `-${agoSeconds} seconds`);
}

export function createLiveAndDialogPanes(session, fixtureFile) {
  const socket = resolvedTmuxSocket();
  if (!socket) {
    throw new Error(
      `createLiveAndDialogPanes: cannot resolve a reachable tmux socket (TMUX_TMPDIR=${process.env.TMUX_TMPDIR ?? "unset"})`,
    );
  }

  mkdirSync(dirname(socket), { recursive: true, mode: 0o700 });
  execFileSync(
    "tmux",
    ["-S", socket, "new-session", "-d", "-s", session, "-x", "300", "-y", "60", "sleep 600"],
    { stdio: "ignore" },
  );
  const livePane = execFileSync("tmux", ["-S", socket, "list-panes", "-t", `=${session}`, "-F", "#{pane_id}"], {
    encoding: "utf8",
  })
    .trim()
    .split("\n")[0];
  const dialogPane = execFileSync(
    "tmux",
    [
      "-S",
      socket,
      "new-window",
      "-t",
      `=${session}`,
      "-P",
      "-F",
      "#{pane_id}",

      `cat '${join(REPO, "test", "fixtures", "panes", fixtureFile)}'; sleep 600`,
    ],
    { encoding: "utf8" },
  ).trim();
  return { livePane, dialogPane };
}

export function wakeConfirmPayload(wakeId) {
  return JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: `[hive wake #${wakeId}] acknowledged` });
}

export function leadRow(db, projectId) {
  return db.prepare("SELECT * FROM agents WHERE project_id = ? AND kind = 'lead'").get(projectId);
}

export function seedLeadRow(db, projectId, projectDir, socket = "") {
  return db
    .prepare(
      `INSERT INTO agents (project_id, actor_id, name, tmux_target, tmux_socket, command, cwd, kind, status)
       VALUES (?, 'lead:999', 'lead', '%not-a-real-pane', ?, 'claude', ?, 'lead', 'running')
       RETURNING id`,
    )
    .get(projectId, socket, projectDir).id;
}

export function repaintPaneAsSameWorker(db, target, command) {
  const socket = resolvedTmuxSocket();
  if (!socket) {
    throw new Error(
      `repaintPaneAsSameWorker: cannot resolve a reachable tmux socket (TMUX_TMPDIR=${process.env.TMUX_TMPDIR ?? "unset"})`,
    );
  }
  execFileSync("tmux", ["-S", socket, "respawn-pane", "-k", "-t", target, command], { stdio: "ignore" });
  const pid = paneField(target, "#{pane_pid}");
  assert.ok(pid, `respawn-pane left no readable pid for ${target}`);

  const reclaim = db.prepare(
    "UPDATE agents SET pane_pid = ?, status = 'running', closed_at = NULL " +
      "WHERE tmux_target = ? AND (status = 'running' OR (status = 'closed' AND pane_pid != ?))",
  );
  const row = db.prepare("SELECT status, pane_pid FROM agents WHERE tmux_target = ?");
  const deadline = Date.now() + 2000;
  let stable = false;
  while (!stable) {
    assert.equal(reclaim.run(pid, target, pid).changes, 1, `no row naming ${target} to re-record a pid onto`);
    const now = row.get(target);
    stable = now.status === "running" && now.pane_pid === pid;
    if (!stable && Date.now() > deadline) {
      assert.fail(`row naming ${target} would not stay running with pid ${pid}: ${JSON.stringify(now)}`);
    }
  }
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function until(predicate, timeoutMs = 3000, stepMs = 25) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() >= deadline) return false;
    await sleep(stepMs);
  }
}

export function withEnv(vars, fn) {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

export function raceProcesses(scriptSource, argvList, { env = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "hive-race-"));
  const barrierDir = join(dir, "barrier");
  mkdirSync(barrierDir, { recursive: true });
  const expected = argvList.length;
  const barrier = `
import { mkdirSync as __hiveBarrierMkdir, readdirSync as __hiveBarrierList, writeFileSync as __hiveBarrierWrite } from "node:fs";
__hiveBarrierMkdir(${JSON.stringify(barrierDir)}, { recursive: true });
__hiveBarrierWrite(${JSON.stringify(barrierDir)} + "/" + process.pid, "");
{
  const __hiveBarrierDeadline = Date.now() + 10000;
  while (__hiveBarrierList(${JSON.stringify(barrierDir)}).length < ${expected} && Date.now() < __hiveBarrierDeadline) {
    // Synchronous spin, deliberately: see raceProcesses' own comment in
    // test/helpers.mjs for why this must not yield.
  }
}
`;
  const script = join(dir, "race.mjs");
  writeFileSync(script, `${barrier}\n${scriptSource}`);
  return Promise.all(
    argvList.map(
      (argv) =>
        new Promise((resolve, reject) => {
          const child = spawn(process.execPath, [script, ...argv], {
            env: { ...baseEnv(), HIVE_AUTO_ATTACH: "0", ...env },
            stdio: ["ignore", "pipe", "inherit"],
          });
          let out = "";
          child.stdout.on("data", (c) => (out += c));
          child.on("exit", (code) => {
            if (code !== 0) return reject(new Error(`race child exited ${code}, stdout: ${out}`));
            try {
              resolve(JSON.parse(out));
            } catch {
              reject(new Error(`race child produced non-JSON stdout: ${out}`));
            }
          });
        }),
    ),
  );
}

export function toolRegistrationsByFile() {
  const dir = join(REPO, "src/tools");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".ts") && f !== "params.ts")
    .sort()
    .map((file) => {
      const src = readFileSync(join(dir, file), "utf8");
      const names = [...src.matchAll(/registerTool\(\s*"([a-zA-Z_]+)"/g)].map((m) => m[1]);
      return { file, src, names };
    });
}

export function registeredToolNames() {
  return toolRegistrationsByFile()
    .flatMap((f) => f.names)
    .sort();
}

export function seedDeadPaneLead(db, projectId, projectDir, actorId) {
  return db
    .prepare(
      `INSERT INTO agents (project_id, actor_id, name, tmux_target, command, cwd, kind, status, created_at)
       VALUES (?, ?, 'lead', '%deadlead', 'claude', ?, 'lead', 'running', datetime('now', '-300 seconds'))
       RETURNING id`,
    )
    .get(projectId, actorId, projectDir).id;
}

export const UPSERT_ACTOR_SQL_PREFIX = "INSERT INTO actors (id, name, kind)";

export function seedStandingWatch(db, projectId, owner, { pane = "%deadlead", body = "crew update" } = {}) {
  return db
    .prepare(
      `INSERT INTO timers (project_id, owner, body, kind, watch, watch_scope, deliver_actor, deliver_pane,
         max_wait_at, created_at)
       VALUES (?, ?, ?, 'idle_any', '[]', 'project', ?, ?, datetime('now', '+4 hours'),
         datetime('now', '-60 seconds')) RETURNING id`,
    )
    .get(projectId, owner, body, owner, pane).id;
}

export function standingNoticeBodies(db, watchId) {
  return db
    .prepare("SELECT body FROM timers WHERE parent_timer_id = ? ORDER BY id")
    .all(watchId)
    .map((r) => r.body);
}

function claimedUnderWatch(db, watchId, name, condition) {
  return (
    db
      .prepare(
        `SELECT 1 FROM wake_idle_notices n JOIN agents a ON a.id = n.agent_id
          WHERE n.timer_id = ? AND a.name = ? AND n.notice_timer_id IS NOT NULL
            ${condition === null ? "" : "AND n.condition = ?"}`,
      )
      .get(...(condition === null ? [watchId, name] : [watchId, name, condition])) !== undefined
  );
}

// A folded finish (past FINISHED_SHOWN_CAP, "...and N more finish(es) not shown above.") carries no
// name in the rendered text at all - src/scheduler.ts drops it to a bare count, so no regex over the
// body can ever recover it. wake_idle_notices is the claim record every finish stamps regardless of
// whether it made the visible slice (claimStandingBatch's stampEpisodeNotice), so reading THAT is the
// only way to answer "was this name's finish reported at all" once the render has folded it away.
// Do NOT also match the "Still going" roster here: that would re-open the 2026-08-11 defect the
// two-space anchor was added to close (.claude/sessions/common-issues/a-bare-name-matcher-also-
// matches-the-still-going-roster.md) - "was this worker reported" and "is this worker merely alive
// and mentioned in passing" collapsing back into one question. A worker's roster mention carries no
// claim row at all, so a still-going name folded past ROSTER_STILL_GOING is a real, undecidable gap,
// same shape as the finish-overflow one but with no ground truth to fall back on.
export function namedInStandingReport(db, watchId, name) {
  return claimedUnderWatch(db, watchId, name, null);
}

export function reportedAsFinished(db, watchId, name) {
  return claimedUnderWatch(db, watchId, name, "idle");
}
