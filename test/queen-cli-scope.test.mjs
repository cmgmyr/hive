import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";

import { clearHiveEnv, isolateTmux, makeFakeClaude, runCli, scratchDirs } from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("the queen CLI scope tests");

clearHiveEnv();
const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { db, migrate } = await import("../dist/db.js");
const { QUEEN_REFUSAL } = await import("../dist/context.js");
const { sessionName } = await import("../dist/tmux.js");
migrate();
after(() => cleanup(sessionName()));

function project(name, path) {
  mkdirSync(path, { recursive: true });
  const real = realpathSync(path);
  return { id: db.prepare("INSERT INTO projects (name, path) VALUES (?, ?) RETURNING id").get(name, real).id, path: real };
}

function leadActor(projectId) {
  const id = db
    .prepare("INSERT INTO agents (project_id, name, command, cwd, kind, tmux_target) VALUES (?, 'lead', 'claude', '/', 'lead', '%none') RETURNING id")
    .get(projectId).id;
  db.prepare("UPDATE agents SET actor_id = ? WHERE id = ?").run(`lead:${id}`, id);
  db.prepare("INSERT OR IGNORE INTO actors (id, name, kind) VALUES (?, 'lead', 'lead')").run(`lead:${id}`);
  return `lead:${id}`;
}

const queen = project("queen", join(dirs.dataDir, "queen"));
const alpha = project("alpha", join(dirs.tmp, "alpha"));
const beta = project("beta", join(dirs.tmp, "beta"));
writeFileSync(join(alpha.path, "hive.yml"), "processes:\n  web:\n    command: sleep 600\n    auto_start: false\n");
const queenActor = leadActor(queen.id);
const betaActor = leadActor(beta.id);
db.prepare("INSERT INTO pads (project_id, name, content, updated_by) VALUES (?, 'board', 'seed', 'lead:0')").run(alpha.id);

const claudePath = makeFakeClaude(dirs.tmp)("sleep 600");
const as = (actorId, cwd) => ({
  cwd,
  dataDir: dirs.dataDir,
  tmp: dirs.tmp,
  env: { HIVE_AGENT_ID: actorId, HIVE_LEAD: "1", PATH: `${dirname(claudePath)}:${process.env.PATH}` },
});

function tmuxWindowCount() {
  try {
    return execFileSync("tmux", ["list-windows", "-a", "-F", "#{window_id}"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .split("\n")
      .filter(Boolean).length;
  } catch {
    return 0;
  }
}

const storeState = () => ({
  pad: db.prepare("SELECT revision, content FROM pads WHERE project_id = ? AND name = 'board'").get(alpha.id),
  agents: db.prepare("SELECT id, kind, status FROM agents ORDER BY id").all(),
  projects: db.prepare("SELECT id, path FROM projects ORDER BY id").all(),
  windows: tmuxWindowCount(),
});

const foreignVerbs = [
  ["hive attach", (p) => ["attach", ...p]],
  ["hive start", (p) => ["start", "web", ...p]],
  ["hive stop", (p) => ["stop", "web", ...p]],
  ["hive stop", (p) => ["stop", "--all", ...p]],
  ["hive show", (p) => ["show", "web", ...p]],
  ["hive hide", (p) => ["hide", "web", ...p]],
  ["hive init", (p) => ["init", ...p, "--no-profile"]],
];

describe("the queen's CLI reach into another project", { skip: hasTmux ? false : "tmux is not installed" }, () => {
  for (const [op, argv] of foreignVerbs) {
    for (const [how, pathArgs, cwd] of [
      ["an explicit foreign path", [alpha.path], queen.path],
      ["a foreign cwd", [], alpha.path],
    ]) {
      it(`refuses ${argv([]).slice(0, 2).join(" ")} from the queen via ${how}, leaving the store and tmux unchanged`, async () => {
        const before = storeState();
        const run = await runCli(argv(pathArgs), as(queenActor, cwd));
        assert.notEqual(run.code, 0, run.stdout);
        assert.match(run.stdout, new RegExp(`${QUEEN_REFUSAL}: the queen cannot run ${op} in project ${alpha.id}`));
        assert.deepEqual(storeState(), before);
        assert.equal(existsSync(join(alpha.path, ".hive")), false, `${op} must not create alpha's .hive directory`);
      });
    }
  }

  it("refuses hive pad --save into another project before reading the export", async () => {
    const before = storeState();
    const run = await runCli(["pad", "board", "--save", "/nonexistent-export.md"], as(queenActor, alpha.path));
    assert.notEqual(run.code, 0);
    assert.match(run.stdout, new RegExp(`${QUEEN_REFUSAL}: the queen cannot run hive pad --save in project ${alpha.id}`));
    assert.deepEqual(storeState(), before);
  });

  it("refuses hive init on an unregistered directory, registering and writing nothing", async () => {
    const fresh = realpathSync(mkdtempSync(join(dirs.tmp, "fresh-")));
    const before = storeState();
    const run = await runCli(["init", fresh, "--no-profile"], as(queenActor, queen.path));
    assert.notEqual(run.code, 0);
    assert.match(run.stdout, new RegExp(`${QUEEN_REFUSAL}: the queen cannot run hive init outside the queen's own project`));
    assert.deepEqual(storeState(), before);
    assert.equal(existsSync(join(fresh, "hive.yml")), false);
  });

  it("lets an ordinary lead run the same verbs against another project, as before", async () => {
    const run = await runCli(["stop", "--all", alpha.path], as(betaActor, beta.path));
    assert.equal(run.code, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /No processes are running/);
  });

  it("lets the queen run its own verbs in its own home", async () => {
    const run = await runCli(["stop", "--all"], as(queenActor, queen.path));
    assert.equal(run.code, 0, run.stdout + run.stderr);
  });

  it("lets the queen start another project's lead with hive lead <path>, and a retry adopts it", async () => {
    const runningLeads = () =>
      db.prepare("SELECT id, tmux_target FROM agents WHERE project_id = ? AND kind = 'lead' AND status = 'running'").all(alpha.id);
    const first = await runCli(["lead", alpha.path, "--no-dashboard"], as(queenActor, queen.path));
    assert.equal(first.code, 0, first.stdout + first.stderr);
    const started = runningLeads();
    assert.equal(started.length, 1);

    const retry = await runCli(["lead", alpha.path, "--no-dashboard"], as(queenActor, queen.path));
    assert.equal(retry.code, 0, retry.stdout + retry.stderr);
    assert.deepEqual(runningLeads(), started);
  });
});
