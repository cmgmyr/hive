import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { assertScratchStore, isolateTmux, McpClient, scratchDirs } from "./helpers.mjs";

const { cleanup } = isolateTmux("wake clock tool tests");
const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const OWNER = "user:wake-clock-tools";
const TIME_ZONE = "America/New_York";
let db;
let mcp;
let projectId;

before(async () => {
  mcp = new McpClient({
    cwd: dirs.projectDir,
    dataDir: dirs.dataDir,
    env: { HIVE_AGENT_ID: OWNER, TMUX_PANE: "%wake-clock-test", TZ: TIME_ZONE },
  });
  await mcp.start();
  projectId = (await mcp.call("whoami")).project.id;
  ({ db } = await import("../dist/db.js"));
  await assertScratchStore();
});

after(async () => {
  await mcp.close();
  cleanup();
});

test("wake_set accepts clock schedules and read tools expose the captured zone", async () => {
  const oneShot = await mcp.call("wake_set", { at: "19:00", body: "one clock wake" });
  const daily = await mcp.call("wake_set", { at: "19:00", repeat: "daily", body: "daily clock wake" });

  for (const [receipt, repeat] of [[oneShot, null], [daily, "daily"]]) {
    assert.equal(receipt.repeating, repeat === "daily");
    const got = await mcp.call("wake_get", { wake_id: receipt.wake_id });
    assert.equal(got.at, "19:00");
    assert.equal(got.repeat, repeat);
    assert.equal(got.time_zone, TIME_ZONE);
    assert.equal(got.repeating, repeat === "daily");
    assert.equal(got.repeat_every_seconds, null);
    assert.match(got.due_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:00$/);
    assert.ok(Date.parse(`${got.due_at.replace(" ", "T")}Z`) > Date.now());
  }

  const list = await mcp.call("wake_list");
  const listed = list.wakes.find((wake) => wake.wake_id === daily.wake_id);
  assert.equal(listed.at, "19:00");
  assert.equal(listed.repeat, "daily");
  assert.equal(listed.time_zone, TIME_ZONE);
});

test("wake_set rejects invalid and mixed clock arguments before resolving delivery or inserting", async () => {
  const beforeCount = db.prepare("SELECT COUNT(*) AS n FROM wakes WHERE project_id = ?").get(projectId).n;
  const invalid = [
    [{ body: "missing timing" }, /exactly one/],
    [{ at: "19:00", delay_seconds: 60, body: "two modes" }, /exactly one/],
    [{ repeat: "daily", body: "repeat without clock" }, /exactly one/],
    [{ at: "not-a-time", body: "malformed", deliver_to: "missing-agent" }, /clock schedule/],
    [{ at: "19:00", repeat_every_seconds: 60, body: "mixed repeats" }, /cannot mix repeat_every_seconds/],
  ];
  for (const [args, message] of invalid) await assert.rejects(mcp.call("wake_set", args), message);
  const afterCount = db.prepare("SELECT COUNT(*) AS n FROM wakes WHERE project_id = ?").get(projectId).n;
  assert.equal(afterCount, beforeCount, "rejected clock arguments must not insert a wake");
});

test("wake_update keeps clock identity and zone while timing and repeat fields change independently", async () => {
  const created = await mcp.call("wake_set", { at: "19:00", body: "one-shot becomes daily" });
  const before = await mcp.call("wake_get", { wake_id: created.wake_id });

  const enabled = await mcp.call("wake_update", { wake_id: created.wake_id, repeat: "daily" });
  assert.equal(enabled.updated, true);
  assert.equal(enabled.due_at, before.due_at, "repeat-only edits leave due_at unchanged");
  let got = await mcp.call("wake_get", { wake_id: created.wake_id });
  assert.equal(got.wake_id, created.wake_id);
  assert.equal(got.at, "19:00");
  assert.equal(got.repeat, "daily");
  assert.equal(got.time_zone, TIME_ZONE);

  const retimed = await mcp.call("wake_update", { wake_id: created.wake_id, at: "20:00" });
  assert.equal(retimed.updated, true);
  assert.notEqual(retimed.due_at, enabled.due_at);
  got = await mcp.call("wake_get", { wake_id: created.wake_id });
  assert.equal(got.at, "20:00");
  assert.equal(got.repeat, "daily");
  assert.equal(got.time_zone, TIME_ZONE);

  const bodyOnly = await mcp.call("wake_update", { wake_id: created.wake_id, body: "body only" });
  assert.equal(bodyOnly.due_at, retimed.due_at);
  db.prepare("UPDATE wakes SET fired_at = datetime('now'), fire_count = 1 WHERE id = ?").run(created.wake_id);
  const afterFirstFire = await mcp.call("wake_update", { wake_id: created.wake_id, at: "21:00" });
  assert.equal(afterFirstFire.updated, true, "a fired daily wake remains editable");
  got = await mcp.call("wake_get", { wake_id: created.wake_id });
  assert.equal(got.wake_id, created.wake_id);
  assert.equal(got.at, "21:00");
  assert.equal(got.repeat, "daily");
  assert.equal(got.time_zone, TIME_ZONE);
  const listedAfterFire = await mcp.call("wake_list");
  const listedDaily = listedAfterFire.wakes.find((wake) => wake.wake_id === created.wake_id);
  assert.equal(listedDaily.at, "21:00");
  assert.equal(listedDaily.repeat, "daily");
  assert.equal(listedDaily.time_zone, TIME_ZONE);
  assert.equal(listedDaily.repeating, true);
});

