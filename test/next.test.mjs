import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { after, describe, it } from "node:test";

import { clearHiveEnv, isolateTmux, leadRow, makeFakeClaude, runCli, scratchDirs, tmux, tmuxSocketUnder } from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("hive next");
clearHiveEnv();
const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { db, migrate } = await import("../dist/db.js");
const { sessionName } = await import("../dist/tmux.js");
migrate();

const session = sessionName();
const claudePath = makeFakeClaude(dirs.tmp)("sleep 600");
const opts = (extra = {}) => ({
  cwd: dirs.projectDir,
  dataDir: dirs.dataDir,
  tmp: dirs.tmp,
  env: { PATH: `${dirname(claudePath)}:${process.env.PATH}`, ...extra },
});

after(() => cleanup(session));

const OLD = "2026-01-02 00:00:00";
let seq = 0;

function project(name, { atRoot } = {}) {
  const root = atRoot ?? join(dirs.tmp, `${name.replace(/[^a-z0-9]/gi, "_")}-${++seq}`);
  mkdirSync(root, { recursive: true });
  const path = realpathSync(root);
  const id = db.prepare("INSERT INTO projects (name, path, created_at) VALUES (?, ?, ?) RETURNING id").get(name, path, OLD).id;
  return { id, path };
}

function todo(p, { status = "open", tags = [], updated = OLD } = {}) {
  return db
    .prepare("INSERT INTO todos (project_id, title, status, tags, updated_at) VALUES (?, 't', ?, ?, ?) RETURNING id")
    .get(p.id, status, JSON.stringify(tags), updated).id;
}

const needsHuman = (p, n = 1, updated = OLD) => {
  for (let i = 0; i < n; i++) todo(p, { tags: ["needs-human"], updated });
};

function blockedInProgress(p, n = 1) {
  for (let i = 0; i < n; i++) {
    const t = todo(p, { status: "in_progress" });
    const blocker = todo(p);
    db.prepare("INSERT INTO todo_blockers (todo_id, blocker_id) VALUES (?, ?)").run(t, blocker);
  }
}

function overdueWakes(p, n) {
  for (let i = 0; i < n; i++) {
    db.prepare(
      `INSERT INTO wakes (project_id, owner, body, kind, deliver_actor, deliver_pane, due_at)
       VALUES (?, 'lead:1', 'b', 'delay', 'lead:1', '%x', '2020-01-01 00:00:00')`,
    ).run(p.id);
  }
}

function leadAgent(p, { target = "%not-a-real-pane", socket = "" } = {}) {
  db.prepare(
    `INSERT INTO agents (project_id, actor_id, name, tmux_target, tmux_socket, command, cwd, kind, status)
     VALUES (?, ?, 'lead', ?, ?, 'claude', ?, 'lead', 'running')`,
  ).run(p.id, `lead:${++seq}`, target, socket, p.path);
}

function resetStore() {
  for (const t of ["todo_blockers", "todos", "wakes", "agents", "command_trust", "kv", "projects"]) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
}

const print = async (extra) => runCli(["next", "--print"], opts(extra));
const picked = (stdout) => JSON.parse(stdout.trim().split("\n")[0]);

function storeFingerprint() {
  return JSON.stringify(
    ["projects", "agents", "todos", "wakes", "kv", "command_trust"].map((t) =>
      db.prepare(`SELECT * FROM ${t} ORDER BY 1`).all(),
    ),
  );
}

