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
  repaintPaneAsSameWorker,
  scratchDirs,
  until,
  wakeConfirmPayload,
} from "./helpers.mjs";

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

      repaintPaneAsSameWorker(db, spawned.tmux_target, "sleep 600");

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

    it("holds behind an ordinary tool-permission prompt and never types into it (todo 392)", async () => {
      const spawned = await spawnShowing("wake-state-permission-prompt", replayFixture("tool-permission-prompt.txt"));

      const wake = await mcp.call("wake_set", {
        delay_seconds: 1,
        body: "INTEGRATION wake state check, permission prompt",
        deliver_to: spawned.agent_id,
      });

      let held;
      await until(async () => {
        const list = await mcp.call("wake_list");
        held = findWake(list.wakes, wake.wake_id);
        return held?.held_at != null;
      }, 10000);
      assert.ok(held, "the wake must still be in the pending list while held");
      assert.match(held.held_reason, /modal choice/, "held for the dialog, not some other reason");
      assert.equal(held.typed_at, null, "nothing typed while the prompt is up");

      const heldAtFirst = held.held_at;
      await until(async () => {
        const list = await mcp.call("wake_list");
        held = findWake(list.wakes, wake.wake_id);
        return held?.held_at > heldAtFirst;
      }, 12000);
      assert.ok(held.held_at > heldAtFirst, "the scheduler must have re-held this wake on a later tick");
      assert.equal(held.typed_at, null, "still nothing typed: the dialog was never answered");
      const stillPending = await mcp.call("wake_list");
      assert.equal(
        findWake(stillPending.recently_delivered, wake.wake_id),
        undefined,
        "a held wake has not fired; it must not appear as delivered",
      );
    });

    it("distinguishes no-confirmation-channel from unconfirmed, and a never-typed claim from either", async () => {

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
