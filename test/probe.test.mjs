import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import {
  McpClient,
  assertScratchStore,
  clearHiveEnv,
  isolateTmux,
  runCli,
  scratchDirs,
  seedTrustedYml,
} from "./helpers.mjs";

// Issue #14: liveTargets could not tell "the probe failed" from "nothing is
// alive", so one failed `tmux list-panes -a` closed every running agent in the
// store. These tests pin both halves of that distinction, because fixing the
// first half is only correct if the second half still behaves as it always
// has.

const { hasTmux, cleanup } = isolateTmux("the tmux probe tests");
const dirs = scratchDirs();
const { dataDir, projectDir } = dirs;

// dataDir is read at import time, so the store must be pointed at scratch
// before dist/db.js loads.
clearHiveEnv();
process.env.HIVE_DATA_DIR = dataDir;
// This file runs DELETE statements between tests. Prove the store is the
// scratch one before opening it, not after.
await assertScratchStore();

const { db, migrate } = await import("../dist/db.js");
const { janitor, tick } = await import("../dist/scheduler.js");
const { liveTargets, sessionName } = await import("../dist/tmux.js");
migrate();

// The two failures that must not be confused. Both are produced for real,
// through execFileSync, rather than stubbed.
//
// NO SERVER: a socket dir that never gets one. tmux exits 1 with "error
// connecting to <socket>", which is a fact (nothing can be alive without a
// server) and must sweep. Since tmux ships `exit-empty on`, this is also what
// every hive session looks like once its last pane closes, so it is the
// common case rather than an edge one.
//
// NO ANSWER: a tmux on PATH that fails for some other reason. That is the
// unknown case, and it must never destroy state. A fake binary is the only
// honest way to produce it: every real tmux failure we can stage locally is
// one tmux has an opinion about.
const realPath = process.env.PATH;
const noServerTmp = mkdtempSync(join(tmpdir(), "hive-noserver-"));
const realTmux = hasTmux
  ? execFileSync("which", ["tmux"], { encoding: "utf8" }).trim()
  : "/usr/bin/false";

// A fake tmux that runs `shShouldFail` (a POSIX-sh snippet testing "$@") and,
// if it does not exit first, passes the call through to the real tmux. One
// scaffold shared by every "fails call X, honestly passes everything else
// through" fixture below, rather than a hand-copied heredoc per fixture.
function fakeTmuxFailing(label, shShouldFail) {
  const dir = mkdtempSync(join(tmpdir(), `hive-${label}-`));
  writeFileSync(join(dir, "tmux"), `#!/bin/sh\n${shShouldFail}\nexec ${realTmux} "$@"\n`, { mode: 0o755 });
  return dir;
}

// Fails `list-panes -a` and passes everything else through to the real tmux.
// Failing every call would work for the guards, but then nothing observable
// can happen during a tick, and a test whose assertions are all negative
// passes just as well on a tick that threw on its first statement. Breaking
// only the batch probe leaves a due wake still deliverable, which is the
// positive control. It is also the more realistic failure: one call fails,
// not the whole binary.
const brokenBinDir = fakeTmuxFailing(
  "brokentmux",
  `if [ "$1" = "list-panes" ]; then
  for a in "$@"; do
    # Deliberately not one of the strings tmuxSaysNothingThere matches.
    if [ "$a" = "-a" ]; then echo "tmux: connection interrupted" >&2; exit 1; fi
    if [ -n "$HIVE_TEST_UNPROBEABLE" ] && [ "$a" = "$HIVE_TEST_UNPROBEABLE" ]; then
      echo "tmux: connection interrupted" >&2; exit 1
    fi
  done
fi`,
);

// Issue #40. Fails only `capture-pane`, passing send-keys and everything else
// through to the real tmux, so a send made through this PATH really lands in
// the pane while the tail read that follows it fails honestly.
const captureFailBinDir = fakeTmuxFailing(
  "capturefail",
  `if [ "$1" = "capture-pane" ]; then
  echo "tmux: capture-pane failed" >&2
  exit 1
fi`,
);
const captureFailPath = `${captureFailBinDir}:${realPath}`;

