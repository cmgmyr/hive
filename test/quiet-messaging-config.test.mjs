import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { assertScratchStore, clearHiveEnv, isolateTmux, leadRow, makeFakeClaude, runCli, scratchDirs, seedLeadProject } from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("the quiet_messaging config tests");
clearHiveEnv();
const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
await assertScratchStore();

const { db, migrate } = await import("../dist/db.js");
migrate();
const { loadProjectYml, quietMessagingEnabled } = await import("../dist/projectYml.js");
const { quietMessagingOn } = await import("../dist/claudeWake.js");
const { ensureHooksFile, ensureLeadHooksFile, ensureWorkerHooksFile } = await import("../dist/hooks.js");
const { sessionName } = await import("../dist/tmux.js");

const globalPath = join(dirs.dataDir, "hive.yml");
let projectCount = 0;
function resolve({ global, project }) {
  rmSync(globalPath, { force: true });
  if (global !== undefined) writeFileSync(globalPath, global);
  const dir = join(dirs.tmp, `cfg-${projectCount++}`);
  mkdirSync(dir, { recursive: true });
  if (project !== undefined) writeFileSync(join(dir, "hive.yml"), project);
  try {
    return loadProjectYml(dir);
  } finally {
    rmSync(globalPath, { force: true });
  }
}

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

const needsTmux = { skip: hasTmux ? false : "tmux is not installed" };
after(() => cleanup(sessionName()));

describe("quiet_messaging resolves on by default", () => {
  it("defaults to on with no hive.yml, and null resets to the built-in default", () => {
    const absent = resolve({ project: "dashboard: true\n" });
    assert.equal(absent.config.quiet_messaging, true);
    assert.equal(absent.sources.quiet_messaging, "built-in");
    assert.equal(resolve({ project: "quiet_messaging: false\n" }).config.quiet_messaging, false);
    assert.equal(resolve({ project: "quiet_messaging: null\n" }).config.quiet_messaging, true);
    assert.equal(quietMessagingEnabled(null), true);
    const noConfigDir = join(dirs.tmp, "quiet-no-file");
    mkdirSync(noConfigDir, { recursive: true });
    const projectId = db.prepare("INSERT INTO projects (name, path) VALUES ('quiet-no-file', ?) RETURNING id").get(noConfigDir).id;
    assert.equal(quietMessagingOn(projectId), true);
  });

  it("warns on a non-boolean value and falls back to the default", () => {
    for (const value of ["yes-please", "1", "\"true\""]) {
      const loaded = resolve({ project: `quiet_messaging: ${value}\n` });
      assert.equal(loaded.config.quiet_messaging, true, value);
      assert.ok(loaded.warnings.some((w) => w.includes("quiet_messaging must be true or false")), JSON.stringify(loaded.warnings));
    }
  });

  it("turns on from the global file, and a project false overrides a global true", () => {
    const globalOn = resolve({ global: "quiet_messaging: true\n" });
    assert.equal(globalOn.config.quiet_messaging, true);
    assert.equal(globalOn.sources.quiet_messaging, "global");
    assert.equal(resolve({ global: "quiet_messaging: true\n", project: "quiet_messaging: false\n" }).config.quiet_messaging, false);
    assert.equal(resolve({ global: "quiet_messaging: true\n", project: "quiet_messaging: null\n" }).config.quiet_messaging, true);
    const projectOn = resolve({ project: "quiet_messaging: true\n" });
    assert.equal(projectOn.config.quiet_messaging, true);
    assert.equal(projectOn.sources.quiet_messaging, "project");
  });
});

describe("the generated lead settings file", () => {
  it("off returns the store-wide hooks.json, which carries no inbound setting and no SessionStart", () => {
    const path = ensureLeadHooksFile(41, false);
    assert.equal(path, ensureHooksFile());
    assert.equal(path, join(dirs.dataDir, "hooks.json"));
    const settings = readJson(path);
    assert.equal("crossSessionInbound" in settings, false);
    assert.equal("SessionStart" in settings.hooks, false);
  });

  it("on writes a per-project file that accepts inbound peers and wires SessionStart beside the state hooks", () => {
    const path = ensureLeadHooksFile(42, true);
    assert.equal(path, join(dirs.dataDir, "lead-42-hooks.json"));
    const settings = readJson(path);
    assert.equal(settings.crossSessionInbound, "accept");
    for (const event of ["Stop", "UserPromptSubmit", "Notification", "SessionEnd"]) {
      assert.deepEqual(settings.hooks[event], readJson(ensureHooksFile()).hooks[event], event);
    }
    assert.match(settings.hooks.SessionStart[0].hooks[0].command, / session_start$/);
  });

  it("one project opting in never changes another project's or the store-wide file", () => {
    ensureLeadHooksFile(43, true);
    const off = readJson(ensureLeadHooksFile(44, false));
    assert.equal("crossSessionInbound" in off, false);
    assert.equal(existsSync(join(dirs.dataDir, "lead-44-hooks.json")), false);
    assert.equal(readJson(join(dirs.dataDir, "lead-43-hooks.json")).crossSessionInbound, "accept");
  });

  it("a worker's generated settings still refuse inbound peers after a lead opted in", () => {
    ensureLeadHooksFile(45, true);
    const projectId = db.prepare("INSERT INTO projects (name, path) VALUES ('worker-refuse', ?) RETURNING id").get(dirs.tmp).id;
    const workerId = db
      .prepare(
        `INSERT INTO agents (project_id, actor_id, name, kind, tmux_target, command, cwd, status)
         VALUES (?, 'agent:qlw-worker', 'qlw-worker', 'agent', '%1', 'claude', ?, 'running') RETURNING id`,
      )
      .get(projectId, dirs.tmp).id;
    const settings = readJson(ensureWorkerHooksFile(workerId, { includePostToolUse: false }));
    assert.equal(settings.crossSessionInbound, "refuse");
    assert.equal("SessionStart" in settings.hooks, false);
  });
});

describe("hive lead launches a claude lead with the settings its key selects", () => {
  const leadBin = makeFakeClaude(dirs.tmp)();

  it("an opted-in project's lead command names its own accept file; an off project's names hooks.json", needsTmux, async () => {
    const on = await seedLeadProject(db, { root: dirs.tmp, name: "qlw-on", leadBin, processes: {}, yml: `lead: ${leadBin}\nquiet_messaging: true\n` });
    const off = await seedLeadProject(db, { root: dirs.tmp, name: "qlw-off", leadBin, processes: {}, yml: `lead: ${leadBin}\nquiet_messaging: false\n` });
    for (const project of [on, off]) {
      const result = await runCli(["lead", "--detach"], { cwd: project.dir, dataDir: dirs.dataDir, tmp: dirs.tmp });
      assert.equal(result.code, 0, result.stderr + result.stdout);
    }
    const onCommand = leadRow(db, on.id).command;
    const offCommand = leadRow(db, off.id).command;
    assert.ok(onCommand.includes(join(dirs.dataDir, `lead-${on.id}-hooks.json`)), onCommand);
    assert.ok(offCommand.includes(join(dirs.dataDir, "hooks.json")), offCommand);
    assert.equal(offCommand.includes("lead-"), false, offCommand);
    assert.equal(readJson(join(dirs.dataDir, `lead-${on.id}-hooks.json`)).crossSessionInbound, "accept");
    assert.equal(existsSync(join(dirs.dataDir, `lead-${off.id}-hooks.json`)), false);
  });
});
