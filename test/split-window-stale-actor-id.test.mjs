import assert from "node:assert/strict";
import { dirname } from "node:path";
import { after, before, describe, it } from "node:test";

import { isolateTmux, leadRow, makeFakeClaude, McpClient, panesIn, runCli, scratchDirs, tmux } from "./helpers.mjs";

// Lead review round 1, item A on todo 267. A lead's actor_id is DELIBERATELY
// REUSED across a restart: ensureLeadRow (src/cli.ts) mints a NEW running row
// that carries the CLOSED row's old actor_id forward, so the closed row's
// stale tmux_target survives for stillThere's own adoption check. So after
// any lead close-and-restart, two rows can share one actor_id - a closed one
// holding a STALE pane and a running one holding the real pane -
// splitTargetWindow's parent lookup (src/spawn.ts) must resolve the RUNNING
// one, never whichever row an unscoped `WHERE actor_id = ?` with no ORDER BY
// happens to return first (ordinarily the lower, closed, rowid).

const { hasTmux, cleanup } = isolateTmux("the stale-actor-id parent lookup test");

const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { db, migrate } = await import("../dist/db.js");
const { sessionName, tmuxSocketPath } = await import("../dist/tmux.js");
migrate();

describe(
  "a split-placed worker's parent lookup resolves the RUNNING row, never a closed row sharing the same (reused) actor_id",
  { skip: hasTmux ? false : "tmux is not installed" },
  () => {
    const fakeClaude = makeFakeClaude(dirs.tmp);
    const project = db
      .prepare("INSERT INTO projects (name, path) VALUES (?, ?) RETURNING id")
      .get("stale-actor-id-project", dirs.projectDir);
    const session = sessionName();
    const mcpClients = [];

    function mcpAs(actorId) {
      const mcp = new McpClient({
        cwd: dirs.projectDir,
        dataDir: dirs.dataDir,
        env: { HIVE_AGENT_ID: actorId, HIVE_SPAWN_READY_MS: "500" },
      });
      mcpClients.push(mcp);
      return mcp;
    }

    before(async () => {
      const claude = fakeClaude("sleep 600");
      const led = await runCli(["lead"], {
        cwd: dirs.projectDir,
        dataDir: dirs.dataDir,
        tmp: dirs.tmp,
        env: { PATH: `${dirname(claude)}:${process.env.PATH}` },
      });
      assert.equal(led.code, 0, led.stderr);
    });

    after(async () => {
      for (const mcp of mcpClients) await mcp.close();
      cleanup(session);
    });

    it("lands the worker at the RUNNING row's pane, not the closed row's - even though the closed row's pane is real, alive, and in a different window", async () => {
      const realLead = leadRow(db, project.id);
      const windowRunning = tmux(
        "list-panes", "-t", realLead.tmux_target, "-F", "#{session_name}:#{window_id}",
      ).trim();

      // A real, ALIVE pane in a DIFFERENT window - what the closed row's
      // stale tmux_target looks like when it has not actually died. Built by
      // spawning a genuine placement="window" worker through the real lead,
      // not a synthetic fixture, so this is a real pane in a real window.
      const mcpRealLead = mcpAs(realLead.actor_id);
      await mcpRealLead.start();
      const stray = await mcpRealLead.call("agent_spawn", {
        name: "stray-window",
        command: fakeClaude("sleep 600"),
        extra_args: [],
        placement: "window",
      });
      const staleTarget = tmux("list-panes", "-t", stray.tmux_target, "-F", "#{pane_id}").trim().split("\n")[0];
      const windowStray = stray.tmux_target; // placement="window": target IS the window
      assert.notEqual(windowStray, windowRunning, "sanity: the stray window must differ from the running lead's own window");

      const ownSocket = tmuxSocketPath(process.env.TMUX, process.env.TMUX_TMPDIR);
      const staleActorId = "lead:stale-actor-id-fixture";

      // Inserted FIRST, so it gets the LOWER id - reproducing the real shape:
      // the closed row is the OLDER one, and a restart's new running row
      // always gets a HIGHER id than whatever it reused the actor_id from.
      // Distinct `name` values: idx_agents_running_name only allows one
      // status='running' row per (project_id, name), and the real lead row
      // already holds "lead" - splitTargetWindow's lookup is by actor_id,
      // not name, so the name here is otherwise irrelevant.
      db.prepare(
        `INSERT INTO agents (project_id, actor_id, name, tmux_target, tmux_socket, command, cwd, kind, status)
         VALUES (?, ?, 'lead-fixture-closed', ?, ?, 'claude', '/tmp', 'lead', 'closed')`,
      ).run(project.id, staleActorId, staleTarget, ownSocket);

      db.prepare(
        `INSERT INTO agents (project_id, actor_id, name, tmux_target, tmux_socket, command, cwd, kind, status)
         VALUES (?, ?, 'lead-fixture-running', ?, ?, 'claude', '/tmp', 'lead', 'running')`,
      ).run(project.id, staleActorId, realLead.tmux_target, ownSocket);

      const mcpStaleParent = mcpAs(staleActorId);
      await mcpStaleParent.start();
      const worker = await mcpStaleParent.call("agent_spawn", {
        name: "child-of-reused-actor-id",
        command: fakeClaude("sleep 600"),
        extra_args: [],
        placement: "split",
      });

      assert.ok(
        panesIn(windowRunning).includes(worker.tmux_target),
        `worker must land in the RUNNING row's window (${windowRunning}), got pane ${worker.tmux_target}`,
      );
      assert.ok(
        !panesIn(windowStray).includes(worker.tmux_target),
        "must not land in the CLOSED row's window, even though that row's pane is real, alive, and would pass rowLive on its own",
      );
    });
  },
);
