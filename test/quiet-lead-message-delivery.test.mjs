import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";

import {
  DIST,
  REPO,
  assertScratchStore,
  clearHiveEnv,
  insertStateLogRow,
  isolateTmux,
  McpClient,
  raceProcesses,
  runNode,
  scratchDirs,
  sleep,
  until,
} from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("the quiet lead message delivery tests");
const { dataDir, tmp } = scratchDirs();
clearHiveEnv();
delete process.env.CLAUDE_CODE_MESSAGING_SOCKET;
process.env.HIVE_DATA_DIR = dataDir;
await assertScratchStore();

const { db, migrate } = await import("../dist/db.js");
const { tick } = await import("../dist/scheduler.js");
const { sendQuietLeadMessage, retryQuietLeadMessages } = await import("../dist/leadMessageDelivery.js");
const { renderLeadPointer } = await import("../dist/leadMessage.js");
const { senderAddress } = await import("../dist/claudeWake.js");
const { liveTargets, tmuxSocketPath } = await import("../dist/tmux.js");
migrate();

const HOOK = join(DIST, "hook.js");
const FIXTURES = join(REPO, "test", "fixtures", "panes");
const ownSocket = tmuxSocketPath(process.env.TMUX, process.env.TMUX_TMPDIR);
const socketDir = mkdtempSync(join(tmpdir(), "qlm-"));
const needsTmux = { skip: hasTmux ? false : "tmux is not installed" };
const FOOTER = "Automated hive worker message. Do not reply to this socket sender.";
const NO_SCHEDULER = { HIVE_SCHEDULER_INTERVAL_MS: "2147483647" };
const sessions = [];
const servers = [];
const clients = [];
after(async () => {
  for (const client of clients) await client.close().catch(() => {});
  for (const server of servers) server.close();
  rmSync(socketDir, { recursive: true, force: true });
  cleanup(...sessions);
});

beforeEach(() =>
  db.exec("DELETE FROM agent_messages; DELETE FROM agent_state_log; DELETE FROM lead_turn_state; DELETE FROM leases; DELETE FROM wakes;"),
);

function project(key) {
  const dir = mkdtempSync(join(tmp, "qlm-project-"));
  writeFileSync(join(dir, "hive.yml"), key === undefined ? "dashboard: false\n" : `dashboard: false\nquiet_messaging: ${key}\n`);
  const id = db.prepare("INSERT INTO projects (name, path) VALUES ('qlm', ?) RETURNING id").get(dir).id;
  return { id, dir };
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
const refusedSocket = () => join(socketDir, `nobody-${servers.length}-${Math.random()}.sock`);

let paneCount = 0;
function sinkPane({ fixture } = {}) {
  const session = `qlm-${process.pid}-${paneCount++}`;
  const sink = join(tmp, `${session}.sink`);
  const flag = join(tmp, `${session}.flag`);
  writeFileSync(sink, "");
  const script = fixture
    ? `cat '${join(FIXTURES, fixture)}'; while [ ! -f '${flag}' ]; do sleep 0.05; done; clear; cat > '${sink}'`
    : `cat > '${sink}'`;
  execFileSync("tmux", ["new-session", "-d", "-s", session, "-x", "200", "-y", "50", script], { stdio: "ignore" });
  sessions.push(session);
  const [pane, pid] = execFileSync("tmux", ["list-panes", "-t", `=${session}`, "-F", "#{pane_id}\t#{pane_pid}"], { encoding: "utf8" })
    .trim()
    .split("\t");
  return { pane, pid, sink, flag };
}

let actorCount = 0;
function agentRow(projectId, { kind, socket = "", registeredPid, command = "claude", fixture, name } = {}) {
  const { pane, pid, sink, flag } = sinkPane({ fixture });
  const n = actorCount++;
  const actorId = `${kind}:qlm${n}`;
  const rowName = name ?? `qlm-${kind}-${n}`;
  const rowId = db
    .prepare(
      `INSERT INTO agents (project_id, actor_id, name, kind, tmux_target, tmux_socket, pane_pid, command, cwd, status,
         claude_messaging_socket, claude_messaging_pane_pid, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, '/tmp', 'running', ?, ?, datetime('now', '-60 seconds')) RETURNING id`,
    )
    .get(projectId, actorId, rowName, kind, pane, ownSocket, pid, command, socket, registeredPid ?? (socket ? pid : "")).id;
  return { actorId, rowId, pane, pid, sink, flag, name: rowName, tag: `[hive:${kind === "lead" ? "lead" : "worker"} ${rowName}] ` };
}
const lead = (projectId, options = {}) => agentRow(projectId, { kind: "lead", ...options });
const worker = (projectId, options = {}) => agentRow(projectId, { kind: "agent", ...options });

const agent = (rowId) => db.prepare("SELECT * FROM agents WHERE id = ?").get(rowId);
const message = (id) => db.prepare("SELECT * FROM agent_messages WHERE id = ?").get(id);
const sinkText = (target) => readFileSync(target.sink, "utf8");
const screen = (target) => execFileSync("tmux", ["capture-pane", "-p", "-t", target.pane], { encoding: "utf8" });
const backdateAttempt = (id, seconds) =>
  db.prepare("UPDATE agent_messages SET socket_attempt_at = strftime('%Y-%m-%d %H:%M:%f', 'now', ?) WHERE id = ?").run(`-${seconds} seconds`, id);
const copyMode = (target, on) =>
  execFileSync("tmux", on ? ["copy-mode", "-t", target.pane] : ["send-keys", "-t", target.pane, "-X", "cancel"], { stdio: "ignore" });

function send(projectId, from, target, text, submit = true) {
  return sendQuietLeadMessage({ projectId, fromActor: from.actorId, target: agent(target.rowId), text, submit });
}

async function mcpAs(proj, actorId) {
  const client = new McpClient({ cwd: proj.dir, dataDir, env: { HIVE_AGENT_ID: actorId, ...NO_SCHEDULER } });
  await client.start();
  clients.push(client);
  return client;
}

async function promptHook(target, prompt, session = "s1") {
  const { code } = await runNode(HOOK, ["prompt"], {
    dataDir,
    env: { HIVE_AGENT_ID: target.actorId, HIVE_LEAD: "1" },
    stdin: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: session, prompt }),
  });
  assert.equal(code, 0);
}

