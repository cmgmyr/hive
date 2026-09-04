import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { isolateTmux, leadRow, runCli, scratchDirs, until } from "./helpers.mjs";

// todo 575: `lead: codex ...` in hive.yml must start a codex lead with hooks and posture wired
// through the generated-CODEX_HOME mechanism workers already use, since codex has no
// briefDelivery-shaped flags (no --settings, no --append-system-prompt-file equivalent).

const { hasTmux, cleanup } = isolateTmux("the codex lead tests");

const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { db, migrate } = await import("../dist/db.js");
migrate();
const { sessionName, shellQuote } = await import("../dist/tmux.js");
const { configHash } = await import("../dist/projectYml.js");
const { codexHomeDir } = await import("../dist/codexHome.js");
const { TRIAGE_MESSAGE } = await import("../dist/kickoff.js");

// A fake HOME so ensureCodexHome's auth.json lookup resolves to a fake credential rather than the
// real ~/.codex (the same reason agent-spawn-harness.test.mjs and codex-home.test.mjs need one).
const fakeHome = join(dirs.tmp, "fake-home");
mkdirSync(join(fakeHome, ".codex"), { recursive: true });
writeFileSync(join(fakeHome, ".codex", "auth.json"), JSON.stringify({ tokens: "not real" }));

// Named exactly "codex" so `lead: codex` resolves through PATH the way a real spawn would. Writes
// its argv to a file hive's own PATH-lookup env can find, keyed by an env var this fake reads back
// out of its own environment (HIVE_AGENT_NAME is always "lead" for every invocation here, so the
// captured-argv file is overwritten per invocation - fine, since these tests run sequentially and
// each reads it immediately after the `hive lead` call that produced it).
const binDir = join(dirs.tmp, "codex-lead-bin");
mkdirSync(binDir, { recursive: true });
const argvFile = join(dirs.tmp, "codex-lead-argv.txt");
writeFileSync(
  join(binDir, "codex"),
  `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(argvFile)}\nsleep 600\n`,
);
chmodSync(join(binDir, "codex"), 0o755);

const postureText = "CODEX LEAD POSTURE SENTINEL {{repo}}";
mkdirSync(join(dirs.dataDir, "profiles", "orchestration"), { recursive: true });
writeFileSync(join(dirs.dataDir, "profiles", "orchestration", "posture.md"), postureText);

function newProjectDir(name) {
  const dir = join(dirs.tmp, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "hive.yml"), "lead: codex\nprofile: orchestration\n");
  return dir;
}

function seedProject(name, projectDir) {
  const project = db
    .prepare("INSERT INTO projects (name, path) VALUES (?, ?) RETURNING id")
    .get(name, projectDir);
  db.prepare("INSERT INTO command_trust (project_id, name, config_hash) VALUES (?, ?, ?)").run(
    project.id,
    "lead",
    configHash("lead", "codex", null, {}),
  );
  return project;
}

const cliOpts = (projectDir) => ({
  cwd: projectDir,
  dataDir: dirs.dataDir,
  tmp: dirs.tmp,
  env: { HOME: fakeHome, PATH: `${binDir}:${process.env.PATH}` },
});

