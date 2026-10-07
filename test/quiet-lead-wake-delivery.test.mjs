import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";

import {
  DIST,
  assertScratchStore,
  clearHiveEnv,
  insertStateLogRow,
  isolateTmux,
  raceProcesses,
  runNode,
  scratchDirs,
  sleep,
  until,
} from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("the quiet lead wake delivery tests");
const { dataDir, tmp } = scratchDirs();
clearHiveEnv();
delete process.env.CLAUDE_CODE_MESSAGING_SOCKET;
process.env.HIVE_DATA_DIR = dataDir;
await assertScratchStore();

const { db, migrate } = await import("../dist/db.js");
const { tick } = await import("../dist/scheduler.js");
const { postClaudeWake, senderAddress } = await import("../dist/claudeWake.js");
const { tmuxSocketPath } = await import("../dist/tmux.js");
migrate();

const HOOK = join(DIST, "hook.js");
const ownSocket = tmuxSocketPath(process.env.TMUX, process.env.TMUX_TMPDIR);
const socketDir = mkdtempSync(join(tmpdir(), "qlw-"));
const needsTmux = { skip: hasTmux ? false : "tmux is not installed" };
const sessions = [];
const servers = [];
after(() => {
  for (const server of servers) server.close();
  rmSync(socketDir, { recursive: true, force: true });
  cleanup(...sessions);
});

function project(on) {
  const dir = mkdtempSync(join(tmp, "qlw-project-"));
  writeFileSync(join(dir, "hive.yml"), on ? "quiet_messaging: true\n" : "dashboard: false\n");
  return db.prepare("INSERT INTO projects (name, path) VALUES ('qlw', ?) RETURNING id").get(dir).id;
}

function listener() {
  const path = join(socketDir, `l${servers.length}.sock`);
  const received = [];
  const server = createServer((conn) => {
    let buf = "";
    conn.on("data", (c) => (buf += c));
    conn.on("end", () => received.push(buf));
  });
  server.listen(path);
  servers.push(server);
  return { path, received };
}

let paneCount = 0;
function sinkPane() {
  const session = `qlw-${process.pid}-${paneCount++}`;
  const sink = join(tmp, `${session}.sink`);
  writeFileSync(sink, "");
  execFileSync("tmux", ["new-session", "-d", "-s", session, "-x", "200", "-y", "50", `cat > '${sink}'`], { stdio: "ignore" });
  sessions.push(session);
  const [pane, pid] = execFileSync("tmux", ["list-panes", "-t", `=${session}`, "-F", "#{pane_id}\t#{pane_pid}"], { encoding: "utf8" })
    .trim()
    .split("\t");
  return { pane, pid, sink };
}

let actorCount = 0;
function lead(projectId, { socket = "", registeredPid, kind = "lead", command = "claude" } = {}) {
  const { pane, pid, sink } = sinkPane();
  const actorId = `${kind}:qlw${actorCount++}`;
  const rowId = db
    .prepare(
      `INSERT INTO agents (project_id, actor_id, name, kind, tmux_target, tmux_socket, pane_pid, command, cwd, status,
         claude_messaging_socket, claude_messaging_pane_pid, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, '/tmp', 'running', ?, ?, datetime('now', '-60 seconds')) RETURNING id`,
    )
    .get(projectId, actorId, `qlw${actorCount}`, kind, pane, ownSocket, pid, command, socket, registeredPid ?? (socket ? pid : "")).id;
  return { actorId, rowId, pane, pid, sink };
}

function dueWake(projectId, target, body, { repeatMs = null } = {}) {
  return db
    .prepare(
      `INSERT INTO wakes (project_id, owner, body, kind, watch, deliver_actor, deliver_pane, due_at, created_at, repeat_every_ms)
       VALUES (?, ?, ?, 'delay', '[]', ?, ?, datetime('now', '-1 seconds'), datetime('now', '-60 seconds'), ?)
       RETURNING id`,
    )
    .get(projectId, target.actorId, body, target.actorId, target.pane, repeatMs).id;
}

