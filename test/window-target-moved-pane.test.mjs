import assert from "node:assert/strict";
import { dirname } from "node:path";
import { after, before, describe, it } from "node:test";

import { isolateTmux, leadRow, makeFakeClaude, McpClient, paneField, panesIn, runCli, scratchDirs, tmux, windowFor } from "./helpers.mjs";

// Todo 371. A placement="window" worker's tmux_target is a WINDOW id, so
// anything that moves its pane out of that window destroys the id the row
// names and the janitor's agents sweep closes a LIVE worker.
//
// REPORTED from a live incident in another project (a lead ran `tmux
// join-pane` to pull two window-placed workers into its own window, which
// destroyed their windows; both rows went closed at the next tick while both
// claude processes carried on mid-turn). This file is the local reproduction
// that report was taken on trust for, per
// decisions/2026-08-06-a-relayed-finding-is-not-a-verified-one.md.
//
// IT ASSERTS BOTH HALVES, AND THAT IS THE WHOLE POINT. A test that only shows
// the row closing proves the janitor works, which nobody doubts. The claim
// that makes this a defect rather than a tidy-up is that the PROCESS IS STILL
// RUNNING, so the pane's pid is asserted alive - through the kernel
// (process.kill(pid, 0)), not through hive's own view of the world - before
// the row is ever read.
//
// The sweep is not being accused of misbehaving: a destroyed window is an
// honest `false` from rowAliveProbe, not the `null` the foreign-socket
// conservatism protects. The wrong fact is what the row records.

const { hasTmux, cleanup } = isolateTmux("the window-target moved-pane test");

const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { db, migrate } = await import("../dist/db.js");
const { sessionName } = await import("../dist/tmux.js");
migrate();

// Raw tmux, never a dist/ helper answering the same question - test/helpers.mjs
// states the rule and why (a helper that asks the code under test only ever
// proves the code agrees with itself).
// #{session_name}:#{window_id}, NOT a bare #{window_id}, and that is the
// whole assertion rather than a formatting preference. The window this file
// compares against is read as `session:@n` (below), so listing bare `@n` here
// made `!windowIds(session).includes(workerWindow)` compare two strings that
// can never be equal - the fixture check the file rests on would have passed
// with no join-pane at all. Found by this lane's own /simplify pass; it is
// test/CLAUDE.md's first shape, an assertion that cannot fail, and the fix is
// proven by asserting the window IS listed before the move.
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
      // The worker's PANE and its WINDOW are both derived from tmux here,
      // never read off the receipt, and that is not indirection for its own
      // sake. The receipt's tmux_target is the very thing this lane changes,
      // so a window id taken from it would compare a PANE id against the
      // window list after the fix and pass for the wrong reason - the shape
      // test/CLAUDE.md lists seventh, an assertion satisfied by two
      // indistinguishable causes. Written this way the file makes the same
      // claim against either kind of target, which is what let it run red
      // against the parent commit and green against this one.
      const panes = panesIn(worker.tmux_target);
      assert.equal(panes.length, 1, `a window-placed worker owns exactly one pane, got ${JSON.stringify(panes)}`);
      workerPane = panes[0];
      workerWindow = paneField(workerPane, "#{session_name}:#{window_id}");
      assert.match(workerWindow, /:@\d+$/, `expected a window id for the worker's pane, got ${workerWindow}`);
      workerPanePid = paneField(workerPane, "#{pane_pid}");
      // THE POSITIVE CONTROL FOR THE ASSERTION BELOW, and it is the reason
      // that assertion can fail at all. "the window is gone after the move"
      // says nothing unless the same query found it BEFORE the move - the
      // first version compared a bare `@n` against a `session:@n` and was
      // therefore true with no join-pane at all.
      assert.ok(
        windowIds(session).includes(workerWindow),
        `the worker's window ${workerWindow} must be listed before the move, or the check after it proves nothing`,
      );

      // The incident's own sequence: the lead pulls the worker's pane into its
      // own window. Joining the LAST pane out of a window destroys that window,
      // which is what takes the id the row names out of existence.
      tmux("join-pane", "-d", "-s", workerPane, "-t", windowFor(session, project.id));

      // Past the janitor's SETTLE_WINDOW (-15 seconds), which would otherwise
      // spare this row for a reason that has nothing to do with the defect.
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

    // Todo 371's second-order consequence, decided deliberately rather than
    // discovered later. targetLiveProbe returns pid null for a WINDOW target
    // ("a window target has no single pane's pid to report at all",
    // src/tmux.ts), so every placement="window" row used to carry pane_pid=''
    // - which paneReissued reads as "no fact recorded" - and the todo-336 /
    // issue-149 pane-reissue guard was INERT for this whole population. A pane
    // id makes the pid real, which switches that guard ON for rows it has
    // never run against.
    //
    // Kept rather than suppressed, because the guard's own condition cannot be
    // tripped by the move this lane is about: the fixture check above asserts
    // #{pane_pid} is UNCHANGED across join-pane. What it can now catch is what
    // it was built to catch - a server restart reissuing this pane id to
    // somebody else's process.
    it("a window-placed row records a real pane_pid, so the pane-reissue guard is no longer inert for it", () => {
      const row = db.prepare("SELECT pane_pid FROM agents WHERE id = ?").get(worker.agent_id);
      assert.equal(row.pane_pid, workerPanePid, "the row records the pane's own pid, read from tmux at spawn time");
      assert.notEqual(row.pane_pid, "", "'' is the pre-fix value and reads as 'no fact recorded' to paneReissued");
    });

    it("the janitor does not close the row of a worker whose process is still running", async () => {
      const { janitor } = await import("../dist/scheduler.js");
      // probed, not just the row: janitor() returns early with probed=false
      // when liveTargets() cannot answer, and a sweep that never ran leaves
      // the row 'running' for a reason that has nothing to do with this fix.
      // Without this the headline test passes against fully unfixed code
      // whenever the probe path breaks (counselors, fable seat).
      const swept = janitor();
      assert.equal(swept.probed, true, "the janitor must have actually probed tmux, or a surviving row proves nothing");

      // The process half first, deliberately: it is what makes a closed row a
      // DEFECT rather than a correct reap, and asserting it after the row would
      // leave a failure reading as though the sweep had found a dead worker.
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
