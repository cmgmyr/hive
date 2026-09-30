import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { after, it } from "node:test";
import { assertScratchStore, clearHiveEnv, isolateTmux, McpClient, scratchDirs } from "./helpers.mjs";

isolateTmux("queen audit MCP reader");
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
const actor = (p, kind, name) => {
  const id = db.prepare("INSERT INTO agents (project_id, name, command, cwd, kind) VALUES (?, ?, 'claude', ?, ?) RETURNING id").get(p.id, name, p.path, kind).id;
  const actorId = `${kind === "lead" ? "lead" : "agent"}:${id}`;
  db.prepare("UPDATE agents SET actor_id = ? WHERE id = ?").run(actorId, id);
  return actorId;
};
const queenActor = actor(queen, "lead", "lead");
const alphaActor = actor(alpha, "lead", "lead");
const workerActor = actor(alpha, "agent", "worker");
const seed = db.prepare("INSERT INTO queen_audit (actor_id, home_project_id, target_project_id, operation, resource_type, resource_id, summary, created_at) VALUES (?, ?, ?, 'todo_create', 'todo', ?, ?, '2026-01-01 00:00:00.000')");
const alphaIds = [];
const allIds = [];
for (let i = 0; i < 130; i++) {
  const a = Number(seed.run(i % 2 ? "lead:previous" : queenActor, queen.id, alpha.id, i + 1, `alpha ${i}`).lastInsertRowid);
  alphaIds.unshift(a); allIds.unshift(a);
  allIds.unshift(Number(seed.run("lead:older", queen.id, beta.id, i + 1, `beta ${i}`).lastInsertRowid));
}
const clients = [];
async function as(p, env = {}) {
  const c = new McpClient({ cwd: p.path, dataDir: dirs.dataDir, env: { HIVE_SCHEDULER_INTERVAL_MS: "3600000", ...env } });
  clients.push(c); await c.start(); return c;
}
after(async () => { for (const c of clients) await c.close(); });
it("queen lists all historical actors by descending ids at default 20 and max 100, and filters in SQL before LIMIT", async () => {
  const c = await as(queen, { HIVE_AGENT_ID: queenActor });
  const defaultReport = await c.call("queen_audit_list");
  assert.equal(defaultReport.project_id, null);
  assert.equal(defaultReport.limit, 20);
  assert.deepEqual(defaultReport.entries.map((r) => r.id), allIds.slice(0, 20));
  const all = await c.call("queen_audit_list", { limit: 1000 });
  assert.equal(all.limit, 100);
  assert.deepEqual(all.entries.map((r) => r.id), allIds.slice(0, 100));
  const filtered = await c.call("queen_audit_list", { project_id: alpha.id, limit: 100 });
  assert.deepEqual(filtered.entries.map((r) => r.id), alphaIds.slice(0, 100));
  assert.deepEqual(new Set(filtered.entries.map((r) => r.actor_id)), new Set([queenActor, "lead:previous"]));
  assert.ok(filtered.entries.every((r) => r.target_project_id === alpha.id));
});
it("ordinary leads, humans and locked workers see only their own project and refuse foreign filters", async () => {
  for (const env of [{ HIVE_AGENT_ID: alphaActor }, {}, { HIVE_AGENT_ID: workerActor, HIVE_PROJECT_LOCK: "1", HIVE_PROJECT_PATH: alpha.path }]) {
    const c = await as(alpha, env);
    const report = await c.call("queen_audit_list");
    assert.equal(report.project_id, alpha.id);
    assert.deepEqual(report.entries.map((r) => r.id), alphaIds.slice(0, 20));
    assert.deepEqual((await c.call("queen_audit_list", { project_id: alpha.id })).entries, report.entries);
    await assert.rejects(c.call("queen_audit_list", { project_id: beta.id }), /own project|locked/);
  }
  const humanAtHome = await as(queen);
  assert.deepEqual(await humanAtHome.call("queen_audit_list"), { entries: [], limit: 20, project_id: queen.id });
});
it("empty lists are objects, unknown targets and invalid numbers refuse, and strict input rejects unknown keys", async () => {
  const c = await as(queen, { HIVE_AGENT_ID: queenActor });
  assert.deepEqual(await c.call("queen_audit_list", { project_id: empty.id }), { entries: [], limit: 20, project_id: empty.id });
  await assert.rejects(c.call("queen_audit_list", { project_id: 999999 }), /Unknown project_id/);
  for (const key of ["limit", "project_id"]) for (const value of [0, -1, 1.5, "20"]) await assert.rejects(c.call("queen_audit_list", { [key]: value }));
  await assert.rejects(c.call("queen_audit_list", { unknown: true }), /MCP error -32602:.*Unrecognized key: "unknown"/);
  const tools = (await c.request("tools/list", {})).result.tools;
  const tool = tools.find((t) => t.name === "queen_audit_list");
  assert.equal(tool.annotations.readOnlyHint, true);
  assert.equal(tool.inputSchema.additionalProperties, false);
  assert.equal(tool.outputSchema, undefined);
});