describe("hive next --print: selection", () => {
  it("prefers waiting_on_you over stuck, and ranks by needs_human, then oldest activity, then id", async () => {
    resetStore();
    const stuck = project("stuck-heavy");
    blockedInProgress(stuck, 5);
    const few = project("few-asks");
    needsHuman(few, 1);
    const many = project("many-asks");
    needsHuman(many, 3);
    const manyTwin = project("many-asks-twin");
    needsHuman(manyTwin, 3);

    let r = await print();
    assert.equal(r.code, 0, r.stderr);
    assert.equal(picked(r.stdout).project_id, many.id);
    assert.equal(picked(r.stdout).lane, "waiting_on_you");

    db.prepare("UPDATE todos SET updated_at = '2025-01-01 00:00:00' WHERE project_id = ?").run(manyTwin.id);
    db.prepare("UPDATE projects SET created_at = '2025-01-01 00:00:00' WHERE id IN (?, ?)").run(many.id, manyTwin.id);
    r = await print();
    assert.equal(picked(r.stdout).project_id, manyTwin.id, "older last activity wins the needs_human tie");

    db.prepare("UPDATE todos SET updated_at = '2025-01-01 00:00:00' WHERE project_id = ?").run(many.id);
    r = await print();
    assert.equal(picked(r.stdout).project_id, many.id, "lower id wins a full tie");
  });

  it("ranks stuck by blocked_in_progress, then overdue wakes, then oldest activity", async () => {
    resetStore();
    const a = project("stuck-a");
    blockedInProgress(a, 1);
    overdueWakes(a, 4);
    const b = project("stuck-b");
    blockedInProgress(b, 2);

    let r = await print();
    assert.equal(picked(r.stdout).project_id, b.id);
    assert.equal(picked(r.stdout).lane, "stuck");

    blockedInProgress(a, 1);
    r = await print();
    assert.equal(picked(r.stdout).project_id, a.id, "equal blocked count falls to overdue wakes");
  });

  it("emits one JSON line with the fixed key order, reasons unchanged, and escaped name", async () => {
    resetStore();
    const p = project('odd "name" \\ é');
    needsHuman(p, 1);
    blockedInProgress(p, 1);

    const r = await print();
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout.endsWith("\n"), true);
    assert.equal(r.stdout.trim().split("\n").length, 1);
    const obj = JSON.parse(r.stdout);
    assert.deepEqual(Object.keys(obj), ["project_id", "name", "root", "lane", "reasons", "lead_state"]);
    assert.equal(obj.name, 'odd "name" \\ é');
    assert.equal(obj.root, p.path);
    assert.deepEqual(obj.reasons, ["needs_human", "in_progress_blocked", "stale_in_progress_48h", "todo_in_progress"]);
    assert.equal(obj.lead_state, "none");
  });

  it("never picks the queen project, even when it is the highest", async () => {
    resetStore();
    const queen = project("queen", { atRoot: join(dirs.dataDir, "queen") });
    needsHuman(queen, 9);
    const other = project("ordinary");
    needsHuman(other, 1);

    const r = await print();
    assert.equal(picked(r.stdout).project_id, other.id);
  });

  it("says so and exits 0 when the queen is the only candidate or nothing needs you", async () => {
    resetStore();
    const queen = project("queen", { atRoot: join(dirs.dataDir, "queen") });
    needsHuman(queen, 2);
    project("idle");

    for (const args of [["next", "--print"], ["next"]]) {
      const r = await runCli(args, opts());
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.stdout, "No project is waiting on you or stuck.\n");
    }
  });

  it("leaves every store table unchanged and creates no tmux server", async () => {
    resetStore();
    const p = project("untouched");
    needsHuman(p, 1);
    const before = storeFingerprint();

    const r = await print();
    assert.equal(r.code, 0, r.stderr);
    assert.equal(storeFingerprint(), before);
    assert.equal(leadRow(db, p.id), undefined);
    assert.equal(existsSync(tmuxSocketUnder(process.env.TMUX_TMPDIR)), false, "--print must not start tmux");
  });

  it("rejects an unknown flag and a positional argument, naming --print", async () => {
    for (const args of [["next", "--nope"], ["next", "somewhere"]]) {
      const r = await runCli(args, opts());
      assert.equal(r.code, 1);
      assert.match(r.stderr, /--print/);
    }
  });

  it("refuses a caller pinned to a worker project before ranking", async () => {
    resetStore();
    const pinned = project("pinned");
    const target = project("wants-you");
    needsHuman(target, 1);
    db.prepare(
      `INSERT INTO agents (project_id, actor_id, name, tmux_target, command, cwd, kind, status)
       VALUES (?, 'agent:pinned', 'worker', '%caller', 'claude', ?, 'agent', 'running')`,
    ).run(pinned.id, pinned.path);

    for (const args of [["next", "--print"], ["next"]]) {
      const r = await runCli(args, opts({ HIVE_AGENT_ID: "agent:pinned", HIVE_PROJECT_LOCK: "1" }));
      assert.equal(r.code, 1);
      assert.equal(r.stdout, "");
      assert.match(r.stderr, /HIVE_PROJECT_LOCK=1/);
    }
  });
});

