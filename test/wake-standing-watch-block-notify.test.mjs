import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { describe, it } from "node:test";

import { isolateTmux, until } from "./helpers.mjs";
import { replayFixture, settleTicks, wakeNotifyFixture } from "./wake-notify-fixture.mjs";

const { hasTmux, cleanup } = isolateTmux("the standing-watch block-notification tests");

const fx = await wakeNotifyFixture({ hasTmux, cleanup });
const { db, spawnShowing, agentRow, timerRow, ownedStandingWatch, markWaiting } = fx;

describe(
  "a standing watch tells its owner when a crew member is stopped on a dialog",
  { skip: hasTmux ? false : "tmux is not installed" },
  () => {

    const cancelWatch = async (watchId, originalOwner) => {
      db.prepare("UPDATE wakes SET owner = ? WHERE id = ?").run(originalOwner, watchId);
      await fx.mcp.call("wake_cancel", { wake_id: watchId });
      assert.ok(timerRow(watchId).cancelled_at, "the watch must really be cancelled, or it outlives its own test");
    };

    const readCall = (name) => `agent_output(name: "${name}")`;

    const onScreen = (pane, text) =>
      execFileSync("tmux", ["capture-pane", "-p", "-J", "-t", pane], { encoding: "utf8" }).includes(text);
    const TRUST_DIALOG = "Yes, I trust this folder";
    const blockNoticesNaming = (name) =>
      db
        .prepare("SELECT * FROM wakes WHERE parent_wake_id IS NULL AND kind = 'delay' AND body LIKE ? ORDER BY id")
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
      assert.equal(filed[0].parent_wake_id, null, "left unparented on purpose: it may still be true after a cancel");

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

      const control = await fx.mcp.call("wake_set", {
        delay_seconds: 2,
        body: "INTEGRATION standing-block control wake",
        deliver_to: owner.agent_id,
      });
      await until(async () => timerRow(control.wake_id).typed_at != null, 15000);
      await settleTicks();
      assert.ok(timerRow(control.wake_id).typed_at, "the scheduler must have been ticking through that window");
      assert.equal(blockNoticesNaming("standing-block-stuck").length, 1, "one per block, not one per tick");

      assert.equal(
        db.prepare("SELECT COUNT(*) AS n FROM wake_block_notices WHERE wake_id = ? AND agent_id = ?").get(
          watchId,
          agentRow("standing-block-stuck").id,
        ).n,
        1,
        "and the claim lives in wake_block_notices, which the finish half never touches",
      );
      assert.equal(
        db.prepare("SELECT COUNT(*) AS n FROM wake_idle_notices WHERE wake_id = ? AND agent_id = ?").get(
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
        db.prepare("SELECT created_at > (SELECT created_at FROM wakes WHERE id = ?) AS after FROM agents WHERE id = ?")
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
          .prepare("SELECT id FROM wakes WHERE parent_wake_id IS NULL AND kind = 'delay' AND body LIKE ?")
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
          .prepare("SELECT COUNT(*) AS n FROM wake_block_notices WHERE wake_id = ? AND agent_id IN (?, ?)")
          .get(watchId, agentRow("batch-block-one").id, agentRow('batch"two').id).n,
        2,
        "two blocks, two claim rows, one notice",
      );
      await cancelWatch(watchId, setBy);
    });
  },
);
