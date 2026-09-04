import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import {
  DIST,
  REPO,
  isolateTmux,
  runCli,
  runNode,
  runningCommandNames,
  scratchDirs,
  seedTrustedYml,
  tmux,
} from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("the SessionEnd hook tests");

const dirs = scratchDirs();
const opts = { cwd: dirs.projectDir, dataDir: dirs.dataDir, tmp: dirs.tmp };
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { db } = await import("../dist/db.js");
const { createWindow, ensureSession, sessionName, targetLive } = await import("../dist/tmux.js");

const needsTmux = { skip: hasTmux ? false : "tmux is not installed" };
const HOOK = join(DIST, "hook.js");
const payload = (name) => readFileSync(join(REPO, "test", "fixtures", "hook-payloads", name), "utf8");

const EXIT = payload("session-end-prompt-input-exit.json");
const CLEAR = payload("session-end-clear.json");

// Claude Code documents `logout` and `other`; neither has been captured, so neither is a fixture
// (test/fixtures/hook-payloads/README.md). These take a real capture and change the one field the
// policy reads, which is the only honest way to exercise a value nobody has seen.
const withReason = (reason) => JSON.stringify({ ...JSON.parse(EXIT), reason });

let session;
let mine;
let other;

const LEAD_ACTOR = "lead:770";
const OTHER_LEAD_ACTOR = "lead:771";
const WORKER_ACTOR = "agent:772";

function seedLead(projectId, actorId) {
  db.prepare(
    `INSERT INTO actors (id, name, kind) VALUES (?, 'lead', 'lead')
     ON CONFLICT(id) DO NOTHING`,
  ).run(actorId);
  db.prepare(
    `INSERT INTO agents (project_id, actor_id, name, tmux_target, tmux_socket, command, cwd, kind, status)
     VALUES (?, ?, 'lead', '%not-a-real-pane', '', 'claude', ?, 'lead', 'running')`,
  ).run(projectId, actorId, dirs.projectDir);
}

async function fireSessionEnd(body, env) {
  const { code } = await runNode(HOOK, ["session_end"], { dataDir: dirs.dataDir, tmp: dirs.tmp, env, stdin: body });
  assert.equal(code, 0, "a hook must always exit 0");
}

const runningNames = (projectId) => runningCommandNames(db, projectId);

const logRows = (actorId) =>
  db.prepare("SELECT event, state FROM agent_state_log WHERE actor_id = ? ORDER BY id").all(actorId);

async function startBoth() {
  for (const [projectDir, name] of [[dirs.projectDir, "api"], [dirs.projectDir, "queue"]]) {
    const { code } = await runCli(["start", name], { ...opts, cwd: projectDir });
    assert.equal(code, 0);
  }
  await runCli(["start", "api"], { cwd: other.dir, dataDir: dirs.dataDir, tmp: dirs.tmp });
}

before(async () => {
  const init = await runCli(["init"], opts);
  assert.equal(init.code, 0, init.stderr);
  const project = db.prepare("SELECT id, name FROM projects LIMIT 1").get();
  mine = { id: project.id, name: project.name, dir: dirs.projectDir };
  session = sessionName();
  await seedTrustedYml({
    db,
    projectId: mine.id,
    projectDir: dirs.projectDir,
    processes: { api: { command: "sleep 600", visible: false }, queue: { command: "sleep 600", visible: false } },
  });

  const otherDir = join(dirs.tmp, "other-project");
  mkdirSync(otherDir, { recursive: true });
  const otherId = db
    .prepare("INSERT INTO projects (name, path) VALUES ('other-project', ?) RETURNING id")
    .get(otherDir).id;
  other = { id: otherId, name: "other-project", dir: otherDir };
  await seedTrustedYml({
    db,
    projectId: other.id,
    projectDir: otherDir,
    processes: { api: { command: "sleep 600", visible: false } },
  });

  seedLead(mine.id, LEAD_ACTOR);
  seedLead(other.id, OTHER_LEAD_ACTOR);

  if (!hasTmux) return;
  ensureSession(session, dirs.projectDir, { bare: true });
  createWindow(session, mine.name, dirs.projectDir, [], "sleep 600", mine.id, true, false);
});

after(() => cleanup(session));

