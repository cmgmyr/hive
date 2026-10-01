import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import {
  fakeFailingTmux,
  isolateTmux,
  McpClient,
  paneField,
  recordingTmux,
  scratchDirs,
  tmuxCallsIn,
  until,
} from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("the agent_close row_only tests");

const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { db } = await import("../dist/db.js");
const { tmuxSocketPath } = await import("../dist/tmux.js");

const OWN_SOCKET = tmuxSocketPath(process.env.TMUX, process.env.TMUX_TMPDIR);
const FOREIGN_SOCKET = "/nonexistent/foreign-socket-dir/tmux-0/default";
const FIRST = `row-only-first-${process.pid}`;
const BYSTANDER = `row-only-bystander-${process.pid}`;
const MUTATING_VERBS = [
  "kill-pane",
  "kill-window",
  "kill-session",
  "send-keys",
  "paste-buffer",
  "load-buffer",
  "set-buffer",
  "respawn-pane",
  "select-layout",
  "split-window",
  "new-window",
  "resize-pane",
];

const bystanderCommand = "sh -c 'echo BYSTANDER; sleep 600'";
const tmuxRun = (...args) => execFileSync("tmux", args, { encoding: "utf8" }).trim();
const firstPane = (session) => tmuxRun("list-panes", "-t", `=${session}`, "-F", "#{pane_id}").split("\n")[0];
const serverGone = () => {
  try {
    execFileSync("tmux", ["list-sessions"], { stdio: "ignore" });
    return false;
  } catch {
    return true;
  }
};

let projectId;
let pane;
let stalePid;
let livePid;
const clients = [];

async function client(env = {}) {
  const mcp = new McpClient({ cwd: dirs.projectDir, dataDir: dirs.dataDir, env });
  await mcp.start();
  clients.push(mcp);
  return mcp;
}

before(async () => {
  const human = await client();
  projectId = (await human.call("whoami")).project.id;
  if (!hasTmux) return;
  execFileSync("tmux", ["new-session", "-d", "-s", FIRST, bystanderCommand], { stdio: "ignore" });
  const firstId = firstPane(FIRST);
  stalePid = paneField(firstId, "#{pane_pid}");
  cleanup(FIRST);
  await until(serverGone, 5000);
  execFileSync("tmux", ["new-session", "-d", "-s", BYSTANDER, bystanderCommand], { stdio: "ignore" });
  pane = firstPane(BYSTANDER);
  livePid = paneField(pane, "#{pane_pid}");
  assert.equal(pane, firstId, "a restarted server on the same socket must reissue the same pane id");
  assert.notEqual(livePid, stalePid, "the reissued pane must belong to a different process");
});

after(async () => {
  for (const mcp of clients) await mcp.close();
  cleanup(BYSTANDER);
});

beforeEach(() => db.prepare("DELETE FROM agents WHERE project_id = ?").run(projectId));

function row({ kind = "lead", name = kind, actor = `${kind}:900`, target = pane, socket = OWN_SOCKET, pid = "" } = {}) {
  return db
    .prepare(
      `INSERT INTO agents (project_id, actor_id, name, tmux_target, tmux_socket, pane_pid, command, cwd, kind, status)
       VALUES (?, ?, ?, ?, ?, ?, 'claude', '/tmp', ?, 'running') RETURNING id`,
    )
    .get(projectId, actor, name, target, socket, pid, kind).id;
}

const rowOf = (id) => db.prepare("SELECT status, closed_at, parked_at, tmux_target, pane_pid FROM agents WHERE id = ?").get(id);
const bystanderAlive = () => paneField(pane, "#{pane_pid}") === livePid;

