import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { isolateTmux, paneField, panesIn, runCli, scratchDirs, seedTrustedYml, tmux } from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("the process placement tests");

const dirs = scratchDirs();
const opts = { cwd: dirs.projectDir, dataDir: dirs.dataDir, tmp: dirs.tmp };
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { db } = await import("../dist/db.js");
const { PROCESSES_WINDOW_OPTION, findProcessesWindow, findProjectWindow, paneWindow, sessionName, windowTitle } =
  await import("../dist/tmux.js");

const needsTmux = { skip: hasTmux ? false : "tmux is not installed" };

let projectId;
let projectName;
let session;

const rowFor = (name) =>
  db.prepare("SELECT tmux_target FROM agents WHERE project_id = ? AND name = ?").get(projectId, name);

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
      first: { command: "sleep 600", visible: false },
      api: { command: "sleep 600", visible: false },
      worker: { command: "sleep 600", visible: false },
      dev: { command: "sleep 600", visible: true },
      dev2: { command: "sleep 600", visible: true },
      envdev: { command: "sleep 600", visible: true },
    },
  });
});

after(() => cleanup(session));

describe("hive.yml visible:false places a process in the project's processes window (todo 767)", () => {
  it("gives the first process its own window when it is the one that opened the session, and says so", needsTmux, async () => {
    const { code, stdout } = await runCli(["start", "first"], opts);

    assert.equal(code, 0, stdout);
    assert.match(stdout, /started in its own window/);
    assert.equal(
      findProcessesWindow(session, projectId),
      undefined,
      "a session's initial window must never become the processes group",
    );
    assert.match(rowFor("first").tmux_target, /^%/);
  });

  it("tiles every later hidden process into ONE window found by its own stamp", needsTmux, async () => {
    const api = await runCli(["start", "api"], opts);
    const worker = await runCli(["start", "worker"], opts);

    assert.match(api.stdout, /started \(hidden\)/, api.stdout);
    assert.match(worker.stdout, /started \(hidden\)/, worker.stdout);

    const window = findProcessesWindow(session, projectId);
    assert.ok(window, "the stamp lookup must find the window the processes went into");
    assert.equal(paneWindow(rowFor("api").tmux_target), window);
    assert.equal(paneWindow(rowFor("worker").tmux_target), window);
    assert.equal(panesIn(window).length, 2);
    assert.equal(windowNameOf(window), `${projectName}/processes`);
  });

  it("records a PANE id for each process, never the window they share", needsTmux, () => {
    const targets = ["api", "worker"].map((name) => rowFor(name).tmux_target);
    for (const target of targets) assert.match(target, /^%/);
    assert.notEqual(targets[0], targets[1]);
  });

  it("titles each tile `<project>/processes · <name>` so a pane border names the process", needsTmux, () => {
    for (const name of ["api", "worker"]) {
      assert.equal(paneField(rowFor(name).tmux_target, "#{pane_title}"), `${projectName}/processes · ${name}`);
    }
  });

  it("leaves the processes window unstamped for @hive-project-id, so findProjectWindow never returns it", needsTmux, () => {
    const window = findProcessesWindow(session, projectId);
    assert.equal(tmux("display-message", "-p", "-t", window, "#{@hive-project-id}"), "");
    assert.notEqual(findProjectWindow(session, projectId), window);
  });

  it("reads the stamp as this project's id and no other project's", needsTmux, () => {
    const window = findProcessesWindow(session, projectId);
    assert.equal(tmux("display-message", "-p", "-t", window, `#{${PROCESSES_WINDOW_OPTION}}`), String(projectId));
    assert.equal(findProcessesWindow(session, projectId + 1000), undefined);
  });

  it("with no placement: set, a visible:true process now follows the split default a worker gets (todo 785)", needsTmux, async () => {
    const { code, stdout } = await runCli(["start", "dev"], opts);

    assert.equal(code, 0, stdout);
    assert.match(stdout, /dev: started$/m);
    assert.doesNotMatch(stdout, /hidden/);
    const window = paneWindow(rowFor("dev").tmux_target);
    assert.equal(
      windowNameOf(window),
      projectName,
      "split with no project window yet claims one and names it after the project, not the process",
    );
    assert.equal(findProjectWindow(session, projectId), window);
    assert.notEqual(window, findProcessesWindow(session, projectId));
  });

  it("titles a visible:true process's pane too, so a status line rendering #T never shows the hostname", needsTmux, () => {
    assert.equal(paneField(rowFor("dev").tmux_target, "#{pane_title}"), `${projectName}/dev`);
  });

  it("joins a second visible:true process into that same project window instead of opening another tab (todo 785)", needsTmux, async () => {
    const { code, stdout } = await runCli(["start", "dev2"], opts);

    assert.equal(code, 0, stdout);
    assert.match(stdout, /dev2: started$/m);
    const projectWindow = findProjectWindow(session, projectId);
    assert.equal(paneWindow(rowFor("dev2").tmux_target), projectWindow);
    assert.equal(paneWindow(rowFor("dev").tmux_target), projectWindow, "dev must still be there too");
    assert.equal(paneField(rowFor("dev2").tmux_target, "#{pane_title}"), `${projectName}/dev2`);
  });

  it("HIVE_SPAWN_PLACEMENT=window still overrides the split default and opens its own window (todo 785)", needsTmux, async () => {
    const { code, stdout } = await runCli(["start", "envdev"], { ...opts, env: { HIVE_SPAWN_PLACEMENT: "window" } });

    assert.equal(code, 0, stdout);
    assert.match(stdout, /envdev: started$/m);
    const window = paneWindow(rowFor("envdev").tmux_target);
    assert.equal(windowNameOf(window), windowTitle(projectName, "envdev"));
    assert.notEqual(window, findProjectWindow(session, projectId));
  });

  // dev2 has been beside the project window since it started (split), never moved there by `hive
  // show`; the show/hide fixture above only ever starts a process hidden, so this is the one case
  // it never covers (todo 785).
  it("says already shown for a split-placed process that started beside the lead, never via hive show", needsTmux, async () => {
    const { code, stdout } = await runCli(["show", "dev2"], opts);

    assert.equal(code, 0, stdout);
    assert.match(stdout, /dev2: already shown/);
  });

  it("hive hide still moves a split-placed process into the processes window", needsTmux, async () => {
    const { code, stdout } = await runCli(["hide", "dev2"], opts);

    assert.equal(code, 0, stdout);
    assert.match(stdout, /dev2: hidden/);
    assert.equal(paneWindow(rowFor("dev2").tmux_target), findProcessesWindow(session, projectId));
  });
});