const sender = () => senderAddress(join(dataDir, "wake-sender.sock"));
const envelope = (body) => `<cross-session-message from="${sender()}" from-name="hive">\n${body}\n</cross-session-message>`;
const frameFor = (body) =>
  JSON.stringify({ type: "user", from: sender(), message: { role: "user", content: envelope(body) } }) + "\n";
const shortRender = (id, tag, text, redelivered = false) =>
  `${tag}[message #${id}, ${text.length} chars${redelivered ? ", re-delivered" : ""}]` +
  (redelivered ? ` If you already handled message #${id}, ignore this.` : "") +
  ` ${text}`;
const markerCount = (text, id) => text.split(`[message #${id},`).length - 1;

const DEEP = "ZQXDEEPMARKERZQX";
const longText = (n) => `${"a".repeat(200)} ${DEEP} ${"b".repeat(n - 218)}`.slice(0, n);

describe("a worker's send to an opted-in Claude lead goes over the lead's socket", () => {
  it("quiet worker send posts one named frame and no pane bytes", needsTmux, async () => {
    const proj = project(true);
    const sock = listener();
    const target = lead(proj.id, { socket: sock.path });
    const from = worker(proj.id);
    const text = "short report\nsecond line";
    const client = await mcpAs(proj, from.actorId);

    const receipt = await client.call("agent_send", { name: target.name, text });
    assert.ok(await until(() => sock.received.length === 1, 3000), "one frame reached the socket");
    const id = receipt.message_id;
    assert.deepEqual(
      { ...receipt, note: undefined },
      { agent_id: target.rowId, name: target.name, message_id: id, sent: true, pending: true, delivery_method: "socket", confirmed: false, note: undefined },
    );
    assert.match(receipt.note, /awaiting prompt confirmation; do not resend/);
    assert.ok(!JSON.stringify(receipt).includes("short report"), "a receipt never echoes the message");
    assert.equal(sock.received[0], frameFor(`${shortRender(id, from.tag, text)}\n\n${FOOTER}`));

    const row = message(id);
    assert.equal(row.text, text);
    assert.equal(row.delivery_status, "socket-pending");
    assert.equal(row.delivery_method, "socket");
    assert.ok(row.socket_attempt_at);
    assert.equal(row.typed_at, null);
    assert.equal(row.confirmed_at, null);
    assert.equal(row.sender_tag, from.tag);
    assert.deepEqual(JSON.parse(row.target_identity), { tmux_target: target.pane, tmux_socket: ownSocket, pane_pid: target.pid });

    await sleep(400);
    assert.equal(sinkText(target), "", "nothing typed into the lead's pane");
    assert.equal(sock.received.length, 1);
  });

  it("quiet long send retains its 140-character pointer and full lookup", needsTmux, async () => {
    const proj = project(true);
    const sock = listener();
    const target = lead(proj.id, { socket: sock.path });
    const from = worker(proj.id);
    const text = longText(1000);
    const client = await mcpAs(proj, from.actorId);

    const receipt = await client.call("agent_send", { name: target.name, text });
    assert.ok(await until(() => sock.received.length === 1, 3000));
    assert.equal(receipt.shortened, true);
    assert.equal(receipt.delivery_method, "socket");
    assert.match(receipt.note, /messaging socket/);
    assert.doesNotMatch(receipt.note, /that pane got/, "the pane-only shortening claim is not made for a socket post");
    const id = receipt.message_id;
    assert.equal(sock.received[0], frameFor(`${renderLeadPointer(id, text, from.tag)}\n\n${FOOTER}`));
    assert.ok(!sock.received[0].includes(DEEP), "the body past the head never rides the socket");

    const got = await client.call("agent_message_get", { message_id: id });
    assert.equal(got.text, text);
    assert.equal(got.chars, 1000);
    assert.equal(got.delivery_status, "socket-pending");
    assert.equal(got.delivery_method, "socket");
    assert.equal(sinkText(target), "");
  });
});

