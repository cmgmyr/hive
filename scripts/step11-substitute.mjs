#!/usr/bin/env node

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

const REPO_DIR = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const BRANCH_DIST = join(REPO_DIR, "dist");
const MAIN_DIST = process.env.HIVE_STEP11_MAIN_DIST;

function refuse(message) {
  console.error(`REFUSES: ${message}`);
  process.exit(1);
}

if (!MAIN_DIST) {
  refuse(
    "HIVE_STEP11_MAIN_DIST is not set. See this file's header for how to build main's dist. " +
      "Never point this at dist/ inside the live checkout at the repo root - that is the running lead's own instance.",
  );
}
for (const dist of [MAIN_DIST, BRANCH_DIST]) {
  for (const f of ["cli.js", "hook.js", "index.js"]) {
    if (!existsSync(join(dist, f))) refuse(`${join(dist, f)} does not exist. Run \`npm run build\` for that dist first.`);
  }
}
if (process.env.TMUX) refuse("TMUX is set. Run this from a plain shell, not from inside a tmux pane.");

const results = [];
function record(label, ok, detail) {
  results.push({ label, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` - ${detail}` : ""}`);
}

function makeScratch(tag) {
  const root = mkdtempSync(join(tmpdir(), `hive-step11-${tag}-`));
  const dataDir = join(root, "data");

  const tmuxTmpDir = mkdtempSync(join(tmpdir(), "hive-step11-tmux-"));
  mkdirSync(dataDir, { recursive: true });
  const projectDir = mkdtempSync(join(root, "project-"));
  return { root, dataDir, tmuxTmpDir, projectDir };
}

function fakeClaudeBin(scratch) {
  if (!scratch.claudeBin) {
    const bin = join(scratch.root, "fake-claude-bin");
    mkdirSync(bin, { recursive: true });
    const path = join(bin, "claude");
    scratch.envMarker = join(scratch.root, "pane-env-marker");
    writeFileSync(
      path,
      `#!/bin/sh\n(echo "HIVE_AGENT_ID=$HIVE_AGENT_ID"; echo "HIVE_LEAD=$HIVE_LEAD") > "${scratch.envMarker}"\nexec sleep 600\n`,
    );
    chmodSync(path, 0o755);
    scratch.claudeBin = bin;
  }
  return scratch.claudeBin;
}

async function waitForPaneEnv(scratch, timeoutMs = 5000, stepMs = 50) {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(scratch.envMarker) || !readFileSync(scratch.envMarker, "utf8").includes("HIVE_LEAD=")) {
    if (Date.now() >= deadline) return {};
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return Object.fromEntries(
    readFileSync(scratch.envMarker, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const eq = line.indexOf("=");
        return [line.slice(0, eq), line.slice(eq + 1)];
      }),
  );
}

function baseEnv(scratch, extra = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("HIVE_")));
  delete env.TMUX;
  delete env.TMUX_PANE;
  env.HIVE_DATA_DIR = scratch.dataDir;
  env.TMUX_TMPDIR = scratch.tmuxTmpDir;
  env.HIVE_AUTO_ATTACH = "0";
  Object.assign(env, extra);
  return env;
}

