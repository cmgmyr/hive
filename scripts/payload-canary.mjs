#!/usr/bin/env node
// Issue #46 step 2: the live payload conformance canary (#32's half D).
// A sibling of scripts/part-c-gate.mjs, not a fork of it -- reuses its
// exported McpClient, gitSnapshot, workerAssignment and
// checkDataDirForResultRecording rather than re-deriving them. Brings up an
// isolated instance (scripts/isolated-hive.mjs), spawns ONE real claude
// worker, has it launch real background subagents so at least one Stop
// payload carries a non-empty background_tasks, reads every hook payload
// this run produced out of agent_state_log on the SCRATCH store, diffs each
// against the manifest step 1 (scripts/payload-shape.mjs) derives from the
// committed corpus (test/fixtures/hook-payloads/), reports, and tears down
// on every exit path including failure.
//
// Lives in scripts/, not test/: `npm test` must never run this. It costs
// real tokens, a network connection, and roughly the same few minutes
// part-c-gate.mjs takes. Run it by hand after any change to the corpus, to
// src/hook.ts, or when checking whether Claude Code itself has changed a
// hook payload's shape.
//
// WHAT IS COVERED BY `npm test` AND WHAT IS NOT: test/payload-shape.test.mjs
// pins the decision logic this script calls (deriveManifest, checkPayload)
// with mutated copies of committed fixtures -- fast, deterministic, no
// tokens. This file's OWN wiring -- bringing up a real instance, spawning a
// real worker, reading real agent_state_log rows, the run-level "did a Stop
// ever carry a non-empty background_tasks" check -- is exercised only by
// running it. A change here that breaks the wiring (a wrong column name, a
// mismatched actor id) is invisible to `npm test` and visible only in this
// script's own run, printed below.
//
// DOCUMENTED PRECONDITION (same one part-c-gate.mjs documents, and the same
// underlying cause): the spawned worker's Bash calls need an allow rule
// already in the DEVELOPER'S OWN ~/.claude/settings.json, because the
// worker's project root inherits trust from this checkout but not a
// pre-approved Bash permission of its own. Without one the worker hits a
// permission prompt on its first Bash call and the run hangs until
// RUN_TIMEOUT_MS. This script does not and will not solve that; set the
// allow rule by hand before running it.
//
// BLAST RADIUS: identical to part-c-gate.mjs's own, for the identical
// reason (see isolated-hive.mjs's header) -- the worker's project root sits
// inside this trusted checkout, so it has a live path back to the working
// tree via a plain `cd ..`. gitSnapshot(), reused from part-c-gate.mjs, is
// the actual enforcement: taken before the worker starts and again before
// teardown, so a dirtied tree is DETECTED, not merely hoped against.
//
// RECOVERY, if this process is killed hard enough that its own signal
// handler never runs: the isolated instance is left up. Tear it down with
//   node scripts/isolated-hive.mjs down --force
//
// WHERE THE RESULT LANDS: the STORE, not a delivered wake, for the same #27
// reason part-c-gate.mjs documents. recordResultInStore() below opens a
// SEPARATE connection to the REAL default store and kv_sets a compact
// summary under PAYLOAD_CANARY_RESULT_KV_KEY. Read it back with the hive
// kv_get tool, key "payload-canary:last-run", from any session in this
// project.
//
// SCOPE: SHAPE conformance only. This script asserts nothing about what
// state hive decides to write for any payload it reads -- that surface
// belongs to test/hook-replay.test.mjs, not here. NOT a scheduled job: the
// issue asks for one eventually; this lands hand-run, exactly like
// part-c-gate.mjs, and scheduling is a follow-up for someone to file later.
//
// THREE VERDICTS, THREE EXIT CODES, one `verdict` field in the kv record.
// This split exists because the completion signal this script waits on --
// the worker's IDLE WAKE -- fires when the worker's TURN ends, not when the
// worker has done the assignment. A run whose worker never launched the
// subagents still gets a clean idle wake, an empty background_tasks, and
// (if step 0 of the assignment never ran either) no confirmed MCP server --
// a run that answers nothing about payload shapes, not a passing one.
// Treating that the same as a real drift finding is worse than not running
// this at all: a canary that cries wolf gets ignored, and its next real
// finding gets ignored with it.
//   PASS (exit 0)          The run's preconditions held (server confirmed,
//                          wake fired, subagents demonstrably ran) and no
//                          shape or run-level finding fired.
//   FAIL (exit 1)          Either the working tree was dirtied (checked
//                          unconditionally -- a blast-radius breach matters
//                          whether or not the run was otherwise valid), or
//                          the preconditions held and something real fired:
//                          a shape FAILURE, or subagents demonstrably ran
//                          and background_tasks still never populated (the
//                          actual #24 detector, meaningful only once the
//                          precondition is established).
//   INCONCLUSIVE (exit 2)  A precondition didn't hold: the MCP server was
//                          never confirmed, the idle wake never fired, no
//                          subagent ever demonstrably ran, or the run threw
//                          outright. This run cannot support a judgement
//                          about payload shapes either way -- re-run it,
//                          it is a result about the HARNESS, not the corpus.

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

