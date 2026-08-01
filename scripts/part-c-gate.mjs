#!/usr/bin/env node
// Issue #31 part C: the pre-merge end-to-end gate that part B's isolated
// instance (scripts/isolated-hive.mjs) makes possible. Brings the instance
// up, spawns ONE real claude worker inside it, has that worker launch
// background subagents that each write their own completion file, sets a
// wake, samples the run while it happens, and tears the instance down --
// including on failure, so a crash here never leaks a private tmux server
// and its workers (that exact shape was PR #48's first CRITICAL).
//
// Lives in scripts/, not test/: `npm test` must never run this. It costs
// real tokens, a network connection, and roughly the four minutes the three
// staggered subagents below take to finish. Run it by hand before merging
// anything that touches worker-state tracking or the scheduler.
//
// DOCUMENTED PRECONDITION (todo 141 triage; opus's own closing note, real and
// deliberately out of scope here -- it is a property of the trust-inheritance
// decision in isolated-hive.mjs, which is recorded and stands): the spawned
// worker's Bash calls (the `sleep && date` completions, step 0's whoami
// write) need an allow rule already in the DEVELOPER'S OWN ~/.claude/
// settings.json, because the worker's project root inherits trust from this
// checkout but not a pre-approved Bash permission of its own. Without one,
// the worker hits a permission prompt on its first Bash call and the run
// hangs until RUN_TIMEOUT_MS. This script does not and will not solve that;
// set the allow rule by hand before running it.
//
// MECHANICS ONLY (todo 130). This file collects the rows and samples the
// assertions (todo 131, scripts/part-c-assert.mjs) read; it does not itself
// decide pass or fail beyond the sanity checks needed to trust its own
// setup (e.g. that the worker's pane never hit a dialog it should not have).
//
// BLAST RADIUS, named because isolated-hive.mjs's own header only tells half
// of it: the worker's project root is sited inside this trusted checkout (see
// that header), so the worker has a live path back to the working tree this
// branch lives in via a plain `cd ..`. The prompt below scopes the worker as
// tightly as an instruction can, but an instruction is not a sandbox --
// gitSnapshot() below is the actual enforcement, taken before the worker
// starts and again before `down` runs, so a dirtied tree is DETECTED rather
// than merely hoped against. See --no-verify-free `git status --porcelain`
// use: this never touches the working tree itself, only reads it.
//
// RECOVERY, if this process is killed hard enough that its own SIGINT/SIGTERM
// handler (installed in main(), below) never runs -- SIGKILL, a crashed
// terminal, a machine sleep that drops the process group: the isolated
// instance is left up. Tear it down by hand with
//   node scripts/isolated-hive.mjs down --force
//
// WHERE THE RESULT LANDS (todo 133, issue #31's own closing question): the
// STORE, not a delivered wake. #27 is not hypothetical -- wave 7's wake 65
// fired and the lead never received it, and what actually surfaced the
// finished lane was a human typing a message. A gate whose result arrives by
// keystroke can report a pass into a void. recordResultInStore() below opens
// a SEPARATE connection to the REAL default store (never the scratch one --
// that's gone the moment `down` returns) and kv_sets a compact summary under
// PART_C_RESULT_KV_KEY, scoped at prep to an existing surface on purpose (kv
// or a pad, never a new table or a MIGRATIONS entry: src/db.ts is code the
// lead's own MCP server executes, so a migration would force a lead restart
// mid-lane, which this wave's goal assumes never happens). Read it back with
// the hive kv_get tool, key "part-c-gate:last-run", from any session in this
// project -- no dependency on the pane the gate ran in.

import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";

import { DIST_DIR, MCP_CONFIG_FILE, REPO_DIR, cmdDown, cmdUp } from "./isolated-hive.mjs";
import { runAllAssertions } from "./part-c-assert.mjs";

const PART_C_RESULT_KV_KEY = "part-c-gate:last-run";

