import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { isolateTmux, leadRow, makeFakeClaude, runCli, scratchDirs, tmuxSocketUnder } from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("harness onboarding");
after(() => cleanup(sessionName()));
const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { db, migrate } = await import("../dist/db.js");
const { sessionName } = await import("../dist/tmux.js");
const { configHash } = await import("../dist/projectYml.js");
const { executableOnPath, harnessExecutable, leadExecutableProblem } = await import("../dist/harnessSetup.js");
migrate();

function fixture() {
  const f = scratchDirs();
  const home = join(f.tmp, "home");
  const bin = join(f.tmp, "bin");
  mkdirSync(home, { recursive: true });
  mkdirSync(bin);
  return { ...f, home, bin, opts: {
    cwd: f.projectDir, dataDir: f.dataDir, tmp: f.tmp, node: process.execPath,
    env: { HOME: home, PATH: bin, CODEX_HOME: join(home, ".codex"), CLAUDE_CONFIG_DIR: home, HIVE_NO_UPDATE_CHECK: "1" },
  } };
}
function executable(dir, name) {
  const file = join(dir, name);
  writeFileSync(file, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  return file;
}

describe("setup harness selection", () => {
  for (const harness of [undefined, "claude", "codex"]) {
    it(`prints ${harness ?? "default Claude"} registration and a recipe without rewriting config`, async () => {
      const f = fixture();
      if (harness !== "codex") writeFileSync(join(f.home, ".claude.json"), '{"mcpServers":{}}');
      const projectConfig = "lead: codex\nagents: [codex, claude]\n";
      writeFileSync(join(f.projectDir, "hive.yml"), projectConfig);
      mkdirSync(f.dataDir, { recursive: true });
      const globalConfig = "lead: claude\nagents: [claude]\n";
      writeFileSync(join(f.dataDir, "hive.yml"), globalConfig);
      const args = ["setup", "--dir", f.bin];
      if (harness) args.push("--harness", harness);
      const result = await runCli(args, f.opts);
      assert.equal(result.code, 0, result.stderr);
      const selected = harness ?? "claude";
      assert.match(result.stdout, new RegExp(`Setup harness: ${selected}`));
      assert.ok(result.stdout.includes(`${selected} mcp add ${selected === "claude" ? "--scope user " : ""}hive --`));
      assert.ok(result.stdout.includes(process.execPath));
      assert.ok(result.stdout.includes("/dist/index.js"));
      assert.match(result.stdout, /Effective lead: codex\nEffective workers: codex, claude/);
      assert.ok(result.stdout.includes(`lead: ${selected}\n  agents: [${selected}]`));
      assert.equal(readFileSync(join(f.projectDir, "hive.yml"), "utf8"), projectConfig);
      assert.equal(readFileSync(join(f.dataDir, "hive.yml"), "utf8"), globalConfig);
      assert.equal(existsSync(join(f.home, ".codex", "config.toml")), false);
      if (harness === "codex") assert.equal(existsSync(join(f.home, ".claude.json")), false);
      else assert.equal(readFileSync(join(f.home, ".claude.json"), "utf8"), '{"mcpServers":{}}');
    });
  }
  for (const args of [["--harness"], ["--harness", "unknown"]]) {
    it(`rejects ${args.join(" ")} before writing the dispatcher`, async () => {
      const f = fixture();
      const result = await runCli(["setup", "--dir", f.bin, ...args], f.opts);
      assert.notEqual(result.code, 0);
      assert.match(result.stdout + result.stderr, /--harness/);
      assert.equal(existsSync(join(f.bin, "hive")), false);
    });
  }
});

describe("doctor checks configured harnesses with no real CLIs on PATH", () => {
  for (const harness of ["claude", "codex"]) {
    it(`${harness}-only passes its executable check without requiring the other harness`, async () => {
      const f = fixture();
      executable(f.bin, harness);
      writeFileSync(join(f.projectDir, "hive.yml"), `lead: ${harness}\nagents: [${harness}]\n`);
      const result = await runCli(["doctor"], f.opts);
      assert.match(result.stdout, new RegExp(`ok +${harness}:`));
      const unused = harness === "codex" ? "claude" : "codex";
      assert.match(result.stdout, new RegExp(`info +${unused}: not required`));
      assert.doesNotMatch(result.stdout, /FAIL +(claude|codex):/);
      if (harness === "codex") assert.match(result.stdout, /codex credentials: .*missing; run codex login/);
    });
  }
  it("requires both harnesses for mixed configuration and detects the missing worker", async () => {
    const f = fixture();
    executable(f.bin, "codex");
    writeFileSync(join(f.projectDir, "hive.yml"), "lead: codex\nagents: [claude, codex]\n");
    const result = await runCli(["doctor", "--strict"], f.opts);
    assert.match(result.stdout, /FAIL +claude:.*not found/);
    assert.match(result.stdout, /ok +codex:/);
  });
  it("uses global harness settings and project overrides independently", async () => {
    const f = fixture();
    executable(f.bin, "codex");
    mkdirSync(f.dataDir, { recursive: true });
    writeFileSync(join(f.dataDir, "hive.yml"), "lead: codex\nagents: [codex]\n");
    const global = await runCli(["doctor"], f.opts);
    assert.match(global.stdout, /lead command=codex; workers=codex/);
    assert.doesNotMatch(global.stdout, /FAIL +claude:/);
    writeFileSync(join(f.projectDir, "hive.yml"), "lead: claude\n");
    const project = await runCli(["doctor"], f.opts);
    assert.match(project.stdout, /lead command=claude; workers=codex/);
    assert.match(project.stdout, /FAIL +claude:/);
  });
  it("keeps Claude as the required default even when only Codex is installed", async () => {
    const f = fixture();
    executable(f.bin, "codex");
    const result = await runCli(["doctor"], f.opts);
    assert.match(result.stdout, /lead command=claude; workers=claude/);
    assert.match(result.stdout, /FAIL +claude:/);
  });
});

describe("lead executable preflight", () => {
  it("resolves recognized wrapper prefixes without executing them", () => {
    assert.equal(harnessExecutable("FOO=1 nice env codex --model example"), "codex");
    for (const command of ["PATH=/other codex", "env -i codex", "my-wrapper codex", "$(touch sentinel) codex"]) {
      assert.equal(harnessExecutable(command), null, command);
    }
  });
  it("accepts absolute executables and excludes directories and non-executable files", () => {
    const f = fixture();
    const path = executable(f.bin, "codex");
    assert.equal(executableOnPath(path, f.projectDir, ""), path);
    assert.equal(leadExecutableProblem(`${path} --model example`, f.projectDir), null);
    chmodSync(path, 0o644);
    assert.equal(executableOnPath(path, f.projectDir, ""), null);
    assert.equal(executableOnPath(f.bin, f.projectDir, ""), null);
  });
  for (const harness of ["claude", "codex"]) {
    it(`rejects a missing ${harness} lead before an agent row or tmux socket is created`, async () => {
      const f = fixture();
      const project = db.prepare("INSERT INTO projects (name, path) VALUES (?, ?) RETURNING id")
        .get(`missing-${harness}`, f.projectDir);
      const command = join(f.bin, harness);
      writeFileSync(join(f.projectDir, "hive.yml"), `lead: ${command}\nagents: [${harness}]\n`);
      db.prepare("INSERT INTO command_trust (project_id, name, config_hash) VALUES (?, ?, ?)")
        .run(project.id, "lead", configHash("lead", command, null, {}));
      const result = await runCli(["lead", "--detach"], { ...f.opts, dataDir: dirs.dataDir });
      assert.notEqual(result.code, 0);
      assert.match(result.stdout + result.stderr, /lead executable .* was not found or is not executable/);
      assert.ok((result.stdout + result.stderr).includes(command));
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM agents WHERE project_id = ?").get(project.id).n, 0);
      assert.equal(existsSync(tmuxSocketUnder(process.env.TMUX_TMPDIR)), false);
    });
  }
  it("checks the default Claude fallback when a configured lead is not trusted", async () => {
    const f = fixture();
    writeFileSync(join(f.projectDir, "hive.yml"), "lead: codex\n");
    const result = await runCli(["lead"], f.opts);
    assert.match(result.stdout, /Using the default claude lead instead/);
    assert.match(result.stdout + result.stderr, /lead executable "claude" was not found/);
  });
});


it("adopts an owned live lead after its executable is removed, but refuses to restart it", { skip: !hasTmux }, async () => {
  const f = fixture();
  const command = makeFakeClaude(f.tmp)("sleep 600");
  writeFileSync(join(f.projectDir, "hive.yml"), `lead: ${command}\n`);
  const project = db.prepare("INSERT INTO projects (name, path) VALUES (?, ?) RETURNING id").get("adopt-lead", f.projectDir);
  db.prepare("INSERT INTO command_trust (project_id, name, config_hash) VALUES (?, ?, ?)")
    .run(project.id, "lead", configHash("lead", command, null, {}));
  const opts = { ...f.opts, dataDir: dirs.dataDir, env: { ...f.opts.env, PATH: process.env.PATH } };
  const first = await runCli(["lead", "--detach"], opts);
  assert.equal(first.code, 0, first.stdout + first.stderr);
  const original = leadRow(db, project.id);
  rmSync(command);
  const adopted = await runCli(["lead", "--detach"], opts);
  assert.equal(adopted.code, 0, adopted.stdout + adopted.stderr);
  assert.equal(leadRow(db, project.id).tmux_target, original.tmux_target);
  assert.equal(leadRow(db, project.id).pane_pid, original.pane_pid);
  cleanup(sessionName());
  const restart = await runCli(["lead", "--detach"], opts);
  assert.notEqual(restart.code, 0);
  assert.match(restart.stdout + restart.stderr, /lead executable .* was not found/);
});
