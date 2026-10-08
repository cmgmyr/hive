import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { after, before, describe, it } from "node:test";

import { isolateTmux, McpClient, runCli, scratchDirs } from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("the dormant lead tests");
const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { db, migrate } = await import("../dist/db.js");
migrate();
const { tmuxSocketPath } = await import("../dist/tmux.js");
const { addProject } = await import("../dist/context.js");

const project = addProject(dirs.projectDir, "dormant-lead-tests");
const skip = !hasTmux && "tmux is not installed";
const endedAt = "2026-10-08 12:34:56";
const foreignSocket = "/nonexistent/foreign-socket-dir/tmux-0/default";
let mcp;
let pane;
let panePid;

before(async () => {
  mcp = new McpClient({ cwd: dirs.projectDir, dataDir: dirs.dataDir });
  await mcp.start();
  if (hasTmux) {
    pane = execFileSync("tmux", ["new-session", "-d", "-P", "-F", "#{pane_id}", "-s", `dormant-lead-${process.pid}`, "sleep 300"], { encoding: "utf8" }).trim();
    panePid = execFileSync("tmux", ["display-message", "-p", "-t", pane, "#{pane_pid}"], { encoding: "utf8" }).trim();
  }
});

after(async () => {
  await mcp.close();
  cleanup(`dormant-lead-${process.pid}`);
});

function lead(name, target = "%99999", pid = "saved-pane", socket = tmuxSocketPath(process.env.TMUX, process.env.TMUX_TMPDIR)) {
  return db.prepare(
    `INSERT INTO agents (project_id, name, command, cwd, kind, actor_id, tmux_target, tmux_socket, pane_pid, status)
     VALUES (?, ?, 'claude', ?, 'lead', ?, ?, ?, ?, 'running') RETURNING id`,
  ).get(project.id, name, dirs.projectDir, `lead:${name}`, target, socket, pid).id;
}

function sessionEnd(id, pid = "saved-pane", event = "session_end") {
  db.prepare(
    `INSERT INTO lead_turn_state (agent_id, pane_pid, session_id, state, idle_seq, last_event, changed_at)
     VALUES (?, ?, 'session-one', 'unknown', 0, ?, ?)`,
  ).run(id, pid, event, endedAt);
}

const leadLine = (stdout, name) => stdout.split("\n").find((line) => line.includes(`lead   ${name}`)) ?? "";
const localTime = (utc) => {
  const date = new Date(`${utc.replace(" ", "T")}Z`);
  const pad2 = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
};

describe("dormant lead display", () => {
  it("status labels a cleanly ended lead dormant with its end time", { skip }, async () => {
    const id = lead("ended-status");
    sessionEnd(id);
    const reissuedId = lead("reissued-ended-status", pane, "earlier-pane");
    sessionEnd(reissuedId, "earlier-pane");
    const result = await runCli(["status"], { cwd: dirs.projectDir, dataDir: dirs.dataDir, tmp: dirs.tmp });
    assert.equal(result.code, 0, result.stderr);
    assert.match(leadLine(result.stdout, "ended-status"), /dormant \(session ended/);
    assert.ok(leadLine(result.stdout, "ended-status").includes(localTime(endedAt)));
    assert.match(leadLine(result.stdout, "reissued-ended-status"), /dormant \(session ended/);
  });

  it("status keeps no live pane for a lead that died without session end", { skip }, async () => {
    lead("no-end-status");
    const otherEvent = lead("other-event-status", "%99997", "other-pane");
    sessionEnd(otherEvent, "other-pane", "stop");
    const result = await runCli(["status"], { cwd: dirs.projectDir, dataDir: dirs.dataDir, tmp: dirs.tmp });
    assert.match(leadLine(result.stdout, "no-end-status"), /no live pane/);
    assert.match(leadLine(result.stdout, "other-event-status"), /no live pane/);
  });

  it("a stale session end from an earlier pane does not read dormant", { skip }, async () => {
    const id = lead("stale-end-status", "%99998", "new-pane");
    sessionEnd(id, "old-pane");
    const result = await runCli(["status"], { cwd: dirs.projectDir, dataDir: dirs.dataDir, tmp: dirs.tmp });
    assert.match(leadLine(result.stdout, "stale-end-status"), /no live pane/);
    assert.doesNotMatch(leadLine(result.stdout, "stale-end-status"), /dormant/);
  });

  it("a live or unknown lead never reads dormant", { skip }, async () => {
    const liveId = lead("live", pane, panePid);
    sessionEnd(liveId, panePid);
    const unknownId = lead("unknown", pane, panePid, foreignSocket);
    sessionEnd(unknownId, panePid);
    const listed = await mcp.call("agent_list", {});
    const live = listed.agents.find((agent) => agent.agent_id === liveId);
    const unknown = listed.agents.find((agent) => agent.agent_id === unknownId);
    assert.deepEqual([live.alive, live.status, "dormant_since" in live], [true, "running", false]);
    assert.deepEqual([unknown.alive, unknown.status, "dormant_since" in unknown], [null, "running", false]);
    const status = await runCli(["status"], { cwd: dirs.projectDir, dataDir: dirs.dataDir, tmp: dirs.tmp });
    assert.match(leadLine(status.stdout, "live"), /running/);
    assert.match(leadLine(status.stdout, "unknown"), /pane identity unknown/);
  });

  it("agent_list adds dormant_since to a cleanly ended lead only", { skip }, async () => {
    const endedId = lead("ended-list");
    sessionEnd(endedId);
    const noEndId = lead("no-end-list", "%99996", "no-end-pane");
    const workerId = db.prepare(
      `INSERT INTO agents (project_id, name, command, cwd, kind, actor_id, tmux_target, tmux_socket, pane_pid, status)
       VALUES (?, 'worker', 'claude', ?, 'agent', 'agent:worker', '%99997', ?, 'saved-pane', 'running') RETURNING id`,
    ).get(project.id, dirs.projectDir, tmuxSocketPath(process.env.TMUX, process.env.TMUX_TMPDIR)).id;
    const listed = await mcp.call("agent_list", {});
    const ended = listed.agents.find((agent) => agent.agent_id === endedId);
    const noEnd = listed.agents.find((agent) => agent.agent_id === noEndId);
    const worker = listed.agents.find((agent) => agent.agent_id === workerId);
    assert.equal(ended.dormant_since, endedAt);
    assert.equal(ended.status, "exited");
    assert.equal(ended.alive, false);
    assert.equal("dormant_since" in noEnd, false);
    assert.equal("dormant_since" in worker, false);
    const detailed = await mcp.call("agent_status", { agent_id: endedId });
    assert.equal(detailed.dormant_since, endedAt);
    assert.equal(detailed.status, "exited");
    assert.equal(detailed.alive, false);
  });
});