// Three subagents, staggered enough that "last completion" is unambiguous
// even at one-second timestamp resolution (portable `date +%s`; BSD date on
// macOS has no `%N`). 6s/12s/18s keeps the whole run inside the ~4 minutes
// the plan already budgets once the worker's own startup and reasoning time
// is added on top.
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

// Todo 141 item 9. dist/ is gitignored, so a worker that overwrote
// dist/hook.js would leave gitSnapshot()'s HEAD and `git status --porcelain`
// byte-identical before and after -- the worst possible blind spot for a
// gate whose entire premise is "the branch's dist". A content checksum over
// every file under distDir catches a change there git cannot see at all.
// Paths sorted before hashing so file-system readdir order (not guaranteed)
// can never make two identical trees hash differently.
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

// A minimal MCP stdio client. The JSON-RPC framing below (the newline
// buffering loop, the pending-Map request/response matching, start()'s
// initialize handshake) is close to line-for-line what test/helpers.mjs's
// own McpClient (there, lines ~236-306) already does, and /simplify's own
// review flagged that duplication. Left duplicated rather than factored into
// a shared module on purpose, not by oversight: test/helpers.mjs is shared
// infrastructure for the WHOLE existing suite, used by dozens of files that
// predate this lane, and merging it into a new shared module this late, for
// two call sites, is a bigger and riskier change than the four lines it
// would save. The one place the two classes have already diverged for a real
// reason is close() (see below): if a second protocol bug surfaces there,
// that is the signal to actually extract the shared piece, not this comment.
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

  // Must not return before the child has ACTUALLY exited, not merely been
  // sent a signal: observed by running it, not reasoned about. An early
  // version raced `cmdDown`'s rmSync against this process's own shutdown --
  // issuing SIGKILL and returning immediately, while the OS had not yet
  // reclaimed the process or its open hive.db/-wal/-shm file descriptors --
  // and left a non-empty `data/` directory behind inside the torn-down root
  // (rmSync's recursive walk found the directory empty, then something the
  // dying process was still writing recreated a file in it before the rmdir
  // landed, and force:true swallowed the resulting ENOTEMPTY rather than
  // surfacing it). Waiting on the same `exited` promise after the kill,
  // instead of returning once the signal is merely sent, closes that window.
  async close() {
    this.child.stdin.end();
    // Todo 141 item 7, the SECOND race in this function, opposite direction
    // from the one above's comment: the child may have already exited before
    // close() is even called (a crash mid-request), and Node emits "exit"
    // exactly once, so a `once("exit", ...)` listener attached here after
    // the fact never fires. This left only the unref'd 3-second timeout as a
    // referenced handle -- with nothing else keeping the event loop alive,
    // Node can end THIS process on that still-pending await before main()'s
    // finally (cmdDown) ever runs, leaking the isolated instance. Checking
    // exitCode first, before attaching a listener for an event that may
    // already be gone, closes that window without touching the fix above
    // (still waits for a REAL exit after SIGKILL, never returns the instant
    // the signal is merely sent).
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

// Named once so the assignment prompt and the gate's own post-run read (see
// runGate) can never name two different files for the same fact.
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
    // Todo 141 item 4: --strict-mcp-config (todo 128/129) is wired up but
    // nothing in the run used to DEPEND on it -- spawnReceipt.announced is
    // equally true with the right server, the machine's installed one, or
    // none at all. Claude Code namespaces MCP tools by server key, so under
    // --strict-mcp-config the only hive tools this worker can see are
    // mcp__hive-iso__*; having it name the exact tool it called pins that.
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

// /simplify: pollUntilDone's hot loop (every 2s, up to ~150 ticks) only ever
// needs the timer row, but the original single readRows() below re-ran the
// per-actor log query AND the global-table scan on every tick and threw both
// away -- real, if small, waste on a path that runs far more often than the
// one call site that actually wants the other two. Split so the loop pays
// for one query, and readRows() (used exactly once, after the loop exits)
// keeps everything it needs.
function readTimer(dbPath, timerId) {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    return db.prepare("SELECT fired_at, cancelled_at, due_at, max_wait_at FROM timers WHERE id = ?").get(timerId);
  } finally {
    db.close();
  }
}

