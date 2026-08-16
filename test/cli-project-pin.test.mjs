import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { McpClient, isolateTmux, liveAgentRow, runCli, scratchDirs } from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("the CLI project-pin tests");

const dbDirs = scratchDirs();
process.env.HIVE_DATA_DIR = dbDirs.dataDir;
const { db, migrate } = await import("../dist/db.js");
migrate();

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

describe(
  "CLI commands consult the same project pin agent_spawn's own tools honor",
  { skip: hasTmux ? false : "tmux is not installed" },
  () => {
    const dirs = scratchDirs();
    let mcp;
    let actorId;
    let todoId;

    before(async () => {
      mcp = new McpClient({ cwd: dirs.projectDir, dataDir: dirs.dataDir });
      await mcp.start();
      const todo = await mcp.call("todo_create", { title: "pinned-project-todo-cli63" });
      todoId = todo.todo_id;

      const receipt = await mcp.call("agent_spawn", {
        name: "cli-pin-worker-63",
        command: "sleep",
        extra_args: ["600"],
      });
      actorId = receipt.actor_id;
      await liveAgentRow(mcp, "cli-pin-worker-63");
    });

    after(async () => {
      await mcp.call("agent_close", { name: "cli-pin-worker-63" });
      await mcp.close();
      cleanup();
    });

    const unregisteredDir = (name) => mkdtempSync(join(dirs.tmp, `unreg-cli63-${name}-`));

    it("hive todos, run from an unregistered cwd carrying the worker's pin, shows the pinned project's todo", async () => {
      const { code, stdout } = await runCli(["todos", "--all"], {
        cwd: unregisteredDir("todos"),
        dataDir: dirs.dataDir,
        env: { HIVE_AGENT_ID: actorId, HIVE_PROJECT_LOCK: "1" },
      });
      assert.equal(code, 0);
      assert.match(stdout, /pinned-project-todo-cli63/);
    });

    it("hive todo <id>, same env, resolves the pinned project's todo detail", async () => {
      const { code, stdout } = await runCli(["todo", String(todoId)], {
        cwd: unregisteredDir("todo"),
        dataDir: dirs.dataDir,
        env: { HIVE_AGENT_ID: actorId, HIVE_PROJECT_LOCK: "1" },
      });
      assert.equal(code, 0);
      assert.match(stdout, /pinned-project-todo-cli63/);
    });

    it("hive statusline, same env, reports the pinned project's state instead of staying silent for the unregistered cwd", async () => {
      const { code, stdout } = await runCli(["statusline"], {
        cwd: unregisteredDir("statusline"),
        dataDir: dirs.dataDir,
        env: { HIVE_AGENT_ID: actorId, HIVE_PROJECT_LOCK: "1" },
      });
      assert.equal(code, 0);

      assert.notEqual(stdout.trim(), "");
    });

    it("hive todos still resolves by cwd, unaffected, when no pin is set - the control for the three cases above", async () => {
      const { code, stdout } = await runCli(["todos"], {
        cwd: dirs.projectDir,
        dataDir: dirs.dataDir,
        env: {},
      });
      assert.equal(code, 0);
      assert.match(stdout, /pinned-project-todo-cli63/);
    });

    it("(finding 6) a pinned command run in an unregistered cwd with NO pin set registers no project - the MUST NEVER REGISTER property pinnedOrCwdProject's own comment asserts", async () => {

      const before = (await mcp.call("project_list")).projects.length;
      const { code, stdout } = await runCli(["todos"], {
        cwd: unregisteredDir("finding6"),
        dataDir: dirs.dataDir,
        env: {},
      });
      assert.equal(code, 0);
      assert.equal(stdout.trim(), "");
      const after = (await mcp.call("project_list")).projects.length;
      assert.equal(after, before);
    });

    it("a bad pin (row missing) prints a clean message, not a raw node stack trace, and exits non-zero", async () => {
      const { code, stdout, stderr } = await runCli(["todos"], {
        cwd: unregisteredDir("badpin"),
        dataDir: dirs.dataDir,
        env: { HIVE_AGENT_ID: "agent:cli63-missing", HIVE_PROJECT_LOCK: "1" },
      });
      assert.notEqual(code, 0);
      assert.match(stdout, /names no agents row/);

      assert.match(stdout, /unset HIVE_AGENT_ID/);

      assert.doesNotMatch(stderr, /at Object|at process|node:internal|Error:\s*\n\s*at /);
    });

    it("(finding 3) hive statusline stays silent and exits 0 on a bad pin, honoring its own 'prints nothing' contract", async () => {

      const { code, stdout, stderr } = await runCli(["statusline"], {
        cwd: unregisteredDir("statusline-badpin"),
        dataDir: dirs.dataDir,
        env: { HIVE_AGENT_ID: "agent:cli63-missing-statusline", HIVE_PROJECT_LOCK: "1" },
      });
      assert.equal(code, 0);
      assert.equal(stdout.trim(), "");
      assert.equal(stderr.trim(), "");
    });

    it("(finding 2a) a path argument matching the pin is a no-op - a locked session still resolves the same project it was already going to", async () => {

      const { code, stdout } = await runCli(["runbook", dirs.projectDir], {
        cwd: unregisteredDir("finding2a-cwd"),
        dataDir: dirs.dataDir,
        env: { HIVE_AGENT_ID: actorId, HIVE_PROJECT_LOCK: "1" },
      });
      assert.equal(code, 1);
      assert.match(stdout, /This project has no profile/);
      assert.doesNotMatch(stdout, /locked to project/);
    });

    it("(finding 2b) a path argument that disagrees with the pin REFUSES, naming both, and registers no project", async () => {

      const before = (await mcp.call("project_list")).projects.length;
      const elsewhere = unregisteredDir("finding2b");
      const { code, stdout } = await runCli(["runbook", elsewhere], {
        cwd: unregisteredDir("finding2b-cwd"),
        dataDir: dirs.dataDir,
        env: { HIVE_AGENT_ID: actorId, HIVE_PROJECT_LOCK: "1" },
      });
      assert.notEqual(code, 0);
      assert.match(stdout, /locked to project \d+/);
      assert.match(stdout, new RegExp(escapeRegex(elsewhere)));
      assert.match(stdout, /no registered project/);
      assert.match(stdout, /Unset HIVE_AGENT_ID and HIVE_PROJECT_LOCK/);
      const after = (await mcp.call("project_list")).projects.length;
      assert.equal(after, before);
    });

    it("(finding 2c) control: an UNLOCKED session with a path argument is unaffected - it still registers an unregistered path exactly as before", async () => {

      const before = (await mcp.call("project_list")).projects.length;
      const fresh = unregisteredDir("finding2c");
      const { code, stdout } = await runCli(["runbook", fresh], {
        cwd: unregisteredDir("finding2c-cwd"),
        dataDir: dirs.dataDir,
        env: {},
      });
      assert.equal(code, 1);
      assert.match(stdout, /This project has no profile/);
      const after = (await mcp.call("project_list")).projects.length;
      assert.equal(after, before + 1);
    });
  },
);

