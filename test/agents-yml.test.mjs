import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { agentVarKeys, agentVars, allowedAgents, loadProjectYml, mergedProjectVars } from "../dist/projectYml.js";

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

describe("todo 597: agentVars, derived per-harness template vars", () => {
  it("sets agents_claude only when agents: is absent", () => {
    assert.deepEqual(agentVars(null), { agents_claude: "1" });
  });

  it("sets one var per allowed harness when agents: lists more than one", () => {
    const { config } = loadProjectYml(ymlProject("agents:\n  - claude\n  - codex\n"));
    assert.deepEqual(agentVars(config), { agents_claude: "1", agents_codex: "1" });
  });

  it("never sets a var for a harness not in the allowed list", () => {
    const { config } = loadProjectYml(ymlProject("agents:\n  - codex\n"));
    assert.deepEqual(agentVars(config), { agents_codex: "1" });
  });

  it("agentVarKeys lists every known harness's key, not just the allowed ones", () => {
    assert.deepEqual(agentVarKeys().sort(), ["agents_claude", "agents_codex"]);
  });
});

describe("todo 597: mergedProjectVars", () => {
  it("merges a project's hive.yml vars with the derived agents_* vars", () => {
    const { config } = loadProjectYml(ymlProject("vars:\n  foo: bar\n"));
    assert.deepEqual(mergedProjectVars(config), { foo: "bar", agents_claude: "1" });
  });

  it("a hive.yml var named agents_codex does not survive when codex is not allowed", () => {
    const { config } = loadProjectYml(ymlProject("vars:\n  agents_codex: 1\n"));
    assert.deepEqual(mergedProjectVars(config), { agents_claude: "1" });
  });

  it("a hive.yml var named agents_claude does not silently disable the real derived value", () => {
    const { config } = loadProjectYml(ymlProject("agents:\n  - codex\nvars:\n  agents_claude: fake\n"));
    assert.deepEqual(mergedProjectVars(config), { agents_codex: "1" });
  });

  it("defaults to claude-only derived vars with no config at all", () => {
    assert.deepEqual(mergedProjectVars(null), { agents_claude: "1" });
  });
});
