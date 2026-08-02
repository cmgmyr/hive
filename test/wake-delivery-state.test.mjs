import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import {
  insertStateLogRow,
  isolateTmux,
  liveAgentRow,
  makeFakeClaude,
  McpClient,
  REPO,
  scratchDirs,
  until,
  wakeConfirmPayload,
} from "./helpers.mjs";

// Issue #27, L3 step 4. This is runbook step 11 from plan-l3-delivery-states:
// set a real wake against a real pane, hold it behind a real dialog, clear
// the dialog, and read wake_list (the actual MCP tool, through a real
// running server on its own natural scheduler tick, not tick() called
// in-process) at each stage. Unit tests elsewhere pin the timers-table
// writes; nothing else exercises the OUTPUT this lane exists to make
// legible - the distinctions a lead actually reads.
//
// Issue #75 added a fifth: unconfirmed_busy, alongside confirmed, plain
// unconfirmed, no_confirmation_channel, and the null (nothing typed yet)
// case. One test below seeds typed_busy directly to pin the reporting
// layer's own NULL/0/1 boundary in isolation; a second, added in counselors
// round 1 (todo 209, item E3), drives a real wake_set through this file's
// real running server and its own natural scheduler tick against two real
// spawned targets - the lane's actual claim, busy vs idle reporting
// differently, THROUGH THE REAL PATH, not asserted only against a hand-set
// column.

const { hasTmux, cleanup } = isolateTmux("the wake-delivery-state tests");

const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { sessionName } = await import("../dist/tmux.js");
const { db } = await import("../dist/db.js");

const FIXTURES = join(REPO, "test", "fixtures", "panes");
const fixturePath = (file) => join(FIXTURES, file);
const replayFixture = (file) => `cat '${fixturePath(file)}'; sleep 600`;

let mcp;
let projectId;

before(async () => {
  mcp = new McpClient({ cwd: dirs.projectDir, dataDir: dirs.dataDir, env: { HIVE_SPAWN_READY_MS: "2000" } });
  await mcp.start();
  projectId = (await mcp.call("whoami")).project.id;
  if (!hasTmux) return;
  execFileSync("tmux", [
    "new-session", "-d", "-s", sessionName(projectId), "-x", "220", "-y", "50", "-c", dirs.projectDir,
  ]);
});

