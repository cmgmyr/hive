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
const { collectPortfolio, leadText, ACTIVE_WAKE_WHERE } = await import("../dist/portfolio.js");
const { ACTIVE_TIMER_WHERE } = await import("../dist/scheduler.js");

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

function agent(
  p,
  { kind = "agent", state = "working", target = "%nope", socket = "", status = "running", created = OLD, changed = OLD } = {},
) {
  return db
    .prepare(
      `INSERT INTO agents (project_id, actor_id, name, tmux_target, tmux_socket, command, cwd, kind, status,
                           agent_state, created_at, state_changed_at)
       VALUES (?, ?, ?, ?, ?, 'claude', ?, ?, ?, ?, ?, ?) RETURNING id`,
    )
    .get(p.id, `${kind}:${++seq}`, `${kind}-${seq}`, target, socket, p.path, kind, status, state, created, changed).id;
}

function wake(
  p,
  { due = null, repeat = null, fired = null, cancelled = null, kind = "delay", maxWait = null, created = OLD, heldReason = null } = {},
) {
  return db
    .prepare(
      `INSERT INTO wakes (project_id, owner, body, kind, deliver_actor, deliver_pane, due_at, repeat_every_ms,
                          fired_at, cancelled_at, created_at, max_wait_at, held_at, held_reason)
       VALUES (?, 'lead:1', 'b', ?, 'lead:1', '%x', ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    )
    .get(p.id, kind, due, repeat, fired, cancelled, created, maxWait, heldReason === null ? null : at("-1 hour"), heldReason).id;
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
    assert.deepEqual(r.lead, { state: "none", agent_id: null, turn: "unknown" });
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
    assert.equal(r.lane, "stuck");
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
    const onArchivedOnly = todo(p);
    const onTwo = todo(p);
    const onDoneOnly = todo(p);
    const archivedOpen = todo(p, { archived: true });
    const done = todo(p, { status: "completed" });
    block(onArchivedOnly, archivedOpen);
    block(onTwo, todo(p));
    block(onTwo, todo(p));
    block(onDoneOnly, done);
    assert.equal(row(p).todos.blocked, 2);
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
    assert.equal(r.lane, "quiet");
    assert.deepEqual(r.reasons, ["wake_due_24h", "quiet"]);
  });

  it("gives a wake five minutes of grace, then calls the project stuck at exactly five", () => {
    const grace = project();
    wake(grace, { due: at("-299 seconds") });
    assert.equal(row(grace).wakes.overdue, 1);
    assert.equal(row(grace).lane, "quiet");
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

  it("reports a wake due in exactly 24 hours as a reason and one past that not, and neither moves the project", () => {
    const edge = project();
    wake(edge, { due: at("+24 hours") });
    assert.equal(row(edge).lane, "quiet");
    assert.ok(row(edge).reasons.includes("wake_due_24h"));
    const far = project();
    wake(far, { due: at("+86401 seconds") });
    assert.equal(row(far).lane, "quiet");
    assert.ok(!row(far).reasons.includes("wake_due_24h"));
  });
});

describe("portfolio idle-watch wakes", () => {
  it("measures an idle-watch wake (due_at NULL, max_wait_at set) against max_wait_at", () => {
    const expired = project();
    wake(expired, { kind: "idle_any", maxWait: at("-1 day") });
    const r = row(expired);
    assert.deepEqual(r.wakes, { pending: 1, overdue: 1 });
    assert.equal(r.lane, "stuck");
    assert.deepEqual(r.reasons, ["wake_overdue_5m"]);

    const upcoming = project();
    wake(upcoming, { kind: "idle_all", maxWait: at("+2 hours") });
    assert.deepEqual(row(upcoming).wakes, { pending: 1, overdue: 0 });
    assert.equal(row(upcoming).lane, "quiet");
  });

  it("keeps the local active-wake clause identical to the scheduler's", () => {
    assert.equal(ACTIVE_WAKE_WHERE, ACTIVE_TIMER_WHERE);
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

  it("is stuck when the only work is a pending wake", () => {
    const p = project("gone-wake", { rootMissing: true });
    wake(p, { due: at("+2 days") });
    const r = row(p);
    assert.equal(r.lane, "stuck");
    assert.deepEqual(r.reasons, ["missing_root_with_work"]);
  });
});

describe("portfolio last_activity_at", () => {
  const T = "2026-09-20 10:00:00";
  const sources = {
    "todos.updated_at": (p) => todo(p, { updated: T }),
    "todo_comments.created_at": (p) => {
      const id = todo(p);
      db.prepare("INSERT INTO todo_comments (todo_id, author, body, created_at) VALUES (?, 'a', 'b', ?)").run(id, T);
    },
    "pads.updated_at": (p) =>
      db.prepare("INSERT INTO pads (project_id, name, content, updated_at) VALUES (?, 'n', 'c', ?)").run(p.id, T),
    "agents.created_at": (p) => agent(p, { created: T }),
    "agents.state_changed_at": (p) => agent(p, { changed: T }),
    "agent_state_log.created_at (milliseconds)": (p) => {
      const id = agent(p);
      const actor = db.prepare("SELECT actor_id FROM agents WHERE id = ?").get(id).actor_id;
      db.prepare("INSERT INTO agent_state_log (actor_id, event, state, created_at) VALUES (?, 'e', 'idle', ?)").run(
        actor,
        `${T}.500`,
      );
    },
    "wakes.created_at": (p) => wake(p, { created: T }),
    "wakes.fired_at": (p) => wake(p, { fired: T }),
  };

  for (const [name, seed] of Object.entries(sources)) {
    it(`moves when only ${name} is newer`, () => {
      const p = project();
      seed(p);
      assert.equal(row(p).last_activity_at, T);
    });
  }

  it("ignores another project's agent_state_log rows", () => {
    const other = project();
    const mine = project();
    const id = agent(other);
    const actor = db.prepare("SELECT actor_id FROM agents WHERE id = ?").get(id).actor_id;
    db.prepare("INSERT INTO agent_state_log (actor_id, event, state, created_at) VALUES (?, 'e', 'idle', ?)").run(
      actor,
      "2026-09-25 00:00:00.250",
    );
    assert.equal(row(mine).last_activity_at, OLD);
  });

  it("treats a millisecond log row exactly at the 48h edge as stale and one second newer as fresh", () => {
    const stuck = project();
    todo(stuck, { status: "in_progress", updated: OLD });
    const stuckAgent = agent(stuck);
    const fresh = project();
    todo(fresh, { status: "in_progress", updated: OLD });
    const freshAgent = agent(fresh);
    const log = (agentId, ts) => {
      const actor = db.prepare("SELECT actor_id FROM agents WHERE id = ?").get(agentId).actor_id;
      db.prepare("INSERT INTO agent_state_log (actor_id, event, state, created_at) VALUES (?, 'e', 'idle', ?)").run(
        actor,
        ts,
      );
    };
    log(stuckAgent, `${at("-48 hours")}.500`);
    log(freshAgent, `${at("-172799 seconds")}.500`);
    assert.equal(row(stuck).last_activity_at, at("-48 hours"));
    assert.equal(row(stuck).lane, "stuck");
    assert.equal(row(fresh).lane, "moving");
  });
});

describe("portfolio panes", () => {
  const skip = !hasTmux && "tmux is not installed";
  it("stays quiet with lead.state dead_pane when a dead lead has no in_progress work and no wakes", { skip }, () => {
    const p = project();
    const id = agent(p, { kind: "lead", state: "idle", target: "%dead" });
    todo(p);
    const r = row(p);
    assert.deepEqual(r.lead, { state: "dead_pane", agent_id: id, turn: "unknown" });
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

  it("reads a lead whose pane id was reissued to a different pid as dead_pane, and a matching pid as alive", { skip }, () => {
    const reissued = project();
    const id = agent(reissued, { kind: "lead", state: "idle", target: livePane() });
    db.prepare("UPDATE agents SET pane_pid = '1' WHERE id = ?").run(id);
    todo(reissued, { status: "in_progress", updated: at("-1 hour") });
    assert.deepEqual(row(reissued).lead, { state: "dead_pane", agent_id: id, turn: "unknown" });
    assert.deepEqual(row(reissued).reasons, ["dead_lead_pane", "todo_in_progress"]);

    const same = project();
    const sameId = agent(same, { kind: "lead", state: "idle", target: livePane() });
    const pid = db.prepare("SELECT tmux_target FROM agents WHERE id = ?").get(sameId).tmux_target;
    const livePid = tmux("display-message", "-p", "-t", pid, "#{pane_pid}");
    db.prepare("UPDATE agents SET pane_pid = ? WHERE id = ?").run(livePid, sameId);
    assert.equal(row(same).lead.state, "alive");
  });

  it("counts a worker whose pane id was reissued to a different pid as unreachable, not working", { skip }, () => {
    const p = project();
    const id = agent(p, { state: "working", target: livePane() });
    db.prepare("UPDATE agents SET pane_pid = '1' WHERE id = ?").run(id);
    const r = row(p);
    assert.deepEqual(r.workers, { working: 0, idle: 0, needs_input: 0, other: 0, unreachable: 1, unconfirmed: 0 });
    assert.equal(r.lane, "quiet");
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

  it("does not call in_progress work stale while a live worker is working on it", { skip }, () => {
    const p = project();
    db.prepare("UPDATE projects SET created_at = ? WHERE id = ?").run(at("-72 hours"), p.id);
    todo(p, { status: "in_progress", updated: at("-72 hours") });
    agent(p, { state: "working", target: livePane(), created: at("-72 hours"), changed: at("-72 hours") });
    const r = row(p);
    assert.equal(r.lane, "moving");
    assert.deepEqual(r.reasons, ["worker_working", "todo_in_progress"]);
  });

  it("ignores running non-agent rows when counting workers", { skip }, () => {
    const p = project();
    agent(p, { kind: "command", state: "working", target: livePane() });
    const r = row(p);
    assert.deepEqual(r.workers, { working: 0, idle: 0, needs_input: 0, other: 0, unreachable: 0, unconfirmed: 0 });
    assert.deepEqual(r.lead, { state: "none", agent_id: null, turn: "unknown" });
    assert.equal(r.lane, "quiet");
  });

  it("puts a live working worker in moving", { skip }, () => {
    const p = project();
    agent(p, { state: "working", target: livePane() });
    assert.equal(row(p).lane, "moving");
    assert.deepEqual(row(p).reasons, ["worker_working"]);
  });
});

describe("portfolio lead turn", () => {
  const skip = !hasTmux && "tmux is not installed";
  const insertTurn = (id, panePid, state) =>
    db
      .prepare(
        "INSERT INTO lead_turn_state (agent_id, pane_pid, session_id, state, idle_seq, last_event, changed_at) VALUES (?, ?, 's', ?, 1, 'stop', ?)",
      )
      .run(id, panePid, state, OLD);

  // rowPid: null = no row, "live" = the pane's real pid, anything else = a row from another launch
  const aliveLead = (rowPid, state) => {
    const p = project();
    const id = agent(p, { kind: "lead", state: "idle", target: livePane() });
    const target = db.prepare("SELECT tmux_target FROM agents WHERE id = ?").get(id).tmux_target;
    const livePid = tmux("display-message", "-p", "-t", target, "#{pane_pid}");
    db.prepare("UPDATE agents SET pane_pid = ? WHERE id = ?").run(livePid, id);
    if (rowPid !== null) insertTurn(id, rowPid === "live" ? livePid : rowPid, state);
    return p;
  };

  it("maps a matching-pane working row to working and an idle row to turn_ended", { skip }, () => {
    assert.equal(row(aliveLead("live", "working")).lead.turn, "working");
    assert.equal(row(aliveLead("live", "idle")).lead.turn, "turn_ended");
  });

  it("reads unknown for no row, an unknown state, or a row from another pane launch", { skip }, () => {
    assert.equal(row(aliveLead(null)).lead.turn, "unknown");
    assert.equal(row(aliveLead("live", "unknown")).lead.turn, "unknown");
    assert.equal(row(aliveLead("999999", "idle")).lead.turn, "unknown");
  });

  it("leaves the lane and reasons exactly as they were without a turn row", { skip }, () => {
    const withTurn = aliveLead("live", "idle");
    const without = aliveLead(null);
    assert.equal(row(withTurn).lane, row(without).lane);
    assert.deepEqual(row(withTurn).reasons, row(without).reasons);
  });

  it("reads unknown for a dead-pane lead even when a matching working row exists", () => {
    const p = project();
    const id = agent(p, { kind: "lead", state: "idle", target: "%dead" });
    db.prepare("UPDATE agents SET pane_pid = '100' WHERE id = ?").run(id);
    insertTurn(id, "100", "working");
    const r = row(p);
    assert.equal(r.lead.state, "dead_pane");
    assert.equal(r.lead.turn, "unknown");
  });

  it("leadText appends the turn only for an alive lead with a known turn", () => {
    const at = (state, turn) => ({ lead: { state, agent_id: 1, turn } });
    assert.equal(leadText(at("alive", "turn_ended")), "alive, turn ended");
    assert.equal(leadText(at("alive", "working")), "alive, turn working");
    assert.equal(leadText(at("alive", "unknown")), "alive");
    assert.equal(leadText(at("dead_pane", "working")), "dead_pane");
  });

  it("hive portfolio prints the lead line through leadText", async () => {
    const p = project();
    agent(p, { kind: "lead", state: "idle", target: "%dead" });
    const { code, stdout } = await runCli(["portfolio"], { cwd: dirs.projectDir, dataDir: dirs.dataDir });
    assert.equal(code, 0);
    const block = stdout.split("\n").findIndex((l) => l.includes(`${p.name} (#${p.id})`));
    assert.match(stdout.split("\n")[block + 2], /^ {2}lead (dead_pane|unknown); workers /);
  });
});

