import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const REPO = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
export const DIST = join(REPO, "dist");
export const SERVER = join(DIST, "index.js");
export const CLI = join(DIST, "cli.js");
// The SessionStart hook runs this file directly, not through cli.js.
export const KICKOFF = join(DIST, "kickoff.js");

// The suite is normally run from inside a hive worker pane, whose env carries
// HIVE_AGENT_ID, HIVE_PROJECT_LOCK and friends. Inheriting those makes a
// spawned server think it is that worker, so drop the whole namespace and let
// each helper set back only what it means to. Explicit per-call env still wins.
function baseEnv() {
  return Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("HIVE_")));
}

// The in-process counterpart of baseEnv, for a test that imports dist/ rather
// than spawning it: same rule, applied to this process. Call it before the
// first import of anything that reads HIVE_* at module load, then set back
// only what the test means to.
export function clearHiveEnv() {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("HIVE_")) delete process.env[key];
  }
}

// A project with hive.yml processes that hive will actually run.
//
// Two things gate every hive.yml command path, and a test that skips either
// one never reaches the code it means to test. The config has to be on disk
// where loadProjectYml finds it, and the command has to be trusted, which is
// normally an interactive y/N prompt: without the trust row a non-TTY run
// prints "not trusted yet" and returns before doing anything.
//
// Trust is keyed by a hash of exactly what will run, so this seeds it with
// hive's own configHash rather than a copy. A drift between the two would
// otherwise show up as a test that mysteriously stopped reaching the command.
//
// db is passed in and configHash is imported INSIDE the function so that
// nothing here pulls dist/ in at hoist time. That is no longer what stands
// between the suite and a live store (see test/store-isolation.test.mjs), but
// a static dist import at the top of this file is the literal line that
// destroyed one, and every test file imports this one.
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

// Call this after setting HIVE_DATA_DIR and BEFORE importing dist/db.js, in
// any test file that imports dist/ directly instead of spawning it.
//
// Two structural guards now stand behind this, and it is worth being precise
// about what is left for it to do. dist/dataDir.js reads HIVE_DATA_DIR when
// asked rather than caching it at module load, so import order no longer
// decides the store; and storeDir() refuses the real ~/.hive outright when a
// test runner is the entry point, so a file that never sets HIVE_DATA_DIR
// fails loudly instead of running its DELETEs on a live store. Neither can
// tell one scratch directory from another: HIVE_DATA_DIR inherited from the
// worker pane this suite usually runs in points somewhere real enough to
// satisfy both and wrong enough to ruin the run. That is this function's
// remaining job, plus giving a destructive file its error at the top instead
// of at the first statement. See test/store-isolation.test.mjs.
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
// ALWAYS PAIR THIS WITH A SCRATCH HIVE_DATA_DIR. Isolating tmux on its own is
// the more dangerous half-measure, not the safe subset: a hive process on a
// private tmux server while still using the default store asks that server
// about panes that live on the shared one, gets a correct "no such pane", and
// sweeps every agent in the real store as dead. That happened on 2026-07-29.
// hive refuses that pair outright now (see untrustedTmuxServer in src/tmux.ts),
// so a caller who sets only this one gets a hive that answers "unknown" to
// every liveness question rather than a hive that destroys state. Setting both
// is what a test actually wants.
//
// Returns { hasTmux, cleanup }. cleanup(...sessionNames) kills ONLY the named
// sessions. Never kill-server: the code under test resolves its server from the
// ambient env, so the suite cannot pin one with -L, and a bare kill-server takes
// down whatever that env points at.
//
// cleanup deliberately does NOT remove the socket directory, and that is the
// whole reason this comment exists. It used to, and a file with more than one
// tmux describe then destroyed its own isolation halfway through: the first
// after() hook removed the dir, TMUX_TMPDIR went on naming a path that no longer
// existed, and tmux DOES NOT CREATE IT. Per CLAUDE.md that resolves to the
// SHARED socket, so every later describe in the file quietly created its
// sessions on the developer's own tmux server. On 2026-07-29 that put a
// list-panes -a in a test face to face with the developer's real panes and typed
// five wake bodies into a live claude session. Nothing was lost, and nothing
// about it was loud.
//
// So the directory is removed once, on process exit, when no more tmux calls can
// happen. Registered once per isolateTmux call; a file that calls it twice gets
// two handlers for two directories, which is correct.
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

  process.on("exit", () => {
    try {
      rmSync(tmuxTmp, { recursive: true, force: true });
    } catch {
      // A scratch dir left in the system temp dir is not worth a failed run.
    }
  });

  const cleanup = (...sessions) => {
    for (const session of sessions) {
      try {
        execFileSync("tmux", ["kill-session", "-t", `=${session}`], { stdio: "ignore" });
      } catch {
        // Never started, or already gone.
      }
    }
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

// A receipt is not proof of a worker. A pane whose command exits immediately
// still returns a tmux_target, so a spawn test that trusts the receipt passes
// while nothing is running. Read the row back and require it alive.
export async function liveAgentRow(mcp, name) {
  const row = (await mcp.call("agent_list")).agents.find((a) => a.name === name);
  assert.ok(row?.alive, `worker "${name}" should be running, got ${JSON.stringify(row)}`);
  return row;
}

export function runCli(args, opts = {}) {
  return runNode(CLI, args, opts);
}

// node defaults to whatever the suite is running under. Pass another
// interpreter to test what happens when hive is run by one it was not built
// for; everything else about the call stays identical.
// stdin: a string to write to the child, for an entry point that reads fd 0
// (dist/hook.js takes its Claude Code payload that way). Opened as a pipe only
// when asked, so every existing caller keeps the "ignore" it relies on.
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

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Wait for a condition instead of guessing how long it takes. A fixed sleep
// pays its full cost on every run and still flakes on a loaded CI, because the
// number that is comfortable locally is the ceiling everywhere. Polling exits
// on the first true and can afford a generous deadline, so it is both faster
// and more tolerant than the sleep it replaces. Returns whether the condition
// held, so a caller can assert on it rather than on a timeout.
export async function until(predicate, timeoutMs = 3000, stepMs = 25) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() >= deadline) return false;
    await sleep(stepMs);
  }
}

// Set env vars for the duration of fn, then put back exactly what was there.
// undefined means DELETE the variable, which is the case the suite actually
// needs and the one a plain Object.assign restore gets wrong: assigning
// undefined to a process.env key stores the string "undefined" rather than
// unsetting it. Synchronous on purpose, so the restore cannot interleave with
// another test's env.
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
