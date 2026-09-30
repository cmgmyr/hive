import assert from "node:assert/strict";
import { it } from "node:test";
import { assertScratchStore, clearHiveEnv, isolateTmux, scratchDirs } from "./helpers.mjs";

isolateTmux("queen audit retention");
clearHiveEnv();
const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { db, migrate } = await import("../dist/db.js");
const { tick } = await import("../dist/scheduler.js");
const { QUEEN_AUDIT_RETENTION, QUEEN_AUDIT_MAX_ROWS } = await import("../dist/queenAudit.js");
await assertScratchStore();
migrate();
const seed = (id, age = "-1 day") => db.prepare("INSERT INTO queen_audit (id, actor_id, home_project_id, target_project_id, operation, resource_type, resource_id, summary, created_at) VALUES (?, 'lead:historical', 1, 2, 'todo_create', 'todo', 1, 'retention fixture', datetime('now', ?))").run(id, age);
const ids = () => db.prepare("SELECT id FROM queen_audit ORDER BY id").all().map((r) => r.id);
it("real tick removes records older than 30 days while preserving eight-day and recent rows", async () => {
  assert.equal(QUEEN_AUDIT_RETENTION, "-30 days");
  seed(1, "-31 days"); seed(2, "-8 days"); seed(3);
  await tick(null);
  assert.deepEqual(ids(), [2, 3]);
});
it("real tick applies the 20k id-range backstop to sparse and dense histories", async () => {
  db.exec("DELETE FROM queen_audit");
  seed(1); seed(20001); seed(20002);
  await tick(null);
  assert.equal(QUEEN_AUDIT_MAX_ROWS, 20000);
  assert.deepEqual(ids(), [20001, 20002]);
  db.exec("DELETE FROM queen_audit");
  db.transaction(() => { for (let i = 1; i <= 20005; i++) seed(i); })();
  await tick(null);
  const remaining = ids();
  assert.equal(remaining.length, 20000);
  assert.equal(remaining[0], 6);
  assert.equal(remaining.at(-1), 20005);
});
it("an absent audit table does not throw or prevent existing state-log retention", async () => {
  db.exec("DROP TABLE queen_audit");
  db.prepare("INSERT INTO agent_state_log (actor_id, event, state, payload, created_at) VALUES ('agent:old', 'stop', 'idle', '{}', datetime('now', '-8 days'))").run();
  await assert.doesNotReject(tick(null));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM agent_state_log").get().n, 0);
});
