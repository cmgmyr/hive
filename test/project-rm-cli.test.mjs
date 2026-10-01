import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { clearHiveEnv, isolateTmux, paneField, runCli, scratchDirs } from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("the project rm CLI tests");
clearHiveEnv();

const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { db, migrate } = await import("../dist/db.js");
const { tmuxSocketPath } = await import("../dist/tmux.js");
migrate();

const BYSTANDER = `project-rm-cli-bystander-${process.pid}`;
let pane = "%unset";
let pid = "";
const startBystander = () => {
  execFileSync("tmux", ["new-session", "-d", "-s", BYSTANDER, "sleep 600"], { stdio: "ignore" });
  pane = execFileSync("tmux", ["list-panes", "-t", `=${BYSTANDER}`, "-F", "#{pane_id}"], { encoding: "utf8" }).trim();
  pid = paneField(pane, "#{pane_pid}");
};
const bystanderAlive = () => paneField(pane, "#{pane_pid}") === pid;
const runningRow = (projectId, name, kind, panePid) =>
  db
    .prepare(
      "INSERT INTO agents (project_id, name, kind, command, cwd, status, tmux_target, tmux_socket, pane_pid) VALUES (?, ?, ?, 'sleep', '/tmp', 'running', ?, ?, ?) RETURNING id",
    )
    .get(projectId, name, kind, pane, tmuxSocketPath(process.env.TMUX, process.env.TMUX_TMPDIR), panePid).id;

before(() => hasTmux && startBystander());
after(() => cleanup(BYSTANDER));

function project(name) {
  const path = join(dirs.tmp, name);
  mkdirSync(path, { recursive: true });
  const real = realpathSync(path);
  return { id: db.prepare("INSERT INTO projects (name, path) VALUES (?, ?) RETURNING id").get(name, real).id, path: real, name };
}

function withRows(p) {
  db.prepare("INSERT INTO todos (project_id, title) VALUES (?, 'x')").run(p.id);
  db.prepare("INSERT INTO kv (project_id, key, value) VALUES (?, 'k', 'v')").run(p.id);
  return p;
}

const home = project("home");
const exists = (id) => db.prepare("SELECT id FROM projects WHERE id = ?").get(id) !== undefined;
const run = (args, extra = {}) => runCli(["project", ...args], { cwd: home.path, dataDir: dirs.dataDir, tmp: dirs.tmp, ...extra });

describe("hive project rm", () => {
  it("--yes removes a non-empty project by id, prints counts and the snapshot, and leaves the others", async () => {
    const target = withRows(project("gone-by-id"));
    const other = withRows(project("bystander"));
    const r = await run(["rm", String(target.id), "--yes"]);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /Deleted todos: 1, kv: 1\./);
    assert.match(r.stdout, /Snapshot: .*backups/);
    assert.ok(!exists(target.id));
    assert.ok(exists(other.id));
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM todos WHERE project_id = ?").get(other.id).n, 1);
  });

  it("--yes removes a project named by its exact registered path", async () => {
    const target = withRows(project("gone-by-path"));
    const r = await run(["rm", target.path, "--yes"]);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.ok(!exists(target.id));
  });

  it("without --yes and with n on stdin removes nothing", async () => {
    const target = withRows(project("kept-on-no"));
    const r = await run(["rm", String(target.id)], { stdin: "n\n" });
    assert.match(r.stdout, /Not removed/);
    assert.equal(r.code, 1);
    assert.ok(exists(target.id));
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM todos WHERE project_id = ?").get(target.id).n, 1);
  });

  it("refuses a path that is not exactly a registered path, even one inside a registered project", async () => {
    const target = withRows(project("parent"));
    const inside = join(target.path, "sub");
    mkdirSync(inside);
    const r = await run(["rm", inside, "--yes"]);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /not a registered project id or exact registered path/);
    assert.ok(exists(target.id));
  });

  it("refuses an unknown id", async () => {
    const r = await run(["rm", "999999", "--yes"]);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /not a registered project/);
  });

  it("refuses the project the working directory belongs to", async () => {
    withRows(home);
    const r = await run(["rm", String(home.id), "--yes"]);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /never removed from itself/);
    assert.ok(exists(home.id));
    const viaPath = await run(["rm", home.path, "--yes"]);
    assert.equal(viaPath.code, 1);
    assert.ok(exists(home.id));
  });

  it("refuses a target whose running worker owns a live pane and deletes nothing", { skip: !hasTmux && "tmux is not installed" }, async () => {
    const target = withRows(project("busy"));
    runningRow(target.id, "w", "agent", pid);
    const r = await run(["rm", String(target.id), "--yes"]);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /running agents: w \(agent \d+, owns a live pane\)/);
    assert.ok(exists(target.id));
  });

  it("refuses a target whose lead has no recorded pane pid, naming agent_close row_only for it", { skip: !hasTmux && "tmux is not installed" }, async () => {
    const target = withRows(project("unknown-lead"));
    const id = runningRow(target.id, "lead", "lead", "");
    const r = await run(["rm", String(target.id), "--yes"]);
    assert.equal(r.code, 1);
    assert.match(r.stdout, new RegExp(`pane identity unknown[\\s\\S]*agent_close\\(\\{agent_id: ${id}, row_only: true\\}\\)`));
    assert.ok(exists(target.id));
    assert.equal(db.prepare("SELECT status FROM agents WHERE id = ?").get(id).status, "running");
  });

  it("removes a target whose running lead row names a reissued pane, leaving the pane's new owner alive", { skip: !hasTmux && "tmux is not installed" }, async () => {
    const target = withRows(project("reissued-lead"));
    runningRow(target.id, "lead", "lead", "1");
    const r = await run(["rm", String(target.id), "--yes"]);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.ok(!exists(target.id));
    assert.ok(bystanderAlive());
  });

  it("refuses under HIVE_PROJECT_LOCK=1", async () => {
    const target = withRows(project("locked-out"));
    const actor = "lead:lock";
    db.prepare("INSERT OR IGNORE INTO actors (id, name, kind) VALUES (?, 'l', 'lead')").run(actor);
    db.prepare("INSERT INTO agents (project_id, actor_id, name, command, cwd, status) VALUES (?, ?, 'l', 'claude', '/', 'running')").run(home.id, actor);
    const r = await run(["rm", String(target.id), "--yes"], { env: { HIVE_AGENT_ID: actor, HIVE_PROJECT_LOCK: "1" } });
    assert.equal(r.code, 1);
    assert.match(r.stdout, /HIVE_PROJECT_LOCK/);
    assert.ok(exists(target.id));
  });

  it("refuses when only HIVE_PROJECT_LOCK=1 is set, with no agent id", async () => {
    const target = withRows(project("locked-env-only"));
    const r = await run(["rm", String(target.id), "--yes"], { env: { HIVE_PROJECT_LOCK: "1" } });
    assert.equal(r.code, 1);
    assert.match(r.stdout, /HIVE_PROJECT_LOCK/);
    assert.ok(exists(target.id));
  });

  it("prints usage for anything but rm <ref>", async () => {
    const r = await run(["rm"]);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /Usage: hive project rm/);
  });
});