function withEnv(vars, fn) {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const brokenPath = `${brokenBinDir}:${realPath}`;
const withNoServer = (fn) => withEnv({ TMUX_TMPDIR: noServerTmp }, fn);
// unprobeable: one extra target the fake refuses to answer about, for testing
// the single-target path. Everything else still reaches the real tmux.
const withBrokenTmux = (fn, unprobeable) =>
  withEnv({ PATH: brokenPath, HIVE_TEST_UNPROBEABLE: unprobeable }, fn);

// REACHABLE BUT EMPTY: a server with no sessions at all. It takes
// `exit-empty off` to hold one open, which is the point: with the shipped
// default this state is unreachable, and issue #14's "a reachable empty
// server must still sweep" is really about the no-server case. Staged anyway,
// because a user with exit-empty off in their tmux.conf gets exactly this.
//
// Torn down by restoring exit-empty and destroying one throwaway session,
// which makes the server exit on its own. Never kill-server: it takes down
// whatever server the ambient env points at (CLAUDE.md).
const emptyTmuxTmp = mkdtempSync(join(tmpdir(), "hive-emptysrv-"));
const onEmptyServer = (...args) =>
  execFileSync("tmux", args, { encoding: "utf8", env: { ...process.env, TMUX_TMPDIR: emptyTmuxTmp } });

function startEmptyServer() {
  onEmptyServer("new-session", "-d", "-s", "seed", "sleep 600");
  onEmptyServer("set-option", "-g", "exit-empty", "off");
  onEmptyServer("kill-session", "-t", "=seed");
}

function stopEmptyServer() {
  try {
    onEmptyServer("set-option", "-g", "exit-empty", "on");
    onEmptyServer("new-session", "-d", "-s", "last", "sleep 600");
    onEmptyServer("kill-session", "-t", "=last");
  } catch {
    // Never started, or already gone.
  }
  rmSync(emptyTmuxTmp, { recursive: true, force: true });
}

const withEmptyServer = (fn) => withEnv({ TMUX_TMPDIR: emptyTmuxTmp }, fn);

// One tmux server for the whole file, torn down once. cleanup() removes the
// shared socket dir, so calling it per describe would pull it out from under
// the describes still to run.
const session = `hive-probe-${process.pid}`;
let livePane;

before(() => {
  if (!hasTmux) return;
  execFileSync("tmux", ["new-session", "-d", "-s", session, "sleep 600"], { stdio: "ignore" });
  livePane = execFileSync("tmux", ["list-panes", "-t", `=${session}`, "-F", "#{pane_id}"], {
    encoding: "utf8",
  })
    .trim()
    .split("\n")[0];
});

after(() => {
  cleanup(session);
  stopEmptyServer();
  rmSync(noServerTmp, { recursive: true, force: true });
  rmSync(brokenBinDir, { recursive: true, force: true });
  rmSync(captureFailBinDir, { recursive: true, force: true });
});

const EMPTY = { panes: new Set(), windows: new Set() };

// Registered at the real scratch project dir so an MCP server started with
// that cwd resolves to this same project.
const project = db
  .prepare("INSERT INTO projects (name, path) VALUES (?, ?) RETURNING id")
  .get("probe-test", projectDir).id;

// Default age clears the janitor's 15-second spawn-race guard, which is a
// separate protection and must keep working. Pass "0 seconds" for a row that
// is still inside it.
function agentRow(name, target, age = "-60 seconds") {
  return db
    .prepare(
      `INSERT INTO agents (project_id, actor_id, name, tmux_target, command, cwd, status,
         agent_state, created_at)
       VALUES (?, ?, ?, ?, 'claude', '/tmp', 'running', 'working', datetime('now', ?))
       RETURNING id`,
    )
    .get(project, `agent:${name}`, name, target, age).id;
}

// due defaults to an hour out, so a timer only fires when a test asks it to.
function timerRow({ pane, kind = "delay", watch = [], due = "+1 hour" }) {
  return db
    .prepare(
      `INSERT INTO timers (project_id, owner, body, kind, watch, deliver_actor, deliver_pane,
         due_at, created_at)
       VALUES (?, 'user:test', 'wake body', ?, ?, 'user:test', ?,
         datetime('now', ?), datetime('now', '-60 seconds'))
       RETURNING id`,
    )
    .get(project, kind, JSON.stringify(watch), pane, due).id;
}

// One tool call against a fresh MCP server. Real server, real tmux binary,
// real failure when asked for one: nothing inside hive is stubbed.
async function callTool(tool, args = {}, env = {}) {
  const mcp = new McpClient({ cwd: projectDir, dataDir, env });
  await mcp.start();
  try {
    return await mcp.call(tool, args);
  } finally {
    await mcp.close();
  }
}

const listAgents = (env) => callTool("agent_list", {}, env);

// unprobeable: the one target this server's tmux refuses to answer about.
const callWithBrokenTmux = (tool, args, unprobeable) =>
  callTool(tool, args, {
    PATH: brokenPath,
    // Wake tools need somewhere to deliver: a real pane on the shared
    // session, the way a lead running inside tmux has one.
    TMUX_PANE: livePane,
    ...(unprobeable ? { HIVE_TEST_UNPROBEABLE: unprobeable } : {}),
  });

const agentStatus = (id) => db.prepare("SELECT status FROM agents WHERE id = ?").get(id).status;
const timerOf = (id) => db.prepare("SELECT * FROM timers WHERE id = ?").get(id);

// janitor and tick sweep the whole store, so rows left by an earlier test
// would land in the next one's counts.
function reset() {
  db.exec("DELETE FROM timers; DELETE FROM agents;");
}

describe("liveTargets tells a failed probe from an empty one", { skip: hasTmux ? false : "tmux is not installed" }, () => {
  // Paired with stopEmptyServer in the file's after hook.
  before(startEmptyServer);

  it("returns an empty snapshot when there is no server to ask", () => {
    const snapshot = withNoServer(() => liveTargets());

    assert.notEqual(snapshot, null, "no server is a fact, not an unanswered probe");
    assert.equal(snapshot.panes.size, 0);
    assert.equal(snapshot.windows.size, 0);
  });

  it("returns an empty snapshot from a reachable server with no sessions", () => {
    const snapshot = withEmptyServer(() => liveTargets());

    assert.notEqual(snapshot, null, "a server that answered 'nothing here' is not a failed probe");
    assert.equal(snapshot.panes.size, 0);
  });

  it("returns null when tmux answers with anything else", () => {
    assert.equal(withBrokenTmux(() => liveTargets()), null);
  });

  it("returns a snapshot of real targets when tmux answers", () => {
    const [pane, window] = execFileSync(
      "tmux",
      ["list-panes", "-t", `=${session}`, "-F", "#{pane_id} #{session_name}:#{window_id}"],
      { encoding: "utf8" },
    )
      .trim()
      .split(" ");

    const snapshot = liveTargets();
    assert.notEqual(snapshot, null, "a reachable server must not report a failed probe");
    assert.ok(snapshot.panes.has(pane), "the live pane should be in the snapshot");
    assert.ok(snapshot.windows.has(window), "the live window should be in the snapshot");
  });
});

describe("janitor acts on an empty snapshot and refuses to act on a failed probe", () => {
  beforeEach(reset);

  it("sweeps nothing when the probe failed", () => {
    const agent = agentRow("probe-failed", "%9001");
    const timer = timerRow({ pane: "%9001" });

    const result = janitor(null);

    assert.deepEqual(result, { closed_agents: 0, cancelled_timers: 0, probed: false });
    assert.equal(agentStatus(agent), "running", "a failed probe must not close a running agent");
    assert.equal(timerOf(timer).cancelled_at, null, "a failed probe must not cancel a timer");
  });

  it("sweeps through its own probe when the tmux server is gone", () => {
    const agent = agentRow("probe-no-server", "%9010");
    const timer = timerRow({ pane: "%9010" });

    // No argument: the real probe runs, finds no server, and that is a fact.
    // This is the ordinary end of a hive session, not an edge case, because
    // tmux exits with its last pane.
    const result = withNoServer(() => janitor());

    assert.equal(result.closed_agents, 1, "a dead server must still sweep dead rows");
    assert.equal(result.cancelled_timers, 1);
    assert.equal(agentStatus(agent), "closed");
    assert.notEqual(timerOf(timer).cancelled_at, null);
  });

  it("sweeps nothing through its own probe when tmux does not answer", () => {
    const agent = agentRow("probe-broken", "%9011");
    const timer = timerRow({ pane: "%9011" });

    const result = withBrokenTmux(() => janitor());

    assert.deepEqual(result, { closed_agents: 0, cancelled_timers: 0, probed: false });
    assert.equal(agentStatus(agent), "running");
    assert.equal(timerOf(timer).cancelled_at, null);
  });

  it("still sweeps when a reachable server reports nothing alive", () => {
    const agent = agentRow("probe-empty", "%9002");
    const timer = timerRow({ pane: "%9002" });

    const result = janitor(EMPTY);

    assert.equal(result.closed_agents, 1);
    assert.equal(result.cancelled_timers, 1);
    assert.equal(agentStatus(agent), "closed", "an empty snapshot is a fact and still sweeps");
    assert.notEqual(timerOf(timer).cancelled_at, null);
  });

  it("leaves alive targets alone and sweeps only what is missing", () => {
    const alive = agentRow("probe-alive", "%9003");
    const dead = agentRow("probe-dead", "%9004");
    const snapshot = { panes: new Set(["%9003"]), windows: new Set() };

    assert.equal(janitor(snapshot).closed_agents, 1);
    assert.equal(agentStatus(alive), "running");
    assert.equal(agentStatus(dead), "closed");
  });

  it("keeps the 15-second spawn-race guard on an empty snapshot", () => {
    const fresh = agentRow("probe-fresh", "%9005", "0 seconds");

    janitor(EMPTY);

    assert.equal(agentStatus(fresh), "running", "a just-spawned row is protected by age, not liveness");
  });
});

describe("a failed probe fires no idle wake", { skip: hasTmux ? false : "tmux is not installed" }, () => {
  beforeEach(reset);

  // Both cases below start from identical rows: an agent whose target is not
  // alive, watched by an idle_any wake. Only the snapshot differs. Delivery
  // goes to a real pane so the control case reaches the end of the path
  // instead of being cancelled as undeliverable.
  function watchedPair(name) {
    assert.match(livePane, /^%\d+$/, "the delivery pane must be real, or the control case proves nothing");
    const agent = agentRow(name, "%9100");
    const timer = timerRow({ pane: livePane, kind: "idle_any", watch: [agent] });
    return { agent, timer };
  }

  it("leaves the agent running and the wake unfired when the probe fails", async () => {
    const { agent, timer } = watchedPair("wake-probe-failed");
    // Positive control. tick() swallows every exception, so a tick that threw
    // on its first statement would satisfy all the negative assertions below
    // and this test would pass on a completely broken tick. A due delay wake
    // does not consult the snapshot, so it must fire in this same tick: that
    // is the proof the tick ran to the end rather than dying early.
    const due = timerRow({ pane: livePane, due: "-1 second" });

    await tick(null);

    assert.notEqual(timerOf(due).fired_at, null, "the tick must run to completion, not throw");
    assert.equal(agentStatus(agent), "running", "the watched agent must survive the tick");
    const row = timerOf(timer);
    assert.equal(row.fired_at, null, "a failed probe must not fire an idle wake");
    assert.equal(row.fire_count, 0);
    assert.equal(row.cancelled_at, null, "nor cancel it");
  });

  it("survives a real unanswered probe through the default path", async () => {
    // No injected snapshot: the tick runs its own probe against a tmux whose
    // batch call fails. This is the only shape that pins probe -> consumer
    // end to end. The due wake still delivers, which proves the tick reached
    // its end instead of dying in the catch-all.
    const { agent, timer } = watchedPair("wake-broken-tmux");
    const due = timerRow({ pane: livePane, due: "-1 second" });

    await withBrokenTmux(() => tick());

    assert.notEqual(timerOf(due).fired_at, null, "the tick must run to completion, not throw");
    assert.equal(agentStatus(agent), "running", "an unanswered probe must not close a row");
    assert.equal(timerOf(timer).cancelled_at, null, "nor cancel a wake watching it");
    assert.equal(timerOf(timer).fired_at, null, "nor fire one");
  });

  it("leaves a due wake alone when its delivery pane cannot be probed", async () => {
    // deliver() used to ask about the pane AFTER claiming the timer. A failed
    // probe then cancelled a wake that was already spent, and for a repeating
    // one that destroys the schedule: fired_at is set, so no other scheduler
    // instance ever retries it.
    const due = timerRow({ pane: "%9198", due: "-1 second" });

    await withBrokenTmux(() => tick(), "%9198");

    const row = timerOf(due);
    assert.equal(row.fired_at, null, "an unprobeable pane must not consume the wake");
    assert.equal(row.cancelled_at, null, "and must not cancel it either");
    assert.equal(row.fire_count, 0);
  });

  it("cancels a due wake only when tmux says the pane is really gone", async () => {
    const due = timerRow({ pane: "%9199", due: "-1 second" });

    await tick();

    const row = timerOf(due);
    assert.notEqual(row.cancelled_at, null, "a pane tmux cannot find is still cancelled");
    assert.equal(row.fired_at, null, "and cancelled before it is claimed, not after");
  });

  it("fires when tmux answers and the watched agent really is gone", async () => {
    const { agent, timer } = watchedPair("wake-probe-ok");

    await tick();

    assert.equal(agentStatus(agent), "closed", "a reachable server still sweeps a dead target");
    const row = timerOf(timer);
    assert.notEqual(row.fired_at, null, "the wake fires when the probe actually answered");
    assert.equal(row.fire_count, 1);
  });
});

describe("agent_list reports unknown liveness, not a dead worker", { skip: hasTmux ? false : "tmux is not installed" }, () => {
  beforeEach(reset);

  it("keeps a running worker running when the probe fails", async () => {
    agentRow("list-probe-failed", "%9200");

    const out = await listAgents({ PATH: brokenPath });

    const row = out.agents.find((a) => a.name === "list-probe-failed");
    assert.ok(row, "the worker must still be listed");
    assert.equal(row.status, "running", "a failed probe must not render a worker as exited");
    assert.equal(row.alive, null, "unknown liveness is null, not false");
    assert.equal(row.agent_state, "working", "the state the hooks wrote survives an unanswered probe");
    assert.match(out.note, /could not be probed/, "the response says liveness is unknown");
    // Issue #5, D3: unknown liveness is treated as "not confirmed alive", the
    // same as a dead row, so agent_list still offers the transcript path here
    // -- a failed probe is exactly the moment agent_output stops answering.
    assert.ok(
      "transcript_dir" in row,
      `unknown liveness should still report transcript_dir: ${JSON.stringify(row)}`,
    );
  });

  it("still says exited when a reachable server does not have the pane", async () => {
    // Inside the janitor's 15-second guard, so the server's own scheduler
    // cannot close the row out from under the assertion.
    agentRow("list-probe-ok", "%9201", "0 seconds");

    const out = await listAgents({});

    const row = out.agents.find((a) => a.name === "list-probe-ok");
    assert.equal(row.status, "exited", "an answered probe that lacks the pane is still a dead worker");
    assert.equal(row.alive, false);
    assert.equal(row.agent_state, "gone");
    assert.equal(out.note, undefined, "no note when the probe answered");
    assert.ok("transcript_dir" in row, "a confirmed-dead row should report transcript_dir too");
  });

  it("agent_status says unknown instead of exited", async () => {
    // agent_status takes the single-target path, which round 1 left alone. It
    // is the tool a lead polls before acting on one worker, so it lying is
    // worse than agent_list lying.
    agentRow("status-probe", "%9202");

    const out = await callWithBrokenTmux("agent_status", { name: "status-probe" }, "%9202");

    assert.equal(out.status, "running", "must not report a healthy worker as exited");
    assert.equal(out.alive, null);
    assert.equal(out.agent_state, "working");
    assert.match(out.note, /could not be probed/);
    // D2: agent_status always carries transcript_dir for a claude worker,
    // unknown liveness included -- it is the tool a lead reaches for once a
    // pane may already be unreachable.
    assert.ok("transcript_dir" in out, "agent_status should still carry transcript_dir here");
  });

  it("wake_when_idle mode=all schedules instead of claiming everyone is idle", async () => {
    // The dangerous answer here is already_satisfied with "Act now": the lead
    // reads a completion that never happened and moves on while the worker is
    // mid-task.
    agentRow("wake-all-probe", "%9203");

    const out = await callWithBrokenTmux(
      "wake_when_idle",
      { agents: ["wake-all-probe"], mode: "all", body: "check in" },
      "%9203",
    );

    assert.notEqual(out.status, "already_satisfied", "unknown liveness is not 'already idle'");
    assert.ok(out.wake_id, "the wake must actually be scheduled");
  });
});

describe("hive start refuses to duplicate a process it cannot see", { skip: hasTmux ? false : "tmux is not installed" }, () => {
  // The one round-2 consumer that writes to the world rather than the store.
  // On a failed probe it used to close the live row and launch a second copy,
  // so a hive.yml dev server ran twice: the original untracked and still
  // holding its port, the new one failing to bind.
  const launched = sessionName(project);

  before(async () => {
    await seedTrustedYml({ db, projectId: project, projectDir, processes: { web: "sleep 600" } });
  });

  beforeEach(reset);
  after(() => cleanup(launched));

  const commandRow = (target) =>
    db
      .prepare(
        `INSERT INTO agents (project_id, actor_id, name, tmux_target, command, cwd, status, kind,
           created_at)
         VALUES (?, 'cmd:web', 'web', ?, 'sleep 600', ?, 'running', 'command',
           datetime('now', '-60 seconds'))
         RETURNING id`,
      )
      .get(project, target, projectDir).id;

  const runningNamed = (name) =>
    db
      .prepare("SELECT * FROM agents WHERE project_id = ? AND name = ? AND status = 'running'")
      .all(project, name);

  const start = (env = {}) =>
    runCli(["start", "web"], { cwd: projectDir, dataDir, tmp: dirs.tmp, env });

  it("says already running when tmux says the pane is alive", async () => {
    const existing = commandRow(livePane);

    const { code, stdout } = await start();

    assert.equal(code, 0, stdout);
    assert.match(stdout, /already running/);
    assert.equal(agentStatus(existing), "running", "the live row must survive");
    assert.equal(runningNamed("web").length, 1, "and must not be joined by a second one");
  });

  it("closes the row and launches when tmux says the pane is gone", async () => {
    const existing = commandRow("%9300");

    const { code, stdout } = await start();

    assert.equal(code, 0, stdout);
    assert.match(stdout, /started/);
    assert.equal(agentStatus(existing), "closed", "a dead row is replaced, as before");
    const running = runningNamed("web");
    assert.equal(running.length, 1);
    assert.notEqual(running[0].id, existing, "by a new row, not the old one");
  });

  it("starts nothing and closes nothing when tmux cannot answer", async () => {
    // The regression pin. Unknown liveness must not become "it is dead, start
    // another one".
    const existing = commandRow("%9301");

    const { code, stdout } = await start({
      PATH: brokenPath,
      HIVE_TEST_UNPROBEABLE: "%9301",
    });

    assert.equal(code, 0, stdout);
    assert.match(stdout, /skipped: tmux could not be probed/);
    assert.equal(agentStatus(existing), "running", "the row must not be closed");
    assert.equal(runningNamed("web").length, 1, "and no second copy may be launched");
  });
});

describe("the tools that changed how they refuse", { skip: hasTmux ? false : "tmux is not installed" }, () => {
  // Round 2 made each of these decide for itself what an unanswered probe
  // means. Each decision was a judgement call, so each needs a test saying
  // which way it went.
  beforeEach(reset);

  const rejects = async (tool, args, target) => {
    try {
      await callWithBrokenTmux(tool, args, target);
    } catch (e) {
      return e.message;
    }
    assert.fail(`${tool} should have refused while tmux could not answer`);
  };

  it("agent_close refuses on unknown rather than half-closing the row", async () => {
    // Closing a row whose pane may still be up leaks a running worker nothing
    // tracks, and the kill could not land anyway while tmux is unreachable.
    const agent = agentRow("close-unknown", "%9400");

    const message = await rejects("agent_close", { name: "close-unknown" }, "%9400");

    assert.match(message, /could not be probed/);
    assert.equal(agentStatus(agent), "running", "the row must survive the refusal");
  });

  it("agent_close still closes when tmux says the pane is really gone", async () => {
    const agent = agentRow("close-gone", "%9401");

    const out = await callTool("agent_close", { name: "close-gone" });

    assert.equal(out.closed, true);
    assert.equal(agentStatus(agent), "closed", "a definite answer still closes, as before");
  });

  it("agent_send names the probe instead of telling the caller to destroy the worker", async () => {
    // The wording is the whole point. A model told "close it with agent_close
    // and spawn a new one" does exactly that, to a worker that is probably
    // alive and mid-task.
    agentRow("send-unknown", "%9402");

    const message = await rejects("agent_send", { name: "send-unknown", text: "hello" }, "%9402");

    assert.match(message, /could not be probed/);
    assert.doesNotMatch(message, /agent_close/, "must not tell the caller to close a live worker");
    assert.doesNotMatch(message, /spawn a new one/);
  });

  it("agent_send still says close-and-respawn when the window really is gone", async () => {
    // The other half: that wording is correct when tmux actually answered,
    // and this test is what stops it being softened everywhere.
    agentRow("send-gone", "%9403");

    let message = "";
    try {
      await callTool("agent_send", { name: "send-gone", text: "hello" });
    } catch (e) {
      message = e.message;
    }
    assert.match(message, /no live tmux window/);
    assert.match(message, /agent_close and spawn a new one/);
  });

  it("agent_rename renames the row even when tmux cannot be asked", async () => {
    // Everything unknown costs here is cosmetic: the tmux window title and
    // claude's own /rename. The store half must still happen, or "the cost is
    // only a stale pane label" is not true.
    const agent = agentRow("rename-unknown", "%9404");

    const out = await callWithBrokenTmux(
      "agent_rename",
      { name: "rename-unknown", new_name: "renamed" },
      "%9404",
    );

    assert.equal(out.previous_name, "rename-unknown");
    assert.equal(out.name, "renamed");
    assert.equal(out.retitled, false, "the pane is not retitled while tmux is unreachable");
    const row = db.prepare("SELECT name FROM agents WHERE id = ?").get(agent);
    assert.equal(row.name, "renamed", "the row is renamed either way");
  });
});

describe("agent_send's wait_ms tail read", { skip: hasTmux ? false : "tmux is not installed" }, () => {
  beforeEach(reset);

  it("reports a successful send even when the post-send tail read fails", async () => {
    // capturePane in agent_send's wait_ms branch used to run unwrapped, AFTER
    // the text was already sent, so a pane that died (or a capture that
    // failed for any other reason) during the wait turned a successful send
    // into a reported error. A caller reading "error" here reasonably
    // retries, and a duplicated instruction mid-task is worse than a missing
    // tail (issue #40).
    //
    // Counselors review on PR #47, finding 1 (both seats independently):
    // without the final assertion below, this test passes even with the
    // sendText call deleted from agent_send entirely -- requireLive uses
    // list-panes (passes through captureFailPath), paneChoiceCheck's own
    // capture fails and returns awaitingChoice: null so the text branch falls
    // straight to wait_ms, and the receipt comes out byte-identical with no
    // text ever having been typed. That proves the receipt SHAPE under a
    // capture failure, not that the send landed, which is the one thing
    // issue #40 is actually about: sent: true must mean the keystrokes
    // reached the pane. Read the pane back with the real tmux binary,
    // outside captureFailPath (which only fails capture-pane for the MCP
    // server child, not for this test process's own PATH), so a no-op send
    // cannot pass silently.
    const id = agentRow("wait-ms-tail", livePane);

    const receipt = await callTool(
      "agent_send",
      { agent_id: id, text: "hello", submit: false, wait_ms: 250 },
      { PATH: captureFailPath },
    );

    assert.equal(receipt.sent, true, "the send itself succeeded through send-keys, not capture-pane");
    assert.equal(receipt.tail, undefined, "the tail could not be read, so it must be omitted, not blank");
    assert.match(receipt.note, /tail could not be read/);

    const rendered = execFileSync("tmux", ["capture-pane", "-p", "-t", livePane], { encoding: "utf8" });
    assert.match(rendered, /hello/, "sent: true must mean the keystrokes actually reached the pane");
  });

  it("still returns the tail on the happy path, unaffected by the wrap", async () => {
    const id = agentRow("wait-ms-happy", livePane);

    const receipt = await callTool("agent_send", { agent_id: id, text: "hello", submit: false, wait_ms: 250 });

    assert.equal(receipt.sent, true);
    // A hard-coded empty string would satisfy `typeof tail === "string"`
    // without proving capture happened at all, or that it captured what was
    // actually sent (counselors review on PR #47, finding 1).
    assert.match(receipt.tail, /hello/, "the captured tail must actually show what was just sent");
    assert.equal(receipt.note, undefined);
  });
});
