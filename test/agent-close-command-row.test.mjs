import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { isolateTmux, McpClient, runCli, scratchDirs, seedTrustedYml, until } from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("the agent_close-on-a-process tests");

const dirs = scratchDirs();
const opts = { cwd: dirs.projectDir, dataDir: dirs.dataDir, tmp: dirs.tmp };
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { db } = await import("../dist/db.js");
const { createWindow, ensureSession, findProjectWindow, sessionName, targetLive } = await import("../dist/tmux.js");
const { janitor } = await import("../dist/scheduler.js");

let mcp;
let projectId;
let session;

const runningRow = (name) =>
  db.prepare("SELECT * FROM agents WHERE project_id = ? AND name = ? AND status = 'running'").get(projectId, name);

const noticeCount = () =>
  db.prepare("SELECT COUNT(*) AS n FROM wakes WHERE project_id = ? AND cancelled_at IS NULL").get(projectId).n;

before(async () => {
  assert.equal((await runCli(["init"], opts)).code, 0);
  const project = db.prepare("SELECT id, name FROM projects LIMIT 1").get();
  projectId = project.id;
  session = sessionName();
  await seedTrustedYml({
    db,
    projectId,
    projectDir: dirs.projectDir,
    processes: {
      api: { command: "sleep 600", visible: false },
      trapper: { command: "trap '' INT; sleep 600", visible: false },
    },
  });
  mcp = new McpClient({ cwd: dirs.projectDir, dataDir: dirs.dataDir });
  await mcp.start();
  if (!hasTmux) return;
  ensureSession(session, dirs.projectDir, { bare: true });
  createWindow(session, project.name, dirs.projectDir, [], "sleep 600", projectId, true, false);
  db.prepare(
    `INSERT INTO agents (project_id, actor_id, name, tmux_target, tmux_socket, command, cwd, kind, status)
     VALUES (?, 'lead:910', 'lead', ?, '', 'claude', ?, 'lead', 'running')`,
  ).run(projectId, findProjectWindow(session, projectId), dirs.projectDir);
});

after(async () => {
  await mcp.close();
  cleanup(session);
});

describe("agent_close of a hive.yml process is a stop, not a bare kill (todo 765)", { skip: hasTmux ? false : "tmux is not installed" }, () => {
  it("takes the graceful leg and says which one, instead of SIGHUP with no receipt", async () => {
    assert.equal((await runCli(["start", "api"], opts)).code, 0);
    const row = runningRow("api");

    const receipt = await mcp.call("agent_close", { agent_id: row.id });

    assert.equal(receipt.closed, true);
    assert.equal(receipt.stop_leg, "interrupted", "a bare kill-pane could never report the C-c leg");
    assert.match(receipt.note, /api: stopped \(C-c\)/);
    assert.equal(runningRow("api"), undefined);
    assert.equal(await until(() => targetLive(row.tmux_target) === false), true);
  });

  it("files no dead-process notice, because it wrote the stopping marker like any other stop", async () => {
    assert.equal((await runCli(["start", "trapper"], opts)).code, 0);
    const row = runningRow("trapper");
    const before = noticeCount();

    const receipt = await mcp.call("agent_close", { agent_id: row.id });

    assert.equal(receipt.stop_leg, "killed");
    db.prepare("UPDATE agents SET created_at = datetime('now', '-10 minutes') WHERE kind = 'command'").run();
    janitor();

    assert.equal(noticeCount(), before, "a deliberate close is never reported as a crash");
  });

  it("refuses to park a process, which has no conversation to resume", async () => {
    assert.equal((await runCli(["start", "api"], opts)).code, 0);
    const row = runningRow("api");

    await assert.rejects(
      () => mcp.call("agent_park", { agent_id: row.id }),
      /hive\.yml process, not a worker session/,
    );
    assert.ok(runningRow("api"), "a refused park must leave the process running");
  });
});
