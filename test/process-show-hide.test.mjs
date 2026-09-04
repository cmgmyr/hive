import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { isolateTmux, paneField, panesIn, runCli, scratchDirs, seedTrustedYml, tmux } from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("the process show/hide tests");

const dirs = scratchDirs();
const opts = { cwd: dirs.projectDir, dataDir: dirs.dataDir, tmp: dirs.tmp };
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { db } = await import("../dist/db.js");
const {
  PROCESSES_WINDOW_OPTION,
  createWindow,
  ensureSession,
  findProcessesWindow,
  findProjectWindow,
  paneWindow,
  sessionName,
} = await import("../dist/tmux.js");

const needsTmux = { skip: hasTmux ? false : "tmux is not installed" };

let projectId;
let projectName;
let session;

const targetFor = (name) =>
  db
    .prepare("SELECT tmux_target FROM agents WHERE project_id = ? AND name = ? AND status = 'running'")
    .get(projectId, name)?.tmux_target;

const windowNameOf = (window) => tmux("display-message", "-p", "-t", window, "#{window_name}");

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
      worker: { command: "sleep 600", visible: false },
      never: { command: "sleep 600", visible: false },
    },
  });

  if (!hasTmux) return;

  // The project's own window has to exist, stamped, before a process can be shown beside it, and
  // `hive lead` is not runnable here - it would attach a real claude.
  ensureSession(session, dirs.projectDir, { bare: true });
  createWindow(session, projectName, dirs.projectDir, [], "sleep 600", projectId, true, false);
  await runCli(["start", "api"], opts);
  await runCli(["start", "worker"], opts);
});

after(() => cleanup(session));

describe("hive show and hive hide move a process pane between windows (todo 767)", () => {
  it("refuses a name hive.yml does not define, and lists the ones it does", async () => {
    const { code, stdout } = await runCli(["show", "nope"], opts);

    assert.equal(code, 1, stdout);
    assert.match(stdout, /No process "nope" in hive.yml\. Defined: api, worker/);
  });

  it("says a defined but unstarted process is not running, and names the command that starts it", async () => {
    const { code, stdout } = await runCli(["hide", "never"], opts);

    assert.equal(code, 0, stdout);
    assert.match(stdout, /never: not running \(start with: hive start "never"\)/);
  });

  it("rejects a flag rather than reading it as the optional path", async () => {
    const { code, stdout, stderr } = await runCli(["show", "api", "--force"], opts);

    assert.notEqual(code, 0);
    assert.match(stdout + stderr, /--force/);
  });

  it("starts both processes hidden in one processes window (fixture check)", needsTmux, () => {
    const window = findProcessesWindow(session, projectId);
    assert.ok(window, "the fixture needs both processes tiled in the processes window");
    assert.equal(panesIn(window).length, 2);
  });

  it("moves a pane into the project's window without changing its pane id, and retitles it", needsTmux, async () => {
    const before = targetFor("api");
    const { code, stdout } = await runCli(["show", "api"], opts);

    assert.equal(code, 0, stdout);
    assert.match(stdout, /api: shown/);
    assert.equal(targetFor("api"), before, "the row's pane id must survive join-pane");
    assert.equal(paneWindow(before), findProjectWindow(session, projectId));
    assert.equal(paneField(before, "#{pane_title}"), `${projectName}/api`);
  });

  it("says already shown rather than joining a pane that is already there", needsTmux, async () => {
    const { code, stdout } = await runCli(["show", "api"], opts);

    assert.equal(code, 0, stdout);
    assert.match(stdout, /api: already shown/);
  });

  it("reports a shown process as already running (shown) instead of starting a second copy", needsTmux, async () => {
    const running = db
      .prepare("SELECT COUNT(*) AS n FROM agents WHERE project_id = ? AND name = 'api' AND status = 'running'")
      .get(projectId).n;
    const { code, stdout } = await runCli(["start", "api"], opts);

    assert.equal(code, 0, stdout);
    assert.match(stdout, /api: already running \(shown\)/);
    assert.equal(
      db
        .prepare("SELECT COUNT(*) AS n FROM agents WHERE project_id = ? AND name = 'api' AND status = 'running'")
        .get(projectId).n,
      running,
    );
  });

  it("moves it back into the existing processes window and retitles it for the group", needsTmux, async () => {
    const before = targetFor("api");
    const { code, stdout } = await runCli(["hide", "api"], opts);

    assert.equal(code, 0, stdout);
    assert.match(stdout, /api: hidden/);
    assert.equal(targetFor("api"), before);
    assert.equal(paneWindow(before), findProcessesWindow(session, projectId));
    assert.equal(paneField(before, "#{pane_title}"), `${projectName}/processes · api`);
  });

  it("says already hidden rather than joining a pane that is already in the group", needsTmux, async () => {
    const { code, stdout } = await runCli(["hide", "api"], opts);

    assert.equal(code, 0, stdout);
    assert.match(stdout, /api: already hidden/);
  });

  it("rebuilds the processes window, stamp and all, when showing the last tile destroyed it", needsTmux, async () => {
    await runCli(["show", "api"], opts);
    const worker = targetFor("worker");
    const shown = await runCli(["show", "worker"], opts);
    assert.match(shown.stdout, /worker: shown/);
    assert.equal(
      findProcessesWindow(session, projectId),
      undefined,
      "tmux destroys a window when its last pane leaves; the fixture depends on that",
    );

    const { code, stdout } = await runCli(["hide", "worker"], opts);

    assert.equal(code, 0, stdout);
    assert.match(stdout, /worker: hidden/);
    const rebuilt = findProcessesWindow(session, projectId);
    assert.ok(rebuilt, "hide must recreate the window it could not find");
    assert.equal(targetFor("worker"), worker, "break-pane must not change the pane id the row stores");
    assert.equal(paneWindow(worker), rebuilt);
    assert.equal(windowNameOf(rebuilt), `${projectName}/processes`);
    assert.equal(tmux("display-message", "-p", "-t", rebuilt, `#{${PROCESSES_WINDOW_OPTION}}`), String(projectId));
    assert.equal(tmux("display-message", "-p", "-t", rebuilt, "#{@hive-owned}"), "1");
    assert.equal(tmux("display-message", "-p", "-t", rebuilt, "#{@hive-project-id}"), "");
  });

  it("leaves the project's own window stamped and findable after panes move through it", needsTmux, () => {
    assert.ok(findProjectWindow(session, projectId));
    assert.notEqual(findProjectWindow(session, projectId), findProcessesWindow(session, projectId));
  });
});