// Duplicated from part-c-gate.mjs on purpose, not by oversight: it is a
// single filename literal, not logic, and workerAssignment() (imported,
// reused verbatim) already bakes this exact path into the prompt it hands
// the worker. Exporting a whole function from a file this lane does not own
// just to share one string is not worth the coupling.
function mcpVerificationPath(completionsDir) {
  return join(completionsDir, "mcp-server.confirmed");
}

// One connection held for the whole poll, not reopened every tick: up to
// ~150 ticks over RUN_TIMEOUT_MS's 5 minutes, and a readonly connection has
// nothing to invalidate between reads of the same row.
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

// event/state/created_at read alongside payload for the printed report;
// payload is the one src/hook.ts stores UNREDACTED, precisely so a reader
// like this one can read it back. Same open/query/close-in-finally shape as
// part-c-gate.mjs's own readRows; not shared with it because this lane's
// file ownership is "scripts/ (new files only)" (see installSignalHandlers'
// own comment below for the same boundary).
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

// The manifest keys on hook_event_name ("Stop", "Notification",
// "UserPromptSubmit"), read from the payload JSON itself -- NOT the DB row's
// own `event` column, which src/hook.ts fills from the CLI arg it was
// invoked with ("stop", "prompt", "notify") and never renames to match. Row
// event is kept in the report for a human to cross-check, never used as the
// manifest lookup key.
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

  // THE RUN-LEVEL CHECK, and it is the highest-value one this script runs:
  // this canary deliberately launches background subagents, so a run in
  // which NO Stop payload ever carried a non-empty background_tasks means
  // the array that used to populate has emptied -- the #24 shape exactly.
  // The corpus alone cannot express this: it holds fixtures of both an
  // empty and a non-empty Stop, with no notion of "this run's own
  // subagents," so the check has to live here, next to the code that
  // causes the subagents to exist.
  const runLevelOk = stopCount > 0 && anyStopWithBackgroundTasks;

  return { perRow, shapeFailures, shapeInfos, parseFailures, stopCount, anyStopWithBackgroundTasks, runLevelOk };
}

// Exit codes for the three verdicts evaluateRun can return; see the header
// for what each means to a human reading a run's output later.
const EXIT_CODES = { PASS: 0, FAIL: 1, INCONCLUSIVE: 2 };

