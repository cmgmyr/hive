import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import { assertScratchStore, clearHiveEnv, isolateTmux, runCli, scratchDirs } from "./helpers.mjs";

const { cleanup } = isolateTmux("the questions CLI tests");
const dirs = scratchDirs();
clearHiveEnv();
process.env.HIVE_DATA_DIR = dirs.dataDir;
await assertScratchStore();

const { db, migrate } = await import("../dist/db.js");
const { addProject } = await import("../dist/context.js");
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

after(() => cleanup());

describe("hive questions", () => {
  it("reports an empty project in text and JSON forms", async () => {
    const text = await runCli(["questions"], { cwd: dirs.projectDir, dataDir: dirs.dataDir });
    assert.equal(text.code, 0);
    assert.equal(text.stdout.trim(), "No pending or defaulted questions.");

    const json = await runCli(["questions", "--json"], { cwd: dirs.projectDir, dataDir: dirs.dataDir });
    assert.equal(json.code, 0);
    assert.deepEqual(JSON.parse(json.stdout), { questions: [] });
  });

  it("lists pending before defaulted with full choice details and excludes terminal rows", async () => {
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
    const row = db.prepare("SELECT state, answer, notes FROM questions WHERE id = ?").get(questionId);
    assert.deepEqual(row, { state: "answered", answer, notes });
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM wakes WHERE body LIKE ?").get(`Question #${questionId} answered.%`).n, 0);
  });

  it("rejects malformed, foreign and terminal answers without changing rows", async () => {
    const pending = insertQuestion();
    const foreignProject = db.prepare("INSERT INTO projects (name, path) VALUES ('foreign-question-cli', ?) RETURNING id")
      .get(`${dirs.projectDir}-foreign`).id;
    const foreign = insertQuestion({ project_id: foreignProject, question: "Foreign question" });
    const terminal = insertQuestion({ state: "answered", question: "Already answered" });
    const before = JSON.stringify(db.prepare("SELECT id, state, answer, notes FROM questions ORDER BY id").all());

    for (const [args, expected] of [
      [["answer", "0", "choice"], /positive safe integer/],
      [["answer", String(pending), ""], /answer cannot be blank/],
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
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM wakes").get().n, 0);
  });
});