// The proof this run's rows are readable at all before retention (todo 132)
// or teardown gets anywhere near them: a fresh scratch store's agents/timers
// tables start empty, so a query keyed on the actor id this spawn just
// allocated is unambiguous without needing to filter by time or project.
// Named readRows, not readState, so it is never confused with
// isolated-hive.mjs's own readState (the up/down instance pointer file) --
// same word, unrelated concept, different file.
// Todo 132's own bound is GLOBAL (every actor, every project sharing this
// store), not per-actor, so "is this run's log readable" depends on the
// WHOLE table's span, not just one actor's rows. Named and called twice
// (todo 141 item 8): once at gate start, once after the run, so
// part-c-assert.mjs can tell "retention's bounds were never close to
// triggering" apart from "a prune actually ran mid-run and this run cannot
// see it in the post-run-only span, because a prune also erases the
// evidence that it happened."
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
    // payload, not just event/state/created_at: it is the raw background_tasks
    // array the whole #24 fix turns on, which src/hook.ts stores unredacted
    // precisely so it can be read afterwards. Dropping it here left nothing
    // able to prove a subagent ever actually existed (todo 141, item 3).
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

// Exit is the WAKE firing (or being cancelled), never merely "all completion
// files exist": completions finishing is necessary but not sufficient, since
// idle detection and the wake's own scheduler tick both take real time after
// the last subagent writes its file. Returning as soon as completions are
// done -- the first shape this function had -- reads its own sample set as
// "the wake never fired" on every run, correct or not, because it stops
// watching before the thing todo 131 asserts on has had a chance to happen.
// `samples` is the caller's own array, mutated in place rather than built up
// locally and handed back only on the happy path: this function's timeout
// throw (RUN_TIMEOUT_MS, below) used to discard every sample it had already
// collected along with it, because the caller's `result` was assigned only
// after runGate's try block finished without throwing -- exactly backwards,
// since a run that times out here is the one whose ~150 samples matter most
// (todo 141 item 6; see runGate's own comment on `partial`).
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

