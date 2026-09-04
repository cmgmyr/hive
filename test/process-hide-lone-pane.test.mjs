import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { isolateTmux, panesIn, runCli, scratchDirs, seedTrustedYml, tmux } from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("hiding a process that is alone in the project window");

const dirs = scratchDirs();
const opts = { cwd: dirs.projectDir, dataDir: dirs.dataDir, tmp: dirs.tmp };
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { db } = await import("../dist/db.js");
const { createWindow, ensureSession, findProcessesWindow, findProjectWindow, paneWindow, sessionName } =
  await import("../dist/tmux.js");

const needsTmux = { skip: hasTmux ? false : "tmux is not installed" };

let projectId;
let projectName;
let session;
let projectWindow;

const targetFor = (name) =>
  db
    .prepare("SELECT tmux_target FROM agents WHERE project_id = ? AND name = ? AND status = 'running'")
    .get(projectId, name)?.tmux_target;

const option = (window, name) => tmux("display-message", "-p", "-t", window, `#{${name}}`);

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
    processes: { api: { command: "sleep 600", visible: false } },
  });

  if (!hasTmux) return;

  ensureSession(session, dirs.projectDir, { bare: true });
  const made = createWindow(session, projectName, dirs.projectDir, [], "sleep 600", projectId, true, false);
  projectWindow = made.window;
  await runCli(["start", "api"], opts);
  await runCli(["show", "api"], opts);

  // Leave the process alone in the project window, the way quitting the lead does.
  tmux("kill-pane", "-t", made.pane);
});

after(() => cleanup(session));

describe("hive hide refuses when the process is the only pane in the project's window (todo 767)", () => {
  it("fixture check: the process is shown, alone in the project window, with no processes window left", needsTmux, () => {
    assert.equal(paneWindow(targetFor("api")).split(":")[1], projectWindow.split(":")[1]);
    assert.equal(panesIn(projectWindow).length, 1);
    assert.equal(
      findProcessesWindow(session, projectId),
      undefined,
      "showing the last tile destroys the processes window; without that this test proves nothing",
    );
  });

  it("says there is nothing to hide it behind, and moves nothing", needsTmux, async () => {
    const before = targetFor("api");
    const { code, stdout } = await runCli(["hide", "api"], opts);

    assert.equal(code, 0, stdout);
    assert.match(stdout, /api: it is the only pane in this project's window/);
    assert.match(stdout, /start the lead \(hive\) first/);
    assert.equal(paneWindow(before).split(":")[1], projectWindow.split(":")[1], "the pane must not have moved");
  });

  it("leaves the project's window owning only itself, never carrying both stamps", needsTmux, () => {
    assert.equal(option(projectWindow, "@hive-project-id"), String(projectId));
    assert.equal(option(projectWindow, "@hive-processes-of"), "");
    assert.equal(option(projectWindow, "window_name"), projectName);
    assert.equal(findProjectWindow(session, projectId).split(":")[1], projectWindow.split(":")[1]);
  });

  it("still finds no processes window afterwards, so nothing was half-created", needsTmux, () => {
    assert.equal(findProcessesWindow(session, projectId), undefined);
  });
});
