import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import Database from "better-sqlite3";

import { clearHiveEnv, isolateTmux, runCli, scratchDirs, tmux, until } from "./helpers.mjs";

clearHiveEnv();
const { hasTmux, cleanup } = isolateTmux("global hive.yml resolver");

const { configHash, loadProjectYml, resolveHiveConfig } = await import("../dist/projectYml.js");
const { globalConfigPath } = await import("../dist/globalConfig.js");
const { sessionName } = await import("../dist/tmux.js");

function fixture({ global, project } = {}) {
  const root = mkdtempSync(join(tmpdir(), "hive-global-yml-"));
  const dataDir = join(root, "data");
  const projectDir = join(root, "project");
  mkdirSync(projectDir, { recursive: true });
  process.env.HIVE_DATA_DIR = dataDir;
  if (global !== undefined) {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, "hive.yml"), global);
  }
  if (project !== undefined) writeFileSync(join(projectDir, "hive.yml"), project);
  return { root, dataDir, projectDir, globalPath: join(dataDir, "hive.yml") };
}

describe("global and project hive.yml resolution", () => {
  it("reads global-only defaults without a project hive.yml", () => {
    const dirs = fixture({ global: "lead: sleep 300\ndashboard: true\nvars:\n  repo: global/repo\n" });
    const loaded = loadProjectYml(dirs.projectDir);
    assert.equal(loaded.config.lead, "sleep 300");
    assert.equal(loaded.config.dashboard, true);
    assert.equal(loaded.config.vars.repo, "global/repo");
    assert.equal(loaded.sources.lead, "global");
    assert.equal(loaded.sources.dashboard, "global");
    assert.equal(loaded.sources["vars.repo"], "global");
    assert.equal(existsSync(join(dirs.projectDir, "hive.yml")), false);
  });

  it("reads project-only values with built-in sources for absent keys", () => {
    const dirs = fixture({ project: "lead: sleep 301\n" });
    const loaded = loadProjectYml(dirs.projectDir);
    assert.equal(loaded.config.lead, "sleep 301");
    assert.equal(loaded.config.dashboard, false);
    assert.equal(loaded.sources.lead, "project");
    assert.equal(loaded.sources.dashboard, "built-in");
  });

  it("project scalars override global scalars and omitted keys inherit", () => {
    const dirs = fixture({ global: "lead: sleep 300\nplacement: window\n", project: "lead: sleep 301\n" });
    const loaded = loadProjectYml(dirs.projectDir);
    assert.equal(loaded.config.lead, "sleep 301");
    assert.equal(loaded.config.placement, "window");
    assert.equal(loaded.sources.lead, "project");
    assert.equal(loaded.sources.placement, "global");
  });

  it("project lists replace global lists without concatenation", () => {
    const dirs = fixture({ global: "agents: [claude, codex]\nlead_branches: [main, trunk]\n", project: "agents: [codex]\nlead_branches: [release]\n" });
    const loaded = loadProjectYml(dirs.projectDir);
    assert.deepEqual(loaded.config.agents, ["codex"]);
    assert.deepEqual(loaded.config.lead_branches, ["release"]);
    assert.equal(loaded.sources.agents, "project");
    assert.equal(loaded.sources.lead_branches, "project");
  });

  it("explicit false and null clear global dashboard defaults", () => {
    const falseCase = fixture({ global: "dashboard: true\n", project: "dashboard: false\n" });
    const nullCase = fixture({ global: "dashboard: true\n", project: "dashboard: null\n" });
    assert.equal(loadProjectYml(falseCase.projectDir).config.dashboard, false);
    assert.equal(loadProjectYml(nullCase.projectDir).config.dashboard, false);
    assert.equal(loadProjectYml(falseCase.projectDir).sources.dashboard, "project");
    assert.equal(loadProjectYml(nullCase.projectDir).sources.dashboard, "project");
  });

  it("explicit null clears each nullable global scalar", () => {
    const dirs = fixture({
      global: "lead: sleep 300\nplacement: window\nlayout: main-vertical\nprofile: simple\ncontext_checkpoint_percent: 50\n",
      project: "lead: null\nplacement: null\nlayout: null\nprofile: null\ncontext_checkpoint_percent: null\n",
    });
    const loaded = loadProjectYml(dirs.projectDir);
    for (const key of ["lead", "placement", "layout", "profile", "context_checkpoint_percent"]) {
      assert.equal(loaded.config[key], null, `${key} must be explicitly cleared`);
      assert.equal(loaded.sources[key], "project", `${key} must report its assigning file`);
    }
  });

  it("vars merge by key and null removes an inherited var", () => {
    const dirs = fixture({
      global: "vars:\n  keep: global\n  replace: global\n  remove: global\n",
      project: "vars:\n  replace: project\n  remove: null\n  add: project\n",
    });
    const loaded = loadProjectYml(dirs.projectDir);
    assert.deepEqual(loaded.config.vars, { keep: "global", replace: "project", add: "project" });
    assert.equal(loaded.sources["vars.keep"], "global");
    assert.equal(loaded.sources["vars.replace"], "project");
    assert.equal(loaded.sources["vars.remove"], "project");
    assert.equal(loaded.sources["vars.add"], "project");
  });

  it("null vars clears the map while an empty map inherits", () => {
    const cleared = fixture({ global: "vars:\n  inherited: yes\n", project: "vars: null\n" });
    const inherited = fixture({ global: "vars:\n  inherited: yes\n", project: "vars: {}\n" });
    const a = loadProjectYml(cleared.projectDir);
    const b = loadProjectYml(inherited.projectDir);
    assert.deepEqual(a.config.vars, {});
    assert.equal(a.sources.vars, "project");
    assert.deepEqual(b.config.vars, { inherited: "yes" });
    assert.equal(b.sources.vars, "global");
  });

  it("a project budget replaces the global budget as a whole pair", () => {
    const replaced = fixture({ global: "lead_turn_budget: {warn: 300, stop: 600}\n", project: "lead_turn_budget: {warn: 400, stop: 800}\n" });
    const invalid = fixture({ global: "lead_turn_budget: {warn: 300, stop: 600}\n", project: "lead_turn_budget: {warn: 700, stop: 600}\n" });
    const reset = fixture({ global: "lead_turn_budget: {warn: 300, stop: 600}\n", project: "lead_turn_budget: null\n" });
    assert.deepEqual(loadProjectYml(replaced.projectDir).config.lead_turn_budget, { warn: 400, stop: 800 });
    const invalidResult = loadProjectYml(invalid.projectDir);
    assert.deepEqual(invalidResult.config.lead_turn_budget, { warn: 300, stop: 600 });
    assert.equal(invalidResult.warnings.some((warning) => warning.startsWith(`${join(invalid.projectDir, "hive.yml")}:`)), true);
    assert.equal(invalidResult.sources.lead_turn_budget, "global");
    assert.equal(loadProjectYml(reset.projectDir).config.lead_turn_budget, null);
    assert.equal(loadProjectYml(reset.projectDir).sources.lead_turn_budget, "project");
  });

  it("global processes are ignored and warn with the global file path", () => {
    const dirs = fixture({ global: "processes: null\nlead: sleep 300\n" });
    const loaded = loadProjectYml(dirs.projectDir);
    assert.deepEqual(loaded.config.processes, {});
    assert.equal(loaded.sources.processes, "built-in");
    assert.ok(loaded.warnings.some((warning) => warning.startsWith(`${dirs.globalPath}:`) && warning.includes("cannot define `processes`")));
  });

  it("project attach and autoAttach warn and cannot change terminal settings", () => {
    const dirs = fixture({ global: "attach: control\nautoAttach: off\n", project: "attach: raw\nautoAttach: on\n" });
    const loaded = loadProjectYml(dirs.projectDir);
    assert.deepEqual(loaded.attach, { mode: "control", source: "global" });
    assert.deepEqual(loaded.autoAttach, { value: "off", source: "global" });
    assert.equal(loaded.warnings.filter((warning) => warning.startsWith(`${join(dirs.projectDir, "hive.yml")}:`)).length, 2);
  });

  it("warnings name each invalid file and preserve the valid lower layer", () => {
    const dirs = fixture({ global: "layout: diagonal\ndashboard: true\n", project: "dashboard: yes\n" });
    const loaded = loadProjectYml(dirs.projectDir);
    assert.equal(loaded.config.dashboard, true);
    assert.equal(loaded.config.layout, null);
    assert.ok(loaded.warnings.some((warning) => warning.startsWith(`${dirs.globalPath}:`) && warning.includes("layout must be one of")));
    assert.ok(loaded.warnings.some((warning) => warning.startsWith(`${join(dirs.projectDir, "hive.yml")}:`) && warning.includes("dashboard must be true or false")));
  });

  it("changing HIVE_DATA_DIR after import changes both config layers", () => {
    const first = fixture({ global: "lead: sleep 301\n" });
    const second = fixture({ global: "lead: sleep 302\n" });
    process.env.HIVE_DATA_DIR = first.dataDir;
    assert.equal(resolveHiveConfig(first.projectDir).config.lead, "sleep 301");
    process.env.HIVE_DATA_DIR = second.dataDir;
    assert.equal(globalConfigPath(), second.globalPath);
    assert.equal(resolveHiveConfig(first.projectDir).config.lead, "sleep 302");
  });

  it("global file edits do not change a project process command hash", () => {
    const dirs = fixture({ global: "lead: sleep 301\n" });
    const projectHash = configHash("web", "npm run dev", null, { PORT: "3000" });
    writeFileSync(dirs.globalPath, "lead: sleep 302\nvars:\n  ticket: changed\n");
    const loaded = resolveHiveConfig(dirs.projectDir);
    assert.equal(loaded.config.lead, "sleep 302");
    assert.equal(configHash("web", "npm run dev", null, { PORT: "3000" }), projectHash);
  });

  it("both module import entry orders resolve without opening SQLite", () => {
    const dirs = fixture({ global: "lead: sleep 300\n" });
    for (const order of [["config", "projectYml"], ["projectYml", "config"], ["config", "tmux"], ["tmux", "config"]]) {
      const imports = order.map((name) => `await import(${JSON.stringify(new URL(`../dist/${name}.js`, import.meta.url).pathname)});`).join("\n");
      const script = `${imports}\nconst { resolveHiveConfig } = await import(${JSON.stringify(new URL("../dist/projectYml.js", import.meta.url).pathname)});\nif (resolveHiveConfig(${JSON.stringify(dirs.projectDir)}).config.lead !== "sleep 300") process.exit(9);`;
      const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
        encoding: "utf8",
        env: { ...process.env, HIVE_DATA_DIR: dirs.dataDir },
      });
      assert.equal(result.status, 0, `${order.join(" then ")}: ${result.stderr}`);
      assert.equal(existsSync(join(dirs.dataDir, "hive.db")), false, "module entry order must not open SQLite");
    }
  });

  it("legacy attach fallback reads write no files", () => {
    const dirs = fixture();
    mkdirSync(dirs.dataDir, { recursive: true });
    const legacyPath = join(dirs.dataDir, "config.json");
    const bytes = '{"attach":"raw","autoAttach":"on","other":"kept"}\n';
    writeFileSync(legacyPath, bytes);
    const before = readdirSync(dirs.dataDir).sort();
    const loaded = resolveHiveConfig(dirs.projectDir);
    assert.deepEqual(loaded.attach, { mode: "raw", source: "global" });
    assert.deepEqual(loaded.autoAttach, { value: "on", source: "global" });
    assert.deepEqual(readdirSync(dirs.dataDir).sort(), before);
    assert.equal(readFileSync(legacyPath, "utf8"), bytes);
  });

  it("empty and malformed layer roots preserve built-in defaults", () => {
    const dirs = fixture({ global: "[]\n", project: "lead: [broken\n" });
    const loaded = loadProjectYml(dirs.projectDir);
    assert.equal(loaded.config, null);
    assert.equal(loaded.sources.lead, "built-in");
    assert.ok(loaded.warnings.some((warning) => warning.startsWith(`${dirs.globalPath}:`)));
    assert.ok(loaded.warnings.some((warning) => warning.startsWith(`${join(dirs.projectDir, "hive.yml")}:`)));
  });

  it("source attribution follows each merged map leaf", () => {
    const dirs = fixture({ global: "vars:\n  keep: global\n  remove: global\n", project: "vars:\n  project: local\n  remove: null\n" });
    const loaded = loadProjectYml(dirs.projectDir);
    assert.deepEqual(loaded.config.vars, { keep: "global", project: "local" });
    assert.equal(loaded.sources.vars, "project");
    assert.equal(loaded.sources["vars.keep"], "global");
    assert.equal(loaded.sources["vars.project"], "project");
    assert.equal(loaded.sources["vars.remove"], "project");
  });
});

