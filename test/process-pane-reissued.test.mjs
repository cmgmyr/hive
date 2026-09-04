import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { isolateTmux, panesIn, runCli, scratchDirs, seedTrustedYml, tmux } from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("the reissued-pane show/hide tests");

const dirs = scratchDirs();
const opts = { cwd: dirs.projectDir, dataDir: dirs.dataDir, tmp: dirs.tmp };
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { db } = await import("../dist/db.js");
const { createWindow, ensureSession, sessionName } = await import("../dist/tmux.js");

const needsTmux = { skip: hasTmux ? false : "tmux is not installed" };
const STRANGER = "someone-elses";

let projectId;
let session;
let recorded;
let strangerWindow;

const rowFor = (name) =>
  db
    .prepare("SELECT tmux_target, tmux_socket, pane_pid, status FROM agents WHERE project_id = ? AND name = ?")
    .get(projectId, name);

const paneWindowOf = (pane) => tmux("display-message", "-p", "-t", pane, "#{window_id}");
const windowsIn = (name) => tmux("list-windows", "-t", `=${name}`, "-F", "#{window_id}").split("\n").filter(Boolean);
const panePidOf = (pane) => tmux("display-message", "-p", "-t", pane, "#{pane_pid}");

function serverIsGone() {
  try {
    tmux("list-sessions", "-F", "#{session_name}");
    return false;
  } catch {
    return true;
  }
}

// A fresh server hands out pane ids from %0 again, which is the whole point of the fixture. Killing
// every session is how a test gets there: `kill-server` is forbidden in this suite, and `exit-empty`
// may have been turned off by the trace helper.
function restartTmuxServer() {
  tmux("set", "-s", "exit-empty", "on");
  for (const name of tmux("list-sessions", "-F", "#{session_name}").split("\n").filter(Boolean)) {
    try {
      tmux("kill-session", "-t", `=${name}`);
    } catch {

    }
  }
  for (let i = 0; i < 40 && !serverIsGone(); i += 1) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  assert.equal(serverIsGone(), true, "the fixture needs the old server gone before the new one starts");
}

before(async () => {
  const init = await runCli(["init"], opts);
  assert.equal(init.code, 0, init.stderr);
  const project = db.prepare("SELECT id, name FROM projects LIMIT 1").get();
  projectId = project.id;
  session = sessionName();
  await seedTrustedYml({
    db,
    projectId,
    projectDir: dirs.projectDir,
    processes: { api: { command: "sleep 600", visible: false } },
  });

  if (!hasTmux) return;

  ensureSession(session, dirs.projectDir, { bare: true });
  createWindow(session, project.name, dirs.projectDir, [], "sleep 600", projectId, true, false);
  const started = await runCli(["start", "api"], opts);
  assert.equal(started.code, 0, started.stdout + started.stderr);
  recorded = rowFor("api");
  assert.match(recorded.tmux_target, /^%\d+$/);
  assert.notEqual(recorded.pane_pid, "");

  restartTmuxServer();

  // The project window has to exist on the NEW server too, or show would refuse for the unrelated
  // reason that there is nowhere to show it, and the pin would pass without the pid compare.
  ensureSession(session, dirs.projectDir, { bare: true });
  createWindow(session, project.name, dirs.projectDir, [], "sleep 600", projectId, true, false);

  strangerWindow = tmux(
    "new-session", "-d", "-P", "-F", "#{window_id}", "-s", STRANGER, "-n", "not-hive", "sleep", "600",
  );
  for (let i = 0; i < 4; i += 1) tmux("split-window", "-d", "-t", strangerWindow, "sleep", "600");
});

after(() => cleanup(session, STRANGER));

describe("hive show and hive hide refuse a pane id the server has reissued (todo 767)", () => {
  it("hands the recorded pane id to a stranger's pane on the new server (fixture check)", needsTmux, () => {
    assert.equal(panesIn(strangerWindow).length, 5);
    assert.equal(
      panesIn(strangerWindow).includes(recorded.tmux_target),
      true,
      "the fixture is vacuous unless the recorded pane id names a live pane again",
    );
    assert.equal(paneWindowOf(recorded.tmux_target), strangerWindow);
    assert.notEqual(panePidOf(recorded.tmux_target), recorded.pane_pid);
    assert.equal(rowFor("api").status, "running", "the stale row must still say running");
  });

  it("refuses show, leaving the stranger's window whole", needsTmux, async () => {
    const { code, stdout } = await runCli(["show", "api"], opts);

    assert.equal(panesIn(strangerWindow).length, 5, "join-pane must not have taken a pane out of it");
    assert.equal(paneWindowOf(recorded.tmux_target), strangerWindow);
    assert.equal(code, 0, stdout);
    assert.match(stdout, /api: not running \(start with: hive start "api"\)/);
  });

  it("refuses hide, breaking no pane out into a processes window", needsTmux, async () => {
    const { code, stdout } = await runCli(["hide", "api"], opts);

    assert.equal(panesIn(strangerWindow).length, 5, "break-pane must not have taken a pane out of it");
    assert.equal(paneWindowOf(recorded.tmux_target), strangerWindow);
    assert.deepEqual(windowsIn(STRANGER), [strangerWindow], "break-pane must not have made a processes window here");
    assert.equal(code, 0, stdout);
    assert.match(stdout, /api: not running \(start with: hive start "api"\)/);
  });
});