describe("a codex lead is routed through the generated CODEX_HOME (todo 575)", { skip: hasTmux ? false : "tmux is not installed" }, () => {
  describe("a fresh spawn", () => {
    const projectDir = newProjectDir("codex-lead-fresh");
    const project = seedProject("codex-lead-fresh", projectDir);
    const session = sessionName();
    after(() => cleanup(session));

    let freshResult;

    it("wires hooks and posture through the home instead of printing the claude-only skip messages", async () => {
      freshResult = await runCli(["lead"], cliOpts(projectDir));
      assert.equal(freshResult.code, 0, freshResult.stderr);
      assert.doesNotMatch(freshResult.stdout, /skipping hooks/, "a codex lead must not take the claude-only skip path");
      assert.doesNotMatch(freshResult.stdout, /skipping profile/, "posture is delivered through the home, not skipped");

      const row = leadRow(db, project.id);
      assert.notEqual(row.codex_home, "", "a codex lead's row must record its generated home key");
      assert.ok(existsSync(codexHomeDir(row.codex_home)), "the home directory must actually exist on disk");
    });

    it("the codex home receipt line names the events actually wired in hooks.json, not a hardcoded claim (todo 782 fix round)", () => {
      const row = leadRow(db, project.id);
      const hooks = JSON.parse(readFileSync(join(codexHomeDir(row.codex_home), "hooks.json"), "utf8")).hooks;
      const expected = `- codex home: ${codexHomeDir(row.codex_home)} (${Object.keys(hooks).join("/")} hooks wired)`;
      assert.ok(
        freshResult.stdout.includes(expected),
        `expected the receipt to name the real hooks.json keys (${JSON.stringify(Object.keys(hooks))}), got stdout:\n${freshResult.stdout}`,
      );
    });

    it("appends the home's launch flags and the triage message as codex's own [PROMPT] positional, live-verified to auto-submit with no keystroke", async () => {
      const row = leadRow(db, project.id);
      assert.match(row.command, /--dangerously-bypass-hook-trust/);
      assert.match(row.command, /--dangerously-bypass-approvals-and-sandbox/);
      assert.equal(
        row.command.trim().endsWith(shellQuote(TRIAGE_MESSAGE)),
        true,
        "the triage message must be the final positional argument, matching codex's own [PROMPT] shape",
      );
    });

    it("the pane actually received the triage message as its argv, not just the stored command string", async () => {
      await until(() => existsSync(argvFile), 5000);
      const argv = readFileSync(argvFile, "utf8").split("\n").filter(Boolean);
      assert.ok(
        argv.includes(TRIAGE_MESSAGE),
        `expected TRIAGE_MESSAGE among the codex process's real argv, got: ${JSON.stringify(argv)}`,
      );
    });

    it("the generated home's config.toml carries the rendered posture as developer_instructions", async () => {
      const row = leadRow(db, project.id);
      const { parse: parseToml } = await import("smol-toml");
      const parsed = parseToml(readFileSync(join(codexHomeDir(row.codex_home), "config.toml"), "utf8"));
      assert.match(parsed.developer_instructions, /CODEX LEAD POSTURE SENTINEL/);
    });

    it("the generated home's hooks.json wires SessionStart to kickoff --codex, alongside the worker-state events", async () => {
      const row = leadRow(db, project.id);
      const hooks = JSON.parse(readFileSync(join(codexHomeDir(row.codex_home), "hooks.json"), "utf8"));
      assert.match(hooks.hooks.SessionStart[0].hooks[0].command, /kickoff\.js.*--codex/);
      assert.ok(hooks.hooks.Stop, "lead state tracking needs Stop too, same as a worker's home");
      assert.ok(hooks.hooks.UserPromptSubmit);
    });
  });

  describe("lifecycle: a restart reaps the previous home, an adopt reaps the unused new one", () => {
    const projectDir = newProjectDir("codex-lead-lifecycle");
    const project = seedProject("codex-lead-lifecycle", projectDir);
    const session = sessionName();
    after(() => cleanup(session));

    it("a restart (pane killed) builds a NEW home and reaps the old one", async () => {
      const first = await runCli(["lead"], cliOpts(projectDir));
      assert.equal(first.code, 0, first.stderr);
      const row1 = leadRow(db, project.id);
      const firstHome = row1.codex_home;
      assert.ok(existsSync(codexHomeDir(firstHome)));

      execFileSync("tmux", ["kill-window", "-t", row1.tmux_target], { stdio: "ignore" });

      const second = await runCli(["lead"], cliOpts(projectDir));
      assert.equal(second.code, 0, second.stderr);
      const row2 = leadRow(db, project.id);

      assert.notEqual(row2.codex_home, firstHome, "a fresh pane must get a fresh home key");
      assert.equal(existsSync(codexHomeDir(firstHome)), false, "the previous invocation's home must be reaped");
      assert.ok(existsSync(codexHomeDir(row2.codex_home)), "the new home must exist");
    });

    it("re-invoking hive lead while the pane is still alive adopts it, and reaps the freshly-built-but-unused home", async () => {
      const before = leadRow(db, project.id);
      const beforeHome = before.codex_home;

      const again = await runCli(["lead"], cliOpts(projectDir));
      assert.equal(again.code, 0, again.stderr);

      const after_ = leadRow(db, project.id);
      assert.equal(after_.codex_home, beforeHome, "an adopted pane keeps running under its ORIGINAL home");
      assert.equal(after_.tmux_target, before.tmux_target, "adopting must not replace the live pane");
      assert.ok(existsSync(codexHomeDir(beforeHome)), "the home actually in use must survive");
    });
  });

  describe("a home half-built when ensureCodexHome throws does not survive the throw", () => {
    const projectDir = newProjectDir("codex-lead-partial-home");
    const project = seedProject("codex-lead-partial-home", projectDir);
    const session = sessionName();
    after(() => cleanup(session));

    // No .codex/auth.json under this HOME, so ensureCodexHome's authSource check throws AFTER
    // mkdirSync(home) has already created the directory - a partial home nothing records to
    // agents.codex_home, so no reap path can ever find it by key.
    const brokenHome = join(dirs.tmp, "codex-lead-broken-home");
    mkdirSync(brokenHome, { recursive: true });

    it("hive lead fails, and the home directory it started building is gone afterward", async () => {
      const homesDir = join(dirs.dataDir, "codex-homes");
      const before = existsSync(homesDir) ? new Set(readdirSync(homesDir)) : new Set();

      const result = await runCli(["lead"], {
        cwd: projectDir,
        dataDir: dirs.dataDir,
        tmp: dirs.tmp,
        env: { HOME: brokenHome, PATH: `${binDir}:${process.env.PATH}` },
      });

      assert.notEqual(result.code, 0, "a missing codex credential must fail hive lead, not start naked");
      assert.match(result.stdout, /no codex credentials found/);

      const after_ = existsSync(homesDir) ? new Set(readdirSync(homesDir)) : new Set();
      const leaked = [...after_].filter((entry) => !before.has(entry));
      assert.deepEqual(leaked, [], `ensureCodexHome's own mkdirSync must not survive the throw it caused; leaked: ${leaked}`);
    });
  });
});

