import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { it } from "node:test";
import { assertScratchStore, clearHiveEnv, isolateTmux, McpClient, REPO, runCli, runFixture, scratchDirs } from "./helpers.mjs";

isolateTmux("queen audit CLI reader");
clearHiveEnv();
const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { db, migrate } = await import("../dist/db.js");
await assertScratchStore();
migrate();
const project = (name, path) => {
  mkdirSync(path, { recursive: true });
  return { id: db.prepare("INSERT INTO projects (name, path) VALUES (?, ?) RETURNING id").get(name, path).id, path };
};
const queen = project("queen", join(dirs.dataDir, "queen"));
const alpha = project("alpha", join(dirs.tmp, "alpha"));
const beta = project("beta", join(dirs.tmp, "beta"));
const empty = project("empty", join(dirs.tmp, "empty"));
const actor = (p, kind) => {
  const id = db.prepare("INSERT INTO agents (project_id, name, command, cwd, kind) VALUES (?, ?, 'claude', ?, ?) RETURNING id").get(p.id, kind === "lead" ? "lead" : "worker", p.path, kind).id;
  const actorId = `${kind === "lead" ? "lead" : "agent"}:${id}`;
  db.prepare("UPDATE agents SET actor_id = ? WHERE id = ?").run(actorId, id);
  return actorId;
};
const q = actor(queen, "lead");
const lead = actor(alpha, "lead");
const worker = actor(alpha, "agent");
const ids = [];
const alphaIds = [];
for (let i = 0; i < 130; i++) {
  for (const target of [alpha, beta]) {
    const id = Number(db.prepare("INSERT INTO queen_audit (actor_id, home_project_id, target_project_id, operation, resource_type, resource_id, summary) VALUES (?, ?, ?, 'todo_create', 'todo', ?, ?)").run(i % 2 ? q : "lead:previous", queen.id, target.id, i + 1, `Review task ${i}`).lastInsertRowid);
    ids.unshift(id); if (target === alpha) alphaIds.unshift(id);
  }
}
const run = (p, args = [], env = {}) => runCli(["queen-audit", ...args], { cwd: p.path, dataDir: dirs.dataDir, env });
it("CLI help prints the queen-audit usage block exactly once", async () => {
  const result = await runCli(["--help"], { cwd: queen.path, dataDir: dirs.dataDir });
  assert.match(result.stdout, /^Usage:/m);
  assert.equal((result.stdout.match(/^  hive queen-audit\b/gm) ?? []).length, 1);
});
it("CLI refuses an unregistered cwd in text and JSON modes without registering a project", async () => {
  for (const args of [[], ["--json"]]) {
    const scratch = scratchDirs();
    const result = await runCli(["queen-audit", ...args], { cwd: scratch.projectDir, dataDir: scratch.dataDir });
    assert.notEqual(result.code, 0);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /hive queen-audit:.*cwd is not a registered project/);
    const projects = runFixture(scratch.tmp, "project-list", `import { listProjects } from ${JSON.stringify(pathToFileURL(join(REPO, "dist/context.js")).href)}; console.log(JSON.stringify(listProjects()));`, { ...process.env, HIVE_DATA_DIR: scratch.dataDir });
    assert.deepEqual(projects, []);
    const mcp = new McpClient({ cwd: scratch.projectDir, dataDir: scratch.dataDir });
    try {
      await mcp.start();
      assert.deepEqual((await mcp.call("project_list")).projects, []);
    } finally {
      await mcp.close();
    }
  }
});
it("CLI JSON is exactly one object with global, filtered and capped id-desc results", async () => {
  const report = await run(queen, ["--json"], { HIVE_AGENT_ID: q });
  assert.equal(report.code, 0, report.stderr);
  assert.deepEqual(JSON.parse(report.stdout).entries.map((r) => r.id), ids.slice(0, 20));
  const filtered = await run(queen, ["--json", "--project-id", String(alpha.id), "--limit", "999"], { HIVE_AGENT_ID: q });
  assert.equal(filtered.code, 0, filtered.stderr);
  const parsed = JSON.parse(filtered.stdout);
  assert.equal(parsed.limit, 100);
  assert.deepEqual(parsed.entries.map((r) => r.id), alphaIds.slice(0, 100));
  assert.deepEqual(new Set(parsed.entries.map((r) => r.actor_id)), new Set([q, "lead:previous"]));
});
it("CLI ordinary leads, humans and locked workers are target-scoped, and queen cwd alone grants no global read", async () => {
  for (const env of [{}, { HIVE_AGENT_ID: lead }, { HIVE_AGENT_ID: worker, HIVE_PROJECT_LOCK: "1", HIVE_PROJECT_PATH: alpha.path }]) {
    const result = await run(alpha, ["--json"], env);
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.deepEqual(JSON.parse(result.stdout).entries.map((r) => r.id), alphaIds.slice(0, 20));
    const foreign = await run(alpha, ["--json", "--project-id", String(beta.id)], env);
    assert.notEqual(foreign.code, 0);
    assert.match(foreign.stderr, /own project|locked/);
    assert.equal(foreign.stdout, "");
  }
  const atHome = await run(queen, ["--json"]);
  assert.deepEqual(JSON.parse(atHome.stdout), { entries: [], limit: 20, project_id: queen.id });
});
it("CLI rejects unknown flags, missing values, positions, invalid limits and unknown projects with no JSON pollution", async () => {
  for (const args of [["--unknown"], ["--limit"], ["position"], ["--limit", "0"], ["--limit", "-1"], ["--limit", "1.5"], ["--limit", "no"], ["--project-id", "0"], ["--project-id", "999999"]]) {
    const result = await run(queen, [...args, "--json"], { HIVE_AGENT_ID: q });
    assert.notEqual(result.code, 0, JSON.stringify(args));
    assert.equal(result.stdout, "", JSON.stringify(args));
    assert.ok(result.stderr.length > 0);
  }
});
it("CLI renders event fields, filtered target and empty state and captures the five requested terminal states", async () => {
  const populated = await run(queen, ["--limit", "2"], { HIVE_AGENT_ID: q });
  assert.equal(populated.code, 0);
  assert.match(populated.stdout, /UTC.*lead:/);
  assert.match(populated.stdout, /target #\d+\n  todo_create  todo #\d+\n  Review task/);
  const filtered = await run(queen, ["--project-id", String(alpha.id), "--limit", "2"], { HIVE_AGENT_ID: q });
  assert.match(filtered.stdout, new RegExp(`target #${alpha.id}`));
  assert.doesNotMatch(filtered.stdout, new RegExp(`target #${beta.id}`));
  const emptyResult = await run(empty);
  assert.equal(emptyResult.stdout, "No queen actions recorded.\n");
  const refused = await run(alpha, ["--project-id", String(beta.id)]);
  const json = await run(queen, ["--json", "--limit", "2"], { HIVE_AGENT_ID: q });
  const captureDir = join(new URL("../node_modules/.cache/queen-audit", import.meta.url).pathname, "captures");
  mkdirSync(captureDir, { recursive: true });
  for (const [name, text] of [["global", populated.stdout], ["filtered", filtered.stdout], ["empty", emptyResult.stdout], ["refusal", refused.stderr], ["json", json.stdout]]) writeFileSync(join(captureDir, `${name}.txt`), text);
});