describe("hive next: start or attach", () => {
  const tmuxIt = (name, fn) => it(name, { skip: hasTmux ? false : "tmux is not installed" }, fn);
  tmuxIt("starts a missing lead, then attaches to the same project --print named", async () => {
    resetStore();
    const p = project("no-lead");
    needsHuman(p, 1);
    const named = picked((await print()).stdout);

    const r = await runCli(["next"], opts());
    assert.equal(r.code, 0, r.stderr);
    assert.equal(picked(r.stdout).project_id, named.project_id);
    const row = leadRow(db, p.id);
    assert.ok(row, `${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /LEAD_PANE=%\d+/);
    assert.equal(tmux("list-panes", "-a", "-F", "#{pane_id}").split("\n").includes(row.tmux_target), true);
  });

  tmuxIt("restarts a dead lead pane", async () => {
    resetStore();
    const p = project("dead-lead");
    needsHuman(p, 1);
    const first = await runCli(["lead", p.path, "--detach"], opts());
    assert.equal(first.code, 0, first.stderr);
    const dead = leadRow(db, p.id).tmux_target;
    execFileSync("tmux", ["kill-pane", "-t", dead], { stdio: "ignore" });
    assert.equal(picked((await print()).stdout).lead_state, "dead_pane");

    const r = await runCli(["next"], opts());
    assert.equal(r.code, 0, r.stderr);
    const now = leadRow(db, p.id).tmux_target;
    assert.notEqual(now, dead);
    assert.equal(tmux("list-panes", "-a", "-F", "#{pane_id}").split("\n").includes(now), true);
  });

  tmuxIt("attaches to a live lead without starting another", async () => {
    resetStore();
    const p = project("live-lead");
    needsHuman(p, 1);
    const first = await runCli(["lead", p.path, "--detach"], opts());
    assert.equal(first.code, 0, first.stderr);
    const pane = leadRow(db, p.id).tmux_target;
    assert.equal(picked((await print()).stdout).lead_state, "alive");

    const r = await runCli(["next"], opts());
    assert.equal(r.code, 0, r.stderr);
    assert.equal(leadRow(db, p.id).tmux_target, pane);
    assert.doesNotMatch(r.stdout, /LEAD_PANE=/);
  });

  tmuxIt("refuses an untrusted lead without a TTY and never attaches", async () => {
    resetStore();
    const p = project("untrusted");
    needsHuman(p, 1);
    writeFileSync(join(p.path, "hive.yml"), "lead: 'sleep 600'\n");

    const r = await runCli(["next"], opts());
    assert.equal(r.code, 1);
    assert.match(r.stderr, /"lead" is not trusted; run hive lead <path> interactively once/);
    assert.equal(leadRow(db, p.id), undefined);
    assert.doesNotMatch(r.stdout, /LEAD_PANE=/);
  });

  tmuxIt("starts nothing when the lead's liveness is unknown", async () => {
    resetStore();
    const p = project("unknown-probe");
    needsHuman(p, 1);
    leadAgent(p, { target: "%9", socket: "/nonexistent/foreign.sock" });
    assert.equal(picked((await print()).stdout).lead_state, "unknown");
    const before = storeFingerprint();

    const r = await runCli(["next"], opts());
    assert.equal(r.code, 1);
    assert.match(r.stderr, /cannot tell whether the lead/);
    assert.equal(storeFingerprint(), before);
  });

  tmuxIt("fails on a missing root without trying a runner-up", async () => {
    resetStore();
    const gone = project("gone");
    needsHuman(gone, 3);
    const runnerUp = project("runner-up");
    needsHuman(runnerUp, 1);
    rmSync(gone.path, { recursive: true });

    const r = await runCli(["next"], opts());
    assert.equal(r.code, 1);
    assert.equal(picked(r.stdout).project_id, gone.id);
    assert.match(r.stderr, /root is missing/);
    assert.equal(leadRow(db, runnerUp.id), undefined);
  });
});
