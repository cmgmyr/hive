import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { dirname } from "node:path";
import { after, before, describe, it } from "node:test";

import { isolateTmux, leadRow, makeFakeClaude, runCli, scratchDirs, sleep, tmux } from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("splitTargetWindow outliving a view session");

const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { db, migrate } = await import("../dist/db.js");
const { paneWindow, resolveAttachTarget, sessionName, viewSessionName } = await import("../dist/tmux.js");
const { splitTargetWindow } = await import("../dist/spawn.js");
migrate();

function hasSession(name) {
  try {
    execFileSync("tmux", ["has-session", "-t", `=${name}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe(
  "splitTargetWindow (src/spawn.ts) re-qualifies with the base session, never the view paneWindow() happened to report",
  { skip: hasTmux ? false : "tmux is not installed" },
  () => {
    const fakeClaude = makeFakeClaude(dirs.tmp);
    const project = db
      .prepare("INSERT INTO projects (name, path) VALUES (?, ?) RETURNING id")
      .get("outlives-view-project", dirs.projectDir);
    const session = sessionName();
    let viewClient;

    before(async () => {
      const claude = fakeClaude("sleep 600");
      const led = await runCli(["lead"], {
        cwd: dirs.projectDir,
        dataDir: dirs.dataDir,
        tmp: dirs.tmp,
        env: { PATH: `${dirname(claude)}:${process.env.PATH}` },
      });
      assert.equal(led.code, 0, led.stderr);

      const args = resolveAttachTarget(session, project.id, false);
      viewClient = spawn("tmux", ["-C", ...args], { stdio: ["pipe", "pipe", "pipe"] });
      await sleep(400);
      assert.ok(hasSession(viewSessionName()), "the view must exist before the fixture check below means anything");
    });

    after(async () => {
      if (viewClient) viewClient.kill("SIGTERM");
      await sleep(300);
      if (hasSession(viewSessionName())) tmux("kill-session", "-t", `=${viewSessionName()}`);
      cleanup(session);
    });

    it("fixture check: with a view grouped, paneWindow() answers the lead's own pane with the VIEW's name", () => {
      const row = leadRow(db, project.id);
      const reported = paneWindow(row.tmux_target);
      assert.equal(
        reported,
        `${viewSessionName()}:${reported.split(":")[1]}`,
        `the defect surface must be real for this test to mean anything - got ${reported}`,
      );
    });

    it("splitTargetWindow returns a target qualified with the BASE session, not the view", () => {
      const row = leadRow(db, project.id);
      const target = splitTargetWindow(session, project.id, row.actor_id);
      assert.equal(
        target,
        `${session}:${paneWindow(row.tmux_target).split(":")[1]}`,
        `must be re-qualified with the base session (${session}), not the view - got ${target}`,
      );
    });

    it("the returned target still works for a real split-window call after the view has been destroyed", async () => {
      const row = leadRow(db, project.id);
      const target = splitTargetWindow(session, project.id, row.actor_id);

      viewClient.kill("SIGTERM");
      await sleep(400);
      assert.ok(!hasSession(viewSessionName()), "the view must be gone before this call means anything");
      viewClient = null;

      const pane = tmux(
        "split-window", "-P", "-F", "#{pane_id}",
        "-t", target, "-c", dirs.projectDir, "sleep 600",
      );
      assert.ok(pane.startsWith("%"), `split-window must succeed against a target that outlives the view, got: ${pane}`);
    });
  },
);