const wake = (id) => db.prepare("SELECT * FROM wakes WHERE id = ?").get(id);
const sinkText = (target) => readFileSync(target.sink, "utf8");
const backdateAttempt = (id, seconds) =>
  db.prepare("UPDATE wakes SET socket_attempt_at = strftime('%Y-%m-%d %H:%M:%f', 'now', ?) WHERE id = ?").run(`-${seconds} seconds`, id);

async function promptHook(target, prompt) {
  const { code } = await runNode(HOOK, ["prompt"], {
    dataDir,
    env: { HIVE_AGENT_ID: target.actorId, HIVE_LEAD: "1" },
    stdin: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "s1", prompt }),
  });
  assert.equal(code, 0);
}

const BODY = "first line of the wake\nsecond line\n  third, indented";

beforeEach(() => db.exec("DELETE FROM wakes; DELETE FROM agent_state_log; DELETE FROM lead_turn_state; DELETE FROM leases;"));

describe("a one-shot wake to an opted-in Claude lead goes by socket", () => {
  it("posts one named-sender JSON line carrying the whole body, types nothing, and records socket without typed_at", needsTmux, async () => {
    const sock = listener();
    const target = lead(project(true), { socket: sock.path });
    const id = dueWake(db.prepare("SELECT project_id FROM agents WHERE id = ?").get(target.rowId).project_id, target, BODY);

    await tick();
    await until(() => sock.received.length === 1, 3000);

    const sender = senderAddress(join(dataDir, "wake-sender.sock"));
    const expectedText = `[hive wake #${id}] ${BODY}\n\nAutomated hive wake. Do not reply to this sender.`;
    assert.equal(
      sock.received[0],
      JSON.stringify({
        type: "user",
        from: sender,
        message: { role: "user", content: `<cross-session-message from="${sender}" from-name="hive">\n${expectedText}\n</cross-session-message>` },
      }) + "\n",
    );
    const row = wake(id);
    assert.equal(row.delivery_method, "socket");
    assert.ok(row.socket_attempt_at);
    assert.equal(row.typed_at, null);
    assert.equal(row.confirmed_at, null);
    assert.equal(row.fire_count, 1);
    await sleep(300);
    assert.equal(sinkText(target), "");
  });

  it("is confirmed by the real prompt hook seeing the envelope, and a confirmed wake is never re-typed", needsTmux, async () => {
    const sock = listener();
    const pid = project(true);
    const target = lead(pid, { socket: sock.path });
    const id = dueWake(pid, target, BODY);
    await tick();
    await until(() => sock.received.length === 1, 3000);

    await promptHook(target, JSON.parse(sock.received[0]).message.content);
    await tick();
    assert.ok(wake(id).confirmed_at, "the substring [hive wake #N] inside the envelope confirms it");

    backdateAttempt(id, 600);
    await tick();
    await sleep(300);
    assert.equal(sinkText(target), "");
    assert.equal(wake(id).delivery_method, "socket");
  });
});

