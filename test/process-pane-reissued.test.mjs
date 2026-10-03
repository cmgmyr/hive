import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import {
  fakeFailingTmux,
  isolateTmux,
  McpClient,
  panesIn,
  recordingTmux,
  runCli,
  scratchDirs,
  seedTrustedYml,
  sleep,
  tmux,
  tmuxCallsIn,
} from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("the reissued-pane show/hide tests");

const dirs = scratchDirs();
const opts = { cwd: dirs.projectDir, dataDir: dirs.dataDir, tmp: dirs.tmp };
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { db } = await import("../dist/db.js");
const { createWindow, ensureSession, sessionName, tmuxSocketPath } = await import("../dist/tmux.js");

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
    processes: {
      api: { command: "sleep 600", visible: false },
      stale: { command: "sleep 600", visible: false },
      trapper: { command: "trap '' INT; sleep 600", visible: false },
    },
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

const OWN_SOCKET = () => tmuxSocketPath(process.env.TMUX, process.env.TMUX_TMPDIR);
const FOREIGN_SOCKET = "/nonexistent/foreign-socket-dir/tmux-0/default";
const SIGNALLING_VERBS = new Set(["send-keys", "kill-pane", "kill-window", "paste-buffer"]);

function seedStale({ pid, socket = OWN_SOCKET() }) {
  return db
    .prepare(
      `INSERT INTO agents (project_id, name, tmux_target, tmux_socket, pane_pid, command, cwd, kind, status)
       VALUES (?, 'stale', ?, ?, ?, 'sleep 600', ?, 'command', 'running') RETURNING id`,
    )
    .get(projectId, recorded.tmux_target, socket, pid, dirs.projectDir).id;
}

const statusOf = (id) => db.prepare("SELECT status FROM agents WHERE id = ?").get(id).status;

async function stopsNothing(trigger) {
  const pidBefore = panePidOf(recorded.tmux_target);
  const log = join(mkdtempSync(join(tmpdir(), "hive-stopguard-")), "calls.log");
  const out = await trigger({ PATH: `${recordingTmux({ log })}:${process.env.PATH}` });
  assert.equal(panePidOf(recorded.tmux_target), pidBefore, "the stranger's process must survive");
  assert.equal(panesIn(strangerWindow).length, 5);
  const signalling = tmuxCallsIn(log)
    .map((argv) => argv.find((a) => !a.startsWith("-")))
    .filter((verb) => SIGNALLING_VERBS.has(verb));
  assert.deepEqual(signalling, [], "no copy-mode cancel, C-c or kill may reach a pane the row does not own");
  return out;
}

const TRIGGERS = {
  "hive stop <name>": async (env) => (await runCli(["stop", "stale"], { ...opts, env })).stdout,
  "hive stop --all": async (env) => (await runCli(["stop", "--all"], { ...opts, env })).stdout,
  agent_close: async (env) => {
    const mcp = new McpClient({ cwd: dirs.projectDir, dataDir: dirs.dataDir, env });
    await mcp.start();
    try {
      return JSON.stringify(await mcp.call("agent_close", { name: "stale" }));
    } catch (err) {
      return err.message;
    } finally {
      await mcp.close();
    }
  },
};

