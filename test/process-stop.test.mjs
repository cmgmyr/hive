import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { isolateTmux, runCli, scratchDirs, seedTrustedYml, tmux, until } from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("the process stop tests");

const dirs = scratchDirs();
const opts = { cwd: dirs.projectDir, dataDir: dirs.dataDir, tmp: dirs.tmp };
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { db } = await import("../dist/db.js");
const { createWindow, ensureSession, findProjectWindow, sessionName, targetLive } = await import("../dist/tmux.js");

const needsTmux = { skip: hasTmux ? false : "tmux is not installed" };

let projectId;
let projectName;
let session;

const rowFor = (name) =>
  db.prepare("SELECT * FROM agents WHERE project_id = ? AND name = ? ORDER BY id DESC").get(projectId, name);

const runningRow = (name) =>
  db
    .prepare("SELECT * FROM agents WHERE project_id = ? AND name = ? AND status = 'running'")
    .get(projectId, name);

before(async () => {
  const init = await runCli(["init"], opts);
  assert.equal(init.code, 0, init.stderr);
  const project = db.prepare("SELECT id, name FROM projects LIMIT 1").get();
  projectId = project.id;
  projectName = project.name;
  session = sessionName();
  await seedTrustedYml({
    db,
    projectId,
    projectDir: dirs.projectDir,
    processes: {
      api: { command: "sleep 600", visible: false },
      queue: { command: "sleep 600", visible: false },
      trapper: { command: "trap '' INT; sleep 600", visible: false },
      never: { command: "sleep 600", visible: false },
    },
  });

  if (!hasTmux) return;

  ensureSession(session, dirs.projectDir, { bare: true });
  createWindow(session, projectName, dirs.projectDir, [], "sleep 600", projectId, true, false);
});

after(() => cleanup(session));

describe("hive stop ends a hive.yml process, gracefully first (todo 765)", () => {
  it("refuses a name hive.yml does not define and never started, and lists the ones it does", async () => {
    const { code, stdout } = await runCli(["stop", "nope"], opts);

    assert.equal(code, 1, stdout);
    assert.match(stdout, /No process "nope" in hive\.yml\. Defined: api, queue, trapper, never/);
  });

  it("says a defined but unstarted process is not running, and names the command that starts it", async () => {
    const { code, stdout } = await runCli(["stop", "never"], opts);

    assert.equal(code, 0, stdout);
    assert.match(stdout, /never: not running \(start with: hive start "never"\)/);
  });

  it("rejects a flag rather than reading it as the optional path", async () => {
    const { code, stdout, stderr } = await runCli(["stop", "api", "--force"], opts);

    assert.notEqual(code, 0);
    assert.match(stdout + stderr, /--force/);
  });

  it("says nothing is running rather than printing an empty list", needsTmux, async () => {
    const { code, stdout } = await runCli(["stop", "--all"], opts);

    assert.equal(code, 0, stdout);
    assert.match(stdout, /No processes are running\./);
  });

  it("takes a process that honours C-c down on the graceful leg, and says which leg it was", needsTmux, async () => {
    assert.equal((await runCli(["start", "api"], opts)).code, 0);
    const target = runningRow("api").tmux_target;
    assert.equal(targetLive(target), true, "the fixture needs a live pane to stop");

    const { code, stdout } = await runCli(["stop", "api"], opts);

    assert.equal(code, 0, stdout);
    assert.match(stdout, /^api: stopped \(C-c\)$/m);
    assert.equal(runningRow("api"), undefined);
    assert.ok(rowFor("api").closed_at);
    assert.equal(await until(() => targetLive(target) === false), true, "the pane must be gone");
  });

  it("marks the row as stopping before it touches the pane, and closes it only once the pane is gone", needsTmux, async () => {
    assert.equal((await runCli(["start", "trapper"], opts)).code, 0);
    const row = runningRow("trapper");
    const marker = db
      .prepare("SELECT 1 FROM kv WHERE project_id = ? AND key = ?")
      .get(projectId, `stopping:${row.id}`);
    assert.equal(marker, undefined, "no marker before a stop");

    const stopping = runCli(["stop", "trapper"], opts);
    const observed = await until(
      () =>
        !!db.prepare("SELECT 1 FROM kv WHERE project_id = ? AND key = ?").get(projectId, `stopping:${row.id}`) &&
        !!runningRow("trapper") &&
        targetLive(row.tmux_target) === true,
    );
    const { code, stdout } = await stopping;

    assert.equal(observed, true, "the marker must be live while the row is still running and the pane still up");
    assert.equal(code, 0, stdout);
    assert.match(stdout, /^trapper: stopped \(killed after 2s\)$/m);
    assert.equal(runningRow("trapper"), undefined);
    assert.equal(targetLive(row.tmux_target), false);
    assert.equal(
      db.prepare("SELECT 1 FROM kv WHERE project_id = ? AND key = ?").get(projectId, `stopping:${row.id}`),
      undefined,
      "a finished stop clears its own marker",
    );
  });

  it("leaves copy mode before C-c, where tmux would read it as cancel rather than SIGINT", needsTmux, async () => {
    assert.equal((await runCli(["start", "api"], opts)).code, 0);
    const target = runningRow("api").tmux_target;
    tmux("copy-mode", "-t", target);
    assert.equal(tmux("display-message", "-p", "-t", target, "#{pane_in_mode}"), "1", "the fixture needs copy mode");

    const { code, stdout } = await runCli(["stop", "api"], opts);

    assert.equal(code, 0, stdout);
    assert.match(stdout, /^api: stopped \(C-c\)$/m, "the graceful leg must still be the one that ends it");
    assert.equal(targetLive(target), false);
  });

  it("stops every command row on --all and leaves a worker row alone", needsTmux, async () => {
    assert.equal((await runCli(["start", "api"], opts)).code, 0);
    assert.equal((await runCli(["start", "queue"], opts)).code, 0);
    const workerPane = tmux(
      "split-window", "-P", "-F", "#{pane_id}", "-t", findProjectWindow(session, projectId), "-c", dirs.projectDir, "sleep 600",
    );
    db.prepare(
      `INSERT INTO agents (project_id, actor_id, name, tmux_target, tmux_socket, command, cwd, kind, status)
       VALUES (?, 'agent:9001', 'helper', ?, '', 'claude', ?, 'agent', 'running')`,
    ).run(projectId, workerPane, dirs.projectDir);

    const { code, stdout } = await runCli(["stop", "--all"], opts);

    assert.equal(code, 0, stdout);
    assert.match(stdout, /^api: stopped \(C-c\)$/m);
    assert.match(stdout, /^queue: stopped \(C-c\)$/m);
    assert.equal(runningRow("api"), undefined);
    assert.equal(runningRow("queue"), undefined);
    assert.ok(runningRow("helper"), "a worker is never stopped by anything in this lane");
    assert.equal(targetLive(workerPane), true, "the worker's pane must still be up");
  });
});
