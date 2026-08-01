#!/usr/bin/env node
// Issue #27, L4 fix round, todo 164 (rewritten for R6/todo 168 - see FIXED
// AGAINST R6 below) - the substitute for step 11 of plan-l3-delivery-states.
// A real restarted lead needs the lead's OWN session to restart, which no
// worker running inside a worktree can do (it would mean killing and
// relaunching the very session running this script). This measures the
// lane's central claim end to end instead, against two REAL builds of the
// CLI and the hook, not fixtures: MAIN's dist (before issue #27's L4 lane)
// against THIS BRANCH's dist, over the identical sequence of real `hive
// lead` invocations, a real hook run, and a real wake.
//
// FIVE THINGS MEASURED:
//   1. MAIN's dist: zero agent_state_log rows for the lead, no kind='lead'
//      agents row at all - the mechanism this lane adds simply is not there.
//   2. THIS BRANCH's dist: both exist.
//   3. A janitor sweep (`hive status`) survives a lead row that is BOTH past
//      the settle window AND paneless - the two conditions the janitor's
//      agent sweep actually requires (src/scheduler.ts). A second `hive
//      lead` afterward reuses the SAME row and actor id.
//   4. DECISION 2's other half, exercised for the first time: a lead row
//      CLOSED by someone else (what an already-running pre-fix janitor in
//      another session would still do to it) still has its actor id
//      inherited by the next `hive lead`, under a NEW row.
//   5. The wake-88 pair: a real wake to the lead's own pane reads
//      "no_confirmation_channel" on main (hasChannel() in wakes.ts finds no
//      agents row for the actor at all) and flips through "unconfirmed" to
//      "confirmed" on this branch once a genuine `node hook.js prompt`
//      invocation - not a fixture insert - writes the confirming
//      agent_state_log row.
//
// Arms 1 and 2 are run concurrently and their measurements are DIFFED
// afterward (see diffArms below) rather than each merely asserting its own
// side - if they stop disagreeing, that is reported as its own failure, not
// silently absent from the output.
//
// FIXED AGAINST R6 (counselors opus F2, F8; codex F7), all three verified by
// the lead against scheduler.ts before dispatch:
//   - The old arm 3 could not fail: it swept a lead row that was both
//     seconds old and pointed at a live pane, so the settle window and the
//     live-pane check protected it regardless of whether the janitor's own
//     kind='lead' filter was even present. Fixed by manufacturing both
//     conditions on the row first (test/lead-identity.test.mjs's own
//     STEP 1 test does this correctly; this mirrors it), and PROVEN able to
//     fail: run once by hand against a temporarily reverted kind filter and
//     confirmed it goes red (see todo 168's comment on the record).
//   - The closed-row actor_id reuse (decision 2's other half, the half that
//     matters for an already-running pre-fix session) was never exercised
//     at all. Arm 4 below closes a row directly and proves the next `hive
//     lead` inherits its actor id under a fresh row.
//   - The header used to assert "arms 1 and 2 disagreed on every point
//     measured" without computing any such comparison; each arm only ever
//     asserted its own side. diffArms() now does the comparison for real.
//   - Both early-return paths left `session` unset, so teardown() was a
//     no-op and a scratch tmux server leaked a `sleep 600` process on a
//     private socket; fixed by resolving the session right after the first
//     `hive lead` call, before any check that can return early. Running the
//     arms via Promise.allSettled rather than Promise.all so one arm
//     throwing cannot end the process before the other arm's own finally
//     (and therefore its teardown) has run.
//
// FIXED AGAINST R8 (counselors opus F5), the second time this script has
// claimed a measurement it did not make:
//   - Nothing here read HIVE_AGENT_ID or HIVE_LEAD back out of the lead's
//     own pane; MiniMcpClient and the hook run were simply handed the DB
//     row's actor_id directly, so arm 2 would have passed with cmdLead's
//     entire env block (todo 167's own fix) deleted. fakeClaudeBin's script
//     now dumps both vars from its own real environment
//     (waitForPaneEnv/scratch.envMarker), and that measured value - not the
//     row - is what drives the MCP client and the hook run from here on.
//   - The arm1-vs-arm2 "agent_state_log has rows" disagreement was
//     manufactured, not measured: arm1 never invokes the hook at all and
//     arm2 does, by the script's own choice, so the two counts were never
//     evidence the mechanism differs. Dropped from diffArms(); each arm
//     still records its own honest, non-comparative claim about its count.
//
// FIXED AGAINST R9 (counselors codex F5). waitForPaneEnv waited only for
// the marker FILE to exist, not for its CONTENT to land: the shell's own
// `>` redirection truncates the file as part of setting up the subshell's
// stdout, strictly before either echo inside it has run, so this could
// read the file in that gap and report a missing HIVE_LEAD on otherwise-
// correct code. A false RED rather than a false green - still fixed,
// because a verification script that cries wolf gets ignored, and this one
// has already been wrong twice in the other direction. Now polls for the
// second (last) line specifically before reading.
//
// ISOLATION, all three axes, checked before anything else runs:
//   - env -u TMUX (this script never has TMUX set at all, since it is not
//     itself run from inside a hive-managed pane; guarded anyway).
//   - TMUX_TMPDIR is a directory that ALREADY EXISTS (tmux does not create
//     one named but missing, and silently falls back to the shared socket -
//     .claude/rules/tmux-and-panes.md).
//   - HIVE_DATA_DIR is a scratch directory per arm, never ~/.hive.
// Torn down with `kill-session -t`, never kill-server, never `list-panes -a`
// (test/CLAUDE.md).
//
// HOW TO GET MAIN'S DIST: this script refuses without one, named via
// HIVE_STEP11_MAIN_DIST. Build it once, anywhere outside this worktree:
//   git worktree add --detach /tmp/hive-main-worktree main
//   cd /tmp/hive-main-worktree && npm install && npm run build
//   HIVE_STEP11_MAIN_DIST=/tmp/hive-main-worktree/dist node scripts/step11-substitute.mjs
//
// Lives in scripts/, not test/: this is a one-shot measurement tool run by
// hand against an external prebuilt dist, not a fixture `npm test` can run
// unattended (test/CLAUDE.md's isolateTmux() pattern does not apply cleanly
// to orchestrating two separate dist builds' worth of child processes, and
// the point here is a live comparison, not a pinned regression).

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

