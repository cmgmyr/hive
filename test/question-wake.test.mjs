import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { after, afterEach, before, describe, it } from "node:test";

import { assertScratchStore, clearHiveEnv, DIST, isolateTmux, McpClient, raceProcesses, scratchDirs, until } from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("the question answer wake tests");
const skip = !hasTmux && "tmux is not installed";
const dirs = scratchDirs();

clearHiveEnv();
process.env.HIVE_DATA_DIR = dirs.dataDir;
await assertScratchStore();

const { db, migrate } = await import("../dist/db.js");
const { tick } = await import("../dist/scheduler.js");
const { tmuxSocketPath } = await import("../dist/tmux.js");
const { answerQuestion, answerWakeBody } = await import("../dist/questions.js");
migrate();

const OWN_SOCKET = tmuxSocketPath(process.env.TMUX, process.env.TMUX_TMPDIR);
const tmuxRun = (...args) => execFileSync("tmux", args, { encoding: "utf8" }).trim();
const screen = (target) => tmuxRun("capture-pane", "-p", "-J", "-t", target);
const sessions = [];
let seq = 0;

function pane() {
  const session = `question-wake-${process.pid}-${seq++}`;
  execFileSync("tmux", ["new-session", "-d", "-s", session, "cat"], { stdio: "ignore" });
  sessions.push(session);
  const id = tmuxRun("list-panes", "-t", `=${session}`, "-F", "#{pane_id}");
  return { id, pid: tmuxRun("display-message", "-p", "-t", id, "#{pane_pid}") };
}

const project = db
  .prepare("INSERT INTO projects (name, path) VALUES ('question-wake', ?) RETURNING id")
  .get(dirs.projectDir).id;

function agentRow(actor, p = pane(), status = "running") {
  db.prepare("INSERT OR IGNORE INTO actors (id, name, kind) VALUES (?, ?, 'agent')").run(actor, actor);
  const id = db
    .prepare(
      `INSERT INTO agents (project_id, actor_id, name, kind, tmux_target, tmux_socket, pane_pid, command, cwd, status,
         agent_state, state_changed_at, created_at)
       VALUES (?, ?, ?, 'agent', ?, ?, ?, 'claude', '/tmp', ?, 'working', datetime('now', '-30 seconds'),
         datetime('now', '-60 seconds')) RETURNING id`,
    )
    .get(project, actor, `${actor}-${seq++}`, p.id, OWN_SOCKET, p.pid, status).id;
  return { id, pane: p };
}

function seedQuestion(asker, agentId, over = {}) {
  return db
    .prepare(
      `INSERT INTO questions (project_id, asker, kind, question, header, default_answer, updated_by, state)
       VALUES (?, ?, 'free_text', ?, 'Probe', 'the default', ?, ?) RETURNING id`,
    )
    .get(project, asker, over.question ?? "Which name should the release carry?", asker, over.state ?? "pending").id;
}

const questionRow = (id) => db.prepare("SELECT * FROM questions WHERE id = ?").get(id);
const wakesFor = (id) => db.prepare("SELECT * FROM wakes WHERE body LIKE ? ORDER BY id").all(`Question #${id} answered.%`);
const refused = (fn) => {
  try {
    fn();
  } catch (e) {
    return e.message;
  }
  assert.fail("should have been refused");
};

afterEach(() => db.exec("DROP TRIGGER IF EXISTS fail_wake_insert"));
after(() => cleanup(...sessions));

