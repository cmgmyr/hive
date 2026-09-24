import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { after, before } from "node:test";

import { REPO, liveAgentRow, makeFakeClaude, McpClient, scratchDirs } from "./helpers.mjs";

export const TICK_MS = 500;
const SERVER_ENV = { HIVE_SPAWN_READY_MS: "2000", HIVE_SCHEDULER_INTERVAL_MS: String(TICK_MS) };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const settleTicks = () => sleep(3 * TICK_MS);

const FIXTURES = join(REPO, "test", "fixtures", "panes");
const fixturePath = (file) => join(FIXTURES, file);
export const replayFixture = (file) => `cat '${fixturePath(file)}'; sleep 600`;

// Call after isolateTmux(): the store and tmux module are chosen here, before anything spawns.
export async function wakeNotifyFixture({ hasTmux, cleanup }) {
  const dirs = scratchDirs();
  process.env.HIVE_DATA_DIR = dirs.dataDir;
  const { sessionName } = await import("../dist/tmux.js");
  const { db } = await import("../dist/db.js");

  const fx = { dirs, db, sessionName, mcp: null };
  const startServer = async () => {
    fx.mcp = new McpClient({ cwd: dirs.projectDir, dataDir: dirs.dataDir, env: SERVER_ENV });
    await fx.mcp.start();
  };
  fx.restartServer = async () => {
    await fx.mcp.close();
    await startServer();
  };

  before(async () => {
    await startServer();
    if (!hasTmux) return;
    execFileSync("tmux", [
      "new-session", "-d", "-s", sessionName(), "-x", "220", "-y", "50", "-c", dirs.projectDir,
    ]);
  });

  after(async () => {
    await fx.mcp.close();
    cleanup(sessionName());
  });

  const fakeClaude = makeFakeClaude(dirs.tmp);

  fx.spawnShowing = async (name, shellCommand) => {
    const receipt = await fx.mcp.call("agent_spawn", {
      name,
      command: fakeClaude(shellCommand),
      extra_args: [],
      placement: "window",
    });
    await liveAgentRow(fx.mcp, name);
    return receipt;
  };

  fx.agentRow = (name) => db.prepare("SELECT id, actor_id, tmux_target FROM agents WHERE name = ?").get(name);

  fx.noticesAbout = (wakeId) =>
    db
      .prepare("SELECT * FROM wakes WHERE id != ? AND body LIKE ? ORDER BY id")
      .all(wakeId, `%wake #${wakeId} %`);

  fx.noticeCount = (wakeId) => fx.noticesAbout(wakeId).length;

  fx.timerRow = (id) => db.prepare("SELECT * FROM wakes WHERE id = ?").get(id);

  fx.ownedWake = async (ownerName, targetAgentId, body) => {
    const wake = await fx.mcp.call("wake_set", { delay_seconds: 5, body, deliver_to: targetAgentId });
    db.prepare("UPDATE wakes SET owner = ? WHERE id = ?").run(fx.agentRow(ownerName).actor_id, wake.wake_id);
    return wake.wake_id;
  };

  fx.ownedIdleWake = async (ownerName, watchNames, deliverToAgentId, body) => {
    const wake = await fx.mcp.call("wake_when_idle", {
      agents: watchNames,
      body,
      deliver_to: deliverToAgentId,
      max_wait_seconds: 900,
    });
    db.prepare("UPDATE wakes SET owner = ? WHERE id = ?").run(fx.agentRow(ownerName).actor_id, wake.wake_id);
    return wake.wake_id;
  };

  fx.ownedStandingWatch = async (ownerName, deliverToAgentId, body) => {
    const watch = await fx.mcp.call("wake_when_idle", {
      scope: "project",
      body,
      deliver_to: deliverToAgentId,
      max_wait_seconds: 900,
    });
    const setBy = fx.timerRow(watch.wake_id).owner;
    db.prepare("UPDATE wakes SET owner = ? WHERE id = ?").run(fx.agentRow(ownerName).actor_id, watch.wake_id);
    return { watchId: watch.wake_id, setBy };
  };

  fx.markWaiting = (name, since) => {
    db.prepare("UPDATE agents SET agent_state = 'waiting', state_changed_at = ? WHERE name = ?").run(since, name);
  };

  return fx;
}
