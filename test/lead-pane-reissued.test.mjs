import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { describe, it } from "node:test";

import { assertScratchStore, clearHiveEnv, isolateTmux, scratchDirs, until } from "./helpers.mjs";

// Todo 336. Pane ids restart from %0 when a tmux server exits and a fresh one
// starts on the same socket path - measured directly, and recorded on the
// todo. deliverable()'s old lead-pane-dead hold (HELD_REASON_LEAD_PANE_DEAD)
// only fires when the recorded pane reads DEAD; a reissued pane reads LIVE,
// so a pending lead-owned wake used to sail through and type into whatever
// pane the new server handed that id to next - a stranger's pane, not the
// lead's.
//
// THE FIXTURE IS THE WHOLE POINT (the lane's own plan pad, pad 112). A test
// that only checks "matching pid delivers, mismatched pid does not" tests the
// CONDITION this lane wrote, not the DEFECT todo 336 describes. So the first
// test below reproduces the real sequence measured on the todo: record a
// lead-owned wake against a real pane, kill every session so the server
// genuinely exits, start a fresh one on the same socket, and assert the wake
// does not land on whatever that fresh server's first pane turns out to be -
// no synthetic AliveSnapshot standing in for tmux's own restart behaviour.

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

// Independent of dist/tmux.ts on purpose (test/CLAUDE.md's own rule for
// assertion helpers): this file's whole point is to prove what a pane
// carries, so it has to ask tmux directly rather than through the code under
// test. list-panes, not display-message, matching src/tmux.ts's own reason
// (display-message silently answers for a different target on a dead one;
// list-panes just errors).
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
      `INSERT INTO timers (project_id, owner, body, kind, watch, deliver_actor, deliver_pane, due_at, created_at)
       VALUES (?, ?, ?, 'delay', '[]', ?, ?, datetime('now', '-1 seconds'), datetime('now', '-60 seconds'))
       RETURNING id`,
    )
    .get(projectId, actorId, body, actorId, pane).id;
}

const timerRow = (id) =>
  db.prepare("SELECT fired_at, typed_at, held_at, held_reason FROM timers WHERE id = ?").get(id);

describe("todo 336: a lead-owned wake must not type into a pane a tmux restart reissued", { skip: hasTmux ? false : "tmux is not installed" }, () => {
  it("DEFECT, reproduced for real: a wake held against a pane a fresh tmux server reissued to a stranger", async () => {
    const project = seedProject();
    const actorId = "lead:336001";

    // gen1: the ONLY tmux command this whole file has issued so far against
    // this file's private socket (isolateTmux gives every file its own), so
    // its pane is deterministically the server's very first: %0. Nothing
    // below depends on knowing that number - only on gen2's first pane also
    // being ITS server's first, which holds for the identical reason once
    // gen1's server is genuinely gone.
    const gen1Session = `hive-336-gen1-${process.pid}`;
    execFileSync("tmux", ["new-session", "-d", "-s", gen1Session, "sleep", "600"], { stdio: "ignore" });
    const gen1Pane = paneIdOf(`=${gen1Session}`);
    const gen1Pid = panePidOf(gen1Pane);

    insertLeadRow(project, actorId, gen1Pane, gen1Pid);
    const wakeBody = "echo wake-336-should-not-land-here";
    const timerId = insertDueLeadWake(project, actorId, gen1Pane, wakeBody);

    // Kill the ONLY session on this socket. tmux's default exit-empty
    // setting makes the server exit once no session is left - never
    // kill-server directly (test/suite-isolation.test.mjs refuses any file
    // but helpers.mjs from calling it, and for the reason stated there: a
    // bare kill-server resolves through ambient env and can reach a server
    // this file does not own).
    execFileSync("tmux", ["kill-session", "-t", `=${gen1Session}`], { stdio: "ignore" });
    const gone = await until(serverGone, 5000);
    assert.ok(gone, "the tmux server must fully exit before the next session starts a fresh one");

    // gen2: a BRAND NEW server on the same socket path (the old one is
    // gone), so its pane-id counter restarts at %0 exactly as measured on
    // the todo. This is what reissues gen1Pane's id to a genuinely different
    // process - not a mocked snapshot standing in for it.
    const gen2Session = `hive-336-gen2-${process.pid}`;
    execFileSync("tmux", ["new-session", "-d", "-s", gen2Session, "sleep", "600"], { stdio: "ignore" });
    const gen2Pane = paneIdOf(`=${gen2Session}`);
    const gen2Pid = panePidOf(gen2Pane);

    try {
      // THE FIXTURE'S OWN SANITY CHECK, not an assertion about the code under
      // test: prove the reissue actually happened before trusting anything
      // that follows. Same id, different process - if either fails, the rest
      // of this test proves nothing about todo 336's defect.
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
      // '' is this column's own DEFAULT and its "no fact recorded" reading
      // (src/db.ts's migration, TimerRow's own comment) - every row written
      // before this lane's migration lands reads this way, and an upgrade
      // must not start holding or cancelling every one of them.
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
