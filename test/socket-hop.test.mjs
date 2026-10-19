import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";

import { assertScratchStore, clearHiveEnv, scratchDirs, until } from "./helpers.mjs";

const { dataDir } = scratchDirs();
clearHiveEnv();
process.env.HIVE_DATA_DIR = dataDir;
const { db, migrate } = await import("../dist/db.js");
await assertScratchStore();
const wakeTransport = await import("../dist/claudeWake.js");
const { humanPromptSql, isHumanPrompt } = await import("../dist/leadState.js");
migrate();

const literal = (value) => `'${value.replaceAll("'", "''")}'`;
const wakeMarker = "[hive wake #42 firing #3";
const messageMarker = "[hive:worker Ada] [message #17, 23 chars]";
const wakeMarkerAt = (prompt, start) =>
  `substr(${prompt}, ${start}, length(${literal(wakeMarker)}) + 1) IN (${literal(wakeMarker)} || ']', ${literal(wakeMarker)} || ',')`;
const messageMarkerAt = (prompt, start) =>
  `substr(${prompt}, ${start}, length(${literal(messageMarker)})) = ${literal(messageMarker)}`;
const evaluateEnvelopeEvidence = (markerAt, payload) =>
  db.prepare(`SELECT ${wakeTransport.promptMarkerEvidenceSql(markerAt)} AS hit FROM (SELECT ? AS payload) ev`).get(payload).hit === 1;
const evaluateConversationSql = (prompt) =>
  db.prepare(`SELECT ${humanPromptSql("payload")} AS human FROM (SELECT ? AS payload)`).get(prompt).human === 1;

