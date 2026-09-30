import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import {
  DIST,
  REPO,
  clearHiveEnv,
  isolateTmux,
  McpClient,
  paneField,
  raceProcesses,
  resolvedTmuxSocket,
  runNode,
  scratchDirs,
  until,
} from "./helpers.mjs";

const SESSION = "lead-watch";
const { hasTmux, cleanup } = isolateTmux("the queen's lead watch tests");
after(() => cleanup(SESSION));

clearHiveEnv();
const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { db, migrate } = await import("../dist/db.js");
migrate();

const HOOK = join(DIST, "hook.js");
const fixture = (name) => readFileSync(join(REPO, "test", "fixtures", "hook-payloads", name), "utf8");
const PROMPT = fixture("lead-claude-prompt.json");
const STOP = fixture("lead-claude-stop.json");
const PROMPT_AFTER_CLEAR = fixture("lead-claude-prompt-after-clear.json");

function project(name, path) {
  mkdirSync(path, { recursive: true });
  const real = realpathSync(path);
  return { id: db.prepare("INSERT INTO projects (name, path) VALUES (?, ?) RETURNING id").get(name, real).id, path: real };
}

function leadRow(projectId, pane) {
  const id = db
    .prepare(
      `INSERT INTO agents (project_id, name, command, cwd, kind, status, tmux_target, tmux_socket, pane_pid)
       VALUES (?, 'lead', 'claude', '/', 'lead', 'running', ?, ?, ?) RETURNING id`,
    )
    .get(projectId, pane, resolvedTmuxSocket(), paneField(pane, "#{pane_pid}")).id;
  const actorId = `lead:${id}`;
  db.prepare("UPDATE agents SET actor_id = ? WHERE id = ?").run(actorId, id);
  db.prepare("INSERT OR IGNORE INTO actors (id, name, kind) VALUES (?, 'lead', 'lead')").run(actorId);
  return { id, actorId };
}

const newPane = (command) =>
  execFileSync("tmux", ["new-window", "-d", "-t", `=${SESSION}`, "-P", "-F", "#{pane_id}", command], {
    encoding: "utf8",
  }).trim();

const screen = (pane) => execFileSync("tmux", ["capture-pane", "-p", "-J", "-S", "-200", "-t", pane], { encoding: "utf8" });
const markers = (pane, wakeId) => screen(pane).split(`[hive wake #${wakeId}`).length - 1;

async function leadHook(actorId, event, payload) {
  const { code } = await runNode(HOOK, [event], {
    dataDir: dirs.dataDir,
    env: { HIVE_AGENT_ID: actorId, HIVE_LEAD: "1" },
    stdin: payload,
  });
  assert.equal(code, 0);
}

async function endTurn(actorId, prompt = PROMPT) {
  await leadHook(actorId, "prompt", prompt);
  await leadHook(actorId, "stop", STOP);
}

async function tickOnce() {
  const { tick } = await import("../dist/scheduler.js");
  const { liveTargets } = await import("../dist/tmux.js");
  await tick(liveTargets());
}

const wakeRow = (id) => db.prepare("SELECT * FROM wakes WHERE id = ?").get(id);
const subRow = (id) => db.prepare("SELECT * FROM lead_idle_subscriptions WHERE wake_id = ?").get(id);

async function refusal(mcp, args) {
  const msg = await mcp.request("tools/call", { name: "wake_when_idle", arguments: args });
  assert.equal(msg.error, undefined, JSON.stringify(msg.error));
  assert.equal(msg.result.isError, true, `must refuse, got ${JSON.stringify(msg.result)}`);
  return msg.result.content[0].text;
}

const SKIP = { skip: hasTmux ? false : "tmux is not installed" };
const CLEAR = fixture("lead-claude-session-end-clear.json");
const STOP_AFTER_CLEAR = fixture("lead-claude-stop-after-clear.json");
const PROMPT_THIRD_SESSION = JSON.stringify({ ...JSON.parse(PROMPT_AFTER_CLEAR), session_id: "aaaaaaaa-0000-4000-8000-000000000023" });
const REAL_INPUT = `cat '${join(REPO, "test", "fixtures", "panes", "real-input.txt")}'; sleep 600`;

