#!/usr/bin/env node

import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";

import { DIST_DIR, MCP_CONFIG_FILE, REPO_DIR, cmdDown, cmdUp } from "./isolated-hive.mjs";
import { runAllAssertions } from "./part-c-assert.mjs";

const PART_C_RESULT_KV_KEY = "part-c-gate:last-run";

const SUBAGENT_SLEEPS_SECONDS = [6, 12, 18];
const POLL_INTERVAL_MS = 2000;
const RUN_TIMEOUT_MS = 5 * 60 * 1000;
const WAKE_MAX_WAIT_SECONDS = 280;

function gitSnapshot(repoDir) {
  return {
    head: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir, encoding: "utf8" }).trim(),
    status: execFileSync("git", ["status", "--porcelain"], { cwd: repoDir, encoding: "utf8" }),
  };
}

function distChecksum(distDir) {
  const hash = createHash("sha256");
  const walk = (dir) => {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      hash.update(full.slice(distDir.length));
      hash.update(readFileSync(full));
    }
  };
  walk(distDir);
  return hash.digest("hex");
}

class McpClient {
  constructor(distDir, env) {
    this.child = spawn(process.execPath, [join(distDir, "index.js")], {
      env,
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
      }, 30_000);
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
      clientInfo: { name: "hive-part-c-gate", version: "0" },
    });
    this.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  }

  async call(name, args = {}) {
    const msg = await this.request("tools/call", { name, arguments: args });
    if (msg.error) throw new Error(`${name}: ${msg.error.message}`);
    const text = msg.result?.content?.[0]?.text ?? "";
    if (msg.result?.isError) throw new Error(`${name}: ${text}`);
    return text ? JSON.parse(text) : null;
  }

  async close() {
    this.child.stdin.end();

    if (this.child.exitCode !== null) return;
    const exited = new Promise((resolve) => this.child.once("exit", resolve));
    const timeout = new Promise((resolve) => setTimeout(resolve, 3000).unref());
    await Promise.race([exited, timeout]);
    if (this.child.exitCode == null) {
      this.child.kill("SIGKILL");
      await exited;
    }
  }
}

function mcpVerificationPath(completionsDir) {
  return join(completionsDir, "mcp-server.confirmed");
}

function workerAssignment(completionsDir) {
  const tasks = SUBAGENT_SLEEPS_SECONDS.map(
    (seconds, i) =>
      `Subagent ${i + 1}: using the Bash tool, run exactly: sleep ${seconds} && date +%s > "${join(completionsDir, `${i + 1}.completed`)}" -- then stop. No other action.`,
  ).join("\n");
  return [
    "Automated end-to-end test (issue #31 part C). Do exactly this and nothing else:",
    "",

    `0. Call the "whoami" tool from your hive MCP server. In your tool list its full name starts with "mcp__" followed by the server's key. Using the Bash tool, write that EXACT full tool name (e.g. mcp__hive-iso__whoami) as the only line of "${mcpVerificationPath(completionsDir)}" -- nothing else in the file, no extra whitespace. Do this before step 1.`,
    "",
    `1. Use your Agent tool to launch ${SUBAGENT_SLEEPS_SECONDS.length} background subagents (run_in_background: true), one per task below:`,
    tasks,
    "",
    "2. Once all are launched, reply with one short line confirming how many you launched, then stop. Do not poll, wait for, or check on them yourself, and do not do any other work this turn.",
    "",
    `3. Do not read, write, or run anything outside ${completionsDir}. In particular, make no edits anywhere else in this repository -- this session's cwd sits inside a trusted checkout, but its task is scoped to that one directory only.`,
  ].join("\n");
}

function readTimer(dbPath, timerId) {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    return db.prepare("SELECT fired_at, cancelled_at, due_at, max_wait_at FROM timers WHERE id = ?").get(timerId);
  } finally {
    db.close();
  }
}

function readGlobalSpan(dbPath) {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    return db
      .prepare("SELECT MIN(id) AS lo, MAX(id) AS hi, COUNT(*) AS count, MIN(created_at) AS oldest FROM agent_state_log")
      .get();
  } finally {
    db.close();
  }
}

function readRows(dbPath, actorId, timerId) {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {

    const log = db
      .prepare("SELECT event, state, payload, created_at FROM agent_state_log WHERE actor_id = ? ORDER BY id")
      .all(actorId);
    const timer = db.prepare("SELECT fired_at, cancelled_at, due_at, max_wait_at FROM timers WHERE id = ?").get(timerId);
    return { log, timer };
  } finally {
    db.close();
  }
}

