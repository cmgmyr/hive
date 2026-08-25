import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { allowedAgents, loadProjectYml } from "../dist/projectYml.js";

function ymlProject(body) {
  const dir = mkdtempSync(join(tmpdir(), "hive-yml-agents-"));
  writeFileSync(join(dir, "hive.yml"), body);
  return dir;
}

describe("hive.yml agents key", () => {
  it("leaves agents unset when the key is absent", () => {
    const { config, warnings } = loadProjectYml(ymlProject("placement: split\n"));
    assert.equal(config.agents, null);
    assert.deepEqual(warnings, []);
  });

  it("accepts a list naming known harnesses, first entry first", () => {
    const { config, warnings } = loadProjectYml(ymlProject("agents:\n  - claude\n  - codex\n"));
    assert.deepEqual(config.agents, ["claude", "codex"]);
    assert.deepEqual(warnings, []);
  });

  it("warns and drops an unknown harness name without crashing the rest of the list", () => {
    const { config, warnings } = loadProjectYml(ymlProject("agents:\n  - claude\n  - aider\n"));
    assert.deepEqual(config.agents, ["claude"]);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /agents: "aider" is not a known harness/);
  });

  it("warns and falls back to unset when the value is not a list", () => {
    const { config, warnings } = loadProjectYml(ymlProject("agents: claude\n"));
    assert.equal(config.agents, null);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /agents must be a list of harness names/);
  });

  it("falls back to unset when every entry is invalid, rather than an empty array", () => {
    const { config, warnings } = loadProjectYml(ymlProject("agents:\n  - aider\n"));
    assert.equal(config.agents, null);
    assert.equal(warnings.length, 1);
  });
});

describe("allowedAgents", () => {
  it("defaults to claude only when there is no config", () => {
    assert.deepEqual(allowedAgents(null), ["claude"]);
  });

  it("defaults to claude only when agents is unset", () => {
    const { config } = loadProjectYml(ymlProject("placement: split\n"));
    assert.deepEqual(allowedAgents(config), ["claude"]);
  });

  it("uses the configured list, first entry as the default", () => {
    const { config } = loadProjectYml(ymlProject("agents:\n  - codex\n  - claude\n"));
    assert.deepEqual(allowedAgents(config), ["codex", "claude"]);
  });
});