describe("only an opted-in worker-to-Claude-lead submitted send takes the socket", () => {
  it("key absent and false preserve today's bytes and short-message storage", needsTmux, async () => {
    for (const key of [undefined, false]) {
      const proj = project(key);
      const sock = listener();
      const target = lead(proj.id, { socket: sock.path });
      const from = worker(proj.id);
      const client = await mcpAs(proj, from.actorId);

      const short = await client.call("agent_send", { name: target.name, text: "short report" });
      assert.deepEqual(short, { agent_id: target.rowId, name: target.name, sent: true }, `key ${key}`);
      assert.ok(await until(() => sinkText(target) === `${from.tag}short report\n`, 3000), `key ${key}: ${sinkText(target)}`);
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM agent_messages").get().n, 0, "a short key-off send stores nothing");

      const text = longText(900);
      const long = await client.call("agent_send", { name: target.name, text });
      assert.equal(long.shortened, true);
      assert.match(long.note, /that pane got a \d+-character pointer/);
      const expected = `${from.tag}short report\n${renderLeadPointer(long.message_id, text, from.tag)}\n`;
      assert.ok(await until(() => sinkText(target) === expected, 3000), `key ${key}: ${sinkText(target)}`);
      assert.equal(message(long.message_id).delivery_status, null, "a key-off pointer row carries no delivery metadata");
      assert.equal(sock.received.length, 0, `key ${key}: zero frames`);
      db.exec("DELETE FROM agent_messages");
    }
  });

  it("lead send, worker target, Codex lead, keys and submit=false stay PTY", needsTmux, async () => {
    const proj = project(true);
    const sock = listener();
    const target = lead(proj.id, { socket: sock.path });
    const from = worker(proj.id);
    const otherLead = lead(proj.id);
    const codex = lead(proj.id, { socket: sock.path, command: "codex" });
    const peer = worker(proj.id);

    assert.equal(await send(proj.id, otherLead, target, "from a lead"), null, "a lead sender");
    assert.equal(await send(proj.id, { actorId: "human:someone" }, target, "from a human"), null, "a human sender");
    assert.equal(await send(proj.id, target, target, "to itself"), null, "the lead itself");
    assert.equal(await send(proj.id, from, peer, "to a worker"), null, "a worker target");
    assert.equal(await send(proj.id, from, codex, "to a codex lead"), null, "a Codex lead");
    assert.equal(await send(proj.id, from, target, "unsubmitted", false), null, "submit=false");

    const client = await mcpAs(proj, from.actorId);
    const toPeer = await client.call("agent_send", { name: peer.name, text: "worker bound" });
    assert.deepEqual(toPeer, { agent_id: peer.rowId, name: peer.name, sent: true });
    assert.ok(await until(() => sinkText(peer) === `${from.tag}worker bound\n`, 3000));
    const unsubmitted = await client.call("agent_send", { name: target.name, text: "left in the box", submit: false });
    assert.deepEqual(unsubmitted, { agent_id: target.rowId, name: target.name, sent: true });
    assert.ok(await until(() => screen(target).includes("left in the box"), 3000), "submit=false is still pasted into the pane");
    await assert.rejects(client.call("agent_send", { name: target.name, keys: ["Enter"] }), /refuses to send raw keys to a lead/);

    await sleep(300);
    assert.equal(sock.received.length, 0, "zero frames");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM agent_messages").get().n, 0, "nothing stored");
  });
});

