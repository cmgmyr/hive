import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { clearHiveEnv, isolateTmux, McpClient, paneField, resolvedTmuxSocket, scratchDirs } from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("the queen scope tests");
after(() => cleanup("qscope-alpha"));

clearHiveEnv();
const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { db, migrate } = await import("../dist/db.js");
const { QUEEN_REACH, QUEEN_REFUSAL } = await import("../dist/context.js");
migrate();

function project(name, path) {
  mkdirSync(path, { recursive: true });
  const real = realpathSync(path);
  return { id: db.prepare("INSERT INTO projects (name, path) VALUES (?, ?) RETURNING id").get(name, real).id, path: real };
}

function agentRow(projectId, { kind, name, pane = "%none", socket = "", status = "running", parent = null, command = "claude" }) {
  const id = db
    .prepare(
      `INSERT INTO agents (project_id, name, command, cwd, kind, status, tmux_target, tmux_socket, parent_actor_id)
       VALUES (?, ?, ?, '/', ?, ?, ?, ?, ?) RETURNING id`,
    )
    .get(projectId, name, command, kind, status, pane, socket, parent).id;
  const actorId = kind === "lead" ? `lead:${id}` : `agent:${id}`;
  db.prepare("UPDATE agents SET actor_id = ? WHERE id = ?").run(actorId, id);
  db.prepare("INSERT OR IGNORE INTO actors (id, name, kind) VALUES (?, ?, ?)").run(actorId, name, kind);
  return { id, actorId };
}

const queen = project("queen", join(dirs.dataDir, "queen"));
const alpha = project("alpha", join(dirs.tmp, "alpha"));
const beta = project("beta", join(dirs.tmp, "beta"));
const queenLead = agentRow(queen.id, { kind: "lead", name: "lead" });
const betaLead = agentRow(beta.id, { kind: "lead", name: "lead" });
const alphaWorker = agentRow(alpha.id, { kind: "agent", name: "impl" });
const queenWorker = agentRow(queen.id, { kind: "agent", name: "scout", parent: queenLead.actorId });

const seedPad = db
  .prepare("INSERT INTO pads (project_id, name, content, updated_by) VALUES (?, 'board', 'seed', 'lead:0') RETURNING id")
  .get(alpha.id).id;
const seedTodo = (title) =>
  db.prepare("INSERT INTO todos (project_id, title) VALUES (?, ?) RETURNING id").get(alpha.id, title).id;
const todoA = seedTodo("first");
const todoB = seedTodo("second");
db.prepare("INSERT INTO kv (project_id, key, value, updated_by) VALUES (?, 'k', '\"v\"', 'lead:0')").run(alpha.id);

let alphaLead;
let queenMcp;

function clientAs(actorId, cwd, extra = {}) {
  return new McpClient({ cwd, dataDir: dirs.dataDir, env: { HIVE_AGENT_ID: actorId, HIVE_LEAD: "1", ...extra } });
}

async function rawCall(mcp, name, args) {
  const msg = await mcp.request("tools/call", { name, arguments: args });
  assert.equal(msg.error, undefined, JSON.stringify(msg.error));
  return msg.result;
}

async function refusal(mcp, name, args) {
  const result = await rawCall(mcp, name, args);
  assert.equal(result.isError, true, `${name} must refuse, got ${JSON.stringify(result)}`);
  return result.content[0].text;
}

const alphaState = () => ({
  pad: db.prepare("SELECT revision, content, archived FROM pads WHERE id = ?").get(seedPad),
  todos: db.prepare("SELECT * FROM todos WHERE project_id = ? ORDER BY id").all(alpha.id),
  blockers: db.prepare("SELECT COUNT(*) AS n FROM todo_blockers").get().n,
  kv: db.prepare("SELECT key, value FROM kv WHERE project_id = ?").all(alpha.id),
  leases: db.prepare("SELECT COUNT(*) AS n FROM leases WHERE project_id = ?").get(alpha.id).n,
  agents: db.prepare("SELECT id, name, status FROM agents WHERE project_id = ? ORDER BY id").all(alpha.id),
  projects: db.prepare("SELECT COUNT(*) AS n FROM projects").get().n,
  actors: db.prepare("SELECT COUNT(*) AS n FROM actors").get().n,
});

