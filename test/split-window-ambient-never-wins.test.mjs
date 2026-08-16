import assert from "node:assert/strict";
import { dirname } from "node:path";
import { after, before, describe, it } from "node:test";

import { isolateTmux, leadRow, makeFakeClaude, McpClient, panesIn, runCli, scratchDirs, tmux, windowFor } from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("the ambient-never-wins test");

const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { db, migrate } = await import("../dist/db.js");
const { sessionName } = await import("../dist/tmux.js");
migrate();

describe(
  "a caller with a real, live, ambient TMUX_PANE in a DIFFERENT window - but no agents row of its own - still lands in the project's stamped window",
  { skip: hasTmux ? false : "tmux is not installed" },
  () => {
    const fakeClaude = makeFakeClaude(dirs.tmp);
    const project = db
      .prepare("INSERT INTO projects (name, path) VALUES (?, ?) RETURNING id")
      .get("ambient-never-wins-project", dirs.projectDir);
    const session = sessionName();
    const mcpClients = [];

    after(async () => {
      for (const mcp of mcpClients) await mcp.close();
      cleanup(session);
    });

    it("resolves no parent (no agents row for a plain user:<name> caller) and falls back to the project's stamped window, ignoring a live ambient TMUX_PANE elsewhere", async () => {
      const claude = fakeClaude("sleep 600");
      const led = await runCli(["lead"], {
        cwd: dirs.projectDir,
        dataDir: dirs.dataDir,
        tmp: dirs.tmp,
        env: { PATH: `${dirname(claude)}:${process.env.PATH}` },
      });
      assert.equal(led.code, 0, led.stderr);

      const row = leadRow(db, project.id);
      const windowProject = windowFor(session, project.id);

      const mcpLead = new McpClient({
        cwd: dirs.projectDir,
        dataDir: dirs.dataDir,
        env: { HIVE_AGENT_ID: row.actor_id, HIVE_SPAWN_READY_MS: "500" },
      });
      mcpClients.push(mcpLead);
      await mcpLead.start();
      const stray = await mcpLead.call("agent_spawn", {
        name: "ambient-stray-window",
        command: fakeClaude("sleep 600"),
        extra_args: [],
        placement: "window",
      });

      const windowStray = tmux("list-panes", "-t", stray.tmux_target, "-F", "#{window_id}").trim().split("\n")[0];
      const strayPane = tmux("list-panes", "-t", windowStray, "-F", "#{pane_id}").trim().split("\n")[0];
      assert.notEqual(windowStray, windowProject, "sanity: the stray window must differ from the project's stamped window");

      const mcpPlainCaller = new McpClient({
        cwd: dirs.projectDir,
        dataDir: dirs.dataDir,
        env: { TMUX_PANE: strayPane, HIVE_SPAWN_READY_MS: "500" },
      });
      mcpClients.push(mcpPlainCaller);
      await mcpPlainCaller.start();
      const worker = await mcpPlainCaller.call("agent_spawn", {
        name: "ambient-should-not-win",
        command: fakeClaude("sleep 600"),
        extra_args: [],
        placement: "split",
      });

      assert.ok(
        panesIn(windowProject).includes(worker.tmux_target),
        `worker must fall back to the project's stamped window (${windowProject}), got pane ${worker.tmux_target}`,
      );
      assert.ok(
        !panesIn(windowStray).includes(worker.tmux_target),
        "must not land at the ambient TMUX_PANE's window - that pane is real and alive, but this caller has no agents row to resolve a parent from, and ambient must never substitute for one",
      );
    });
  },
);
