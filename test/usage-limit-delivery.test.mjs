import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { REPO, clearHiveEnv, isolateTmux, scratchDirs } from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("usage-limit delivery from synthetic findings-limit-fork-spike records");
const dirs = scratchDirs();
clearHiveEnv();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { db, migrate } = await import("../dist/db.js");
const { tick } = await import("../dist/scheduler.js");
const { sendQuietLeadMessage } = await import("../dist/leadMessageDelivery.js");
const { tmuxSocketPath } = await import("../dist/tmux.js");
migrate();

const projectDir = join(dirs.projectDir, "delivery");
mkdirSync(projectDir, { recursive: true });
const projectId = db.prepare("INSERT INTO projects (name, path) VALUES ('usage-limit-delivery', ?) RETURNING id").get(projectDir).id;
const socket = tmuxSocketPath(process.env.TMUX, process.env.TMUX_TMPDIR);
const sessions = [];
const panes = [];
after(() => cleanup(...sessions));

function liveRow(kind, name, fixture = "ready-idle.txt", recordedPid = null) {
  const session = `usage-limit-${process.pid}-${name}`;
  const sink = join(dirs.tmp, `${name}.sink`);
  const sourcePane = join(REPO, "test", "fixtures", "panes", fixture);
  writeFileSync(sink, "");
  execFileSync("tmux", ["new-session", "-d", "-s", session, "-x", "220", "-y", "50", `cat '${sourcePane}'; cat > '${sink}'`], { stdio: "ignore" });
  sessions.push(session);
  const [pane, panePid] = execFileSync("tmux", ["list-panes", "-t", `=${session}`, "-F", "#{pane_id}\t#{pane_pid}"], { encoding: "utf8" }).trim().split("\t");
  panes.push({ pane, sink });
  const actor = `${kind}:${name}`;
  const id = db.prepare(`INSERT INTO agents
    (project_id, actor_id, name, kind, tmux_target, tmux_socket, pane_pid, command, cwd, status, session_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'claude', ?, 'running', ?) RETURNING id`)
    .get(projectId, actor, name, kind, pane, socket, recordedPid ?? panePid, projectDir, `synthetic-${name}-session`).id;
  return db.prepare("SELECT * FROM agents WHERE id = ?").get(id);
}

function activeEpisode(target) {
  db.prepare(`INSERT INTO agent_usage_limits
    (agent_id, project_id, harness, pane_pid, session_id, signal_key, observed_at, reset_at, expires_at)
    VALUES (?, ?, 'claude', ?, ?, ?, datetime('now'), NULL, datetime('now', '+5 hours'))`)
    .run(target.id, projectId, target.pane_pid, target.session_id, `synthetic-spike-A1-A2-${target.name}`);
}

function dueWake(target, body) {
  return db.prepare(`INSERT INTO wakes (project_id, owner, body, kind, deliver_actor, deliver_pane, due_at)
    VALUES (?, 'agent:sender', ?, 'delay', ?, ?, datetime('now', '-1 second')) RETURNING id`)
    .get(projectId, body, target.actor_id, target.tmux_target).id;
}

