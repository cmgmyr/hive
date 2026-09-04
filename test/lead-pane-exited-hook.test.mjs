import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { after, describe, it } from "node:test";

import {
  clearHiveEnv,
  crashPane,
  isolateTmux,
  leadRow,
  makeFakeClaude,
  panesIn,
  runCli,
  runningCommandNames,
  scratchDirs,
  seedLeadProject,
  tmux,
  until,
} from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("the lead pane-exited backstop tests");

clearHiveEnv();
const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { db, migrate } = await import("../dist/db.js");
migrate();
const { globalHooks, paneWindow, sessionName, targetLive, windowIdsIn } = await import("../dist/tmux.js");

const leadBin = makeFakeClaude(dirs.tmp)();
const session = sessionName();

const seedProject = (name, processes = { api: "sleep 600" }) =>
  seedLeadProject(db, { root: dirs.tmp, name, leadBin, processes });

const cliOpts = (dir) => ({ cwd: dir, dataDir: dirs.dataDir, tmp: dirs.tmp });

const runningNames = (projectId) => runningCommandNames(db, projectId);

after(() => cleanup(session));

describe("a killed lead pane takes its project's processes with it (todo 765)", { skip: hasTmux ? false : "tmux is not installed" }, () => {
  it("arms one global pane-exited hook when it creates a lead pane, naming an absolute interpreter and script", async () => {
    const project = await seedProject("backstop-armed");
    const first = await runCli(["lead"], cliOpts(project.dir));
    assert.equal(first.code, 0, first.stderr);

    const [hook, ...extra] = globalHooks("pane-exited");

    assert.ok(hook, "the server must carry the hook: a window or session hook dies with the lead's window");
    assert.deepEqual(extra, [], "re-arming the same command must not grow the list");
    assert.match(hook, /lead-pane-exited/);
    assert.match(hook, /#\{hook_pane\}/, "the exiting pane's id has to reach the command tmux runs");
    assert.doesNotMatch(hook, /(^|[\s'"])hive[\s'"]/, "a bare hive would resolve to nothing in tmux's own PATH");
    assert.match(hook, />\/dev\/null 2>&1/, "tmux prints a run-shell's output into the pane it fired from");
    assert.match(hook, new RegExp(`${process.execPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  });

  it("arms exactly one entry when a second fresh lead re-arms it, and prunes an entry whose script is gone", async () => {
    const project = await seedProject("backstop-rearm");
    assert.equal((await runCli(["lead"], cliOpts(project.dir))).code, 0);
    assert.equal(globalHooks("pane-exited").length, 1);

    execFileSync("tmux", ["kill-pane", "-t", leadRow(db, project.id).tmux_target], { stdio: "ignore" });
    assert.equal((await runCli(["lead"], cliOpts(project.dir))).code, 0);

    assert.equal(globalHooks("pane-exited").length, 1, "a second created lead must not append a duplicate");

    tmux("set-hook", "-ga", "pane-exited", `run-shell "env HIVE_DATA_DIR=${dirs.dataDir} /gone/dist/cli.js lead-pane-exited"`);
    tmux("set-hook", "-ga", "pane-exited", "run-shell 'echo not-hives'");
    execFileSync("tmux", ["kill-pane", "-t", leadRow(db, project.id).tmux_target], { stdio: "ignore" });
    assert.equal((await runCli(["lead"], cliOpts(project.dir))).code, 0);

    const after = globalHooks("pane-exited");
    assert.equal(after.filter((e) => e.includes("lead-pane-exited")).length, 1, "the dead worktree's entry must go");
    assert.equal(after.filter((e) => e.includes("not-hives")).length, 1, "an entry that is not hive's is never touched");
  });

  it("says nothing about a missing backstop on an adopted lead when one is armed", async () => {
    const project = await seedProject("backstop-adopt");
    assert.equal((await runCli(["lead"], cliOpts(project.dir))).code, 0);

    const again = await runCli(["lead"], cliOpts(project.dir));

    assert.equal(again.code, 0, again.stderr);
    assert.doesNotMatch(again.stdout, /carries no pane-exited backstop/);
  });

  it("warns on an adopted lead when the server carries no backstop of ours", async () => {
    const project = await seedProject("backstop-absent");
    assert.equal((await runCli(["lead"], cliOpts(project.dir))).code, 0);
    tmux("set-hook", "-gu", "pane-exited");

    const again = await runCli(["lead"], cliOpts(project.dir));

    assert.equal(again.code, 0, again.stderr);
    assert.match(again.stdout, /carries no pane-exited backstop/);
  });

  it("stops the project's processes when the lead's own process dies, with no hive command running", async () => {
    const project = await seedProject("backstop-fires");
    assert.equal((await runCli(["lead"], cliOpts(project.dir))).code, 0);
    assert.deepEqual(runningNames(project.id), ["api"]);
    const process_ = db
      .prepare("SELECT tmux_target FROM agents WHERE project_id = ? AND name = 'api' AND status = 'running'")
      .get(project.id).tmux_target;

    const leadPane = leadRow(db, project.id).tmux_target;
    const leadWindow = paneWindow(leadPane);
    assert.equal(panesIn(leadWindow).length, 1, "the case worth pinning is a lead alone in its window");

    crashPane(leadPane);

    assert.equal(
      await until(() => !windowIdsIn(session).includes(leadWindow.split(":")[1]), 8000),
      true,
      "tmux destroys that window with the pane, which is why a window-scoped hook could not do this",
    );

    assert.equal(await until(() => runningNames(project.id).length === 0, 8000), true, "the row must be closed");
    assert.equal(await until(() => targetLive(process_) === false, 8000), true, "and the pane taken down");
  });

  it("does nothing when a WORKER pane in the lead's own window exits", async () => {
    const project = await seedProject("backstop-worker");
    assert.equal((await runCli(["lead"], cliOpts(project.dir))).code, 0);
    const leadPane = leadRow(db, project.id).tmux_target;
    const workerPane = tmux(
      "split-window", "-P", "-F", "#{pane_id}", "-t", paneWindow(leadPane), "-c", project.dir, "sleep 600",
    );
    assert.deepEqual(runningNames(project.id), ["api"]);

    crashPane(workerPane);

    assert.equal(await until(() => targetLive(workerPane) === false, 8000), true, "the fixture needs that pane gone");
    assert.equal(await until(() => runningNames(project.id).length === 0, 2000), false);
    assert.deepEqual(runningNames(project.id), ["api"], "only the lead's own pane may trigger the stop");
  });

  it("fires for one project's lead only, never another project's processes", async () => {
    const mine = await seedProject("backstop-mine");
    const other = await seedProject("backstop-other");
    assert.equal((await runCli(["lead"], cliOpts(mine.dir))).code, 0);
    assert.equal((await runCli(["lead"], cliOpts(other.dir))).code, 0);
    assert.deepEqual(runningNames(other.id), ["api"]);

    crashPane(leadRow(db, mine.id).tmux_target);

    assert.equal(await until(() => runningNames(mine.id).length === 0, 8000), true);
    assert.deepEqual(runningNames(other.id), ["api"]);
  });

  it("leaves restart-lead.sh's kill-pane to the fresh lead, because tmux fires no hook for a destroyed pane", async () => {
    const project = await seedProject("backstop-restart");
    assert.equal((await runCli(["lead"], cliOpts(project.dir))).code, 0);
    const before = db
      .prepare("SELECT tmux_target FROM agents WHERE project_id = ? AND name = 'api' AND status = 'running'")
      .get(project.id).tmux_target;

    execFileSync("tmux", ["kill-pane", "-t", leadRow(db, project.id).tmux_target], { stdio: "ignore" });
    assert.deepEqual(
      runningNames(project.id),
      ["api"],
      "kill-pane fires no tmux hook at all, so the process is still running when the script reaches hive lead",
    );

    const again = await runCli(["lead"], cliOpts(project.dir));

    assert.equal(again.code, 0, again.stderr);
    assert.match(again.stdout, /^- api: stopped \(C-c\); left running by a previous lead$/m);
    assert.deepEqual(runningNames(project.id), ["api"]);
    assert.notEqual(
      db
        .prepare("SELECT tmux_target FROM agents WHERE project_id = ? AND name = 'api' AND status = 'running'")
        .get(project.id).tmux_target,
      before,
      "the restarted process is a new pane, not the one the backstop took down",
    );
  });
});