describe("an unconfirmed socket wake falls back to PTY once, measured from the lead's turn end", () => {
  it("an idle lead with no confirmation 60 s after the post gets one marked re-delivery of the same firing", needsTmux, async () => {
    const sock = listener();
    const pid = project(true);
    const target = lead(pid, { socket: sock.path });
    const id = dueWake(pid, target, BODY);
    await tick();
    await until(() => sock.received.length === 1, 3000);

    backdateAttempt(id, 50);
    await tick();
    assert.equal(wake(id).typed_at, null, "not yet past the 60 s bound");

    backdateAttempt(id, 61);
    await tick();
    await until(() => sinkText(target).includes("third, indented"), 3000);
    assert.equal(
      sinkText(target),
      `[hive wake #${id}, re-delivered] If you already handled wake #${id}, ignore this.\n${BODY}\n`,
    );
    const row = wake(id);
    assert.equal(row.delivery_method, "pty-after-socket-timeout");
    assert.ok(row.typed_at);
    assert.equal(row.fire_count, 1);
    assert.equal(row.body, BODY);

    await tick();
    await sleep(300);
    assert.equal(sinkText(target).split("re-delivered").length, 2, "exactly one fallback");

    await promptHook(target, JSON.parse(sock.received[0]).message.content);
    await tick();
    assert.ok(wake(id).confirmed_at, "a late socket prompt after the fallback still confirms the wake");
    assert.equal(wake(id).delivery_method, "pty-after-socket-timeout");
  });

  it("a busy lead is not re-typed until 60 s after its first turn end following the post", needsTmux, async () => {
    const sock = listener();
    const pid = project(true);
    const target = lead(pid, { socket: sock.path });
    db.prepare("INSERT INTO lead_turn_state (agent_id, pane_pid, session_id, state) VALUES (?, ?, 's1', 'working')").run(target.rowId, target.pid);
    const id = dueWake(pid, target, BODY);
    await tick();
    await until(() => sock.received.length === 1, 3000);

    backdateAttempt(id, 600);
    await tick();
    assert.equal(wake(id).typed_at, null, "ten minutes busy with no turn end is not a timeout");

    insertStateLogRow(db, target.actorId, "stop", "idle", 30);
    await tick();
    assert.equal(wake(id).typed_at, null, "30 s after the turn end is inside the bound");

    db.exec("DELETE FROM agent_state_log");
    insertStateLogRow(db, target.actorId, "stop", "idle", 61);
    await tick();
    await until(() => wake(id).typed_at !== null, 3000);
    assert.equal(wake(id).delivery_method, "pty-after-socket-timeout");
  });

  it("a stop before the post does not start the clock", needsTmux, async () => {
    const sock = listener();
    const pid = project(true);
    const target = lead(pid, { socket: sock.path });
    db.prepare("INSERT INTO lead_turn_state (agent_id, pane_pid, session_id, state) VALUES (?, ?, 's1', 'working')").run(target.rowId, target.pid);
    insertStateLogRow(db, target.actorId, "stop", "idle", 900);
    const id = dueWake(pid, target, BODY);
    await tick();
    await until(() => sock.received.length === 1, 3000);
    backdateAttempt(id, 600);
    await tick();
    assert.equal(wake(id).typed_at, null);
  });

  it("a socket that refuses the connection falls straight back to a marked PTY delivery", needsTmux, async () => {
    const pid = project(true);
    const target = lead(pid, { socket: join(socketDir, "nobody-listens.sock") });
    const id = dueWake(pid, target, BODY);
    await tick();
    await until(() => sinkText(target).includes("third, indented"), 3000);
    assert.match(sinkText(target), new RegExp(`^\\[hive wake #${id}, re-delivered\\] If you already handled wake #${id}, ignore this\\.\\n`));
    const row = wake(id);
    assert.equal(row.delivery_method, "pty-after-socket-timeout");
    assert.ok(row.socket_attempt_at);
    assert.equal(row.fire_count, 1);
  });

  it("a lead row closed after the post holds the fallback instead of typing", needsTmux, async () => {
    const sock = listener();
    const pid = project(true);
    const target = lead(pid, { socket: sock.path });
    const id = dueWake(pid, target, BODY);
    await tick();
    await until(() => sock.received.length === 1, 3000);
    db.prepare("UPDATE agents SET status = 'closed' WHERE id = ?").run(target.rowId);
    backdateAttempt(id, 61);
    await tick();
    await sleep(300);
    const row = wake(id);
    assert.equal(row.typed_at, null);
    assert.equal(row.delivery_method, "socket");
    assert.ok(row.held_reason, "the hold is readable on the row");
    assert.equal(sinkText(target), "");
  });

  async function postedAndDue(pid, target, sock) {
    const id = dueWake(pid, target, BODY);
    await tick();
    await until(() => sock.received.length === 1, 3000);
    backdateAttempt(id, 61);
    return id;
  }

  it("a prompt that lands after the tick's confirmation pass but before the fallback claim stops the paste", needsTmux, async () => {
    const sock = listener();
    const pid = project(true);
    const target = lead(pid, { socket: sock.path });
    const id = await postedAndDue(pid, target, sock);
    const other = lead(project(false));
    dueWake(db.prepare("SELECT project_id FROM agents WHERE id = ?").get(other.rowId).project_id, other, "an earlier typed wake that holds the tick for ~800 ms");
    const prompt = JSON.parse(sock.received[0]).message.content;
    setTimeout(() => insertStateLogRow(db, target.actorId, "prompt", "working", 0, JSON.stringify({ prompt })), 150);

    await tick();
    await until(() => sinkText(other).includes("holds the tick"), 3000);
    await sleep(300);
    assert.equal(wake(id).confirmed_at, null, "the prompt arrived after this tick's confirmation pass");
    assert.equal(sinkText(target), "", "the claim saw the prompt and typed nothing");
    assert.equal(wake(id).delivery_method, "socket");
  });

  it("a cancelled socket wake gets no fallback", needsTmux, async () => {
    const sock = listener();
    const pid = project(true);
    const target = lead(pid, { socket: sock.path });
    const id = await postedAndDue(pid, target, sock);
    db.prepare("UPDATE wakes SET cancelled_at = datetime('now') WHERE id = ?").run(id);
    await tick();
    await sleep(500);
    assert.equal(sinkText(target), "");
    assert.equal(wake(id).typed_at, null);
  });

  it("a fallback held for a live conversation types exactly once after the hold lifts", needsTmux, async () => {
    const sock = listener();
    const pid = project(true);
    const target = lead(pid, { socket: sock.path });
    const id = await postedAndDue(pid, target, sock);
    insertStateLogRow(db, target.actorId, "prompt", "working", 5, JSON.stringify({ prompt: "a human is talking to the lead" }));
    await tick();
    await sleep(300);
    assert.match(wake(id).held_reason ?? "", /a human talked to this lead/);
    assert.equal(sinkText(target), "");
    assert.equal(wake(id).delivery_method, "socket");

    db.prepare("DELETE FROM agent_state_log WHERE actor_id = ? AND payload LIKE '%a human is talking%'").run(target.actorId);
    await tick();
    await until(() => sinkText(target).includes("third, indented"), 3000);
    await tick();
    await sleep(300);
    assert.equal(sinkText(target).split("re-delivered").length, 2, sinkText(target));
    assert.equal(wake(id).delivery_method, "pty-after-socket-timeout");
    assert.equal(wake(id).held_reason, null);
  });

  it("two scheduler processes racing one due fallback type it once", needsTmux, async () => {
    const sock = listener();
    const pid = project(true);
    const target = lead(pid, { socket: sock.path });
    const id = dueWake(pid, target, BODY);
    await tick();
    await until(() => sock.received.length === 1, 3000);
    backdateAttempt(id, 61);

    await raceProcesses(
      `const { tick } = await import(${JSON.stringify(join(DIST, "scheduler.js"))});\nawait tick();\nprocess.stdout.write("{}");\n`,
      [[], []],
      { env: { HIVE_DATA_DIR: dataDir } },
    );
    await until(() => sinkText(target).includes("third, indented"), 3000);
    await sleep(500);
    assert.equal(sinkText(target).split("re-delivered").length, 2, sinkText(target));
  });
});