// ---- scratch env per arm --------------------------------------------------

function makeScratch(tag) {
  const root = mkdtempSync(join(tmpdir(), `hive-step11-${tag}-`));
  const dataDir = join(root, "data");
  // TMUX_TMPDIR must ALREADY EXIST; tmux does not create it.
  const tmuxTmpDir = mkdtempSync(join(tmpdir(), "hive-step11-tmux-"));
  mkdirSync(dataDir, { recursive: true });
  const projectDir = mkdtempSync(join(root, "project-"));
  return { root, dataDir, tmuxTmpDir, projectDir };
}

// One fake claude binary per scratch env, written once and reused by every
// runCli() call against it - armsBranch() calls runCli several times, and
// the binary's content never changes between them.
//
// Issue #27's L4 fix round R8, todo 174 (counselors opus F5). Dumps the
// SPAWNED PANE PROCESS's own actual HIVE_AGENT_ID/HIVE_LEAD, not a value
// read some other way - the same ground-truth technique
// test/lead-data-dir.test.mjs uses for HIVE_DATA_DIR. Before this, nothing
// in the script read either var back out of a real pane: MiniMcpClient was
// simply handed the DB row's actor_id directly, so arm 2 would have passed
// with cmdLead's entire env block (todo 167's own fix) deleted. Overwritten
// on every restart; a caller that cares about a SPECIFIC pane's values must
// remove the file first (scratch.envMarker) and poll for its fresh
// reappearance, not trust a leftover from an earlier pane this scratch env
// already killed.
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

