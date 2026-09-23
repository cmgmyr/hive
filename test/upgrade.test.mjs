import assert from "node:assert/strict";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { DIST, installedVersion, isolateTmux, REPO, runNode, scratchDirs } from "./helpers.mjs";

const { cleanup } = isolateTmux("the upgrade tests");
after(() => cleanup());
const dirs = scratchDirs();

function npmRootCommand(root) {
  const bin = mkdtempSync(join(dirs.tmp, "npm-"));
  const file = join(bin, "npm");
  writeFileSync(file, `#!/bin/sh\nprintf '%s\\n' '${root.replaceAll("'", "'\\''")}'\n`);
  chmodSync(file, 0o755);
  return file;
}

describe("upgrade install identity and steps", () => {
  it("accepts ordinary and linked checkouts before querying npm, even beneath node_modules", async () => {
    const { detectInstallShape } = await import("../dist/upgrade.js");
    for (const kind of ["directory", "file"]) {
      const root = join(mkdtempSync(join(dirs.tmp, "checkout-")), "node_modules/@cmgmyr/hive");
      mkdirSync(root, { recursive: true });
      if (kind === "file") writeFileSync(join(root, ".git"), "gitdir: /not-consulted");
      else mkdirSync(join(root, ".git"));
      assert.deepEqual(detectInstallShape(join(root, "dist/cli.js"), "/missing-npm"), { kind: "checkout", packageRoot: root });
    }
  });

  it("requires canonical global ownership and accepts a symlinked prefix", async () => {
    const { detectInstallShape } = await import("../dist/upgrade.js");
    const root = mkdtempSync(join(dirs.tmp, "prefix-"));
    const npmRoot = join(root, "lib/node_modules");
    const packageRoot = join(npmRoot, "@cmgmyr/hive");
    mkdirSync(packageRoot, { recursive: true });
    const alias = `${root}-alias`;
    symlinkSync(root, alias);
    const npm = npmRootCommand(join(alias, "lib/node_modules"));
    assert.equal(detectInstallShape(join(packageRoot, "dist/cli.js"), npm).kind, "global");
    for (const suffix of ["_npx/123/node_modules/@cmgmyr/hive", "copy"]) {
      const copied = join(root, suffix);
      mkdirSync(copied, { recursive: true });
      assert.deepEqual(detectInstallShape(join(copied, "dist/cli.js"), npm), {
        kind: "unknown", cli: join(copied, "dist/cli.js"), packageRoot: copied,
        gitState: "absent", npmRoot: join(alias, "lib/node_modules"),
        reason: "npm root -g does not own the running package",
      });
    }
  });

  it("retains npm failure and observed paths for unknown installs", async () => {
    const { detectInstallShape } = await import("../dist/upgrade.js");
    const result = detectInstallShape(join(dirs.tmp, "copy/dist/cli.js"), "/missing-npm");
    assert.equal(result.kind, "unknown");
    assert.equal(result.npmRoot, null);
    assert.match(result.reason, /ENOENT/);
    assert.equal(result.gitState, "absent");
  });

  it("describes exact ordered argv and pins the new CLI with the explicit interpreter", async () => {
    const { checkoutUpgradeSteps, globalUpgradeSteps } = await import("../dist/upgrade.js");
    const root = "/scratch/package with spaces";
    const node = "/scratch/node";
    assert.deepEqual(checkoutUpgradeSteps(root, node), [
      { label: "pull", command: "git", args: ["pull", "--ff-only"], cwd: root },
      { label: "install", command: "npm", args: ["install"], cwd: root },
      { label: "build", command: "npm", args: ["run", "build"], cwd: root },
      { label: "setup", command: node, args: [join(root, "dist/cli.js"), "setup"], cwd: root },
    ]);
    assert.deepEqual(globalUpgradeSteps({ kind: "global", packageRoot: "/old/canonical", npmRoot: root, npmCommand: "npm" }, node), [
      { label: "install", command: "npm", args: ["install", "-g", "@cmgmyr/hive@latest"] },
      { label: "setup", command: node, args: [join(root, "@cmgmyr/hive/dist/cli.js"), "setup"] },
    ]);
  });
});

