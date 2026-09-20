import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { describe, it } from "node:test";

import { assertScratchStore, clearHiveEnv, isolateTmux, scratchDirs, until } from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("the lead-pane-reissued tests");
const { dataDir, projectDir } = scratchDirs();

clearHiveEnv();
process.env.HIVE_DATA_DIR = dataDir;
await assertScratchStore();

const { db, migrate } = await import("../dist/db.js");
const { tick } = await import("../dist/scheduler.js");
const { tmuxSocketPath } = await import("../dist/tmux.js");
migrate();

const ownSocket = tmuxSocketPath(process.env.TMUX, process.env.TMUX_TMPDIR);

function panePidOf(target) {
  return execFileSync("tmux", ["list-panes", "-t", target, "-F", "#{pane_pid}"], { encoding: "utf8" })
    .trim()
    .split("\n")[0];
}

function paneIdOf(target) {
  return execFileSync("tmux", ["list-panes", "-t", target, "-F", "#{pane_id}"], { encoding: "utf8" })
    .trim()
    .split("\n")[0];
}

function capture(target) {
  return execFileSync("tmux", ["capture-pane", "-p", "-t", target], { encoding: "utf8" });
}

function serverGone() {
  try {
    execFileSync("tmux", ["list-sessions"], { stdio: "ignore" });
    return false;
  } catch {
    return true;
  }
}

let projectCount = 0;
function seedProject() {
  return db
    .prepare("INSERT INTO projects (name, path) VALUES ('lead-pane-reissued-test', ?) RETURNING id")
    .get(`${projectDir}-${projectCount++}`).id;
}

function insertLeadRow(projectId, actorId, pane, panePid) {
  return db
    .prepare(
      `INSERT INTO agents (project_id, actor_id, name, kind, tmux_target, tmux_socket, pane_pid, command, cwd, status)
       VALUES (?, ?, 'lead', 'lead', ?, ?, ?, 'claude', '/tmp', 'running')`,
    )
    .run(projectId, actorId, pane, ownSocket, panePid);
}

function insertDueLeadWake(projectId, actorId, pane, body) {
  return db
    .prepare(
      `INSERT INTO wakes (project_id, owner, body, kind, watch, deliver_actor, deliver_pane, due_at, created_at)
       VALUES (?, ?, ?, 'delay', '[]', ?, ?, datetime('now', '-1 seconds'), datetime('now', '-60 seconds'))
       RETURNING id`,
    )
    .get(projectId, actorId, body, actorId, pane).id;
}

function insertWorkerRow(projectId, actorId, pane, panePid) {
  return db
    .prepare(
      `INSERT INTO agents (project_id, actor_id, name, kind, tmux_target, tmux_socket, pane_pid, command, cwd, status, created_at)
       VALUES (?, ?, 'worker', 'agent', ?, ?, ?, 'claude', '/tmp', 'running', datetime('now', '-60 seconds'))
       RETURNING id`,
    )
    .get(projectId, actorId, pane, ownSocket, panePid).id;
}

const timerRow = (id) =>
  db.prepare("SELECT fired_at, typed_at, held_at, held_reason, cancelled_at FROM wakes WHERE id = ?").get(id);

const agentStatus = (id) => db.prepare("SELECT status FROM agents WHERE id = ?").get(id).status;

