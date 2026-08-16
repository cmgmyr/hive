import assert from "node:assert/strict";
import { dirname } from "node:path";
import { after, describe, it } from "node:test";

import { isolateTmux, leadRow, makeFakeClaude, McpClient, runCli, scratchDirs, tmux, windowOwners } from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("the worker-first window stamp test");

const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { db, migrate } = await import("../dist/db.js");
const { sessionName } = await import("../dist/tmux.js");
migrate();

function stampOf(target) {
  try {
    return tmux("show-options", "-w", "-v", "-t", target, "@hive-project-id");
  } catch {
    return "";
  }
}

describe(
  "a placement=\"window\" worker spawned before any `hive lead` never stamps its own window",
  { skip: hasTmux ? false : "tmux is not installed" },
  () => {
    const fakeClaude = makeFakeClaude(dirs.tmp);
    const project = db
      .prepare("INSERT INTO projects (name, path) VALUES (?, ?) RETURNING id")
      .get("window-first-project", dirs.projectDir);
    const session = sessionName();
    let mcp;

    after(async () => {
      if (mcp) await mcp.close();
      cleanup(session);
    });

    it("does not stamp the worker's own window, so a later `hive lead` gets ITS OWN window rather than landing in the worker's", async () => {
      mcp = new McpClient({ cwd: dirs.projectDir, dataDir: dirs.dataDir, env: { HIVE_SPAWN_READY_MS: "500" } });
      await mcp.start();
      const spawned = await mcp.call("agent_spawn", {
        name: "first-worker",
        command: fakeClaude("sleep 600"),
        extra_args: [],
        placement: "window",
      });

      const workerWindow = tmux("list-panes", "-t", spawned.tmux_target, "-F", "#{window_id}").trim().split("\n")[0];
      assert.equal(
        stampOf(workerWindow),
        "",
        "a worker's own dedicated window (placement=\"window\") must not carry the project's ownership stamp",
      );

      const claude = fakeClaude("sleep 600");
      const led = await runCli(["lead"], {
        cwd: dirs.projectDir,
        dataDir: dirs.dataDir,
        tmp: dirs.tmp,
        env: { PATH: `${dirname(claude)}:${process.env.PATH}` },
      });
      assert.equal(led.code, 0, led.stderr);

      const row = leadRow(db, project.id);
      const leadPanesInWorkerWindow = tmux("list-panes", "-t", workerWindow, "-F", "#{pane_id}").split("\n");
      assert.ok(
        !leadPanesInWorkerWindow.includes(row.tmux_target),
        "the lead must not land inside the worker's private window",
      );

      const owners = windowOwners(session);
      const leadWindow = owners.find(([, id]) => id === String(project.id))?.[0];
      assert.ok(leadWindow, `expected a window stamped for project ${project.id}, got: ${JSON.stringify(owners)}`);
      assert.notEqual(leadWindow, workerWindow, "the lead's stamped window must be a DIFFERENT window from the worker's");
    });
  },
);