// `partial` is the caller's own object, filled in as the run progresses
// rather than assembled locally and only attached to a returned `result` at
// the very end (todo 141 item 6). The old shape lost everything -- every
// sample, the whole agent_state_log, every git snapshot -- to any throw
// before the final assignment, including pollUntilDone's own five-minute
// timeout: exactly the run whose ~150 samples and full pane history matter
// most, discarded by the one code path built to explain a failure. main()
// reads `partial` regardless of whether this function threw.
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
    // Found by running the gate and watching it pop blank terminal windows
    // open on a real desktop: ensureAttached() in src/tmux.ts auto-attaches
    // a native terminal to a project's tmux session whenever nobody is
    // watching it, exactly the shape agent_spawn below triggers. An isolated
    // instance must not reach out and touch the developer's screen any more
    // than it reaches into their real store or their real tmux server.
    HIVE_AUTO_ATTACH: "0",
  };
  delete env.TMUX;
  delete env.TMUX_PANE;

  const mcp = new McpClient(instance.distDir, env);
  try {
    await mcp.start();

    // Todo 141 item 8: captured HERE, before the worker does anything, not
    // only after the run. A prune both deletes rows and normalises the span
    // that would otherwise reveal it, so a post-run-only read cannot tell
    // "retention's bounds were never close" apart from "a prune already ran
    // and ate the evidence of itself." This scratch store is fresh per `up`
    // (mkdtemp), so its agent_state_log is provably empty at this point;
    // part-c-assert.mjs uses that to prove the post-run MIN(id) is exactly 1,
    // not just plausible.
    const dbPath = join(instance.dataDir, "hive.db");
    partial.dbPath = dbPath;
    partial.agentStateLogPreRunSpan = readGlobalSpan(dbPath);

    const spawnReceipt = await mcp.call("agent_spawn", {
      name: "gate-worker",
      model: "sonnet",
      cwd: instance.workerRoot,
      extra_args: ["--mcp-config", mcpConfigPath, "--strict-mcp-config"],
    });
    // A dialog here means either the trust-inheritance or the
    // --strict-mcp-config mechanism (todo 128/129) regressed -- not
    // something todo 131's assertions should have to discover indirectly.
    if (spawnReceipt.announced !== true) {
      throw new Error(
        `worker's pane never confirmed ready/undialogued (announced=${spawnReceipt.announced}); ` +
          `receipt: ${JSON.stringify(spawnReceipt)}`,
      );
    }
    partial.worker = { agentId: spawnReceipt.agent_id, actorId: spawnReceipt.actor_id, name: spawnReceipt.name };

    // Set BEFORE the assignment is sent, so "fresh idle transition" (the
    // tool's own semantics: an agent already idle at set-time does not
    // count) is measured from before any work started, never from a moment
    // when the worker might already have gone idle on the bare announcement
    // turn with nothing else to do yet.
    const wake = await mcp.call("wake_when_idle", {
      // agentRefParam is a bare number-or-name union, not {agent_id}.
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

    // Todo 141 item 4: the file step 0 of the assignment wrote, read as plain
    // data rather than assumed -- existsSync would only prove the worker did
    // SOMETHING, not which server answered it.
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

// Todo 133: a separate connection to the REAL default store, opened only
// after the scratch instance is torn down -- writing into the scratch store
// would be pointless, it is gone the moment `down` returns. Uses THIS
// BRANCH's own already-built dist (no interpreter-pinning concerns; kv_set's
// behavior is not what this gate is testing) with the AMBIENT environment,
// unmodified: whatever HIVE_DATA_DIR the invoking shell already has (or its
// absence, meaning the real default ~/.hive) is exactly the store a human
// running this by hand, or their own lead session, would read the result
// back from. No HIVE_AUTO_ATTACH=0 here on purpose, unlike the scratch
// connection above: this one never calls agent_spawn (only kv_set), which
// is the only path that can trigger ensureAttached(), so there is nothing
// for it to neutralise -- and forcing it off on the REAL project's env would
// contradict "ambient, unmodified" for no reason.
// result's fields are no longer guaranteed complete (todo 141 item 6: this is
// called on a failing run's partial data too, not just a clean pass), so
// every read here is optional-chained rather than assumed present.
//
// Todo 141 item 10: this can report success into a store that no longer
// exists. Part B's documented usage is
//   eval "$(node scripts/isolated-hive.mjs up)"
// which EXPORTS HIVE_DATA_DIR into the interactive shell; it survives a
// later `down` even though the directory is gone. src/db.ts does
// mkdirSync(dataDir, { recursive: true }) on open, so a stale HIVE_DATA_DIR
// gets silently recreated, migrated, and written to -- kv_set "succeeds",
// this prints "result recorded in the store", and a human reading ~/.hive
// (or their own project's real store) finds nothing, because the write
// landed in a directory nobody will ever read again. #27's shape, arriving
// through the one function written to prevent exactly that. Refuse loudly
// instead of writing into a directory this process would otherwise
// recreate out from under a stale pointer, and echo the resolved store path
// and project id on success so a silent wrong-store write cannot look
// identical to a right one.
// Pure guard, separated from recordResultInStore's real MCP call the same
// way isolated-hive.mjs's own checkXxx guards are separated from their
// actions (checkNotDefaultStore, checkTmuxTmpDirExists, ...): testable
// without spinning up a server.
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

// Todo 141 item 6, signal half. main()'s own finally already tears down on a
// thrown assertion or exception, but Node does not run finally blocks for a
// process killed by a signal -- SIGINT (a human hitting Ctrl-C on a run that
// looks hung; RUN_TIMEOUT_MS is five minutes and a human's patience is
// often less) or SIGTERM terminate immediately, leaving the private tmux
// server (and the live worker inside it, still burning tokens), the scratch
// store, and the hive-iso-project-* directory under .claude/ all leaked --
// PR #48's first CRITICAL, arriving through the one door the finally never
// covered. Installed once an instance actually exists; removed in main()'s
// own finally so a normal exit does not leave a handler around re-invoking
// teardown on this process's own later, unrelated signals.
function installSignalHandlers() {
  const onSignal = async (signal) => {
    console.error(`part-c-gate: caught ${signal}, tearing down the isolated instance before exiting...`);
    try {
      await cmdDown(true);
    } catch (e) {
      console.error(`part-c-gate: teardown during ${signal} handling failed: ${e.message}`);
    }
    // Re-raise rather than process.exit(): restores the default disposition
    // first so this doesn't recurse, then lets the signal itself end the
    // process, which preserves the normal 128+signal exit code a caller
    // (a CI wrapper, a human's shell) expects from a killed process.
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

  // Filled in as runGate progresses, not assembled locally and attached only
  // on success (todo 141 item 6) -- see runGate's own comment. Read below
  // regardless of whether runGate threw, so a failing run's partial evidence
  // (samples, agent_state_log, git snapshots -- whatever was captured before
  // the throw) still reaches the assertions, the JSON dump, and the store,
  // instead of a failing run coming back with nothing.
  const partial = {};
  let gateError;
  try {
    await runGate(instance, partial);
  } catch (e) {
    gateError = e;
  } finally {
    uninstallSignalHandlers();
    console.error("part-c-gate: tearing down isolated instance...");
    // force: this instance exists for exactly this one run, so nothing
    // should still be live in it by the time this finally block runs. A live
    // session surviving to here is itself a failure this reports, not a
    // reason to leave the instance (and its private tmux server) leaked --
    // that leak was PR #48's first CRITICAL, on the exact failure path this
    // finally block exists to close.
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
    // No early return: whatever partial made it into `partial` before the
    // throw is exactly the evidence a failure needs explained, so this falls
    // through to the same assertion run, JSON dump, and store write a clean
    // pass gets, rather than losing it all here.
  } else {
    console.error(`part-c-gate: mechanics completed in ${elapsedSeconds}s.`);
  }

  // Every assertion runs regardless of an earlier one's outcome (see
  // part-c-assert.mjs's own header on why short-circuiting hides a dead
  // assertion behind an earlier failure), so this loop can name EVERY
  // check that failed, not just the first. Each already tolerates missing
  // fields with its own PROVES NOTHING, which is exactly what most of them
  // report against a partial result.
  const assertions = runAllAssertions(partial);
  for (const a of assertions) {
    console.error(`${a.ok ? "PASS" : "FAIL"}: ${a.name} -- ${a.ok ? a.proof : a.error}`);
  }

  // Todo 141 item 10: a real regression is diagnosed by the ONE assertion
  // built to catch it (its message starts "FAILS:"), but a wake that fires
  // early also starves every assertion downstream of it of the data it
  // needed, so those report "PROVES NOTHING" -- setup that never happened,
  // not a violation. Three inconclusive-setup lines and one real diagnosis,
  // printed with identical weight above, reads at 2am like "slow machine,
  // re-run it." Surface the genuine failures separately so the real
  // diagnosis cannot be lost in that noise.
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
    // #27's own lesson: a result that only exists in this pane's scrollback
    // is a result the lead may never see. Loud and exit-code-affecting, not
    // swallowed, even though the assertions above are this run's real
    // verdict -- a gate that passed but never landed its result anywhere
    // durable has not actually finished todo 133's job.
    console.error(`part-c-gate: WARNING: failed to record the result in the store: ${e.message}`);
    process.exitCode = 1;
  }

  console.log(JSON.stringify({ result: partial, assertions, gateError: gateError ? (gateError.stack ?? gateError.message) : null }, null, 2));
  if (gateError || assertions.some((a) => !a.ok)) process.exitCode = 1;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) await main();

export { checkDataDirForResultRecording, gitSnapshot, McpClient, runGate, workerAssignment };