describe("stopProcess acts only on a command row that owns its pane", () => {
  beforeEach(() => db.prepare("DELETE FROM agents WHERE project_id = ? AND name = 'stale'").run(projectId));

  for (const [trigger, run] of Object.entries(TRIGGERS)) {
    it(`${trigger} leaves an empty-pid row running and the stranger untouched, naming unknown ownership`, needsTmux, async () => {
      const id = seedStale({ pid: "" });
      const out = await stopsNothing(run);
      assert.match(out, /ownership (is|reads) unknown/);
      assert.equal(statusOf(id), "running");
    });

    it(`${trigger} leaves a foreign-socket row running and the stranger untouched`, needsTmux, async () => {
      const id = seedStale({ pid: recorded.pane_pid, socket: FOREIGN_SOCKET });
      const out = await stopsNothing(run);
      assert.match(out, /ownership (is|reads) unknown/);
      assert.equal(statusOf(id), "running");
    });

    it(`${trigger} retires a reissued row without signalling the stranger now holding its pane id`, needsTmux, async () => {
      const id = seedStale({ pid: recorded.pane_pid });
      const out = await stopsNothing(run);
      assert.match(out, /pane id now belongs to another process|ownership read reissued/);
      assert.equal(statusOf(id), "closed");
    });
  }

  it("hive stop leaves the row running when the tmux probe fails", needsTmux, async () => {
    const id = seedStale({ pid: panePidOf(recorded.tmux_target) });
    const failing = { PATH: `${fakeFailingTmux({ failOn: "list-panes" })}:${process.env.PATH}` };
    const { stdout } = await runCli(["stop", "stale"], { ...opts, env: failing });
    assert.match(stdout, /tmux could not be probed, so hive left it running/);
    assert.equal(statusOf(id), "running");
  });

  it("does not fall back to kill-pane when the row records a different pane during the grace period", needsTmux, async () => {
    const started = await runCli(["start", "trapper"], opts);
    assert.equal(started.code, 0, started.stdout + started.stderr);
    const row = rowFor("trapper");
    try {
      const stopping = runCli(["stop", "trapper"], opts);
      await sleep(600);
      db.prepare("UPDATE agents SET pane_pid = '1' WHERE project_id = ? AND name = 'trapper' AND status = 'running'").run(projectId);
      const { stdout } = await stopping;
      assert.match(stdout, /trapper: its row was closed or recorded a different pane during the stop, so hive touched nothing further$/m);
      assert.equal(panePidOf(row.tmux_target), row.pane_pid, "the trapped process must not have been killed");
      assert.equal(rowFor("trapper").status, "running");
      const id = db.prepare("SELECT id FROM agents WHERE project_id = ? AND name = 'trapper' AND status = 'running'").get(projectId).id;
      const marker = db.prepare("SELECT 1 FROM kv WHERE project_id = ? AND key = ?").get(projectId, `stopping:${id}`);
      assert.equal(marker, undefined, "a stop that touched nothing must not leave its stopping marker behind");
    } finally {
      tmux("kill-pane", "-t", row.tmux_target);
      db.prepare("UPDATE agents SET status = 'closed' WHERE project_id = ? AND name = 'trapper'").run(projectId);
    }
  });

  it("agent_close reports closed:false when a command stop ends with the row still open", needsTmux, async () => {
    const started = await runCli(["start", "trapper"], opts);
    assert.equal(started.code, 0, started.stdout + started.stderr);
    const row = db
      .prepare("SELECT tmux_target, pane_pid FROM agents WHERE project_id = ? AND name = 'trapper' AND status = 'running'")
      .get(projectId);
    const mcp = new McpClient({ cwd: dirs.projectDir, dataDir: dirs.dataDir });
    await mcp.start();
    try {
      const closing = mcp.call("agent_close", { name: "trapper" });
      await sleep(600);
      db.prepare("UPDATE agents SET pane_pid = '1' WHERE project_id = ? AND name = 'trapper' AND status = 'running'").run(projectId);
      const receipt = await closing;
      assert.equal(receipt.closed, false);
      assert.equal(receipt.stop_leg, "unreachable");
      assert.equal(panePidOf(row.tmux_target), row.pane_pid);
    } finally {
      await mcp.close();
      tmux("kill-pane", "-t", row.tmux_target);
      db.prepare("UPDATE agents SET status = 'closed' WHERE project_id = ? AND name = 'trapper'").run(projectId);
    }
  });

  it("hive show and hide refuse an empty-pid row by naming unknown ownership, moving no pane", needsTmux, async () => {
    seedStale({ pid: "" });
    for (const verb of ["show", "hide"]) {
      const { stdout } = await runCli([verb, "stale"], opts);
      assert.match(stdout, /stale: its pane ownership is unknown/);
      assert.equal(panesIn(strangerWindow).length, 5);
      assert.deepEqual(windowsIn(STRANGER), [strangerWindow]);
    }
  });
});
