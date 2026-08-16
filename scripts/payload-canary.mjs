#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";

import { DIST_DIR, MCP_CONFIG_FILE, REPO_DIR, cmdDown, cmdUp } from "./isolated-hive.mjs";
import { McpClient, checkDataDirForResultRecording, gitSnapshot, workerAssignment } from "./part-c-gate.mjs";
import { checkPayload, deriveManifest, loadCorpusFromDir } from "./payload-shape.mjs";

const PAYLOAD_CANARY_RESULT_KV_KEY = "payload-canary:last-run";
const FIXTURES_DIR = join(REPO_DIR, "test", "fixtures", "hook-payloads");
const POLL_INTERVAL_MS = 2000;
const RUN_TIMEOUT_MS = 5 * 60 * 1000;
const WAKE_MAX_WAIT_SECONDS = 280;

function mcpVerificationPath(completionsDir) {
  return join(completionsDir, "mcp-server.confirmed");
}

async function pollUntilIdle(dbPath, timerId) {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const stmt = db.prepare("SELECT fired_at, cancelled_at FROM timers WHERE id = ?");
    const deadline = Date.now() + RUN_TIMEOUT_MS;
    for (;;) {
      const timer = stmt.get(timerId);
      if (timer?.fired_at != null || timer?.cancelled_at != null) return timer;
      if (Date.now() > deadline) {
        throw new Error(`wake never fired within ${RUN_TIMEOUT_MS / 1000}s (timer: ${JSON.stringify(timer)})`);
      }
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
  } finally {
    db.close();
  }
}

function readAgentStateLog(dbPath, actorId) {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    return db
      .prepare("SELECT event, state, payload, created_at FROM agent_state_log WHERE actor_id = ? ORDER BY id")
      .all(actorId);
  } finally {
    db.close();
  }
}

function analyzeRows(manifest, rows) {
  const perRow = [];
  let stopCount = 0;
  let anyStopWithBackgroundTasks = false;

  for (const row of rows) {
    let payload;
    try {
      payload = JSON.parse(row.payload);
    } catch (e) {
      perRow.push({ rowEvent: row.event, createdAt: row.created_at, parseError: e.message, findings: [] });
      continue;
    }
    const hookEvent = payload.hook_event_name;
    const findings = checkPayload(manifest, hookEvent, payload);
    if (hookEvent === "Stop") {
      stopCount++;
      if (Array.isArray(payload.background_tasks) && payload.background_tasks.length > 0) anyStopWithBackgroundTasks = true;
    }
    perRow.push({ rowEvent: row.event, hookEvent, createdAt: row.created_at, findings });
  }

  const allFindings = perRow.flatMap((r) => r.findings);
  const shapeFailures = allFindings.filter((f) => f.severity === "FAILURE");
  const shapeInfos = allFindings.filter((f) => f.severity === "INFO");
  const parseFailures = perRow.filter((r) => r.parseError).length;

  const runLevelOk = stopCount > 0 && anyStopWithBackgroundTasks;

  return { perRow, shapeFailures, shapeInfos, parseFailures, stopCount, anyStopWithBackgroundTasks, runLevelOk };
}

const EXIT_CODES = { PASS: 0, FAIL: 1, INCONCLUSIVE: 2 };

function evaluateRun(partial, canaryError) {
  if (canaryError) {
    return { verdict: "INCONCLUSIVE", reasons: [`the run itself failed: ${canaryError.message}`] };
  }

  const failReasons = [];
  const { gitBefore, gitAfter } = partial;
  if (gitBefore && gitAfter) {
    if (gitBefore.head !== gitAfter.head) failReasons.push(`HEAD moved during the run, from ${gitBefore.head} to ${gitAfter.head}`);
    if (gitBefore.status !== gitAfter.status) failReasons.push("the working tree's git status changed during the run");
  }
  if (failReasons.length > 0) return { verdict: "FAIL", reasons: failReasons };

  const inconclusiveReasons = [];

  if (partial.timer?.fired_at == null) {
    inconclusiveReasons.push(`the idle wake never fired (cancelled_at=${partial.timer?.cancelled_at ?? "null"})`);
  }

  if (!partial.mcpServerConfirmed || !/^mcp__hive-iso__/.test(partial.mcpServerConfirmed)) {
    inconclusiveReasons.push(`worker's confirmed MCP tool name was "${partial.mcpServerConfirmed}", not prefixed mcp__hive-iso__`);
  }

  if (!Array.isArray(partial.completionFiles) || partial.completionFiles.length === 0) {
    inconclusiveReasons.push("no subagent ever demonstrably ran (no *.completed file was written)");
  }
  if (inconclusiveReasons.length > 0) return { verdict: "INCONCLUSIVE", reasons: inconclusiveReasons };

  const analysis = partial.analysis;
  if (!analysis) {

    return { verdict: "FAIL", reasons: ["no analysis was produced despite a run that reached every precondition"] };
  }

  const shapeFailReasons = [];
  if (analysis.shapeFailures.length > 0) {
    shapeFailReasons.push(`${analysis.shapeFailures.length} shape FAILURE(s) (see findings above)`);
  }
  if (!analysis.runLevelOk) {

    shapeFailReasons.push(`run-level check: subagents ran but no Stop payload ever carried a non-empty background_tasks (the #24 shape); stopCount=${analysis.stopCount}`);
  }

  return { verdict: shapeFailReasons.length === 0 ? "PASS" : "FAIL", reasons: shapeFailReasons };
}

