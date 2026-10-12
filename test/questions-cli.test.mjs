import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { after, afterEach, describe, it } from "node:test";

import { assertScratchStore, clearHiveEnv, isolateTmux, McpClient, runCli, scratchDirs } from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("the questions CLI tests");
const tmuxSkip = !hasTmux && "tmux is not installed";
const scratchSessions = [];
const dirs = scratchDirs();
clearHiveEnv();
process.env.HIVE_DATA_DIR = dirs.dataDir;
await assertScratchStore();

const { db, migrate } = await import("../dist/db.js");
const { observeRowOwnership, tmuxSocketPath } = await import("../dist/tmux.js");
const { addProject, HUMAN_ACTOR_PREFIX } = await import("../dist/context.js");
migrate();
const project = addProject(dirs.projectDir);

function insertQuestion(overrides = {}) {
  const row = db
    .prepare(
      `INSERT INTO questions (project_id, asker, kind, question, header, options, default_answer, state, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    )
    .get(
      overrides.project_id ?? project.id,
      overrides.asker ?? "agent:unreachable",
      overrides.kind ?? "choice",
      overrides.question ?? "Which route should the release take?",
      overrides.header ?? "Route",
      overrides.options === undefined
        ? JSON.stringify([
            { label: "North", description: "Ship to the northern region first.", recommended: true },
            { label: "South", description: "Ship to the southern region first.", recommended: false },
          ])
        : overrides.options,
      overrides.default_answer ?? "North",
      overrides.state ?? "pending",
      overrides.asker ?? "agent:unreachable",
    );
  return row.id;
}

after(() => cleanup(...scratchSessions));
afterEach(() => db.prepare("UPDATE agents SET status = 'closed' WHERE project_id = ? AND kind = 'lead'").run(project.id));

function makeAskingAgent(actor) {
  const session = `questions-cli-${process.pid}-${scratchSessions.length}`;
  execFileSync("tmux", ["new-session", "-d", "-s", session, "cat"], { stdio: "ignore" });
  scratchSessions.push(session);
  const pane = execFileSync("tmux", ["list-panes", "-t", `=${session}`, "-F", "#{pane_id}"], {
    encoding: "utf8",
  }).trim();
  const panePid = execFileSync("tmux", ["display-message", "-p", "-t", pane, "#{pane_pid}"], {
    encoding: "utf8",
  }).trim();
  db.prepare("INSERT OR IGNORE INTO actors (id, name, kind) VALUES (?, ?, 'agent')").run(actor, actor);
  db.prepare(
    `INSERT INTO agents (project_id, actor_id, name, kind, tmux_target, tmux_socket, pane_pid, command, cwd, status,
       agent_state, state_changed_at, created_at)
     VALUES (?, ?, ?, 'agent', ?, ?, ?, 'claude', '/tmp', 'running', 'working', datetime('now'), datetime('now'))`,
  ).run(project.id, actor, actor, pane, tmuxSocketPath(process.env.TMUX, process.env.TMUX_TMPDIR), panePid);
  const row = db.prepare("SELECT tmux_target, tmux_socket, pane_pid FROM agents WHERE actor_id = ?").get(actor);
  assert.equal(observeRowOwnership(row), "live", JSON.stringify(row));
  return { pane };
}

function makeRunningLead(actor) {
  const session = `questions-cli-lead-${process.pid}-${scratchSessions.length}`;
  execFileSync("tmux", ["new-session", "-d", "-s", session, "cat"], { stdio: "ignore" });
  scratchSessions.push(session);
  const pane = execFileSync("tmux", ["list-panes", "-t", `=${session}`, "-F", "#{pane_id}"], {
    encoding: "utf8",
  }).trim();
  const panePid = execFileSync("tmux", ["display-message", "-p", "-t", pane, "#{pane_pid}"], {
    encoding: "utf8",
  }).trim();
  db.prepare("INSERT OR IGNORE INTO actors (id, name, kind) VALUES (?, ?, 'lead')").run(actor, actor);
  const result = db.prepare(
    `INSERT INTO agents (project_id, actor_id, name, kind, tmux_target, tmux_socket, pane_pid, command, cwd,
       status, agent_state, state_changed_at, created_at)
     VALUES (?, ?, 'lead', 'lead', ?, ?, ?, 'claude', '/tmp', 'running', 'working', datetime('now'), datetime('now'))
     RETURNING id`,
  ).get(project.id, actor, pane, tmuxSocketPath(process.env.TMUX, process.env.TMUX_TMPDIR), panePid);
  return result.id;
}

describe("hive questions", () => {
  it("questions CLI reports an empty project", async () => {
    const text = await runCli(["questions"], { cwd: dirs.projectDir, dataDir: dirs.dataDir });
    assert.equal(text.code, 0);
    assert.equal(text.stdout.trim(), "No pending or defaulted questions.");

    const json = await runCli(["questions", "--json"], { cwd: dirs.projectDir, dataDir: dirs.dataDir });
    assert.equal(json.code, 0);
    assert.deepEqual(JSON.parse(json.stdout), { questions: [] });
  });

  it("questions CLI orders pending before defaulted and omits terminals", async () => {
    const pending = insertQuestion({ question: "Which route should the release take?" });
    const defaulted = insertQuestion({ state: "defaulted", question: "Which build should ship?" });
    insertQuestion({ state: "answered", question: "An answered terminal question." });
    insertQuestion({ state: "withdrawn", question: "A withdrawn terminal question." });

    const text = await runCli(["questions"], { cwd: dirs.projectDir, dataDir: dirs.dataDir });
    assert.equal(text.code, 0);
    assert.ok(text.stdout.indexOf(`#${pending} [pending]`) < text.stdout.indexOf(`#${defaulted} [defaulted]`));
    assert.match(text.stdout, /Question: Which route should the release take\?/);
    assert.match(text.stdout, /Default: North/);
    assert.match(text.stdout, /North \(Recommended\): Ship to the northern region first\./);
    assert.match(text.stdout, /South: Ship to the southern region first\./);
    assert.doesNotMatch(text.stdout, /terminal question/);

    const json = await runCli(["questions", "--json"], { cwd: dirs.projectDir, dataDir: dirs.dataDir });
    assert.equal(json.code, 0);
    const listed = JSON.parse(json.stdout).questions;
    assert.deepEqual(listed.map((q) => [q.id, q.state]), [[pending, "pending"], [defaulted, "defaulted"]]);
    assert.deepEqual(listed[0].options[0], {
      label: "North",
      description: "Ship to the northern region first.",
      recommended: true,
    });
  });

  it("answers one quoted argument and notes verbatim, while reporting a skipped wake honestly", async () => {
    const questionId = insertQuestion({ kind: "free_text", options: null, default_answer: "the current route" });
    const answer = "Keep North\n  and ship after the review.";
    const notes = "First note\n  second note";
    const result = await runCli(["answer", String(questionId), answer, "--notes", notes], {
      cwd: dirs.projectDir,
      dataDir: dirs.dataDir,
    });

    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, new RegExp(`Question #${questionId} answered\\.`));
    assert.match(result.stdout, /No wake queued:/);
    assert.doesNotMatch(result.stdout, /Wake #\d+ queued/);
    const row = db.prepare("SELECT state, answer, notes, asker, answered_by FROM questions WHERE id = ?").get(questionId);
    assert.deepEqual({ state: row.state, answer: row.answer, notes: row.notes, asker: row.asker }, {
      state: "answered",
      answer,
      notes,
      asker: "agent:unreachable",
    });
    assert.ok(row.answered_by.startsWith(HUMAN_ACTOR_PREFIX));
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM wakes WHERE body LIKE ?").get(`Question #${questionId} answered.%`).n, 0);
  });

  it("answer CLI stores text and notes and queues the asker wake", { skip: tmuxSkip }, async () => {
    const asker = "agent:questions-cli-reachable";
    makeAskingAgent(asker);
    const questionId = insertQuestion({ asker });
    const notes = "the review is complete";
    const result = await runCli(["answer", String(questionId), "Ship North", "--notes", notes], {
      cwd: dirs.projectDir,
      dataDir: dirs.dataDir,
    });

    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, new RegExp(`Question #${questionId} answered\\.`));
    const match = result.stdout.match(/Wake #(\d+) queued for the asking session\./);
    assert.ok(match, result.stdout);
    const wake = db.prepare("SELECT deliver_actor, body FROM wakes WHERE id = ?").get(Number(match[1]));
    assert.equal(wake.deliver_actor, asker);
    assert.match(wake.body, /Answer: Ship North/);
    assert.match(wake.body, /Notes: the review is complete/);
  });

  it("hive answer reports a rerouted wake", { skip: tmuxSkip }, async () => {
    const askerActor = "agent:questions-cli-closed";
    const asker = makeAskingAgent(askerActor);
    const askerClient = new McpClient({
      cwd: dirs.projectDir,
      dataDir: dirs.dataDir,
      env: { HIVE_AGENT_ID: askerActor },
    });
    await askerClient.start();
    let questionId;
    try {
      ({ question_id: questionId } = await askerClient.call("question_ask", {
        kind: "free_text",
        question: "Which route should the closed worker take?",
        header: "Route",
        default_answer: "North",
      }));
    } finally {
      await askerClient.close();
    }
    db.prepare("UPDATE agents SET status = 'closed' WHERE project_id = ? AND actor_id = ?").run(project.id, askerActor);
    execFileSync("tmux", ["kill-pane", "-t", asker.pane], { stdio: "ignore" });

    const leadActor = "lead:questions-cli-fallback";
    makeRunningLead(leadActor);
    const result = await runCli(["answer", String(questionId), "Ship North"], {
      cwd: dirs.projectDir,
      dataDir: dirs.dataDir,
    });

    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
    const match = result.stdout.match(/Wake #(\d+) queued for the asking session \(asker not running; sent to lead:questions-cli-fallback\)\./);
    assert.ok(match, result.stdout);
    const wake = db.prepare("SELECT deliver_actor, body FROM wakes WHERE id = ?").get(Number(match[1]));
    assert.equal(wake.deliver_actor, leadActor);
    assert.equal(
      wake.body,
      `Question #${questionId} answered.\nQuestion: Which route should the closed worker take?\nAnswer: Ship North\n` +
        `Asked by ${askerActor}, which is not running; delivered to this project's lead.`,
    );
  });

  it("accepts a dash-prefixed answer after the end-of-options marker", async () => {
    const questionId = insertQuestion({ kind: "free_text", options: null, default_answer: "the current route" });
    const result = await runCli(["answer", String(questionId), "--", "--ship-north"], {
      cwd: dirs.projectDir,
      dataDir: dirs.dataDir,
    });

    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
    const row = db.prepare("SELECT answer FROM questions WHERE id = ?").get(questionId);
    assert.deepEqual(row, { answer: "--ship-north" });
  });

  it("CLI refuses malformed flags and foreign or terminal ids", async () => {
    const pending = insertQuestion();
    const foreignProject = db.prepare("INSERT INTO projects (name, path) VALUES ('foreign-question-cli', ?) RETURNING id")
      .get(`${dirs.projectDir}-foreign`).id;
    const foreign = insertQuestion({ project_id: foreignProject, question: "Foreign question" });
    const terminal = insertQuestion({ state: "answered", question: "Already answered" });
    const before = JSON.stringify(db.prepare("SELECT id, state, answer, notes FROM questions ORDER BY id").all());
    const wakesBefore = db.prepare("SELECT COUNT(*) AS n FROM wakes").get().n;

    for (const [args, expected] of [
      [["answer", "0", "choice"], /positive safe integer/],
      [["answer", String(pending), ""], /answer cannot be blank/],
      [["answer", String(pending), "unsafe\u0007answer"], /cannot contain/],
      [["answer", String(pending), "two", "arguments"], /usage: hive answer/],
      [["answer", String(pending), "choice", "--unknown"], /unknown argument/],
      [["answer", String(pending), "choice", "--notes"], /--notes requires a value/],
      [["answer", String(pending), "choice", "--notes", "one", "--notes", "two"], /--notes may be passed only once/],
      [["answer", String(foreign), "choice"], /No question .* in this project/],
      [["answer", String(terminal), "choice"], /already answered/],
    ]) {
      const result = await runCli(args, { cwd: dirs.projectDir, dataDir: dirs.dataDir });
      assert.equal(result.code, 1, `${args.join(" ")} should fail`);
      assert.match(`${result.stdout}${result.stderr}`, expected);
    }

    assert.equal(JSON.stringify(db.prepare("SELECT id, state, answer, notes FROM questions ORDER BY id").all()), before);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM wakes").get().n, wakesBefore);
  });
});
