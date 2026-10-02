import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";

import { assertScratchStore, clearHiveEnv, isolateTmux, McpClient, REPO, scratchDirs, tmuxCallsIn, until } from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("the wake row-ownership tests");
const dirs = scratchDirs();

clearHiveEnv();
process.env.HIVE_DATA_DIR = dirs.dataDir;
await assertScratchStore();

const { db, migrate } = await import("../dist/db.js");
const { tick } = await import("../dist/scheduler.js");
const { tmuxSocketPath } = await import("../dist/tmux.js");
migrate();

const OWN_SOCKET = tmuxSocketPath(process.env.TMUX, process.env.TMUX_TMPDIR);
const FOREIGN_SOCKET = "/nonexistent/foreign-socket-dir/tmux-0/default";
const skip = !hasTmux && "tmux is not installed";

const tmuxRun = (...args) => execFileSync("tmux", args, { encoding: "utf8" }).trim();
const screen = (pane) => tmuxRun("capture-pane", "-p", "-J", "-t", pane);
const sessions = [];
let seq = 0;

function pane() {
  const session = `wake-own-${process.pid}-${seq++}`;
  execFileSync("tmux", ["new-session", "-d", "-s", session, "cat"], { stdio: "ignore" });
  sessions.push(session);
  const id = tmuxRun("list-panes", "-t", `=${session}`, "-F", "#{pane_id}");
  return { id, pid: tmuxRun("display-message", "-p", "-t", id, "#{pane_pid}"), session };
}

const project = db
  .prepare("INSERT INTO projects (name, path) VALUES ('wake-row-ownership', ?) RETURNING id")
  .get(dirs.projectDir).id;

function row({ actor, target, pid, status = "running", socket = OWN_SOCKET, kind = "agent", state = "working", age = "-60 seconds" }) {
  return db
    .prepare(
      `INSERT INTO agents (project_id, actor_id, name, kind, tmux_target, tmux_socket, pane_pid, command, cwd, status,
         agent_state, state_changed_at, created_at, closed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'claude', '/tmp', ?, ?, datetime('now', '-30 seconds'), datetime('now', ?),
         CASE WHEN ? = 'closed' THEN datetime('now') END)
       RETURNING id`,
    )
    .get(project, actor, `${actor}-${seq++}`, kind, target, socket, pid, status, state, age, status).id;
}

function wake({ actor, pane: target, body, repeat = null, kind = "delay", watch = "[]", maxWait = null }) {
  return db
    .prepare(
      `INSERT INTO wakes (project_id, owner, body, kind, watch, deliver_actor, deliver_pane, due_at, repeat_every_ms,
         max_wait_at, created_at)
       VALUES (?, 'user:test', ?, ?, ?, ?, ?, CASE WHEN ? = 'delay' THEN datetime('now', '-1 seconds') END, ?,
         ${maxWait === null ? "NULL" : "datetime('now', ?)"}, datetime('now', '-60 seconds'))
       RETURNING id`,
    )
    .get(project, body, kind, watch, actor, target, kind, repeat, ...(maxWait === null ? [] : [maxWait])).id;
}

const wakeRow = (id) =>
  db.prepare("SELECT fired_at, typed_at, held_reason, cancelled_at, fire_count FROM wakes WHERE id = ?").get(id);

beforeEach(() => db.exec("DELETE FROM wakes; DELETE FROM agents;"));
after(() => cleanup(...sessions));

const UNKNOWN_HOLD = /^pane ownership for this wake's row cannot be verified/;