describe("a codex lead's receipt names which instruction layers (todo 787) were found", { skip: hasTmux ? false : "tmux is not installed" }, () => {
  const layersHome = join(dirs.tmp, "codex-lead-layers-home");
  mkdirSync(join(layersHome, ".codex"), { recursive: true });
  writeFileSync(join(layersHome, ".codex", "auth.json"), JSON.stringify({ tokens: "not real" }));
  writeFileSync(join(layersHome, ".codex", "AGENTS.md"), "GLOBAL SENTINEL");

  const projectDir = newProjectDir("codex-lead-layers");
  const project = seedProject("codex-lead-layers", projectDir);
  writeFileSync(join(projectDir, "CLAUDE.local.md"), "LOCAL SENTINEL");
  const session = sessionName();
  after(() => cleanup(session));

  it("prints an (instructions: global, local) phrase and writes both layers into the generated home", async () => {
    const result = await runCli(["lead"], {
      cwd: projectDir,
      dataDir: dirs.dataDir,
      tmp: dirs.tmp,
      env: { HOME: layersHome, PATH: `${binDir}:${process.env.PATH}` },
    });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /\(instructions: global, local\)/);

    const row = leadRow(db, project.id);
    const home = codexHomeDir(row.codex_home);
    assert.equal(readFileSync(join(home, "AGENTS.md"), "utf8"), "GLOBAL SENTINEL");
    const { parse: parseToml } = await import("smol-toml");
    const parsed = parseToml(readFileSync(join(home, "config.toml"), "utf8"));
    assert.match(parsed.developer_instructions, /LOCAL SENTINEL/);
  });
});