describe("answering a question wakes its asker", () => {
  it("answer and one asker wake commit together", { skip }, () => {
    const asker = agentRow("agent:wake-asker");
    const id = seedQuestion("agent:wake-asker", asker.id);
    const receipt = answerQuestion(project, "user:human", id, "Falcon", "Because it is short");
    assert.deepEqual(Object.keys(receipt).sort(), ["question_id", "wake_id"]);
    const q = questionRow(id);
    assert.equal(q.state, "answered");
    assert.equal(q.answer, "Falcon");
    assert.equal(q.notes, "Because it is short");
    assert.equal(q.answered_by, "user:human");
    const wakes = wakesFor(id);
    assert.equal(wakes.length, 1);
    const [w] = wakes;
    assert.equal(w.id, receipt.wake_id);
    assert.equal(w.deliver_actor, "agent:wake-asker");
    assert.equal(w.deliver_pane, asker.pane.id);
    assert.equal(w.kind, "delay");
    assert.equal(w.repeat_every_ms, null);
    assert.equal(w.watch, "[]");
    assert.equal(w.parent_wake_id, null);
    assert.equal(w.body, answerWakeBody(id, q.question, "Falcon", "Because it is short"));
    assert.equal(w.body, `Question #${id} answered.\nQuestion: Which name should the release carry?\nAnswer: Falcon\nNotes: Because it is short`);
  });

  it("answer wake reaches the asking pane with its body intact", { skip }, async () => {
    const asker = agentRow("agent:wake-screen");
    const id = seedQuestion("agent:wake-screen", asker.id, { question: "Pick the rollout order for the three regions?" });
    const notes = "First line of notes\n  indented second line\nThird line, with a [bracket] and a $dollar";
    const { wake_id } = answerQuestion(project, "user:human", id, "Region B first", notes);
    await tick();
    const stored = db.prepare("SELECT body, fire_count FROM wakes WHERE id = ?").get(wake_id);
    assert.equal(stored.fire_count, 1);
    const lines = stored.body.split("\n").map((l) => l.trimEnd());
    await until(() => lines.every((l) => l === "" || screen(asker.pane.id).includes(l)), 4000);
    const shown = screen(asker.pane.id);
    let at = 0;
    for (const line of lines.filter((l) => l !== "")) {
      const found = shown.indexOf(line, at);
      assert.ok(found >= at, `line ${JSON.stringify(line)} missing or out of order on the asker's screen:\n${shown}`);
      at = found + line.length;
    }
    await tick();
    assert.equal(db.prepare("SELECT fire_count FROM wakes WHERE id = ?").get(wake_id).fire_count, 1, "typed once");
  });

  it("a defaulted question can be answered as a reversal", { skip }, () => {
    const asker = agentRow("agent:wake-reverse");
    const id = seedQuestion("agent:wake-reverse", asker.id, { state: "defaulted" });
    const receipt = answerQuestion(project, "user:human", id, "Reverse it");
    assert.equal(questionRow(id).state, "answered");
    assert.equal(wakesFor(id).length, 1);
    assert.equal(receipt.wake_id, wakesFor(id)[0].id);
  });

  it("an answer recorded by the asker queues no wake", { skip }, () => {
    const asker = agentRow("agent:wake-self");
    const id = seedQuestion("agent:wake-self", asker.id);
    const before = db.prepare("SELECT COUNT(*) AS n FROM wakes").get().n;
    const receipt = answerQuestion(project, "agent:wake-self", id, "The human picked B");
    assert.deepEqual(receipt, { question_id: id, wake_id: null, wake_skipped: "answered by the asker" });
    assert.equal(questionRow(id).state, "answered");
    assert.equal(questionRow(id).answer, "The human picked B");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM wakes").get().n, before);
  });

  it("an unreachable asker never loses the answer", { skip }, () => {
    const closed = agentRow("agent:wake-closed", pane(), "closed");
    const idClosed = seedQuestion("agent:wake-closed", closed.id);
    const noAgent = seedQuestion("agent:wake-no-row", 999999);
    const deadPane = agentRow("agent:wake-dead");
    execFileSync("tmux", ["kill-pane", "-t", deadPane.pane.id], { stdio: "ignore" });
    const idDead = seedQuestion("agent:wake-dead", deadPane.id);
    const before = db.prepare("SELECT COUNT(*) AS n FROM wakes").get().n;
    for (const id of [idClosed, noAgent, idDead]) {
      const receipt = answerQuestion(project, "user:human", id, "Answer survives");
      assert.equal(receipt.wake_id, null, `question ${id}`);
      assert.equal(typeof receipt.wake_skipped, "string");
      assert.ok(receipt.wake_skipped.length > 0);
      assert.equal(questionRow(id).state, "answered");
      assert.equal(questionRow(id).answer, "Answer survives");
    }
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM wakes").get().n, before);
  });

  it("the wake follows the asker's current pane, not the pane it asked from", { skip }, () => {
    const first = agentRow("agent:wake-moved");
    const id = seedQuestion("agent:wake-moved", first.id);
    db.prepare("UPDATE agents SET status = 'closed' WHERE id = ?").run(first.id);
    const second = agentRow("agent:wake-moved");
    const { wake_id } = answerQuestion(project, "user:human", id, "Delivered after a restart");
    const w = db.prepare("SELECT deliver_pane, deliver_actor FROM wakes WHERE id = ?").get(wake_id);
    assert.equal(w.deliver_pane, second.pane.id);
    assert.notEqual(w.deliver_pane, first.pane.id);
    assert.equal(w.deliver_actor, "agent:wake-moved");
  });

  it("invalid or repeated answers neither change state nor enqueue", { skip }, () => {
    const asker = agentRow("agent:wake-invalid");
    const id = seedQuestion("agent:wake-invalid", asker.id);
    const snapshot = () => JSON.stringify([questionRow(id), db.prepare("SELECT COUNT(*) AS n FROM wakes").get().n]);
    const before = snapshot();
    for (const bad of ["", "   ", "bell\u0007"]) {
      refused(() => answerQuestion(project, "user:human", id, bad));
      assert.equal(snapshot(), before);
    }
    refused(() => answerQuestion(project, "user:human", id, "fine", "note with \u001b escape"));
    assert.equal(snapshot(), before);

    answerQuestion(project, "user:human", id, "First");
    const afterFirst = snapshot();
    assert.match(refused(() => answerQuestion(project, "user:human", id, "Second")), /QUESTION_STATE_CONFLICT/);
    assert.equal(snapshot(), afterFirst);

    const withdrawn = seedQuestion("agent:wake-invalid", asker.id, { state: "withdrawn" });
    const frozen = JSON.stringify(questionRow(withdrawn));
    assert.match(refused(() => answerQuestion(project, "user:human", withdrawn, "late")), /QUESTION_STATE_CONFLICT/);
    assert.equal(JSON.stringify(questionRow(withdrawn)), frozen);

    const other = db.prepare("INSERT INTO projects (name, path) VALUES ('question-wake-other', ?) RETURNING id").get(`${dirs.projectDir}-x`).id;
    assert.match(refused(() => answerQuestion(other, "user:human", seedQuestion("agent:wake-invalid", asker.id), "cross")), /No question/);
  });

  it("failed wake insertion rolls the answer back", { skip }, () => {
    const asker = agentRow("agent:wake-rollback");
    const id = seedQuestion("agent:wake-rollback", asker.id);
    db.exec("CREATE TRIGGER fail_wake_insert BEFORE INSERT ON wakes BEGIN SELECT RAISE(ABORT, 'wake insert refused'); END");
    assert.match(refused(() => answerQuestion(project, "user:human", id, "Will not stick")), /wake insert refused/);
    const q = questionRow(id);
    assert.equal(q.state, "pending");
    assert.equal(q.answer, null);
    assert.equal(q.answered_by, null);
  });
});