describe("a row-bound wake types only into a pane its row owns", () => {
  const kinds = {
    "one-shot delay": (actor, target, body) => wake({ actor, pane: target, body }),
    "repeating delay": (actor, target, body) => wake({ actor, pane: target, body, repeat: 600000 }),
    "timed-out idle": (actor, target, body) => wake({ actor, pane: target, body, kind: "idle_any", watch: "[]", maxWait: "-1 seconds" }),
  };

  for (const [kind, make] of Object.entries(kinds)) {
    it(`${kind}: an empty-pid row on a live pane holds by name before any claim or paste`, { skip }, async () => {
      const p = pane();
      row({ actor: "agent:own", target: p.id, pid: "" });
      const before = screen(p.id);
      const id = make("agent:own", p.id, `UNKNOWN-${kind}`);
      await tick();
      await tick();
      const w = wakeRow(id);
      assert.equal(w.fire_count, 0);
      assert.equal(w.typed_at, null);
      assert.equal(w.cancelled_at, null);
      assert.match(w.held_reason, UNKNOWN_HOLD);
      assert.match(w.held_reason, /wake_cancel/, "a worker hold names the remedy a running lead has");
      assert.equal(screen(p.id), before);
    });

    it(`${kind}: a matching-pid row delivers exactly once`, { skip }, async () => {
      const p = pane();
      row({ actor: "agent:own", target: p.id, pid: p.pid });
      const id = make("agent:own", p.id, `OWNED-${kind}`);
      await tick();
      assert.equal(wakeRow(id).fire_count, 1);
      await until(() => screen(p.id).includes(`OWNED-${kind}`), 3000);
      await tick();
      assert.equal(wakeRow(id).fire_count, 1, "delivered once, not replayed");
      assert.equal(wakeRow(id).held_reason, null);
    });
  }

  it("a lead row with no recorded pid holds with the hive lead remedy", { skip }, async () => {
    const p = pane();
    row({ actor: "lead:own", target: p.id, pid: "", kind: "lead" });
    const id = wake({ actor: "lead:own", pane: p.id, body: "LEAD-UNKNOWN" });
    await tick();
    assert.match(wakeRow(id).held_reason, /run `hive lead`/);
    assert.ok(!screen(p.id).includes("LEAD-UNKNOWN"));
  });

  it("a row whose recorded pane differs from the wake's pane never lends its pid to that pane", { skip }, async () => {
    const owned = pane();
    const other = pane();
    row({ actor: "agent:moved", target: owned.id, pid: owned.pid });
    const id = wake({ actor: "agent:moved", pane: other.id, body: "MOVED-ROW" });
    await tick();
    assert.match(wakeRow(id).held_reason, UNKNOWN_HOLD);
    assert.ok(!screen(other.id).includes("MOVED-ROW"));
  });

  it("a rowless user wake keeps its raw pane semantics and delivers", { skip }, async () => {
    const p = pane();
    const id = wake({ actor: "user:plain", pane: p.id, body: "RAW-USER" });
    await tick();
    assert.equal(wakeRow(id).fire_count, 1);
    await until(() => screen(p.id).includes("RAW-USER"), 3000);
  });

  it("an unknown hold survives its pane dying, re-held by name rather than silently cancelled", { skip }, async () => {
    const p = pane();
    row({ actor: "agent:dying", target: p.id, pid: "", age: "+0 seconds" });
    const id = wake({ actor: "agent:dying", pane: p.id, body: "DYING" });
    await tick();
    assert.match(wakeRow(id).held_reason, UNKNOWN_HOLD);
    cleanup(p.session);
    await tick();
    const w = wakeRow(id);
    assert.equal(w.cancelled_at, null);
    assert.match(w.held_reason, UNKNOWN_HOLD);
    assert.match(w.held_reason, /has since gone dead too/);
  });
});

