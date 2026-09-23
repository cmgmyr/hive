import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

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
