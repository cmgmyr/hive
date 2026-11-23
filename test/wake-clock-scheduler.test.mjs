import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import {
  isolateTmux,
  liveAgentRow,
  makeFakeClaude,
  McpClient,
  raceProcesses,
  REPO,
  scratchDirs,
  until,
} from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("wake clock scheduler tests");
const NEEDS_TMUX = { skip: hasTmux ? false : "tmux is not installed" };
const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { db } = await import("../dist/db.js");
const { sessionName } = await import("../dist/tmux.js");
const { tick } = await import("../dist/scheduler.js");
const { renderDashboard } = await import("../dist/dashboard.js");

const TIME_ZONE = "America/New_York";
const CLOCK_AT = "19:00";
const READY_IDLE = join(REPO, "test", "fixtures", "panes", "ready-idle.txt");
const SINK = join(dirs.tmp, "wake-clock-sink.log");
const OWNER = "user:wake-clock-scheduler";
const serverEnv = {
  HIVE_AGENT_ID: OWNER,
  HIVE_SPAWN_READY_MS: "2000",
  HIVE_SCHEDULER_INTERVAL_MS: "60000",
  TZ: TIME_ZONE,
};

let first;
let second;
let projectId;
let workerId;

before(async () => {
  first = new McpClient({ cwd: dirs.projectDir, dataDir: dirs.dataDir, env: serverEnv });
  second = new McpClient({ cwd: dirs.projectDir, dataDir: dirs.dataDir, env: serverEnv });
  await first.start();
  await second.start();
  projectId = (await first.call("whoami")).project.id;
  if (hasTmux) {
    execFileSync("tmux", ["new-session", "-d", "-s", sessionName(), "-x", "220", "-y", "50", "-c", dirs.projectDir]);
  }
});

after(async () => {
  await first.close();
  await second.close();
  cleanup(sessionName());
});

const fakeClaude = makeFakeClaude(dirs.tmp);

async function ensureWorker() {
  if (workerId !== undefined) return workerId;
  writeFileSync(SINK, "");
  const spawned = await first.call("agent_spawn", {
    name: "wake-clock-worker",
    command: fakeClaude(`cat '${READY_IDLE}'; cat >> '${SINK}'`),
    extra_args: [],
    placement: "window",
  });
  workerId = spawned.agent_id;
  await liveAgentRow(first, "wake-clock-worker");
  return workerId;
}

async function dailyWake(body) {
  return first.call("wake_set", {
    at: CLOCK_AT,
    repeat: "daily",
    body,
    deliver_to: await ensureWorker(),
  });
}

function makeDue(id, secondsAgo = 1) {
  db.prepare("UPDATE wakes SET due_at = datetime('now', ?) WHERE id = ?").run(`-${secondsAgo} seconds`, id);
}