describe("portfolio is read-only", () => {
  it("leaves every store row untouched", () => {
    const snapshot = () =>
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .all()
        .map(({ name }) => `${name}: ${JSON.stringify(db.prepare(`SELECT * FROM "${name}"`).all())}`)
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
    assert.deepEqual(Object.keys(p.lead), ["state", "agent_id", "turn"]);
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

describe("portfolio busy is moving", () => {
  const skip = !hasTmux && "tmux is not installed";
  const needsHuman = (p) => todo(p, { tags: ["needs-human"] });
  const working = (p) => agent(p, { state: "working", target: livePane() });
  const blockedInProgress = (p) => {
    const a = todo(p, { status: "in_progress", updated: at("-1 hour") });
    block(a, todo(p));
  };

  it("keeps needs-human with a working worker in moving, with the count and item kept", { skip }, () => {
    const p = project();
    needsHuman(p);
    working(p);
    const r = row(p);
    assert.equal(r.lane, "moving");
    assert.equal(r.needs_human, 1);
    assert.equal(r.needs_human_items.length, 1);
    assert.ok(r.reasons.includes("needs_human"));
  });

  it("puts needs-human with nothing moving in waiting_on_you", () => {
    const p = project();
    needsHuman(p);
    assert.equal(row(p).lane, "waiting_on_you");
  });

  it("puts needs-human with a dead lead and open work in stuck", { skip }, () => {
    const p = project();
    needsHuman(p);
    agent(p, { kind: "lead", target: "%dead" });
    todo(p, { status: "in_progress", updated: at("-1 hour") });
    const r = row(p);
    assert.equal(r.lane, "stuck");
    assert.ok(r.reasons.includes("dead_lead_pane"));
  });

  it("keeps a blocked in-progress todo in moving while a worker is working, reason kept", { skip }, () => {
    const p = project();
    blockedInProgress(p);
    working(p);
    const r = row(p);
    assert.equal(r.lane, "moving");
    assert.ok(r.reasons.includes("in_progress_blocked"));
    assert.equal(r.todos.blocked_in_progress, 1);
  });

  it("puts a blocked in-progress todo with nothing moving in stuck", () => {
    const p = project();
    blockedInProgress(p);
    assert.equal(row(p).lane, "stuck");
  });

  it("keeps a stale in-progress todo in moving while a worker is working", { skip }, () => {
    const p = project();
    todo(p, { status: "in_progress", updated: OLD });
    working(p);
    const r = row(p);
    assert.equal(r.lane, "moving");
  });

  it("puts a dead lead with a working worker in stuck", { skip }, () => {
    const p = project();
    agent(p, { kind: "lead", target: "%dead" });
    todo(p, { status: "in_progress", updated: at("-1 hour") });
    working(p);
    assert.equal(row(p).lane, "stuck");
  });

  it("puts a worker at a prompt in stuck even with another worker working", { skip }, () => {
    const p = project();
    working(p);
    agent(p, { state: "waiting", target: livePane() });
    assert.equal(row(p).lane, "stuck");
  });

  it("puts a project whose only activity is a wake due in an hour in quiet", () => {
    const p = project();
    wake(p, { due: at("+1 hour") });
    const r = row(p);
    assert.equal(r.lane, "quiet");
    assert.deepEqual(r.wakes, { pending: 1, overdue: 0 });
  });

  for (const [name, reason] of [
    ["unsubmitted input", "the pane's input box has unsubmitted human text; delivering now would paste"],
    ["a dialog", "pane is awaiting a modal choice (folder-trust or /model picker)"],
    ["a conversation hold", "a human talked to this lead more recently than the conversation-hold window"],
    ["copy mode", "the pane is in copy mode"],
  ]) {
    it(`does not call an overdue wake held for ${name} stuck`, () => {
      const p = project();
      wake(p, { due: at("-10 minutes"), heldReason: reason });
      const r = row(p);
      assert.notEqual(r.lane, "stuck");
      assert.equal(r.wakes.overdue, 0);
    });
  }

  it("still calls an overdue wake with no hold stuck", () => {
    const p = project();
    wake(p, { due: at("-10 minutes") });
    assert.equal(row(p).lane, "stuck");
  });

  it("puts a working lead turn with nothing else in moving", { skip }, () => {
    const p = project();
    const id = agent(p, { kind: "lead", state: "idle", target: livePane() });
    const target = db.prepare("SELECT tmux_target FROM agents WHERE id = ?").get(id).tmux_target;
    const livePid = tmux("display-message", "-p", "-t", target, "#{pane_pid}");
    db.prepare("UPDATE agents SET pane_pid = ? WHERE id = ?").run(livePid, id);
    db.prepare(
      "INSERT INTO lead_turn_state (agent_id, pane_pid, session_id, state, idle_seq, last_event, changed_at) VALUES (?, ?, 's', 'working', 1, 'stop', ?)",
    ).run(id, livePid, OLD);
    assert.equal(row(p).lane, "moving");
  });
});
