import assert from "node:assert/strict";
import { dirname } from "node:path";
import { after, describe, it } from "node:test";

import { isolateTmux, leadRow, makeFakeClaude, McpClient, runCli, scratchDirs, tmux } from "./helpers.mjs";

// A worker spawned before its own project's lead has ever run: a real case
// (the first thing to happen in a brand-new store, e.g. right after a
// reboot), not an edge case to punt on. launchAgent's createdSession branch
// (src/spawn.ts) claims the session's fresh initial window directly, the
// same first-occupant path `hive lead` itself uses via claimInitialWindow -
// this file exercises it through agent_spawn instead, since it needs a
// session that does not exist yet, which none of the other lead-*.test.mjs
// files start from (isolateTmux is one call per file, at module top level,
// so a fresh-session scenario needs its own file rather than a nested
// describe reusing an already-created session).

const { hasTmux, cleanup } = isolateTmux("the worker-first window naming test");

const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { db, migrate } = await import("../dist/db.js");
const { sessionName } = await import("../dist/tmux.js");
migrate();

describe(
  "a split-placed worker spawned before any `hive lead` claims the project's window, not its own",
  { skip: hasTmux ? false : "tmux is not installed" },
  () => {
    const fakeClaude = makeFakeClaude(dirs.tmp);
    const project = db
      .prepare("INSERT INTO projects (name, path) VALUES (?, ?) RETURNING id")
      .get("worker-first-project", dirs.projectDir);
    const session = sessionName();
    let mcp;

    after(async () => {
      if (mcp) await mcp.close();
      cleanup(session);
    });

    it("names the fresh session's claimed window for the PROJECT, stamps it, and a later `hive lead` reuses it", async () => {
      mcp = new McpClient({ cwd: dirs.projectDir, dataDir: dirs.dataDir, env: { HIVE_SPAWN_READY_MS: "500" } });
      await mcp.start();
      const spawned = await mcp.call("agent_spawn", {
        name: "first-worker",
        command: fakeClaude("sleep 600"),
        extra_args: [],
        placement: "split",
      });

      const window = tmux("list-panes", "-t", spawned.tmux_target, "-F", "#{session_name}:#{window_id}");
      const windowName = tmux("display-message", "-p", "-t", window, "#{window_name}");
      assert.equal(
        windowName,
        "worker-first-project",
        "the window a split-placed worker claims as the session's first occupant must be named for the " +
          "PROJECT, matching splitTargetWindow's own create path and cmdLead - not windowTitle(project, worker), " +
          "which is placement=\"window\"'s convention for a worker's OWN dedicated window",
      );
      const owner = tmux("show-options", "-w", "-v", "-t", window, "@hive-project-id");
      assert.equal(owner, String(project.id), "the window must be stamped so a later `hive lead` can find it");

      const claude = fakeClaude("sleep 600");
      const led = await runCli(["lead"], {
        cwd: dirs.projectDir,
        dataDir: dirs.dataDir,
        tmp: dirs.tmp,
        env: { PATH: `${dirname(claude)}:${process.env.PATH}` },
      });
      assert.equal(led.code, 0, led.stderr);

      const windowsAfter = tmux("list-windows", "-t", `=${session}`, "-F", "#{window_id}\t#{@hive-project-id}")
        .split("\n")
        .filter((row) => row.endsWith(`\t${project.id}`));
      assert.equal(
        windowsAfter.length,
        1,
        "hive lead must reuse the worker's already-stamped window, not create a second one for the same project",
      );

      const row = leadRow(db, project.id);
      assert.ok(
        tmux("list-panes", "-t", window, "-F", "#{pane_id}").split("\n").includes(row.tmux_target),
        "the lead's pane must land in the SAME window the worker already claimed",
      );
    });
  },
);
