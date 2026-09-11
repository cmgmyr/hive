import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { parse } from "yaml";
import { clearHiveEnv, isolateTmux, REPO, scratchDirs } from "./helpers.mjs";

const { cleanup } = isolateTmux("context checkpoint config");
after(cleanup);
clearHiveEnv();
const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { loadProjectYml } = await import("../dist/projectYml.js");
function load(body) {
  writeFileSync(join(dirs.projectDir, "hive.yml"), body);
  return loadProjectYml(dirs.projectDir);
}

describe("context_checkpoint_percent config", () => {
  it("is off with no file, an absent key, or explicit null", () => {
    assert.equal(loadProjectYml(dirs.projectDir).config, null);
    for (const body of ["{}", "context_checkpoint_percent: null"]) {
      const result = load(body);
      assert.equal(result.config.context_checkpoint_percent, null);
      assert.deepEqual(result.warnings, []);
    }
  });
  it("accepts integer percentages including both boundaries", () => {
    for (const value of [1, 37, 100]) {
      const result = load(`context_checkpoint_percent: ${value}`);
      assert.equal(result.config.context_checkpoint_percent, value);
      assert.deepEqual(result.warnings, []);
    }
  });
  it("ignores invalid values with a warning instead of supplying a default", () => {
    for (const value of ["0", "101", "-1", "1.5", "'37'", "true", "[]", "{}", ".inf", ".nan"]) {
      const result = load(`context_checkpoint_percent: ${value}`);
      assert.equal(result.config.context_checkpoint_percent, null);
      assert.equal(result.warnings.length, 1);
      assert.match(result.warnings[0], /context_checkpoint_percent.*integer from 1 through 100/);
    }
  });
  it("keeps the parser, starter, project docs and tracked example in agreement with no source default", () => {
    const source = readFileSync(join(REPO, "src/projectYml.ts"), "utf8");
    assert.match(source, /context_checkpoint_percent: number \| null = null/);
    for (const file of ["src/cli.ts", "docs/projects.md", "hive.example.yml"]) {
      const text = readFileSync(join(REPO, file), "utf8");
      assert.match(text, /context_checkpoint_percent:.*unset means off/);
    }
    const example = parse(readFileSync(join(REPO, "hive.example.yml"), "utf8"));
    assert.equal(example.context_checkpoint_percent, 70);
    const tools = readFileSync(join(REPO, "src/tools/agents.ts"), "utf8");
    assert.doesNotMatch(tools, /context_checkpoint_percent:\s*z\./);
  });
});