describe("global lead trust remains per project", { skip: hasTmux ? false : "tmux is not installed" }, () => {
  it("global lead changes retain the existing per-project command hash gate", async () => {
    const dirs = fixture();
    mkdirSync(dirs.dataDir, { recursive: true });
    const session = sessionName();
    const customDir = join(dirs.root, "custom");
    const defaultDir = join(dirs.root, "default");
    mkdirSync(customDir);
    mkdirSync(defaultDir);
    const untrustedPath = join(dirs.root, "untrusted-lead");
    const changedPath = join(dirs.root, "changed-lead");
    const defaultPath = join(defaultDir, "claude");
    const customMarker = join(dirs.root, "custom-ran");
    const defaultMarker = join(dirs.root, "default-ran");
    writeFileSync(untrustedPath, `#!/bin/sh\nprintf run >> '${customMarker}'\nexec sleep 600\n`);
    writeFileSync(changedPath, `#!/bin/sh\nprintf run >> '${join(dirs.root, "changed-ran")}'\nexec sleep 600\n`);
    writeFileSync(defaultPath, `#!/bin/sh\nprintf run >> '${defaultMarker}'\nexec sleep 600\n`);
    for (const path of [untrustedPath, changedPath, defaultPath]) chmodSync(path, 0o755);

    const opts = { cwd: dirs.projectDir, dataDir: dirs.dataDir, tmp: join(dirs.root, "tmp"), env: { PATH: `${defaultDir}:${process.env.PATH}` } };
    const initialized = await runCli(["init", "--no-profile"], opts);
    assert.equal(initialized.code, 0, initialized.stderr);
    rmSync(join(dirs.projectDir, "hive.yml"));
    writeFileSync(dirs.globalPath, `lead: ${untrustedPath}\n`);
    const db = new Database(join(dirs.dataDir, "hive.db"));
    try {
      const project = db.prepare("SELECT id FROM projects WHERE path = ?").get(realpathSync(dirs.projectDir));
      assert.ok(project, `init must leave a real registered project row; init output:\n${initialized.stdout}`);
      const first = await runCli(["lead"], opts);
      assert.equal(first.code, 0, first.stderr);
      assert.match(first.stdout, /lead.*not trusted yet/);
      assert.equal(existsSync(customMarker), false, "an untrusted global command must never run");
      assert.ok(await until(() => existsSync(defaultMarker)), `the default claude command did not start; ${first.stdout}\n${first.stderr}`);
      assert.equal(existsSync(defaultMarker), true, "the fake default claude command must run");
      assert.match(db.prepare("SELECT command FROM agents WHERE project_id = ? AND kind = 'lead'").get(project.id).command, /^claude\b/);

      const hash = configHash("lead", untrustedPath, null, {});
      db.prepare("INSERT INTO command_trust (project_id, name, config_hash) VALUES (?, 'lead', ?)").run(project.id, hash);
      tmux("kill-pane", "-t", db.prepare("SELECT tmux_target FROM agents WHERE project_id = ? AND kind = 'lead'").get(project.id).tmux_target);
      const approved = await runCli(["lead"], opts);
      assert.equal(approved.code, 0, approved.stderr);
      assert.ok(await until(() => existsSync(customMarker)), `the approved command did not start; ${approved.stdout}\n${approved.stderr}\n${JSON.stringify(db.prepare("SELECT command FROM agents WHERE project_id = ? AND kind = 'lead'").get(project.id))}`);
      assert.equal(readFileSync(customMarker, "utf8"), "run");
      assert.equal(db.prepare("SELECT command FROM agents WHERE project_id = ? AND kind = 'lead'").get(project.id).command, untrustedPath);

      writeFileSync(dirs.globalPath, `lead: ${changedPath}\n`);
      tmux("kill-pane", "-t", db.prepare("SELECT tmux_target FROM agents WHERE project_id = ? AND kind = 'lead'").get(project.id).tmux_target);
      const changed = await runCli(["lead"], opts);
      assert.equal(changed.code, 0, changed.stderr);
      assert.match(changed.stdout, /lead.*not trusted yet/);
      assert.equal(existsSync(join(dirs.root, "changed-ran")), false, "a changed global lead must need approval");
      assert.match(db.prepare("SELECT command FROM agents WHERE project_id = ? AND kind = 'lead'").get(project.id).command, /^claude\b/);
    } finally {
      cleanup(session);
      db.close();
    }
  });
});
