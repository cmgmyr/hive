import assert from "node:assert/strict";
import { dirname } from "node:path";
import { after, before, describe, it } from "node:test";

import { isolateTmux, leadRow, makeFakeClaude, McpClient, paneField, panesIn, runCli, scratchDirs, tmux, windowFor } from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("the window-target moved-pane test");

const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { db, migrate } = await import("../dist/db.js");
const { sessionName } = await import("../dist/tmux.js");
migrate();

const windowIds = (session) =>
  tmux("list-windows", "-t", `=${session}`, "-F", "#{session_name}:#{window_id}").split("\n").filter(Boolean);

const processAlive = (pid) => {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
};

describe(
  "a placement=\"window\" worker survives its pane being moved to another window",
  { skip: hasTmux ? false : "tmux is not installed" },
  () => {
    const fakeClaude = makeFakeClaude(dirs.tmp);
    const project = db
      .prepare("INSERT INTO projects (name, path) VALUES (?, ?) RETURNING id")
      .get("moved-window-worker", dirs.projectDir);
    const session = sessionName();
    const mcpClients = [];
    let worker;
    let workerPane;
    let workerPanePid;
    let workerWindow;

    before(async () => {
      const claude = fakeClaude("sleep 600");
      const led = await runCli(["lead"], {
        cwd: dirs.projectDir,
        dataDir: dirs.dataDir,
        tmp: dirs.tmp,
        env: { PATH: `${dirname(claude)}:${process.env.PATH}` },
      });
      assert.equal(led.code, 0, led.stderr);

      const lead = leadRow(db, project.id);
      const mcp = new McpClient({
        cwd: dirs.projectDir,
        dataDir: dirs.dataDir,
        env: { HIVE_AGENT_ID: lead.actor_id, HIVE_SPAWN_READY_MS: "500" },
      });
      mcpClients.push(mcp);
      await mcp.start();
      worker = await mcp.call("agent_spawn", {
        name: "windowed-worker",
        command: fakeClaude("sleep 600"),
        extra_args: [],
        placement: "window",
      });

      const panes = panesIn(worker.tmux_target);
      assert.equal(panes.length, 1, `a window-placed worker owns exactly one pane, got ${JSON.stringify(panes)}`);
      workerPane = panes[0];
      workerWindow = paneField(workerPane, "#{session_name}:#{window_id}");
      assert.match(workerWindow, /:@\d+$/, `expected a window id for the worker's pane, got ${workerWindow}`);
      workerPanePid = paneField(workerPane, "#{pane_pid}");

      assert.ok(
        windowIds(session).includes(workerWindow),
        `the worker's window ${workerWindow} must be listed before the move, or the check after it proves nothing`,
      );

      tmux("join-pane", "-d", "-s", workerPane, "-t", windowFor(session, project.id));

      db.prepare("UPDATE agents SET created_at = datetime('now', '-60 seconds') WHERE id = ?").run(worker.agent_id);
    });

    after(async () => {
      for (const mcp of mcpClients) await mcp.close();
      cleanup(session);
    });

    it("the move destroys the recorded window while the worker's pane and process stay alive (fixture check)", () => {
      assert.ok(
        !windowIds(session).includes(workerWindow),
        `joining the last pane out of ${workerWindow} must destroy it - otherwise this file reproduces nothing`,
      );
      assert.ok(panesIn(windowFor(session, project.id)).includes(workerPane), "the worker's pane moved into the lead's window");
      assert.equal(paneField(workerPane, "#{pane_dead}"), "0", "the worker's pane is not dead");
      assert.equal(paneField(workerPane, "#{pane_pid}"), workerPanePid, "the pane kept its process across the move");
      assert.ok(processAlive(workerPanePid), `the worker's process (pid ${workerPanePid}) is still running`);
    });

    it("a window-placed row records a real pane_pid, so the pane-reissue guard is no longer inert for it", () => {
      const row = db.prepare("SELECT pane_pid FROM agents WHERE id = ?").get(worker.agent_id);
      assert.equal(row.pane_pid, workerPanePid, "the row records the pane's own pid, read from tmux at spawn time");
      assert.notEqual(row.pane_pid, "", "'' is the pre-fix value and reads as 'no fact recorded' to paneReissued");
    });

    it("the janitor does not close the row of a worker whose process is still running", async () => {
      const { janitor } = await import("../dist/scheduler.js");

      const swept = janitor();
      assert.equal(swept.probed, true, "the janitor must have actually probed tmux, or a surviving row proves nothing");

      assert.ok(processAlive(workerPanePid), `the worker's process (pid ${workerPanePid}) is still running after the sweep`);
      assert.equal(paneField(workerPane, "#{pane_dead}"), "0", "the worker's pane is still not dead after the sweep");

      const row = db.prepare("SELECT status, tmux_target FROM agents WHERE id = ?").get(worker.agent_id);
      assert.equal(
        row.status,
        "running",
        `a worker whose pane and process are both alive must not read as closed (row target: ${row.tmux_target}, live pane: ${workerPane})`,
      );
    });
  },
);