describe("the queen's cross-project scope", { skip: hasTmux ? false : "tmux is not installed" }, () => {
  before(async () => {
    const pane = execFileSync("tmux", ["new-session", "-d", "-s", "qscope-alpha", "-P", "-F", "#{pane_id}", "sleep", "600"], {
      encoding: "utf8",
    }).trim();
    alphaLead = agentRow(alpha.id, { kind: "lead", name: "lead", pane, socket: resolvedTmuxSocket() });
    db.prepare("UPDATE agents SET pane_pid = ? WHERE id = ?").run(paneField(pane, "#{pane_pid}"), alphaLead.id);
    queenMcp = clientAs(queenLead.actorId, queen.path);
    await queenMcp.start();
  });
  after(() => queenMcp?.close());

  it("classifies every registered tool as read, allowed or refused, so a new tool cannot open silently", async () => {
    const listed = (await queenMcp.request("tools/list", {})).result.tools.map((t) => t.name).sort();
    assert.ok(listed.length >= 45, `tools/list returned only ${listed.length} tools`);
    assert.deepEqual(listed.filter((name) => !(name in QUEEN_REACH)), []);
  });

  it("tells the queen its scoped rule in the server instructions", async () => {
    const mcp = clientAs(queenLead.actorId, queen.path);
    try {
      const init = await mcp.request("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "hive-test", version: "0" },
      });
      assert.match(init.result.instructions, /you are the queen/);
      assert.doesNotMatch(init.result.instructions, /Never browse other projects/);
    } finally {
      await mcp.close();
    }
  });

  it("reads another project's pads and todos by project_id", async () => {
    const pad = await queenMcp.call("pad_read", { name: "board", project_id: alpha.id });
    assert.equal(pad.content, "seed");
    const todos = await queenMcp.call("todo_list", { project_id: alpha.id });
    assert.deepEqual(todos.todos.map((t) => t.todo_id).sort(), [todoA, todoB].sort());
  });

  it("creates and comments on a todo in another project", async () => {
    const created = await queenMcp.call("todo_create", { title: "from the queen", project_id: alpha.id });
    await queenMcp.call("todo_comment", { todo_id: created.todo_id, body: "context", project_id: alpha.id });
    assert.equal(db.prepare("SELECT project_id FROM todos WHERE id = ?").get(created.todo_id).project_id, alpha.id);
    assert.equal(
      db.prepare("SELECT author FROM todo_comments WHERE todo_id = ?").get(created.todo_id).author,
      queenLead.actorId,
    );
    db.prepare("DELETE FROM todo_comments WHERE todo_id = ?").run(created.todo_id);
    db.prepare("DELETE FROM todos WHERE id = ?").run(created.todo_id);
  });

  it("sends text to another project's running lead, and refuses keys to it", async () => {
    const sent = await queenMcp.call("agent_send", { name: "lead", text: "status?", project_id: alpha.id });
    assert.ok(sent, "agent_send to the foreign lead must return a receipt");
    const text = await refusal(queenMcp, "agent_send", { name: "lead", keys: ["Escape"], project_id: alpha.id });
    assert.match(text, new RegExp(`^${QUEEN_REFUSAL}:.*keys can interrupt`));
  });

  it("refuses agent_send to another project's worker", async () => {
    const text = await refusal(queenMcp, "agent_send", { agent_id: alphaWorker.id, text: "hi", project_id: alpha.id });
    assert.match(text, new RegExp(`^${QUEEN_REFUSAL}:.*recipient must be that project's running lead`));
  });

  it("sets, edits and cancels its own wake addressed to another project's lead", async () => {
    const wake = await queenMcp.call("wake_set", {
      delay_seconds: 3600,
      body: "check in",
      deliver_to: "lead",
      project_id: alpha.id,
    });
    assert.equal(wake.deliver_to, alphaLead.actorId);
    const updated = await queenMcp.call("wake_update", { wake_id: wake.wake_id, body: "edited", project_id: alpha.id });
    assert.equal(updated.updated, true);
    const cancelled = await queenMcp.call("wake_cancel", { wake_id: wake.wake_id, project_id: alpha.id });
    assert.equal(cancelled.cancelled, true);
  });

  it("refuses a foreign wake with no deliver_to, since the default delivers to the queen's own pane", async () => {
    const text = await refusal(queenMcp, "wake_set", { delay_seconds: 60, body: "x", project_id: alpha.id });
    assert.match(text, new RegExp(`^${QUEEN_REFUSAL}:.*deliver_to must name that project's running lead`));
  });

  it("refuses a standing watch in another project, even one delivered to its lead", async () => {
    const before = db.prepare("SELECT COUNT(*) AS n FROM wakes WHERE project_id = ?").get(alpha.id).n;
    const text = await refusal(queenMcp, "wake_when_idle", {
      scope: "project",
      deliver_to: "lead",
      body: "crew update",
      project_id: alpha.id,
    });
    assert.match(text, new RegExp(`^${QUEEN_REFUSAL}:.*a standing watch in another project belongs to its lead`));
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM wakes WHERE project_id = ?").get(alpha.id).n, before);
  });

  it("refuses to cancel or edit another project's wake that the queen does not own, and leaves it pending", async () => {
    const wakeId = db
      .prepare(
        `INSERT INTO wakes (project_id, owner, body, kind, deliver_actor, deliver_pane, due_at)
         VALUES (?, ?, 'mine', 'delay', ?, '%x', datetime('now', '+1 hour')) RETURNING id`,
      )
      .get(alpha.id, alphaLead.actorId, alphaLead.actorId).id;
    for (const tool of ["wake_cancel", "wake_update"]) {
      const args = tool === "wake_update" ? { wake_id: wakeId, body: "hijack" } : { wake_id: wakeId };
      const text = await refusal(queenMcp, tool, { ...args, project_id: alpha.id });
      assert.match(text, new RegExp(`^${QUEEN_REFUSAL}:`));
    }
    const row = db.prepare("SELECT body, cancelled_at FROM wakes WHERE id = ?").get(wakeId);
    assert.deepEqual(row, { body: "mine", cancelled_at: null });
  });

  it("refuses the queen's wake in a project whose running lead has changed since it was set", async () => {
    const wake = await queenMcp.call("wake_set", {
      delay_seconds: 3600,
      body: "check in",
      deliver_to: "lead",
      project_id: alpha.id,
    });
    db.prepare("UPDATE wakes SET deliver_actor = 'lead:gone' WHERE id = ?").run(wake.wake_id);
    const text = await refusal(queenMcp, "wake_cancel", { wake_id: wake.wake_id, project_id: alpha.id });
    assert.match(text, new RegExp(`^${QUEEN_REFUSAL}:`));
    db.prepare("UPDATE wakes SET cancelled_at = datetime('now') WHERE id = ?").run(wake.wake_id);
  });

  const refusedForeign = {
    pad_write: () => ({ name: "board", content: "x" }),
    pad_append: () => ({ pad_id: seedPad, content: "x" }),
    pad_edit: () => ({ pad_id: seedPad, old_text: "seed", new_text: "x" }),
    pad_archive: () => ({ pad_id: seedPad }),
    pad_delete: () => ({ pad_id: seedPad }),
    todo_update: () => ({ todo_id: todoA, status: "in_progress" }),
    todo_archive: () => ({ todo_id: todoA }),
    todo_complete: () => ({ todo_id: todoA }),
    todo_block: () => ({ todo_id: todoA, blocker_id: todoB }),
    todo_unblock: () => ({ todo_id: todoA, blocker_id: todoB }),
    kv_set: () => ({ key: "k", value: "changed" }),
    kv_delete: () => ({ key: "k" }),
    lease_acquire: () => ({ key: "file:x", ttl_seconds: 60 }),
    lease_release: () => ({ key: "file:x" }),
    agent_spawn: () => ({ name: "intruder" }),
    agent_resume: () => ({ name: "impl" }),
    agent_park: () => ({ name: "impl" }),
    agent_rename: () => ({ name: "impl", new_name: "renamed" }),
    agent_close: () => ({ name: "impl" }),
  };

  it("refuses every other write into another project by name, and changes nothing there", async () => {
    const reachRefused = Object.entries(QUEEN_REACH)
      .filter(([op, reach]) => reach === "home" && !op.startsWith("hive "))
      .map(([op]) => op)
      .sort();
    assert.deepEqual(Object.keys(refusedForeign).sort(), reachRefused, "every home-only tool needs a row here");

    const before = alphaState();
    for (const [tool, args] of Object.entries(refusedForeign)) {
      const text = await refusal(queenMcp, tool, { ...args(), project_id: alpha.id });
      assert.match(text, new RegExp(`^${QUEEN_REFUSAL}: the queen cannot run ${tool} in project ${alpha.id}`), tool);
    }
    assert.deepEqual(alphaState(), before);
  });

  it("refuses the store-wide tools outright", async () => {
    const before = alphaState();
    for (const [tool, args] of [
      ["project_add", { path: dirs.projectDir }],
      ["project_prune", {}],
      ["actor_prune", {}],
    ]) {
      const text = await refusal(queenMcp, tool, args);
      assert.match(text, new RegExp(`^${QUEEN_REFUSAL}:.*changes the whole store`), tool);
    }
    assert.deepEqual(alphaState(), before);
  });

  it("refuses project_select of another project, so an implicit write stays in the queen's own project", async () => {
    const mcp = clientAs(queenLead.actorId, queen.path);
    await mcp.start();
    try {
      const text = await refusal(mcp, "project_select", { project_id: alpha.id });
      assert.match(text, new RegExp(`^${QUEEN_REFUSAL}: the queen cannot run project_select in project ${alpha.id}`));
      const pad = await mcp.call("pad_write", { name: "implicit", content: "x" });
      assert.equal(db.prepare("SELECT project_id FROM pads WHERE id = ?").get(pad.pad_id).project_id, queen.id);
      await mcp.call("project_select", { project_id: queen.id });
    } finally {
      await mcp.close();
    }
  });

  it("returns a refusal from an outputSchema tool as a plain error, not an outputSchema failure", async () => {
    const result = await rawCall(queenMcp, "kv_set", { key: "k", value: 1, project_id: alpha.id });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent, undefined);
    assert.match(result.content[0].text, new RegExp(`^${QUEEN_REFUSAL}:`));
  });

  it("writes freely in its own project", async () => {
    const pad = await queenMcp.call("pad_write", { name: "notes", content: "mine" });
    assert.ok(pad.pad_id);
    const own = await queenMcp.call("kv_set", { key: "q", value: 1 });
    assert.ok(own);
  });

  it("leaves an ordinary lead's cross-project writes as they were", async () => {
    const mcp = clientAs(betaLead.actorId, beta.path);
    await mcp.start();
    try {
      await mcp.call("kv_set", { key: "from-beta", value: 1, project_id: alpha.id });
      assert.ok(db.prepare("SELECT 1 FROM kv WHERE project_id = ? AND key = 'from-beta'").get(alpha.id));
      db.prepare("DELETE FROM kv WHERE project_id = ? AND key = 'from-beta'").run(alpha.id);
    } finally {
      await mcp.close();
    }
  });

  it("does not make a closed queen lead row, or a human session in the queen's home, the queen", async () => {
    const human = new McpClient({ cwd: queen.path, dataDir: dirs.dataDir });
    await human.start();
    try {
      await human.call("kv_set", { key: "from-human", value: 1, project_id: alpha.id });
    } finally {
      await human.close();
    }
    db.prepare("UPDATE agents SET status = 'closed' WHERE id = ?").run(queenLead.id);
    const closed = clientAs(queenLead.actorId, queen.path);
    await closed.start();
    try {
      await closed.call("kv_set", { key: "from-closed", value: 1, project_id: alpha.id });
    } finally {
      await closed.close();
      db.prepare("UPDATE agents SET status = 'running' WHERE id = ?").run(queenLead.id);
      db.prepare("DELETE FROM kv WHERE project_id = ? AND key LIKE 'from-%'").run(alpha.id);
    }
  });

  it("keeps a worker the queen spawned locked to the queen's project", async () => {
    const mcp = new McpClient({
      cwd: queen.path,
      dataDir: dirs.dataDir,
      env: { HIVE_AGENT_ID: queenWorker.actorId, HIVE_PROJECT_LOCK: "1", HIVE_PROJECT_PATH: queen.path },
    });
    await mcp.start();
    try {
      for (const [tool, args] of [
        ["pad_read", { name: "board", project_id: alpha.id }],
        ["todo_create", { title: "x", project_id: alpha.id }],
      ]) {
        const result = await rawCall(mcp, tool, args);
        assert.equal(result.isError, true, tool);
        assert.match(result.content[0].text, /HIVE_PROJECT_LOCK=1\)\. Cross-project access is disabled/, tool);
      }
    } finally {
      await mcp.close();
    }
  });
});
