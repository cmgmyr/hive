import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";

import { isolateTmux, leadRow, makeFakeClaude, McpClient, panesIn, runCli, scratchDirs, windowFor, windowOwners } from "./helpers.mjs";

// Todo 268 / plan-lane-3-tmux-topology. The case that started the whole
// investigation: a lead in project A is told to work in another repo, and
// the worker it spawns there must appear NEXT TO THE LEAD, not off in
// project B's own tab (pad 71 "THE PLACEMENT RULE, STATED ONCE" - "the
// worker's project's window" is the exact popping-out behaviour this design
// exists to stop, wearing a different costume). Todo 267 already built the
// mechanism (splitTargetWindow resolves the SPAWNING PARENT's window from
// the store); this file proves it generalizes across projects and that the
// receipt names where the pane actually landed, since a caller cannot
// reconstruct that from project_id alone.

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
    // Registered, but no `hive lead` of its own - the ordinary shape of "the
    // lead is told to work in another repo" (project-scoping.md: cwd's
    // project need not be running anything).
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

      // WHERE THE PANE IS: next to the lead, in project A's window.
      assert.ok(
        panesIn(windowA).includes(spawned.tmux_target),
        `cross-repo worker must land in the spawning lead's window (${windowA}), got pane ${spawned.tmux_target}`,
      );

      // WHERE THE PANE IS NOT: project B never gets a window of its own out
      // of this spawn - there is nothing yet for a project-id fallback to
      // have found, so a passing test here cannot be explained by the OLD
      // "worker's own project's window" rule happening to agree.
      const owners = windowOwners(session);
      assert.ok(
        !owners.some(([, id]) => id === String(projB.id)),
        `project B must not have been given its own window, got: ${JSON.stringify(owners)}`,
      );

      // STORE SCOPE: a separate question, and it stays project B's.
      const workerRow = db.prepare("SELECT project_id FROM agents WHERE id = ?").get(spawned.agent_id);
      assert.equal(
        workerRow.project_id,
        projB.id,
        "the worker's own agents row must still record project B - display location and store scope are independent",
      );

      // THE RECEIPT: names the crossing rather than leaving the caller to
      // reconstruct it from project_id, which is exactly the field it can't.
      assert.equal(
        spawned.landed_in_project,
        "lead-repo",
        "the receipt must say the pane landed in project A (\"lead-repo\"), not silently agree with project_id",
      );
    });
  },
);