describe("a socket-posted message is confirmed by its own prompt and nothing else", () => {
  it("prompt confirms the matching message only", needsTmux, async () => {
    const proj = project(true);
    const sock = listener();
    const target = lead(proj.id, { socket: sock.path });
    const from = worker(proj.id);
    const stranger = lead(proj.id);
    db.prepare("INSERT INTO lead_turn_state (agent_id, pane_pid, session_id, state) VALUES (?, ?, 's-real', 'idle')").run(target.rowId, target.pid);

    insertStateLogRow(db, target.actorId, "prompt", "working", 5, JSON.stringify({ session_id: "s-real", prompt: "early" }));
    const receipt = await send(proj.id, from, target, "short report");
    const id = receipt.message_id;
    assert.ok(await until(() => sock.received.length === 1, 3000));
    const content = JSON.parse(sock.received[0]).message.content;
    const log = (actor, prompt, session = "s-real", ago = 0) =>
      insertStateLogRow(db, actor, "prompt", "working", ago, JSON.stringify({ session_id: session, prompt }));

    db.prepare("UPDATE agent_state_log SET payload = ? WHERE actor_id = ?").run(JSON.stringify({ session_id: "s-real", prompt: content }), target.actorId);
    log(target.actorId, content.replace(`[message #${id},`, `[message #${id + 1},`));
    log(stranger.actorId, content);
    log(target.actorId, `a human quoting it: ${content}`);
    log(target.actorId, JSON.stringify({ quoted: content }), "s-real");
    await tick();
    assert.equal(message(id).confirmed_at, null, "a pre-post prompt, another id or actor, or a quotation never confirms");
    assert.equal(message(id).delivery_status, "socket-pending");

    await promptHook(target, content, "s-real");
    await tick();
    assert.ok(message(id).confirmed_at, "the real hook seeing the envelope confirms it");
    assert.equal(message(id).delivery_status, "complete");

    backdateAttempt(id, 600);
    await tick();
    await tick();
    await sleep(300);
    assert.equal(sinkText(target), "", "a confirmed message is never typed");
  });

  it("a lead's first prompt after /clear confirms a message sent while its turn state still named the old session", needsTmux, async () => {
    const proj = project(true);
    const sock = listener();
    const target = lead(proj.id, { socket: sock.path });
    const from = worker(proj.id);
    db.prepare("INSERT INTO lead_turn_state (agent_id, pane_pid, session_id, state) VALUES (?, ?, 's-old', 'unknown')").run(target.rowId, target.pid);
    const { message_id: id } = await send(proj.id, from, target, "report after clear");
    assert.ok(await until(() => sock.received.length === 1, 3000));

    await promptHook(target, JSON.parse(sock.received[0]).message.content, "s-new");
    await tick();
    assert.ok(message(id).confirmed_at, "the new session reading the envelope confirms it");
    assert.equal(message(id).delivery_status, "complete");
    backdateAttempt(id, 600);
    insertStateLogRow(db, target.actorId, "stop", "idle", 300);
    await tick();
    await sleep(300);
    assert.equal(sinkText(target), "", "a message the lead already read is never re-typed");
  });

  it("busy lead starts fallback grace at its first stop", needsTmux, async () => {
    const proj = project(true);
    const sock = listener();
    const target = lead(proj.id, { socket: sock.path });
    const from = worker(proj.id);
    const text = "report for a busy lead";
    const { message_id: id } = await send(proj.id, from, target, text);
    db.prepare("INSERT INTO lead_turn_state (agent_id, pane_pid, session_id, state) VALUES (?, ?, '', 'working')").run(target.rowId, target.pid);

    backdateAttempt(id, 120);
    await tick();
    await sleep(300);
    assert.equal(sinkText(target), "", "no fallback while the lead's turn is still running");
    assert.equal(message(id).delivery_status, "socket-pending");

    insertStateLogRow(db, target.actorId, "stop", "idle", 30);
    await tick();
    await sleep(300);
    assert.equal(sinkText(target), "", "the grace runs from the first stop, which was only 30 s ago");

    db.prepare("UPDATE agent_state_log SET created_at = strftime('%Y-%m-%d %H:%M:%f', 'now', '-61 seconds') WHERE event = 'stop'").run();
    await tick();
    assert.ok(await until(() => sinkText(target).includes(text), 3000));
    assert.equal(sinkText(target), `${shortRender(id, from.tag, text, true)}\n`);
    const row = message(id);
    assert.equal(row.delivery_status, "complete");
    assert.equal(row.delivery_method, "pty-after-socket-timeout");
    assert.ok(row.typed_at && row.fallback_claimed_at);
    await tick();
    await sleep(300);
    assert.equal(markerCount(sinkText(target), id), 1, "exactly one fallback");
  });
});