function runCli(dist, scratch, args, extraEnv = {}) {
  const env = baseEnv(scratch, { PATH: `${fakeClaudeBin(scratch)}:${process.env.PATH}`, ...extraEnv });
  const r = spawnSync("node", [join(dist, "cli.js"), ...args], { cwd: scratch.projectDir, env, encoding: "utf8" });
  return { code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function runHook(dist, scratch, event, payload, actorId) {
  const env = baseEnv(scratch, { HIVE_AGENT_ID: actorId });
  const r = spawnSync("node", [join(dist, "hook.js"), event], {
    cwd: scratch.projectDir,
    env,
    input: payload,
    encoding: "utf8",
  });
  return r.status;
}

function tmuxEnv(scratch) {
  return { ...process.env, TMUX_TMPDIR: scratch.tmuxTmpDir };
}

function killPane(scratch, pane) {
  try {
    execFileSync("tmux", ["kill-pane", "-t", pane], { env: tmuxEnv(scratch), stdio: "ignore" });
  } catch {

  }
}

function teardown(scratch, session) {
  if (!session) return;
  try {
    execFileSync("tmux", ["kill-session", "-t", `=${session}`], { env: tmuxEnv(scratch), stdio: "ignore" });
  } catch {

  }
}

class MiniMcpClient {
  constructor(dist, scratch, extraEnv = {}) {
    this.child = spawn("node", [join(dist, "index.js")], {
      cwd: scratch.projectDir,
      env: baseEnv(scratch, extraEnv),
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
        reject(new Error(`timed out waiting for ${method} (id ${id})`));
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
      clientInfo: { name: "hive-step11-substitute", version: "0" },
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

async function waitForWakeRow(mcp, wakeId, predicate, timeoutMs = 10000, stepMs = 100) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const list = await mcp.call("wake_list");
    const row = list.recently_delivered.find((w) => w.wake_id === wakeId);
    if (row && predicate(row)) return row;
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

function onlySessionName(scratch) {
  try {
    const out = execFileSync("tmux", ["list-sessions", "-F", "#{session_name}"], {
      env: tmuxEnv(scratch),
      encoding: "utf8",
    });
    return out.trim().split("\n")[0] || null;
  } catch {
    return null;
  }
}

function livePaneInSession(scratch, session) {
  try {
    const out = execFileSync("tmux", ["list-panes", "-t", `=${session}`, "-F", "#{pane_id}"], {
      env: tmuxEnv(scratch),
      encoding: "utf8",
    });
    return out.trim().split("\n")[0] || null;
  } catch {
    return null;
  }
}

const WAKE_BODY = "step11-substitute wake-88 pair";

function emptyMeasurements() {
  return { leadRowExists: null, wakeReachedConfirmed: null };
}

async function armMain() {
  console.log("\n=== ARM 1: MAIN's dist (889fb9f, pre-L4) ===");
  const scratch = makeScratch("main");
  let mcp;
  let session = null;
  const m = emptyMeasurements();
  try {
    const lead = runCli(MAIN_DIST, scratch, ["lead"]);
    session = onlySessionName(scratch);
    if (lead.code !== 0) {
      record("arm1: hive lead exits 0", false, `stderr: ${lead.stderr}`);
      return m;
    }
    const db = new Database(join(scratch.dataDir, "hive.db"), { readonly: true });
    try {
      const leadRows = db.prepare("SELECT COUNT(*) AS n FROM agents WHERE kind = 'lead'").get().n;
      const logRows = db.prepare("SELECT COUNT(*) AS n FROM agent_state_log").get().n;
      record("arm1: no kind='lead' agents row", leadRows === 0, `found ${leadRows}`);

      record("arm1: zero agent_state_log rows", logRows === 0, `found ${logRows}`);
      m.leadRowExists = leadRows > 0;
    } finally {
      db.close();
    }

    const pane = session ? livePaneInSession(scratch, session) : null;
    if (!pane) {
      record("arm1: wake-88 pair (a live pane to target)", false, "no pane found in the lead's session");
      m.wakeReachedConfirmed = false;
    } else {

      mcp = new MiniMcpClient(MAIN_DIST, scratch, { TMUX_PANE: pane });
      await mcp.start();
      const wake = await mcp.call("wake_set", { delay_seconds: 1, body: WAKE_BODY });
      const row = await waitForWakeRow(mcp, wake.wake_id, (w) => w.typed_at != null);
      record(
        "arm1: wake-88 pair reads no_confirmation_channel",
        row?.confirmation === "no_confirmation_channel",
        `got ${row?.confirmation ?? "(wake never delivered)"}`,
      );
      m.wakeReachedConfirmed = row?.confirmation === "confirmed";
    }
  } finally {
    if (mcp) await mcp.close();
    teardown(scratch, session);
  }
  return m;
}

async function armsBranch() {
  console.log("\n=== ARMS 2-4: THIS BRANCH's dist ===");
  const scratch = makeScratch("branch");
  let mcp;
  let session = null;
  const m = emptyMeasurements();
  try {
    const first = runCli(BRANCH_DIST, scratch, ["lead"]);
    session = onlySessionName(scratch);
    if (first.code !== 0) {
      record("arm2: first hive lead exits 0", false, `stderr: ${first.stderr}`);
      return m;
    }

    const db = new Database(join(scratch.dataDir, "hive.db"));
    let currentRow;
    try {
      const row1 = db.prepare("SELECT * FROM agents WHERE kind = 'lead' AND status = 'running'").get();
      record("arm2: a kind='lead' running row exists", !!row1);
      record(
        "arm2: its actor_id is real (not empty)",
        !!row1 && row1.actor_id !== "",
        row1 ? `actor_id=${row1.actor_id}` : undefined,
      );
      m.leadRowExists = !!row1;
      if (!row1) return m;
      currentRow = row1;

      db.prepare("UPDATE agents SET created_at = datetime('now', '-1 hour') WHERE id = ?").run(row1.id);
      killPane(scratch, row1.tmux_target);

      const swept = runCli(BRANCH_DIST, scratch, ["status"]);
      record("arm3: hive status (a janitor sweep) exits 0 against a backdated, dead-paned row", swept.code === 0, swept.stderr);

      const afterSweep = db.prepare("SELECT status FROM agents WHERE id = ?").get(row1.id);
      record(
        "arm3: the janitor does not close the row despite satisfying BOTH conditions it sweeps on",
        afterSweep?.status === "running",
        `status=${afterSweep?.status}`,
      );

      const second = runCli(BRANCH_DIST, scratch, ["lead"]);
      record("arm3: second hive lead (recovering the dead pane) exits 0", second.code === 0, second.stderr);

      const row2 = db.prepare("SELECT * FROM agents WHERE kind = 'lead' AND status = 'running'").get();
      record("arm3: the actor id survives the sweep, unchanged", row2?.actor_id === row1.actor_id, `${row1.actor_id} -> ${row2?.actor_id}`);
      record("arm3: the SAME row is reused, not a new one", row2?.id === row1.id, `row ${row1.id} -> row ${row2?.id}`);
      currentRow = row2 ?? currentRow;

      db.prepare("UPDATE agents SET status = 'closed', closed_at = datetime('now') WHERE id = ?").run(currentRow.id);
      killPane(scratch, currentRow.tmux_target);

      rmSync(scratch.envMarker, { force: true });
      const third = runCli(BRANCH_DIST, scratch, ["lead"]);
      record("arm4: hive lead after the row was closed by someone else exits 0", third.code === 0, third.stderr);

      const row3 = db.prepare("SELECT * FROM agents WHERE kind = 'lead' AND status = 'running'").get();
      record("arm4: a NEW row is minted, not the closed one", !!row3 && row3.id !== currentRow.id, `closed row ${currentRow.id} -> new row ${row3?.id}`);
      record(
        "arm4: it inherits the closed row's actor id, not a fresh lead:<id>",
        row3?.actor_id === currentRow.actor_id,
        `${currentRow.actor_id} -> ${row3?.actor_id}`,
      );
      currentRow = row3 ?? currentRow;
    } finally {
      db.close();
    }

    const paneEnv = await waitForPaneEnv(scratch);
    record(
      "arm4: the lead's own pane actually received HIVE_AGENT_ID matching the row (measured from the pane, not the DB)",
      paneEnv.HIVE_AGENT_ID === currentRow.actor_id,
      `pane saw "${paneEnv.HIVE_AGENT_ID ?? "(marker never appeared)"}"; row is "${currentRow.actor_id}"`,
    );
    record(
      "arm4: the lead's own pane actually received HIVE_LEAD=1",
      paneEnv.HIVE_LEAD === "1",
      `pane saw "${paneEnv.HIVE_LEAD ?? "(marker never appeared)"}"`,
    );

    const pane = currentRow.tmux_target;
    mcp = new MiniMcpClient(BRANCH_DIST, scratch, {
      HIVE_AGENT_ID: paneEnv.HIVE_AGENT_ID ?? "",
      HIVE_LEAD: paneEnv.HIVE_LEAD ?? "",
      TMUX_PANE: pane,
    });
    await mcp.start();
    const wake = await mcp.call("wake_set", { delay_seconds: 1, body: WAKE_BODY });
    const beforeConfirm = await waitForWakeRow(mcp, wake.wake_id, (w) => w.typed_at != null);
    record(
      "arm2: wake-88 pair reads unconfirmed BEFORE the hook fires (has a channel, unlike arm1)",
      beforeConfirm?.confirmation === "unconfirmed",
      `got ${beforeConfirm?.confirmation ?? "(wake never delivered)"}`,
    );

    const hookCode = runHook(
      BRANCH_DIST,
      scratch,
      "prompt",
      JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: `[hive wake #${wake.wake_id}] acknowledged` }),
      paneEnv.HIVE_AGENT_ID ?? "",
    );
    record("arm2: the hook run itself exits 0", hookCode === 0);

    const confirmed = await waitForWakeRow(mcp, wake.wake_id, (w) => w.confirmation === "confirmed");
    record(
      "arm2: wake-88 pair flips to confirmed AFTER the hook fires - the lane's central claim, measured end to end",
      !!confirmed,
      confirmed ? `confirmed_at=${confirmed.confirmed_at}` : "never confirmed",
    );
    m.wakeReachedConfirmed = !!confirmed;

    const db2 = new Database(join(scratch.dataDir, "hive.db"), { readonly: true });
    try {
      const logRows = db2.prepare("SELECT COUNT(*) AS n FROM agent_state_log").get().n;
      record("arm2: agent_state_log gets a row once the hook fires (own-arm claim, not compared to arm1)", logRows > 0, `found ${logRows}`);
    } finally {
      db2.close();
    }
  } finally {
    if (mcp) await mcp.close();
    teardown(scratch, session);
  }
  return m;
}

function diffArms(main1, branch2) {
  console.log("\n=== ARM 1 vs ARM 2-4: COMPUTED DISAGREEMENT ===");

  const fields = [
    ["a kind='lead' agents row exists", "leadRowExists"],
    ["the wake-88 pair reaches confirmed", "wakeReachedConfirmed"],
  ];
  for (const [label, key] of fields) {
    const a = main1[key];
    const b = branch2[key];
    const measured = a !== null && b !== null;
    record(
      `disagree: ${label} (main vs branch)`,
      measured && a !== b,
      `main=${a === null ? "unmeasured" : a}, branch=${b === null ? "unmeasured" : b}`,
    );
  }
}

async function main() {

  const settled = await Promise.allSettled([armMain(), armsBranch()]);
  const [mainResult, branchResult] = settled;
  if (mainResult.status === "rejected") record("arm1 completed without throwing", false, String(mainResult.reason?.stack ?? mainResult.reason));
  if (branchResult.status === "rejected") record("arms 2-4 completed without throwing", false, String(branchResult.reason?.stack ?? branchResult.reason));

  diffArms(
    mainResult.status === "fulfilled" ? mainResult.value : emptyMeasurements(),
    branchResult.status === "fulfilled" ? branchResult.value : emptyMeasurements(),
  );

  console.log("\n=== SUMMARY ===");
  const failed = results.filter((r) => !r.ok);
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.label}`);
  if (failed.length > 0) {
    console.error(`\n${failed.length} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll checks passed, including the computed arm-vs-arm disagreement.");
}

await main();