describe("the queen waits on another project's lead ending a turn", () => {
  let queen;
  let beta;
  let queenLead;
  let betaLead;
  let queenPane;
  let betaPane;
  let queenMcp;

  before(async () => {
    if (!hasTmux) return;
    queen = project("queen", join(dirs.dataDir, "queen"));
    beta = project("beta", join(dirs.tmp, "beta"));
    queenPane = execFileSync(
      "tmux",
      ["new-session", "-d", "-s", SESSION, "-x", "200", "-y", "50", "-P", "-F", "#{pane_id}", "bash --norc --noprofile"],
      { encoding: "utf8" },
    ).trim();
    queenLead = leadRow(queen.id, queenPane);
    queenMcp = new McpClient({
      cwd: queen.path,
      dataDir: dirs.dataDir,
      env: { HIVE_AGENT_ID: queenLead.actorId, HIVE_LEAD: "1", TMUX_PANE: queenPane },
    });
    await queenMcp.start();
  });

  after(async () => {
    await queenMcp?.close();
  });

  beforeEach(() => {
    if (!hasTmux) return;
    db.prepare("DELETE FROM wakes").run();
    db.prepare("DELETE FROM lead_turn_state").run();
    db.prepare("DELETE FROM agents WHERE project_id = ?").run(beta.id);
    execFileSync("tmux", ["send-keys", "-t", queenPane, "clear", "Enter"]);
    execFileSync("tmux", ["clear-history", "-t", queenPane]);
    betaPane = newPane("sleep 600");
    betaLead = leadRow(beta.id, betaPane);
  });

  it("stores the watch in the queen's own project and fires once, into the queen only, on the lead's NEXT turn ending", SKIP, async () => {
    await endTurn(betaLead.actorId);

    const armed = await queenMcp.call("wake_when_idle", { lead_project_id: beta.id, body: "beta lead is free" });

    assert.equal(wakeRow(armed.wake_id).project_id, queen.id, "the wake belongs to the queen's home, never beta");
    assert.equal(wakeRow(armed.wake_id).deliver_actor, queenLead.actorId);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM wakes WHERE project_id = ?").get(beta.id).n, 0);
    assert.equal(armed.lead_watch.baseline_idle_seq, 1);

    await tickOnce();
    assert.equal(wakeRow(armed.wake_id).fired_at, null, "a turn that ended before arming does not count");

    await endTurn(betaLead.actorId);
    await tickOnce();

    assert.ok(wakeRow(armed.wake_id).fired_at, "the next turn ending fires the watch");
    await until(() => markers(queenPane, armed.wake_id) === 1);
    assert.match(screen(queenPane), new RegExp(`\\[hive wake #${armed.wake_id}, watched lead's turn ended \\(not necessarily finished; read it before acting\\)\\] beta lead is free`));
    assert.equal(markers(betaPane, armed.wake_id), 0, "nothing is ever typed into the watched lead");
  });

  it("mode=all on a lead whose turn already ended returns already_satisfied and schedules nothing", SKIP, async () => {
    await endTurn(betaLead.actorId);

    const result = await queenMcp.call("wake_when_idle", { lead_project_id: beta.id, mode: "all", body: "x" });

    assert.equal(result.status, "already_satisfied");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM wakes").get().n, 0);
  });

  it("a working lead is pending, and max_wait ends the watch as a timeout, never as a turn ending", SKIP, async () => {
    await leadHook(betaLead.actorId, "prompt", PROMPT);
    const armed = await queenMcp.call("wake_when_idle", { lead_project_id: beta.id, mode: "all", body: "timeout body" });

    await tickOnce();
    assert.equal(wakeRow(armed.wake_id).fired_at, null);

    db.prepare("UPDATE wakes SET max_wait_at = datetime('now', '-1 second') WHERE id = ?").run(armed.wake_id);
    await tickOnce();

    await until(() => markers(queenPane, armed.wake_id) === 1);
    assert.match(screen(queenPane), new RegExp(`\\[hive wake #${armed.wake_id}, max wait reached\\] timeout body`));
  });

  it("a restarted lead (new pane pid on its row) ends the watch as LEAD_TARGET_RESTARTED and never as a turn ending", SKIP, async () => {
    const armed = await queenMcp.call("wake_when_idle", { lead_project_id: beta.id, body: "restart body" });
    db.prepare("UPDATE agents SET pane_pid = '1' WHERE id = ?").run(betaLead.id);
    await endTurn(betaLead.actorId);

    await tickOnce();

    await until(() => markers(queenPane, armed.wake_id) === 1);
    assert.match(screen(queenPane), /lead watch ended: LEAD_TARGET_RESTARTED/);
    assert.doesNotMatch(screen(queenPane), /turn ended/);
    assert.equal(subRow(armed.wake_id).terminal_reason, "LEAD_TARGET_RESTARTED");
  });

  it("a new session in the same pane ends the watch as LEAD_TARGET_RESTARTED", SKIP, async () => {
    await endTurn(betaLead.actorId);
    const armed = await queenMcp.call("wake_when_idle", { lead_project_id: beta.id, body: "session body" });
    assert.ok(subRow(armed.wake_id).session_id, "the watch binds the session it was armed under");

    await leadHook(betaLead.actorId, "prompt", PROMPT_AFTER_CLEAR);
    await tickOnce();

    await until(() => markers(queenPane, armed.wake_id) === 1);
    assert.equal(subRow(armed.wake_id).terminal_reason, "LEAD_TARGET_RESTARTED");
  });

  it("a dead lead pane ends the watch as LEAD_TARGET_GONE", SKIP, async () => {
    const armed = await queenMcp.call("wake_when_idle", { lead_project_id: beta.id, body: "gone body" });
    execFileSync("tmux", ["kill-pane", "-t", betaPane]);

    await tickOnce();

    await until(() => markers(queenPane, armed.wake_id) === 1);
    assert.equal(subRow(armed.wake_id).terminal_reason, "LEAD_TARGET_GONE");
  });

  it("a lead pane id now running a different process ends the watch as LEAD_TARGET_REISSUED", SKIP, async () => {
    const armed = await queenMcp.call("wake_when_idle", { lead_project_id: beta.id, body: "reissued body" });
    execFileSync("tmux", ["respawn-pane", "-k", "-t", betaPane, "sleep 601"]);
    await endTurn(betaLead.actorId);

    await tickOnce();

    await until(() => markers(queenPane, armed.wake_id) === 1);
    assert.equal(subRow(armed.wake_id).terminal_reason, "LEAD_TARGET_REISSUED");
  });

  it("a watched lead on a dialog holds the turn-ended wake instead of firing it", SKIP, async () => {
    execFileSync("tmux", ["kill-pane", "-t", betaPane]);
    const dialog = newPane(`cat '${join(REPO, "test", "fixtures", "panes", "tool-permission-prompt.txt")}'; sleep 600`);
    db.prepare("UPDATE agents SET tmux_target = ?, pane_pid = ? WHERE id = ?").run(dialog, paneField(dialog, "#{pane_pid}"), betaLead.id);
    const armed = await queenMcp.call("wake_when_idle", { lead_project_id: beta.id, body: "dialog body" });
    await endTurn(betaLead.actorId);

    await tickOnce();

    assert.equal(wakeRow(armed.wake_id).fired_at, null, "a human answering that lead's dialog is not a lead the queen should act on");
    const got = await queenMcp.call("wake_get", { wake_id: armed.wake_id });
    assert.equal(got.lead_watch.agent_id, betaLead.id);
  });

  it("two schedulers racing the same turn ending deliver exactly once", SKIP, async () => {
    const armed = await queenMcp.call("wake_when_idle", { lead_project_id: beta.id, body: "race body" });
    await endTurn(betaLead.actorId);

    await raceProcesses(
      `const { tick } = await import(${JSON.stringify(join(DIST, "scheduler.js"))});
       const { liveTargets } = await import(${JSON.stringify(join(DIST, "tmux.js"))});
       await tick(liveTargets());
       console.log("{}");`,
      [[], []],
      { env: { HIVE_DATA_DIR: dirs.dataDir, TMUX_TMPDIR: process.env.TMUX_TMPDIR } },
    );

    await until(() => markers(queenPane, armed.wake_id) >= 1);
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(markers(queenPane, armed.wake_id), 1);
    assert.equal(wakeRow(armed.wake_id).fire_count, 1);
  });

  it("the queen can cancel its own lead watch, and wake_get shows what it watches", SKIP, async () => {
    const armed = await queenMcp.call("wake_when_idle", { lead_project_id: beta.id, body: "cancel body" });
    const got = await queenMcp.call("wake_get", { wake_id: armed.wake_id });
    assert.deepEqual(
      { project_id: got.lead_watch.project_id, agent_id: got.lead_watch.agent_id },
      { project_id: beta.id, agent_id: betaLead.id },
    );

    const cancelled = await queenMcp.call("wake_cancel", { wake_id: armed.wake_id });
    assert.equal(cancelled.cancelled, true);
    await endTurn(betaLead.actorId);
    await tickOnce();
    assert.equal(wakeRow(armed.wake_id).fired_at, null);
  });

  it("refuses project_id, deliver_to, the queen's own project, and a second selector, and writes nothing", SKIP, async () => {
    assert.match(await refusal(queenMcp, { lead_project_id: beta.id, project_id: beta.id, body: "x" }), /QUEEN_CROSS_PROJECT_WRITE_REFUSED/);
    assert.match(
      await refusal(queenMcp, { lead_project_id: beta.id, project_id: beta.id, deliver_to: "lead", body: "x" }),
      /refuses project_id and deliver_to/,
      "a foreign wake that QUEEN_REACH would allow must still not become a lead watch stored in beta",
    );
    assert.match(await refusal(queenMcp, { lead_project_id: beta.id, deliver_to: "lead", body: "x" }), /refuses project_id and deliver_to/);
    assert.match(await refusal(queenMcp, { lead_project_id: queen.id, body: "x" }), /cannot wait on itself/);
    assert.match(await refusal(queenMcp, { lead_project_id: beta.id, scope: "project", body: "x" }), /exactly one of/);
    assert.match(await refusal(queenMcp, { lead_project_id: beta.id, agents: ["lead"], body: "x" }), /exactly one of/);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM wakes").get().n, 0);
  });

  it("refuses every caller that is not the running queen: another project's lead, and a locked queen actor", SKIP, async () => {
    const betaMcp = new McpClient({ cwd: beta.path, dataDir: dirs.dataDir, env: { HIVE_AGENT_ID: betaLead.actorId, HIVE_LEAD: "1" } });
    const lockedMcp = new McpClient({
      cwd: queen.path,
      dataDir: dirs.dataDir,
      env: { HIVE_AGENT_ID: queenLead.actorId, HIVE_LEAD: "1", HIVE_PROJECT_LOCK: "1" },
    });
    await betaMcp.start();
    await lockedMcp.start();
    try {
      assert.match(await refusal(betaMcp, { lead_project_id: queen.id, body: "x" }), /LEAD_WATCH_QUEEN_ONLY/);
      assert.match(await refusal(lockedMcp, { lead_project_id: beta.id, body: "x" }), /LEAD_WATCH_QUEEN_ONLY/);
    } finally {
      await betaMcp.close();
      await lockedMcp.close();
    }
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM wakes").get().n, 0);
  });

  function repoint(pane) {
    db.prepare("UPDATE agents SET tmux_target = ?, pane_pid = ? WHERE id = ?").run(pane, paneField(pane, "#{pane_pid}"), betaLead.id);
  }

  it("a watched lead with unsubmitted text in its input box holds the turn-ended wake", SKIP, async () => {
    execFileSync("tmux", ["kill-pane", "-t", betaPane]);
    repoint(newPane(REAL_INPUT));
    const armed = await queenMcp.call("wake_when_idle", { lead_project_id: beta.id, body: "typed body" });
    await endTurn(betaLead.actorId);

    await tickOnce();

    assert.equal(wakeRow(armed.wake_id).fired_at, null, "a human mid-sentence to that lead is not a lead the queen should act on");
  });

  it("mode=all on an idle lead with unsubmitted text schedules instead of returning already_satisfied", SKIP, async () => {
    execFileSync("tmux", ["kill-pane", "-t", betaPane]);
    repoint(newPane(REAL_INPUT));
    await endTurn(betaLead.actorId);

    const result = await queenMcp.call("wake_when_idle", { lead_project_id: beta.id, mode: "all", body: "typed all" });

    assert.equal(result.status, undefined);
    assert.ok(result.wake_id);
  });

  it("refuses at arming a lead pane id now running another process, as LEAD_TARGET_REISSUED", SKIP, async () => {
    db.prepare("UPDATE agents SET pane_pid = '1' WHERE id = ?").run(betaLead.id);
    assert.match(await refusal(queenMcp, { lead_project_id: beta.id, body: "x" }), /LEAD_TARGET_REISSUED: .*another process/);
  });

  it("refuses at arming a dead lead pane, as LEAD_TARGET_GONE", SKIP, async () => {
    execFileSync("tmux", ["kill-pane", "-t", betaPane]);
    assert.match(await refusal(queenMcp, { lead_project_id: beta.id, body: "x" }), /LEAD_TARGET_GONE: .*pane is gone/);
  });

  it("refuses at arming a lead with no recorded pane pid", SKIP, async () => {
    db.prepare("UPDATE agents SET pane_pid = '' WHERE id = ?").run(betaLead.id);
    assert.match(await refusal(queenMcp, { lead_project_id: beta.id, body: "x" }), /no recorded pane pid/);
  });

  it("refuses at arming a lead whose command hive cannot classify", SKIP, async () => {
    db.prepare("UPDATE agents SET command = 'bash' WHERE id = ?").run(betaLead.id);
    assert.match(await refusal(queenMcp, { lead_project_id: beta.id, body: "x" }), /cannot\s+classify/);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM wakes").get().n, 0);
  });

  it("a watch armed right after /clear binds the next session and fires on its turn, not as RESTARTED", SKIP, async () => {
    await endTurn(betaLead.actorId);
    await leadHook(betaLead.actorId, "session_end", CLEAR);
    const armed = await queenMcp.call("wake_when_idle", { lead_project_id: beta.id, body: "after clear" });
    assert.equal(subRow(armed.wake_id).session_id, "", "an unknown turn binds no session at arming");

    await leadHook(betaLead.actorId, "prompt", PROMPT_AFTER_CLEAR);
    await tickOnce();
    assert.equal(subRow(armed.wake_id).session_id, JSON.parse(PROMPT_AFTER_CLEAR).session_id);
    await leadHook(betaLead.actorId, "stop", STOP_AFTER_CLEAR);
    await tickOnce();

    await until(() => markers(queenPane, armed.wake_id) === 1);
    assert.equal(subRow(armed.wake_id).terminal_reason, null);
    assert.match(screen(queenPane), new RegExp(`\\[hive wake #${armed.wake_id}, watched lead's turn ended`));
  });

  it("a watch armed before any hook binds the first real session, and a later /clear still ends it as RESTARTED", SKIP, async () => {
    const armed = await queenMcp.call("wake_when_idle", { lead_project_id: beta.id, mode: "all", body: "later clear" });
    await leadHook(betaLead.actorId, "prompt", PROMPT_AFTER_CLEAR);
    await tickOnce();
    assert.equal(subRow(armed.wake_id).session_id, JSON.parse(PROMPT_AFTER_CLEAR).session_id);

    await leadHook(betaLead.actorId, "prompt", PROMPT_THIRD_SESSION);
    await tickOnce();

    await until(() => markers(queenPane, armed.wake_id) === 1);
    assert.equal(subRow(armed.wake_id).terminal_reason, "LEAD_TARGET_RESTARTED");
  });
});
