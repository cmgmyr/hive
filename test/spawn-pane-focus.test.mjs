import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import { isolateTmux, makeFakeClaude, McpClient, scratchDirs, tmux } from "./helpers.mjs";

// Todo 316. tmux makes a newly split pane, or a newly created window, ACTIVE
// by default. A human typing into the pane or window that had focus when a
// spawn lands gets some of their keystrokes stolen by the worker's pane
// instead - confirmed in real use, not a hypothetical. This exercises the
// actual launchAgent code path (through agent_spawn) against a real tmux
// server, not a reimplementation of it, for the same reason
// worker-first-window-naming.test.mjs does.

const { hasTmux, cleanup } = isolateTmux("the spawn pane focus test");

const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { db, migrate } = await import("../dist/db.js");
const { sessionName } = await import("../dist/tmux.js");
migrate();

describe(
  "spawning a worker must not steal pane or window focus from whoever had it",
  { skip: hasTmux ? false : "tmux is not installed" },
  () => {
    const fakeClaude = makeFakeClaude(dirs.tmp);
    const project = db
      .prepare("INSERT INTO projects (name, path) VALUES (?, ?) RETURNING id")
      .get("focus-test-project", dirs.projectDir);
    const session = sessionName();
    let mcp;

    after(async () => {
      if (mcp) await mcp.close();
      cleanup(session);
    });

    it("a split placement leaves the pane that had focus active", async () => {
      mcp = new McpClient({ cwd: dirs.projectDir, dataDir: dirs.dataDir, env: { HIVE_SPAWN_READY_MS: "500" } });
      await mcp.start();

      // First split-placed worker for this project claims the session's
      // fresh initial window (claimInitialWindow, not the split-window path
      // under test) and is the window's only pane, so it starts active -
      // stand-in for "the human's pane already had focus".
      const first = await mcp.call("agent_spawn", {
        name: "worker-1",
        command: fakeClaude("sleep 600"),
        extra_args: [],
        placement: "split",
      });
      const window = tmux("list-panes", "-t", first.tmux_target, "-F", "#{session_name}:#{window_id}");
      assert.equal(
        tmux("list-panes", "-t", window, "-F", "#{pane_active}").trim(),
        "1",
        "the only pane in a freshly claimed window must start active",
      );

      // Second split-placed worker goes through splitTargetWindow -> the
      // split-window call in launchAgent (src/spawn.ts) - the exact call
      // this todo is about, since worker-1's window already exists.
      await mcp.call("agent_spawn", {
        name: "worker-2",
        command: fakeClaude("sleep 600"),
        extra_args: [],
        placement: "split",
      });

      const activity = tmux("list-panes", "-t", window, "-F", "#{pane_id} #{pane_active}")
        .split("\n")
        .map((row) => row.split(" "));
      assert.equal(activity.length, 2, `expected two panes in the window, got ${JSON.stringify(activity)}`);
      const leadPane = activity.find(([id]) => id === first.tmux_target);
      assert.equal(
        leadPane?.[1],
        "1",
        "the pane that had focus before the split must still be active after it, " +
          `got ${JSON.stringify(activity)}`,
      );
    });

    it("a window placement does not move the session off the window that had focus", async () => {
      const before = tmux("list-windows", "-t", `=${session}`, "-F", "#{window_active} #{window_id}")
        .split("\n")
        .find((row) => row.startsWith("1 "));
      assert.ok(before, "expected exactly one active window before the spawn");
      const currentWindowId = before.split(" ")[1];

      // placement="window" runs through createWindow's new-window call
      // (src/tmux.ts) - the sibling call this todo names explicitly ("check
      // it rather than assuming they behave the same").
      await mcp.call("agent_spawn", {
        name: "worker-3",
        command: fakeClaude("sleep 600"),
        extra_args: [],
        placement: "window",
      });

      const after = tmux("list-windows", "-t", `=${session}`, "-F", "#{window_active} #{window_id}")
        .split("\n")
        .find((row) => row.startsWith("1 "));
      assert.ok(after, "expected exactly one active window after the spawn");
      assert.equal(
        after.split(" ")[1],
        currentWindowId,
        "the session's current window must not move to a worker's freshly created window",
      );
    });
  },
);
