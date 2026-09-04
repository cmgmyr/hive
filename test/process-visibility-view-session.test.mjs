import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { dirname } from "node:path";
import { after, before, describe, it } from "node:test";

import {
  isolateTmux,
  makeFakeClaude,
  runCli,
  scratchDirs,
  seedTrustedYml,
  sleep,
  tmux,
} from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("process visibility under a grouped view session");

const dirs = scratchDirs();
const opts = { cwd: dirs.projectDir, dataDir: dirs.dataDir, tmp: dirs.tmp };
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { db } = await import("../dist/db.js");
const { paneVisibility, paneWindow, projectWindows, resolveAttachTarget, sessionName, viewSessionName } =
  await import("../dist/tmux.js");

const needsTmux = { skip: hasTmux ? false : "tmux is not installed" };

function hasSession(name) {
  try {
    execFileSync("tmux", ["has-session", "-t", `=${name}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

let projectId;
let session;
let viewClient;

const targetFor = (name) =>
  db
    .prepare("SELECT tmux_target FROM agents WHERE project_id = ? AND name = ? AND status = 'running'")
    .get(projectId, name)?.tmux_target;

before(async () => {
  const init = await runCli(["init"], opts);
  assert.equal(init.code, 0, init.stderr);
  projectId = db.prepare("SELECT id FROM projects LIMIT 1").get().id;
  session = sessionName();
  await seedTrustedYml({
    db,
    projectId,
    projectDir: dirs.projectDir,
    processes: { api: { command: "sleep 600", visible: false } },
  });

  if (!hasTmux) return;

  const claude = makeFakeClaude(dirs.tmp)("sleep 600");
  const led = await runCli(["lead"], { ...opts, env: { PATH: `${dirname(claude)}:${process.env.PATH}` } });
  assert.equal(led.code, 0, led.stderr);
  await runCli(["start", "api"], opts);

  const args = resolveAttachTarget(session, projectId, false);
  viewClient = spawn("tmux", ["-C", ...args], { stdio: ["pipe", "pipe", "pipe"] });
  await sleep(400);
  assert.ok(hasSession(viewSessionName()), "the view must exist before any assertion below means anything");
});

after(async () => {
  if (viewClient) viewClient.kill("SIGTERM");
  await sleep(300);
  if (hasSession(viewSessionName())) tmux("kill-session", "-t", `=${viewSessionName()}`);
  cleanup(session);
});

describe("a process stays locatable once a human's view session is grouped onto the project (todo 767)", () => {
  it("fixture check: with a view grouped, paneWindow answers the process's pane with the VIEW's name", needsTmux, () => {
    const reported = paneWindow(targetFor("api"));

    assert.equal(
      reported,
      `${viewSessionName()}:${reported.split(":")[1]}`,
      `the defect surface must be real for this file to mean anything - got ${reported}`,
    );
  });

  it("still reads the pane as hidden, because only the window id is load-bearing", needsTmux, () => {
    assert.equal(paneVisibility(targetFor("api"), projectWindows(session, projectId)), "hidden");
  });

  it("hive hide of an already-hidden process says so instead of failing on a join-pane", needsTmux, async () => {
    const { code, stdout, stderr } = await runCli(["hide", "api"], opts);

    assert.equal(code, 0, stdout + stderr);
    assert.match(stdout, /api: already hidden/);
    assert.doesNotMatch(stdout + stderr, /source and target panes must be different/);
  });

  it("hive status still labels it hidden rather than falling back to running", needsTmux, async () => {
    const { code, stdout } = await runCli(["status"], opts);

    assert.equal(code, 0, stdout);
    assert.match(stdout, /cmd\s+api\s+hidden/);
  });
});