// Waits for the marker fakeClaudeBin's script writes, then parses it into
// {HIVE_AGENT_ID, HIVE_LEAD}. Absent keys read as "" (unset), same as the
// shell's own unset-variable expansion that produced the line.
//
// Issue #27's L4 fix round R9, todo 179 item 3 (codex F5). Waiting only for
// EXISTENCE was racy: the shell's own `>` redirection truncates (creates)
// the file as part of setting up the subshell's stdout, strictly before
// either echo inside it has run, so this could read the file between
// truncation and the SECOND line landing and report a missing HIVE_LEAD on
// otherwise-correct code - a FALSE RED, not a false green, but a
// verification script that cries wolf gets ignored, and this one has
// already been wrong twice in the other direction. Poll for the second
// (last) line specifically, not just for the file to exist.
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

// Strips every HIVE_* var first, not just TMUX/TMUX_PANE: this script itself
// may be running inside a hive-managed pane (it was, while developing it -
// HIVE_AGENT_ID and HIVE_PROJECT_LOCK survived into a spawned `hive lead`
// and made it refuse outright, pointing at a store this scratch run had
// never heard of). Same rule test/helpers.mjs's own baseEnv() applies for
// the identical reason.
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
    // Already gone.
  }
}

function teardown(scratch, session) {
  if (!session) return;
  try {
    execFileSync("tmux", ["kill-session", "-t", `=${session}`], { env: tmuxEnv(scratch), stdio: "ignore" });
  } catch {
    // Never started, or already gone.
  }
}

// ---- minimal MCP client, parameterised by dist (test/helpers.mjs's
// McpClient is hardcoded to this repo's own dist/index.js) -----------------

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

// Polls wake_list until the named wake's row satisfies predicate, returning
// that row directly - not a boolean a caller then has to re-fetch the same
// row to use, which every call site here used to do as a second MCP round
// trip for data the polling loop had already just read.
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

// The real session name, read from tmux itself rather than guessed:
// src/tmux.ts's sessionName() tags it with a hash of the data dir whenever
// the store is not the default (dataDirTag()), which every scratch run here
// always is, so "hive-<projectId>" is wrong for every arm this script runs.
// Exactly one session exists on this scratch server at this point (one
// `hive lead` has run), so the first (only) one is it.
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

// The shape both arms report, diffed for real by diffArms() below rather
// than each side only ever asserting its own half.
function emptyMeasurements() {
  return { leadRowExists: null, wakeReachedConfirmed: null };
}

// ---- ARM 1: MAIN's dist, pre-fix ------------------------------------------

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
      // Own-arm claim, not fed into diffArms: this arm never invokes the
      // hook (see todo 174's comment on arm2's own agent_state_log check
      // below for why that pairing was manufactured, not measured).
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
      // No HIVE_AGENT_ID at all: on main, the lead's own MCP session never
      // sets one (that mechanism does not exist yet), so currentActor()
      // resolves to user:<login>, exactly like Chris's real session that
      // measured wake 88.
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