test("wake_update rejects empty, mixed-mode and timing edits on legacy or idle wakes", async () => {
  const clock = await mcp.call("wake_set", { at: "19:00", body: "clock" });
  const interval = await mcp.call("wake_set", { delay_seconds: 3600, body: "interval" });
  const idle = db
    .prepare(
      `INSERT INTO wakes (project_id, owner, body, kind, watch, deliver_actor, deliver_pane, max_wait_at)
       VALUES (?, ?, 'idle', 'idle_any', '[]', ?, '%idle', datetime('now', '+1 hour')) RETURNING id`,
    )
    .get(projectId, OWNER, OWNER).id;

  await assert.rejects(mcp.call("wake_update", { wake_id: clock.wake_id }), /at least one/);
  await assert.rejects(mcp.call("wake_update", { wake_id: clock.wake_id, delay_seconds: 20 }), /clock-time wake/);
  await assert.rejects(mcp.call("wake_update", { wake_id: interval.wake_id, at: "20:00" }), /not a clock-time wake/);
  await assert.rejects(mcp.call("wake_update", { wake_id: interval.wake_id, repeat: "daily" }), /not a clock-time wake/);
  await assert.rejects(mcp.call("wake_update", { wake_id: clock.wake_id, at: "20:00", repeat_every_seconds: 30 }), /cannot mix/);
  await assert.rejects(mcp.call("wake_update", { wake_id: idle, at: "20:00" }), /idle_any/);
  const noZone = db.prepare("SELECT clock_at, clock_zone, clock_repeat, due_at FROM wakes WHERE id = ?").get(interval.wake_id);
  assert.deepEqual(noZone, { clock_at: null, clock_zone: null, clock_repeat: null, due_at: interval.due_at });
});

test("wake_update retains ownership and lifecycle refusals for clock schedules", async () => {
  const fired = await mcp.call("wake_set", { at: "19:00", body: "fired one-shot" });
  db.prepare("UPDATE wakes SET fired_at = datetime('now'), fire_count = 1 WHERE id = ?").run(fired.wake_id);
  assert.equal((await mcp.call("wake_update", { wake_id: fired.wake_id, at: "20:00" })).updated, false);

  const cancelled = await mcp.call("wake_set", { at: "19:00", body: "cancelled" });
  db.prepare("UPDATE wakes SET cancelled_at = datetime('now') WHERE id = ?").run(cancelled.wake_id);
  assert.equal((await mcp.call("wake_update", { wake_id: cancelled.wake_id, at: "20:00" })).updated, false);

  const foreign = await mcp.call("wake_set", { at: "19:00", body: "foreign" });
  db.prepare("UPDATE wakes SET owner = 'user:other-clock-owner' WHERE id = ?").run(foreign.wake_id);
  assert.equal((await mcp.call("wake_update", { wake_id: foreign.wake_id, at: "20:00" })).updated, false);

  const parent = await mcp.call("wake_set", { at: "19:00", body: "parent" });
  const child = await mcp.call("wake_set", { at: "19:00", body: "child" });
  db.prepare("UPDATE wakes SET parent_wake_id = ? WHERE id = ?").run(parent.wake_id, child.wake_id);
  assert.equal((await mcp.call("wake_update", { wake_id: child.wake_id, at: "20:00" })).updated, false);
});

test("clock input remains strict and legacy delay readback keeps its existing shape", async () => {
  await assert.rejects(
    mcp.call("wake_set", { at: "19:00", body: "caller zone", time_zone: TIME_ZONE }),
    /time_zone|Unrecognized key/,
  );
  const legacy = await mcp.call("wake_set", { delay_seconds: 120, repeat_every_seconds: 300, body: "legacy" });
  const got = await mcp.call("wake_get", { wake_id: legacy.wake_id });
  assert.equal(got.repeat_every_seconds, 300);
  assert.equal(got.repeating, true);
  assert.equal("at" in got, false);
  assert.equal("repeat" in got, false);
  assert.equal("time_zone" in got, false);
});
