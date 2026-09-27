import assert from "node:assert/strict";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { failureCount, isolateTmux, runCli, scratchDirs, warningCount } from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("the doctor global config tests");
const skipWithoutTmux = hasTmux ? false : "tmux is not installed";
after(() => cleanup());

async function doctorWith({ global, project, legacy, env = {} } = {}) {
  const dirs = scratchDirs();
  const opts = { cwd: dirs.projectDir, dataDir: dirs.dataDir, tmp: dirs.tmp };
  const init = await runCli(["init", "--no-profile"], opts);
  assert.equal(init.code, 0, init.stderr);
  const globalPath = join(dirs.dataDir, "hive.yml");
  const projectPath = join(dirs.projectDir, "hive.yml");
  const legacyPath = join(dirs.dataDir, "config.json");
  if (global !== undefined) writeFileSync(globalPath, global);
  if (project !== undefined) writeFileSync(projectPath, project);
  else if (existsSync(projectPath)) unlinkSync(projectPath);
  if (legacy !== undefined) writeFileSync(legacyPath, legacy);
  const result = await runCli(["doctor"], {
    ...opts,
    env: { HIVE_NO_UPDATE_CHECK: "1", ...env },
  });
  return { ...result, dirs, globalPath, legacyPath, projectPath };
}

describe("hive doctor global config sources", () => {
  it("doctor reports project lead and global dashboard sources", { skip: skipWithoutTmux }, async () => {
    const { stdout } = await doctorWith({
      global: "lead: global-command\ndashboard: true\n",
      project: "lead: project-command\n",
    });
    assert.match(stdout, /info {2}config lead: "project-command" \(source: project\)/);
    assert.match(stdout, /info {2}config dashboard: true \(source: global\)/);
  });

  it("doctor reports project false over a global true", { skip: skipWithoutTmux }, async () => {
    const { stdout } = await doctorWith({ global: "dashboard: true\n", project: "dashboard: false\n" });
    assert.match(stdout, /info {2}config dashboard: false \(source: project\)/);
  });

  it("doctor reports env attach over global attach", { skip: skipWithoutTmux }, async () => {
    const { stdout } = await doctorWith({ global: "attach: raw\n", env: { HIVE_ATTACH_MODE: "control" } });
    assert.match(stdout, /info {2}attach mode: control .*HIVE_ATTACH_MODE.*source: env/);
  });

  it("doctor reports built-in sources without either YAML file", { skip: skipWithoutTmux }, async () => {
    const { stdout } = await doctorWith();
    assert.match(stdout, /info {2}config lead: null \(source: built-in\)/);
    assert.match(stdout, /info {2}config dashboard: false \(source: built-in\)/);
    assert.match(stdout, /info {2}config vars: {} \(source: built-in\)/);
  });

  it("doctor reports each vars and budget leaf source", { skip: skipWithoutTmux }, async () => {
    const { stdout } = await doctorWith({
      global: "vars:\n  check: npm test\n  inherited: yes\nlead_turn_budget: {warn: 100, stop: 200}\n",
      project: "vars:\n  check: null\n  local: yes\nlead_turn_budget: {warn: 300, stop: 600}\n",
    });
    assert.match(stdout, /info {2}config vars\.check: null \(source: project\)/);
    assert.match(stdout, /info {2}config vars\.inherited: "yes" \(source: global\)/);
    assert.match(stdout, /info {2}config vars\.local: "yes" \(source: project\)/);
    assert.match(stdout, /info {2}config lead_turn_budget: {"warn":300,"stop":600} \(source: project\)/);
    assert.doesNotMatch(stdout, /config lead_turn_budget\.(warn|stop)/);
  });

  it("doctor names the global file when refusing processes", { skip: skipWithoutTmux }, async () => {
    const { stdout, globalPath } = await doctorWith({ global: "processes: {}\n" });
    const warning = stdout.split("\n").find((line) => line.includes("only project commands can be trusted"));
    assert.ok(warning, stdout);
    assert.ok(warning.includes(globalPath), warning);
    assert.equal(warning.split(globalPath).length - 1, 1, warning);
  });

  it("doctor reports migration without losing a pre-existing YAML comment", { skip: skipWithoutTmux }, async () => {
    const comment = "# keep this comment\n# existing global settings\nunknown: retained\n";
    const legacy = "{\"attach\":\"raw\"}\n";
    const { stdout, stderr, globalPath, legacyPath } = await doctorWith({ global: comment, legacy });
    assert.match(stderr, /migrat/);
    assert.equal(readFileSync(globalPath, "utf8").startsWith(comment), true);
    assert.equal(readFileSync(join(globalPath, "../config.json.migrated"), "utf8"), legacy);
    assert.doesNotMatch(readFileSync(globalPath, "utf8"), /config\.json/);
    assert.match(stdout, /info {2}attach mode: raw .*source: global/);
    assert.equal(existsSync(legacyPath), false);
  });

  it("config warnings do not increase doctor's failure count", { skip: skipWithoutTmux }, async () => {
    const clean = await doctorWith({});
    const broken = await doctorWith({ project: "layout: main-verticle\n" });
    const warning = broken.stdout.split("\n").find((line) => line.includes("layout must be one of"));
    assert.ok(warning, broken.stdout);
    assert.equal(warning.split(broken.projectPath).length - 1, 1, warning);
    assert.equal(failureCount(broken.stdout), failureCount(clean.stdout));
    assert.equal(warningCount(broken.stdout) - warningCount(clean.stdout), 1);
  });
});
