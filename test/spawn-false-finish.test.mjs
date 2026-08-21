import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import {
  DIST,
  isolateTmux,
  liveAgentRow,
  makeFakeClaude,
  McpClient,
  namedInStandingReport,
  REPO,
  reportedAsFinished,
  runNode,
  scratchDirs,
  seedDeadPaneLead,
  seedStandingWatch,
  standingNoticeBodies,
} from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("the spawn false-finish tests");
const NEEDS_TMUX = { skip: hasTmux ? false : "tmux is not installed" };

const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { db } = await import("../dist/db.js");
const { tick } = await import("../dist/scheduler.js");
const { sessionName } = await import("../dist/tmux.js");

const HOOK = join(DIST, "hook.js");
const payload = (name) => readFileSync(join(REPO, "test", "fixtures", "hook-payloads", name), "utf8");
const STOP_PAYLOAD = payload("stop-idle.json");

const FORMER_ANNOUNCEMENT_PAYLOAD = payload("prompt-spawn-announcement.json");
const USER_PROMPT_PAYLOAD = payload("prompt-user.json");

const OWNER = "lead:spawn-finish";

let mcp;
let projectId;

before(async () => {

  mcp = new McpClient({
    cwd: dirs.projectDir,
    dataDir: dirs.dataDir,
    env: { HIVE_AGENT_ID: OWNER, HIVE_SPAWN_READY_MS: "1" },
  });
  await mcp.start();
  projectId = (await mcp.call("whoami")).project.id;

  seedDeadPaneLead(db, projectId, dirs.projectDir, OWNER);
});

after(async () => {
  await mcp.close();
  cleanup(sessionName());
});

const fakeClaude = makeFakeClaude(dirs.tmp);

const addStandingWatch = () => seedStandingWatch(db, projectId, OWNER);

const noticeReporting = (watchId, name) =>
  standingNoticeBodies(db, watchId).find((body) => new RegExp(`^ {2}${name}: (?!GONE)`, "m").test(body));
const namedInReport = (watchId, name) => namedInStandingReport(db, watchId, name);
const wasReportedAsFinished = (watchId, name) => reportedAsFinished(db, watchId, name);

async function fireHook(event, stdin, actorId) {
  const { code } = await runNode(HOOK, [event], { dataDir: dirs.dataDir, env: { HIVE_AGENT_ID: actorId }, stdin });
  assert.equal(code, 0, "the hook must exit 0 - a failing hook would prove nothing about state");
}

async function spawnWorker(name) {
  const receipt = await mcp.call("agent_spawn", { name, command: fakeClaude() });
  const live = await liveAgentRow(mcp, name);
  const row = db
    .prepare("SELECT id, actor_id, tmux_target, resumed_at, agent_state FROM agents WHERE id = ?")
    .get(live.agent_id);
  return { row, receipt };
}

const logFor = (actorId) =>
  db.prepare("SELECT event, state FROM agent_state_log WHERE actor_id = ? ORDER BY id").all(actorId);

