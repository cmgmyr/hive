import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import Database from "better-sqlite3";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { runCli, scratchDirs, isolateTmux } from "./helpers.mjs";

const { cleanup: cleanupTmux } = isolateTmux("lead turn count tests");
after(() => cleanupTmux());

const { readTurnCount } = await import("../dist/turnCount.js");
const { loadProjectYml } = await import("../dist/projectYml.js");

function fixture(lines) {
  const dir = mkdtempSync(join(tmpdir(), "hive-lead-turn-count-"));
  const path = join(dir, "session.jsonl");
  writeFileSync(path, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  return path;
}

test("lead turn count deduplicates content blocks and ignores user and synthetic records", () => {
  const path = fixture([
    { type: "assistant", message: { id: "a", model: "claude", content: [{ type: "text" }] } },
    { type: "assistant", message: { id: "a", model: "claude", content: [{ type: "tool_use" }] } },
    { type: "user", message: { id: "u" } },
    { type: "assistant", message: { id: "synthetic", model: "<synthetic>" } },
    { type: "assistant", message: { id: "b", model: "claude" } },
    { type: "assistant", message: { model: "claude" } },
  ]);
  assert.equal(readTurnCount(path), 2);
});

test("missing transcript omits the count", () => {
  assert.equal(readTurnCount(join(tmpdir(), "hive-lead-turn-count-does-not-exist.jsonl")), null);
});

test("lead_turn_budget requires positive ordered integer thresholds", () => {
  const dir = mkdtempSync(join(tmpdir(), "hive-lead-turn-budget-"));
  writeFileSync(join(dir, "hive.yml"), "lead_turn_budget: {warn: 300, stop: 600}\n");
  assert.deepEqual(loadProjectYml(dir).config.lead_turn_budget, { warn: 300, stop: 600 });
  writeFileSync(join(dir, "hive.yml"), "lead_turn_budget: {warn: 600, stop: 300}\n");
  const invalid = loadProjectYml(dir);
  assert.equal(invalid.config.lead_turn_budget, null);
  assert.match(invalid.warnings[0], /lead_turn_budget/);
});

function assistantLines(count) {
  return Array.from({ length: count }, (_, i) => JSON.stringify({
    type: "assistant", message: { id: `turn-${i}`, model: "claude" },
  })).join("\n") + "\n";
}

async function statuslineFixture({ count, budget, actor = "lead:1321", kind = "lead" }) {
  const dirs = scratchDirs();
  writeFileSync(join(dirs.projectDir, "hive.yml"), budget ? `lead_turn_budget: ${JSON.stringify(budget)}\n` : "");
  const init = await runCli(["init"], { cwd: dirs.projectDir, dataDir: dirs.dataDir, tmp: dirs.tmp });
  assert.equal(init.code, 0, init.stderr);
  const transcript = join(dirs.tmp, "lead.jsonl");
  writeFileSync(transcript, assistantLines(count));
  const store = new Database(join(dirs.dataDir, "hive.db"));
  try {
    const project = store.prepare("SELECT id FROM projects WHERE path = ?").get(dirs.projectDir);
    store.prepare(
      `INSERT INTO agents (project_id, actor_id, name, tmux_target, command, cwd, kind, status)
       VALUES (?, ?, 'lead', '%1321', 'claude', ?, ?, 'running')`,
    ).run(project.id, actor, dirs.projectDir, kind);
  } finally {
    store.close();
  }
  const opts = {
    cwd: dirs.projectDir,
    dataDir: dirs.dataDir,
    tmp: dirs.tmp,
    env: { HIVE_AGENT_ID: actor },
  };
  return { transcript, run: (stdin) => runCli(["statusline"], { ...opts, stdin }) };
}

test("lead statusline reads transcript_path from stdin and colors budget boundaries", async () => {
  const fixture = await statuslineFixture({ count: 300, budget: { warn: 300, stop: 600 } });
  const amber = await fixture.run(JSON.stringify({ transcript_path: fixture.transcript }));
  assert.equal(amber.code, 0);
  assert.match(amber.stdout, /turns 300/);
  assert.match(amber.stdout, /\x1b\[33mturns 300\x1b\[0m/);
  writeFileSync(fixture.transcript, assistantLines(599));
  const stillAmber = await fixture.run(JSON.stringify({ transcript_path: fixture.transcript }));
  assert.match(stillAmber.stdout, /\x1b\[33mturns 599\x1b\[0m/);
  writeFileSync(fixture.transcript, assistantLines(600));
  const red = await fixture.run(JSON.stringify({ transcript_path: fixture.transcript }));
  assert.match(red.stdout, /\x1b\[31mturns 600\x1b\[0m/);
});

test("lead statusline stays plain without a budget and below the warning boundary", async () => {
  const fixture = await statuslineFixture({ count: 299, budget: { warn: 300, stop: 600 } });
  const below = await fixture.run(JSON.stringify({ transcript_path: fixture.transcript }));
  assert.doesNotMatch(below.stdout, /\x1b\[33mturns 299/);
  const plainFixture = await statuslineFixture({ count: 600 });
  const plain = await plainFixture.run(JSON.stringify({ transcript_path: plainFixture.transcript }));
  assert.match(plain.stdout, /turns 600/);
  assert.doesNotMatch(plain.stdout, /\x1b\[(?:31|33)mturns/);
});

test("worker environments omit the lead turn field", async () => {
  const fixture = await statuslineFixture({ count: 98, actor: "agent:1321", kind: "agent" });
  const result = await fixture.run(JSON.stringify({ transcript_path: fixture.transcript }));
  assert.doesNotMatch(result.stdout, /turns/);
});

test("empty stdin returns promptly and omits the turn field", async () => {
  const fixture = await statuslineFixture({ count: 98 });
  const result = await fixture.run("");
  assert.equal(result.code, 0);
  assert.doesNotMatch(result.stdout, /turns/);
});
