import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { after, describe, it } from "node:test";

import { clearHiveEnv, DIST, isolateTmux, makeFakeClaude, panesIn, runCli, runNode, scratchDirs, tmux, windowFor } from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("the hive queen command tests");

clearHiveEnv();

const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { db, migrate } = await import("../dist/db.js");
const { sessionName } = await import("../dist/tmux.js");
migrate();

after(() => {
  let sessions = [];
  try {
    sessions = tmux("list-sessions", "-F", "#{session_name}").split("\n").filter(Boolean);
  } catch {
    sessions = [];
  }
  cleanup(...sessions);
});

const claudePath = makeFakeClaude(dirs.tmp)("sleep 600");
const cliOpts = (dataDir, cwd = dirs.projectDir) => ({
  cwd,
  dataDir,
  tmp: dirs.tmp,
  env: { PATH: `${dirname(claudePath)}:${process.env.PATH}` },
});

const queenHome = () => realpathSync(join(dirs.dataDir, "queen"));
const queenProjects = () => db.prepare("SELECT * FROM projects WHERE name = 'queen'").all();
const runningLeads = (projectId) =>
  db.prepare("SELECT * FROM agents WHERE project_id = ? AND kind = 'lead' AND status = 'running'").all(projectId);

describe("hive queen", { skip: hasTmux ? false : "tmux is not installed" }, () => {
  it("two concurrent first runs publish one complete hive.yml, one project row and one running lead pane", async () => {
    const results = await Promise.all([
      runCli(["queen", "--no-dashboard"], cliOpts(dirs.dataDir)),
      runCli(["queen", "--no-dashboard"], cliOpts(dirs.dataDir)),
    ]);
    assert.ok(
      results.some((r) => r.code === 0),
      `at least one concurrent hive queen must succeed: ${JSON.stringify(results)}`,
    );

    assert.equal(readFileSync(join(queenHome(), "hive.yml"), "utf8"), "profile: queen\n");
    assert.deepEqual(
      readdirSync(queenHome()).filter((f) => f.startsWith(".hive.yml")),
      [],
      "no staged config file may survive publication",
    );
    const projects = queenProjects();
    assert.equal(projects.length, 1, JSON.stringify(projects));
    assert.equal(projects[0].path, queenHome());
    const leads = runningLeads(projects[0].id);
    assert.equal(leads.length, 1, JSON.stringify(leads));
    assert.deepEqual(panesIn(windowFor(sessionName(), projects[0].id)), [leads[0].tmux_target]);
  });

  it("a repeat run adopts the running lead's pane and names the shipped queen posture", async () => {
    const [project] = queenProjects();
    const before = runningLeads(project.id)[0];

    const again = await runCli(["queen", "--no-dashboard"], cliOpts(dirs.dataDir));
    assert.equal(again.code, 0, again.stderr + again.stdout);
    assert.match(again.stdout, /- profile: queen \(shipped posture; see it with: hive posture\)/);

    const after = runningLeads(project.id);
    assert.equal(after.length, 1);
    assert.equal(after[0].id, before.id);
    assert.equal(after[0].tmux_target, before.tmux_target, "a repeat run must adopt the live pane, not replace it");
    assert.deepEqual(panesIn(windowFor(sessionName(), project.id)), [before.tmux_target]);
  });

  it("on a first run under a registered ancestor of the data dir, starts the queen's own lead, not the ancestor's", async () => {
    const ancestor = realpathSync(mkdtempSync(join(dirname(dirs.dataDir), "ancestor-")));
    const dataDir = join(ancestor, "data");
    const init = await runCli(["init", ancestor, "--no-profile"], cliOpts(dataDir, ancestor));
    assert.equal(init.code, 0, init.stderr + init.stdout);

    const run = await runCli(["queen", "--no-dashboard"], cliOpts(dataDir, ancestor));
    assert.equal(run.code, 0, run.stderr + run.stdout);

    const portfolio = await runCli(["portfolio", "--json"], cliOpts(dataDir, ancestor));
    const byRoot = Object.fromEntries(JSON.parse(portfolio.stdout).projects.map((p) => [p.root, p.lead.state]));
    assert.deepEqual(byRoot, { [ancestor]: "none", [join(ancestor, "data", "queen")]: "alive" });
  });

  it("derives its home from the data dir it runs under, so a second data dir gets its own", async () => {
    const otherDataDir = join(mkdtempSync(join(dirname(dirs.dataDir), "other-")), "data");
    const run = await runCli(["queen", "--no-dashboard"], cliOpts(otherDataDir));
    assert.equal(run.code, 0, run.stderr + run.stdout);
    assert.equal(readFileSync(join(otherDataDir, "queen", "hive.yml"), "utf8"), "profile: queen\n");
    assert.equal(queenProjects().length, 1, "the first data dir's store must not gain a second queen row");
  });

  it("refuses a pre-existing hive.yml that selects another profile, and leaves it untouched", async () => {
    const dataDir = join(mkdtempSync(join(dirname(dirs.dataDir), "foreign-yml-")), "data");
    mkdirSync(join(dataDir, "queen"), { recursive: true });
    writeFileSync(join(dataDir, "queen", "hive.yml"), "profile: orchestration\n");

    const run = await runCli(["queen", "--no-dashboard"], cliOpts(dataDir));
    assert.notEqual(run.code, 0);
    assert.match(run.stdout, /does not select "profile: queen"/);
    assert.equal(readFileSync(join(dataDir, "queen", "hive.yml"), "utf8"), "profile: orchestration\n");
    assert.deepEqual(readdirSync(join(dataDir, "queen")), ["hive.yml"]);
  });

  it("refuses a queen home that is a symlink, without writing through it", async () => {
    const dataDir = join(mkdtempSync(join(dirname(dirs.dataDir), "linked-")), "data");
    const elsewhere = mkdtempSync(join(dirname(dirs.dataDir), "elsewhere-"));
    mkdirSync(dataDir, { recursive: true });
    symlinkSync(elsewhere, join(dataDir, "queen"));

    const run = await runCli(["queen", "--no-dashboard"], cliOpts(dataDir));
    assert.notEqual(run.code, 0);
    assert.match(run.stdout, /is not a plain directory/);
    assert.equal(existsSync(join(elsewhere, "hive.yml")), false);
  });

  it("refuses a locked worker before creating the queen's home or registering it", async () => {
    const dataDir = join(mkdtempSync(join(dirname(dirs.dataDir), "locked-")), "data");
    const project = realpathSync(mkdtempSync(join(dirname(dirs.dataDir), "worker-project-")));
    const init = await runCli(["init", project, "--no-profile"], cliOpts(dataDir, project));
    assert.equal(init.code, 0, init.stderr + init.stdout);
    const seed = await runNode("--input-type=module", [
      "-e",
      [
        `process.env.HIVE_DATA_DIR = ${JSON.stringify(dataDir)};`,
        `const { db } = await import(${JSON.stringify(join(DIST, "db.js"))});`,
        `const p = db.prepare("SELECT id FROM projects WHERE path = ?").get(${JSON.stringify(project)});`,
        `db.prepare("INSERT INTO agents (project_id, actor_id, name, command, cwd, kind) VALUES (?, 'agent:w1', 'w1', 'claude', '/', 'agent')").run(p.id);`,
      ].join("\n"),
    ], { cwd: project, dataDir, tmp: dirs.tmp });
    assert.equal(seed.code, 0, seed.stderr);

    const locked = await runCli(["queen", "--no-dashboard"], {
      ...cliOpts(dataDir, project),
      env: { ...cliOpts(dataDir, project).env, HIVE_AGENT_ID: "agent:w1", HIVE_PROJECT_LOCK: "1", HIVE_PROJECT_PATH: project },
    });
    assert.notEqual(locked.code, 0);
    assert.match(locked.stdout, /hive queen: this session is locked to its own project/);
    assert.equal(existsSync(join(dataDir, "queen")), false, "a locked worker must not create the queen's home");
    const portfolio = await runCli(["portfolio", "--json"], cliOpts(dataDir, project));
    assert.deepEqual(JSON.parse(portfolio.stdout).projects.map((p) => p.root), [project]);
  });

  it("names itself when it rejects an unknown flag", async () => {
    const run = await runCli(["queen", "--bogus"], cliOpts(dirs.dataDir));
    assert.notEqual(run.code, 0);
    assert.match(run.stderr, /^hive queen: unknown argument "--bogus"/);
  });

  it("takes no path argument", async () => {
    const run = await runCli(["queen", dirs.projectDir], cliOpts(dirs.dataDir));
    assert.notEqual(run.code, 0);
    assert.match(run.stderr, /takes no path/);
  });
});
