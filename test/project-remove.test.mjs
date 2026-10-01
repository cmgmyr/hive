import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import { assertScratchStore, clearHiveEnv, fakeFailingTmux, isolateTmux, paneField, scratchDirs } from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("the project-remove tests");
clearHiveEnv();

const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
await assertScratchStore();
const { db, migrate } = await import("../dist/db.js");
migrate();
const { removeProject, projectRowCounts, PROJECT_OWNER_TABLES } = await import("../dist/projectRemove.js");
const { tmuxSocketPath } = await import("../dist/tmux.js");

const OWN_SOCKET = tmuxSocketPath(process.env.TMUX, process.env.TMUX_TMPDIR);
const FOREIGN_SOCKET = "/nonexistent/foreign-socket-dir/tmux-0/default";
const BYSTANDER = `project-remove-bystander-${process.pid}`;
let pane = "%unset";
let pid = "";

before(() => {
  if (!hasTmux) return;
  execFileSync("tmux", ["new-session", "-d", "-s", BYSTANDER, "sleep 600"], { stdio: "ignore" });
  pane = execFileSync("tmux", ["list-panes", "-t", `=${BYSTANDER}`, "-F", "#{pane_id}"], { encoding: "utf8" }).trim();
  pid = paneField(pane, "#{pane_pid}");
});

after(() => cleanup(BYSTANDER));

const bystanderAlive = () => paneField(pane, "#{pane_pid}") === pid;

function runningAgent(p, { name = "x", kind = "agent", target = pane, socket = OWN_SOCKET, panePid = pid } = {}) {
  return db
    .prepare(
      "INSERT INTO agents (project_id, name, kind, command, cwd, status, tmux_target, tmux_socket, pane_pid) VALUES (?, ?, ?, 'sleep', '/tmp', 'running', ?, ?, ?) RETURNING id",
    )
    .get(p, name, kind, target, socket, panePid).id;
}

function withPath(dir, fn) {
  const saved = process.env.PATH;
  process.env.PATH = `${dir}:${saved}`;
  try {
    return fn();
  } finally {
    process.env.PATH = saved;
  }
}

function seedProject(name, { agentStatus = "closed" } = {}) {
  const p = db.prepare("INSERT INTO projects (name, path) VALUES (?, ?) RETURNING id").get(name, `/nowhere/${name}`).id;
  db.prepare("INSERT OR IGNORE INTO actors (id, name, kind) VALUES ('actor:rm', 'rm', 'agent')").run();
  db.prepare("INSERT INTO pads (project_id, name) VALUES (?, 'x')").run(p);
  const todo = db.prepare("INSERT INTO todos (project_id, title) VALUES (?, 'x') RETURNING id").get(p).id;
  db.prepare("INSERT INTO todo_comments (todo_id, author, body) VALUES (?, 'actor:rm', 'x')").run(todo);
  db.prepare("INSERT INTO kv (project_id, key, value) VALUES (?, 'k', 'v')").run(p);
  db.prepare("INSERT INTO leases (project_id, lock_key, owner, expires_at) VALUES (?, 'k', 'actor:rm', datetime('now', '+1 day'))").run(p);
  const agent = db
    .prepare("INSERT INTO agents (project_id, name, command, cwd, status) VALUES (?, 'x', 'sleep', '/tmp', ?) RETURNING id")
    .get(p, agentStatus).id;
  const wake = db
    .prepare("INSERT INTO wakes (project_id, owner, body, deliver_actor, deliver_pane) VALUES (?, 'x', 'x', 'x', 'x') RETURNING id")
    .get(p).id;
  db.prepare("INSERT INTO command_trust (project_id, name, config_hash) VALUES (?, 'x', 'x')").run(p);
  db.prepare("INSERT INTO agent_messages (project_id, from_actor, from_name, to_agent_id, text) VALUES (?, 'a', 'a', ?, 'x')").run(p, agent);
  db.prepare("INSERT INTO lead_idle_subscriptions (wake_id, target_project_id, agent_id, pane_pid) VALUES (?, ?, ?, '1')").run(wake, p, agent);
  return p;
}

