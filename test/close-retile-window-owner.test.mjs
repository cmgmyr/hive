import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";

import { isolateTmux, leadRow, makeFakeClaude, McpClient, runCli, scratchDirs, tmux, windowFor } from "./helpers.mjs";

// Todo 269 / plan-lane-3-tmux-topology. agent_close's re-tile
// (src/tools/agents.ts, the applyLayout call after kill-pane/kill-window)
// used to fall back to `loadProjectYml(project.path)` - the CLOSING ROW's
// project - when the window carried no @hive-layout yet. Once a
// cross-project worker can share a window with a lead it did not spawn from
// (todo 268), that resolves a FOREIGN repo's hive.yml against a window it
// does not own: exactly counselors F1 on pad 71, the finding that killed the
// lead's original cross-session placement proposal. The fix routes the
// fallback through the WINDOW's own @hive-project-id owner instead.
//
// windowLayout(window) (the @hive-layout window option) is consulted FIRST
// and already reads correctly in the ordinary case - a spawn's own
// applyLayout call stamps it. So both tests here deliberately UNSET
// @hive-layout after spawning, to force the code down the FALLBACK path this
// todo actually changed; without that, every window here would already
// carry a stamp from its own spawn and the fallback would never run.

const { hasTmux, cleanup } = isolateTmux("the close-retile window-owner tests");

const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { db, migrate } = await import("../dist/db.js");
const { sessionName, windowLayout } = await import("../dist/tmux.js");
migrate();

function unsetLayoutStamp(window) {
  tmux("set-window-option", "-t", window, "-u", "@hive-layout");
}

describe(
  "agent_close's re-tile resolves the fallback hive.yml through the WINDOW's owner, never the closing row's project",
  { skip: hasTmux ? false : "tmux is not installed" },
  () => {
    const fakeClaude = makeFakeClaude(dirs.tmp);
    const dirA = mkdtempSync(join(dirs.tmp, "owner-a-"));
    const dirB = mkdtempSync(join(dirs.tmp, "owner-b-"));
    // DIFFERENT layouts, deliberately, so a wrong resolution is observable -
    // test/CLAUDE.md's "a same-layout fixture cannot fail" rule, named
    // directly in the todo's own acceptance criteria.
    writeFileSync(join(dirA, "hive.yml"), "layout: main-vertical\n");
    writeFileSync(join(dirB, "hive.yml"), "layout: even-horizontal\n");
    const projA = db.prepare("INSERT INTO projects (name, path) VALUES (?, ?) RETURNING id").get("owner-a", dirA);
    const projB = db.prepare("INSERT INTO projects (name, path) VALUES (?, ?) RETURNING id").get("owner-b", dirB);
    const session = sessionName();
    const mcpClients = [];

    function mcpAs(actorId, cwd = dirA) {
      const mcp = new McpClient({
        cwd,
        dataDir: dirs.dataDir,
        env: { HIVE_AGENT_ID: actorId, HIVE_SPAWN_READY_MS: "500" },
      });
      mcpClients.push(mcp);
      return mcp;
    }

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
      for (const mcp of mcpClients) await mcp.close();
      cleanup(session);
    });

    it("re-tiles through project A's hive.yml (the window's owner), not project B's (the closing row's own project)", async () => {
      const row = leadRow(db, projA.id);
      const windowA = windowFor(session, projA.id);

      const mcpLead = mcpAs(row.actor_id);
      await mcpLead.start();
      // A cross-project worker: store scope B, but its pane lands in A's
      // window because A's lead spawned it (todo 268).
      const worker = await mcpLead.call("agent_spawn", {
        name: "foreign-scoped-worker",
        command: fakeClaude("sleep 600"),
        extra_args: [],
        placement: "split",
        project_id: projB.id,
      });
      assert.equal(worker.landed_in_project, "owner-a", "sanity: must have landed in project A's window");

      unsetLayoutStamp(windowA);
      assert.equal(windowLayout(windowA), null, "sanity: the window must carry no @hive-layout before the close");

      // Close it as project B would see its own worker - project_id=B,
      // matching how a lead orchestrating cross-repo work actually calls
      // agent_close (findAgent scopes strictly by project_id).
      const closed = await mcpLead.call("agent_close", {
        agent_id: worker.agent_id,
        project_id: projB.id,
      });
      assert.equal(closed.closed, true);

      assert.equal(
        windowLayout(windowA),
        "main-vertical",
        "the re-tile fallback must resolve through project A's hive.yml (the window's owner), not project B's (the closing row's project)",
      );
    });

    it("a window with no @hive-project-id stamp re-tiles to DEFAULT_LAYOUT, never the closing row's project", async () => {
      const row = leadRow(db, projA.id);

      const mcpLead = mcpAs(row.actor_id);
      await mcpLead.start();
      // placement="window": its own dedicated window, deliberately never
      // stamped with @hive-project-id (test/worker-first-window-stamp.test.mjs).
      const parentWorker = await mcpLead.call("agent_spawn", {
        name: "unstamped-window-parent",
        command: fakeClaude("sleep 600"),
        extra_args: [],
        placement: "window",
      });
      const parentWindow = parentWorker.tmux_target;

      const mcpParent = mcpAs(parentWorker.actor_id);
      await mcpParent.start();
      const child = await mcpParent.call("agent_spawn", {
        name: "child-in-unstamped-window",
        command: fakeClaude("sleep 600"),
        extra_args: [],
        placement: "split",
      });

      unsetLayoutStamp(parentWindow);
      assert.equal(windowLayout(parentWindow), null, "sanity: the window must carry no @hive-layout before the close");

      // Closing row's own project is A, whose hive.yml layout ("main-vertical")
      // is deliberately NOT DEFAULT_LAYOUT ("tiled") - if the fallback wrongly
      // used the closing row's project here, this assertion would catch it
      // exactly as the first test does, even though this scenario has no
      // owner stamp to compare against at all.
      const closed = await mcpParent.call("agent_close", {
        agent_id: child.agent_id,
        project_id: projA.id,
      });
      assert.equal(closed.closed, true);

      assert.equal(
        windowLayout(parentWindow),
        "tiled",
        "a window with no ownership stamp must re-tile to DEFAULT_LAYOUT, not the closing row's project's hive.yml",
      );
    });
  },
);