// ---- ARMS 2-4: THIS BRANCH's dist -----------------------------------------
// Arm 2: the row and its identity exist at all. Arm 3: a janitor sweep
// survives a row that is both past the settle window and paneless. Arm 4:
// identity survives the row being CLOSED by someone else. Then the wake-88
// pair's positive half.

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

    // Kept open for the rest of this arm rather than reopened per read:
    // better-sqlite3 sees each writer's commit through the same handle under
    // WAL, so a second connection buys nothing here.
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

      // ARM 3, R6 fix: the janitor's agent sweep requires BOTH created_at
      // past SETTLE_WINDOW ('-15 seconds', src/scheduler.ts) AND a dead
      // pane. A seconds-old row with a live sleep-600 fake claude - what the
      // pre-R6 version of this arm gave it - is protected twice over
      // regardless of the kind filter under test, which is why that arm
      // could not fail. Manufacture both conditions directly on the row, the
      // same way test/lead-identity.test.mjs's own STEP 1 test does.
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

      // ARM 4, missing entirely before R6: decision 2's OTHER half, and the
      // half that matters for an already-running pre-fix session, which
      // closes a reused row directly rather than merely letting its settle
      // window lapse. Close it and kill its pane, the same shape
      // test/lead-identity.test.mjs's second reuse test uses, then confirm
      // the next `hive lead` mints a NEW row that inherits the OLD actor id.
      db.prepare("UPDATE agents SET status = 'closed', closed_at = datetime('now') WHERE id = ?").run(currentRow.id);
      killPane(scratch, currentRow.tmux_target);

      // Issue #27's L4 fix round R8, todo 174. Removed so the marker below
      // can only be the THIRD pane's own write, never a stale leftover from
      // the first or second `hive lead` call above.
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

    // Issue #27's L4 fix round R8, todo 174. Ground truth for what cmdLead's
    // envFlags (todo 167) actually delivered into THIS pane, read back from
    // the pane's own process rather than assumed from the DB row. Nothing
    // else in this script read either var out of a real pane before this;
    // MiniMcpClient below was simply handed the row's actor_id directly, so
    // arm 2 would have passed with cmdLead's entire env block reverted.
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

    // Wake-88 pair, positive half. HIVE_AGENT_ID/HIVE_LEAD taken from the
    // pane's own measured environment above, not the DB row directly: this
    // is what makes the wake-confirmation chain below actually depend on
    // cmdLead's env delivery, rather than merely on the agents table.
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

    // The genuine mechanism, not a fixture insert: a real `node hook.js
    // prompt` invocation with a real UserPromptSubmit payload carrying this
    // wake's own [hive wake #<id>] marker, exactly what Claude Code sends
    // once the typed wake is submitted as a turn. Actor id from the measured
    // pane env, same reasoning as the MCP client above: a real hook run
    // inherits the pane's own environment, not a value fetched from the DB.
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

    // Issue #27's L4 fix round R8, todo 174 (counselors opus F5, second
    // half). NOT fed into diffArms: arm1 never invokes the hook at all
    // (record() is actor-generic, so main's hook given the same actor id
    // would write a row too), while this arm just ran one by hand above. The
    // two counts were never measuring the same thing - the prior "disagree"
    // entry was the script computing its own manufactured disagreement, not
    // observing a real one. This is an honest, non-comparative claim about
    // this arm alone: the hook it just ran actually wrote the row it claims to.
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

// Computes the comparison the header claims, instead of leaving each arm to
// assert only its own side. A field either arm could not measure (null) is
// reported as its own failure rather than silently treated as "disagreed".
function diffArms(main1, branch2) {
  console.log("\n=== ARM 1 vs ARM 2-4: COMPUTED DISAGREEMENT ===");
  // Issue #27's L4 fix round R8, todo 174 (counselors opus F5). Dropped
  // "agent_state_log has rows for the lead" from this list: arm1 never
  // invokes the hook and arm2 does, by the script's own choice, so a
  // disagreement here was never evidence the MECHANISM differs, only that
  // the two arms were driven differently. Each arm still records its own
  // honest, non-comparative claim about that count (see armMain and
  // armsBranch above) - just not as a computed cross-arm disagreement.
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
  // Independent scratch envs (separate TMUX_TMPDIR, HIVE_DATA_DIR, project
  // dir), so nothing stops running both arms concurrently - each spawns its
  // own tmux server and MCP subprocess and only the shared `results` array is
  // touched by both, always synchronously within one microtask.
  //
  // allSettled, not all: a throw from either arm must not end the process
  // before the OTHER arm's own try/finally (and so its teardown) has run.
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