// THE ONE PLACE THE VERDICT IS DECIDED. Every value runCanary collects onto
// `partial` gets consumed here or nowhere -- a value gathered and never
// compared against anything is not evidence, it is decoration (the lessons
// pad's own run-5 note). Called exactly once; main() uses its `verdict` for
// the exit code AND recordResultInStore uses the SAME value for the kv
// record, so the durable result and the console result cannot disagree the
// way an independently re-derived overallPass in each place already had.
//
// PRIORITY, and it is deliberate, not incidental:
//   1. canaryError -> INCONCLUSIVE. The harness itself broke; nothing below
//      was necessarily even collected.
//   2. a dirtied working tree -> FAIL, unconditionally, ahead of the
//      precondition check. A blast-radius breach is real and dangerous
//      whether or not the run was otherwise valid to judge shapes from.
//   3. the three preconditions (server confirmed, wake fired, a subagent
//      demonstrably ran) -> INCONCLUSIVE if any fails. Below this point
//      shapeFailures/runLevelOk are NOT consulted: they describe a run
//      whose own premise -- that it exercised what this canary exists to
//      exercise -- did not hold, so they are not a verdict, only context
//      (still printed; see main()).
//   4. otherwise, a valid run: shapeFailures or a false runLevelOk -> FAIL.
//      Neither fired -> PASS.
function evaluateRun(partial, canaryError) {
  if (canaryError) {
    return { verdict: "INCONCLUSIVE", reasons: [`the run itself failed: ${canaryError.message}`] };
  }

  // part-c-assert.mjs's own assertWorkingTreeUnchanged compares BOTH head
  // and status, and for good reason: a worker that COMMITS inside the
  // checkout leaves `git status --porcelain` byte-identical while moving
  // HEAD, so status alone passes on exactly the case blast-radius
  // enforcement exists to catch.
  const failReasons = [];
  const { gitBefore, gitAfter } = partial;
  if (gitBefore && gitAfter) {
    if (gitBefore.head !== gitAfter.head) failReasons.push(`HEAD moved during the run, from ${gitBefore.head} to ${gitAfter.head}`);
    if (gitBefore.status !== gitAfter.status) failReasons.push("the working tree's git status changed during the run");
  }
  if (failReasons.length > 0) return { verdict: "FAIL", reasons: failReasons };

  const inconclusiveReasons = [];
  // part-c-assert.mjs's own assertWakeFiredAfterLastCompletion and its
  // siblings treat a null fired_at as PROVES NOTHING, never a pass; mirrored
  // here because this script, unlike that one, takes no sample history that
  // could otherwise explain a cancellation.
  if (partial.timer?.fired_at == null) {
    inconclusiveReasons.push(`the idle wake never fired (cancelled_at=${partial.timer?.cancelled_at ?? "null"})`);
  }
  // The same check part-c-assert.mjs's assertWorkerUsedItsOwnMcpServer
  // makes: confirms the worker actually called THIS branch's hive-iso
  // server, not the machine's separately-installed one, which would
  // silently verify the wrong build's payload shapes.
  if (!partial.mcpServerConfirmed || !/^mcp__hive-iso__/.test(partial.mcpServerConfirmed)) {
    inconclusiveReasons.push(`worker's confirmed MCP tool name was "${partial.mcpServerConfirmed}", not prefixed mcp__hive-iso__`);
  }
  // The precondition run 2 actually violated: an idle wake firing and an
  // MCP server confirmation prove the worker's SESSION behaved, not that it
  // did the assignment. A worker whose first turn ends without launching
  // any subagent produces exactly this shape -- a clean idle wake, an empty
  // background_tasks -- and reading that as "the array that used to
  // populate has emptied" would be a false positive on the one check this
  // whole issue is about.
  if (!Array.isArray(partial.completionFiles) || partial.completionFiles.length === 0) {
    inconclusiveReasons.push("no subagent ever demonstrably ran (no *.completed file was written)");
  }
  if (inconclusiveReasons.length > 0) return { verdict: "INCONCLUSIVE", reasons: inconclusiveReasons };

  const analysis = partial.analysis;
  if (!analysis) {
    // Unreachable given the checks above (a valid run always produces an
    // analysis), kept as a named failure rather than a silent PASS in case
    // that invariant is ever wrong.
    return { verdict: "FAIL", reasons: ["no analysis was produced despite a run that reached every precondition"] };
  }
  // A fresh array, not a reuse of the git check's failReasons above: this
  // point is only reached when that one was empty (it returned otherwise),
  // but naming a new one keeps that fact from having to be re-derived by a
  // future reader.
  const shapeFailReasons = [];
  if (analysis.shapeFailures.length > 0) {
    shapeFailReasons.push(`${analysis.shapeFailures.length} shape FAILURE(s) (see findings above)`);
  }
  if (!analysis.runLevelOk) {
    // Only meaningful here, past the subagent precondition above: THE #24
    // DETECTOR. Subagents demonstrably ran (completionFiles proved it) and
    // no Stop payload ever showed them in background_tasks -- the array
    // that used to populate has emptied.
    shapeFailReasons.push(`run-level check: subagents ran but no Stop payload ever carried a non-empty background_tasks (the #24 shape); stopCount=${analysis.stopCount}`);
  }
  // parseFailures is deliberately NOT a reason here: a truncated payload
  // (src/hook.ts's PAYLOAD_LIMIT, e.g. a huge pasted prompt) is a storage
  // limit, not shape drift, and if EVERY Stop payload were unparseable
  // stopCount would stay 0 and runLevelOk would already fail above -- the
  // one case that would matter is already covered.

  return { verdict: shapeFailReasons.length === 0 ? "PASS" : "FAIL", reasons: shapeFailReasons };
}

