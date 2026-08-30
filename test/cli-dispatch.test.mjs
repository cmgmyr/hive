import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { CLI } from "./helpers.mjs";

const source = readFileSync(CLI, "utf8");

const COMMANDS = (() => {
  const table = /const COMMANDS = \[([\s\S]*?)\];/.exec(source);
  assert.ok(table, "COMMANDS table not found in dist/cli.js");
  return [...table[1].matchAll(/"([a-z]+)"/g)].map((m) => m[1]);
})();

const switchBody = (() => {
  const start = source.indexOf("switch (command) {");
  assert.ok(start >= 0, "dispatch switch not found in dist/cli.js");
  const end = source.indexOf("\n}", start);
  assert.ok(end > start, "could not find the end of the dispatch switch");
  return source.slice(start, end);
})();

describe("hive CLI dispatch", () => {
  it("routes every COMMANDS entry to its own case label, not a fallthrough", () => {
    for (const command of COMMANDS) {
      assert.match(
        switchBody,
        new RegExp(`case "${command}":`),
        `COMMANDS lists "${command}" but the dispatch switch has no case for it`,
      );
    }
  });

  it("falls to a default case that exits non-zero naming the command, rather than a silent no-op", () => {
    assert.match(switchBody, /default:/, "dispatch switch has no default case");
    const defaultBody = switchBody.slice(switchBody.indexOf("default:"));
    assert.match(defaultBody, /process\.exit\(1\)/, "default case does not exit non-zero");
    assert.match(defaultBody, /\$\{command\}/, "default case does not name the unmatched command");
  });
});