describe("a standing watch's finish notice delivered by socket", () => {
  function idleWorkerAndWatch(pid, target) {
    const worker = sinkPane();
    db.prepare(
      `INSERT INTO agents (project_id, actor_id, name, kind, tmux_target, tmux_socket, pane_pid, command, cwd, status,
         agent_state, state_changed_at, created_at)
       VALUES (?, ?, ?, 'agent', ?, ?, ?, 'claude', '/tmp', 'running', 'idle', datetime('now', '-30 seconds'), datetime('now', '-300 seconds'))`,
    ).run(pid, `agent:qlw-w${actorCount}`, `qlw-w${actorCount++}`, worker.pane, ownSocket, worker.pid);
    return db
      .prepare(
        `INSERT INTO wakes (project_id, owner, body, kind, watch, watch_scope, deliver_actor, deliver_pane, max_wait_at, created_at)
         VALUES (?, ?, 'crew update', 'idle_any', '[]', 'project', ?, ?, datetime('now', '+4 hours'), datetime('now', '-60 seconds'))
         RETURNING id`,
      )
      .get(pid, target.actorId, target.actorId, target.pane).id;
  }
  const notices = (watch) => db.prepare("SELECT * FROM wakes WHERE parent_wake_id = ? ORDER BY id").all(watch);
  const agePastRetry = (id) =>
    db.prepare(
      "UPDATE wakes SET fired_at = datetime('now', '-90 seconds'), socket_attempt_at = strftime('%Y-%m-%d %H:%M:%f', 'now', '-90 seconds') WHERE id = ?",
    ).run(id);

  for (const confirmed of [true, false]) {
    it(`is reported once and posted once across the 60 s re-arm boundary (${confirmed ? "confirmed" : "unconfirmed"})`, needsTmux, async () => {
      const sock = listener();
      const pid = project(true);
      const target = lead(pid, { socket: sock.path });
      const watch = idleWorkerAndWatch(pid, target);

      for (let i = 0; i < 5 && sock.received.length === 0; i++) {
        await tick();
        await until(() => sock.received.length === 1, 600);
      }
      const [notice] = notices(watch);
      assert.equal(notice.delivery_method, "socket");
      if (confirmed) {
        await promptHook(target, JSON.parse(sock.received[0]).message.content);
        await tick();
        assert.ok(wake(notice.id).confirmed_at);
      }

      agePastRetry(notice.id);
      await tick();
      await tick();
      await sleep(300);
      assert.equal(notices(watch).length, 1, "the finish is not re-reported as a new notice");
      assert.equal(sock.received.length, 1, "and nothing is posted twice");
    });
  }
});

