import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { clearHiveEnv, crashPane, isolateTmux, runCli, scratchDirs, seedTrustedYml, tmux, until } from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("the dead-process notice tests");

clearHiveEnv();
const dirs = scratchDirs();
const opts = { cwd: dirs.projectDir, dataDir: dirs.dataDir, tmp: dirs.tmp };
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { db } = await import("../dist/db.js");
const { createWindow, ensureSession, findProjectWindow, sessionName, targetLive } = await import("../dist/tmux.js");
const { janitor } = await import("../dist/scheduler.js");

const needsTmux = { skip: hasTmux ? false : "tmux is not installed" };

let projectId;
let projectName;
let session;
let leadPane;

const noticeBodies = () =>
  db
    .prepare("SELECT body FROM wakes WHERE project_id = ? AND cancelled_at IS NULL ORDER BY id")
    .all(projectId)
    .map((r) => r.body);

const paneOf = (name) =>
  db
    .prepare("SELECT tmux_target FROM agents WHERE project_id = ? AND name = ? AND status = 'running'")
    .get(projectId, name)?.tmux_target;


// The sweep only looks at rows older than its settle window, so a row started this second is
// invisible to it however dead its pane is.
const ageRows = () =>
  db.prepare("UPDATE agents SET created_at = datetime('now', '-10 minutes') WHERE kind = 'command'").run();

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
    processes: { api: { command: "sleep 600", visible: false }, queue: { command: "sleep 600", visible: false } },
  });

  if (!hasTmux) return;
  ensureSession(session, dirs.projectDir, { bare: true });
  createWindow(session, projectName, dirs.projectDir, [], "sleep 600", projectId, true, false);
  leadPane = tmux("list-panes", "-t", findProjectWindow(session, projectId), "-F", "#{pane_id}").split("\n")[0];
  db.prepare(
    `INSERT INTO agents (project_id, actor_id, name, tmux_target, tmux_socket, command, cwd, kind, status)
     VALUES (?, 'lead:900', 'lead', ?, '', 'claude', ?, 'lead', 'running')`,
  ).run(projectId, leadPane, dirs.projectDir);
});

after(() => cleanup(session));

describe("a process that dies on its own is reported to the lead once; a stopped one never is (todo 765)", () => {
  it("files one lead-bound notice naming the process and the command that restarts it", needsTmux, async () => {
    assert.equal((await runCli(["start", "api"], opts)).code, 0);
    const pane = paneOf("api");
    crashPane(pane);
    assert.equal(await until(() => targetLive(pane) === false), true, "the fixture needs that pane gone");
    ageRows();

    janitor();

    assert.deepEqual(noticeBodies(), [
      `[hive] process "api" exited on its own; its pane is gone. Restart it with: hive start "api"`,
    ]);
    const notice = db.prepare("SELECT * FROM wakes WHERE project_id = ? ORDER BY id DESC LIMIT 1").get(projectId);
    assert.equal(notice.deliver_pane, leadPane, "it has to be aimed at the lead's own pane");
    assert.equal(notice.parent_wake_id, null, "parentless, so nothing can age out a report of a death");
  });

  it("files nothing more on the next sweep, because the row it reported is already closed", needsTmux, () => {
    const before = noticeBodies().length;

    janitor();

    assert.equal(noticeBodies().length, before);
  });

  it("files nothing for a process taken down by hive stop", needsTmux, async () => {
    assert.equal((await runCli(["start", "queue"], opts)).code, 0);
    const before = noticeBodies().length;

    assert.match((await runCli(["stop", "queue"], opts)).stdout, /queue: stopped/);
    ageRows();
    janitor();

    assert.deepEqual(noticeBodies().length, before, "a deliberate stop is not a death and must be silent");
  });

  it("files nothing for a row whose stopping marker is live, which is what an interrupted stop leaves", needsTmux, async () => {
    assert.equal((await runCli(["start", "api"], opts)).code, 0);
    const row = db
      .prepare("SELECT id, tmux_target FROM agents WHERE project_id = ? AND name = 'api' AND status = 'running'")
      .get(projectId);
    const before = noticeBodies().length;

    db.prepare(
      `INSERT INTO kv (project_id, key, value, updated_by, expires_at)
       VALUES (?, ?, '"stopping"', 'test', datetime('now', '+30 seconds'))`,
    ).run(projectId, `stopping:${row.id}`);
    crashPane(row.tmux_target);
    assert.equal(await until(() => targetLive(row.tmux_target) === false), true);
    ageRows();
    janitor();

    assert.equal(
      db.prepare("SELECT status FROM agents WHERE id = ?").get(row.id).status,
      "closed",
      "the row is still swept; only the notice is suppressed",
    );
    assert.equal(noticeBodies().length, before, "a stop that was interrupted is not a crash report");
    db.prepare("DELETE FROM kv WHERE project_id = ? AND key = ?").run(projectId, `stopping:${row.id}`);
  });

  it("files nothing when the swept row is a worker, which has its own reporting", needsTmux, async () => {
    const workerPane = tmux(
      "split-window", "-P", "-F", "#{pane_id}", "-t", findProjectWindow(session, projectId), "-c", dirs.projectDir,
      "sleep 600",
    );
    db.prepare(
      `INSERT INTO agents (project_id, actor_id, name, tmux_target, tmux_socket, command, cwd, kind, status, created_at)
       VALUES (?, 'agent:901', 'helper', ?, '', 'claude', ?, 'agent', 'running', datetime('now', '-10 minutes'))`,
    ).run(projectId, workerPane, dirs.projectDir);
    const before = noticeBodies().length;

    crashPane(workerPane);
    assert.equal(await until(() => targetLive(workerPane) === false), true);
    janitor();

    assert.equal(
      db.prepare("SELECT status FROM agents WHERE actor_id = 'agent:901'").get().status,
      "closed",
      "the fixture needs that row actually swept",
    );
    assert.equal(noticeBodies().length, before);
  });

  it("mints nothing when the lead's row is still running but its pane is dead", needsTmux, async () => {
    const deadPane = tmux(
      "split-window", "-P", "-F", "#{pane_id}", "-t", findProjectWindow(session, projectId), "-c", dirs.projectDir,
      "sleep 600",
    );
    crashPane(deadPane);
    assert.equal(await until(() => targetLive(deadPane) === false), true);
    db.prepare("UPDATE agents SET tmux_target = ? WHERE kind = 'lead'").run(deadPane);
    assert.equal((await runCli(["start", "api"], opts)).code, 0);
    const pane = paneOf("api");
    const before = noticeBodies().length;

    crashPane(pane);
    assert.equal(await until(() => targetLive(pane) === false), true);
    ageRows();
    janitor();

    assert.equal(noticeBodies().length, before, "a notice nobody could ever be told is never written");
  });
});
