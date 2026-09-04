import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { isolateTmux, runCli, scratchDirs, seedTrustedYml } from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("the process surfaces tests");

const dirs = scratchDirs();
const opts = { cwd: dirs.projectDir, dataDir: dirs.dataDir, tmp: dirs.tmp };
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { db } = await import("../dist/db.js");
const { renderDashboard } = await import("../dist/dashboard.js");
const { snapshotProcesses } = await import("../dist/processes.js");
const { createWindow, ensureSession, sessionName } = await import("../dist/tmux.js");

const needsTmux = { skip: hasTmux ? false : "tmux is not installed" };

let projectId;
let projectName;
let session;

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
      web: { command: "sleep 600", visible: false },
      never: { command: "sleep 600", visible: false },
    },
  });

  if (!hasTmux) return;

  ensureSession(session, dirs.projectDir, { bare: true });
  createWindow(session, projectName, dirs.projectDir, [], "sleep 600", projectId, true, false);
  await runCli(["start", "api"], opts);
  await runCli(["start", "web"], opts);
  await runCli(["show", "web"], opts);
});

after(() => cleanup(session));

describe("status, doctor and the dashboard report where each process is (todo 767)", () => {
  it("labels a command row hidden or shown in hive status instead of a flat running", needsTmux, async () => {
    const { code, stdout } = await runCli(["status"], opts);

    assert.equal(code, 0, stdout);
    assert.match(stdout, /cmd\s+api\s+hidden/);
    assert.match(stdout, /cmd\s+web\s+shown/);
  });

  it("counts running, hidden and defined-not-running processes in one doctor line", needsTmux, async () => {
    const { stdout } = await runCli(["doctor"], opts);

    assert.match(stdout, /processes: 2 running \(1 hidden\), 1 defined not running/);
  });

  it("says nothing about processes in doctor for a project that defines none", needsTmux, async () => {
    const other = scratchDirs();
    const otherOpts = { cwd: other.projectDir, dataDir: dirs.dataDir, tmp: other.tmp };
    const init = await runCli(["init", "--no-profile"], otherOpts);
    assert.equal(init.code, 0, init.stderr);

    const { stdout } = await runCli(["doctor"], otherOpts);

    assert.doesNotMatch(stdout, /processes:/);
  });

  it("puts the same counts on the dashboard's processes card and section", needsTmux, () => {
    const html = renderDashboard(projectId, snapshotProcesses(projectId));

    assert.match(html, /id="stat-processes"/);
    assert.match(html, /id="section-processes"/);
    assert.match(html, /1 hidden · 1 not started/);
    assert.match(html, /2 running, 1 not started/);
  });

  it("shows a defined but unstarted process as a row, so the section says what could be started", needsTmux, () => {
    const html = renderDashboard(projectId, snapshotProcesses(projectId));

    assert.match(html, /not started/);
    assert.match(html, />never</);
  });

  it("keeps command rows out of the workers card, where they had no state to report", needsTmux, () => {
    const html = renderDashboard(projectId, snapshotProcesses(projectId));
    const card = html.slice(html.indexOf('id="stat-workers"'), html.indexOf('id="stat-processes"'));

    assert.doesNotMatch(card, /no log event recorded/);
    assert.doesNotMatch(card, />api</);
    assert.doesNotMatch(card, />web</);
  });
});
