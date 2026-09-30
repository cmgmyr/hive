import assert from "node:assert/strict";
import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { clearHiveEnv, isolateTmux, runCli, scratchDirs } from "./helpers.mjs";

isolateTmux("the project rm CLI tests");
clearHiveEnv();

const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { db, migrate } = await import("../dist/db.js");
migrate();

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

  it("refuses a target with a running agent and deletes nothing", async () => {
    const target = withRows(project("busy"));
    db.prepare("INSERT INTO agents (project_id, name, command, cwd, status) VALUES (?, 'w', 'sleep', '/tmp', 'running')").run(target.id);
    const r = await run(["rm", String(target.id), "--yes"]);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /running agents: w/);
    assert.ok(exists(target.id));
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
