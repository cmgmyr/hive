import assert from "node:assert/strict";
import { dirname } from "node:path";
import { after, before, describe, it } from "node:test";

import { isolateTmux, leadRow, makeFakeClaude, McpClient, panesIn, runCli, scratchDirs, windowFor } from "./helpers.mjs";

// Todo 267 / plan-lane-3-tmux-topology. splitTargetWindow (src/spawn.ts) used
// to open with `process.env.TMUX_PANE`, the caller's own ambient pane. That
// happened to answer "the spawning lead's window" only by luck of derivation
// (under one shared session, the caller usually IS the lead). This file
// drives the REAL MCP entry point - two real `agent_spawn` calls chained
// through a real store row, never a helper - per
// dead-ends/2026-08-05-helper-whose-parameters-cannot-disagree.md: a helper
// whose two args are always made to agree proves nothing about the caller
// that matters. Neither McpClient process here ever runs inside tmux (no
// TMUX_PANE in its env), so any test that only proves "the worker landed in
// the project's window" cannot tell the store lookup from the old
// ambient-primary code's fallback - both give the same answer when ambient
// is empty. The tests below are built so the two answers DIFFER.

const { hasTmux, cleanup } = isolateTmux("the split-window parent-placement tests");

const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { db, migrate } = await import("../dist/db.js");
const { sessionName } = await import("../dist/tmux.js");
migrate();

describe(
  "a split-placed worker's window comes from the STORE (parent_actor_id -> the parent's own pane -> its window), never from ambient TMUX_PANE",
  { skip: hasTmux ? false : "tmux is not installed" },
  () => {
    const fakeClaude = makeFakeClaude(dirs.tmp);
    const project = db
      .prepare("INSERT INTO projects (name, path) VALUES (?, ?) RETURNING id")
      .get("split-placement-project", dirs.projectDir);
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

    it("a worker spawned by the lead lands in the lead's own window, the lead's pane and the worker's pane in the same one", async () => {
      const row = leadRow(db, project.id);
      const leadWindow = windowFor(session, project.id);
      assert.ok(panesIn(leadWindow).includes(row.tmux_target), "the lead's own pane must be in its own window");

      const mcp = mcpAs(row.actor_id);
      await mcp.start();
      const spawned = await mcp.call("agent_spawn", {
        name: "lead-direct-worker",
        command: fakeClaude("sleep 600"),
        extra_args: [],
        placement: "split",
      });
      assert.ok(
        panesIn(leadWindow).includes(spawned.tmux_target),
        `worker spawned by the lead must land in the lead's window (${leadWindow}), got pane ${spawned.tmux_target}`,
      );
    });

    it("a worker spawned BY A WORKER lands in THAT WORKER's window, not the project's stamped window - the fallback would get this wrong", async () => {
      const row = leadRow(db, project.id);
      const leadWindow = windowFor(session, project.id);

      // placement="window": worker0 gets its OWN dedicated window, distinct
      // from and NOT stamped with the project's @hive-project-id
      // (test/worker-first-window-stamp.test.mjs). So findProjectWindow(session,
      // project.id) can never resolve to it - the only way a later spawn can
      // land there is by resolving worker0's OWN pane from the store.
      const mcpLead = mcpAs(row.actor_id);
      await mcpLead.start();
      const worker0 = await mcpLead.call("agent_spawn", {
        name: "parent-worker",
        command: fakeClaude("sleep 600"),
        extra_args: [],
        placement: "window",
      });
      const worker0Window = worker0.tmux_target; // placement="window": target IS the window
      assert.notEqual(worker0Window, leadWindow, "worker0's own window must differ from the project's stamped window");

      // Now worker0 itself is the spawning parent - drive the real MCP entry
      // point as worker0 would (its own pane's process carries
      // HIVE_AGENT_ID=worker0.actor_id, exactly as a real claude worker's does).
      const mcpWorker0 = mcpAs(worker0.actor_id);
      await mcpWorker0.start();
      const worker1 = await mcpWorker0.call("agent_spawn", {
        name: "child-of-worker",
        command: fakeClaude("sleep 600"),
        extra_args: [],
        placement: "split",
      });

      assert.ok(
        panesIn(worker0Window).includes(worker1.tmux_target),
        `worker spawned by worker0 must land in worker0's own window (${worker0Window}), got pane ${worker1.tmux_target}`,
      );
      assert.ok(
        !panesIn(leadWindow).includes(worker1.tmux_target),
        "must not fall back to the project's stamped window - that is the old ambient-TMUX_PANE code's fallback answer, and it is the wrong one here",
      );
    });

    it("a parent row on a FOREIGN socket is never trusted, even though its pane is alive and reachable - falls back to the project's stamped window instead", async () => {
      const row = leadRow(db, project.id);
      const leadWindow = windowFor(session, project.id);

      const mcpLead = mcpAs(row.actor_id);
      await mcpLead.start();
      const worker0 = await mcpLead.call("agent_spawn", {
        name: "foreign-socket-parent",
        command: fakeClaude("sleep 600"),
        extra_args: [],
        placement: "window",
      });
      const worker0Window = worker0.tmux_target;

      // worker0's pane is real, alive, and on OUR OWN server - only the
      // recorded socket disagrees, the same shape
      // test/tmux-socket-foreign.test.mjs uses to fake "foreign" without a
      // second real tmux server. rowLive() must refuse to trust this row's
      // tmux_target on that basis alone (foreignSocket(), src/tmux.ts).
      db.prepare("UPDATE agents SET tmux_socket = ? WHERE actor_id = ?").run(
        "/nonexistent/foreign-socket-dir/tmux-0/default",
        worker0.actor_id,
      );

      const mcpWorker0 = mcpAs(worker0.actor_id);
      await mcpWorker0.start();
      const worker2 = await mcpWorker0.call("agent_spawn", {
        name: "child-of-foreign-parent",
        command: fakeClaude("sleep 600"),
        extra_args: [],
        placement: "split",
      });

      assert.ok(
        panesIn(leadWindow).includes(worker2.tmux_target),
        `an unresolvable (foreign-socket) parent must fall back to the project's stamped window (${leadWindow}), got pane ${worker2.tmux_target}`,
      );
      assert.ok(
        !panesIn(worker0Window).includes(worker2.tmux_target),
        "must not land in the foreign-socket parent's window - that pane is real and alive, but this row's account of it must not be trusted",
      );
    });
  },
);