describe("SessionEnd stops a lead's processes, and nobody else's (todo 765)", () => {
  it("hive's generated hooks.json wires SessionEnd alongside the worker-state events", async () => {
    const { ensureHooksFile } = await import("../dist/hooks.js");
    const hooks = JSON.parse(readFileSync(ensureHooksFile(), "utf8")).hooks;

    assert.match(hooks.SessionEnd[0].hooks[0].command, /hook\.js" session_end$|hook\.js session_end$/);
    assert.ok(hooks.Stop && hooks.UserPromptSubmit && hooks.Notification, "the existing events must survive");
  });

  it("records every call in agent_state_log, whatever it decides to do", async () => {
    await fireSessionEnd(CLEAR, { HIVE_AGENT_ID: WORKER_ACTOR });

    assert.deepEqual(logRows(WORKER_ACTOR), [{ event: "session_end", state: "unchanged" }]);
  });

  it("resolves the project from the ENDING lead's own row, so each lead stops only its own", needsTmux, async () => {
    await startBoth();
    assert.deepEqual(runningNames(mine.id), ["api", "queue"]);
    assert.deepEqual(runningNames(other.id), ["api"]);

    await fireSessionEnd(EXIT, { HIVE_AGENT_ID: OTHER_LEAD_ACTOR, HIVE_LEAD: "1" });

    assert.deepEqual(runningNames(other.id), [], "the lead that ended is the one whose processes stop");
    assert.deepEqual(
      runningNames(mine.id),
      ["api", "queue"],
      "and no other project's: a lead resolved from anywhere but its own row would take these too",
    );

    await fireSessionEnd(EXIT, { HIVE_AGENT_ID: LEAD_ACTOR, HIVE_LEAD: "1" });

    assert.deepEqual(runningNames(mine.id), []);
  });

  it("stops nothing on a /clear, which ends the session and starts a new one in the same pane", needsTmux, async () => {
    await startBoth();
    const before = runningNames(mine.id);
    assert.deepEqual(before, ["api", "queue"]);

    await fireSessionEnd(CLEAR, { HIVE_AGENT_ID: LEAD_ACTOR, HIVE_LEAD: "1" });

    assert.deepEqual(runningNames(mine.id), before);
  });

  it("stops nothing on a reason outside the acting set, because unobserved does not mean terminal", needsTmux, async () => {
    const before = runningNames(mine.id);
    assert.deepEqual(before, ["api", "queue"], "the /clear test leaves both running");

    await fireSessionEnd(withReason("other"), { HIVE_AGENT_ID: LEAD_ACTOR, HIVE_LEAD: "1" });
    await fireSessionEnd(withReason("resume_picker"), { HIVE_AGENT_ID: LEAD_ACTOR, HIVE_LEAD: "1" });

    assert.deepEqual(
      runningNames(mine.id),
      before,
      "a session that ended in place leaves the lead's pane alive, and nothing would restart these",
    );
  });

  it("stops them on a logout, the other reason Claude Code documents as the session being over", needsTmux, async () => {
    assert.deepEqual(runningNames(mine.id), ["api", "queue"], "the previous test leaves both running");

    await fireSessionEnd(withReason("logout"), { HIVE_AGENT_ID: LEAD_ACTOR, HIVE_LEAD: "1" });

    assert.deepEqual(runningNames(mine.id), []);
  });

  it("stops nothing from a worker's environment, which shares the same hooks.json", needsTmux, async () => {
    await startBoth();
    const before = runningNames(mine.id);
    assert.deepEqual(before, ["api", "queue"]);

    await fireSessionEnd(EXIT, { HIVE_AGENT_ID: WORKER_ACTOR });
    await fireSessionEnd(EXIT, { HIVE_AGENT_ID: LEAD_ACTOR, HIVE_LEAD: "" });

    assert.deepEqual(runningNames(mine.id), before, "HIVE_LEAD is the gate; a worker's SessionEnd is a no-op");
  });

  it("leaves a worker's own pane alone when it does stop a lead's processes", needsTmux, async () => {
    const workerPane = tmux(
      "split-window", "-P", "-F", "#{pane_id}", "-t", `${session}:`, "-c", dirs.projectDir, "sleep 600",
    );
    db.prepare(
      `INSERT INTO agents (project_id, actor_id, name, tmux_target, tmux_socket, command, cwd, kind, status)
       VALUES (?, 'agent:773', 'helper', ?, '', 'claude', ?, 'agent', 'running')`,
    ).run(mine.id, workerPane, dirs.projectDir);

    await fireSessionEnd(EXIT, { HIVE_AGENT_ID: LEAD_ACTOR, HIVE_LEAD: "1" });

    assert.deepEqual(runningNames(mine.id), []);
    assert.equal(targetLive(workerPane), true, "workers outlive the lead on purpose");
    assert.ok(
      db.prepare("SELECT 1 FROM agents WHERE actor_id = 'agent:773' AND status = 'running'").get(),
      "and their rows stay running",
    );
  });
});
