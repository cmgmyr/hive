import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import {
  DIST,
  REPO,
  isolateTmux,
  liveAgentRow,
  makeFakeClaude,
  McpClient,
  repaintPaneAsSameWorker,
  runFixture,
  scratchDirs,
  until,
} from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("the wake-hold notification tests");

const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { sessionName } = await import("../dist/tmux.js");
const { db } = await import("../dist/db.js");

const FIXTURES = join(REPO, "test", "fixtures", "panes");
const fixturePath = (file) => join(FIXTURES, file);
const replayFixture = (file) => `cat '${fixturePath(file)}'; sleep 600`;

let mcp;

before(async () => {
  mcp = new McpClient({ cwd: dirs.projectDir, dataDir: dirs.dataDir, env: { HIVE_SPAWN_READY_MS: "2000" } });
  await mcp.start();
  if (!hasTmux) return;
  execFileSync("tmux", [
    "new-session", "-d", "-s", sessionName(), "-x", "220", "-y", "50", "-c", dirs.projectDir,
  ]);
});

after(async () => {
  await mcp.close();
  cleanup(sessionName());
});

const fakeClaude = makeFakeClaude(dirs.tmp);

async function spawnShowing(name, shellCommand) {
  const receipt = await mcp.call("agent_spawn", {
    name,
    command: fakeClaude(shellCommand),
    extra_args: [],
    placement: "window",
  });
  await liveAgentRow(mcp, name);
  return receipt;
}

const agentRow = (name) => db.prepare("SELECT id, actor_id, tmux_target FROM agents WHERE name = ?").get(name);

const noticesAbout = (wakeId) =>
  db
    .prepare("SELECT * FROM timers WHERE id != ? AND body LIKE ? ORDER BY id")
    .all(wakeId, `%wake #${wakeId} %`);

const timerRow = (id) => db.prepare("SELECT * FROM timers WHERE id = ?").get(id);

async function ownedWake(ownerName, targetAgentId, body) {
  const wake = await mcp.call("wake_set", { delay_seconds: 5, body, deliver_to: targetAgentId });
  db.prepare("UPDATE timers SET owner = ? WHERE id = ?").run(agentRow(ownerName).actor_id, wake.wake_id);
  return wake.wake_id;
}

async function ownedIdleWake(ownerName, watchNames, deliverToAgentId, body) {
  const wake = await mcp.call("wake_when_idle", {
    agents: watchNames,
    body,
    deliver_to: deliverToAgentId,
    max_wait_seconds: 900,
  });
  db.prepare("UPDATE timers SET owner = ? WHERE id = ?").run(agentRow(ownerName).actor_id, wake.wake_id);
  return wake.wake_id;
}

async function ownedStandingWatch(ownerName, deliverToAgentId, body) {
  const watch = await mcp.call("wake_when_idle", {
    scope: "project",
    body,
    deliver_to: deliverToAgentId,
    max_wait_seconds: 900,
  });
  const setBy = timerRow(watch.wake_id).owner;
  db.prepare("UPDATE timers SET owner = ? WHERE id = ?").run(agentRow(ownerName).actor_id, watch.wake_id);
  return { watchId: watch.wake_id, setBy };
}

function markWaiting(name, since) {
  db.prepare("UPDATE agents SET agent_state = 'waiting', state_changed_at = ? WHERE name = ?").run(since, name);
}

const noticeCount = (wakeId) => noticesAbout(wakeId).length;

