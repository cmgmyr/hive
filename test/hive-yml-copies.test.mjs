import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { isolateTmux, runCli, scratchDirs } from "./helpers.mjs";

const PROJECT_YML = readFileSync(join(import.meta.dirname, "..", "src", "projectYml.ts"), "utf8");
const BUILT_IN_BODY = PROJECT_YML.match(/export const BUILT_IN_PROJECT_YML: Readonly<ProjectYml> = Object\.freeze\(\{([\s\S]*?)\n\}\);/)?.[1] ?? "";
const KEYS = [...BUILT_IN_BODY.matchAll(/^\s+([a-z_]+):/gm)].map(([, key]) => key);

const { cleanup: cleanupTmux } = isolateTmux("hive.yml copies");
after(() => cleanupTmux());

const copyKeys = (text, { docs = false } = {}) => KEYS.filter((key) => {
  const appearsAsYaml = new RegExp(docs ? `\\b${key}:` : `^\\s*#?\\s*${key}:`, "m").test(text);
  return !(appearsAsYaml || (docs && text.includes(`\`${key}\``)));
});

const assertKeys = (name, text, options) => {
  const missing = copyKeys(text, options);
  assert.deepEqual(missing, [], `${name} is missing top-level ProjectYml keys: ${missing.join(", ")}`);
};

describe("hive.yml copies", () => {
  it("hive.example.yml mentions every top-level key ProjectYml parses", () => {
    assertKeys("hive.example.yml", readFileSync(join(import.meta.dirname, "..", "hive.example.yml"), "utf8"));
  });

  it("hive init output mentions every top-level key ProjectYml parses", async () => {
    const dirs = scratchDirs();
    const { code } = await runCli(["init", "--no-profile"], { cwd: dirs.projectDir, dataDir: dirs.dataDir, tmp: dirs.tmp });
    assert.equal(code, 0);
    assertKeys("hive init output", readFileSync(join(dirs.projectDir, "hive.yml"), "utf8"));
  });

  it("docs/projects.md mentions every top-level key ProjectYml parses", () => {
    assertKeys("docs/projects.md", readFileSync(join(import.meta.dirname, "..", "docs", "projects.md"), "utf8"), { docs: true });
  });

  it("the built-in sentinel order matches ProjectYml and feeds the doctor reporter", () => {
    const interfaceBody = PROJECT_YML.match(/export interface ProjectYml \{([\s\S]*?)\n\}/)?.[1] ?? "";
    const interfaceKeys = [...interfaceBody.matchAll(/^\s+([a-z_]+)\??:/gm)].map(([, key]) => key);
    assert.deepEqual(KEYS, interfaceKeys);
    assert.match(PROJECT_YML, /export const PROJECT_YML_KEYS = Object\.freeze\(Object\.keys\(BUILT_IN_PROJECT_YML\)/);

    const cli = readFileSync(join(import.meta.dirname, "..", "src", "cli.ts"), "utf8");
    const reporter = cli.match(/function reportEffectiveConfig\([\s\S]*?\n\}/)?.[0] ?? "";
    assert.match(reporter, /const config = loaded\.config \?\? BUILT_IN_PROJECT_YML/);
    assert.match(reporter, /for \(const key of PROJECT_YML_KEYS\)/);
  });
});