// Duplicated from part-c-gate.mjs's own installSignalHandlers, on purpose:
// this lane's file ownership is "scripts/ (new files only)" (see the
// plan-issue-46 pad), so adding a fifth export to a file this lane does not
// own is out of scope here, the same reasoning mcpVerificationPath's own
// comment above already gives for its one-line duplication. This one is
// longer -- real control flow, not a literal -- but the alternative is
// broadening this lane's ownership to fix a cosmetic duplication, which
// costs more than the 15 lines it would save.
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
    // `ready` (renamed from `announced` by todo 387 fix round 1: agent_spawn
    // no longer types anything, but still waits for the pane and still
    // reports whether a dialog blocked it) is the same readiness/no-dialog
    // signal this check always depended on.
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

    // The positive signal that subagents demonstrably RAN, independent of
    // background_tasks: each subagent's own Bash command (see
    // workerAssignment(), reused from part-c-gate.mjs) writes "<n>.completed"
    // to this directory as its LAST action, so a file existing here proves a
    // subagent actually executed, not merely that the worker claimed to
    // launch one. Using background_tasks itself for this would be circular
    // -- it is the exact signal the run-level check below is trying to
    // judge.
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

// verdict/reasons come from evaluateRun(), called exactly once in main() --
// never re-derived here. The kv record is the DURABLE half of this script's
// result (#27: a result that only arrives by keystroke can report a pass
// into a void), so it must read the identical verdict the console and the
// exit code used, not a second expression that happens to agree today.
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

// (b) from the lead's review: the isolated instance is gone by the time a
// human reads this run's output, so anything not printed here is gone with
// it. The raw Stop payload text (unparsed -- exactly what src/hook.ts
// stored) and last_assistant_message are the two fields that would answer
// "did the worker actually do the assignment" in seconds instead of a
// re-run; everything else in a Stop payload is already covered by the
// shape findings printed above this.
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
  // Set on a teardown problem below, consumed only after the verdict's own
  // exit code is assigned (near the end of this function) -- setting
  // process.exitCode here would otherwise get silently overwritten the
  // moment the verdict computation runs, which would let a PASS verdict
  // mask a real leaked-state warning.
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

  // THE ONE VERDICT. See evaluateRun's own header: every value partial
  // carries either feeds a reason here or was deleted for carrying none.
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
    // A failed store write must never downgrade a real FAIL/INCONCLUSIVE to
    // PASS's exit code, but it also must not be silently absorbed into
    // whatever verdict-derived code was already set -- so it forces the
    // worst code rather than picking one.
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