describe("todo 336: a lead-owned wake must not type into a pane a tmux restart reissued", { skip: hasTmux ? false : "tmux is not installed" }, () => {
  it("DEFECT, reproduced for real: a wake held against a pane a fresh tmux server reissued to a stranger", async () => {
    const project = seedProject();
    const actorId = "lead:336001";

    const gen1Session = `hive-336-gen1-${process.pid}`;
    execFileSync("tmux", ["new-session", "-d", "-s", gen1Session, "sleep", "600"], { stdio: "ignore" });
    const gen1Pane = paneIdOf(`=${gen1Session}`);
    const gen1Pid = panePidOf(gen1Pane);

    insertLeadRow(project, actorId, gen1Pane, gen1Pid);
    const wakeBody = "echo wake-336-should-not-land-here";
    const timerId = insertDueLeadWake(project, actorId, gen1Pane, wakeBody);

    execFileSync("tmux", ["kill-session", "-t", `=${gen1Session}`], { stdio: "ignore" });
    const gone = await until(serverGone, 5000);
    assert.ok(gone, "the tmux server must fully exit before the next session starts a fresh one");

    const gen2Session = `hive-336-gen2-${process.pid}`;
    execFileSync("tmux", ["new-session", "-d", "-s", gen2Session, "sleep", "600"], { stdio: "ignore" });
    const gen2Pane = paneIdOf(`=${gen2Session}`);
    const gen2Pid = panePidOf(gen2Pane);

    try {

      assert.equal(gen2Pane, gen1Pane, "gen2's first pane must reuse gen1's exact id for this fixture to mean anything");
      assert.notEqual(gen2Pid, gen1Pid, "the reissued pane must genuinely be a different process, not the same one");

      await tick();

      const timer = timerRow(timerId);
      assert.equal(timer.fired_at, null, "deliverable() must hold before claimOneShot, not deliver into the stranger");
      assert.equal(timer.typed_at, null, "nothing may have been typed at all");
      assert.ok(timer.held_at, "the hold must be RECORDED, not just silently applied");
      assert.match(
        timer.held_reason,
        /now belongs to a different pane/,
        "held_reason must name the pane-identity mismatch, not read as an ordinary not-due-yet or dead-pane hold",
      );

      const onScreen = capture(gen2Pane);
      assert.ok(
        !onScreen.includes("wake-336-should-not-land-here"),
        `the stranger's pane must show no trace of the wake body, got:\n${onScreen}`,
      );
    } finally {
      cleanup(gen2Session);
    }
  });

  it("CONTROL: a lead-owned wake with a genuinely matching pane_pid still delivers", async () => {
    const project = seedProject();
    const actorId = "lead:336002";
    const session = `hive-336-control-${process.pid}`;
    execFileSync("tmux", ["new-session", "-d", "-s", session, "sleep", "600"], { stdio: "ignore" });
    const pane = paneIdOf(`=${session}`);
    const pid = panePidOf(pane);

    try {
      insertLeadRow(project, actorId, pane, pid);
      const wakeBody = "echo wake-336-should-deliver";
      const timerId = insertDueLeadWake(project, actorId, pane, wakeBody);

      await tick();

      const timer = timerRow(timerId);
      assert.notEqual(timer.fired_at, null, "a genuinely matching pane must not be held");
      assert.notEqual(timer.typed_at, null, "and the delivery attempt must have actually happened");
      assert.equal(timer.held_reason, null, "no hold reason - this is not the mismatch case at all");

      const settled = await until(() => capture(pane).includes("wake-336-should-deliver"), 5000);
      assert.ok(settled, `expected the wake body to land on the pane; last capture:\n${capture(pane)}`);
    } finally {
      cleanup(session);
    }
  });

  it("a pre-migration row (pane_pid = '') is never treated as a mismatch", async () => {
    const project = seedProject();
    const actorId = "lead:336003";
    const session = `hive-336-nullpid-${process.pid}`;
    execFileSync("tmux", ["new-session", "-d", "-s", session, "sleep", "600"], { stdio: "ignore" });
    const pane = paneIdOf(`=${session}`);

    try {

      insertLeadRow(project, actorId, pane, "");
      const wakeBody = "echo wake-336-nullpid-should-deliver";
      const timerId = insertDueLeadWake(project, actorId, pane, wakeBody);

      await tick();

      const timer = timerRow(timerId);
      assert.notEqual(timer.fired_at, null, "an absent recorded pid must proceed exactly as before this migration");
      assert.notEqual(timer.typed_at, null);
      assert.equal(timer.held_reason, null);

      const settled = await until(() => capture(pane).includes("wake-336-nullpid-should-deliver"), 5000);
      assert.ok(settled, `expected the wake body to land on the pane; last capture:\n${capture(pane)}`);
    } finally {
      cleanup(session);
    }
  });
});

