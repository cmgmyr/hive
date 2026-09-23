import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { DIST, isolateTmux, repaintPaneAsSameWorker, runFixture, scratchDirs, until } from "./helpers.mjs";
import { replayFixture, TICK_MS, wakeNotifyFixture } from "./wake-notify-fixture.mjs";

const { hasTmux, cleanup } = isolateTmux("the wake-hold notification tests");

const fx = await wakeNotifyFixture({ hasTmux, cleanup });
const { db, sessionName, spawnShowing, agentRow, noticesAbout, timerRow, ownedWake } = fx;

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
        notice.parent_wake_id,
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
        "one notification per hold condition: a per-tick version inserts one on every scheduler tick",
      );

      await fx.restartServer();
      assert.ok((await fx.mcp.call("whoami")).actor_id, "the replacement server must really be serving");
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

      await until(async () => noticesAbout(notice.id).length > 0, 6 * TICK_MS);
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
  \`INSERT INTO wakes (project_id, owner, body, kind, watch, deliver_actor, deliver_pane, due_at, created_at)
   VALUES (?, 'agent:9', 'wake body', 'delay', '[]', 'lead:1', '%dead', datetime('now', '-1 seconds'), datetime('now', '-60 seconds'))
   RETURNING id\`,
).get(project).id;
const snapshot = { panes: new Set(['%live']), windows: new Set() };
`;

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
        `const row = db.prepare("SELECT held_reason, fired_at FROM wakes WHERE id = ?").get(timerId);\n` +
        `const total = db.prepare("SELECT COUNT(*) AS n FROM wakes").get().n;\n` +
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
        `const watchId = db.prepare(\`INSERT INTO wakes (project_id, owner, body, kind, watch_scope, deliver_actor,\n` +
        `    deliver_pane, max_wait_at, created_at)\n` +
        `  VALUES (?, 'lead:1', 'crew update', 'idle_any', 'project', 'lead:1', '%dead',\n` +
        `    datetime('now', '+4 hours'), datetime('now', '-60 seconds')) RETURNING id\`).get(project).id;\n` +
        `const snapshot = { panes: new Set([pane]), windows: new Set() };\n` +
        `await tick(snapshot);\nawait tick(snapshot);\nawait tick(snapshot);\n` +
        `const notices = db.prepare("SELECT COUNT(*) AS n FROM wake_block_notices WHERE wake_id = ?").get(watchId).n;\n` +
        `process.stdout.write(JSON.stringify({ notices, watching: db.prepare("SELECT fired_at FROM wakes WHERE id = ?").get(watchId).fired_at }));`,
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

        `const watchId = db.prepare(\`INSERT INTO wakes (project_id, owner, body, kind, watch_scope, deliver_actor, deliver_pane, max_wait_at, created_at)\n` +
        `  VALUES (?, 'lead:1', 'crew update', 'idle_any', 'project', 'agent:2', ?, datetime('now', '+4 hours'), datetime('now', '-60 seconds')) RETURNING id\`).get(project, tellPane).id;\n` +
        `const snapshot = { panes: new Set([stuckPane, tellPane]), windows: new Set() };\n` +

        `await tick(snapshot);\n` +
        `await tick(snapshot);\n` +
        `const notices = db.prepare("SELECT deliver_pane, deliver_actor, body FROM wakes WHERE id != ? AND kind = 'delay'").all(watchId);\n` +
        `const claims = db.prepare("SELECT COUNT(*) AS n FROM wake_block_notices WHERE wake_id = ?").get(watchId).n;\n` +
        `const typed = db.prepare("SELECT typed_at FROM wakes WHERE id != ? AND kind = 'delay' ORDER BY id LIMIT 1").get(watchId).typed_at;\n` +
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

        `const wakeId = db.prepare(\`INSERT INTO wakes (project_id, owner, body, kind, deliver_actor, deliver_pane, due_at, created_at)\n` +
        `  VALUES (?, 'lead:1', 'go on then', 'delay', 'agent:2', ?, datetime('now', '-5 seconds'), datetime('now', '-60 seconds')) RETURNING id\`).get(project, stuckPane).id;\n` +
        `const snapshot = { panes: new Set([stuckPane, leadPane]), windows: new Set() };\n` +
        `await tick(snapshot);\n` +
        `const dead = { notices: db.prepare("SELECT COUNT(*) AS n FROM wakes WHERE id != ?").get(wakeId).n,\n` +
        `  claims: db.prepare("SELECT COUNT(*) AS n FROM wake_block_notices").get().n,\n` +
        `  held: db.prepare("SELECT held_reason FROM wakes WHERE id = ?").get(wakeId).held_reason };\n` +

        `db.prepare("UPDATE agents SET tmux_target = ? WHERE actor_id = 'lead:1'").run(leadPane);\n` +
        `db.prepare("UPDATE wakes SET held_at = NULL, held_reason = NULL WHERE id = ?").run(wakeId);\n` +
        `await tick(snapshot);\n` +
        `const alive = { notices: db.prepare("SELECT deliver_pane, body FROM wakes WHERE id != ?").all(wakeId),\n` +
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