function installSignalHandlers() {
  const onSignal = async (signal) => {
    console.error(`payload-canary: caught ${signal}, tearing down the isolated instance before exiting...`);
    try {
      await cmdDown(true);
    } catch (e) {
      console.error(`payload-canary: teardown during ${signal} handling failed: ${e.message}`);
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

async function runCanary(instance, partial) {
  partial.gitBefore = gitSnapshot(REPO_DIR);

  const mcpConfigPath = join(instance.workerRoot, MCP_CONFIG_FILE);
  const completionsDir = join(instance.workerRoot, "completions");
  mkdirSync(completionsDir, { recursive: true });

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

    const spawnReceipt = await mcp.call("agent_spawn", {
      name: "payload-canary-worker",
      model: "sonnet",
      cwd: instance.workerRoot,
      extra_args: ["--mcp-config", mcpConfigPath, "--strict-mcp-config"],
    });

    if (spawnReceipt.ready !== true) {
      throw new Error(`worker's pane never confirmed ready/undialogued (ready=${spawnReceipt.ready}); receipt: ${JSON.stringify(spawnReceipt)}`);
    }
    partial.worker = { agentId: spawnReceipt.agent_id, actorId: spawnReceipt.actor_id, name: spawnReceipt.name };

    const wake = await mcp.call("wake_when_idle", {
      agents: [spawnReceipt.agent_id],
      deliver_to: spawnReceipt.agent_id,
      body: "[payload-canary] issue #46: idle wake after the worker's subagents finished.",
      max_wait_seconds: WAKE_MAX_WAIT_SECONDS,
    });
    if (typeof wake.wake_id !== "number") {
      throw new Error(`wake_when_idle did not schedule a timer as expected: ${JSON.stringify(wake)}`);
    }

    await mcp.call("agent_send", { agent_id: spawnReceipt.agent_id, text: workerAssignment(completionsDir) });

    partial.timer = await pollUntilIdle(dbPath, wake.wake_id);

    const rows = readAgentStateLog(dbPath, spawnReceipt.actor_id);
    partial.rowCount = rows.length;
    partial.rows = rows;

    const mcpVerificationFilePath = mcpVerificationPath(completionsDir);
    partial.mcpServerConfirmed = existsSync(mcpVerificationFilePath) ? readFileSync(mcpVerificationFilePath, "utf8").trim() : null;

    partial.completionFiles = existsSync(completionsDir)
      ? readdirSync(completionsDir)
          .filter((f) => /^\d+\.completed$/.test(f))
          .sort()
      : [];

    const manifest = deriveManifest(loadCorpusFromDir(FIXTURES_DIR));
    partial.analysis = analyzeRows(manifest, rows);

    await mcp.call("agent_close", { agent_id: spawnReceipt.agent_id }).catch((e) => {
      console.error(`note: agent_close after the run failed (non-fatal, torn down anyway): ${e.message}`);
    });

    partial.gitAfter = gitSnapshot(REPO_DIR);
  } finally {
    await mcp.close();
  }
}

async function recordResultInStore(partial, elapsedSeconds, canaryError, verdict, reasons) {
  const refusal = checkDataDirForResultRecording(process.env.HIVE_DATA_DIR);
  if (refusal) throw new Error(refusal);
  const mcp = new McpClient(DIST_DIR, process.env);
  try {
    await mcp.start();
    const who = await mcp.call("whoami", {});
    const analysis = partial.analysis;
    await mcp.call("kv_set", {
      key: PAYLOAD_CANARY_RESULT_KV_KEY,
      value: {
        ranAt: new Date().toISOString(),
        headAtRun: partial.gitBefore?.head ?? null,
        worker: partial.worker ?? null,
        elapsedSeconds,
        canaryError: canaryError ? (canaryError.stack ?? canaryError.message) : null,
        rowCount: partial.rowCount ?? null,
        completionFileCount: partial.completionFiles?.length ?? null,
        stopCount: analysis?.stopCount ?? null,
        anyStopWithBackgroundTasks: analysis?.anyStopWithBackgroundTasks ?? null,
        runLevelOk: analysis?.runLevelOk ?? null,
        shapeFailureCount: analysis?.shapeFailures?.length ?? null,
        shapeInfoCount: analysis?.shapeInfos?.length ?? null,
        shapeFailures: analysis?.shapeFailures ?? null,
        shapeInfos: analysis?.shapeInfos ?? null,
        verdict,
        reasons,
      },
    });
    return { projectId: who?.project?.id ?? null, projectPath: who?.project?.path ?? null };
  } finally {
    await mcp.close();
  }
}

function printStopPayloadsForDiagnosis(rows) {
  if (!Array.isArray(rows)) return;
  console.error("payload-canary: non-PASS run -- dumping every Stop payload for diagnosis:");
  for (const row of rows) {
    let payload;
    try {
      payload = JSON.parse(row.payload);
    } catch {
      continue;
    }
    if (payload.hook_event_name !== "Stop") continue;
    console.error(`  [${row.created_at}] last_assistant_message: ${JSON.stringify(payload.last_assistant_message ?? null)}`);
    console.error(`  [${row.created_at}] raw payload: ${row.payload}`);
  }
}

async function main() {
  const startedAt = Date.now();
  console.error("payload-canary: bringing up isolated instance...");
  const instance = await cmdUp();
  if (!instance) {
    console.error("payload-canary: failed to bring up an isolated instance (see refusal above). Nothing to tear down.");
    process.exitCode = EXIT_CODES.INCONCLUSIVE;
    return;
  }
  const uninstallSignalHandlers = installSignalHandlers();

  const partial = {};
  let canaryError;

  let teardownFailed = false;
  try {
    await runCanary(instance, partial);
  } catch (e) {
    canaryError = e;
  } finally {
    uninstallSignalHandlers();
    console.error("payload-canary: tearing down isolated instance...");
    const tornDown = await cmdDown(true);
    if (!tornDown) {
      console.error("payload-canary: WARNING: teardown itself reported a problem; check for leaked state by hand.");
      teardownFailed = true;
    }
  }

  const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
  const analysis = partial.analysis;

  if (canaryError) {
    console.error(`payload-canary: FAILED after ${elapsedSeconds}s: ${canaryError.stack ?? canaryError.message}`);
  } else {
    console.error(`payload-canary: mechanics completed in ${elapsedSeconds}s, ${partial.rowCount} agent_state_log row(s) read.`);
    if (partial.mcpServerConfirmed) console.error(`payload-canary: worker confirmed MCP server "${partial.mcpServerConfirmed}".`);
    console.error(`payload-canary: ${partial.completionFiles?.length ?? 0} subagent completion file(s) written (proof subagents demonstrably ran).`);
    if (analysis) {
      console.error(`payload-canary: ${analysis.stopCount} Stop payload(s), background_tasks ever non-empty: ${analysis.anyStopWithBackgroundTasks}.`);
      if (analysis.parseFailures > 0) {
        console.error(`payload-canary: WARNING: ${analysis.parseFailures} row(s) had a payload that failed to JSON.parse (likely truncated; see src/hook.ts PAYLOAD_LIMIT).`);
      }
      for (const row of analysis.perRow) {
        for (const f of row.findings) {
          console.error(`${f.severity}: [${row.hookEvent}] ${f.message}`);
        }
      }
    }
  }

  const { verdict, reasons } = evaluateRun(partial, canaryError);
  console.error(`payload-canary: VERDICT ${verdict}`);
  for (const reason of reasons) console.error(`  ${verdict}: ${reason}`);
  if (verdict !== "PASS") printStopPayloadsForDiagnosis(partial.rows);
  process.exitCode = EXIT_CODES[verdict];
  if (teardownFailed) process.exitCode = Math.max(process.exitCode, EXIT_CODES.FAIL);

  try {
    const stored = await recordResultInStore(partial, elapsedSeconds, canaryError, verdict, reasons);
    console.error(`payload-canary: result recorded in the store under kv key "${PAYLOAD_CANARY_RESULT_KV_KEY}" (project ${stored?.projectId ?? "?"} at ${stored?.projectPath ?? "?"}).`);
  } catch (e) {
    console.error(`payload-canary: WARNING: failed to record the result in the store: ${e.message}`);

    process.exitCode = Math.max(process.exitCode ?? 0, EXIT_CODES.FAIL);
  }

  console.log(
    JSON.stringify(
      { rowCount: partial.rowCount ?? null, verdict, reasons, analysis, canaryError: canaryError ? (canaryError.stack ?? canaryError.message) : null },
      null,
      2,
    ),
  );
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) await main();

export { analyzeRows, evaluateRun, mcpVerificationPath };