describe("held delivery from synthetic findings-limit-fork-spike A1-A2 evidence", { skip: hasTmux ? false : "tmux is not installed" }, () => {
  it("R3 keeps due wakes, submitted messages, quiet socket sends and pane fallbacks pending until release", async () => {
    const worker = liveRow("agent", "held-worker");
    activeEpisode(worker);
    const oldWake = dueWake(worker, "LIMIT-WAKE-OLD");
    const newWake = dueWake(worker, "LIMIT-WAKE-NEW");
    const { sendUsageHeldMessage } = await import("../dist/leadMessageDelivery.js");
    const oldMessage = await sendUsageHeldMessage({ projectId, fromActor: "agent:sender", target: worker, text: "LIMIT-MESSAGE-OLD", submit: true });
    const newMessage = await sendUsageHeldMessage({ projectId, fromActor: "agent:sender", target: worker, text: "LIMIT-MESSAGE-NEW", submit: true });
    assert.equal(oldMessage.pending, true);
    assert.equal(newMessage.pending, true);

    await tick();

    const wakesHeld = db.prepare("SELECT fired_at, fire_count, held_reason FROM wakes WHERE id IN (?, ?) ORDER BY id").all(oldWake, newWake);
    assert.deepEqual(wakesHeld.map(({ fired_at, fire_count }) => [fired_at, fire_count]), [[null, 0], [null, 0]]);
    assert.ok(wakesHeld.every((row) => /usage limit.*until/.test(row.held_reason)), JSON.stringify(wakesHeld));
    assert.deepEqual(db.prepare("SELECT typed_at, fallback_claimed_at, delivery_status FROM agent_messages ORDER BY id").all()
      .map(({ typed_at, fallback_claimed_at, delivery_status }) => [typed_at, fallback_claimed_at, delivery_status]),
    [[null, null, "fallback-pending"], [null, null, "fallback-pending"]]);
    assert.equal(readFileSync(panes.find((pane) => pane.pane === worker.tmux_target).sink, "utf8"), "");

    const lead = liveRow("lead", "held-lead");
    db.prepare("INSERT INTO lead_turn_state (agent_id, pane_pid, session_id, transcript_path) VALUES (?, ?, ?, '')")
      .run(lead.id, lead.pane_pid, lead.session_id);
    activeEpisode(lead);
    const quietReceipt = await sendQuietLeadMessage({ projectId, fromActor: "agent:sender", target: lead, text: "LIMIT-SOCKET-HELD", submit: true });
    assert.equal(quietReceipt.sent, false);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM agent_messages WHERE text = 'LIMIT-SOCKET-HELD' AND delivery_method = 'socket'").get().n, 0);

    db.prepare("UPDATE agent_usage_limits SET released_at = datetime('now') WHERE project_id = ? AND released_at IS NULL").run(projectId);
    await tick();
    await tick();
    const delivered = readFileSync(panes.find((pane) => pane.pane === worker.tmux_target).sink, "utf8");
    assert.ok(delivered.includes("LIMIT-WAKE-OLD"));
    assert.ok(delivered.indexOf("LIMIT-WAKE-OLD") < delivered.indexOf("LIMIT-WAKE-NEW"));
    assert.ok(delivered.indexOf("LIMIT-MESSAGE-OLD") < delivered.indexOf("LIMIT-MESSAGE-NEW"));
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM wakes WHERE id IN (?, ?) AND fired_at IS NOT NULL").get(oldWake, newWake).n, 2);
  });

  it("R6 retains pane, copy-mode, dialog, input and unreadable-screen guards after release", async () => {
    const modal = liveRow("agent", "modal-after-limit", "folder-trust-dialog.txt");
    const input = liveRow("agent", "input-after-limit", "real-input.txt");
    const copy = liveRow("agent", "copy-after-limit");
    const reissued = liveRow("agent", "reissued-after-limit", "ready-idle.txt", "wrong-recorded-pid");
    const unreadable = liveRow("agent", "unreadable-after-limit");
    const targets = [modal, input, copy, reissued, unreadable];
    const wakes = targets.map((target) => dueWake(target, `LIMIT-GUARD-${target.name}`));
    targets.forEach(activeEpisode);
    await tick();
    const { paneClassifierFor } = await import("../dist/harnesses.js");
    assert.equal(paneClassifierFor("claude").choiceCheck(modal.tmux_target).awaitingChoice, true);
    assert.equal(paneClassifierFor("claude").inputBoxState(input.tmux_target)?.state, "pending");
    db.prepare(`UPDATE agent_usage_limits SET released_at = datetime('now') WHERE agent_id IN (${targets.map(() => "?").join(",")})`)
      .run(...targets.map((target) => target.id));
    execFileSync("tmux", ["copy-mode", "-t", copy.tmux_target], { stdio: "ignore" });

    const realTmux = execFileSync("which", ["tmux"], { encoding: "utf8" }).trim();
    const wrapperDir = join(dirs.tmp, "unreadable-tmux-wrapper");
    const wrapper = join(wrapperDir, "tmux");
    mkdirSync(wrapperDir, { recursive: true });
    writeFileSync(wrapper, `#!/bin/sh\nif [ "$1" = "capture-pane" ]; then case " $* " in *" ${unreadable.tmux_target} "*) exit 1;; esac; fi\nexec '${realTmux}' "$@"\n`);
    chmodSync(wrapper, 0o755);
    const oldPath = process.env.PATH;
    process.env.PATH = `${wrapperDir}:${oldPath}`;
    try {
      await tick();
    } finally {
      process.env.PATH = oldPath;
    }

    const remaining = db.prepare(`SELECT id, fire_count, held_reason FROM wakes WHERE id IN (${wakes.map(() => "?").join(",")}) ORDER BY id`)
      .all(...wakes);
    assert.ok(remaining.every((row) => row.fire_count === 0), JSON.stringify(remaining));
    assert.match(remaining[0].held_reason, /choice/);
    assert.match(remaining[1].held_reason, /input box/);
    assert.match(remaining[2].held_reason, /copy mode/);
    assert.match(remaining[3].held_reason, /reissuing|reissued/);
    assert.match(remaining[4].held_reason, /dialog state is unknown/);
  });

  it("fires a repeating wake after one hour of persistently unreadable pane capture", async () => {
    const unreadable = liveRow("agent", "unreadable-expired");
    activeEpisode(unreadable);
    db.prepare("UPDATE agent_usage_limits SET released_at = datetime('now') WHERE agent_id = ?").run(unreadable.id);
    const wakeId = dueWake(unreadable, "UNREADABLE-EXPIRES");
    db.prepare("UPDATE wakes SET repeat_every_ms = 86400000 WHERE id = ?").run(wakeId);
    const realTmux = execFileSync("which", ["tmux"], { encoding: "utf8" }).trim();
    const wrapperDir = join(dirs.tmp, "unreadable-expiry-tmux-wrapper");
    const wrapper = join(wrapperDir, "tmux");
    mkdirSync(wrapperDir, { recursive: true });
    writeFileSync(wrapper, `#!/bin/sh\nif [ "$1" = "capture-pane" ]; then case " $* " in *" ${unreadable.tmux_target} "*) exit 1;; esac; fi\nexec '${realTmux}' "$@"\n`);
    chmodSync(wrapper, 0o755);
    const oldPath = process.env.PATH;
    process.env.PATH = `${wrapperDir}:${oldPath}`;
    try {
      await tick();
      const held = db.prepare("SELECT cancelled_at, fire_count, held_reason FROM wakes WHERE id = ?").get(wakeId);
      assert.equal(held.cancelled_at, null);
      assert.equal(held.fire_count, 0);
      assert.match(held.held_reason, /dialog state is unknown/);

      db.prepare("UPDATE wakes SET first_held_at = datetime('now', '-2 hours') WHERE id = ?").run(wakeId);
      await tick();
    } finally {
      process.env.PATH = oldPath;
    }

    const released = db.prepare("SELECT cancelled_at, fired_at, fire_count, held_at, held_reason, typed_seen FROM wakes WHERE id = ?").get(wakeId);
    assert.equal(released.cancelled_at, null, "the cap must not silently cancel a repeating wake");
    assert.ok(released.fired_at, "the held firing must proceed through normal delivery after the cap");
    assert.equal(released.fire_count, 1);
    assert.equal(released.held_at, null);
    assert.match(released.typed_seen, /released after unreadable-capture hold/);
    assert.ok(readFileSync(panes.find((pane) => pane.pane === unreadable.tmux_target).sink, "utf8").includes("UNREADABLE-EXPIRES"));
  });

  it("does not hold unreadable capture for an unreleased episode expired over an hour ago", async () => {
    const unreadable = liveRow("agent", "unreadable-old-episode");
    activeEpisode(unreadable);
    db.prepare("UPDATE agent_usage_limits SET expires_at = datetime('now', '-2 hours') WHERE agent_id = ?").run(unreadable.id);
    const wakeId = dueWake(unreadable, "UNREADABLE-OLD-EPISODE");
    const realTmux = execFileSync("which", ["tmux"], { encoding: "utf8" }).trim();
    const wrapperDir = join(dirs.tmp, "unreadable-old-episode-tmux-wrapper");
    const wrapper = join(wrapperDir, "tmux");
    mkdirSync(wrapperDir, { recursive: true });
    writeFileSync(wrapper, `#!/bin/sh\nif [ "$1" = "capture-pane" ]; then case " $* " in *" ${unreadable.tmux_target} "*) exit 1;; esac; fi\nexec '${realTmux}' "$@"\n`);
    chmodSync(wrapper, 0o755);
    const oldPath = process.env.PATH;
    process.env.PATH = `${wrapperDir}:${oldPath}`;
    try {
      await tick();
    } finally {
      process.env.PATH = oldPath;
    }

    const wake = db.prepare("SELECT fire_count, held_reason, fired_at FROM wakes WHERE id = ?").get(wakeId);
    assert.equal(wake.fire_count, 1);
    assert.equal(wake.held_reason, null);
    assert.ok(wake.fired_at);
    assert.ok(readFileSync(panes.find((pane) => pane.pane === unreadable.tmux_target).sink, "utf8").includes("UNREADABLE-OLD-EPISODE"));
  });
});