describe("an explicit hive.yml placement: window sends a visible process to its own window (todo 785)", () => {
  let dir;
  let project;

  before(async () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "hive-test-placement-window-")));
    const init = await runCli(["init"], { cwd: dir, dataDir: dirs.dataDir, tmp: dirs.tmp });
    assert.equal(init.code, 0, init.stderr);
    project = db.prepare("SELECT id, name FROM projects WHERE path = ?").get(dir);
    await seedTrustedYml({
      db,
      projectId: project.id,
      projectDir: dir,
      processes: {
        widget: { command: "sleep 600", visible: true },
        quiet: { command: "sleep 600", visible: false },
      },
    });

    // seedTrustedYml only writes the `processes:` block; the `placement:` key this scenario needs
    // is top-level and does not affect a process's own trust hash, so it is safe to prepend after.
    const ymlPath = join(dir, "hive.yml");
    writeFileSync(ymlPath, `placement: window\n${readFileSync(ymlPath, "utf8")}`);
  });

  const targetFor = (name) =>
    db.prepare("SELECT tmux_target FROM agents WHERE project_id = ? AND name = ?").get(project.id, name).tmux_target;

  it("opens its own window named by the process's title", needsTmux, async () => {
    const { code, stdout } = await runCli(["start", "widget"], { cwd: dir, dataDir: dirs.dataDir, tmp: dirs.tmp });

    assert.equal(code, 0, stdout);
    assert.match(stdout, /widget: started$/m);
    const window = paneWindow(targetFor("widget"));
    assert.equal(windowNameOf(window), windowTitle(project.name, "widget"));
  });

  it("still tiles a visible:false process into <project>/processes despite placement: window (todo 785)", needsTmux, async () => {
    const { code, stdout } = await runCli(["start", "quiet"], { cwd: dir, dataDir: dirs.dataDir, tmp: dirs.tmp });

    assert.equal(code, 0, stdout);
    assert.match(stdout, /quiet: started \(hidden\)$/m);
    assert.equal(paneWindow(targetFor("quiet")), findProcessesWindow(session, project.id));
  });
});
