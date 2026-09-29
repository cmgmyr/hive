import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { clearHiveEnv, isolateTmux, runCli, scratchDirs, tmux } from "./helpers.mjs";

const { cleanup: cleanupTmux, hasTmux } = isolateTmux("the portfolio tests");
clearHiveEnv();

const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;

const { db, migrate } = await import("../dist/db.js");
migrate();
const { addProject } = await import("../dist/context.js");
const { collectPortfolio } = await import("../dist/portfolio.js");

after(() => {
  for (const name of sessions) {
    try {
      tmux("kill-session", "-t", `=${name}`);
    } catch {}
  }
  cleanupTmux();
});

const NOW = "2026-09-29 12:00:00";
const at = (modifier) => db.prepare("SELECT datetime(?, ?) AS t").get(NOW, modifier).t;
const OLD = "2026-01-02 00:00:00";

let seq = 0;
function project(name = `p${++seq}`, { rootMissing = false } = {}) {
  const root = join(dirs.tmp, `${name}-${seq}`);
  mkdirSync(root, { recursive: true });
  const p = addProject(root, name);
  db.prepare("UPDATE projects SET created_at = ? WHERE id = ?").run(OLD, p.id);
  if (rootMissing) rmSync(root, { recursive: true });
  return p;
}

function todo(p, { title = "t", status = "open", priority = "medium", tags = [], updated = OLD, archived = false } = {}) {
  return db
    .prepare(
      `INSERT INTO todos (project_id, title, status, priority, tags, updated_at, archived_at)
       VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    )
    .get(p.id, title, status, priority, JSON.stringify(tags), updated, archived ? OLD : null).id;
}

const block = (todoId, blockerId) =>
  db.prepare("INSERT INTO todo_blockers (todo_id, blocker_id) VALUES (?, ?)").run(todoId, blockerId);

function agent(p, { kind = "agent", state = "working", target = "%nope", socket = "", status = "running" } = {}) {
  return db
    .prepare(
      `INSERT INTO agents (project_id, actor_id, name, tmux_target, tmux_socket, command, cwd, kind, status,
                           agent_state, created_at, state_changed_at)
       VALUES (?, ?, ?, ?, ?, 'claude', ?, ?, ?, ?, ?, ?) RETURNING id`,
    )
    .get(p.id, `${kind}:${++seq}`, `${kind}-${seq}`, target, socket, p.path, kind, status, state, OLD, OLD).id;
}

function wake(p, { due = null, repeat = null, fired = null, cancelled = null } = {}) {
  return db
    .prepare(
      `INSERT INTO wakes (project_id, owner, body, kind, deliver_actor, deliver_pane, due_at, repeat_every_ms,
                          fired_at, cancelled_at, created_at)
       VALUES (?, 'lead:1', 'b', 'delay', 'lead:1', '%x', ?, ?, ?, ?, ?) RETURNING id`,
    )
    .get(p.id, due, repeat, fired, cancelled, OLD).id;
}

const sessions = [];
function livePane() {
  const name = `pf${++seq}`;
  sessions.push(name);
  return tmux("new-session", "-d", "-P", "-F", "#{pane_id}", "-s", name, "sleep 300");
}

const row = (p) => collectPortfolio(NOW).projects.find((r) => r.id === p.id);

describe("portfolio: empty store", () => {
  it("reports zero projects with an all-zero lane tally", () => {
    const r = collectPortfolio(NOW);
    assert.deepEqual(r, {
      schema_version: 1,
      as_of: NOW,
      totals: { projects: 0, lanes: { waiting_on_you: 0, stuck: 0, moving: 0, quiet: 0 } },
      projects: [],
    });
  });
});

describe("portfolio lanes", () => {
  it("puts an empty project in quiet with the quiet reason and last activity from its creation", () => {
    const p = project();
    const r = row(p);
    assert.equal(r.lane, "quiet");
    assert.deepEqual(r.reasons, ["quiet"]);
    assert.equal(r.last_activity_at, OLD);
    assert.deepEqual(r.lead, { state: "none", agent_id: null });
  });

  it("puts a needs-human todo in waiting_on_you", () => {
    const p = project();
    todo(p, { tags: ["needs-human"] });
    const r = row(p);
    assert.equal(r.lane, "waiting_on_you");
    assert.deepEqual(r.reasons, ["needs_human"]);
  });

  it("puts an in_progress todo in moving", () => {
    const p = project();
    todo(p, { status: "in_progress", updated: at("-1 hour") });
    const r = row(p);
    assert.equal(r.lane, "moving");
    assert.deepEqual(r.reasons, ["todo_in_progress"]);
  });

  it("puts a blocked in_progress todo in stuck, and not in moving", () => {
    const p = project();
    const a = todo(p, { status: "in_progress", updated: at("-1 hour") });
    const b = todo(p);
    block(a, b);
    const r = row(p);
    assert.equal(r.lane, "stuck");
    assert.deepEqual(r.reasons, ["in_progress_blocked", "todo_in_progress"]);
    assert.equal(r.todos.blocked_in_progress, 1);
  });

  it("keeps every reason once, in contract order, when several lanes overlap", () => {
    const p = project();
    todo(p, { status: "in_progress", tags: ["needs-human"], updated: at("-1 hour") });
    wake(p, { due: at("-10 minutes") });
    const r = row(p);
    assert.equal(r.lane, "waiting_on_you");
    assert.deepEqual(r.reasons, ["needs_human", "wake_overdue_5m", "todo_in_progress"]);
  });

  it("counts totals per lane and sorts projects by id", () => {
    const r = collectPortfolio(NOW);
    const ids = r.projects.map((x) => x.id);
    assert.deepEqual(ids, [...ids].sort((x, y) => x - y));
    assert.equal(r.totals.projects, r.projects.length);
    for (const lane of ["waiting_on_you", "stuck", "moving", "quiet"]) {
      assert.equal(r.totals.lanes[lane], r.projects.filter((x) => x.lane === lane).length);
    }
  });
});

describe("portfolio todo counts", () => {
  it("counts only active todos and never caps at 200+", () => {
    const p = project();
    for (let i = 0; i < 230; i++) todo(p, { priority: i % 2 ? "high" : "low" });
    todo(p, { status: "completed", priority: "high" });
    todo(p, { status: "backlog", priority: "high" });
    todo(p, { archived: true, priority: "high" });
    const r = row(p);
    assert.equal(r.todos.open, 230);
    assert.equal(r.todos.high, 115);
    assert.equal(r.todos.in_progress, 0);
  });

  it("blocks on an open blocker, even an archived one, but not on a completed one; counts todos, not edges", () => {
    const p = project();
    const target = todo(p);
    const archivedOpen = todo(p, { archived: true });
    const done = todo(p, { status: "completed" });
    const target2 = todo(p);
    block(target, archivedOpen);
    block(target, todo(p));
    block(target2, done);
    const r = row(p);
    assert.equal(r.todos.blocked, 1);
  });

  it("lands in stuck when every active todo is blocked", () => {
    const p = project();
    const a = todo(p);
    const blocker = todo(p, { status: "completed" });
    const open = todo(p, { status: "backlog" });
    block(a, open);
    void blocker;
    const r = row(p);
    assert.equal(r.lane, "stuck");
    assert.deepEqual(r.reasons, ["all_active_todos_blocked"]);
  });
});

describe("portfolio needs-human", () => {
  it("matches the exact tag on active todos only, oldest ask first, capped at 5 with the full count", () => {
    const p = project();
    const ids = [];
    for (let i = 0; i < 7; i++) {
      ids.push(todo(p, { title: `ask${i}`, tags: ["needs-human"], updated: `2026-09-0${7 - i} 00:00:00` }));
    }
    todo(p, { title: "near", tags: ["needs-human-later"] });
    todo(p, { title: "plain", tags: [] });
    todo(p, { title: "done", tags: ["needs-human"], status: "completed" });
    todo(p, { title: "shelf", tags: ["needs-human"], status: "backlog" });
    todo(p, { title: "gone", tags: ["needs-human"], archived: true });
    const r = row(p);
    assert.equal(r.needs_human, 7);
    assert.equal(r.needs_human_items.length, 5);
    assert.deepEqual(
      r.needs_human_items.map((i) => i.title),
      ["ask6", "ask5", "ask4", "ask3", "ask2"],
    );
    assert.equal(r.needs_human_items[0].todo_id, ids[6]);
  });

  it("breaks updated_at ties by todo id", () => {
    const p = project();
    const first = todo(p, { tags: ["needs-human"] });
    const second = todo(p, { tags: ["needs-human"] });
    assert.deepEqual(row(p).needs_human_items.map((i) => i.todo_id), [first, second]);
  });
});

describe("portfolio wakes", () => {
  it("does not call a wake due exactly now overdue, but counts it pending", () => {
    const p = project();
    wake(p, { due: NOW });
    const r = row(p);
    assert.deepEqual(r.wakes, { pending: 1, overdue: 0 });
    assert.equal(r.lane, "moving");
    assert.deepEqual(r.reasons, ["wake_due_24h"]);
  });

  it("gives a wake five minutes of grace, then calls the project stuck at exactly five", () => {
    const grace = project();
    wake(grace, { due: at("-299 seconds") });
    assert.equal(row(grace).wakes.overdue, 1);
    assert.equal(row(grace).lane, "moving");
    const past = project();
    wake(past, { due: at("-5 minutes") });
    assert.equal(row(past).lane, "stuck");
    assert.deepEqual(row(past).reasons, ["wake_overdue_5m"]);
  });

  it("counts a fired repeating wake, ignores a fired one-shot and a cancelled one, and treats null due as pending only", () => {
    const p = project();
    wake(p, { due: at("+2 days"), repeat: 60000, fired: OLD });
    wake(p, { due: at("-2 days"), fired: OLD });
    wake(p, { due: at("-2 days"), cancelled: OLD });
    wake(p);
    const r = row(p);
    assert.deepEqual(r.wakes, { pending: 2, overdue: 0 });
    assert.equal(r.lane, "quiet");
  });

  it("keeps a wake due in exactly 24 hours moving and one past that quiet", () => {
    const edge = project();
    wake(edge, { due: at("+24 hours") });
    assert.equal(row(edge).lane, "moving");
    const far = project();
    wake(far, { due: at("+86401 seconds") });
    assert.equal(row(far).lane, "quiet");
  });
});

describe("portfolio staleness", () => {
  it("calls in_progress work stuck at exactly 48 hours of silence, not one second sooner", () => {
    const stale = project();
    db.prepare("UPDATE projects SET created_at = ? WHERE id = ?").run(at("-48 hours"), stale.id);
    todo(stale, { status: "in_progress", updated: at("-48 hours") });
    assert.equal(row(stale).lane, "stuck");
    assert.deepEqual(row(stale).reasons, ["stale_in_progress_48h", "todo_in_progress"]);

    const fresh = project();
    db.prepare("UPDATE projects SET created_at = ? WHERE id = ?").run(at("-48 hours"), fresh.id);
    todo(fresh, { status: "in_progress", updated: at("-172799 seconds") });
    assert.equal(row(fresh).lane, "moving");
  });
});

describe("portfolio missing root", () => {
  it("still gets a row, flags the root, and is stuck only when work is pending", () => {
    const idle = project("gone-idle", { rootMissing: true });
    const r = row(idle);
    assert.equal(r.root_exists, false);
    assert.equal(r.lane, "quiet");

    const busy = project("gone-busy", { rootMissing: true });
    todo(busy);
    const b = row(busy);
    assert.equal(b.root_exists, false);
    assert.equal(b.lane, "stuck");
    assert.deepEqual(b.reasons, ["missing_root_with_work"]);
  });
});

describe("portfolio panes", () => {
  const skip = !hasTmux && "tmux is not installed";
  it("stays quiet with lead.state dead_pane when a dead lead has no in_progress work and no wakes", { skip }, () => {
    const p = project();
    const id = agent(p, { kind: "lead", state: "idle", target: "%dead" });
    todo(p);
    const r = row(p);
    assert.deepEqual(r.lead, { state: "dead_pane", agent_id: id });
    assert.equal(r.lane, "quiet");
  });

  it("calls a dead lead stuck when it leaves in_progress work or a pending wake", { skip }, () => {
    const withTodo = project();
    agent(withTodo, { kind: "lead", target: "%dead" });
    todo(withTodo, { status: "in_progress", updated: at("-1 hour") });
    assert.equal(row(withTodo).lane, "stuck");
    assert.deepEqual(row(withTodo).reasons, ["dead_lead_pane", "todo_in_progress"]);

    const withWake = project();
    agent(withWake, { kind: "lead", target: "%dead" });
    wake(withWake);
    assert.equal(row(withWake).lane, "stuck");
  });

  it("reads a foreign-socket lead as unknown, never dead", { skip }, () => {
    const p = project();
    agent(p, { kind: "lead", target: "%dead", socket: "/somewhere/else/default" });
    todo(p, { status: "in_progress", updated: at("-1 hour") });
    const r = row(p);
    assert.equal(r.lead.state, "unknown");
    assert.equal(r.lane, "moving");
  });

  it("groups workers by liveness and state: live working, waiting, idle, other; dead unreachable; foreign unconfirmed", { skip }, () => {
    const p = project();
    agent(p, { state: "working", target: livePane() });
    agent(p, { state: "waiting", target: livePane() });
    agent(p, { state: "idle", target: livePane() });
    agent(p, { state: "unknown", target: livePane() });
    agent(p, { state: "working", target: "%dead" });
    agent(p, { state: "working", target: "%dead", socket: "/somewhere/else/default" });
    agent(p, { state: "working", target: "%dead", status: "closed" });
    const r = row(p);
    assert.deepEqual(r.workers, { working: 1, idle: 1, needs_input: 1, other: 1, unreachable: 1, unconfirmed: 1 });
    assert.equal(r.lane, "stuck");
    assert.deepEqual(r.reasons, ["worker_needs_input", "worker_working"]);
  });

  it("puts a live working worker in moving", { skip }, () => {
    const p = project();
    agent(p, { state: "working", target: livePane() });
    assert.equal(row(p).lane, "moving");
    assert.deepEqual(row(p).reasons, ["worker_working"]);
  });
});

describe("portfolio is read-only", () => {
  it("leaves every store row untouched", () => {
    const snapshot = () =>
      ["projects", "todos", "todo_blockers", "todo_comments", "agents", "wakes", "pads", "agent_state_log"]
        .map((t) => JSON.stringify(db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()))
        .join("\n");
    const before = snapshot();
    collectPortfolio(NOW);
    collectPortfolio();
    assert.equal(snapshot(), before);
  });
});

describe("hive portfolio CLI", () => {
  const run = (args) => runCli(args, { cwd: dirs.projectDir, dataDir: dirs.dataDir });

  it("prints one JSON object whose shape matches the v1 contract", async () => {
    const { code, stdout, stderr } = await run(["portfolio", "--json"]);
    assert.equal(code, 0, stderr);
    assert.ok(stdout.endsWith("\n") && !stdout.trimEnd().includes("\n"), "one line of JSON");
    const report = JSON.parse(stdout);
    assert.deepEqual(Object.keys(report), ["schema_version", "as_of", "totals", "projects"]);
    assert.equal(report.schema_version, 1);
    assert.deepEqual(Object.keys(report.totals.lanes), ["waiting_on_you", "stuck", "moving", "quiet"]);
    assert.ok(report.projects.length > 0);
    const p = report.projects[0];
    assert.deepEqual(Object.keys(p), [
      "id", "name", "root", "root_exists", "lane", "reasons", "lead", "workers", "todos", "needs_human",
      "needs_human_items", "last_activity_at", "wakes",
    ]);
    assert.deepEqual(Object.keys(p.lead), ["state", "agent_id"]);
    assert.deepEqual(Object.keys(p.workers), ["working", "idle", "needs_input", "other", "unreachable", "unconfirmed"]);
    assert.deepEqual(Object.keys(p.todos), ["open", "in_progress", "blocked", "blocked_in_progress", "high"]);
    assert.deepEqual(Object.keys(p.wakes), ["pending", "overdue"]);
    assert.equal(report.totals.projects, report.projects.length);
  });

  it("prints one text row per project", async () => {
    const { code, stdout } = await run(["portfolio"]);
    assert.equal(code, 0);
    const heads = stdout.split("\n").filter((l) => /^(waiting_on_you|stuck|moving|quiet)\s/.test(l));
    assert.equal(heads.length, collectPortfolio().projects.length);
  });

  it("rejects an unknown flag and a positional argument", async () => {
    for (const args of [["--bogus"], ["extra"]]) {
      const { code, stderr, stdout } = await run(["portfolio", ...args]);
      assert.equal(code, 1);
      assert.match(stderr, /hive portfolio: unknown argument/);
      assert.equal(stdout, "");
    }
  });

  it("says so when no projects are registered", async () => {
    const fresh = scratchDirs();
    const { code, stdout } = await runCli(["portfolio"], { cwd: fresh.projectDir, dataDir: fresh.dataDir });
    assert.equal(code, 0);
    assert.equal(stdout.trim(), "No registered projects.");
  });
});
