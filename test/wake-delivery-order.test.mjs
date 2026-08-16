import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { after, before, describe, it } from "node:test";

import { isolateTmux, makeFakeClaude, McpClient, scratchDirs, until } from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("resolveDelivery's ORDER BY (todo 274)");

const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { db } = await import("../dist/db.js");
const { sessionName } = await import("../dist/tmux.js");

const capture = (target) => execFileSync("tmux", ["capture-pane", "-p", "-t", target]).toString();

describe(
  "resolveDelivery's own-session lookup",
  { skip: hasTmux ? false : "tmux is not installed" },
  () => {
    let mcp;

    const actorId = "user:wake-order-test";

    before(async () => {
      execFileSync("tmux", [
        "new-session", "-d", "-s", sessionName(), "-x", "220", "-y", "50", "-c", dirs.projectDir,
      ]);
      mcp = new McpClient({ cwd: dirs.projectDir, dataDir: dirs.dataDir, env: { HIVE_AGENT_ID: actorId } });
      await mcp.start();
    });

    after(async () => {
      await mcp.close();
      cleanup(sessionName());
    });

    it("targets the newer row's live pane, not an older dead row sharing the same actor_id", async () => {
      const projectId = (await mcp.call("whoami")).project.id;

      db.prepare(
        `INSERT INTO agents (project_id, actor_id, name, tmux_target, command, cwd, kind, status)
         VALUES (?, ?, 'wake-order-dead', '%99999', 'claude', ?, 'agent', 'running')`,
      ).run(projectId, actorId, dirs.projectDir);

      const fakeClaude = makeFakeClaude(dirs.tmp);
      const pane = execFileSync("tmux", [
        "new-window", "-P", "-F", "#{pane_id}", "-t", `=${sessionName()}`, "-c", dirs.projectDir,
        fakeClaude("sleep 600"),
      ]).toString().trim();
      db.prepare(
        `INSERT INTO agents (project_id, actor_id, name, tmux_target, command, cwd, kind, status)
         VALUES (?, ?, 'wake-order-live', ?, 'claude', ?, 'agent', 'running')`,
      ).run(projectId, actorId, pane, dirs.projectDir);

      const wake = await mcp.call("wake_set", { delay_seconds: 1, body: "WAKE-ORDER marker" });

      const recorded = db.prepare("SELECT deliver_pane FROM timers WHERE id = ?").get(wake.wake_id);
      assert.equal(
        recorded.deliver_pane,
        pane,
        "must target the newer (higher id) row's live pane, not the older dead row sharing this actor_id",
      );

      const delivered = await until(() => capture(pane).includes("WAKE-ORDER marker"), 15000);
      assert.ok(delivered, "the wake must actually be typed into the correct pane, not just recorded there");
    });
  },
);