after(async () => {
  await mcp.close();
  cleanup(sessionName(projectId));
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

const findWake = (wakes, wakeId) => wakes.find((w) => w.wake_id === wakeId);

describe(
  "wake_list reports the delivery states a lead actually reads",
  { skip: hasTmux ? false : "tmux is not installed" },
  () => {
    it("held with a reason while pending, then typed and unconfirmed once the dialog clears", async () => {
      const spawned = await spawnShowing("wake-state-worker", replayFixture("folder-trust-dialog.txt"));

      const wake = await mcp.call("wake_set", {
        delay_seconds: 1,
        body: "INTEGRATION wake state check",
        deliver_to: spawned.agent_id,
      });

      // Held: the dialog fixture is up, the scheduler's own tick sees it and
      // records the hold, and this wake must still be in the PENDING list -
      // never claimed, never gone - with the reason legible.
      let held;
      await until(async () => {
        const list = await mcp.call("wake_list");
        held = findWake(list.wakes, wake.wake_id);
        return held?.held_at != null;
      }, 10000);
      assert.ok(held, "the wake must still be in the pending list while held");
      assert.ok(held.held_reason, "and the reason must be legible, not just that it is held");
      assert.equal(held.typed_at, null, "nothing has been typed yet");
      assert.equal(held.confirmation, null, "no confirmation question applies before anything is typed");
      const listWhileHeld = await mcp.call("wake_list");
      assert.equal(
        findWake(listWhileHeld.recently_delivered, wake.wake_id),
        undefined,
        "a held wake has not fired; it must not appear as delivered",
      );

      // Clear the dialog by replacing what the pane is running, same pane id
      // (tmux wipes the screen on respawn) - the state change under test.
      execFileSync("tmux", ["respawn-pane", "-k", "-t", spawned.tmux_target, "sleep 600"], {
        stdio: "ignore",
      });

      // Typed and unconfirmed: delivered now, gone from the pending list (a
      // one-shot wake leaves it the moment it fires - ACTIVE_TIMER_WHERE),
      // present in recently_delivered with typed_at set. This fakeClaude
      // never runs a real hook, so it can never submit a UserPromptSubmit -
      // confirmation must read "unconfirmed", not silently absent.
      //
      // Waits for typed_at specifically, not just presence in
      // recently_delivered: fired_at (the claim) and typed_at (the attempt)
      // are set by two separate writes roughly ENTER_DELAY_MS apart
      // (src/tmux.ts's sendText sleeps between the paste and the Enter), so
      // there is a real, legitimate window where a fired wake is already
      // visible here with typed_at still null. Stopping at "just visible"
      // makes this test race that window instead of testing the state it
      // actually settles into.
      let delivered;
      await until(async () => {
        const list = await mcp.call("wake_list");
        delivered = findWake(list.recently_delivered, wake.wake_id);
        return delivered?.typed_at != null;
      }, 10000);
      assert.ok(delivered.typed_at, "typed_at must be set once delivery actually happened");
      assert.equal(delivered.held_at, null, "a resolved hold must stop being reported as current");
      assert.equal(
        delivered.confirmation,
        "unconfirmed",
        "a target with a confirmation channel (it was spawned, so it has an agents row) that has not submitted a prompt must read unconfirmed, not confirmed and not silently absent",
      );
      const listAfterDelivery = await mcp.call("wake_list");
      assert.equal(
        findWake(listAfterDelivery.wakes, wake.wake_id),
        undefined,
        "a delivered one-shot wake must leave the pending list",
      );

      // Confirmed: write the hook row this fixture never generates, by hand,
      // at or after typed_at, carrying THIS wake's own `[hive wake #<id>] `
      // marker (counselors A1) - the exact shape a real UserPromptSubmit hook
      // invocation writes when it is genuinely the wake's own paste that got
      // submitted. The scheduler's OWN next tick must pick it up on its own,
      // through checkConfirmations(), not because this test called anything
      // about confirmation directly.
      insertStateLogRow(db, spawned.actor_id, "prompt", "working", 0, wakeConfirmPayload(wake.wake_id));

      await until(async () => {
        const list = await mcp.call("wake_list");
        const row = findWake(list.recently_delivered, wake.wake_id);
        return row?.confirmation === "confirmed";
      }, 10000);
      const confirmedList = await mcp.call("wake_list");
      const confirmed = findWake(confirmedList.recently_delivered, wake.wake_id);
      assert.ok(confirmed.confirmed_at, "confirmed_at must carry the timestamp, not just the status");
    });

    it("distinguishes no-confirmation-channel from unconfirmed, and a never-typed claim from either", async () => {
      // Seeded directly: no L4 yet means the lead writes no agents row at
      // all, and there is no way to make a fixture do that through the
      // normal spawn path - a spawned worker always gets one.
      const ghostActor = "user:ghost-lead-no-channel";
      const noChannelId = db
        .prepare(
          `INSERT INTO timers (project_id, owner, body, kind, watch, deliver_actor, deliver_pane,
             due_at, created_at, fired_at, typed_at)
           VALUES (?, 'user:test', 'no channel wake', 'delay', '[]', ?, '%ghost',
             datetime('now', '-30 seconds'), datetime('now', '-60 seconds'),
             datetime('now', '-20 seconds'), strftime('%Y-%m-%d %H:%M:%f', 'now', '-20 seconds'))
           RETURNING id`,
        )
        .get(projectId, ghostActor).id;

      // Claimed but never typed: sendText itself never returned - the defect
      // #27 exists to make legible in the first place. Must read as neither
      // confirmed nor unconfirmed; forcing it into that pair would hide the
      // more urgent fact that nothing was ever typed at all.
      const neverTypedId = db
        .prepare(
          `INSERT INTO timers (project_id, owner, body, kind, watch, deliver_actor, deliver_pane,
             due_at, created_at, fired_at)
           VALUES (?, 'user:test', 'never typed wake', 'delay', '[]', 'user:test', '%nowhere',
             datetime('now', '-30 seconds'), datetime('now', '-60 seconds'), datetime('now', '-20 seconds'))
           RETURNING id`,
        )
        .get(projectId).id;

      const list = await mcp.call("wake_list");
      const noChannel = findWake(list.recently_delivered, noChannelId);
      const neverTyped = findWake(list.recently_delivered, neverTypedId);

      assert.ok(noChannel, "a fired, typed wake for an actor with no agents row must still be reported");
      assert.equal(
        noChannel.confirmation,
        "no_confirmation_channel",
        "an actor that has never had a confirmation channel must read distinctly from merely unconfirmed",
      );

      assert.ok(neverTyped, "a claimed-but-never-typed wake must still be reported, not dropped");
      assert.equal(neverTyped.typed_at, null);
      assert.equal(
        neverTyped.confirmation,
        null,
        "no confirmation state applies when nothing was ever typed - not unconfirmed, not no_confirmation_channel",
      );
    });

    // Issue #75. Reporting-layer half of the busy/idle distinction; the
    // scheduler's own write of typed_busy is exercised in
    // test/delivery-state.test.mjs's tick()-driven tests. This seeds the
    // column directly and checks only what wake_list derives from it, which
    // is what deliveryState() (src/tools/wakes.ts) actually reads. Each
    // target needs a real agents row - unlike the no-channel case above,
    // this is about the channel EXISTING but the delivery landing mid-turn.
    it("reports unconfirmed_busy only when typed_busy = 1, never for 0 or NULL", async () => {
      const seedAgent = (actor) =>
        db
          .prepare(
            `INSERT INTO agents (project_id, actor_id, name, command, cwd)
             VALUES (?, ?, ?, 'claude', '/tmp')`,
          )
          .run(projectId, actor, actor);
      const seedTimer = (actor, typedBusy) =>
        db
          .prepare(
            `INSERT INTO timers (project_id, owner, body, kind, watch, deliver_actor, deliver_pane,
               due_at, created_at, fired_at, typed_at, typed_busy)
             VALUES (?, 'user:test', 'busy report wake', 'delay', '[]', ?, '%busy-report',
               datetime('now', '-30 seconds'), datetime('now', '-60 seconds'),
               datetime('now', '-20 seconds'), strftime('%Y-%m-%d %H:%M:%f', 'now', '-20 seconds'), ?)
             RETURNING id`,
          )
          .get(projectId, actor, typedBusy).id;

      seedAgent("agent:busy-report-working");
      seedAgent("agent:busy-report-idle");
      seedAgent("agent:busy-report-unknown");
      const busyId = seedTimer("agent:busy-report-working", 1);
      const idleId = seedTimer("agent:busy-report-idle", 0);
      const unknownId = seedTimer("agent:busy-report-unknown", null);

      const list = await mcp.call("wake_list");
      const busy = findWake(list.recently_delivered, busyId);
      const idle = findWake(list.recently_delivered, idleId);
      const unknown = findWake(list.recently_delivered, unknownId);

      assert.ok(busy, "the busy-delivered wake must still be reported");
      assert.equal(
        busy.confirmation,
        "unconfirmed_busy",
        "typed_busy = 1 must read distinctly from a plain 'unconfirmed' - it says the target's last recorded " +
          "state at typing time was mid-turn, not that an ack was impossible",
      );

      assert.ok(idle, "the idle-delivered wake must still be reported");
      assert.equal(
        idle.confirmation,
        "unconfirmed",
        "typed_busy = 0 (observed idle) must stay the real alarm, not be folded into unconfirmed_busy",
      );

      assert.ok(unknown, "the never-instrumented wake must still be reported");
      assert.equal(
        unknown.confirmation,
        "unconfirmed",
        "typed_busy = NULL (no hook row to ask, e.g. a pre-#75 row) must report exactly as it always did - " +
          "no behaviour change for history",
      );
    });

    // Counselors round 1 (todo 209, item E3). The lane's central claim - a
    // wake typed at a busy target reports differently from one typed at an
    // idle target - was previously only hand-seeded at this reporting layer
    // (the test above) or tick()-driven against a bare actor string with no
    // real agent (test/delivery-state.test.mjs). Neither drove a real wake
    // through the actual wake_set -> real running server's own scheduler
    // tick -> wake_list path against a real spawned target. This does, for
    // both targets in the same test, so a constant confirmation value cannot
    // pass it. fakeClaude never runs a real hook, so each target's log is
    // primed by hand the same way a real turn's hook invocation would leave
    // it - the same technique the busy/idle table in delivery-state.test.mjs
    // uses, just driven through wake_set/wake_list instead of tick()
    // directly.
    it("drives a real busy delivery and a real idle delivery through wake_set/wake_list, and they report differently", async () => {
      const busyWorker = await spawnShowing("busy-real-worker", "sleep 600");
      insertStateLogRow(db, busyWorker.actor_id, "prompt", "working", 0);
      const busyWake = await mcp.call("wake_set", {
        delay_seconds: 1,
        body: "E2E busy wake",
        deliver_to: busyWorker.agent_id,
      });

      const idleWorker = await spawnShowing("idle-real-worker", "sleep 600");
      insertStateLogRow(db, idleWorker.actor_id, "stop", "idle", 0);
      const idleWake = await mcp.call("wake_set", {
        delay_seconds: 1,
        body: "E2E idle wake",
        deliver_to: idleWorker.agent_id,
      });

      let busyRow;
      await until(async () => {
        const list = await mcp.call("wake_list");
        busyRow = findWake(list.recently_delivered, busyWake.wake_id);
        return busyRow?.typed_at != null;
      }, 15000);
      let idleRow;
      await until(async () => {
        const list = await mcp.call("wake_list");
        idleRow = findWake(list.recently_delivered, idleWake.wake_id);
        return idleRow?.typed_at != null;
      }, 15000);

      assert.equal(
        busyRow.confirmation,
        "unconfirmed_busy",
        "a wake delivered through the real scheduler tick, into a target whose last real hook row was " +
          "working, must report unconfirmed_busy",
      );
      assert.equal(
        idleRow.confirmation,
        "unconfirmed",
        "the identical real delivery path, into a target whose last real hook row was idle, must report plain unconfirmed",
      );
      assert.notEqual(
        busyRow.confirmation,
        idleRow.confirmation,
        "this is the lane's whole claim: busy and idle deliveries through the real path must report differently",
      );
    });

    // Counselors A6. Past the same retention window checkConfirmations()
    // (src/scheduler.ts) uses, a typed one-shot's confirmed_at can never
    // change again - hive has structurally stopped looking - so reporting it
    // as "unconfirmed", the identical string used for a wake typed seconds
    // ago that hive is actively still watching, is the exact ambiguity the
    // tri-state exists to remove, reappearing on a case nobody enumerated.
    it("excludes a one-shot fired past the retention window from recently_delivered", async () => {
      const staleId = db
        .prepare(
          `INSERT INTO timers (project_id, owner, body, kind, watch, deliver_actor, deliver_pane,
             due_at, created_at, fired_at, typed_at)
           VALUES (?, 'user:test', 'ancient wake', 'delay', '[]', 'user:test', '%ancient',
             datetime('now', '-8 days'), datetime('now', '-8 days'),
             datetime('now', '-8 days'), strftime('%Y-%m-%d %H:%M:%f', 'now', '-8 days'))
           RETURNING id`,
        )
        .get(projectId).id;

      const list = await mcp.call("wake_list");
      assert.equal(
        findWake(list.recently_delivered, staleId),
        undefined,
        "a one-shot fired past the retention window must not appear as merely 'unconfirmed' - " +
          "hive can never look again, so the section must drop it rather than misreport it",
      );
    });

    // Counselors A7. fired_at is whole-second, and a single tick fires every
    // due timer in one loop, so several wakes sharing one fired_at is
    // ordinary. ORDER BY fired_at DESC alone carries no stability guarantee
    // for equal keys - id DESC is a real tiebreaker, not decoration.
    it("breaks ties on a shared fired_at deterministically by id, most recent first", async () => {
      const sharedFiredAt = db.prepare("SELECT datetime('now') AS v").get().v;
      const ids = [];
      for (let i = 0; i < 3; i++) {
        ids.push(
          db
            .prepare(
              `INSERT INTO timers (project_id, owner, body, kind, watch, deliver_actor, deliver_pane,
                 due_at, created_at, fired_at, typed_at)
               VALUES (?, 'user:test', ?, 'delay', '[]', 'user:test', '%burst',
                 ?, ?, ?, strftime('%Y-%m-%d %H:%M:%f', 'now'))
               RETURNING id`,
            )
            .get(projectId, `burst ${i}`, sharedFiredAt, sharedFiredAt, sharedFiredAt).id,
        );
      }

      const list = await mcp.call("wake_list");
      const burstOrder = list.recently_delivered
        .filter((w) => ids.includes(w.wake_id))
        .map((w) => w.wake_id);

      assert.deepEqual(
        burstOrder,
        [...ids].reverse(),
        "wakes sharing one fired_at must still order deterministically, highest id (most recently claimed) first",
      );
    });
  },
);
