import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";

import { isolateTmux, leadRow, makeFakeClaude, McpClient, panesIn, runCli, scratchDirs, windowFor, windowOwners } from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("the cross-project split-placement test");

const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { db, migrate } = await import("../dist/db.js");
const { sessionName } = await import("../dist/tmux.js");
migrate();

describe(
  "a split-placed worker spawned into ANOTHER project lands next to its spawning lead, not in its own project's window",
  { skip: hasTmux ? false : "tmux is not installed" },
  () => {
    const fakeClaude = makeFakeClaude(dirs.tmp);
    const dirA = mkdtempSync(join(dirs.tmp, "proj-a-"));
    const dirB = mkdtempSync(join(dirs.tmp, "proj-b-"));
    const projA = db.prepare("INSERT INTO projects (name, path) VALUES (?, ?) RETURNING id").get("lead-repo", dirA);

    const projB = db.prepare("INSERT INTO projects (name, path) VALUES (?, ?) RETURNING id").get("other-repo", dirB);
    const session = sessionName();
    let mcp;

    before(async () => {
      const claude = fakeClaude("sleep 600");
      const led = await runCli(["lead"], {
        cwd: dirA,
        dataDir: dirs.dataDir,
        tmp: dirs.tmp,
        env: { PATH: `${dirname(claude)}:${process.env.PATH}` },
      });
      assert.equal(led.code, 0, led.stderr);
    });

    after(async () => {
      if (mcp) await mcp.close();
      cleanup(session);
    });

    it("puts the pane in the LEAD's window, keeps the worker's store scope on its OWN project, and the receipt names the crossing", async () => {
      const row = leadRow(db, projA.id);
      const windowA = windowFor(session, projA.id);
      assert.ok(panesIn(windowA).includes(row.tmux_target), "the lead's own pane must be in project A's window");

      mcp = new McpClient({
        cwd: dirA,
        dataDir: dirs.dataDir,
        env: { HIVE_AGENT_ID: row.actor_id, HIVE_SPAWN_READY_MS: "500" },
      });
      await mcp.start();
      const spawned = await mcp.call("agent_spawn", {
        name: "cross-repo-worker",
        command: fakeClaude("sleep 600"),
        extra_args: [],
        placement: "split",
        project_id: projB.id,
      });

      assert.ok(
        panesIn(windowA).includes(spawned.tmux_target),
        `cross-repo worker must land in the spawning lead's window (${windowA}), got pane ${spawned.tmux_target}`,
      );

      const owners = windowOwners(session);
      assert.ok(
        !owners.some(([, id]) => id === String(projB.id)),
        `project B must not have been given its own window, got: ${JSON.stringify(owners)}`,
      );

      const workerRow = db.prepare("SELECT project_id FROM agents WHERE id = ?").get(spawned.agent_id);
      assert.equal(
        workerRow.project_id,
        projB.id,
        "the worker's own agents row must still record project B - display location and store scope are independent",
      );

      assert.equal(
        spawned.landed_in_project,
        "lead-repo",
        "the receipt must say the pane landed in project A (\"lead-repo\"), not silently agree with project_id",
      );
    });
  },
);
