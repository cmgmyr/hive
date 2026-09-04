import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { isolateTmux, panesIn, runCli, scratchDirs, seedTrustedYml } from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("the join-under-claim tests");

const dirs = scratchDirs();
const opts = { cwd: dirs.projectDir, dataDir: dirs.dataDir, tmp: dirs.tmp };
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { db } = await import("../dist/db.js");
const { createWindow, ensureSession, findProcessesWindow, findProjectWindow, paneWindow, sessionName } = await import(
  "../dist/tmux.js"
);

const needsTmux = { skip: hasTmux ? false : "tmux is not installed" };
const ITERATIONS = 12;

let projectId;
let session;

const targetFor = (name) =>
  db
    .prepare("SELECT tmux_target FROM agents WHERE project_id = ? AND name = ? AND status = 'running'")
    .get(projectId, name)?.tmux_target;

// hide of api resolves the processes window; show of worker takes the last tile out of that same
// window, which destroys it. Whichever order they land in, both must succeed.
async function raceHideAgainstShow() {
  return Promise.all([runCli(["hide", "api"], opts), runCli(["show", "worker"], opts)]);
}

async function resetToOneHiddenTile() {
  await runCli(["hide", "worker"], opts);
  await runCli(["show", "api"], opts);
  const processesWindow = findProcessesWindow(session, projectId);
  assert.ok(processesWindow, "reset must leave a processes window for hide to resolve");
  assert.deepEqual(panesIn(processesWindow), [targetFor("worker")], "worker must be its only tile");
  assert.equal(paneWindow(targetFor("api")), findProjectWindow(session, projectId));
  return processesWindow;
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
      worker: { command: "sleep 600", visible: false },
    },
  });

  if (!hasTmux) return;

  ensureSession(session, dirs.projectDir, { bare: true });
  createWindow(session, project.name, dirs.projectDir, [], "sleep 600", projectId, true, false);
  await runCli(["start", "api"], opts);
  await runCli(["start", "worker"], opts);
});

after(() => cleanup(session));

describe("hive show and hive hide read their target window under the claim they act in (todo 767)", () => {
  it("puts the reset state one pane away from destroying the processes window (fixture check)", needsTmux, async () => {
    const processesWindow = await resetToOneHiddenTile();
    const { code } = await runCli(["show", "worker"], opts);

    assert.equal(code, 0);
    assert.equal(
      findProcessesWindow(session, projectId),
      undefined,
      "the race needs showing that tile to destroy the window hide resolves",
    );
    assert.notEqual(processesWindow, undefined);
  });

  it("never lets a concurrent show destroy the window a hide already resolved", needsTmux, async () => {
    const failures = [];
    for (let i = 0; i < ITERATIONS; i += 1) {
      await resetToOneHiddenTile();
      for (const run of await raceHideAgainstShow()) {
        if (run.code !== 0) failures.push(`iteration ${i}: exit ${run.code}: ${run.stdout.trim()}${run.stderr.trim()}`);
      }
    }

    assert.deepEqual(failures, [], "a window id read outside the claim is stale by the time join-pane runs");
  });
});