function cliFixture({ checkout = false, latest = "9.9.9", fail = null, signal = false, unknown = false } = {}) {
  const root = mkdtempSync(join(dirs.tmp, "cli-"));
  const npmRoot = join(root, "prefix/lib/node_modules");
  const packageRoot = join(npmRoot, "@cmgmyr/hive");
  mkdirSync(packageRoot, { recursive: true });
  cpSync(DIST, join(packageRoot, "dist"), { recursive: true });
  cpSync(join(REPO, "package.json"), join(packageRoot, "package.json"));
  symlinkSync(join(REPO, "node_modules"), join(packageRoot, "node_modules"));
  if (checkout) mkdirSync(join(packageRoot, ".git"));
  const cli = join(packageRoot, "dist/cli.js");
  const log = join(root, "calls.jsonl");
  const bin = join(root, "commands");
  mkdirSync(bin);
  const next = join(root, "new-cli.js");
  writeFileSync(next, readFileSync(cli, "utf8").replace("#!/usr/bin/env node", `#!/usr/bin/env node
import { appendFileSync as recordUpgradeStep } from "node:fs";
recordUpgradeStep(${JSON.stringify(log)}, JSON.stringify(["new setup", process.execPath, process.argv.slice(2)]) + "\\n");
${fail === "setup" ? 'console.error("setup child failed"); process.exit(23);' : ''}`));
  for (const command of ["npm", "git"]) {
    const script = join(bin, `${command}.mjs`);
    writeFileSync(script, `import { appendFileSync, copyFileSync } from "node:fs";
const args = process.argv.slice(2);
if (${JSON.stringify(command)} === "git" && args[0] !== "pull") process.exit(1);
appendFileSync(${JSON.stringify(log)}, JSON.stringify([${JSON.stringify(command)}, ...args]) + "\\n");
if (args[0] === "root") { console.log(${JSON.stringify(unknown ? join(root, "other/node_modules") : npmRoot)}); }
else if (args[0] === "view") { console.log(${JSON.stringify(latest)}); }
else {
  const label = args[0] === "run" ? "build" : args[0];
  if (label === ${JSON.stringify(fail)}) {
    console.error(label + " child failed");
    ${signal ? 'process.kill(process.pid, "SIGTERM");' : 'process.exit(19);'}
  }
  if (label === "install" || label === "build") copyFileSync(${JSON.stringify(next)}, ${JSON.stringify(cli)});
}`);
    writeFileSync(join(bin, command), `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' '${script}' "$@"\n`);
    chmodSync(join(bin, command), 0o755);
  }
  const config = join(root, "claude");
  const codex = join(root, "codex");
  mkdirSync(config);
  mkdirSync(codex);
  const claudeFile = join(config, ".claude.json");
  const codexFile = join(codex, "config.toml");
  const old = join(root, "old/dist/index.js");
  mkdirSync(dirname(old), { recursive: true });
  writeFileSync(old, "");
  writeFileSync(claudeFile, JSON.stringify({ mcpServers: { hive: { command: process.execPath, args: [old] } } }));
  writeFileSync(codexFile, `[mcp_servers.hive]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(old)}]\n`);
  const beforeConfigs = [claudeFile, codexFile].map(p => readFileSync(p, "utf8"));
  const data = join(root, "data");
  const shim = join(root, "bin/hive");
  const env = {
    PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
    HIVE_BIN_DIR: dirname(shim), CLAUDE_CONFIG_DIR: config, CODEX_HOME: codex,
    NPM_CONFIG_PREFIX: join(root, "prefix"), HIVE_NO_UPDATE_CHECK: "0",
  };
  return {
    cli, root, data, shim, log, packageRoot, env,
    run: args => runNode(cli, ["upgrade", ...args], { cwd: root, dataDir: data, node: process.execPath, env }),
    calls: () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map(JSON.parse) : [],
    configsUnchanged: () => assert.deepEqual([claudeFile, codexFile].map(p => readFileSync(p, "utf8")), beforeConfigs),
  };
}