describe("todo 387: a spawned worker has no turn at all until briefed", NEEDS_TMUX, () => {
  it("nothing is typed into the pane, and the row carries no trace of a turn", async () => {
    const { row, receipt } = await spawnWorker("sf-no-turn");

    assert.equal(row.resumed_at, "", "launchAgent must not stamp resumed_at anymore - only resumeAgent's flip does");
    assert.equal(row.agent_state, "unknown", "no hook has fired, so the row's state is still its default");
    assert.deepEqual(logFor(row.actor_id), [], "no hook event of any kind - hive gave this worker nothing to react to");

    assert.equal(typeof receipt.ready, "boolean");
    assert.equal(receipt.ready, false);
    assert.match(receipt.note, /never became ready/);
    assert.equal(receipt.tail, undefined, "no dialog fixture here, so there is nothing to name");
    assert.ok(receipt.brief_path, "the brief itself still rides the system prompt");

    const { output } = await mcp.call("agent_output", { name: "sf-no-turn" });
    assert.doesNotMatch(output, /\[hive\]/, "nothing hive typed should be on screen");
  });

  it("the standing watch shows an unbriefed worker without claiming the project is empty", async () => {
    const watchId = addStandingWatch();

    const assigned = await spawnWorker("sf-roster-assigned");
    const unbriefed = await spawnWorker("sf-roster-unbriefed");
    await fireHook("prompt", USER_PROMPT_PAYLOAD, assigned.row.actor_id);
    await fireHook("stop", STOP_PAYLOAD, assigned.row.actor_id);
    await tick({
      panes: new Set([assigned.row.tmux_target, unbriefed.row.tmux_target]),
      windows: new Set(),
    });

    const body = noticeReporting(watchId, "sf-roster-assigned");
    assert.ok(body, "setup: the assigned worker's real finish must be reported, or there is no notice to read");

    assert.doesNotMatch(
      body,
      /Nothing else in this project is running right now/,
      "a live, unbriefed worker must stop the notice claiming the project is empty",
    );
    assert.match(body, /Still going:.*sf-roster-unbriefed/, "and it is named in the roster, honestly labelled");
  });

  it("a spawned worker that dies before ever being given anything is still reported", async () => {
    const watchId = addStandingWatch();
    const { row } = await spawnWorker("sf-death-unbriefed");

    db.prepare("UPDATE agents SET status = 'closed', closed_at = datetime('now') WHERE id = ?").run(row.id);
    await tick({ panes: new Set(), windows: new Set() });

    assert.ok(
      namedInReport(watchId, "sf-death-unbriefed"),
      "a spawned worker's death is real news even before its first assignment - " +
        "agent_state stays 'unknown', which standingGoneRows' != 'idle' clause already catches",
    );
    const body = standingNoticeBodies(db, watchId).find((b) => b.includes("sf-death-unbriefed:"));
    assert.match(
      body,
      /sf-death-unbriefed: GONE .* It was never given an assignment, so nothing was in flight\./,
      "a claude worker whose hook never fired at all gets the airtight message (todo 384 comment 944)",
    );
  });

  it("a never-touched worker with NO state channel does not get the airtight claim (fix round 1, finding 4)", async () => {
    const watchId = addStandingWatch();

    await mcp.call("agent_spawn", { name: "sf-bash-never-touched", command: "bash" });
    const live = await liveAgentRow(mcp, "sf-bash-never-touched");
    db.prepare("UPDATE agents SET status = 'closed', closed_at = datetime('now') WHERE id = ?").run(live.agent_id);
    await tick({ panes: new Set(), windows: new Set() });

    const body = standingNoticeBodies(db, watchId).find((b) => b.includes("sf-bash-never-touched:"));
    assert.match(
      body,
      /sf-bash-never-touched: GONE .* Check its branch, its todo and any pad it was writing/,
      "a row with no state channel must fall back to the honest 'go check' sentence, not the airtight claim",
    );
  });

  it("a real assignment is the worker's first and only turn, and its finish is reported", async () => {
    const watchId = addStandingWatch();
    const { row } = await spawnWorker("sf-real-first-turn");
    const snapshot = { panes: new Set([row.tmux_target]), windows: new Set() };

    await fireHook("prompt", USER_PROMPT_PAYLOAD, row.actor_id);
    await fireHook("stop", STOP_PAYLOAD, row.actor_id);
    await tick(snapshot);

    assert.equal(
      wasReportedAsFinished(watchId, "sf-real-first-turn"),
      true,
      "the worker's first turn is a real assignment, so its finish is real news",
    );
  });
});

describe("todo 384's regression: nothing suppresses an assignment landing immediately after spawn", NEEDS_TMUX, () => {

  it("a spawn immediately followed by an assignment - the two-for-two reproduction shape - reports the finish", async () => {
    const watchId = addStandingWatch();
    const { row } = await spawnWorker("sf-immediate-send");
    const snapshot = { panes: new Set([row.tmux_target]), windows: new Set() };

    await fireHook("prompt", FORMER_ANNOUNCEMENT_PAYLOAD, row.actor_id);
    await fireHook("stop", STOP_PAYLOAD, row.actor_id);
    await tick(snapshot);

    assert.equal(
      wasReportedAsFinished(watchId, "sf-immediate-send"),
      true,
      "todo 384: an assignment landing in the window right after spawn must not be suppressed - " +
        "this is the exact reproduction shape (spawn, then send, in the same tool block)",
    );
  });
});
