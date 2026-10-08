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
const { tick, DELIVER_SOCKET_JOIN, ACTIVE_TIMER_WHERE, socketAwaitingWhere } = await import("../dist/scheduler.js");
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
  it("a repeating wake with the key off", needsTmux, () => assertPty(false, {}, { repeatMs: 3_600_000 }));
  it("a codex lead", needsTmux, () => assertPty(true, { command: "codex" }));
  it("a worker recipient", needsTmux, () => assertPty(true, { kind: "agent" }));
  it("a registration from another pane epoch", needsTmux, () => assertPty(true, { registeredPid: "1" }));
  it("no registration", needsTmux, () => assertPty(true, { socket: "" }));
  it("a body carrying the envelope's closing delimiter", needsTmux, () =>
    assertPty(true, {}, { body: "quoting </cross-session-message> verbatim" }));
});

describe("a repeating wake to an opted-in Claude lead goes by socket on every firing", () => {
  const HOUR = 3_600_000;
  const FOOTER = "Automated hive wake. Do not reply to this sender.";
  const SENDER = senderAddress(join(dataDir, "wake-sender.sock"));
  const envelope = (text, sender = SENDER, name = "hive") =>
    `<cross-session-message from="${sender}" from-name="${name}">\n${text}\n</cross-session-message>`;
  const firingText = (id, n, body = BODY) => `[hive wake #${id} firing #${n}] ${body}\n\n${FOOTER}`;
  const fallbackBytes = (id, n, body = BODY) =>
    `[hive wake #${id} firing #${n}, re-delivered] If you already handled wake #${id} firing #${n}, ignore this.\n${body}\n`;
  const content = (frame) => JSON.parse(frame).message.content;
  const makeDue = (id, seconds = 1) => db.prepare("UPDATE wakes SET due_at = datetime('now', ?) WHERE id = ?").run(`-${seconds} seconds`, id);
  const projectPath = (pid) => db.prepare("SELECT path FROM projects WHERE id = ?").get(pid).path;
  const setKey = (pid, yml) => writeFileSync(join(projectPath(pid), "hive.yml"), yml);
  const backdateFiring = (id, seconds) =>
    db.prepare(
      `UPDATE wakes SET fired_at = datetime('now', ?), socket_attempt_at = strftime('%Y-%m-%d %H:%M:%f', 'now', ?) WHERE id = ?`,
    ).run(`-${seconds + 1} seconds`, `-${seconds} seconds`, id);

  const LEGACY_REPEAT_CLAIM = `UPDATE wakes SET due_at = datetime('now', printf('+%d seconds', ?)),
           fired_at = datetime('now'), fire_count = fire_count + 1,
           typed_at = NULL, confirmed_at = NULL, held_at = NULL, held_reason = NULL, typed_busy = NULL,
           typed_seen = NULL, first_held_at = NULL
         WHERE id = ? AND due_at IS ? AND body IS ? AND repeat_every_ms IS ? AND cancelled_at IS NULL`;
  const legacyRepeatClaim = (id) => {
    const row = wake(id);
    return db.prepare(LEGACY_REPEAT_CLAIM).run(Math.max(1, Math.round(row.repeat_every_ms / 1000)), id, row.due_at, row.body, row.repeat_every_ms).changes;
  };
  const legacyEvidence = (lowerBound) => `
       SELECT MIN(created_at) FROM agent_state_log
        WHERE actor_id = wakes.deliver_actor AND event = 'prompt' AND created_at >= ${lowerBound}
          AND (payload LIKE '%[hive wake #' || wakes.id || ']%'
               OR payload LIKE '%[hive wake #' || wakes.id || ',%')`;
  const LEGACY_SENT_AT = "COALESCE(wakes.socket_attempt_at, wakes.typed_at)";
  const LEGACY_PENDING = `SELECT 1 AS hit FROM wakes
        WHERE ${LEGACY_SENT_AT} IS NOT NULL AND confirmed_at IS NULL AND ${LEGACY_SENT_AT} >= datetime('now', ?) LIMIT 1`;
  const LEGACY_CONFIRM = `UPDATE wakes SET confirmed_at = (${legacyEvidence(LEGACY_SENT_AT)})
       WHERE ${LEGACY_SENT_AT} IS NOT NULL AND confirmed_at IS NULL AND ${LEGACY_SENT_AT} >= datetime('now', ?)
         AND EXISTS (${legacyEvidence(LEGACY_SENT_AT).replace("MIN(created_at)", "1")})`;
  const LEGACY_RETRY = `SELECT wakes.* FROM wakes ${DELIVER_SOCKET_JOIN}
      WHERE wakes.delivery_method = 'socket' AND wakes.confirmed_at IS NULL AND wakes.typed_at IS NULL AND wakes.cancelled_at IS NULL
        AND wakes.socket_attempt_at >= datetime('now', ?)`;

  async function firstFiring({ repeatMs = HOUR, body = BODY, sock = listener() } = {}) {
    const pid = project(true);
    const target = lead(pid, { socket: sock.path });
    const id = dueWake(pid, target, body, { repeatMs });
    await tick();
    assert.ok(await until(() => sock.received.length === 1, 3000), "firing 1 was posted");
    return { pid, target, id, sock };
  }

  async function slowRetryAhead() {
    const sock = listener();
    const pid = project(true);
    const other = lead(pid, { socket: sock.path });
    const id = dueWake(pid, other, "an earlier fallback that holds the retry pass");
    await tick();
    assert.ok(await until(() => sock.received.length === 1, 3000));
    return { other, id };
  }

  async function racedRetry(mutate) {
    const ahead = await slowRetryAhead();
    const f = await firstFiring();
    backdateFiring(ahead.id, 61);
    backdateFiring(f.id, 61);
    setTimeout(() => mutate(f), 150);
    await tick();
    assert.ok(await until(() => sinkText(ahead.other).includes("holds the retry pass"), 3000), "the earlier fallback typed first");
    await sleep(300);
    return f;
  }

  it("three repeating firings post distinct markers and no pane bytes", needsTmux, async () => {
    const { target, id, sock } = await firstFiring();
    for (let n = 1; n <= 3; n++) {
      if (n > 1) {
        makeDue(id);
        await tick();
        assert.ok(await until(() => sock.received.length === n, 3000), `firing ${n} was posted`);
      }
      assert.equal(
        sock.received[n - 1],
        JSON.stringify({ type: "user", from: SENDER, message: { role: "user", content: envelope(firingText(id, n)) } }) + "\n",
      );
      const posted = wake(id);
      assert.equal(posted.fire_count, n);
      assert.equal(posted.delivery_method, "socket-repeating");
      assert.ok(posted.socket_attempt_at >= posted.fired_at);
      assert.equal(posted.typed_at, null);
      assert.equal(posted.confirmed_at, null);

      await promptHook(target, content(sock.received[n - 1]));
      await tick();
      const confirmed = wake(id);
      assert.ok(confirmed.confirmed_at, `firing ${n} is confirmed by its own prompt`);
      assert.equal(confirmed.fire_count, n);
    }
    await sleep(300);
    assert.equal(sinkText(target), "");
  });

  it("key-off repeating wakes preserve exact legacy pane bytes after an earlier socket firing", needsTmux, async () => {
    for (const off of ["dashboard: false\n", "quiet_messaging: false\n"]) {
      const { pid, target, id, sock } = await firstFiring();
      await promptHook(target, content(sock.received[0]));
      await tick();
      assert.ok(wake(id).confirmed_at);

      setKey(pid, off);
      makeDue(id);
      await tick();
      assert.ok(await until(() => sinkText(target).includes("third, indented"), 3000));
      assert.equal(sinkText(target), `[hive wake #${id}] ${BODY}\n`);
      const row = wake(id);
      assert.equal(row.fire_count, 2);
      assert.equal(row.delivery_method, "pty");
      assert.equal(row.socket_attempt_at, null);
      assert.equal(row.socket_delivery_note, null);
      await sleep(200);
      assert.equal(sock.received.length, 1);
    }
  });

  it("worker and Codex repeating recipients remain on PTY", needsTmux, async () => {
    for (const options of [{ kind: "agent" }, { command: "codex" }]) {
      const sock = listener();
      const pid = project(true);
      const target = lead(pid, { socket: sock.path, ...options });
      const id = dueWake(pid, target, BODY, { repeatMs: HOUR });
      await tick();
      assert.ok(await until(() => sinkText(target).includes("third, indented"), 3000));
      assert.equal(sinkText(target), `[hive wake #${id}] ${BODY}\n`);
      assert.equal(wake(id).delivery_method, "pty");
      await sleep(200);
      assert.deepEqual(sock.received, []);
    }
  });

  it("late firing N prompt cannot confirm firing N+1", needsTmux, async () => {
    const { target, id, sock } = await firstFiring();
    backdateFiring(id, 61);
    await tick();
    assert.ok(await until(() => sinkText(target).includes("third, indented"), 3000));
    assert.equal(sinkText(target), fallbackBytes(id, 1));

    makeDue(id);
    await tick();
    assert.ok(await until(() => sock.received.length === 2, 3000));
    assert.equal(content(sock.received[1]), envelope(firingText(id, 2)));

    await promptHook(target, content(sock.received[0]));
    await promptHook(target, fallbackBytes(id, 1).trimEnd());
    await tick();
    assert.equal(wake(id).confirmed_at, null, "firing 1's prompts never confirm firing 2");
    assert.equal(wake(id).fire_count, 2);

    await promptHook(target, content(sock.received[1]));
    await tick();
    assert.ok(wake(id).confirmed_at);
  });

  it("wrong or quoted firing evidence never confirms", needsTmux, async () => {
    const { target, id } = await firstFiring();
    const other = lead(project(true));
    const exact = envelope(firingText(id, 1));
    const wrong = [
      () => promptHook(target, envelope(firingText(id, 2))),
      () => promptHook(target, envelope(firingText(id, 11))),
      () => promptHook(other, exact),
      () => insertStateLogRow(db, target.actorId, "prompt", "working", 30, JSON.stringify({ prompt: exact })),
      () => insertStateLogRow(db, target.actorId, "prompt", "working", 0, JSON.stringify({ prompt: "hello", quoted: exact })),
      () => insertStateLogRow(db, target.actorId, "prompt", "working", 0, JSON.stringify({ note: `[hive wake #${id} firing #1] x` })),
      () => promptHook(target, `look at [hive wake #${id} firing #1] later`),
      () => promptHook(target, envelope(`a worker said: [hive wake #${id} firing #1] ${BODY}`)),
      () => promptHook(target, envelope(firingText(id, 1), "uds:/x", "bob")),
      () => promptHook(target, envelope(firingText(id, 1), `uds:/x" from-name="bob`)),
      () => promptHook(target, `<cross-session-message from="uds:/x" from-name="hive">\n[hive wake #${id} firing #1] no closing tag`),
    ];
    for (const [i, insert] of wrong.entries()) {
      await insert();
      await tick();
      assert.equal(wake(id).confirmed_at, null, `wrong evidence #${i} must not confirm`);
    }

    await promptHook(target, exact);
    await tick();
    assert.ok(wake(id).confirmed_at, "the exact envelope confirms");

    db.prepare("UPDATE wakes SET confirmed_at = NULL WHERE id = ?").run(id);
    db.exec("DELETE FROM agent_state_log");
    await promptHook(target, fallbackBytes(id, 1).trimEnd());
    await tick();
    assert.ok(wake(id).confirmed_at, "the typed firing prefix at offset 0 confirms");
  });

  it("two schedulers claim one repeating fallback", needsTmux, async () => {
    const { target, id } = await firstFiring();
    backdateFiring(id, 61);
    await raceProcesses(
      `const { tick } = await import(${JSON.stringify(join(DIST, "scheduler.js"))});\nawait tick();\nprocess.stdout.write("{}");\n`,
      [[], []],
      { env: { HIVE_DATA_DIR: dataDir } },
    );
    assert.ok(await until(() => sinkText(target).includes("third, indented"), 3000));
    await sleep(500);
    assert.equal(sinkText(target), fallbackBytes(id, 1));
    const row = wake(id);
    assert.equal(row.delivery_method, "pty-after-socket-timeout");
    assert.equal(row.fire_count, 1);
  });

  it("a losing repeating fallback claim types nothing and keeps the winner's method", needsTmux, async () => {
    const f = await racedRetry(({ id }) =>
      db.prepare("UPDATE wakes SET delivery_method = 'pty-after-socket-timeout' WHERE id = ?").run(id),
    );
    assert.equal(sinkText(f.target), "");
    const row = wake(f.id);
    assert.equal(row.delivery_method, "pty-after-socket-timeout");
    assert.equal(row.typed_at, null);
    assert.equal(row.fire_count, 1);
  });

  it("busy repeating firing waits for first stop plus grace", needsTmux, async () => {
    const sock = listener();
    const pid = project(true);
    const target = lead(pid, { socket: sock.path });
    db.prepare("INSERT INTO lead_turn_state (agent_id, pane_pid, session_id, state) VALUES (?, ?, 's1', 'working')").run(target.rowId, target.pid);
    const id = dueWake(pid, target, BODY, { repeatMs: HOUR });
    await tick();
    assert.ok(await until(() => sock.received.length === 1, 3000));

    backdateFiring(id, 600);
    await tick();
    assert.equal(wake(id).typed_at, null, "busy with no turn end is not a timeout");
    insertStateLogRow(db, target.actorId, "stop", "idle", 30);
    await tick();
    assert.equal(wake(id).typed_at, null, "30 s after the turn end is inside the bound");

    db.exec("DELETE FROM agent_state_log");
    insertStateLogRow(db, target.actorId, "stop", "idle", 61);
    await tick();
    assert.ok(await until(() => sinkText(target).includes("third, indented"), 3000));
    assert.equal(sinkText(target), fallbackBytes(id, 1));
  });

  it("late repeating confirmation defeats fallback claim", needsTmux, async () => {
    const f = await racedRetry(({ target, id }) =>
      insertStateLogRow(db, target.actorId, "prompt", "working", 0, JSON.stringify({ prompt: envelope(firingText(id, 1)) })),
    );
    assert.equal(sinkText(f.target), "", "the claim saw the prompt and typed nothing");
    assert.equal(wake(f.id).delivery_method, "socket-repeating");
    await tick();
    assert.ok(wake(f.id).confirmed_at);
  });

  it("held repeating fallback resumes once without advancing its firing", needsTmux, async () => {
    const { target, id } = await firstFiring();
    backdateFiring(id, 61);

    insertStateLogRow(db, target.actorId, "prompt", "working", 5, JSON.stringify({ prompt: "a human is talking to the lead" }));
    await tick();
    await sleep(300);
    assert.match(wake(id).held_reason ?? "", /a human talked to this lead/);
    db.prepare("DELETE FROM agent_state_log WHERE actor_id = ? AND payload LIKE '%a human is talking%'").run(target.actorId);

    execFileSync("tmux", ["copy-mode", "-t", target.pane]);
    await tick();
    await sleep(300);
    assert.match(wake(id).held_reason ?? "", /copy mode/);
    execFileSync("tmux", ["send-keys", "-t", target.pane, "-X", "cancel"]);

    assert.equal(sinkText(target), "");
    assert.equal(wake(id).delivery_method, "socket-repeating");
    assert.equal(wake(id).fire_count, 1);

    await tick();
    assert.ok(await until(() => sinkText(target).includes("third, indented"), 3000));
    await tick();
    await sleep(300);
    assert.equal(sinkText(target), fallbackBytes(id, 1));
    const row = wake(id);
    assert.equal(row.fire_count, 1);
    assert.equal(row.held_reason, null);
  });

  it("next interval defers until the current firing settles", needsTmux, async () => {
    const { target, id, sock } = await firstFiring({ repeatMs: 5_000 });
    for (let i = 0; i < 3; i++) {
      makeDue(id, 120);
      const due = wake(id).due_at;
      await tick();
      await sleep(200);
      assert.equal(sock.received.length, 1, "no second post while firing 1 is unsettled");
      assert.equal(wake(id).fire_count, 1);
      assert.equal(wake(id).due_at, due);
    }
    await promptHook(target, content(sock.received[0]));
    await tick();
    await tick();
    assert.ok(await until(() => sock.received.length === 2, 3000));
    await tick();
    await sleep(300);
    assert.equal(sock.received.length, 2, "one overdue claim, no catch-up");
    const row = wake(id);
    assert.equal(row.fire_count, 2);
    assert.ok(db.prepare("SELECT ? > datetime('now') AS later").get(row.due_at).later, "scheduled from the claim time");
  });

  it("a key flipped off while a firing is pending keeps its fallback, then types the next firing as before", needsTmux, async () => {
    const { pid, target, id, sock } = await firstFiring({ repeatMs: 5_000 });
    setKey(pid, "quiet_messaging: false\n");
    makeDue(id, 120);
    await tick();
    await sleep(200);
    assert.equal(wake(id).fire_count, 1);
    assert.equal(sinkText(target), "");

    backdateFiring(id, 61);
    await tick();
    assert.ok(await until(() => sinkText(target).includes("third, indented"), 3000));
    assert.equal(sinkText(target), fallbackBytes(id, 1));

    makeDue(id);
    await tick();
    assert.ok(await until(() => sinkText(target).split("third, indented").length === 3, 3000));
    assert.equal(sinkText(target), fallbackBytes(id, 1) + `[hive wake #${id}] ${BODY}\n`);
    assert.equal(wake(id).delivery_method, "pty");
    assert.equal(sock.received.length, 1);
  });

  it("post-fallback-claim crash is readable and never pasted again", needsTmux, async () => {
    const { target, id, sock } = await firstFiring();
    db.prepare("UPDATE wakes SET delivery_method = 'pty-after-socket-timeout', due_at = datetime('now', '-60 seconds') WHERE id = ?").run(id);
    backdateFiring(id, 120);
    for (let i = 0; i < 3; i++) await tick();
    await sleep(300);
    assert.equal(sinkText(target), "");
    let row = wake(id);
    assert.equal(row.fire_count, 1, "the unresolved fallback defers the next firing");
    assert.equal(row.delivery_method, "pty-after-socket-timeout");
    assert.equal(row.typed_at, null);

    await promptHook(target, content(sock.received[0]));
    await tick();
    assert.ok(await until(() => sock.received.length === 2, 3000), "a late exact confirmation settles it and the next firing proceeds");
    assert.equal(wake(id).fire_count, 2);
    assert.equal(sinkText(target), "");
  });

  it("failed repeating post falls back immediately exactly once", needsTmux, async () => {
    const pid = project(true);
    const target = lead(pid, { socket: join(socketDir, "nobody-listens-repeat.sock") });
    const id = dueWake(pid, target, BODY, { repeatMs: HOUR });
    await tick();
    assert.ok(await until(() => sinkText(target).includes("third, indented"), 3000));
    for (let i = 0; i < 3; i++) await tick();
    await sleep(300);
    assert.equal(sinkText(target), fallbackBytes(id, 1));
    const row = wake(id);
    assert.equal(row.delivery_method, "pty-after-socket-timeout");
    assert.ok(row.socket_attempt_at);
    assert.ok(row.typed_at);
    assert.equal(row.fire_count, 1);
  });

  it("old repeating claim within the attempt's own second invalidates the stale fallback", needsTmux, async () => {
    const f = await racedRetry(({ id }) => {
      assert.equal(legacyRepeatClaim(id), 1);
      db.prepare("UPDATE wakes SET fired_at = substr(socket_attempt_at, 1, 19) WHERE id = ?").run(id);
    });
    assert.equal(sinkText(f.target), "", "firing 1's fallback is dropped, not replayed into firing 2");
    const row = wake(f.id);
    assert.equal(row.delivery_method, "socket-repeating", "the count-guarded claim changed nothing");
    assert.equal(row.fire_count, 2);
    assert.equal(row.typed_at, null);
    assert.equal(row.held_reason, null);
  });

  it("an old claim between the fallback's paste and its Enter stops the Enter", needsTmux, async () => {
    const { target, id } = await firstFiring();
    backdateFiring(id, 61);
    let bumped = false;
    const watch = setInterval(() => {
      if (!bumped && sinkText(target).includes("second line")) {
        bumped = legacyRepeatClaim(id) === 1;
      }
    }, 10);
    await tick();
    clearInterval(watch);
    await sleep(300);
    assert.ok(bumped, "the paste landed and the old claim ran before the Enter");
    assert.ok(!sinkText(target).includes("third, indented"), "no Enter for a superseded firing");
    const row = wake(id);
    assert.equal(row.fire_count, 2);
    assert.equal(row.typed_at, null, "nothing is recorded onto the newer firing");
    assert.equal(row.held_reason, null);
  });

  it("an old repeat claim's fired_at rejects the previous socket attempt", needsTmux, async () => {
    const fresh = await firstFiring();
    backdateFiring(fresh.id, 61);
    assert.equal(legacyRepeatClaim(fresh.id), 1);
    const stale = wake(fresh.id);
    assert.equal(stale.delivery_method, "socket-repeating", "the old claim leaves firing 1's socket fields behind");
    assert.ok(stale.socket_attempt_at < stale.fired_at);
    for (let i = 0; i < 2; i++) await tick();
    await sleep(300);
    assert.equal(sinkText(fresh.target), "", "a fresh retry sees no eligible row");

    const f = await racedRetry(({ id }) => {
      assert.equal(legacyRepeatClaim(id), 1);
      db.prepare("UPDATE wakes SET fire_count = fire_count - 1 WHERE id = ?").run(id);
    });
    assert.equal(sinkText(f.target), "", "the claim stamp rejects the attempt even when the count matches");
    assert.equal(wake(f.id).typed_at, null);

    const control = await firstFiring();
    backdateFiring(control.id, 61);
    await tick();
    assert.ok(await until(() => sinkText(control.target).includes("third, indented"), 3000));
    assert.equal(sinkText(control.target), fallbackBytes(control.id, 1), "an attempt at or after the claim stamp falls back once");
  });

  it("legacy confirm and retry SQL ignore a clean repeating socket marker", needsTmux, async () => {
    const { target, id, sock } = await firstFiring();
    await promptHook(target, content(sock.received[0]));
    assert.ok(db.prepare(LEGACY_PENDING).get("-7 days"), "the legacy pending probe still sees the row");
    assert.equal(db.prepare(LEGACY_CONFIRM).run("-7 days").changes, 0);
    assert.equal(db.prepare(LEGACY_RETRY).all("-7 days").length, 0);
    await tick();
    assert.ok(wake(id).confirmed_at, "new code confirms the exact marker");

    const quoted = await firstFiring();
    await promptHook(quoted.target, envelope(firingText(quoted.id, 7, `quoting [hive wake #${quoted.id}] from an old note`)));
    db.exec("SAVEPOINT legacy");
    assert.equal(db.prepare(LEGACY_CONFIRM).run("-7 days").changes, 1, "the documented old-build uncertainty: a body quote fools the old matcher");
    db.exec("ROLLBACK TO legacy; RELEASE legacy");
    await tick();
    assert.equal(wake(quoted.id).confirmed_at, null, "new code does not reproduce it");
  });

  it("repeating cancellation and lead re-point preserve firing identity", needsTmux, async () => {
    const cancelled = await firstFiring();
    db.prepare("UPDATE wakes SET cancelled_at = datetime('now') WHERE id = ?").run(cancelled.id);
    backdateFiring(cancelled.id, 61);
    await tick();
    await sleep(300);
    assert.equal(sinkText(cancelled.target), "");
    assert.equal(wake(cancelled.id).fire_count, 1);
    assert.equal(wake(cancelled.id).delivery_method, "socket-repeating");

    const { target, id } = await firstFiring();
    const next = sinkPane();
    db.prepare("UPDATE agents SET tmux_target = ?, pane_pid = ? WHERE id = ?").run(next.pane, next.pid, target.rowId);
    db.prepare(
      `UPDATE wakes SET deliver_pane = ?, held_at = NULL, held_reason = NULL
        WHERE ((${ACTIVE_TIMER_WHERE}) OR (${socketAwaitingWhere()})) AND deliver_actor = ?`,
    ).run(next.pane, target.actorId);
    backdateFiring(id, 61);
    await tick();
    assert.ok(await until(() => readFileSync(next.sink, "utf8").includes("third, indented"), 3000));
    assert.equal(readFileSync(next.sink, "utf8"), fallbackBytes(id, 1), "the restarted lead gets firing 1's fallback");
    assert.equal(sinkText(target), "");
    assert.equal(wake(id).fire_count, 1);
  });
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
