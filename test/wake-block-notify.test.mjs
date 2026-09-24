import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isolateTmux, repaintPaneAsSameWorker, until } from "./helpers.mjs";
import { replayFixture, settleTicks, TICK_MS, wakeNotifyFixture } from "./wake-notify-fixture.mjs";

const { hasTmux, cleanup } = isolateTmux("the wake block-notification tests");

const fx = await wakeNotifyFixture({ hasTmux, cleanup });
const { db, spawnShowing, agentRow, noticesAbout, noticeCount, timerRow, ownedIdleWake, markWaiting } = fx;

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
        notices[0].parent_wake_id,
        wakeId,
        "parent-linked to the wake it reports on, so cancelling that wake cascades to this notice (todo 322)",
      );

      const original = timerRow(wakeId);
      assert.equal(original.fired_at, null, "the watched wake must not have fired");
      assert.equal(original.cancelled_at, null, "and must not have been cancelled");
      assert.equal(original.held_at, null, "and must not be reported as held: it was never due");
      assert.equal(original.held_reason, null, "nor carry a hold reason");

      const control = await fx.mcp.call("wake_set", {
        delay_seconds: 2,
        body: "INTEGRATION block-notify control wake",
        deliver_to: owner.agent_id,
      });
      await until(async () => timerRow(control.wake_id).typed_at != null, 15000);
      await settleTicks();
      assert.ok(timerRow(control.wake_id).typed_at, "the scheduler must have been ticking through that window");
      assert.equal(noticeCount(wakeId), 1, "one per block, not one per tick");

      await fx.restartServer();
      const handoverControl = await fx.mcp.call("wake_set", {
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
      await settleTicks();
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
      const wake = await fx.mcp.call("wake_when_idle", {
        agents: ["block-cancel-stuck"],
        body: "INTEGRATION block-cancel original body",
        deliver_to: owner.agent_id,
        max_wait_seconds: 900,
      });
      const wakeId = wake.wake_id;
      const setBy = timerRow(wakeId).owner;
      db.prepare("UPDATE wakes SET owner = ? WHERE id = ?").run(agentRow("block-cancel-owner").actor_id, wakeId);

      await until(async () => noticeCount(wakeId) > 0, 15000);
      const notice = noticesAbout(wakeId)[0];
      assert.equal(notice.parent_wake_id, wakeId, "filed with the parent link this lane adds");

      db.prepare("UPDATE wakes SET owner = ? WHERE id = ?").run(setBy, wakeId);
      const cancelResult = await fx.mcp.call("wake_cancel", { wake_id: wakeId });
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

      await until(async () => noticeCount(wakeId) > 0, 6 * TICK_MS);
      assert.equal(noticeCount(wakeId), 0, "a stale latch over a pane with no dialog must say nothing");
      assert.equal(timerRow(wakeId).fired_at, null, "and the wake keeps waiting for a real idle");
    });

    it("tells a rowless owner at the pane the wake itself resolved, and the owner's own pane when it has one", async () => {
      const teller = await spawnShowing("rowless-block-teller", replayFixture("ready-idle.txt"));
      const later = await spawnShowing("rowless-block-owner", replayFixture("ready-idle.txt"));
      const stuck = await spawnShowing("rowless-block-stuck", replayFixture("folder-trust-dialog.txt"));
      markWaiting("rowless-block-stuck", "2026-08-09 09:00:00");

      const wake = await fx.mcp.call("wake_when_idle", {
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

      db.prepare("UPDATE wakes SET owner = ? WHERE id = ?").run(agentRow("rowless-block-owner").actor_id, wakeId);
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
      const control = await fx.mcp.call("wake_set", {
        delay_seconds: 2,
        body: "INTEGRATION both-paths control wake",
        deliver_to: other.agent_id,
      });
      await until(async () => timerRow(control.wake_id).typed_at != null, 15000);
      await settleTicks();
      assert.ok(timerRow(control.wake_id).typed_at, "the scheduler must have been ticking through that window");
      assert.match(timerRow(wakeId).held_reason ?? "", /modal choice/, "the wake really did reach the held path");
      assert.equal(timerRow(wakeId).typed_at, null, "and was never typed into the dialog");
      assert.equal(noticeCount(wakeId), 1, "still one across later ticks");
    });
  },
);
