import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";

import {
  fakeFailingTmux,
  isolateTmux,
  leadRow,
  makeFakeClaude,
  McpClient,
  paneField,
  panesIn,
  runCli,
  scratchDirs,
  tmux,
  windowFor,
} from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("the hive layout CLI tests");
const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;

const { db, migrate } = await import("../dist/db.js");
const { paneWindow, sessionName, tmuxSocketPath, windowLayout } = await import("../dist/tmux.js");
migrate();

describe("hive layout", { skip: hasTmux ? false : "tmux is not installed" }, () => {
  const project = db.prepare("INSERT INTO projects (name, path) VALUES (?, ?) RETURNING id")
    .get("layout-main", dirs.projectDir);
  writeFileSync(join(dirs.projectDir, "hive.yml"), "placement: split\nlayout: main-vertical\n");
  const fakeClaude = makeFakeClaude(dirs.tmp);
  const session = sessionName();
  const clients = [];
  let mcp;

  const cli = (args = ["layout"], cwd = dirs.projectDir, env = {}) => runCli(args, {
    cwd,
    dataDir: dirs.dataDir,
    tmp: dirs.tmp,
    env,
  });

  const spawnWorker = async (name) => mcp.call("agent_spawn", {
    name,
    command: fakeClaude("sleep 600"),
    extra_args: [],
    placement: "window",
  });

  const seedPaneRow = (projectId, name, target, kind = "agent", status = "running", parkedAt = "") => {
    const panePid = paneField(target, "#{pane_pid}");
    const { id } = db.prepare(
      `INSERT INTO agents (project_id, actor_id, name, tmux_target, tmux_socket, pane_pid,
                           command, cwd, kind, status, parked_at)
       VALUES (?, ?, ?, ?, ?, ?, 'sleep 600', ?, ?, ?, ?) RETURNING id`,
    ).get(projectId, `test:${name}`, name, target, tmuxSocketPath(), panePid, dirs.projectDir, kind, status, parkedAt);
    return id;
  };

  before(async () => {
    const claude = fakeClaude("sleep 600");
    const led = await cli(["lead", "--detach"], dirs.projectDir, { PATH: `${dirname(claude)}:${process.env.PATH}` });
    assert.equal(led.code, 0, led.stderr);
    const lead = leadRow(db, project.id);
    mcp = new McpClient({
      cwd: dirs.projectDir,
      dataDir: dirs.dataDir,
      env: { HIVE_AGENT_ID: lead.actor_id, HIVE_SPAWN_READY_MS: "500" },
    });
    clients.push(mcp);
    await mcp.start();
  });

  after(async () => {
    for (const client of clients) await client.close();
    cleanup(session);
  });

  it("hive layout joins window-placed workers into the lead window and preserves their live pane ids", async () => {
    const first = await spawnWorker("layout-worker-one");
    const second = await spawnWorker("layout-worker-two");
    const rows = [first, second].map(({ name }) => db.prepare(
      "SELECT id, tmux_target, tmux_socket, pane_pid FROM agents WHERE project_id = ? AND name = ?",
    ).get(project.id, name));
    const initialTargets = rows.map((row) => row.tmux_target);
    const initialWindows = initialTargets.map((target) => paneWindow(target));
    const leadWindow = windowFor(session, project.id);

    const result = await cli();
    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /moved layout-worker-one pane %\d+ into/);
    assert.match(result.stdout, /moved layout-worker-two pane %\d+ into/);
    assert.ok(initialTargets.every((target) => panesIn(leadWindow).includes(target)));

    for (let index = 0; index < rows.length; index++) {
      const after = db.prepare("SELECT status, tmux_target FROM agents WHERE id = ?").get(rows[index].id);
      assert.equal(after.status, "running");
      assert.equal(after.tmux_target, initialTargets[index]);
      assert.equal(paneField(initialTargets[index], "#{pane_dead}"), "0");
      const status = await mcp.call("agent_status", { name: index === 0 ? "layout-worker-one" : "layout-worker-two" });
      assert.equal(status.alive, true);
      assert.equal(status.tmux_target, initialTargets[index]);
    }

    const windows = tmux("list-windows", "-t", `=${session}`, "-F", "#{session_name}:#{window_id}").split("\n");
    assert.ok(initialWindows.every((window) => !windows.includes(window)), `source windows should be gone: ${initialWindows}`);
  });

  it("hive layout puts the lead pane first and applies the configured layout", async () => {
    const worker = await spawnWorker("layout-order-worker");
    const row = db.prepare("SELECT tmux_target FROM agents WHERE project_id = ? AND name = ?")
      .get(project.id, worker.name);
    const lead = leadRow(db, project.id);
    const window = windowFor(session, project.id);
    tmux("join-pane", "-d", "-s", row.tmux_target, "-t", window);
    tmux("swap-pane", "-s", lead.tmux_target, "-t", row.tmux_target);
    tmux("set-window-option", "-t", window, "@hive-layout", "even-horizontal");

    const result = await cli();
    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(panesIn(window)[0], lead.tmux_target);
    assert.equal(windowLayout(window), "main-vertical", "the merged hive.yml layout overrides the stored window layout");
  });

  it("hive layout reports when tmux cannot apply the configured layout", async () => {
    const worker = await spawnWorker("layout-failed-retile-worker");
    const row = db.prepare("SELECT tmux_target FROM agents WHERE project_id = ? AND name = ?")
      .get(project.id, worker.name);
    const window = windowFor(session, project.id);
    tmux("set-window-option", "-t", window, "@hive-layout", "even-horizontal");
    const failingTmux = fakeFailingTmux({ failOn: "select-layout" });

    const result = await cli(["layout"], dirs.projectDir, { PATH: `${failingTmux}:${process.env.PATH}` });
    assert.equal(result.code, 1, result.stderr);
    assert.ok(panesIn(window).includes(row.tmux_target), "the worker pane was moved even though the retile failed");
    assert.match(result.stdout, /layout main-vertical could not be applied; panes were moved/);
    assert.doesNotMatch(result.stdout, /; layout main-vertical$/m);
    assert.equal(windowLayout(window), "even-horizontal");
  });

  it("hive layout with no project window exits 1", async () => {
    const otherDir = mkdtempSync(join(dirs.tmp, "layout-no-window-"));
    db.prepare("INSERT INTO projects (name, path) VALUES (?, ?)").run("layout-no-window", otherDir);
    const result = await cli(["layout"], otherDir);
    assert.equal(result.code, 1);
    assert.match(result.stdout, /this project has no window yet; run hive first/);
  });

  it("hive layout refuses when tmux cannot be probed", async () => {
    const fakeTmux = fakeFailingTmux();
    const result = await cli(["layout"], dirs.projectDir, { PATH: `${fakeTmux}:${process.env.PATH}` });
    assert.equal(result.code, 1);
    assert.match(result.stdout, /tmux could not be probed; nothing was changed/);
  });

  it("hive layout leaves other projects' and process panes where they are", async () => {
    const worker = await spawnWorker("layout-scope-worker");
    const workerRow = db.prepare("SELECT tmux_target FROM agents WHERE project_id = ? AND name = ?")
      .get(project.id, worker.name);
    const foreignProject = db.prepare("INSERT INTO projects (name, path) VALUES (?, ?) RETURNING id")
      .get("layout-foreign", mkdtempSync(join(dirs.tmp, "layout-foreign-")));
    const foreignPane = tmux("new-window", "-d", "-P", "-F", "#{pane_id}", "-t", `=${session}`, "sleep 600");
    const foreignWindow = paneWindow(foreignPane);
    tmux("set-window-option", "-t", foreignWindow, "@hive-project-id", String(foreignProject.id));
    seedPaneRow(foreignProject.id, "foreign-layout-worker", foreignPane);

    const processPane = tmux("new-window", "-d", "-P", "-F", "#{pane_id}", "-t", `=${session}`, "sleep 600");
    seedPaneRow(project.id, "layout-process", processPane, "command");
    const closedPane = tmux("new-window", "-d", "-P", "-F", "#{pane_id}", "-t", `=${session}`, "sleep 600");
    seedPaneRow(project.id, "layout-closed", closedPane, "agent", "closed");
    const parkedPane = tmux("new-window", "-d", "-P", "-F", "#{pane_id}", "-t", `=${session}`, "sleep 600");
    seedPaneRow(project.id, "layout-parked", parkedPane, "agent", "closed", "2026-11-01 00:00:00");
    const originalWindows = new Map([foreignPane, processPane, closedPane, parkedPane].map((pane) => [pane, paneWindow(pane)]));

    const result = await cli();
    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
    for (const pane of [foreignPane, processPane, closedPane, parkedPane]) {
      assert.equal(paneWindow(pane), originalWindows.get(pane), `${pane} should stay in its original window`);
      assert.ok(panesIn(originalWindows.get(pane)).includes(pane), `${pane} should remain alive`);
    }
    assert.ok(panesIn(windowFor(session, project.id)).includes(workerRow.tmux_target));
  });

  it("hive layout leaves a window holding a non-hive pane and names it", async () => {
    const worker = await spawnWorker("layout-leftover-worker");
    const row = db.prepare("SELECT tmux_target FROM agents WHERE project_id = ? AND name = ?")
      .get(project.id, worker.name);
    const source = paneWindow(row.tmux_target);
    tmux("set-window-option", "-t", source, "@hive-owned", "1");
    const humanPane = tmux("split-window", "-d", "-P", "-F", "#{pane_id}", "-t", source, "sleep 600");
    const staleRow = seedPaneRow(project.id, "layout-stale-target", humanPane);
    db.prepare("UPDATE agents SET pane_pid = ? WHERE id = ?").run("0", staleRow);

    const result = await cli();
    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
    assert.ok(result.stdout.includes(`left windows with panes remaining: ${source}`), result.stdout);
    assert.ok(panesIn(source).includes(humanPane), "the untracked pane stays in the source window");
    assert.equal(tmux("show-options", "-w", "-v", "-t", source, "@hive-owned"), "1");
  });

  it("hive layout with every pane already home only re-tiles", async () => {
    const window = windowFor(session, project.id);
    tmux("set-window-option", "-t", window, "@hive-layout", "even-horizontal");
    const result = await cli();
    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /nothing to move/);
    assert.equal(windowLayout(window), "main-vertical");
  });

  it("hive layout does nothing under placement window", async () => {
    const otherDir = mkdtempSync(join(dirs.tmp, "layout-window-placement-"));
    writeFileSync(join(otherDir, "hive.yml"), "placement: window\nlayout: main-horizontal\n");
    const other = db.prepare("INSERT INTO projects (name, path) VALUES (?, ?) RETURNING id")
      .get("layout-window-placement", otherDir);
    const workerPane = tmux("new-window", "-d", "-P", "-F", "#{pane_id}", "-t", `=${session}`, "sleep 600");
    seedPaneRow(other.id, "window-placement-worker", workerPane);
    const originalWindow = paneWindow(workerPane);

    const result = await cli(["layout"], otherDir);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /^placement is window in hive\.yml; nothing to gather\s*$/);
    assert.equal(paneWindow(workerPane), originalWindow);
  });

  it("agent_spawn notes a window placement that overrides a split config", async () => {
    const receipt = await spawnWorker("layout-placement-note-worker");
    assert.match(receipt.note, /own window.*placement "window" overrides this project's split config; run `hive layout`/);
    await mcp.call("agent_close", { name: receipt.name });
  });

  it("agent_spawn uses HIVE_SPAWN_PLACEMENT when hive.yml leaves placement unset", async () => {
    const configPath = join(dirs.projectDir, "hive.yml");
    const originalConfig = "placement: split\nlayout: main-vertical\n";
    writeFileSync(configPath, "layout: main-vertical\n");
    const lead = leadRow(db, project.id);
    const envMcp = new McpClient({
      cwd: dirs.projectDir,
      dataDir: dirs.dataDir,
      env: {
        HIVE_AGENT_ID: lead.actor_id,
        HIVE_SPAWN_READY_MS: "500",
        HIVE_SPAWN_PLACEMENT: "window",
      },
    });
    await envMcp.start();
    const name = "layout-env-placement-worker";
    try {
      const receipt = await envMcp.call("agent_spawn", { name, command: fakeClaude("sleep 600"), extra_args: [] });
      const leadWindow = windowFor(session, project.id);
      const workerWindow = paneWindow(receipt.tmux_target);
      assert.ok(workerWindow, "the worker has a live window");
      assert.notEqual(workerWindow.split(":")[1], leadWindow.split(":")[1]);
      await envMcp.call("agent_close", { name });
    } finally {
      await envMcp.close();
      writeFileSync(configPath, originalConfig);
    }
  });

  it("hive layout refuses layout-selection flags", async () => {
    const result = await cli(["layout", "--window"]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /hive layout: unknown argument "--window"/);
  });
});
