import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";

import { isolateTmux, leadRow, makeFakeClaude, McpClient, panesIn, runCli, scratchDirs, windowFor, windowOwners } from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("the lead window-ownership tests");

const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { db, migrate } = await import("../dist/db.js");
const { sessionName } = await import("../dist/tmux.js");
migrate();

describe(
  "cmdLead claims one window per project in the one shared session, by ownership stamp",
  { skip: hasTmux ? false : "tmux is not installed" },
  () => {
    const fakeClaude = makeFakeClaude(dirs.tmp);
    const dirA = mkdtempSync(join(dirs.tmp, "proj-a-"));
    const dirB = mkdtempSync(join(dirs.tmp, "proj-b-"));

    const projA = db.prepare("INSERT INTO projects (name, path) VALUES (?, ?) RETURNING id").get("same-name", dirA);
    const projB = db.prepare("INSERT INTO projects (name, path) VALUES (?, ?) RETURNING id").get("same-name", dirB);
    const session = sessionName();
    let mcpB;

    before(async () => {
      const claudeA = fakeClaude("sleep 600");
      const firstA = await runCli(["lead"], {
        cwd: dirA,
        dataDir: dirs.dataDir,
        tmp: dirs.tmp,
        env: { PATH: `${dirname(claudeA)}:${process.env.PATH}` },
      });
      assert.equal(firstA.code, 0, firstA.stderr);

      const claudeB = fakeClaude("sleep 600");
      const firstB = await runCli(["lead"], {
        cwd: dirB,
        dataDir: dirs.dataDir,
        tmp: dirs.tmp,
        env: { PATH: `${dirname(claudeB)}:${process.env.PATH}` },
      });
      assert.equal(firstB.code, 0, firstB.stderr);
    });

    after(async () => {
      if (mcpB) await mcpB.close();
      cleanup(session);
    });

    it("gives each project its own window in the ONE session, each stamped with its own id", () => {
      const owners = windowOwners(session);
      const ownerIds = owners.map(([, id]) => id).filter((id) => id !== "");
      assert.deepEqual(
        new Set(ownerIds),
        new Set([String(projA.id), String(projB.id)]),
        `expected windows stamped exactly for ${projA.id} and ${projB.id}, got: ${JSON.stringify(owners)}`,
      );
      assert.equal(ownerIds.length, 2, "each project owns exactly one window, not a duplicate");
    });

    it("keeps each lead's own pane inside ITS project's window, not the other one", () => {
      const windowA = windowFor(session, projA.id);
      const windowB = windowFor(session, projB.id);

      const rowA = leadRow(db, projA.id);
      const rowB = leadRow(db, projB.id);

      assert.ok(panesIn(windowA).includes(rowA.tmux_target), "project A's lead pane must be in project A's window");
      assert.ok(panesIn(windowB).includes(rowB.tmux_target), "project B's lead pane must be in project B's window");
      assert.ok(!panesIn(windowA).includes(rowB.tmux_target), "project B's lead must not share project A's window");
    });

    it("a split-placed worker for the SECOND project lands in that project's window, not the first project's (the old rows[0] fallback)", async () => {
      const windowA = windowFor(session, projA.id);
      const windowB = windowFor(session, projB.id);

      mcpB = new McpClient({ cwd: dirB, dataDir: dirs.dataDir, env: { HIVE_SPAWN_READY_MS: "500" } });
      await mcpB.start();
      const spawned = await mcpB.call("agent_spawn", {
        name: "b-worker",
        command: fakeClaude("sleep 600"),
        extra_args: [],
        placement: "split",
      });

      assert.ok(
        panesIn(windowB).includes(spawned.tmux_target),
        `worker spawned for project B must land in project B's window (${windowB}), got pane ${spawned.tmux_target}`,
      );
      assert.ok(
        !panesIn(windowA).includes(spawned.tmux_target),
        "must not land in project A's window - that is the old rows[0]/leadTitle fallback silently placing it in a stranger's tab",
      );
    });

    it("a lead restart never adopts a pane from a DIFFERENT project's window, even when its own row's tmux_target names one (the cross-upgrade / stranded-pane shape)", async () => {
      const rowA = leadRow(db, projA.id);
      const rowBBefore = leadRow(db, projB.id);

      db.prepare("UPDATE agents SET tmux_target = ?, tmux_socket = ?, pane_pid = ? WHERE id = ?").run(
        rowA.tmux_target,
        rowA.tmux_socket,
        rowA.pane_pid,
        rowBBefore.id,
      );

      const claudeB2 = fakeClaude("sleep 600");
      const restarted = await runCli(["lead"], {
        cwd: dirB,
        dataDir: dirs.dataDir,
        tmp: dirs.tmp,
        env: { PATH: `${dirname(claudeB2)}:${process.env.PATH}` },
      });
      assert.equal(restarted.code, 0, restarted.stderr);

      const rowAAfter = leadRow(db, projA.id);
      const rowBAfter = leadRow(db, projB.id);
      assert.notEqual(
        rowBAfter.tmux_target,
        rowA.tmux_target,
        "project B's lead must not adopt project A's pane just because its own row was made to point at it",
      );
      assert.equal(
        rowAAfter.tmux_target,
        rowA.tmux_target,
        "project A's own row must be untouched by project B's restart",
      );

      const windowA = windowFor(session, projA.id);
      const windowB = windowFor(session, projB.id);
      assert.ok(
        panesIn(windowB).includes(rowBAfter.tmux_target),
        "project B's lead must land back in project B's own window, not wherever its stale tmux_target pointed",
      );
      assert.ok(
        panesIn(windowA).includes(rowA.tmux_target),
        "project A's own pane must still be alive and in its own window",
      );
    });
  },
);