function localClock(dueAt, zone) {
  const due = new Date(`${dueAt.replace(" ", "T")}Z`);
  return Object.fromEntries(
    new Intl.DateTimeFormat("en-US-u-ca-iso8601-nu-latn", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(due)
      .map(({ type, value }) => [type, value]),
  );
}

function shQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

describe("daily clock wake scheduling", { skip: hasTmux ? false : "tmux is not installed" }, () => {
  it("reschedules a late firing from the persisted local rule and stays active in wake_list", NEEDS_TMUX, async () => {
    const body = "CLOCK-LATE-ONCE";
    writeFileSync(SINK, "");
    const { wake_id: id } = await dailyWake(body);
    db.prepare("UPDATE wakes SET due_at = datetime('now', '-1 day') WHERE id = ?").run(id);

    await tick();
    await until(() => readFileSync(SINK, "utf8").includes(body), 5000);
    await new Promise((resolve) => setTimeout(resolve, 350));

    const row = db.prepare("SELECT * FROM wakes WHERE id = ?").get(id);
    assert.equal(row.fire_count, 1);
    assert.ok(row.fired_at);
    assert.ok(Date.parse(`${row.due_at.replace(" ", "T")}Z`) > Date.now());
    assert.deepEqual(
      (({ hour, minute, second }) => ({ hour, minute, second }))(localClock(row.due_at, TIME_ZONE)),
      { hour: "19", minute: "00", second: "00" },
    );
    assert.equal(readFileSync(SINK, "utf8").split(body).length - 1, 1);

    const listed = await first.call("wake_list");
    const wake = listed.wakes.find((candidate) => candidate.wake_id === id);
    assert.equal(wake.at, CLOCK_AT);
    assert.equal(wake.repeat, "daily");
    assert.equal(wake.time_zone, TIME_ZONE);
    assert.equal(wake.repeating, true);
    const dashboardWake = renderDashboard(projectId).split('<li class="wake">').find((html) => html.includes(body));
    assert.ok(dashboardWake, "the active daily wake must remain in the dashboard after its first firing");
    assert.match(dashboardWake, /\(repeats\)/, "the existing repeats label must remain on a daily clock wake");

    await tick();
    await new Promise((resolve) => setTimeout(resolve, 350));
    assert.equal(db.prepare("SELECT fire_count FROM wakes WHERE id = ?").get(id).fire_count, 1);
    assert.equal(readFileSync(SINK, "utf8").split(body).length - 1, 1);
    db.prepare("UPDATE wakes SET cancelled_at = datetime('now') WHERE id = ?").run(id);
  });

  it("two scheduler processes claim one due daily firing in UTC while preserving the creator's zone", NEEDS_TMUX, async () => {
    const body = "CLOCK-CROSS-TZ-RACE";
    writeFileSync(SINK, "");
    const { wake_id: id } = await dailyWake(body);
    makeDue(id);
    const schedulerPath = join(REPO, "dist", "scheduler.js");
    const source = `
      import { tick } from ${JSON.stringify(schedulerPath)};
      await tick();
      process.stdout.write(JSON.stringify({ zone: Intl.DateTimeFormat().resolvedOptions().timeZone }));
    `;
    const results = await raceProcesses(source, [[], []], {
      env: { HIVE_DATA_DIR: dirs.dataDir, HIVE_SCHEDULER_INTERVAL_MS: "60000", TZ: "UTC" },
    });
    assert.deepEqual(results.map((result) => result.zone), ["UTC", "UTC"]);
    await until(() => readFileSync(SINK, "utf8").includes(body), 5000);
    await new Promise((resolve) => setTimeout(resolve, 350));

    const row = db.prepare("SELECT * FROM wakes WHERE id = ?").get(id);
    assert.equal(row.clock_zone, TIME_ZONE);
    assert.equal(row.fire_count, 1, "the two claimers must advance one firing total");
    assert.ok(row.fired_at);
    assert.ok(Date.parse(`${row.due_at.replace(" ", "T")}Z`) > Date.now());
    assert.deepEqual(
      (({ hour, minute, second }) => ({ hour, minute, second }))(localClock(row.due_at, TIME_ZONE)),
      { hour: "19", minute: "00", second: "00" },
    );
    assert.equal(readFileSync(SINK, "utf8").split(body).length - 1, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM leases WHERE lock_key LIKE 'wake-pane:%'").get().n, 0);
    db.prepare("UPDATE wakes SET cancelled_at = datetime('now') WHERE id = ?").run(id);
  });

  it("a stale one-shot claim loses when a captured clock rule changes before its CAS", NEEDS_TMUX, async () => {
    const body = "CLOCK-EDIT-INTERLEAVING";
    writeFileSync(SINK, "");
    const { wake_id: id } = await first.call("wake_set", {
      at: CLOCK_AT,
      body,
      deliver_to: await ensureWorker(),
    });
    makeDue(id);

    const realTmux = execFileSync("which", ["tmux"], { encoding: "utf8" }).trim();
    const shimDir = join(dirs.tmp, "clock-edit-tmux");
    const marker = join(dirs.tmp, "clock-edit-fired");
    const shim = join(shimDir, "tmux");
    const update = `import Database from "better-sqlite3"; const db = new Database(${JSON.stringify(db.name)}); db.prepare("UPDATE wakes SET clock_repeat = 'daily' WHERE id = ?").run(${id}); db.close();`;
    mkdirSync(shimDir, { recursive: true });
    writeFileSync(
      shim,
      `#!/bin/sh\ncase " $* " in\n  *" capture-pane "*) if [ ! -f ${shQuote(marker)} ]; then : > ${shQuote(marker)}; ${shQuote(process.execPath)} --input-type=module -e ${shQuote(update)}; fi ;;\nesac\nexec ${shQuote(realTmux)} "$@"\n`,
    );
    chmodSync(shim, 0o755);

    const savedPath = process.env.PATH;
    try {
      process.env.PATH = `${shimDir}:${savedPath}`;
      await tick();
    } finally {
      process.env.PATH = savedPath;
    }

    assert.equal(existsSync(marker), true, "the fake tmux must edit the row during pane capture");
    let row = db.prepare("SELECT * FROM wakes WHERE id = ?").get(id);
    assert.equal(row.clock_repeat, "daily");
    assert.equal(row.fired_at, null, "the one-shot claim captured before the edit must lose its CAS");
    assert.equal(row.fire_count, 0);
    assert.equal(readFileSync(SINK, "utf8").includes(body), false);

    await tick();
    await until(() => readFileSync(SINK, "utf8").includes(body), 5000);
    row = db.prepare("SELECT * FROM wakes WHERE id = ?").get(id);
    assert.equal(row.fire_count, 1, "the next tick must claim the newly daily rule");
    assert.equal(localClock(row.due_at, TIME_ZONE).hour, "19");
    db.prepare("UPDATE wakes SET cancelled_at = datetime('now') WHERE id = ?").run(id);
  });

  it("holds malformed clock rows without delivering or starving a later valid wake", NEEDS_TMUX, async () => {
    const body = "CLOCK-AFTER-INVALID";
    writeFileSync(SINK, "");
    const target = await ensureWorker();
    const worker = db.prepare("SELECT actor_id, tmux_target FROM agents WHERE id = ?").get(target);
    const row = db.prepare(
      `INSERT INTO wakes (project_id, owner, body, kind, watch, deliver_actor, deliver_pane, due_at,
                          clock_at, clock_zone, clock_repeat)
       VALUES (?, ?, ?, 'delay', '[]', ?, ?, datetime('now', '-1 seconds'), ?, ?, 'daily') RETURNING id`,
    );
    const invalidAt = row.get(projectId, OWNER, "INVALID-CLOCK-AT", worker.actor_id, worker.tmux_target, "25:00", TIME_ZONE).id;
    const invalidZone = row.get(projectId, OWNER, "INVALID-CLOCK-ZONE", worker.actor_id, worker.tmux_target, CLOCK_AT, "Not/AZone").id;
    const valid = await dailyWake(body);
    makeDue(valid.wake_id);

    await tick();
    await until(() => readFileSync(SINK, "utf8").includes(body), 5000);
    const bad = db.prepare("SELECT fired_at, fire_count, held_reason FROM wakes WHERE id IN (?, ?) ORDER BY id").all(invalidAt, invalidZone);
    assert.deepEqual(bad, [
      { fired_at: null, fire_count: 0, held_reason: "invalid clock schedule" },
      { fired_at: null, fire_count: 0, held_reason: "invalid clock schedule" },
    ]);
    assert.equal(readFileSync(SINK, "utf8").includes("INVALID-CLOCK-AT"), false);
    assert.equal(readFileSync(SINK, "utf8").includes("INVALID-CLOCK-ZONE"), false);
    assert.equal(db.prepare("SELECT fire_count FROM wakes WHERE id = ?").get(valid.wake_id).fire_count, 1);
    for (const id of [invalidAt, invalidZone, valid.wake_id]) {
      db.prepare("UPDATE wakes SET cancelled_at = datetime('now') WHERE id = ?").run(id);
    }
  });
});