const naming = (table, col, p) => db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${col} = ?`).get(p).n;

describe("removeProject", () => {
  it("removes a project owning rows in every table, leaves queen_audit, and snapshots first", () => {
    const keep = seedProject("keep");
    const gone = seedProject("gone");
    db.prepare(
      "INSERT INTO queen_audit (actor_id, home_project_id, target_project_id, operation, resource_type, resource_id, summary) VALUES ('q', ?, ?, 'todo_create', 'todo', 1, 's')",
    ).run(keep, gone);

    const watcherWake = db.prepare("INSERT INTO wakes (project_id, owner, body, deliver_actor, deliver_pane) VALUES (?, 'q', 'x', 'q', 'q') RETURNING id").get(keep).id;
    db.prepare("INSERT INTO lead_idle_subscriptions (wake_id, target_project_id, agent_id, pane_pid) VALUES (?, ?, 1, '1')").run(watcherWake, gone);
    const counts = projectRowCounts(gone);
    for (const t of [...PROJECT_OWNER_TABLES, "todo_comments", "agent_messages"]) {
      assert.equal(counts[t], 1, `${t} counted`);
    }

    const out = removeProject(gone, { snapshot: true });
    assert.equal(out.deleted.name, "gone");
    assert.deepEqual(out.counts, counts);
    assert.ok(out.snapshot && existsSync(out.snapshot), "snapshot file exists");

    for (const t of PROJECT_OWNER_TABLES) assert.equal(naming(t, "project_id", gone), 0, t);
    assert.equal(naming("agent_messages", "project_id", gone), 0);
    assert.equal(naming("lead_idle_subscriptions", "target_project_id", gone), 1, "a watcher in another project keeps its subscription");
    assert.equal(naming("dashboard_meta", "project_id", gone), 0);
    assert.equal(naming("projects", "id", gone), 0);
    assert.equal(naming("queen_audit", "target_project_id", gone), 1);
    assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0);
    assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
    assert.equal(naming("pads", "project_id", keep), 1, "other project untouched");
    assert.equal(naming("todo_comments", "todo_id", db.prepare("SELECT id FROM todos WHERE project_id = ?").get(keep).id), 1);
  });

  const skip = !hasTmux && "tmux is not installed";

  it("refuses a project whose running worker owns a live pane, names it, and deletes nothing", { skip }, () => {
    const p = seedProject("busy");
    runningAgent(p);
    assert.throws(
      () => removeProject(p, { snapshot: false }),
      /running agents: x \(agent \d+, owns a live pane\)\. Nothing deleted\. Stop a live worker or command with agent_close first\./,
    );
    assert.equal(naming("projects", "id", p), 1);
    assert.equal(naming("todos", "project_id", p), 1);
    assert.equal(naming("agent_messages", "project_id", p), 1);
  });

  it("refuses a live lead with the own-terminal remedy, never row_only", { skip }, () => {
    const p = seedProject("live-lead");
    runningAgent(p, { name: "lead", kind: "lead" });
    assert.throws(() => removeProject(p, { snapshot: false }), /stopped or restarted from its own terminal, never retired with row_only/);
    assert.equal(naming("projects", "id", p), 1);
  });

  it("removes a project whose only running rows provably lost their panes: an empty target and a reissued lead", { skip }, () => {
    const p = seedProject("stale-rows");
    runningAgent(p, { name: "empty", target: "", panePid: "" });
    runningAgent(p, { name: "lead", kind: "lead", panePid: "1" });
    const out = removeProject(p, { snapshot: true });
    assert.ok(out.snapshot && existsSync(out.snapshot));
    assert.equal(naming("projects", "id", p), 0);
    assert.equal(naming("agents", "project_id", p), 0);
    assert.ok(bystanderAlive(), "removing a reissued row must not touch the pane's new owner");
  });

  const rowOnlyHint = (id) => new RegExp(`agent_close\\(\\{agent_id: ${id}, row_only: true\\}\\)`);
  const RERUN = /run this again from the tmux socket a foreign-socket row was recorded on/;
  for (const [name, seed, run, hint, rerun] of [
    ["an empty recorded pid on a live pane id", (p) => runningAgent(p, { name: "lead", kind: "lead", panePid: "" }), (f) => f(), rowOnlyHint, false],
    ["a foreign recorded socket", (p) => runningAgent(p, { name: "lead", kind: "lead", socket: FOREIGN_SOCKET }), (f) => f(), rowOnlyHint, true],
    [
      "a failed tmux probe",
      (p) => runningAgent(p, { name: "lead", kind: "lead" }),
      (f) => withPath(fakeFailingTmux({ failOn: "list-panes" }), f),
      () => /tmux could not be probed[\s\S]*Retry in a few seconds/,
      false,
    ],
  ]) {
    it(`refuses ${name} as pane identity unknown with the remedy that reaches it, leaving every row`, { skip }, () => {
      const p = seedProject(`unknown-${name}`);
      const id = seed(p);
      const counts = projectRowCounts(p);
      let message = "";
      assert.throws(() => run(() => removeProject(p, { snapshot: false })), (e) => ((message = e.message), true));
      assert.match(message, new RegExp(`lead \\(agent ${id}, pane identity unknown\\)`));
      assert.match(message, hint(id));
      assert.equal(RERUN.test(message), rerun, message);
      assert.deepEqual(projectRowCounts(p), counts);
      assert.ok(bystanderAlive());
    });
  }

  it("names both remedies when a live worker and an unknown lead block together", { skip }, () => {
    const p = seedProject("mixed");
    runningAgent(p, { name: "w" });
    runningAgent(p, { name: "lead", kind: "lead", panePid: "" });
    assert.throws(() => removeProject(p, { snapshot: false }), /owns a live pane[\s\S]*pane identity unknown[\s\S]*agent_close first[\s\S]*row_only: true/);
  });

  it("re-checks running agents inside the delete transaction after the snapshot", { skip }, () => {
    const p = seedProject("raced-agent");
    assert.throws(
      () => removeProject(p, { snapshot: true, afterSnapshot: () => runningAgent(p, { name: "late" }) }),
      /running agents: late/,
    );
    assert.equal(naming("projects", "id", p), 1);
    assert.equal(naming("pads", "project_id", p), 1);
  });

  it("catches the same row republished from gone to live after the snapshot, with row counts unchanged", { skip }, () => {
    const p = seedProject("republished");
    const id = runningAgent(p, { name: "lead", kind: "lead", target: "", panePid: "" });
    const counts = projectRowCounts(p);
    assert.throws(
      () =>
        removeProject(p, {
          snapshot: true,
          afterSnapshot: () => db.prepare("UPDATE agents SET tmux_target = ?, pane_pid = ? WHERE id = ?").run(pane, pid, id),
        }),
      /running agents: lead \(agent \d+, owns a live pane\)/,
    );
    assert.deepEqual(projectRowCounts(p), counts);
    assert.equal(naming("projects", "id", p), 1);
  });

  it("aborts when the project's rows changed while the snapshot was taken", () => {
    const p = seedProject("raced-rows");
    assert.throws(
      () => removeProject(p, { snapshot: true, afterSnapshot: () => db.prepare("INSERT INTO todos (project_id, title) VALUES (?, 'late')").run(p) }),
      /changed while the snapshot was taken; nothing removed, run it again/,
    );
    assert.equal(naming("projects", "id", p), 1);
    assert.equal(naming("todos", "project_id", p), 2);
  });

  it("treats a project deleted by someone else mid-removal as no project, with no receipt and no callback", () => {
    const p = db.prepare("INSERT INTO projects (name, path) VALUES ('vanishing', '/nowhere/vanishing') RETURNING id").get().id;
    let called = false;
    assert.throws(
      () => removeProject(p, { snapshot: false, afterSnapshot: () => db.prepare("DELETE FROM projects WHERE id = ?").run(p), onRemoved: () => { called = true; } }),
      new RegExp(`no project ${p}`),
    );
    assert.equal(called, false);
  });

  it("refuses an unknown project id", () => {
    assert.throws(() => removeProject(999999, { snapshot: false }), /no project 999999/);
  });
});
