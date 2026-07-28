import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const SERVER = new URL("../dist/index.js", import.meta.url).pathname;
export const CLI = new URL("../dist/cli.js", import.meta.url).pathname;
// The SessionStart hook runs this file directly, not through cli.js.
export const KICKOFF = new URL("../dist/kickoff.js", import.meta.url).pathname;

// The suite is normally run from inside a hive worker pane, whose env carries
// HIVE_AGENT_ID, HIVE_PROJECT_LOCK and friends. Inheriting those makes a
// spawned server think it is that worker, so drop the whole namespace and let
// each helper set back only what it means to. Explicit per-call env still wins.
function baseEnv() {
  return Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("HIVE_")));
}

export function scratchDirs() {
  // realpath because macOS tmpdir is a symlink (/var -> /private/var) and
  // hive resolves project paths to their real location.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hive-test-")));
  return {
    dataDir: join(root, "data"),
    projectDir: mkdtempSync(join(root, "project-")),
    tmp: mkdtempSync(join(root, "tmp-")),
  };
}

// Puts this process, and every child that inherits its env, on a private tmux
// server. Call it at module top level, before anything spawns tmux.
//
// Every tmux call in the suite, including the ones inside dist/tmux.js,
// inherits this env. Pointing TMUX_TMPDIR at a private socket dir keeps the
// suite off the developer's own server, so a hard crash cannot strand a
// session there; clearing TMUX/TMUX_PANE stops tmux from treating the pane
// running the tests as a target. Short dir: unix socket paths cap out around
// 104 bytes.
//
// This lives here because it encodes a stated invariant (see CLAUDE.md), and a
// second hand-rolled copy that drifts fails open: it talks to the real server
// and can act on the session the developer is working in.
//
// Returns { hasTmux, cleanup }. cleanup(...sessionNames) kills only the named
// sessions and removes the socket dir. Never kill-server: the code under test
// resolves its server from the ambient env, so the suite cannot pin one with
// -L, and a bare kill-server takes down whatever that env points at.
export function isolateTmux(suite) {
  const tmuxTmp = mkdtempSync(join(tmpdir(), "hive-tmux-"));
  process.env.TMUX_TMPDIR = tmuxTmp;
  delete process.env.TMUX;
  delete process.env.TMUX_PANE;

  let hasTmux = true;
  try {
    execFileSync("tmux", ["-V"], { stdio: "ignore" });
  } catch {
    hasTmux = false;
  }
  // CI installs tmux, so a skip there means the workflow lost that step and
  // these tests are quietly covering nothing. Fail instead of skipping.
  if (!hasTmux && process.env.CI) {
    throw new Error(`tmux is missing on CI; ${suite} cannot run. Restore the install step in ci.yml.`);
  }

  const cleanup = (...sessions) => {
    for (const session of sessions) {
      try {
        execFileSync("tmux", ["kill-session", "-t", `=${session}`], { stdio: "ignore" });
      } catch {
        // Never started, or already gone.
      }
    }
    rmSync(tmuxTmp, { recursive: true, force: true });
  };
  return { hasTmux, cleanup };
}

// Minimal MCP stdio client. Requests are sent sequentially; the server
// handles piped requests concurrently, so callers must await each call.
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

  // Calls a tool and parses the JSON receipt. Tool-level failures throw
  // with the error text so tests can assert on messages.
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

export function runCli(args, opts = {}) {
  return runNode(CLI, args, opts);
}

export function runNode(script, args, { cwd, dataDir, tmp, env = {} } = {}) {
  return new Promise((resolve) => {
    const child = spawn("node", [script, ...args], {
      cwd,
      env: {
        ...baseEnv(),
        HIVE_DATA_DIR: dataDir,
        HIVE_AUTO_ATTACH: "0",
        HIVE_EDITOR: "true",
        ...(tmp ? { TMPDIR: tmp } : {}),
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