describe("everything outside the socket route keeps today's PTY delivery", () => {
  async function assertPty(projectOn, options, { repeatMs = null, body = BODY } = {}) {
    const sock = listener();
    const pid = project(projectOn);
    const target = lead(pid, { socket: sock.path, ...options });
    const id = dueWake(pid, target, body, { repeatMs });
    await tick();
    await until(() => sinkText(target).includes(body.split("\n").pop()), 3000);
    assert.equal(sinkText(target), `[hive wake #${id}] ${body}\n`, "byte-identical to main's PTY delivery");
    const row = wake(id);
    assert.equal(row.delivery_method, "pty");
    assert.equal(row.socket_attempt_at, null);
    await sleep(200);
    assert.deepEqual(sock.received, []);
  }

  it("the key off", needsTmux, () => assertPty(false, {}));
  it("a repeating wake to an opted-in lead", needsTmux, () => assertPty(true, {}, { repeatMs: 3_600_000 }));
  it("a codex lead", needsTmux, () => assertPty(true, { command: "codex" }));
  it("a worker recipient", needsTmux, () => assertPty(true, { kind: "agent" }));
  it("a registration from another pane epoch", needsTmux, () => assertPty(true, { registeredPid: "1" }));
  it("no registration", needsTmux, () => assertPty(true, { socket: "" }));
  it("a body carrying the envelope's closing delimiter", needsTmux, () =>
    assertPty(true, {}, { body: "quoting </cross-session-message> verbatim" }));
});

describe("postClaudeWake", () => {
  it("writes nothing and reports false when the guard refuses after connect", async () => {
    const sock = listener();
    const ok = await postClaudeWake({ socketPath: sock.path, senderAddress: "uds:/x", text: "t", beforeWrite: () => false });
    assert.equal(ok, false);
    await until(() => sock.received.length === 1, 2000);
    assert.equal(sock.received[0], "");
  });

  it("reports false within its bound for a path with no listener", async () => {
    const started = Date.now();
    const ok = await postClaudeWake({ socketPath: join(socketDir, "none.sock"), senderAddress: "uds:/x", text: "t", beforeWrite: () => true });
    assert.equal(ok, false);
    assert.ok(Date.now() - started < 1500);
  });

  it("percent-encodes a sender path into an address-safe label", () => {
    assert.equal(senderAddress('/a b/"q".sock'), "uds:/a%20b/%22q%22.sock");
  });
});