describe("two processes racing", () => {
  it("concurrent ref asks converge and concurrent answers wake once", { skip }, async () => {
    const asker = agentRow("agent:race-asker");
    const script = `
const { askQuestion, answerQuestion } = await import(${JSON.stringify(`file://${join(DIST, "questions.js")}`)});
const [mode, a, b] = process.argv.slice(2);
try {
  const out = mode === "ask"
    ? askQuestion(Number(a), process.env.HIVE_AGENT_ID, { kind: "free_text", question: "Race question " + b, header: "Race", default_answer: "d", ref: { kind: "todo", number: 4242 } })
    : answerQuestion(Number(a), "user:racer-" + b, Number(b.split("-")[0]), "answer " + b);
  console.log(JSON.stringify({ ok: out }));
} catch (e) {
  console.log(JSON.stringify({ error: e.message }));
}
`;
    const env = { HIVE_DATA_DIR: dirs.dataDir, HIVE_AGENT_ID: "agent:race-asker", TMUX_TMPDIR: process.env.TMUX_TMPDIR };
    const asks = await raceProcesses(script, [0, 1, 2, 3].map((i) => ["ask", String(project), String(i)]), { env });
    assert.ok(asks.every((r) => r.ok), JSON.stringify(asks));
    assert.equal(asks.filter((r) => r.ok.created).length, 1, "exactly one ask created the row");
    assert.equal(new Set(asks.map((r) => r.ok.question_id)).size, 1);
    assert.equal(
      db.prepare("SELECT COUNT(*) AS n FROM questions WHERE project_id = ? AND ref_kind = 'todo' AND ref_number = 4242 AND state = 'pending'").get(project).n,
      1,
    );

    const id = asks[0].ok.question_id;
    const answers = await raceProcesses(script, [0, 1, 2, 3].map((i) => ["answer", String(project), `${id}-${i}`]), { env });
    const won = answers.filter((r) => r.ok);
    const lost = answers.filter((r) => r.error);
    assert.equal(won.length, 1, JSON.stringify(answers));
    assert.equal(lost.length, 3);
    assert.ok(lost.every((r) => /QUESTION_STATE_CONFLICT/.test(r.error)));
    assert.equal(won[0].ok.wake_id !== null, true);
    assert.equal(wakesFor(id).length, 1, "one wake for one committed answer");
    assert.equal(questionRow(id).state, "answered");
    assert.equal(asker.id > 0, true);
  });
});

describe("end to end over MCP", () => {
  let mcpAsker;
  let mcpHuman;
  before(async () => {
    if (!hasTmux) return;
    agentRow("agent:mcp-asker");
    mcpAsker = new McpClient({ cwd: dirs.projectDir, dataDir: dirs.dataDir, env: { HIVE_AGENT_ID: "agent:mcp-asker" } });
    mcpHuman = new McpClient({ cwd: dirs.projectDir, dataDir: dirs.dataDir });
    await mcpAsker.start();
    await mcpHuman.start();
  });
  after(async () => {
    await mcpAsker?.close();
    await mcpHuman?.close();
  });

  it("a human's question_answer queues the asker's wake with the stored body", { skip }, async () => {
    const { question_id } = await mcpAsker.call("question_ask", {
      kind: "choice",
      question: "Ship the migration tonight?",
      header: "Migration",
      options: [
        { label: "Tonight", description: "Ship now", recommended: true },
        { label: "Later", description: "Wait for review", recommended: false },
      ],
      default_answer: "Tonight",
    });
    const receipt = await mcpHuman.call("question_answer", { question_id, answer: "Something else entirely", notes: "line one\nline two" });
    assert.equal(typeof receipt.wake_id, "number");
    assert.equal(receipt.wake_skipped, undefined);
    const got = await mcpAsker.call("question_get", { question_id });
    assert.equal(got.state, "answered");
    assert.equal(got.answer, "Something else entirely", "an answer outside the offered labels is kept");
    const body = db.prepare("SELECT body FROM wakes WHERE id = ?").get(receipt.wake_id).body;
    assert.equal(body, answerWakeBody(question_id, "Ship the migration tonight?", "Something else entirely", "line one\nline two"));
    const self = await mcpAsker.call("question_ask", { kind: "free_text", question: "Self answered question probe?", header: "Self", default_answer: "x" });
    const selfReceipt = await mcpAsker.call("question_answer", { question_id: self.question_id, answer: "picked" });
    assert.deepEqual(selfReceipt, { question_id: self.question_id, wake_id: null, wake_skipped: "answered by the asker" });
  });
});