describe("a wake whose actor's row is closed is cancelled with a named reason and never typed", () => {
  const closedSeeds = {
    "closed matching-pid": (p) => ({ pid: p.pid }),
    "closed empty-pid": () => ({ pid: "" }),
    "closed foreign-socket": (p) => ({ pid: p.pid, socket: FOREIGN_SOCKET }),
  };
  for (const [seed, fields] of Object.entries(closedSeeds)) {
    it(`${seed} row`, { skip }, async () => {
      const p = pane();
      row({ actor: "agent:closed", target: p.id, status: "closed", ...fields(p) });
      const before = screen(p.id);
      const id = wake({ actor: "agent:closed", pane: p.id, body: "CLOSED-ACTOR" });
      await tick();
      const w = wakeRow(id);
      assert.equal(w.fire_count, 0);
      assert.equal(w.typed_at, null);
      assert.notEqual(w.cancelled_at, null);
      assert.match(w.held_reason, /^delivery actor closed/);
      assert.equal(screen(p.id), before);
    });
  }

  it("a row retired with agent_close row_only leaves its wake unable to type into the still-live pane", { skip }, async () => {
    const p = pane();
    const id = row({ actor: "agent:rowonly", target: p.id, pid: "" });
    const mcp = new McpClient({ cwd: dirs.projectDir, dataDir: dirs.dataDir });
    await mcp.start();
    try {
      await mcp.call("agent_close", { agent_id: id, row_only: true });
    } finally {
      await mcp.close();
    }
    const w = wake({ actor: "agent:rowonly", pane: p.id, body: "ROW-ONLY-RETIRED" });
    await tick();
    assert.match(wakeRow(w).held_reason, /^delivery actor closed/);
    assert.ok(!screen(p.id).includes("ROW-ONLY-RETIRED"));
  });

  it("a closed lead row holds its wake for hive lead to re-point instead of cancelling it", { skip }, async () => {
    const p = pane();
    row({ actor: "lead:closed", target: p.id, pid: p.pid, status: "closed", kind: "lead" });
    const id = wake({ actor: "lead:closed", pane: p.id, body: "CLOSED-LEAD" });
    await tick();
    const w = wakeRow(id);
    assert.equal(w.cancelled_at, null);
    assert.match(w.held_reason, /lead's row is closed[\s\S]*hive lead/);
    assert.ok(!screen(p.id).includes("CLOSED-LEAD"));
  });

  it("an older closed row never certifies a newer running row's empty pid on the same actor", { skip }, async () => {
    const p = pane();
    row({ actor: "agent:twice", target: p.id, pid: p.pid, status: "closed" });
    row({ actor: "agent:twice", target: p.id, pid: "" });
    const id = wake({ actor: "agent:twice", pane: p.id, body: "TWICE" });
    await tick();
    assert.match(wakeRow(id).held_reason, UNKNOWN_HOLD);
    assert.ok(!screen(p.id).includes("TWICE"));
  });

  it("control: the newer running row with a matching pid delivers despite an older closed row", { skip }, async () => {
    const p = pane();
    row({ actor: "agent:twice", target: p.id, pid: "", status: "closed" });
    row({ actor: "agent:twice", target: p.id, pid: p.pid });
    const id = wake({ actor: "agent:twice", pane: p.id, body: "NEWER-LIVE" });
    await tick();
    await until(() => screen(p.id).includes("NEWER-LIVE"), 3000);
    assert.equal(wakeRow(id).fire_count, 1);
  });
});

describe("ownership lost after the claim withholds the Enter and records why", () => {
  it("a wake whose row changes between paste and Enter is cancelled by name, typed_at kept, no Enter sent", { skip }, async () => {
    const p = pane();
    const rowId = row({ actor: "agent:mid", target: p.id, pid: p.pid });
    const id = wake({ actor: "agent:mid", pane: p.id, body: "MID-DELIVERY" });
    const shimDir = mkdtempSync(join(tmpdir(), "hive-wake-repid-"));
    const log = join(shimDir, "calls.log");
    writeFileSync(log, "");
    const repid = join(shimDir, "repid.mjs");
    writeFileSync(
      repid,
      `import Database from ${JSON.stringify(join(REPO, "node_modules", "better-sqlite3", "lib", "index.js"))};\n` +
        `new Database(${JSON.stringify(db.name)}).prepare("UPDATE agents SET pane_pid = '1' WHERE id = ?").run(${rowId});\n`,
    );
    const realTmux = execFileSync("which", ["tmux"], { encoding: "utf8" }).trim();
    writeFileSync(
      join(shimDir, "tmux"),
      `#!/bin/sh\n{ printf '%s\\037' "$@"; printf '\\n'; } >> ${JSON.stringify(log)}\n` +
        `if [ "$1" = "paste-buffer" ]; then ${realTmux} "$@" || exit $?; exec ${JSON.stringify(process.execPath)} ${JSON.stringify(repid)}; fi\n` +
        `exec ${realTmux} "$@"\n`,
      { mode: 0o755 },
    );
    const savedPath = process.env.PATH;
    process.env.PATH = `${shimDir}:${savedPath}`;
    try {
      await tick();
    } finally {
      process.env.PATH = savedPath;
    }
    const w = wakeRow(id);
    assert.equal(w.fire_count, 1, "claimed once");
    assert.notEqual(w.typed_at, null, "the paste happened, so typed_at is kept");
    assert.notEqual(w.cancelled_at, null, "a one-shot whose delivery stopped is not re-armed");
    assert.match(w.held_reason, /^delivery stopped after claim: [\s\S]*no Enter was sent/);
    const calls = tmuxCallsIn(log);
    assert.equal(calls.filter((a) => a[0] === "paste-buffer").length, 1);
    assert.deepEqual(calls.filter((a) => a[0] === "send-keys" && a.includes("Enter")), []);
  });
});

describe("wake_when_idle mode=all never treats an empty-pid worker as idle", () => {
  it("does not return already_satisfied and does not fire, until a real pid is recorded", { skip }, async () => {
    const p = pane();
    const lead = pane();
    row({ actor: "lead:watcher", target: lead.id, pid: lead.pid, kind: "lead" });
    const id = row({ actor: "agent:quiet", target: p.id, pid: "", state: "idle" });
    const mcp = new McpClient({
      cwd: dirs.projectDir,
      dataDir: dirs.dataDir,
      env: { HIVE_AGENT_ID: "lead:watcher", TMUX_PANE: lead.id },
    });
    await mcp.start();
    let receipt;
    try {
      receipt = await mcp.call("wake_when_idle", { agents: [id], mode: "all", body: "ALL-IDLE" });
    } finally {
      await mcp.close();
    }
    assert.notEqual(receipt.status, "already_satisfied");
    await tick();
    assert.equal(wakeRow(receipt.wake_id).fire_count, 0, "an unknown worker is not idle");
    db.prepare("UPDATE agents SET pane_pid = ?, state_changed_at = datetime('now') WHERE id = ?").run(p.pid, id);
    await tick();
    assert.equal(wakeRow(receipt.wake_id).fire_count, 1, "a verified idle worker satisfies mode=all as before");
  });
});

describe("wake creation refuses a delivery target whose pane ownership is unknown", () => {
  it("wake_set with deliver_to an empty-pid worker refuses by naming unknown ownership", { skip }, async () => {
    const p = pane();
    const id = row({ actor: "agent:target", target: p.id, pid: "" });
    const mcp = new McpClient({ cwd: dirs.projectDir, dataDir: dirs.dataDir });
    await mcp.start();
    try {
      await assert.rejects(mcp.call("wake_set", { delay_seconds: 60, body: "x", deliver_to: id }), /ownership reads unknown/);
    } finally {
      await mcp.close();
    }
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM wakes").get().n, 0);
  });

  it("a session whose own row is unknown is refused rather than bound to its ambient TMUX_PANE", { skip }, async () => {
    const p = pane();
    row({ actor: "agent:self", target: p.id, pid: "" });
    const mcp = new McpClient({ cwd: dirs.projectDir, dataDir: dirs.dataDir, env: { HIVE_AGENT_ID: "agent:self", TMUX_PANE: p.id } });
    await mcp.start();
    try {
      await assert.rejects(mcp.call("wake_set", { delay_seconds: 60, body: "x" }), /ownership reads unknown/);
    } finally {
      await mcp.close();
    }
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM wakes").get().n, 0);
  });
});