function completionState(completionsDir) {
  return SUBAGENT_SLEEPS_SECONDS.map((_, i) => {
    const path = join(completionsDir, `${i + 1}.completed`);
    if (!existsSync(path)) return { path, done: false };
    return { path, done: true, epochSeconds: Number(statSync(path).mtime.getTime() / 1000) };
  });
}

async function pollUntilDone({ dbPath, timerId, completionsDir, agentId, mcp, samples }) {
  const deadline = Date.now() + RUN_TIMEOUT_MS;
  for (;;) {
    const completions = completionState(completionsDir);
    const timer = readTimer(dbPath, timerId);
    const output = await mcp.call("agent_output", { agent_id: agentId, lines: 20 }).catch(() => null);
    samples.push({
      t: Date.now(),
      completions,
      firedAt: timer?.fired_at ?? null,
      cancelledAt: timer?.cancelled_at ?? null,
      maxWaitAt: timer?.max_wait_at ?? null,
      paneTail: output?.output ?? null,
    });
    if (timer?.fired_at != null || timer?.cancelled_at != null) return;
    if (Date.now() > deadline) {
      throw new Error(
        `wake never fired within ${RUN_TIMEOUT_MS / 1000}s (completions: ${JSON.stringify(completions)}, timer: ${JSON.stringify(timer)})`,
      );
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

async function runGate(instance, partial) {
  partial.gitBefore = gitSnapshot(REPO_DIR);
  partial.distChecksumBefore = distChecksum(instance.distDir);

  const mcpConfigPath = join(instance.workerRoot, MCP_CONFIG_FILE);
  const completionsDir = join(instance.workerRoot, "completions");
  mkdirSync(completionsDir, { recursive: true });
  partial.completionsDir = completionsDir;
  partial.samples = [];

  const env = {
    ...process.env,
    HIVE_DATA_DIR: instance.dataDir,
    TMUX_TMPDIR: instance.tmuxTmpDir,

    HIVE_AUTO_ATTACH: "0",
  };
  delete env.TMUX;
  delete env.TMUX_PANE;

  const mcp = new McpClient(instance.distDir, env);
  try {
    await mcp.start();

    const dbPath = join(instance.dataDir, "hive.db");
    partial.dbPath = dbPath;
    partial.agentStateLogPreRunSpan = readGlobalSpan(dbPath);

    const spawnReceipt = await mcp.call("agent_spawn", {
      name: "gate-worker",
      model: "sonnet",
      cwd: instance.workerRoot,
      extra_args: ["--mcp-config", mcpConfigPath, "--strict-mcp-config"],
    });

    if (spawnReceipt.ready !== true) {
      throw new Error(
        `worker's pane never confirmed ready/undialogued (ready=${spawnReceipt.ready}); ` +
          `receipt: ${JSON.stringify(spawnReceipt)}`,
      );
    }
    partial.worker = { agentId: spawnReceipt.agent_id, actorId: spawnReceipt.actor_id, name: spawnReceipt.name };

    const wake = await mcp.call("wake_when_idle", {

      agents: [spawnReceipt.agent_id],
      deliver_to: spawnReceipt.agent_id,
      body: "[gate] issue #31 part C: idle wake after the worker's subagents finished.",
      max_wait_seconds: WAKE_MAX_WAIT_SECONDS,
    });
    if (typeof wake.wake_id !== "number") {
      throw new Error(`wake_when_idle did not schedule a timer as expected: ${JSON.stringify(wake)}`);
    }
    partial.wakeId = wake.wake_id;

    await mcp.call("agent_send", { agent_id: spawnReceipt.agent_id, text: workerAssignment(completionsDir) });

    await pollUntilDone({
      dbPath,
      timerId: wake.wake_id,
      completionsDir,
      agentId: spawnReceipt.agent_id,
      mcp,
      samples: partial.samples,
    });

    const { log, timer } = readRows(dbPath, spawnReceipt.actor_id, wake.wake_id);
    partial.agentStateLog = log;
    partial.agentStateLogTimer = timer;
    partial.agentStateLogGlobal = readGlobalSpan(dbPath);

    const mcpVerificationFilePath = mcpVerificationPath(completionsDir);
    partial.mcpServerConfirmed = existsSync(mcpVerificationFilePath)
      ? readFileSync(mcpVerificationFilePath, "utf8").trim()
      : null;

    await mcp.call("agent_close", { agent_id: spawnReceipt.agent_id }).catch((e) => {
      console.error(`note: agent_close after the run failed (non-fatal, torn down anyway): ${e.message}`);
    });

    partial.gitAfter = gitSnapshot(REPO_DIR);
    partial.distChecksumAfter = distChecksum(instance.distDir);
  } finally {
    await mcp.close();
  }
}

function checkDataDirForResultRecording(dataDir, exists = existsSync) {
  if (dataDir && !exists(dataDir)) {
    return (
      `refuses: HIVE_DATA_DIR is set to ${dataDir}, but that directory does not exist -- writing here would ` +
      "silently recreate an empty store nobody will read the result back from. Run `down` then `up` again in " +
      "that shell, or unset HIVE_DATA_DIR before running this by hand."
    );
  }
  return null;
}

async function recordResultInStore(result, assertions, elapsedSeconds, gateError) {
  const refusal = checkDataDirForResultRecording(process.env.HIVE_DATA_DIR);
  if (refusal) throw new Error(refusal);
  const mcp = new McpClient(DIST_DIR, process.env);
  try {
    await mcp.start();
    const who = await mcp.call("whoami", {});
    await mcp.call("kv_set", {
      key: PART_C_RESULT_KV_KEY,
      value: {
        ranAt: new Date().toISOString(),
        headAtRun: result.gitBefore?.head ?? null,
        worker: result.worker ?? null,
        elapsedSeconds,
        gateError: gateError ? (gateError.stack ?? gateError.message) : null,
        overallPass: !gateError && assertions.every((a) => a.ok),
        assertions: assertions.map((a) => ({ name: a.name, ok: a.ok, detail: a.ok ? a.proof : a.error })),
      },
    });
    return { projectId: who?.project?.id ?? null, projectPath: who?.project?.path ?? null };
  } finally {
    await mcp.close();
  }
}

function installSignalHandlers() {
  const onSignal = async (signal) => {
    console.error(`part-c-gate: caught ${signal}, tearing down the isolated instance before exiting...`);
    try {
      await cmdDown(true);
    } catch (e) {
      console.error(`part-c-gate: teardown during ${signal} handling failed: ${e.message}`);
    }

    process.removeAllListeners(signal);
    process.kill(process.pid, signal);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  return () => {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  };
}

async function main() {
  const startedAt = Date.now();
  console.error("part-c-gate: bringing up isolated instance...");
  const instance = await cmdUp();
  if (!instance) {
    console.error("part-c-gate: failed to bring up an isolated instance (see refusal above). Nothing to tear down.");
    process.exitCode = 1;
    return;
  }
  const uninstallSignalHandlers = installSignalHandlers();

  const partial = {};
  let gateError;
  try {
    await runGate(instance, partial);
  } catch (e) {
    gateError = e;
  } finally {
    uninstallSignalHandlers();
    console.error("part-c-gate: tearing down isolated instance...");

    const tornDown = await cmdDown(true);
    if (!tornDown) {
      console.error("part-c-gate: WARNING: teardown itself reported a problem; check for leaked state by hand.");
      process.exitCode = 1;
    }
  }

  const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
  if (gateError) {
    console.error(`part-c-gate: FAILED after ${elapsedSeconds}s: ${gateError.stack ?? gateError.message}`);
    process.exitCode = 1;

  } else {
    console.error(`part-c-gate: mechanics completed in ${elapsedSeconds}s.`);
  }

  const assertions = runAllAssertions(partial);
  for (const a of assertions) {
    console.error(`${a.ok ? "PASS" : "FAIL"}: ${a.name} -- ${a.ok ? a.proof : a.error}`);
  }

  const realFailures = assertions.filter((a) => !a.ok && a.error.startsWith("FAILS:"));
  if (realFailures.length > 0) {
    console.error("");
    console.error(`part-c-gate: ${realFailures.length} assertion(s) report a REAL failure, not just insufficient data:`);
    for (const a of realFailures) {
      console.error(`  FAILS: ${a.name} -- ${a.error}`);
    }
  }

  try {
    const stored = await recordResultInStore(partial, assertions, elapsedSeconds, gateError);
    console.error(
      `part-c-gate: result recorded in the store under kv key "${PART_C_RESULT_KV_KEY}" ` +
        `(project ${stored?.projectId ?? "?"} at ${stored?.projectPath ?? "?"}).`,
    );
  } catch (e) {

    console.error(`part-c-gate: WARNING: failed to record the result in the store: ${e.message}`);
    process.exitCode = 1;
  }

  console.log(JSON.stringify({ result: partial, assertions, gateError: gateError ? (gateError.stack ?? gateError.message) : null }, null, 2));
  if (gateError || assertions.some((a) => !a.ok)) process.exitCode = 1;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) await main();

export { checkDataDirForResultRecording, gitSnapshot, McpClient, runGate, workerAssignment };