describe("a message the socket cannot carry is typed once, guarded", () => {
  it("missing socket and failed post use one guarded pane fallback", needsTmux, async () => {
    const proj = project(true);
    const sock = listener();
    const cases = [
      ["no registration", lead(proj.id), "plain report", "pty"],
      ["mismatched pane pid", lead(proj.id, { socket: sock.path, registeredPid: "999999" }), "plain report", "pty"],
      ["refused connect", lead(proj.id, { socket: refusedSocket() }), "plain report", "pty-after-socket-timeout"],
      ["close tag in text", lead(proj.id, { socket: sock.path }), "quoting </cross-session-message> here", "pty"],
    ];
    const from = worker(proj.id);
    for (const [label, target, text, method] of cases) {
      const receipt = await send(proj.id, from, target, text);
      assert.equal(receipt.sent, true, label);
      assert.equal(receipt.pending, false, label);
      assert.equal(receipt.delivery_method, method, label);
      assert.ok(await until(() => sinkText(target).includes(text), 3000), label);
      assert.equal(sinkText(target), `${shortRender(receipt.message_id, from.tag, text, method !== "pty")}\n`, label);
      const row = message(receipt.message_id);
      assert.equal(row.delivery_status, "complete", label);
      assert.equal(row.delivery_method, method, label);
      assert.ok(row.typed_at && row.fallback_claimed_at, label);
    }
    await tick();
    await tick();
    await sleep(300);
    for (const [label, target, , ] of cases) assert.equal(sinkText(target).split("\n").length, 2, `${label}: one paste`);
    assert.equal(sock.received.length, 0, "the mismatched and close-tag cases never posted");
  });

  it("late prompt defeats fallback claim", needsTmux, async () => {
    const proj = project(true);
    const target = lead(proj.id, { socket: refusedSocket() });
    const from = worker(proj.id);
    const nextId = (db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'agent_messages'").get()?.seq ?? 0) + 1;
    db.prepare(
      "INSERT INTO agent_state_log (actor_id, event, state, payload, created_at) VALUES (?, 'prompt', 'working', ?, strftime('%Y-%m-%d %H:%M:%f', 'now', '+30 seconds'))",
    ).run(target.actorId, JSON.stringify({ prompt: `${from.tag}[message #${nextId}, 6 chars] report` }));

    const receipt = await send(proj.id, from, target, "report");
    assert.equal(receipt.message_id, nextId);
    assert.equal(receipt.sent, true);
    assert.equal(receipt.pending, true, "settled elsewhere, not yet recorded complete");
    assert.match(receipt.note, /settled by another delivery path/);
    await sleep(400);
    assert.equal(sinkText(target), "", "the claim's own NOT EXISTS saw the prompt, so nothing was pasted");
    assert.equal(message(nextId).fallback_claimed_at, null);
    await tick();
    assert.equal(message(nextId).delivery_status, "complete", "the scheduler's confirmation pass records that prompt");
    assert.ok(message(nextId).confirmed_at);
  });

  it("two scheduler processes claim one fallback", needsTmux, async () => {
    const proj = project(true);
    const target = lead(proj.id, { socket: refusedSocket() });
    const from = worker(proj.id);
    copyMode(target, true);
    const held = await send(proj.id, from, target, "raced report");
    assert.equal(held.sent, false);
    copyMode(target, false);

    await raceProcesses(
      `const { tick } = await import(${JSON.stringify(join(DIST, "scheduler.js"))});\nawait tick();\nprocess.stdout.write("{}");\n`,
      [[], []],
      { env: { HIVE_DATA_DIR: dataDir } },
    );
    assert.ok(await until(() => sinkText(target).includes("raced report"), 3000));
    await sleep(500);
    assert.equal(markerCount(sinkText(target), held.message_id), 1, sinkText(target));
    assert.equal(message(held.message_id).delivery_status, "complete");
  });
});

describe("a pane fallback holds, fails or stays uncertain by name", () => {
  it("copy mode, dialog, pending input and unknown ownership hold fallback", needsTmux, async () => {
    const proj = project(true);
    const from = worker(proj.id);
    const copy = lead(proj.id, { socket: refusedSocket() });
    const dialog = lead(proj.id, { socket: refusedSocket(), fixture: "folder-trust-dialog.txt" });
    const typing = lead(proj.id, { socket: refusedSocket(), fixture: "real-input.txt" });
    const unanswered = lead(proj.id, { socket: refusedSocket() });
    const noPid = lead(proj.id);
    db.prepare("UPDATE agents SET pane_pid = '' WHERE id = ?").run(noPid.rowId);
    await sleep(300);
    copyMode(copy, true);
    copyMode(unanswered, true);

    const expectations = [
      [copy, /copy mode/],
      [dialog, /waiting on a choice/],
      [typing, /unsubmitted text/],
      [unanswered, /copy mode/],
      [noPid, /ownership reads unknown/],
    ];
    const ids = [];
    for (const [target, reason] of expectations) {
      const receipt = await send(proj.id, from, target, `held for ${target.name}`);
      assert.equal(receipt.sent, false, target.name);
      assert.equal(receipt.pending, true, target.name);
      assert.match(receipt.note, /do NOT resubmit/);
      assert.match(message(receipt.message_id).delivery_note, reason, target.name);
      assert.equal(message(receipt.message_id).delivery_status, "fallback-pending");
      ids.push(receipt.message_id);
    }
    await tick();
    await sleep(300);
    for (const [target] of expectations) assert.equal(sinkText(target), "", `${target.name}: no paste while held`);
    copyMode(unanswered, false);
    await retryQuietLeadMessages(null);
    await sleep(300);
    assert.match(message(ids[3]).delivery_note, /ownership reads unknown/, "an unanswered tmux probe holds, never types");
    assert.equal(sinkText(unanswered), "");

    copyMode(copy, false);
    writeFileSync(dialog.flag, "");
    writeFileSync(typing.flag, "");
    await sleep(300);
    for (const cleared of [dialog, typing]) execFileSync("tmux", ["clear-history", "-t", cleared.pane]);
    await tick();
    await tick();
    for (const [index, [target]] of expectations.slice(0, 4).entries()) {
      assert.ok(
        await until(() => sinkText(target).includes(`held for ${target.name}`), 3000),
        `${target.name}: ${JSON.stringify(message(ids[index]))}`,
      );
      assert.equal(markerCount(sinkText(target), ids[index]), 1, target.name);
      assert.equal(message(ids[index]).delivery_status, "complete", target.name);
    }
    assert.equal(sinkText(noPid), "", "a row whose pid was never recorded stays unknown and is never typed into");
    assert.equal(message(ids[4]).delivery_status, "fallback-pending");
  });

  it("a wake-pane lease another delivery holds keeps the fallback off the pane until it is released", needsTmux, async () => {
    const proj = project(true);
    const target = lead(proj.id, { socket: refusedSocket() });
    const from = worker(proj.id);
    db.prepare("INSERT OR IGNORE INTO actors (id, name, kind) VALUES ('hive:scheduler', 'hive scheduler', 'scheduler')").run();
    db.prepare(
      "INSERT INTO leases (project_id, lock_key, owner, expires_at) VALUES (?, ?, 'hive:scheduler', datetime('now', '+60 seconds'))",
    ).run(proj.id, `wake-pane:${ownSocket}:${target.pane}`);

    const receipt = await send(proj.id, from, target, "waits for the lease");
    assert.equal(receipt.sent, false);
    assert.equal(receipt.pending, true);
    assert.match(message(receipt.message_id).delivery_note, /another delivery holds the lead's pane/);
    await tick();
    await sleep(300);
    assert.equal(sinkText(target), "", "nothing is pasted while a wake holds the pane");

    db.prepare("DELETE FROM leases WHERE project_id = ?").run(proj.id);
    await tick();
    assert.ok(await until(() => sinkText(target).includes("waits for the lease"), 3000));
    assert.equal(markerCount(sinkText(target), receipt.message_id), 1);
  });

  it("a registration change between the row update and the connect refuses the post and types once instead", needsTmux, async () => {
    const proj = project(true);
    const sock = listener();
    const target = lead(proj.id, { socket: sock.path });
    const from = worker(proj.id);
    const pending = send(proj.id, from, target, "registration moved");
    db.prepare("UPDATE agents SET claude_messaging_socket = ? WHERE id = ?").run(refusedSocket(), target.rowId);
    const receipt = await pending;
    await sleep(300);
    assert.deepEqual(sock.received.filter((frame) => frame !== ""), [], "the connect is dropped before any byte is written");
    assert.equal(receipt.delivery_method, "pty-after-socket-timeout");
    assert.ok(await until(() => sinkText(target).includes("registration moved"), 3000));
    assert.equal(markerCount(sinkText(target), receipt.message_id), 1);
  });

  it("socket delivery bypasses pending human input unchanged", needsTmux, async () => {
    const proj = project(true);
    const sock = listener();
    const typing = lead(proj.id, { socket: sock.path, fixture: "real-input.txt" });
    const from = worker(proj.id);
    await sleep(300);
    const receipt = await send(proj.id, from, typing, "posted past the box");
    assert.equal(receipt.delivery_method, "socket");
    assert.ok(await until(() => sock.received.length === 1, 3000));
    writeFileSync(typing.flag, "");
    await sleep(300);
    assert.equal(sinkText(typing), "", "the human's box is untouched");
  });

  it("restarted or closed target fails without typing into a replacement", needsTmux, async () => {
    const proj = project(true);
    const from = worker(proj.id);
    const restarted = lead(proj.id, { socket: refusedSocket() });
    const closed = lead(proj.id, { socket: refusedSocket() });
    copyMode(restarted, true);
    copyMode(closed, true);
    const a = await send(proj.id, from, restarted, "for the old pane");
    const b = await send(proj.id, from, closed, "for a closed lead");
    const epoch = message(a.message_id).target_identity;

    const replacement = sinkPane();
    db.prepare("UPDATE agents SET tmux_target = ?, pane_pid = ? WHERE id = ?").run(replacement.pane, replacement.pid, restarted.rowId);
    db.prepare("UPDATE agents SET status = 'closed' WHERE id = ?").run(closed.rowId);
    copyMode(restarted, false);
    copyMode(closed, false);
    await tick();
    await tick();
    await sleep(400);

    assert.equal(message(a.message_id).delivery_status, "failed");
    assert.match(message(a.message_id).delivery_note, /nothing is typed into a replacement/);
    assert.equal(message(a.message_id).target_identity, epoch, "the accepted epoch is never rewritten");
    assert.equal(message(b.message_id).delivery_status, "failed");
    assert.equal(readFileSync(replacement.sink, "utf8"), "", "zero bytes into the replacement pane");
    assert.equal(sinkText(restarted), "");
    assert.equal(sinkText(closed), "");
  });

  it("two pending sends from one worker fall back in id order", needsTmux, async () => {
    const proj = project(true);
    const target = lead(proj.id, { socket: refusedSocket() });
    const from = worker(proj.id);
    copyMode(target, true);
    const first = await send(proj.id, from, target, "first report");
    copyMode(target, false);
    const second = await send(proj.id, from, target, "second report");
    assert.equal(second.sent, false, "the later message waits behind the earlier one");
    assert.match(message(second.message_id).delivery_note, /earlier message/);

    await tick();
    assert.ok(await until(() => sinkText(target).includes("second report"), 4000), sinkText(target));
    const typed = sinkText(target);
    assert.ok(typed.indexOf(`[message #${first.message_id},`) < typed.indexOf(`[message #${second.message_id},`));
    await tick();
    await sleep(300);
    assert.equal(markerCount(sinkText(target), first.message_id), 1);
    assert.equal(markerCount(sinkText(target), second.message_id), 1);
  });

  it("fallback paste ambiguity is recorded and never pasted again", needsTmux, async () => {
    const proj = project(true);
    const from = worker(proj.id);
    const target = lead(proj.id, { socket: refusedSocket() });

    const outcome = send(proj.id, from, target, "pasted then the pane died").then(
      () => null,
      (err) => err,
    );
    assert.ok(await until(() => screen(target).includes("pasted then the pane died"), 3000), "the paste landed");
    execFileSync("tmux", ["kill-pane", "-t", target.pane]);
    assert.match((await outcome)?.message ?? "", /\[agent_send:quiet-fallback-failed\][^]*hive will not type it again/);
    const failed = db.prepare("SELECT * FROM agent_messages ORDER BY id DESC LIMIT 1").get();
    assert.equal(failed.delivery_status, "failed");
    assert.match(failed.delivery_note, /pasted, then the Enter was withheld/);
    assert.ok(failed.typed_at, "the paste is recorded");

    const crashed = lead(proj.id);
    const { id: crashedId } = db
      .prepare(
        `INSERT INTO agent_messages (project_id, from_actor, from_name, to_agent_id, text, delivery_status, delivery_method,
           socket_attempt_at, fallback_claimed_at, target_identity, sender_tag)
         VALUES (?, ?, 'w', ?, 'claimed before a crash', 'fallback-claimed', 'pty-after-socket-timeout',
           strftime('%Y-%m-%d %H:%M:%f', 'now', '-300 seconds'), strftime('%Y-%m-%d %H:%M:%f', 'now', '-200 seconds'), ?, ?)
         RETURNING id`,
      )
      .get(proj.id, from.actorId, crashed.rowId, JSON.stringify({ tmux_target: crashed.pane, tmux_socket: ownSocket, pane_pid: crashed.pid }), from.tag);
    await tick();
    await tick();
    await sleep(300);
    assert.equal(sinkText(crashed), "", "a claimed fallback is never pasted a second time");
    assert.equal(message(crashedId).delivery_status, "fallback-claimed", "and it is never labelled complete");
    assert.equal(message(failed.id).delivery_status, "failed");
  });

  it("failed-post fallback survives sender process exit", needsTmux, async () => {
    const proj = project(true);
    const target = lead(proj.id, { socket: refusedSocket() });
    const from = worker(proj.id);
    const client = await mcpAs(proj, from.actorId);
    copyMode(target, true);
    const receipt = await client.call("agent_send", { name: target.name, text: "outlives its sender" });
    assert.equal(receipt.sent, false);
    assert.equal(receipt.pending, true);
    assert.equal(receipt.delivery_method, "pty-after-socket-timeout");
    await client.close();
    clients.splice(clients.indexOf(client), 1);

    copyMode(target, false);
    await tick();
    assert.ok(await until(() => sinkText(target).includes("outlives its sender"), 3000));
    await tick();
    await sleep(300);
    assert.equal(markerCount(sinkText(target), receipt.message_id), 1);
    assert.equal(message(receipt.message_id).delivery_status, "complete");
  });
});

describe("delivery rows keep the message store's retention and lookup contract", () => {
  it("message retention and lookup miss taxonomy remain unchanged", needsTmux, async () => {
    const proj = project(true);
    const sock = listener();
    const target = lead(proj.id, { socket: sock.path });
    const from = worker(proj.id);
    const old = await send(proj.id, from, target, "expires");
    const ranged = await send(proj.id, from, target, "pushed out of the id range");
    db.prepare("UPDATE agent_messages SET created_at = datetime('now', '-8 days') WHERE id = ?").run(old.message_id);
    db.prepare(
      "INSERT INTO agent_messages (id, project_id, from_actor, from_name, to_agent_id, text) VALUES (?, ?, 'x', 'x', 1, 'newest')",
    ).run(ranged.message_id + 5000, proj.id);
    await tick();
    assert.equal(message(old.message_id), undefined, "a delivery row expires with the retention bound");
    assert.equal(message(ranged.message_id), undefined, "and is trimmed by the id-range backstop");

    const other = project(true);
    const { id: foreign } = db
      .prepare("INSERT INTO agent_messages (project_id, from_actor, from_name, to_agent_id, text, delivery_status) VALUES (?, 'x', 'x', 1, 'elsewhere', 'complete') RETURNING id")
      .get(other.id);
    const client = await mcpAs(proj, from.actorId);
    await assert.rejects(client.call("agent_message_get", { message_id: old.message_id }), /\[agent_message_get:pruned\]/);
    await assert.rejects(client.call("agent_message_get", { message_id: foreign + 100_000 }), /\[agent_message_get:never-issued\]/);
    await assert.rejects(client.call("agent_message_get", { message_id: foreign }), /\[agent_message_get:other-project\]/);
  });
});

describe("the retry pass contains its own failures", () => {
  it("an unreadable accepted target identity fails its row and the next row still delivers", needsTmux, async () => {
    const proj = project(true);
    const from = worker(proj.id);
    const broken = lead(proj.id);
    const target = lead(proj.id);
    db.prepare(
      `INSERT INTO agent_messages (project_id, from_actor, from_name, to_agent_id, text, delivery_status, delivery_method,
         target_identity, sender_tag)
       VALUES (?, ?, 'w', ?, 'broken', 'fallback-pending', 'pty', 'not json', ?)`,
    ).run(proj.id, from.actorId, broken.rowId, from.tag);
    const { id } = db
      .prepare(
        `INSERT INTO agent_messages (project_id, from_actor, from_name, to_agent_id, text, delivery_status, delivery_method,
           target_identity, sender_tag)
         VALUES (?, ?, 'w', ?, 'still delivered', 'fallback-pending', 'pty', ?, ?) RETURNING id`,
      )
      .get(proj.id, from.actorId, target.rowId, JSON.stringify({ tmux_target: target.pane, tmux_socket: ownSocket, pane_pid: target.pid }), from.tag);
    await retryQuietLeadMessages(liveTargets());
    assert.ok(await until(() => sinkText(target).includes("still delivered"), 3000));
    assert.equal(message(id).delivery_status, "complete");
    assert.equal(db.prepare("SELECT delivery_status FROM agent_messages WHERE text = 'broken'").get().delivery_status, "failed");
  });
});