describe(
  "a wake held on a dialogged pane tells its owner, once per hold condition",
  { skip: hasTmux ? false : "tmux is not installed" },
  () => {
    it("notifies the owner once, leaves the original pending, and delivers it when the dialog clears", async () => {
      const owner = await spawnShowing("hold-notify-owner", replayFixture("ready-idle.txt"));
      const stuck = await spawnShowing("hold-notify-stuck", replayFixture("folder-trust-dialog.txt"));
      const wakeId = await ownedWake("hold-notify-owner", stuck.agent_id, "INTEGRATION hold-notify original body");

      let notices;
      await until(async () => {
        notices = noticesAbout(wakeId);
        return notices.length > 0;
      }, 15000);
      assert.equal(notices.length, 1, "the hold must produce a notification to the wake's owner");
      const notice = notices[0];
      assert.equal(notice.owner, agentRow("hold-notify-owner").actor_id, "owned by the actor that set the wake");
      assert.equal(notice.deliver_pane, owner.tmux_target, "delivered to that owner's own pane");
      assert.equal(
        notice.parent_timer_id,
        wakeId,
        "parent-linked to the wake it reports on, so cancelling that wake cascades to this notice (todo 322)",
      );

      assert.equal(
        notice.deliver_actor,
        agentRow("hold-notify-owner").actor_id,
        "delivered AS that actor, not just at its pane",
      );
      assert.equal(notice.project_id, timerRow(wakeId).project_id, "filed in the held wake's project");
      assert.match(notice.body, /hold-notify-stuck/, "it must name the worker that is stuck");
      assert.match(notice.body, /agent_send/, "and the way out, which is agent_send with keys");
      assert.match(notice.body, /keys/, "keys specifically: text is refused against a dialog");

      const heldAtFirst = timerRow(wakeId).held_at;
      assert.ok(heldAtFirst, "the original must be recorded as held");
      await until(async () => timerRow(wakeId).held_at > heldAtFirst, 12000);
      assert.ok(
        timerRow(wakeId).held_at > heldAtFirst,
        "the scheduler must have re-held this wake on a later tick, or the count below proves nothing",
      );
      assert.equal(
        noticesAbout(wakeId).length,
        1,
        "one notification per hold condition: a per-tick version inserts one every three seconds",
      );

      await mcp.close();
      mcp = new McpClient({ cwd: dirs.projectDir, dataDir: dirs.dataDir, env: { HIVE_SPAWN_READY_MS: "2000" } });
      await mcp.start();
      assert.ok((await mcp.call("whoami")).actor_id, "the replacement server must really be serving");
      const heldAtHandover = timerRow(wakeId).held_at;
      await until(async () => timerRow(wakeId).held_at > heldAtHandover, 15000);
      assert.ok(
        timerRow(wakeId).held_at > heldAtHandover,
        "the replacement server must have re-held this wake: nothing else is left to write that column",
      );
      assert.equal(
        noticesAbout(wakeId).length,
        1,
        "still one notification after the store changed hands: the claim is atomic across processes",
      );

      const original = timerRow(wakeId);
      assert.equal(original.fired_at, null, "the original wake must not have fired");
      assert.equal(original.cancelled_at, null, "and must not have been cancelled");
      assert.equal(original.typed_at, null, "and nothing was typed into the dialogged pane");
      assert.match(original.held_reason, /modal choice/, "it is still held for the dialog");

      await until(async () => timerRow(notice.id).typed_at != null, 15000);

      const screen = execFileSync("tmux", ["capture-pane", "-p", "-J", "-S", "-", "-t", owner.tmux_target], {
        encoding: "utf8",
      });
      assert.match(screen, /hive wake #/, "the owner's pane must show the delivered notification");
      assert.match(screen, /hold-notify-stuck/, "naming the worker that needs a human");

      repaintPaneAsSameWorker(db, stuck.tmux_target, "sleep 600");
      await until(async () => timerRow(wakeId).typed_at != null, 15000);
      const delivered = timerRow(wakeId);
      assert.ok(delivered.typed_at, "the original wake delivers once the dialog clears");
      assert.equal(delivered.held_at, null, "and a resolved hold stops being reported as current");
    });

    it("holds the notification too when the owner's own pane is on a dialog, and never chains", async () => {
      const owner = await spawnShowing("hold-notify-busy-owner", replayFixture("folder-trust-dialog.txt"));
      const stuck = await spawnShowing("hold-notify-stuck-2", replayFixture("model-picker-dialog.txt"));
      const wakeId = await ownedWake("hold-notify-busy-owner", stuck.agent_id, "INTEGRATION hold-notify busy owner");

      let notices;
      await until(async () => {
        notices = noticesAbout(wakeId);
        return notices.length > 0;
      }, 15000);
      assert.equal(notices.length, 1, "one notification, even though it cannot be delivered yet");
      const notice = notices[0];
      assert.equal(notice.deliver_pane, owner.tmux_target, "aimed at the owner's own dialogged pane");

      await until(async () => timerRow(notice.id).held_at != null, 15000);
      const heldNotice = timerRow(notice.id);
      assert.ok(heldNotice.held_at, "the notification must hold against the owner's own dialog");
      assert.match(heldNotice.held_reason, /modal choice/, "for the same reason, recorded the same way");
      assert.equal(heldNotice.typed_at, null, "and must never be typed into a dialog");

      await until(async () => noticesAbout(notice.id).length > 0, 9000);
      assert.equal(
        noticesAbout(notice.id).length,
        0,
        "a notification held on its own owner's pane must not notify anyone: there is nobody else to tell",
      );
      assert.equal(noticesAbout(wakeId).length, 1, "and the original still has exactly one");
      assert.equal(notice.owner, notice.deliver_actor, "the structural half of the guard: a notice owns itself");
    });

    it("notifies the owner for unsubmitted human text too, not only for a dialog (todo 320)", async () => {
      const owner = await spawnShowing("hold-notify-typing-owner", replayFixture("ready-idle.txt"));
      const stuck = await spawnShowing("hold-notify-typing", replayFixture("real-input.txt"));
      const wakeId = await ownedWake("hold-notify-typing-owner", stuck.agent_id, "INTEGRATION hold-notify typing");

      const ownerRow = agentRow("hold-notify-typing-owner");
      assert.ok(ownerRow.tmux_target, "the owner must have a pane, or silence proves nothing");
      assert.notEqual(ownerRow.tmux_target, stuck.tmux_target, "and a different one from the held target");
      assert.equal(ownerRow.tmux_target, owner.tmux_target, "the same pane the spawn receipt named");

      await until(async () => timerRow(wakeId).held_at != null, 15000);
      assert.match(timerRow(wakeId).held_reason, /unsubmitted/, "held for the input-box reason, not the dialog one");
      await until(async () => noticesAbout(wakeId).length > 0, 15000);
      assert.equal(noticesAbout(wakeId).length, 1, "this hold now notifies too - see wake-hold-unsubmitted-input-notify.test.mjs");
      assert.equal(noticesAbout(wakeId)[0].deliver_pane, owner.tmux_target, "delivered to the owner's own pane");
      assert.match(noticesAbout(wakeId)[0].body, /unsubmitted/, "and it must say what kind of hold this is");
    });
  },
);

const LEAD_DEAD_SEED = `
const project = db.prepare("INSERT INTO projects (name, path) VALUES ('hold-notify', '/tmp/hold-notify') RETURNING id").get().id;
db.prepare(
  \`INSERT INTO agents (project_id, actor_id, name, kind, tmux_target, command, cwd, status, agent_state, created_at)
   VALUES (?, 'lead:1', 'the-lead', 'lead', '%dead', 'claude', '/tmp', 'running', 'unknown', datetime('now', '-60 seconds'))\`,
).run(project);
db.prepare(
  \`INSERT INTO agents (project_id, actor_id, name, kind, tmux_target, command, cwd, status, agent_state, created_at)
   VALUES (?, 'agent:9', 'the-owner', 'agent', '%live', 'claude', '/tmp', 'running', 'idle', datetime('now', '-60 seconds'))\`,
).run(project);
const timerId = db.prepare(
  \`INSERT INTO timers (project_id, owner, body, kind, watch, deliver_actor, deliver_pane, due_at, created_at)
   VALUES (?, 'agent:9', 'wake body', 'delay', '[]', 'lead:1', '%dead', datetime('now', '-1 seconds'), datetime('now', '-60 seconds'))
   RETURNING id\`,
).get(project).id;
const snapshot = { panes: new Set(['%live']), windows: new Set() };
`;

describe(
  "a wake waiting on a worker that is stopped on a dialog tells its owner",
  { skip: hasTmux ? false : "tmux is not installed" },
  () => {
    it("notifies once while the wake is still pending, and re-arms when the worker blocks again", async () => {
      const owner = await spawnShowing("block-notify-owner", replayFixture("ready-idle.txt"));
      const stuck = await spawnShowing("block-notify-stuck", replayFixture("folder-trust-dialog.txt"));
      markWaiting("block-notify-stuck", "2026-08-08 10:00:00");
      const wakeId = await ownedIdleWake(
        "block-notify-owner",
        ["block-notify-stuck"],
        owner.agent_id,
        "INTEGRATION block-notify original body",
      );

      let notices;
      await until(async () => {
        notices = noticesAbout(wakeId);
        return notices.length > 0;
      }, 15000);
      assert.equal(notices.length, 1, "the block must produce one notification to the wake's owner");
      assert.equal(notices[0].deliver_pane, owner.tmux_target, "delivered to the owner's pane");
      assert.match(notices[0].body, /block-notify-stuck/, "naming the blocked worker");
      assert.match(notices[0].body, /cannot go idle/, "and saying why the wake is not firing");
      assert.equal(
        notices[0].parent_timer_id,
        wakeId,
        "parent-linked to the wake it reports on, so cancelling that wake cascades to this notice (todo 322)",
      );

      const original = timerRow(wakeId);
      assert.equal(original.fired_at, null, "the watched wake must not have fired");
      assert.equal(original.cancelled_at, null, "and must not have been cancelled");
      assert.equal(original.held_at, null, "and must not be reported as held: it was never due");
      assert.equal(original.held_reason, null, "nor carry a hold reason");

      const control = await mcp.call("wake_set", {
        delay_seconds: 2,
        body: "INTEGRATION block-notify control wake",
        deliver_to: owner.agent_id,
      });
      await new Promise((resolve) => setTimeout(resolve, 9000));
      assert.ok(timerRow(control.wake_id).typed_at, "the scheduler must have been ticking through that window");
      assert.equal(noticeCount(wakeId), 1, "one per block, not one per tick");

      await mcp.close();
      mcp = new McpClient({ cwd: dirs.projectDir, dataDir: dirs.dataDir, env: { HIVE_SPAWN_READY_MS: "2000" } });
      await mcp.start();
      const handoverControl = await mcp.call("wake_set", {
        delay_seconds: 2,
        body: "INTEGRATION block-notify handover control",
        deliver_to: owner.agent_id,
      });
      await until(async () => timerRow(handoverControl.wake_id).typed_at != null, 15000);
      assert.ok(
        timerRow(handoverControl.wake_id).typed_at,
        "the replacement server must be ticking, or the count below proves nothing",
      );
      assert.equal(noticeCount(wakeId), 1, "still one after the store changed hands: the claim is in the store");

      repaintPaneAsSameWorker(db, stuck.tmux_target, replayFixture("ready-idle.txt"));
      db.prepare("UPDATE agents SET agent_state = 'working', state_changed_at = ? WHERE name = ?").run(
        "2026-08-08 10:05:00",
        "block-notify-stuck",
      );
      await new Promise((resolve) => setTimeout(resolve, 4000));
      assert.equal(noticeCount(wakeId), 1, "nothing new while the worker is not blocked");

      repaintPaneAsSameWorker(db, stuck.tmux_target, replayFixture("model-picker-dialog.txt"));
      markWaiting("block-notify-stuck", "2026-08-08 10:06:00");
      await until(async () => noticeCount(wakeId) > 1, 15000);
      assert.equal(noticeCount(wakeId), 2, "a second block is a second condition and must be reported again");
    });

    it("cancels an already-filed block notice once its wake is cancelled (todo 322)", async () => {
      const owner = await spawnShowing("block-cancel-owner", replayFixture("ready-idle.txt"));
      const stuck = await spawnShowing("block-cancel-stuck", replayFixture("folder-trust-dialog.txt"));
      markWaiting("block-cancel-stuck", "2026-08-10 10:00:00");
      const wake = await mcp.call("wake_when_idle", {
        agents: ["block-cancel-stuck"],
        body: "INTEGRATION block-cancel original body",
        deliver_to: owner.agent_id,
        max_wait_seconds: 900,
      });
      const wakeId = wake.wake_id;
      const setBy = timerRow(wakeId).owner;
      db.prepare("UPDATE timers SET owner = ? WHERE id = ?").run(agentRow("block-cancel-owner").actor_id, wakeId);

      await until(async () => noticeCount(wakeId) > 0, 15000);
      const notice = noticesAbout(wakeId)[0];
      assert.equal(notice.parent_timer_id, wakeId, "filed with the parent link this lane adds");

      db.prepare("UPDATE timers SET owner = ? WHERE id = ?").run(setBy, wakeId);
      const cancelResult = await mcp.call("wake_cancel", { wake_id: wakeId });
      assert.equal(cancelResult.cancelled_notices, 1, "wake_cancel's existing cascade covers it once parented");
      assert.ok(timerRow(notice.id).cancelled_at, "the block notice about a wake that no longer exists is cancelled");
      assert.equal(timerRow(notice.id).typed_at, null, "and must never have been typed");

      // Clear the dialog and the 'waiting' latch: the standing-watch describe block below scans every
      // 'waiting' agent project-wide, and a leftover dialogged pane here batches into ITS notices too.
      repaintPaneAsSameWorker(db, stuck.tmux_target, replayFixture("ready-idle.txt"));
      db.prepare("UPDATE agents SET agent_state = 'idle', state_changed_at = datetime('now') WHERE name = ?").run(
        "block-cancel-stuck",
      );
    });

    it("notifies the owner when the blocked worker is on an ordinary tool-permission prompt (todo 392)", async () => {
      const owner = await spawnShowing("permission-block-owner", replayFixture("ready-idle.txt"));
      const stuck = await spawnShowing("permission-block-stuck", replayFixture("tool-permission-prompt.txt"));
      markWaiting("permission-block-stuck", "2026-08-13 20:00:00");
      const wakeId = await ownedIdleWake(
        "permission-block-owner",
        ["permission-block-stuck"],
        owner.agent_id,
        "INTEGRATION permission-block original body",
      );

      let notices;
      await until(async () => {
        notices = noticesAbout(wakeId);
        return notices.length > 0;
      }, 15000);
      assert.equal(notices.length, 1, "the block must produce one notification to the wake's owner");
      assert.equal(notices[0].deliver_pane, owner.tmux_target, "delivered to the owner's pane");
      assert.match(notices[0].body, /permission-block-stuck/, "naming the blocked worker");
      assert.match(notices[0].body, /cannot go idle/, "and saying why the wake is not firing");

      const original = timerRow(wakeId);
      assert.equal(original.fired_at, null, "the watched wake must not have fired");
      assert.equal(original.held_at, null, "and must not be reported as held: it was never due");
    });

    it("says nothing for a stale `waiting` whose pane has no dialog on it", async () => {
      const owner = await spawnShowing("stale-latch-owner", replayFixture("ready-idle.txt"));
      const resumed = await spawnShowing("stale-latch-worker", replayFixture("ready-idle.txt"));

      markWaiting("stale-latch-worker", "2026-08-08 10:00:00");
      const wakeId = await ownedIdleWake(
        "stale-latch-owner",
        ["stale-latch-worker"],
        owner.agent_id,
        "INTEGRATION stale latch check",
      );

      assert.ok(agentRow("stale-latch-owner").tmux_target, "the owner must have a pane to be told at");
      assert.notEqual(agentRow("stale-latch-owner").tmux_target, resumed.tmux_target, "a different pane");
      assert.equal(
        db.prepare("SELECT agent_state FROM agents WHERE name = 'stale-latch-worker'").get().agent_state,
        "waiting",
        "the latch must really say waiting, or this tests nothing",
      );

      await until(async () => noticeCount(wakeId) > 0, 10000);
      assert.equal(noticeCount(wakeId), 0, "a stale latch over a pane with no dialog must say nothing");
      assert.equal(timerRow(wakeId).fired_at, null, "and the wake keeps waiting for a real idle");
    });

    it("tells a rowless owner at the pane the wake itself resolved, and the owner's own pane when it has one", async () => {
      const teller = await spawnShowing("rowless-block-teller", replayFixture("ready-idle.txt"));
      const later = await spawnShowing("rowless-block-owner", replayFixture("ready-idle.txt"));
      const stuck = await spawnShowing("rowless-block-stuck", replayFixture("folder-trust-dialog.txt"));
      markWaiting("rowless-block-stuck", "2026-08-09 09:00:00");

      const wake = await mcp.call("wake_when_idle", {
        agents: ["rowless-block-stuck"],
        body: "INTEGRATION rowless-owner block",
        deliver_to: teller.agent_id,
        max_wait_seconds: 900,
      });
      const wakeId = wake.wake_id;
      const owner = timerRow(wakeId).owner;
      assert.equal(
        db.prepare("SELECT COUNT(*) AS n FROM agents WHERE actor_id = ?").get(owner).n,
        0,
        "the fixture must really be the rowless case, or it proves nothing",
      );
      assert.notEqual(timerRow(wakeId).deliver_pane, stuck.tmux_target, "and the pane told is not the stuck one");

      await until(async () => noticeCount(wakeId) > 0, 15000);
      assert.equal(noticeCount(wakeId), 1, "a rowless owner still gets told; the wake resolved a pane either way");
      assert.equal(
        noticesAbout(wakeId)[0].deliver_pane,
        teller.tmux_target,
        "at the pane the wake itself resolved, which is the only one hive knows for this caller",
      );
      assert.equal(
        noticesAbout(wakeId)[0].deliver_actor,
        agentRow("rowless-block-teller").actor_id,
        "and AS that actor: the pane and the actor must come from the same place or the socket join is wrong",
      );

      db.prepare("UPDATE timers SET owner = ? WHERE id = ?").run(agentRow("rowless-block-owner").actor_id, wakeId);
      assert.notEqual(later.tmux_target, teller.tmux_target, "the owner and the delivery target must differ here");
      markWaiting("rowless-block-stuck", "2026-08-09 09:10:00");
      await until(async () => noticeCount(wakeId) > 1, 15000);
      assert.equal(noticeCount(wakeId), 2, "a second block episode is reported again");
      assert.equal(
        noticesAbout(wakeId)[1].deliver_pane,
        later.tmux_target,
        "an owner with a live pane is told at ITS pane, not at the wake's delivery target",
      );
    });

    it("does not double-notify when the same block reaches both paths in sequence", async () => {
      const owner = await spawnShowing("both-paths-owner", replayFixture("ready-idle.txt"));
      const stuck = await spawnShowing("both-paths-stuck", replayFixture("folder-trust-dialog.txt"));
      const other = await spawnShowing("both-paths-other", replayFixture("ready-idle.txt"));
      markWaiting("both-paths-stuck", "2026-08-08 11:00:00");

      const wakeId = await ownedIdleWake(
        "both-paths-owner",
        ["both-paths-stuck", "both-paths-other"],
        stuck.agent_id,
        "INTEGRATION both paths",
      );

      await until(async () => noticeCount(wakeId) > 0, 15000);
      assert.equal(noticeCount(wakeId), 1, "one notification about one block, not one per path");
      assert.equal(noticesAbout(wakeId)[0].deliver_pane, owner.tmux_target, "and it went to the owner");

      assert.match(
        noticesAbout(wakeId)[0].body,
        /cannot go idle/,
        "the blocked-watched path is the one that must have spoken here",
      );

      db.prepare(
        "UPDATE agents SET agent_state = 'idle', state_changed_at = datetime('now'), resumed_at = '' WHERE name = ?",
      ).run("both-paths-other");
      const control = await mcp.call("wake_set", {
        delay_seconds: 2,
        body: "INTEGRATION both-paths control wake",
        deliver_to: other.agent_id,
      });
      await new Promise((resolve) => setTimeout(resolve, 9000));
      assert.ok(timerRow(control.wake_id).typed_at, "the scheduler must have been ticking through that window");
      assert.match(timerRow(wakeId).held_reason ?? "", /modal choice/, "the wake really did reach the held path");
      assert.equal(timerRow(wakeId).typed_at, null, "and was never typed into the dialog");
      assert.equal(noticeCount(wakeId), 1, "still one across later ticks");
    });
  },
);

describe(
  "a standing watch tells its owner when a crew member is stopped on a dialog",
  { skip: hasTmux ? false : "tmux is not installed" },
  () => {

    const cancelWatch = async (watchId, originalOwner) => {
      db.prepare("UPDATE timers SET owner = ? WHERE id = ?").run(originalOwner, watchId);
      await mcp.call("wake_cancel", { wake_id: watchId });
      assert.ok(timerRow(watchId).cancelled_at, "the watch must really be cancelled, or it outlives its own test");
    };

    const readCall = (name) => `agent_output(name: "${name}")`;

    const onScreen = (pane, text) =>
      execFileSync("tmux", ["capture-pane", "-p", "-J", "-t", pane], { encoding: "utf8" }).includes(text);
    const TRUST_DIALOG = "Yes, I trust this folder";
    const blockNoticesNaming = (name) =>
      db
        .prepare("SELECT * FROM timers WHERE parent_timer_id IS NULL AND kind = 'delay' AND body LIKE ? ORDER BY id")
        .all(`%${readCall(name)}%`);

    it("files a block notice for a crew member it never had in a watch list", async () => {
      const owner = await spawnShowing("standing-block-owner", replayFixture("ready-idle.txt"));
      const stuck = await spawnShowing("standing-block-stuck", replayFixture("folder-trust-dialog.txt"));
      await until(async () => onScreen(stuck.tmux_target, TRUST_DIALOG), 15000);
      assert.ok(onScreen(stuck.tmux_target, TRUST_DIALOG), "the dialog must be painted before the watch exists");
      markWaiting("standing-block-stuck", "2026-08-09 12:00:00");

      const { watchId, setBy } = await ownedStandingWatch(
        "standing-block-owner",
        owner.agent_id,
        "INTEGRATION standing-block crew update",
      );

      assert.equal(timerRow(watchId).watch, "[]", "a standing watch's watch list is empty by design");
      assert.equal(timerRow(watchId).watch_scope, "project", "and its membership is a query over the project");

      await until(async () => blockNoticesNaming("standing-block-stuck").length > 0, 20000);
      const filed = blockNoticesNaming("standing-block-stuck");
      assert.equal(filed.length, 1, "the standing watch must file exactly one notice about this block");
      assert.equal(filed[0].deliver_pane, owner.tmux_target, "delivered to the watch's own owner");
      assert.match(filed[0].body, /Standing watch #/, "and it says what kind of watch it is");
      assert.match(
        filed[0].body,
        /will report nothing about the workers above until their dialogs are answered/,
        "the one-shot's sentence is false for a standing watch: it never fires and has no max wait to race",
      );
      assert.doesNotMatch(
        filed[0].body,
        /will not fire until the dialog is answered/,
        "and specifically it must not claim a standing watch fires",
      );
      assert.doesNotMatch(
        filed[0].body,
        /still watching, still pending/,
        "must not assert the watch's own liveness, which it cannot know at delivery time (todo 322)",
      );
      const observedMatch = filed[0].body.match(
        /hive last confirmed the dialogs above at (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) UTC/,
      );
      assert.ok(observedMatch, "reports what hive saw and when instead, letting the reader judge staleness");
      const asMs = (t) => new Date(`${t.replace(" ", "T")}Z`).getTime();
      assert.ok(
        Math.abs(asMs(observedMatch[1]) - asMs(filed[0].created_at)) <= 2000,
        // storeNow() (when the batch observed the dialogs) and the notice row's own created_at default
        // are two separate datetime('now') evaluations a moment apart; SQLite's one-second resolution
        // means an exact-string match can flake across a second boundary - a small tolerance instead.
        `observed-at (${observedMatch[1]}) must be within 2s of the notice's created_at (${filed[0].created_at})`,
      );
      assert.equal(filed[0].parent_timer_id, null, "left unparented on purpose: it may still be true after a cancel");

      assert.ok(timerRow(watchId).max_wait_at, "a standing watch does have a max_wait_at - it is the lifetime");
      assert.match(filed[0].body, /keys/, "the way out is agent_send with keys, as on the one-shot half");

      assert.equal(filed[0].watch_scope, null, "a notice must never itself be a standing watch");
      assert.equal(filed[0].watch, "[]", "nor watch anything: deliver() would paste worker screens into the body");
      assert.equal(blockNoticesNaming("standing-block-owner").length, 0, "and nothing is filed about the owner");

      const row = timerRow(watchId);
      assert.equal(row.fired_at, null, "the watch must not have fired");
      assert.equal(row.held_at, null, "must not be reported as held: it was never due");
      assert.equal(row.held_reason, null, "nor carry a hold reason");
      assert.equal(row.cancelled_at, null, "and must still be watching");

      const control = await mcp.call("wake_set", {
        delay_seconds: 2,
        body: "INTEGRATION standing-block control wake",
        deliver_to: owner.agent_id,
      });
      await new Promise((resolve) => setTimeout(resolve, 9000));
      assert.ok(timerRow(control.wake_id).typed_at, "the scheduler must have been ticking through that window");
      assert.equal(blockNoticesNaming("standing-block-stuck").length, 1, "one per block, not one per tick");

      assert.equal(
        db.prepare("SELECT COUNT(*) AS n FROM wake_block_notices WHERE timer_id = ? AND agent_id = ?").get(
          watchId,
          agentRow("standing-block-stuck").id,
        ).n,
        1,
        "and the claim lives in wake_block_notices, which the finish half never touches",
      );
      assert.equal(
        db.prepare("SELECT COUNT(*) AS n FROM wake_idle_notices WHERE timer_id = ? AND agent_id = ?").get(
          watchId,
          agentRow("standing-block-stuck").id,
        ).n,
        0,
        "a block is not a finish: the two conditions have separate claim tables and must not collide",
      );

      await until(async () => timerRow(filed[0].id).typed_at != null, 20000);
      assert.ok(timerRow(filed[0].id).typed_at, "the notice must be typed, not merely filed");

      const late = await spawnShowing("standing-block-latecomer", replayFixture("model-picker-dialog.txt"));
      assert.ok(
        db.prepare("SELECT created_at > (SELECT created_at FROM timers WHERE id = ?) AS after FROM agents WHERE id = ?")
          .get(watchId, agentRow("standing-block-latecomer").id).after,
        "the second worker must really postdate the watch, or it proves nothing about later joiners",
      );
      markWaiting("standing-block-latecomer", "2026-08-09 12:30:00");
      await until(async () => blockNoticesNaming("standing-block-latecomer").length > 0, 20000);
      const lateFiled = blockNoticesNaming("standing-block-latecomer");
      assert.equal(lateFiled.length, 1, "a crew member that appeared after the watch was set is watched too");
      assert.equal(lateFiled[0].deliver_pane, owner.tmux_target, "and reported to the same owner");
      assert.notEqual(late.tmux_target, stuck.tmux_target, "two distinct panes, or one notice could serve both");
      assert.equal(
        blockNoticesNaming("standing-block-stuck").length,
        1,
        "and the first worker is still reported exactly once: two blocks, two independent claims",
      );

      await cancelWatch(watchId, setBy);
    });

    it("names every crew member blocked in one tick in ONE notice", async () => {
      const owner = await spawnShowing("batch-block-owner", replayFixture("ready-idle.txt"));
      const first = await spawnShowing("batch-block-one", replayFixture("folder-trust-dialog.txt"));

      const second = await spawnShowing('batch"two', replayFixture("model-picker-dialog.txt"));
      await until(
        async () => onScreen(first.tmux_target, TRUST_DIALOG) && onScreen(second.tmux_target, "Esc"),
        15000,
      );
      assert.ok(onScreen(first.tmux_target, TRUST_DIALOG), "both dialogs must really be up first");
      markWaiting("batch-block-one", "2026-08-09 13:00:00");
      markWaiting('batch"two', "2026-08-09 13:00:00");

      const { watchId, setBy } = await ownedStandingWatch(
        "batch-block-owner",
        owner.agent_id,
        "INTEGRATION batch-block crew update",
      );

      await until(async () => blockNoticesNaming("batch-block-one").length > 0, 20000);
      const filed = blockNoticesNaming("batch-block-one");
      assert.equal(filed.length, 1, "one notice, not one per worker");
      assert.ok(
        filed[0].body.includes('agent_output(name: "batch\\"two")'),
        `a quote in a legal agent name must be escaped, or the remedy cannot be run: ${filed[0].body}`,
      );
      assert.deepEqual(
        db
          .prepare("SELECT id FROM timers WHERE parent_timer_id IS NULL AND kind = 'delay' AND body LIKE ?")
          .all('%agent_output(name: "batch\\"two")%')
          .map((n) => n.id),
        [filed[0].id],
        "the second worker's report IS that same row, not a second one",
      );

      const listed = filed[0].body.match(/agent_output\(name: "/g)?.length ?? 0;
      assert.ok(listed >= 2, "this notice must cover at least the two workers this test blocked");
      assert.equal(
        Number(filed[0].body.match(/^(\d+) crew member\(s\)/)[1]),
        listed,
        "the roster's count must match what it actually lists, or the reader is told a wrong number",
      );

      assert.equal(
        db
          .prepare("SELECT COUNT(*) AS n FROM wake_block_notices WHERE timer_id = ? AND agent_id IN (?, ?)")
          .get(watchId, agentRow("batch-block-one").id, agentRow('batch"two').id).n,
        2,
        "two blocks, two claim rows, one notice",
      );
      await cancelWatch(watchId, setBy);
    });
  },
);

describe("the lead-pane-dead hold stays silent", () => {
  it("records the hold and notifies nobody", () => {
    const { dataDir, tmp } = scratchDirs();
    const out = runFixture(
      tmp,
      "lead-pane-dead-hold",
      `const { db, migrate } = await import(${JSON.stringify(join(DIST, "db.js"))});\n` +
        `const { tick } = await import(${JSON.stringify(join(DIST, "scheduler.js"))});\n` +
        `migrate();\n${LEAD_DEAD_SEED}\n` +
        `await tick(snapshot);\nawait tick(snapshot);\n` +
        `const row = db.prepare("SELECT held_reason, fired_at FROM timers WHERE id = ?").get(timerId);\n` +
        `const total = db.prepare("SELECT COUNT(*) AS n FROM timers").get().n;\n` +
        `const ownerRunning = db.prepare("SELECT status FROM agents WHERE actor_id = 'agent:9'").get().status;\n` +
        `process.stdout.write(JSON.stringify({ heldReason: row.held_reason, fired: row.fired_at !== null, total, ownerRunning }));`,
      { HIVE_DATA_DIR: dataDir },
    );
    assert.match(out.heldReason ?? "", /not live/, "the lead-pane-dead hold must still be recorded");
    assert.equal(out.fired, false, "and the wake must not have fired");
    assert.equal(out.ownerRunning, "running", "the owner row must still be running, or this proves nothing");
    assert.equal(out.total, 1, "no notification row: this hold reason has no live pane to deliver one to");
  });
});

describe("the block half does not re-read a pane it just found no dialog on", () => {
  it("reads a stale-`waiting` worker's pane once, not once per tick", { skip: hasTmux ? false : "no tmux" }, () => {
    const { dataDir, tmp } = scratchDirs();
    const realTmux = execFileSync("sh", ["-c", "command -v tmux"], { encoding: "utf8" }).trim();
    const shimDir = join(tmp, "shim");
    const log = join(tmp, "tmux-calls.log");
    mkdirSync(shimDir, { recursive: true });
    writeFileSync(
      join(shimDir, "tmux"),
      `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\nexec ${JSON.stringify(realTmux)} "$@"\n`,
    );
    chmodSync(join(shimDir, "tmux"), 0o755);

    const pane = execFileSync(
      "tmux",
      ["new-window", "-P", "-F", "#{pane_id}", "-t", sessionName(), replayFixture("ready-idle.txt")],
      { encoding: "utf8" },
    ).trim();

    const out = runFixture(
      tmp,
      "no-dialog-fork-count",
      `const { db, migrate } = await import(${JSON.stringify(join(DIST, "db.js"))});\n` +
        `const { tick } = await import(${JSON.stringify(join(DIST, "scheduler.js"))});\n` +
        `const { tmuxSocketPath } = await import(${JSON.stringify(join(DIST, "tmux.js"))});\n` +
        `migrate();\n` +
        `const socket = tmuxSocketPath(process.env.TMUX, process.env.TMUX_TMPDIR);\n` +
        `const pane = ${JSON.stringify(pane)};\n` +
        `const project = db.prepare("INSERT INTO projects (name, path) VALUES ('fc', '/tmp/fc') RETURNING id").get().id;\n` +
        `db.prepare(\`INSERT INTO agents (project_id, actor_id, name, tmux_target, tmux_socket, command, cwd, kind, status, created_at)\n` +
        `  VALUES (?, 'lead:1', 'lead', '%dead', ?, 'claude', '/tmp', 'lead', 'running', datetime('now', '-300 seconds'))\`).run(project, socket);\n` +
        `db.prepare(\`INSERT INTO agents (project_id, actor_id, name, tmux_target, tmux_socket, command, cwd, kind, status,\n` +
        `    agent_state, state_changed_at, created_at)\n` +
        `  VALUES (?, 'agent:1', 'stale', ?, ?, 'claude', '/tmp', 'agent', 'running', 'waiting',\n` +
        `    datetime('now', '-120 seconds'), datetime('now', '-300 seconds'))\`).run(project, pane, socket);\n` +
        `const watchId = db.prepare(\`INSERT INTO timers (project_id, owner, body, kind, watch_scope, deliver_actor,\n` +
        `    deliver_pane, max_wait_at, created_at)\n` +
        `  VALUES (?, 'lead:1', 'crew update', 'idle_any', 'project', 'lead:1', '%dead',\n` +
        `    datetime('now', '+4 hours'), datetime('now', '-60 seconds')) RETURNING id\`).get(project).id;\n` +
        `const snapshot = { panes: new Set([pane]), windows: new Set() };\n` +
        `await tick(snapshot);\nawait tick(snapshot);\nawait tick(snapshot);\n` +
        `const notices = db.prepare("SELECT COUNT(*) AS n FROM wake_block_notices WHERE timer_id = ?").get(watchId).n;\n` +
        `process.stdout.write(JSON.stringify({ notices, watching: db.prepare("SELECT fired_at FROM timers WHERE id = ?").get(watchId).fired_at }));`,
      { HIVE_DATA_DIR: dataDir, TMUX_TMPDIR: process.env.TMUX_TMPDIR, PATH: `${shimDir}:${process.env.PATH}` },
    );

    const captures = readFileSync(log, "utf8")
      .split("\n")
      .filter((line) => line.startsWith("capture-pane") && line.includes(pane));
    execFileSync("tmux", ["kill-pane", "-t", pane], { stdio: "ignore" });

    assert.ok(captures.length > 0, "the block half must actually have read this pane, or the count below is vacuous");
    assert.equal(captures.length, 1, `three ticks, one read: ${captures.join(" | ")}`);

    assert.equal(out.notices, 0, "a pane with no dialog on it must produce no block notice");
    assert.equal(out.watching, null, "and the watch must still be watching");
  });
});

describe("a block notice falls back when the owner's pane is dead", () => {
  it("files at the live delivery target, not at a lead row that is still 'running'", { skip: hasTmux ? false : "no tmux" }, () => {
    const { dataDir, tmp } = scratchDirs();
    const spawnPane = (fixture) =>
      execFileSync("tmux", ["new-window", "-P", "-F", "#{pane_id}", "-t", sessionName(), replayFixture(fixture)], {
        encoding: "utf8",
      }).trim();
    const stuckPane = spawnPane("folder-trust-dialog.txt");
    const tellPane = spawnPane("ready-idle.txt");

    execFileSync("sh", ["-c", `for i in $(seq 1 60); do tmux capture-pane -p -t ${stuckPane} | grep -q 'I trust this folder' && exit 0; sleep 0.25; done; exit 1`]);

    const out = runFixture(
      tmp,
      "dead-owner-pane-fallback",
      `const { db, migrate } = await import(${JSON.stringify(join(DIST, "db.js"))});\n` +
        `const { tick } = await import(${JSON.stringify(join(DIST, "scheduler.js"))});\n` +
        `const { tmuxSocketPath } = await import(${JSON.stringify(join(DIST, "tmux.js"))});\n` +
        `migrate();\n` +
        `const socket = tmuxSocketPath(process.env.TMUX, process.env.TMUX_TMPDIR);\n` +
        `const stuckPane = ${JSON.stringify(stuckPane)};\n` +
        `const tellPane = ${JSON.stringify(tellPane)};\n` +
        `const project = db.prepare("INSERT INTO projects (name, path) VALUES ('df', '/tmp/df') RETURNING id").get().id;\n` +

        `db.prepare(\`INSERT INTO agents (project_id, actor_id, name, tmux_target, tmux_socket, command, cwd, kind, status, created_at)\n` +
        `  VALUES (?, 'lead:1', 'lead', '%dead', ?, 'claude', '/tmp', 'lead', 'running', datetime('now', '-300 seconds'))\`).run(project, socket);\n` +
        `db.prepare(\`INSERT INTO agents (project_id, actor_id, name, tmux_target, tmux_socket, command, cwd, kind, status, agent_state, state_changed_at, created_at)\n` +
        `  VALUES (?, 'agent:2', 'teller', ?, ?, 'claude', '/tmp', 'agent', 'running', 'idle', datetime('now', '-200 seconds'), datetime('now', '-300 seconds'))\`).run(project, tellPane, socket);\n` +
        `db.prepare(\`INSERT INTO agents (project_id, actor_id, name, tmux_target, tmux_socket, command, cwd, kind, status, agent_state, state_changed_at, created_at)\n` +
        `  VALUES (?, 'agent:3', 'stuck', ?, ?, 'claude', '/tmp', 'agent', 'running', 'waiting', datetime('now', '-120 seconds'), datetime('now', '-300 seconds'))\`).run(project, stuckPane, socket);\n` +

        `const watchId = db.prepare(\`INSERT INTO timers (project_id, owner, body, kind, watch_scope, deliver_actor, deliver_pane, max_wait_at, created_at)\n` +
        `  VALUES (?, 'lead:1', 'crew update', 'idle_any', 'project', 'agent:2', ?, datetime('now', '+4 hours'), datetime('now', '-60 seconds')) RETURNING id\`).get(project, tellPane).id;\n` +
        `const snapshot = { panes: new Set([stuckPane, tellPane]), windows: new Set() };\n` +

        `await tick(snapshot);\n` +
        `await tick(snapshot);\n` +
        `const notices = db.prepare("SELECT deliver_pane, deliver_actor, body FROM timers WHERE id != ? AND kind = 'delay'").all(watchId);\n` +
        `const claims = db.prepare("SELECT COUNT(*) AS n FROM wake_block_notices WHERE timer_id = ?").get(watchId).n;\n` +
        `const typed = db.prepare("SELECT typed_at FROM timers WHERE id != ? AND kind = 'delay' ORDER BY id LIMIT 1").get(watchId).typed_at;\n` +
        `process.stdout.write(JSON.stringify({ notices, claims, typed }));`,
      { HIVE_DATA_DIR: dataDir, TMUX_TMPDIR: process.env.TMUX_TMPDIR },
    );
    const screen = execFileSync("tmux", ["capture-pane", "-p", "-J", "-S", "-", "-t", tellPane], { encoding: "utf8" });
    for (const pane of [stuckPane, tellPane]) execFileSync("tmux", ["kill-pane", "-t", pane], { stdio: "ignore" });

    const about = out.notices.filter((n) => n.body.includes("stuck"));
    assert.equal(about.length, 1, `exactly one notice about the blocked worker: ${JSON.stringify(out.notices)}`);
    assert.equal(about[0].deliver_pane, tellPane, "filed at the LIVE delivery target, not the lead's dead pane");
    assert.equal(about[0].deliver_actor, "agent:2", "and as that actor: the pane and the actor come from one place");
    assert.equal(out.claims, 1, "and the episode is claimed exactly once");

    assert.ok(out.typed, "the notice must actually be typed, not merely filed");
    assert.match(screen, /hive wake #/, "and the marker must be on the delivery pane itself");
    assert.match(screen, /stuck/, "naming the crew member that needs a human");
  });
});

describe("a modal hold does not spend its claim on a dead lead pane", () => {
  it("stays silent while the owner's pane is dead, and tells it once the pane is live", { skip: hasTmux ? false : "no tmux" }, () => {
    const { dataDir, tmp } = scratchDirs();
    const spawnPane = (fixture) =>
      execFileSync("tmux", ["new-window", "-P", "-F", "#{pane_id}", "-t", sessionName(), replayFixture(fixture)], {
        encoding: "utf8",
      }).trim();
    const stuckPane = spawnPane("folder-trust-dialog.txt");
    const leadPane = spawnPane("ready-idle.txt");
    execFileSync("sh", ["-c", `for i in $(seq 1 60); do tmux capture-pane -p -t ${stuckPane} | grep -q 'I trust this folder' && exit 0; sleep 0.25; done; exit 1`]);

    const out = runFixture(
      tmp,
      "modal-hold-dead-owner",
      `const { db, migrate } = await import(${JSON.stringify(join(DIST, "db.js"))});\n` +
        `const { tick } = await import(${JSON.stringify(join(DIST, "scheduler.js"))});\n` +
        `const { tmuxSocketPath } = await import(${JSON.stringify(join(DIST, "tmux.js"))});\n` +
        `migrate();\n` +
        `const socket = tmuxSocketPath(process.env.TMUX, process.env.TMUX_TMPDIR);\n` +
        `const stuckPane = ${JSON.stringify(stuckPane)};\n` +
        `const leadPane = ${JSON.stringify(leadPane)};\n` +
        `const project = db.prepare("INSERT INTO projects (name, path) VALUES ('mh', '/tmp/mh') RETURNING id").get().id;\n` +
        `db.prepare(\`INSERT INTO agents (project_id, actor_id, name, tmux_target, tmux_socket, command, cwd, kind, status, created_at)\n` +
        `  VALUES (?, 'lead:1', 'lead', '%dead', ?, 'claude', '/tmp', 'lead', 'running', datetime('now', '-300 seconds'))\`).run(project, socket);\n` +
        `const stuckId = db.prepare(\`INSERT INTO agents (project_id, actor_id, name, tmux_target, tmux_socket, command, cwd, kind, status, agent_state, state_changed_at, created_at)\n` +
        `  VALUES (?, 'agent:2', 'stuck', ?, ?, 'claude', '/tmp', 'agent', 'running', 'waiting', datetime('now', '-120 seconds'), datetime('now', '-300 seconds')) RETURNING id\`).get(project, stuckPane, socket).id;\n` +

        `const wakeId = db.prepare(\`INSERT INTO timers (project_id, owner, body, kind, deliver_actor, deliver_pane, due_at, created_at)\n` +
        `  VALUES (?, 'lead:1', 'go on then', 'delay', 'agent:2', ?, datetime('now', '-5 seconds'), datetime('now', '-60 seconds')) RETURNING id\`).get(project, stuckPane).id;\n` +
        `const snapshot = { panes: new Set([stuckPane, leadPane]), windows: new Set() };\n` +
        `await tick(snapshot);\n` +
        `const dead = { notices: db.prepare("SELECT COUNT(*) AS n FROM timers WHERE id != ?").get(wakeId).n,\n` +
        `  claims: db.prepare("SELECT COUNT(*) AS n FROM wake_block_notices").get().n,\n` +
        `  held: db.prepare("SELECT held_reason FROM timers WHERE id = ?").get(wakeId).held_reason };\n` +

        `db.prepare("UPDATE agents SET tmux_target = ? WHERE actor_id = 'lead:1'").run(leadPane);\n` +
        `db.prepare("UPDATE timers SET held_at = NULL, held_reason = NULL WHERE id = ?").run(wakeId);\n` +
        `await tick(snapshot);\n` +
        `const alive = { notices: db.prepare("SELECT deliver_pane, body FROM timers WHERE id != ?").all(wakeId),\n` +
        `  claims: db.prepare("SELECT agent_id FROM wake_block_notices").all() };\n` +
        `process.stdout.write(JSON.stringify({ dead, alive, stuckId }));`,
      { HIVE_DATA_DIR: dataDir, TMUX_TMPDIR: process.env.TMUX_TMPDIR },
    );
    for (const pane of [stuckPane, leadPane]) execFileSync("tmux", ["kill-pane", "-t", pane], { stdio: "ignore" });

    assert.equal(out.dead.notices, 0, "no notice may be filed at a dead owner pane");
    assert.equal(out.dead.claims, 0, "and the block episode must NOT be claimed by a path that told nobody");
    assert.match(out.dead.held ?? "", /modal choice/, "the hold itself still happens, or this proves nothing");

    assert.equal(out.alive.notices.length, 1, "the returning lead must be told about the block it missed");
    assert.equal(out.alive.notices[0].deliver_pane, leadPane, "at its fresh pane");
    assert.deepEqual(
      out.alive.claims.map((c) => c.agent_id),
      [out.stuckId],
      "and the episode is claimed exactly once, now that someone has actually been told",
    );
  });
});
