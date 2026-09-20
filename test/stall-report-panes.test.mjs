import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import {
  REPO,
  isolateTmux,
  liveAgentRow,
  makeFakeClaude,
  McpClient,
  repaintPaneAsSameWorker,
  scratchDirs,
  until,
} from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("the stall report pane tests");

const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;

const configDir = join(dirs.tmp, "claude-config");
process.env.CLAUDE_CONFIG_DIR = configDir;

const { sessionName } = await import("../dist/tmux.js");
const { db } = await import("../dist/db.js");

const FIXTURES = join(REPO, "test", "fixtures", "panes");
const replayFixture = (file) => `cat '${join(FIXTURES, file)}'; sleep 600`;

let mcp;

before(async () => {
  mcp = new McpClient({
    cwd: dirs.projectDir,
    dataDir: dirs.dataDir,
    env: { HIVE_SPAWN_READY_MS: "2000", CLAUDE_CONFIG_DIR: configDir },
  });
  await mcp.start();
  if (!hasTmux) return;
  execFileSync("tmux", ["new-session", "-d", "-s", sessionName(), "-x", "220", "-y", "50", "-c", dirs.projectDir]);

  await spawnShowing("stall-watcher", "sleep 600");
  await spawnShowing("stall-stuck", replayFixture("ready-idle.txt"));
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

const agentRow = (name) =>
  db.prepare("SELECT id, actor_id, tmux_target, cwd FROM agents WHERE name = ?").get(name);

function markWaiting(name, since) {
  db.prepare("UPDATE agents SET agent_state = 'waiting', state_changed_at = ?, session_id = ? WHERE name = ?").run(
    since,
    `sid-${name}`,
    name,
  );
}

function writeTranscript(cwd, sessionId, ageSeconds) {
  const dir = join(configDir, "projects", cwd.replace(/[/.]/g, "-"));
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${sessionId}.jsonl`);
  writeFileSync(path, '{"type":"assistant"}\n');
  const when = (Date.now() - ageSeconds * 1000) / 1000;
  utimesSync(path, when, when);
}

async function watchOwnedBy(name) {
  const watch = await mcp.call("wake_when_idle", {
    scope: "project",
    body: "crew update",
    deliver_to: agentRow(name).id,
    max_wait_seconds: 900,
  });
  db.prepare("UPDATE wakes SET owner = ? WHERE id = ?").run(agentRow(name).actor_id, watch.wake_id);
  return watch.wake_id;
}

const stallNotices = (watchId) =>
  db.prepare("SELECT id, body FROM wakes WHERE parent_wake_id = ? ORDER BY id").all(watchId);
const stallCursor = (watchId) =>
  db
    .prepare("SELECT agent_id, episode FROM wake_idle_notices WHERE wake_id = ? AND condition = 'stall'")
    .all(watchId);
const blockCursor = (watchId) =>
  db.prepare("SELECT agent_id, blocked_since FROM wake_block_notices WHERE wake_id = ?").all(watchId);
const blockNotices = (watchId) =>
  db
    .prepare("SELECT id, body FROM wakes WHERE parent_wake_id IS NULL AND body LIKE ? ORDER BY id")
    .all(`%watch #${watchId}%`);

const STALE_SECONDS = 30 * 60;

function freshCase(episode, fixture) {
  db.prepare("UPDATE agents SET agent_state = 'unknown', state_changed_at = NULL WHERE kind = 'agent'").run();
  db.prepare(
    "UPDATE wakes SET cancelled_at = datetime('now') WHERE cancelled_at IS NULL AND watch_scope IS NOT NULL",
  ).run();
  const row = agentRow("stall-stuck");
  repaintPaneAsSameWorker(db, row.tmux_target, replayFixture(fixture));
  markWaiting("stall-stuck", episode);
  writeTranscript(row.cwd, "sid-stall-stuck", STALE_SECONDS);
  return agentRow("stall-stuck");
}

describe("arm 2: a `waiting` worker whose pane shows no dialog", { skip: hasTmux ? false : "no tmux" }, () => {

  it("is reported when its transcript has gone quiet past the bound", async () => {
    const row = freshCase("2020-01-01 00:00:00", "ready-idle.txt");
    const watchId = await watchOwnedBy("stall-watcher");

    assert.ok(
      await until(() => stallNotices(watchId).length > 0, 30000),
      "no stall notice was filed within 30s - the scheduler ticks every 3s, so this is a stalled tick, not a count",
    );

    const filed = stallNotices(watchId);
    assert.equal(filed.length, 1, "one stall notice for the one stalled crew member");
    assert.match(filed[0].body, /stall-stuck: has claimed `waiting`/);
    assert.match(
      filed[0].body,
      /its pane shows no dialog/,
      "arm 2's sentence must say what it actually checked, or the body mis-describes its own evidence",
    );
    assert.match(filed[0].body, /transcript has not been written for/);
    assert.equal(stallCursor(watchId).length, 1, "and the episode was claimed once");
    assert.equal(stallCursor(watchId)[0].agent_id, row.id);

  });

  it("says nothing while a dialog really is up, and leaves that to the block report", async () => {
    freshCase("2020-01-02 00:00:00", "folder-trust-dialog.txt");
    const watchId = await watchOwnedBy("stall-watcher");

    assert.ok(
      await until(() => blockNotices(watchId).length > 0, 30000),
      "the block half never spoke, so this case cannot say anything about what the stall half did",
    );

    await new Promise((r) => setTimeout(r, 5000));

    assert.equal(stallNotices(watchId).length, 0, "a dialogged pane is not a stall, whatever the transcript says");
    assert.equal(stallCursor(watchId).length, 0, "and no stall episode was claimed");
    assert.equal(blockNotices(watchId).length, 1, "the block half said the true thing, once");
  });

  it("stays quiet about an episode the block half has already spoken about", async () => {
    const row = freshCase("2020-01-03 00:00:00", "folder-trust-dialog.txt");
    const watchId = await watchOwnedBy("stall-watcher");

    assert.ok(
      await until(() => blockNotices(watchId).length > 0, 30000),
      "the block half never spoke, so there is no prior claim for arm 2 to lose against",
    );
    assert.equal(blockCursor(watchId).length, 1, "the block half claimed the episode first");

    repaintPaneAsSameWorker(db, row.tmux_target, replayFixture("ready-idle.txt"));
    await new Promise((r) => setTimeout(r, 6000));

    assert.equal(
      stallNotices(watchId).length,
      0,
      "one episode, one report: arm 2 must lose the block key rather than contradict it",
    );
    assert.equal(stallCursor(watchId).length, 0);
    assert.equal(blockNotices(watchId).length, 1, "and the block half still spoke exactly once");
  });
});