describe("shared socket hop", () => {
  it("socket protocol pins the shipped frame and literals", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hvs-"));
    const path = join(dir, "receiver.sock");
    const frames = [];
    const server = createServer((connection) => {
      let wire = "";
      connection.on("data", (chunk) => (wire += chunk));
      connection.on("end", () => frames.push(wire));
    });
    try {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(path, resolve);
      });
      const sender = wakeTransport.senderAddress("/tmp/socket hop/é.sock");
      assert.equal(sender, "uds:/tmp/socket%20hop/%C3%A9.sock");
      assert.equal(wakeTransport.socketSenderAddress("/tmp/socket hop"), "uds:/tmp/socket%20hop/wake-sender.sock");
      assert.equal(wakeTransport.SOCKET_CONFIRM_GRACE_SECONDS, 60);
      assert.equal(wakeTransport.SOCKET_WRITE_BOUND_MS, 1000);
      assert.equal(wakeTransport.SOCKET_WAKE_FOOTER, "Automated hive wake. Do not reply to this sender.");
      assert.equal(wakeTransport.SOCKET_MESSAGE_FOOTER, "Automated hive worker message. Do not reply to this socket sender.");

      assert.equal(await wakeTransport.postClaudeWake({ socketPath: path, senderAddress: sender, text: "WAKE BODY\n\nAutomated hive wake. Do not reply to this sender.", beforeWrite: () => true }), true);
      assert.ok(await until(() => frames.length === 1, 1000));
      assert.equal(frames[0], '{"type":"user","from":"uds:/tmp/socket%20hop/%C3%A9.sock","message":{"role":"user","content":"<cross-session-message from=\\"uds:/tmp/socket%20hop/%C3%A9.sock\\" from-name=\\"hive\\">\\nWAKE BODY\\n\\nAutomated hive wake. Do not reply to this sender.\\n</cross-session-message>"}}\n');

      assert.equal(await wakeTransport.postClaudeWake({ socketPath: path, senderAddress: sender, text: "MESSAGE BODY\n\nAutomated hive worker message. Do not reply to this socket sender.", beforeWrite: () => true }), true);
      assert.ok(await until(() => frames.length === 2, 1000));
      assert.equal(frames[1], '{"type":"user","from":"uds:/tmp/socket%20hop/%C3%A9.sock","message":{"role":"user","content":"<cross-session-message from=\\"uds:/tmp/socket%20hop/%C3%A9.sock\\" from-name=\\"hive\\">\\nMESSAGE BODY\\n\\nAutomated hive worker message. Do not reply to this socket sender.\\n</cross-session-message>"}}\n');
    } finally {
      await new Promise((resolve) => server.close(resolve));
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("shared envelope evidence preserves both exact marker forms", () => {
    const wakeTyped = `${wakeMarker}] wake text`;
    const messageTyped = `${messageMarker} message text`;
    const wakeEnvelope = `<cross-session-message from="uds:sender" from-name="hive">\n${wakeMarker}, wake text\n</cross-session-message>`;
    const messageEnvelope = `<cross-session-message from="uds:sender" from-name="hive">\n${messageMarker} message text\n</cross-session-message>`;
    const wakeCases = [
      [wakeTyped, true],
      [JSON.stringify({ prompt: wakeTyped }), true],
      [wakeEnvelope, true],
      [JSON.stringify({ prompt: wakeEnvelope }), true],
      [`quoted ${wakeTyped}`, false],
      [`first line\n${wakeTyped}`, false],
      [wakeEnvelope.replace("#42 firing #3", "#43 firing #3"), false],
      [wakeEnvelope.replace("from-name=\"hive\"", "from-name=\"peer\""), false],
      [wakeEnvelope.replace("uds:sender", 'uds:sen"der'), false],
      [wakeEnvelope.replace("</cross-session-message>", ""), false],
      [JSON.stringify({ content: wakeEnvelope }), false],
    ];
    const messageCases = [
      [messageTyped, true],
      [JSON.stringify({ prompt: messageTyped }), true],
      [messageEnvelope, true],
      [JSON.stringify({ prompt: messageEnvelope }), true],
      [`quoted ${messageTyped}`, false],
      [`first line\n${messageTyped}`, false],
      [messageEnvelope.replace("#17,", "#18,"), false],
      [messageEnvelope.replace("from-name=\"hive\"", "from-name=\"peer\""), false],
      [messageEnvelope.replace("uds:sender", 'uds:sen"der'), false],
      [messageEnvelope.replace("</cross-session-message>", ""), false],
      [JSON.stringify({ content: messageEnvelope }), false],
    ];
    for (const [payload, expected] of wakeCases) assert.equal(evaluateEnvelopeEvidence(wakeMarkerAt, payload), expected, payload);
    for (const [payload, expected] of messageCases) assert.equal(evaluateEnvelopeEvidence(messageMarkerAt, payload), expected, payload);
  });

  it("conversation envelope matching keeps its broader legacy grammar", () => {
    const valid = `<cross-session-message from="uds:sender" from-name="hive">\n[hive:worker Ada] [message #17, 23 chars] body\n</cross-session-message>`;
    const cases = [
      [valid, false],
      [valid.toUpperCase(), false],
      [valid.replace("uds:sender", 'uds:sen"der'), false],
      [valid.replace("body", "first line\nsecond line"), false],
      [valid.replace('from-name="hive"', 'from-name="peer"'), true],
      [`Human quoted this: ${valid}`, true],
      ["a regular human prompt", true],
    ];
    for (const [prompt, expectedHuman] of cases) {
      assert.equal(isHumanPrompt(prompt), expectedHuman, prompt);
      assert.equal(evaluateConversationSql(prompt), expectedHuman, prompt);
    }
  });

  it("socket grace keeps the first stop, same-pane work and the 60 second boundary", () => {
    const actor = "agent:socket-grace";
    db.prepare("INSERT INTO actors (id, name, kind) VALUES (?, ?, 'agent')").run(actor, actor);
    const attempt = db.prepare("SELECT datetime('now', '-90 seconds') AS value").get().value;
    const before = db.prepare("SELECT datetime(?, '-10 seconds') AS value").get(attempt).value;
    const first = db.prepare("SELECT datetime(?, '+30 seconds') AS value").get(attempt).value;
    const later = db.prepare("SELECT datetime(?, '+70 seconds') AS value").get(attempt).value;
    db.prepare("INSERT INTO agent_state_log (actor_id, event, state, payload, created_at) VALUES (?, 'stop', 'idle', '', ?)").run(actor, before);
    db.prepare("INSERT INTO agent_state_log (actor_id, event, state, payload, created_at) VALUES (?, 'stop', 'idle', '', ?)").run(actor, later);
    db.prepare("INSERT INTO agent_state_log (actor_id, event, state, payload, created_at) VALUES (?, 'stop', 'idle', '', ?)").run(actor, first);
    let readTurnCalls = 0;
    assert.equal(wakeTransport.socketGraceDue(actor, attempt, "pane-a", () => {
      readTurnCalls += 1;
      return { state: "working", pane_pid: "pane-a" };
    }), true, "the 60-second-old first stop wins over the later 20-second-old stop");
    assert.equal(readTurnCalls, 0, "turn state is not read when a stop exists");

    db.prepare("DELETE FROM agent_state_log WHERE actor_id = ?").run(actor);
    const oldAttempt = db.prepare("SELECT datetime('now', '-90 seconds') AS value").get().value;
    assert.equal(wakeTransport.socketGraceDue(actor, oldAttempt, "pane-a", () => ({ state: "working", pane_pid: "pane-a" })), false);
    assert.equal(wakeTransport.socketGraceDue(actor, oldAttempt, "pane-a", () => ({ state: "working", pane_pid: "pane-b" })), true);
    assert.equal(wakeTransport.socketGraceDue(actor, oldAttempt, "pane-a", () => ({ state: "idle", pane_pid: "pane-a" })), true);
    assert.equal(wakeTransport.socketGraceDue(actor, oldAttempt, "pane-a", () => null), true);
    const youngAttempt = db.prepare("SELECT datetime('now', '-30 seconds') AS value").get().value;
    assert.equal(wakeTransport.socketGraceDue(actor, youngAttempt, "pane-a", () => ({ state: "idle", pane_pid: "pane-a" })), false);

    const source = readFileSync(new URL("../dist/claudeWake.js", import.meta.url), "utf8");
    assert.match(source, /event = 'stop' AND created_at >= \?/);
    assert.match(source, /julianday\('now'\) - julianday\(\?\).*>= \?/s);
  });
});