describe("issue #149: a worker-owned wake must not type into a pane a tmux restart reissued", { skip: hasTmux ? false : "tmux is not installed" }, () => {
  it("DEFECT, reproduced for real: a worker-owned wake held against a reissued pane, and its agents row reaped in the same tick", async () => {
    const project = seedProject();
    const actorId = "agent:149001";

    const gen1Session = `hive-149-gen1-${process.pid}`;
    execFileSync("tmux", ["new-session", "-d", "-s", gen1Session, "sleep", "600"], { stdio: "ignore" });
    const gen1Pane = paneIdOf(`=${gen1Session}`);
    const gen1Pid = panePidOf(gen1Pane);

    const agentRowId = insertWorkerRow(project, actorId, gen1Pane, gen1Pid);
    const wakeBody = "echo wake-149-should-not-land-here";
    const timerId = insertDueLeadWake(project, actorId, gen1Pane, wakeBody);

    execFileSync("tmux", ["kill-session", "-t", `=${gen1Session}`], { stdio: "ignore" });
    const gone = await until(serverGone, 5000);
    assert.ok(gone, "the tmux server must fully exit before the next session starts a fresh one");

    const gen2Session = `hive-149-gen2-${process.pid}`;
    execFileSync("tmux", ["new-session", "-d", "-s", gen2Session, "sleep", "600"], { stdio: "ignore" });
    const gen2Pane = paneIdOf(`=${gen2Session}`);
    const gen2Pid = panePidOf(gen2Pane);

    try {

      assert.equal(gen2Pane, gen1Pane, "gen2's first pane must reuse gen1's exact id for this fixture to mean anything");
      assert.notEqual(gen2Pid, gen1Pid, "the reissued pane must genuinely be a different process, not the same one");

      await tick();

      const timer = timerRow(timerId);
      assert.equal(timer.fired_at, null, "deliverable() must hold before claimOneShot, not deliver into the stranger");
      assert.equal(timer.typed_at, null, "nothing may have been typed at all - this is the case that used to execute");
      assert.ok(timer.held_at, "the hold must be RECORDED, not just silently applied");
      assert.match(
        timer.held_reason,
        /now belongs to a different pane/,
        "held_reason must name the pane-identity mismatch, not read as an ordinary not-due-yet or dead-pane hold",
      );
      assert.match(
        timer.held_reason,
        /nothing re-points a worker's wake automatically/,
        "a worker-owned hold must not point the reader at `hive lead`, which does not rescue this wake",
      );

      const onScreen = capture(gen2Pane);
      assert.ok(
        !onScreen.includes("wake-149-should-not-land-here"),
        `the stranger's pane must show no trace of the wake body, got:\n${onScreen}`,
      );

      assert.equal(
        agentStatus(agentRowId),
        "closed",
        "a reissued worker row must be reaped by the janitor, not left reporting running",
      );
    } finally {
      cleanup(gen2Session);
    }
  });

  it("a hold for pane-reissue survives the reissued pane later going dead too, instead of being silently cancelled", async () => {
    const project = seedProject();
    const actorId = "agent:149003";

    const gen1Session = `hive-149c-gen1-${process.pid}`;
    execFileSync("tmux", ["new-session", "-d", "-s", gen1Session, "sleep", "600"], { stdio: "ignore" });
    const gen1Pane = paneIdOf(`=${gen1Session}`);
    const gen1Pid = panePidOf(gen1Pane);

    insertWorkerRow(project, actorId, gen1Pane, gen1Pid);
    const timerId = insertDueLeadWake(project, actorId, gen1Pane, "echo wake-149c-should-not-execute");

    execFileSync("tmux", ["kill-session", "-t", `=${gen1Session}`], { stdio: "ignore" });
    assert.ok(await until(serverGone, 5000), "the tmux server must fully exit before the next one starts");

    const gen2Session = `hive-149c-gen2-${process.pid}`;
    const gen2AnchorSession = `hive-149c-gen2-anchor-${process.pid}`;
    execFileSync("tmux", ["new-session", "-d", "-s", gen2Session, "sleep", "600"], { stdio: "ignore" });
    execFileSync("tmux", ["new-session", "-d", "-s", gen2AnchorSession, "sleep", "600"], { stdio: "ignore" });
    const gen2Pane = paneIdOf(`=${gen2Session}`);

    try {
      assert.equal(gen2Pane, gen1Pane, "gen2's first pane must reuse gen1's exact id for this fixture to mean anything");

      await tick();
      const heldForReissue = timerRow(timerId);
      assert.ok(heldForReissue.held_at, "sanity check: the reissue hold from the earlier test's own shape must apply here too");
      assert.match(heldForReissue.held_reason, /now belongs to a different pane/);

      execFileSync("tmux", ["kill-session", "-t", `=${gen2Session}`], { stdio: "ignore" });
      const paneGone = await until(() => {
        try {
          execFileSync("tmux", ["list-panes", "-t", gen2Pane], { stdio: "ignore" });
          return false;
        } catch {
          return true;
        }
      }, 5000);
      assert.ok(paneGone, "gen2Pane itself must read as gone before the next tick, or this test proves nothing");

      await tick();
      const afterPaneDied = timerRow(timerId);
      assert.equal(
        afterPaneDied.cancelled_at,
        null,
        "a wake already held for pane-reissue must not be silently cancelled once that pane also dies - " +
          "it must keep holding, visibly",
      );
      assert.ok(afterPaneDied.held_at, "the hold must still be recorded");
      assert.match(
        afterPaneDied.held_reason,
        /now belongs to a different pane/,
        "held_reason must keep naming the original reissue - the reason string carries the pane- " +
          "identity mismatch that made this a reissue hold in the first place",
      );
      assert.match(
        afterPaneDied.held_reason,
        /has since gone dead too/,
        "held_reason must ALSO name the second fact - the reissued pane has now died too - not " +
          "silently revert to an ordinary dead-pane reading with no memory of the reissue",
      );
    } finally {
      cleanup(gen2AnchorSession);
    }
  });

  it("a pre-migration worker row (pane_pid = '') is never treated as a mismatch by the widened agents sweep", async () => {
    const project = seedProject();
    const actorId = "agent:149002";
    const session = `hive-149-nullpid-${process.pid}`;
    execFileSync("tmux", ["new-session", "-d", "-s", session, "sleep", "600"], { stdio: "ignore" });
    const pane = paneIdOf(`=${session}`);

    try {

      const agentRowId = insertWorkerRow(project, actorId, pane, "");

      await tick();

      assert.equal(
        agentStatus(agentRowId),
        "running",
        "an absent recorded pid must proceed exactly as before this migration - a live pane with no " +
          "recorded pid is not evidence of a reissue",
      );
    } finally {
      cleanup(session);
    }
  });
});