describe("agent_close row_only", () => {
  const skip = !hasTmux && "tmux is not installed";

  it("ordinary agent_close still refuses an empty-pid lead on a live pane id", { skip }, async () => {
    const human = clients[0];
    const id = row();
    await assert.rejects(human.call("agent_close", { agent_id: id }), /still live/);
    assert.equal(rowOf(id).status, "running");
    assert.ok(bystanderAlive());
  });

  it("retires an empty-pid lead whose pane id was reissued, leaving the bystander running and issuing no mutating tmux call", { skip }, async () => {
    const log = join(mkdtempSync(join(tmpdir(), "hive-rowonly-")), "calls.log");
    const recorded = await client({ PATH: `${recordingTmux({ log })}:${process.env.PATH}` });
    const id = row();
    const receipt = await recorded.call("agent_close", { agent_id: id, row_only: true });
    assert.equal(receipt.row_only, true);
    assert.equal(receipt.closed, true);
    assert.match(receipt.note, /ownership read unknown/);
    assert.equal(rowOf(id).status, "closed");
    assert.ok(bystanderAlive());
    const verbs = tmuxCallsIn(log).map((argv) => argv.find((a) => !a.startsWith("-")));
    assert.ok(verbs.includes("list-panes"), `the recording shim must have seen the ownership probe: ${verbs}`);
    assert.deepEqual(verbs.filter((v) => MUTATING_VERBS.includes(v)), []);
  });

  it("retires a lead whose recorded pid names the pane's previous process", { skip }, async () => {
    const id = row({ pid: stalePid });
    const receipt = await clients[0].call("agent_close", { agent_id: id, row_only: true });
    assert.match(receipt.note, /ownership read reissued/);
    assert.equal(rowOf(id).status, "closed");
    assert.ok(bystanderAlive());
  });

  it("refuses a lead whose recorded pid matches its live pane", { skip }, async () => {
    const id = row({ pid: livePid });
    await assert.rejects(clients[0].call("agent_close", { agent_id: id, row_only: true }), /owns a live pane/);
    assert.equal(rowOf(id).status, "running");
  });

  it("refuses a live worker and a live command, which ordinary agent_close stops", { skip }, async () => {
    const worker = row({ kind: "agent", name: "w", pid: livePid });
    const command = row({ kind: "command", name: "web", pid: livePid });
    for (const id of [worker, command]) {
      await assert.rejects(clients[0].call("agent_close", { agent_id: id, row_only: true }), /owns a live pane/);
      assert.equal(rowOf(id).status, "running");
    }
    assert.ok(bystanderAlive());
  });

  it("retires a lead recorded on a foreign socket", { skip }, async () => {
    const id = row({ socket: FOREIGN_SOCKET, pid: livePid });
    await clients[0].call("agent_close", { agent_id: id, row_only: true });
    assert.equal(rowOf(id).status, "closed");
  });

  it("retires a lead whose probe fails, without treating the failure as live", { skip }, async () => {
    const failing = await client({ PATH: `${fakeFailingTmux({ failOn: "list-panes" })}:${process.env.PATH}` });
    const id = row({ pid: livePid });
    const receipt = await failing.call("agent_close", { agent_id: id, row_only: true });
    assert.match(receipt.note, /ownership read unknown/);
    assert.equal(rowOf(id).status, "closed");
    assert.ok(bystanderAlive());
  });

  it("lets a peer lead retire an empty-pid lead row", { skip }, async () => {
    const peer = await client({ HIVE_AGENT_ID: "lead:77" });
    const id = row();
    await peer.call("agent_close", { agent_id: id, row_only: true });
    assert.equal(rowOf(id).status, "closed");
  });

  it("refuses a worker caller on a lead row and on a non-lead row, changing nothing", { skip }, async () => {
    const worker = await client({ HIVE_AGENT_ID: "agent:999" });
    const lead = row();
    const other = row({ kind: "agent", name: "stale", target: "%99999" });
    for (const id of [lead, other]) {
      const before = rowOf(id);
      await assert.rejects(worker.call("agent_close", { agent_id: id, row_only: true }), /reserved for a human at a terminal or a peer lead/);
      assert.deepEqual(rowOf(id), before);
    }
  });

  it("requires confirm_self to retire the caller's own row", { skip }, async () => {
    const self = await client({ HIVE_AGENT_ID: "lead:55" });
    const id = row({ actor: "lead:55" });
    await assert.rejects(self.call("agent_close", { agent_id: id, row_only: true }), /your own session/);
    assert.equal(rowOf(id).status, "running");
    await self.call("agent_close", { agent_id: id, row_only: true, confirm_self: true });
    assert.equal(rowOf(id).status, "closed");
  });

  it("is idempotent on a closed and parked row, leaving the park in place", { skip }, async () => {
    const id = row({ kind: "agent", name: "parked", target: "%99999" });
    db.prepare("UPDATE agents SET status = 'closed', closed_at = datetime('now'), parked_at = datetime('now') WHERE id = ?").run(id);
    const before = rowOf(id);
    const receipt = await clients[0].call("agent_close", { agent_id: id, row_only: true });
    assert.deepEqual(
      { row_only: receipt.row_only, closed: receipt.closed, parked: receipt.parked },
      { row_only: true, closed: true, parked: true },
    );
    assert.deepEqual(rowOf(id), before);
  });
});
