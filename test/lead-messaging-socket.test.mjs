import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";

import { DIST, assertScratchStore, clearHiveEnv, isolateTmux, runNode, scratchDirs, tmux } from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("the lead messaging socket registration tests");
clearHiveEnv();
delete process.env.CLAUDE_CODE_MESSAGING_SOCKET;
const { dataDir } = scratchDirs();
process.env.HIVE_DATA_DIR = dataDir;
await assertScratchStore();

const { db, migrate } = await import("../dist/db.js");
migrate();

const HOOK = join(DIST, "hook.js");
const SESSION = "qlw-socket";
const project = db.prepare("INSERT INTO projects (name, path) VALUES ('lead-socket', ?) RETURNING id").get(dataDir).id;

let pane = "";
let panePid = "";
if (hasTmux) {
  execFileSync("tmux", ["new-session", "-d", "-s", SESSION, "sleep 600"], { stdio: "ignore" });
  pane = tmux("list-panes", "-t", SESSION, "-F", "#{pane_id}");
  panePid = tmux("list-panes", "-t", SESSION, "-F", "#{pane_pid}");
}
const needsTmux = { skip: hasTmux ? false : "tmux is not installed" };
after(() => cleanup(SESSION));

function seed({ kind = "lead", status = "running", recordedPid = "", socket = "/old/socket", pid = "old-pid" } = {}) {
  return db
    .prepare(
      `INSERT INTO agents (project_id, actor_id, name, kind, tmux_target, pane_pid, command, cwd, status, agent_state,
         claude_messaging_socket, claude_messaging_pane_pid)
       VALUES (?, ?, 'lead', ?, ?, ?, 'claude', '/tmp', ?, 'unknown', ?, ?) RETURNING id`,
    )
    .get(project, `${kind}:sock`, kind, pane, recordedPid, status, socket, pid).id;
}

const registration = (id) =>
  db.prepare("SELECT claude_messaging_socket AS socket, claude_messaging_pane_pid AS pid, agent_state FROM agents WHERE id = ?").get(id);

async function sessionStart(actorId, env) {
  const { code } = await runNode(HOOK, ["session_start"], {
    dataDir,
    env: { HIVE_AGENT_ID: actorId, HIVE_LEAD: "1", TMUX_PANE: pane, ...env },
    stdin: JSON.stringify({ hook_event_name: "SessionStart", session_id: "s1", source: "startup" }),
  });
  assert.equal(code, 0);
}

describe("SessionStart records a Claude lead's messaging socket, bound to its pane pid", () => {
  beforeEach(() => db.exec("DELETE FROM agent_state_log; DELETE FROM lead_turn_state; DELETE FROM agents;"));

  it("captures the socket and the hook's own pane pid before cmdLead has recorded that pane", needsTmux, async () => {
    const id = seed({ recordedPid: "" });
    await sessionStart("lead:sock", { CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/new-claude.sock" });
    assert.deepEqual(registration(id), { socket: "/tmp/new-claude.sock", pid: panePid, agent_state: "unknown" });
  });

  it("captures the same pid when cmdLead recorded the pane first", needsTmux, async () => {
    const id = seed({ recordedPid: panePid });
    await sessionStart("lead:sock", { CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/new-claude.sock" });
    assert.equal(registration(id).pid, panePid);
  });

  it("clears the registration when the socket is absent, relative, or there is no pane", needsTmux, async () => {
    for (const env of [{}, { CLAUDE_CODE_MESSAGING_SOCKET: "relative.sock" }, { CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/x.sock", TMUX_PANE: "" }]) {
      db.exec("DELETE FROM agents");
      const id = seed();
      await sessionStart("lead:sock", env);
      assert.deepEqual(registration(id), { socket: "", pid: "", agent_state: "unknown" }, JSON.stringify(env));
    }
  });

  it("writes one log-only session_start row and no lead turn state", needsTmux, async () => {
    seed();
    await sessionStart("lead:sock", { CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/new-claude.sock" });
    const rows = db.prepare("SELECT event, state FROM agent_state_log WHERE actor_id = 'lead:sock'").all();
    assert.deepEqual(rows.map((r) => ({ ...r })), [{ event: "session_start", state: "unchanged" }]);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM lead_turn_state").get().n, 0);
  });

  it("never touches a closed lead row or a worker row", needsTmux, async () => {
    const closed = seed({ status: "closed" });
    await sessionStart("lead:sock", { CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/new-claude.sock" });
    assert.equal(registration(closed).socket, "/old/socket");

    db.exec("DELETE FROM agents");
    const worker = seed({ kind: "agent" });
    await sessionStart("agent:sock", { CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/new-claude.sock" });
    assert.deepEqual(registration(worker), { socket: "/old/socket", pid: "old-pid", agent_state: "unknown" });
  });

  it("does nothing without HIVE_LEAD, even for a lead row", needsTmux, async () => {
    const id = seed();
    await sessionStart("lead:sock", { CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/new-claude.sock", HIVE_LEAD: "" });
    assert.equal(registration(id).socket, "/old/socket");
  });
});
