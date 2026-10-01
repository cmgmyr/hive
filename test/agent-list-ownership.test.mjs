import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { after, before, describe, it } from "node:test";

import { isolateTmux, McpClient, paneField, scratchDirs, until } from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("the agent_list ownership tests");

const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { db } = await import("../dist/db.js");
const { tmuxSocketPath } = await import("../dist/tmux.js");

const BYSTANDER = `agent-list-bystander-${process.pid}`;
const MARK = "BYSTANDER-SCREEN-MARK";
let mcp;
let projectId;
let pane;
let pid;

before(async () => {
  mcp = new McpClient({ cwd: dirs.projectDir, dataDir: dirs.dataDir });
  await mcp.start();
  projectId = (await mcp.call("whoami")).project.id;
  if (!hasTmux) return;
  execFileSync("tmux", ["new-session", "-d", "-s", BYSTANDER, `sh -c 'echo ${MARK}; sleep 600'`], { stdio: "ignore" });
  pane = execFileSync("tmux", ["list-panes", "-t", `=${BYSTANDER}`, "-F", "#{pane_id}"], { encoding: "utf8" }).trim();
  pid = paneField(pane, "#{pane_pid}");
  await until(() => execFileSync("tmux", ["capture-pane", "-p", "-t", pane], { encoding: "utf8" }).includes(MARK));
});

after(async () => {
  await mcp.close();
  cleanup(BYSTANDER);
});

function leadRow(name, target, panePid) {
  return db
    .prepare(
      `INSERT INTO agents (project_id, name, command, cwd, kind, actor_id, tmux_target, tmux_socket, pane_pid, status)
       VALUES (?, ?, 'claude', '/tmp', 'lead', ?, ?, ?, ?, 'running') RETURNING id`,
    )
    .get(projectId, name, `lead:${name}`, target, tmuxSocketPath(process.env.TMUX, process.env.TMUX_TMPDIR), panePid).id;
}

describe("agent_list and agent_status report verified pane ownership", () => {
  const skip = !hasTmux && "tmux is not installed";

  it("agent_list alive reads true, false, false, null for matching, gone, reissued and empty-pid rows", { skip }, async () => {
    const ids = {
      matching: leadRow("lead-matching", pane, pid),
      gone: leadRow("lead-gone", "%99999", pid),
      reissued: leadRow("lead-reissued", pane, "1"),
      empty: leadRow("lead-empty", pane, ""),
    };
    const listed = await mcp.call("agent_list", {});
    const alive = Object.fromEntries(
      Object.entries(ids).map(([k, id]) => [k, listed.agents.find((a) => a.agent_id === id).alive]),
    );
    assert.deepEqual(alive, { matching: true, gone: false, reissued: false, empty: null });
    db.prepare("DELETE FROM agents").run();
  });

  it("agent_status never captures the bystander's screen for an empty-pid row, and says why", { skip }, async () => {
    const id = leadRow("lead-empty-status", pane, "");
    const status = await mcp.call("agent_status", { agent_id: id });
    assert.equal(status.alive, null);
    assert.equal(status.tail, "");
    assert.equal(status.current_command, null);
    assert.doesNotMatch(JSON.stringify(status), new RegExp(MARK));
    assert.match(status.note, /no pane pid was recorded/);
    assert.match(status.note, /agent_close\(row_only=true\)/);
    assert.deepEqual(db.prepare("SELECT status, pane_pid FROM agents WHERE id = ?").get(id), { status: "running", pane_pid: "" });
    db.prepare("DELETE FROM agents").run();
  });

  it("control: agent_status captures the screen of a row whose recorded pid matches", { skip }, async () => {
    const id = leadRow("lead-matching-status", pane, pid);
    const status = await mcp.call("agent_status", { agent_id: id });
    assert.equal(status.alive, true);
    assert.match(status.tail, new RegExp(MARK));
    db.prepare("DELETE FROM agents").run();
  });
});
