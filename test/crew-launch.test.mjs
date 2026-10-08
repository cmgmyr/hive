import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { clearHiveEnv, isolateTmux, McpClient, REPO, runCli, scratchDirs, scratchGit, until } from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("the crew launch tests");
clearHiveEnv();
const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { db, migrate } = await import("../dist/db.js");
migrate();
const { loadProjectYml } = await import("../dist/projectYml.js");
const { configHash } = await import("../dist/projectYml.js");
const { sessionName } = await import("../dist/tmux.js");
after(() => cleanup(sessionName()));

const fakeHome = join(dirs.tmp, "fake-home");
mkdirSync(join(fakeHome, ".codex"), { recursive: true });
writeFileSync(join(fakeHome, ".codex", "auth.json"), JSON.stringify({ tokens: "not real" }));

const binDir = join(dirs.tmp, "crew-launch-bin");
mkdirSync(binDir, { recursive: true });
const argvFile = join(dirs.tmp, "argv.bin");
for (const name of ["claude", "codex"]) {
  const temp = join(dirs.tmp, `${name}-argv.tmp`);
  writeFileSync(
    join(binDir, name),
    `#!/bin/sh\nprintf '%s\\0' "$@" > ${JSON.stringify(temp)}\nmv ${JSON.stringify(temp)} ${JSON.stringify(argvFile)}\nsleep 600\n`,
  );
  chmodSync(join(binDir, name), 0o755);
}

const globalPath = join(dirs.dataDir, "hive.yml");
let seq = 0;
function resolve({ global, project }) {
  rmSync(globalPath, { force: true });
  if (global !== undefined) writeFileSync(globalPath, global);
  const dir = join(dirs.tmp, `cfg-${seq++}`);
  mkdirSync(dir, { recursive: true });
  if (project !== undefined) writeFileSync(join(dir, "hive.yml"), project);
  try {
    return loadProjectYml(dir);
  } finally {
    rmSync(globalPath, { force: true });
  }
}

async function startLead(yml, { trustLead } = {}) {
  if (existsSync(argvFile)) unlinkSync(argvFile);
  const dir = join(dirs.tmp, `lead-${seq++}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "hive.yml"), yml);
  if (trustLead) {
    const project = db.prepare("INSERT INTO projects (name, path) VALUES (?, ?) RETURNING id").get(`lead-${seq}`, dir);
    db.prepare("INSERT INTO command_trust (project_id, name, config_hash) VALUES (?, ?, ?)").run(
      project.id,
      "lead",
      configHash("lead", trustLead, null, {}),
    );
  }
  const result = await runCli(["lead", dir, "--detach"], {
    cwd: dir,
    dataDir: dirs.dataDir,
    tmp: dirs.tmp,
    env: { HOME: fakeHome, PATH: `${binDir}:${process.env.PATH}` },
  });
  assert.equal(result.code, 0, result.stderr);
  assert.ok(await until(() => existsSync(argvFile), 5000), "the fake lead never ran");
  return { argv: readFileSync(argvFile, "utf8").split("\0").slice(0, -1), dir };
}

const withoutPaths = (argv) => argv.map((a) => a.replaceAll(dirs.dataDir, "<data>").replaceAll(/lead-\d+/g, "<lead>"));

describe("lead_sidebar config key", () => {
  it("boolean layering records source and invalid type warns", () => {
    const absent = resolve({ project: "dashboard: true\n" });
    assert.equal(absent.config.lead_sidebar, false);
    assert.equal(absent.sources.lead_sidebar, "built-in");
    assert.equal(resolve({ project: "lead_sidebar: null\n" }).config.lead_sidebar, false);
    const global = resolve({ global: "lead_sidebar: true\n" });
    assert.equal(global.config.lead_sidebar, true);
    assert.equal(global.sources.lead_sidebar, "global");
    assert.equal(resolve({ global: "lead_sidebar: true\n", project: "lead_sidebar: false\n" }).config.lead_sidebar, false);
    const project = resolve({ project: "lead_sidebar: true\n" });
    assert.equal(project.sources.lead_sidebar, "project");
    for (const bad of ["yes-please", "1", '"true"']) {
      const loaded = resolve({ project: `lead_sidebar: ${bad}\n` });
      assert.equal(loaded.config.lead_sidebar, false, bad);
      assert.ok(loaded.warnings.some((w) => w.includes("lead_sidebar must be true or false")), JSON.stringify(loaded.warnings));
    }
  });
});

describe("hive lead --plugin-dir for the crew mod", { skip: hasTmux ? false : "tmux is not installed" }, () => {
  it("absent false null keep lead argv unchanged", async () => {
    const absent = await startLead("dashboard: false\n");
    const off = await startLead("lead_sidebar: false\n");
    const nul = await startLead("lead_sidebar:\n");
    for (const { argv } of [absent, off, nul]) assert.equal(argv.includes("--plugin-dir"), false);
    assert.deepEqual(withoutPaths(off.argv), withoutPaths(absent.argv));
    assert.deepEqual(withoutPaths(nul.argv), withoutPaths(absent.argv));
  });

  it("true adds installed plugin only to Claude lead", async () => {
    const off = await startLead("dashboard: false\n");
    const on = await startLead("lead_sidebar: true\n");
    const at = on.argv.indexOf("--plugin-dir");
    assert.notEqual(at, -1, JSON.stringify(on.argv));
    const dir = on.argv[at + 1];
    assert.equal(dir, join(REPO, "claude-plugin", "crew"));
    assert.equal(JSON.parse(readFileSync(join(dir, ".claude-plugin", "plugin.json"), "utf8")).name, "hive-crew");
    assert.equal(on.argv.filter((a) => a === "--plugin-dir").length, 1);
    const stripped = on.argv.filter((_, i) => i !== at && i !== at + 1);
    assert.deepEqual(withoutPaths(stripped), withoutPaths(off.argv));
  });

  it("workers Codex custom leads never get mod argv", async () => {
    const codex = await startLead("lead: codex\nlead_sidebar: true\n", { trustLead: "codex" });
    assert.equal(codex.argv.includes("--plugin-dir"), false, JSON.stringify(codex.argv));

    scratchGit(dirs.projectDir, "init", "-q");
    scratchGit(dirs.projectDir, "commit", "-q", "--allow-empty", "-m", "root");
    writeFileSync(join(dirs.projectDir, "hive.yml"), "lead_sidebar: true\n");
    unlinkSync(argvFile);
    const mcp = new McpClient({
      cwd: dirs.projectDir,
      dataDir: dirs.dataDir,
      env: { HIVE_SPAWN_READY_MS: "1", HOME: fakeHome, PATH: `${binDir}:${process.env.PATH}` },
    });
    await mcp.start();
    try {
      await mcp.call("agent_spawn", { name: "sidebar-worker", harness: "claude" });
      assert.ok(await until(() => existsSync(argvFile), 5000), "the fake worker never ran");
      const argv = readFileSync(argvFile, "utf8").split("\0").slice(0, -1);
      assert.equal(argv.includes("--plugin-dir"), false, JSON.stringify(argv));
    } finally {
      await mcp.close();
    }
  });
});