describe("agentProjectPin resolves the RUNNING row when actor_id names two (issue #27's L4 fix round R6, todo 170)", () => {
  it("returns the running row's project, not a closed row sharing the same actor_id", async () => {
    const actorId = "dup-actor-170";
    const closedProject = db
      .prepare("INSERT INTO projects (name, path) VALUES (?, ?) RETURNING id")
      .get("dup-actor-closed-project", mkdtempSync(join(dbDirs.tmp, "dup-actor-closed-")));
    const runningProject = db
      .prepare("INSERT INTO projects (name, path) VALUES (?, ?) RETURNING id")
      .get("dup-actor-running-project", mkdtempSync(join(dbDirs.tmp, "dup-actor-running-")));

    db.prepare(
      `INSERT INTO agents (project_id, actor_id, name, tmux_target, command, cwd, kind, status)
       VALUES (?, ?, 'closed-half', '', 'sleep', '/tmp', 'agent', 'closed')`,
    ).run(closedProject.id, actorId);
    db.prepare(
      `INSERT INTO agents (project_id, actor_id, name, tmux_target, command, cwd, kind, status)
       VALUES (?, ?, 'running-half', '', 'sleep', '/tmp', 'agent', 'running')`,
    ).run(runningProject.id, actorId);
    db.prepare("INSERT INTO todos (project_id, title) VALUES (?, 'closed-project-todo-170')").run(closedProject.id);
    db.prepare("INSERT INTO todos (project_id, title) VALUES (?, 'running-project-todo-170')").run(runningProject.id);

    const unregisteredCwd = mkdtempSync(join(dbDirs.tmp, "dup-actor-cwd-"));
    const { code, stdout } = await runCli(["todos", "--all"], {
      cwd: unregisteredCwd,
      dataDir: dbDirs.dataDir,
      env: { HIVE_AGENT_ID: actorId, HIVE_PROJECT_LOCK: "1" },
    });
    assert.equal(code, 0, stdout);
    assert.match(stdout, /running-project-todo-170/, "must resolve to the RUNNING row's project");

    assert.doesNotMatch(stdout, /closed-project-todo-170/, "must not resolve to the closed row's project");
  });
});
