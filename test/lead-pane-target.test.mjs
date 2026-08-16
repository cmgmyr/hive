import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";

import { isolateTmux, leadRow, makeFakeClaude, McpClient, runCli, scratchDirs, until } from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("the lead pane-target tests");

const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { db, migrate } = await import("../dist/db.js");
const { sessionName, isPaneTarget } = await import("../dist/tmux.js");
migrate();

function panesIn(target) {
  return execFileSync("tmux", ["list-panes", "-t", target, "-F", "#{pane_id}"])
    .toString()
    .split("\n")
    .filter(Boolean);
}

function capture(target) {
  try {
    return execFileSync("tmux", ["capture-pane", "-p", "-t", target]).toString();
  } catch {
    return "";
  }
}

describe(
  "the lead's tmux_target is a pane, and a restart always ends with a live one",
  { skip: hasTmux ? false : "tmux is not installed" },
  () => {
    const fakeClaude = makeFakeClaude(dirs.tmp);

    const envMarker = join(dirs.tmp, "lead-pane-env-marker");
    const claudePath = fakeClaude(
      `(echo "HIVE_AGENT_ID=$HIVE_AGENT_ID"; echo "HIVE_LEAD=$HIVE_LEAD"; echo "HIVE_DATA_DIR=$HIVE_DATA_DIR") ` +
        `> "${envMarker}" 2>/dev/null || true; exec sleep 600`,
    );
    const cliOpts = {
      cwd: dirs.projectDir,
      dataDir: dirs.dataDir,
      tmp: dirs.tmp,
      env: { PATH: `${dirname(claudePath)}:${process.env.PATH}` },
    };
    const project = db
      .prepare("INSERT INTO projects (name, path) VALUES (?, ?) RETURNING id")
      .get("lead-pane-target-test", dirs.projectDir);
    const session = sessionName();

    let mcp;
    let workerTarget;

    before(async () => {
      const first = await runCli(["lead"], cliOpts);
      assert.equal(first.code, 0, first.stderr);

      mcp = new McpClient({ cwd: dirs.projectDir, dataDir: dirs.dataDir, env: { HIVE_SPAWN_READY_MS: "500" } });
      await mcp.start();

      const spawned = await mcp.call("agent_spawn", {
        name: "split-worker",
        command: fakeClaude("sleep 600"),
        extra_args: [],
        placement: "split",
      });
      workerTarget = spawned.tmux_target;

      assert.match(workerTarget, /^%\d+$/, "the worker's pane id must be a real target, never empty");
    });

    after(async () => {
      await mcp.close();
      cleanup(session);
    });

    it("records a pane id for the lead, not the window it shares with a split worker", () => {
      const row = leadRow(db, project.id);
      assert.ok(isPaneTarget(row.tmux_target), `expected a pane id (%N), got ${row.tmux_target}`);
      assert.notEqual(row.tmux_target, workerTarget, "the lead's own pane must differ from the worker's");
    });

    it("delivers a lead-directed wake to the lead's own pane; the pre-fix window target would reach the split worker instead", async () => {
      const row = leadRow(db, project.id);
      const leadPane = row.tmux_target;

      const fixedMarker = `FIXED-SHAPE-${row.id}`;
      await mcp.call("wake_set", { delay_seconds: 1, body: fixedMarker, deliver_to: "lead" });
      assert.ok(
        await until(() => capture(leadPane).includes(fixedMarker), 10000),
        "a wake delivered via the fixed pane target must land in the lead's own pane",
      );
      assert.ok(
        !capture(workerTarget).includes(fixedMarker),
        "and must not land in the split worker's pane",
      );

      const windowTarget = execFileSync("tmux", [
        "display-message", "-p", "-t", leadPane, "#{session_name}:#{window_id}",
      ])
        .toString()
        .trim();

      execFileSync("tmux", ["select-pane", "-t", workerTarget]);
      db.prepare("UPDATE agents SET tmux_target = ? WHERE id = ?").run(windowTarget, row.id);
      try {
        const oldShapeMarker = `OLD-SHAPE-${row.id}`;
        await mcp.call("wake_set", { delay_seconds: 1, body: oldShapeMarker, deliver_to: "lead" });
        assert.ok(
          await until(() => capture(workerTarget).includes(oldShapeMarker), 10000),
          "the window-shaped target (the pre-fix behaviour) must deliver to the window's active pane - " +
            "the split worker's, not the lead's - proving the old shape misdelivered",
        );
        assert.ok(
          !capture(leadPane).includes(oldShapeMarker),
          "and must NOT reach the lead's own pane under the old shape",
        );
      } finally {
        db.prepare("UPDATE agents SET tmux_target = ? WHERE id = ?").run(leadPane, row.id);
      }
    });

    it("a found window whose lead pane died gets a fresh pane running leadCommand, leaving the split worker untouched", async () => {
      const before = leadRow(db, project.id);
      const deadPane = before.tmux_target;
      const windowTarget = execFileSync("tmux", [
        "display-message", "-p", "-t", deadPane, "#{session_name}:#{window_id}",
      ])
        .toString()
        .trim();
      assert.deepEqual(
        panesIn(windowTarget).sort(),
        [deadPane, workerTarget].sort(),
        "sanity check: the window holds exactly the lead's pane and the split worker's",
      );

      execFileSync("tmux", ["kill-pane", "-t", deadPane], { stdio: "ignore" });
      assert.deepEqual(panesIn(windowTarget), [workerTarget], "only the worker's pane should remain");

      rmSync(envMarker, { force: true });
      const second = await runCli(["lead"], cliOpts);
      assert.equal(second.code, 0, second.stderr);

      const after = leadRow(db, project.id);
      assert.equal(after.id, before.id, "the restart must reuse the same agents row");
      assert.ok(isPaneTarget(after.tmux_target), `expected a pane id (%N), got ${after.tmux_target}`);
      assert.notEqual(after.tmux_target, deadPane, "a new pane must be recorded, not the dead one");
      assert.notEqual(after.tmux_target, workerTarget, "the new lead pane must not be the worker's pane");

      await until(() => existsSync(envMarker) && readFileSync(envMarker, "utf8").includes("HIVE_DATA_DIR="), 5000);
      const paneEnv = Object.fromEntries(
        readFileSync(envMarker, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => {
            const eq = line.indexOf("=");
            return [line.slice(0, eq), line.slice(eq + 1)];
          }),
      );
      assert.equal(paneEnv.HIVE_AGENT_ID, after.actor_id, "the split-window pane must carry the lead's own actor id");
      assert.equal(paneEnv.HIVE_LEAD, "1", "the split-window pane must be marked as the lead");
      assert.equal(paneEnv.HIVE_DATA_DIR, dirs.dataDir, "the split-window pane must see this store's own data dir");

      assert.deepEqual(
        panesIn(windowTarget).sort(),
        [after.tmux_target, workerTarget].sort(),
        "the new lead pane must land in the SAME window, next to the untouched worker pane",
      );

      assert.ok(
        await until(() => {
          const cmd = execFileSync("tmux", [
            "display-message", "-p", "-t", after.tmux_target, "#{pane_current_command}",
          ]).toString().trim();
          return cmd === "sleep";
        }, 10000),
        "the new pane must actually be running leadCommand (fakeClaude's sleep 600), not sitting idle",
      );
    });
  },
);
