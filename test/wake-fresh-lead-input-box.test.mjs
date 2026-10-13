import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { after, it } from "node:test";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { assertScratchStore, clearHiveEnv, isolateTmux, scratchDirs, until } from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("the fresh-lead wake input-box tests");
const { dataDir, projectDir, tmp } = scratchDirs();
clearHiveEnv();
process.env.HIVE_DATA_DIR = dataDir;
await assertScratchStore();

const { db, migrate } = await import("../dist/db.js");
const { tick } = await import("../dist/scheduler.js");
const { tmuxSocketPath } = await import("../dist/tmux.js");
migrate();

const socket = tmuxSocketPath(process.env.TMUX, process.env.TMUX_TMPDIR);
const session = `fresh-lead-${process.pid}`;
const received = join(tmp, "received.txt");
const dropped = join(tmp, "dropped.txt");
const ready = join(tmp, "ready.txt");
const fake = join(tmp, "claude");
writeFileSync(fake, [
  "#!/bin/bash",
  "sleep 2",
  `while read -t 0.1 -r line; do printf '%s\\n' "$line" >> '${dropped}'; done`,
  `cat '${join(process.cwd(), "test/fixtures/panes/ready-idle.txt")}'`,
  `touch '${ready}'`,
  `exec cat >> '${received}'`,
  "",
].join("\n"));
chmodSync(fake, 0o755);

const needsTmux = { skip: hasTmux ? false : "tmux is not installed" };
after(() => cleanup(session));

it(
  "a wake due when a fresh lead pane starts waits for the input box, not the pane",
  needsTmux,
  async () => {
    execFileSync("tmux", ["-S", socket, "new-session", "-d", "-s", session, "-x", "220", "-y", "50", "sleep", "600"]);
    const pane = execFileSync("tmux", ["-S", socket, "new-window", "-P", "-F", "#{pane_id}", "-t", `=${session}`, fake], {
      encoding: "utf8",
    }).trim();
    const panePid = execFileSync("tmux", ["-S", socket, "display-message", "-p", "-t", pane, "#{pane_pid}"], {
      encoding: "utf8",
    }).trim();
    const actorId = `lead:fresh-box-${process.pid}`;
    const projectId = db.prepare("INSERT INTO projects (name, path) VALUES (?, ?) RETURNING id")
      .get(`fresh-box-${process.pid}`, projectDir).id;
    db.prepare(
      `INSERT INTO agents (project_id, actor_id, name, tmux_target, tmux_socket, pane_pid, command, cwd, kind, status)
       VALUES (?, ?, 'lead', ?, ?, ?, 'claude', ?, 'lead', 'running')`,
    ).run(projectId, actorId, pane, socket, panePid, projectDir);
    db.prepare(
      `INSERT INTO agent_state_log (actor_id, event, state, payload)
       VALUES (?, 'session_start', 'unknown', ?)`,
    ).run(actorId, JSON.stringify({ source: "startup", session_id: `session-${process.pid}` }));
    const wakeId = db.prepare(
      `INSERT INTO wakes (project_id, owner, body, kind, watch, deliver_actor, deliver_pane, due_at)
       VALUES (?, ?, ?, 'delay', '[]', ?, ?, datetime('now', '-1 seconds')) RETURNING id`,
    ).get(projectId, actorId, "fresh lead box marker", actorId, pane).id;

    await tick();

    const held = db.prepare("SELECT held_at, held_reason, typed_at, typed_seen FROM wakes WHERE id = ?").get(wakeId);
    assert.ok(held.held_at, "the wake stays pending during the lead's input-box boot window");
    assert.match(held.held_reason, /input box is not on screen yet/i);
    assert.equal(held.typed_at, null, "a booting lead pane must not consume the wake");
    assert.equal(held.typed_seen, null, "the wake must not be recorded as typed into the booting pane");

    assert.ok(await until(() => existsSync(ready), 5000), "the fake lead eventually renders its input box");
    await tick();
    assert.ok(await until(() => readFileSync(received, "utf8").includes(`[hive wake #${wakeId}`), 5000));
    assert.match(db.prepare("SELECT typed_seen FROM wakes WHERE id = ?").get(wakeId).typed_seen, /box=empty/);
    assert.equal(existsSync(dropped) ? readFileSync(dropped, "utf8") : "", "", "nothing was typed before the box rendered");
  },
);