describe("hive upgrade CLI", () => {
  it("rejects invalid arguments before any npm or git child", async () => {
    const f = cliFixture();
    for (const args of [["--wat"], ["--prefix"], ["--check", "--run"], ["1.2.3"], ["--check=true"]]) {
      const r = await f.run(args);
      assert.equal(r.code, 1, r.stdout + r.stderr);
      assert.deepEqual(f.calls(), []);
    }
  });

  it("refuses unknown ownership and global --run before install or setup", async () => {
    for (const unknown of [false, true]) {
      const f = cliFixture({ unknown });
      const r = await f.run(unknown ? [] : ["--run"]);
      assert.equal(r.code, 1);
      assert.deepEqual(f.calls(), [["npm", "root", "-g"]]);
      if (unknown) {
        for (const text of [f.cli, f.packageRoot, ".git: absent", "npm root -g:"]) assert.ok(r.stderr.includes(text));
      }
    }
  });

  it("global --check prints both commands without install, setup, config or cache changes", async () => {
    const f = cliFixture();
    const r = await f.run(["--check"]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /npm install -g @cmgmyr\/hive@latest/);
    assert.ok(r.stdout.includes(join(f.packageRoot, "dist/cli.js")));
    assert.deepEqual(f.calls(), [["npm", "root", "-g"], ["npm", "view", "@cmgmyr/hive", "version"]]);
    assert.equal(existsSync(f.shim), false);
    assert.equal(existsSync(join(f.data, "update-check.json")), false);
    f.configsUnchanged();
  });

  it("already-current, older-than-installed, and unknown registry results never install or setup", async () => {
    for (const [latest, code, message] of [
      [installedVersion(), 0, /up to date/],
      ["0.0.1", 0, /up to date/],
      ["invalid", 1, /not upgrading: could not read the latest version/],
    ]) {
      const f = cliFixture({ latest });
      const r = await f.run([]);
      assert.equal(r.code, code);
      assert.match(r.stdout + r.stderr, message);
      assert.equal(f.calls().length, 2);
      assert.equal(existsSync(f.shim), false);
      assert.equal(existsSync(join(f.data, "update-check.json")), false);
      f.configsUnchanged();
    }
  });

  it("global upgrade starts newly installed setup, pins its CLI, reports both drifts and restarts", async () => {
    const f = cliFixture();
    const r = await f.run([]);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.deepEqual(f.calls().slice(2), [["npm", "install", "-g", "@cmgmyr/hive@latest"], ["new setup", process.execPath, ["setup"]]]);
    const shim = readFileSync(f.shim, "utf8");
    assert.ok(shim.includes(f.cli));
    assert.ok(shim.includes(process.execPath));
    assert.ok(r.stdout.includes(`claude mcp add --scope user hive -- "${process.execPath}" "${join(f.packageRoot, "dist/index.js")}"`));
    assert.ok(r.stdout.includes(`codex mcp remove hive`));
    assert.ok(r.stdout.includes(`codex mcp add hive -- "${process.execPath}" "${join(f.packageRoot, "dist/index.js")}"`));
    assert.match(r.stdout, /Restart every Claude Code or Codex session/);
    f.configsUnchanged();
  });

  it("install exit or signal preserves output, stops setup and names partial-state recovery", async () => {
    for (const signal of [false, true]) {
      const f = cliFixture({ fail: "install", signal });
      const r = await f.run([]);
      assert.equal(r.code, 1);
      assert.match(r.stderr, /install child failed/);
      assert.match(r.stderr, signal ? /signal SIGTERM/ : /exit 19/);
      assert.match(r.stderr, /partially changed/);
      assert.match(r.stderr, /hive doctor --strict/);
      assert.ok(r.stderr.includes(f.cli));
      assert.equal(f.calls().length, 3);
      assert.equal(existsSync(f.shim), false);
    }
  });

  it("setup failure reports the new package and unconfirmed pin, with explicit repair", async () => {
    const f = cliFixture({ fail: "setup" });
    const r = await f.run([]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /setup child failed/);
    assert.match(r.stderr, /package is new, but the dispatcher was not confirmed re-pinned/);
    assert.ok(r.stderr.includes(f.cli));
    assert.ok(r.stderr.includes(process.execPath));
    assert.match(r.stderr, /Restart every Claude Code or Codex session/);
    assert.equal(f.calls().at(-1)[0], "new setup");
  });

  it("checkout default and --check print all steps without running a child", async () => {
    const f = cliFixture({ checkout: true });
    for (const args of [[], ["--check"]]) {
      const r = await f.run(args);
      assert.equal(r.code, 0, r.stderr);
      for (const text of ["git pull --ff-only", "npm install", "npm run build", f.cli, process.execPath]) assert.ok(r.stdout.includes(text));
      assert.deepEqual(f.calls(), []);
      assert.equal(existsSync(f.shim), false);
      f.configsUnchanged();
    }
  });

  it("checkout --run executes all steps and stops every later step on failure", async () => {
    for (const fail of [null, "pull", "install", "build", "setup"]) {
      const f = cliFixture({ checkout: true, fail });
      const r = await f.run(["--run"]);
      assert.equal(r.code, fail ? 1 : 0, r.stdout + r.stderr);
      const expected = [["git", "pull", "--ff-only"], ["npm", "install"], ["npm", "run", "build"], ["new setup", process.execPath, ["setup"]]];
      const count = fail ? ["pull", "install", "build", "setup"].indexOf(fail) + 1 : 4;
      assert.deepEqual(f.calls(), expected.slice(0, count));
      if (fail) assert.match(r.stderr, /Remaining recipe not run:/);
      else assert.ok(readFileSync(f.shim, "utf8").includes(f.cli));
      f.configsUnchanged();
    }
  });
});
