import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";
import { assertScratchStore, clearHiveEnv, isolateTmux, scratchDirs } from "./helpers.mjs";

isolateTmux("queen audit core");
clearHiveEnv();
const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { db, migrate } = await import("../dist/db.js");
const { captureQueenWriteIdentity } = await import("../dist/context.js");
const { commitQueenStateWrite, confirmQueenWrite, QUEEN_AUDIT_OPERATIONS } = await import("../dist/queenAudit.js");
await assertScratchStore();
migrate();
const project = (name, path) => {
  mkdirSync(path, { recursive: true });
  return db.prepare("INSERT INTO projects (name, path) VALUES (?, ?) RETURNING id").get(name, path).id;
};
const home = project("queen", join(dirs.dataDir, "queen"));
const alpha = project("alpha", join(dirs.tmp, "alpha"));
const beta = project("beta", join(dirs.tmp, "beta"));
const actor = "lead:fixture";
db.prepare("INSERT INTO agents (project_id, actor_id, name, command, cwd, kind) VALUES (?, ?, 'lead', 'claude', ?, 'lead')").run(home, actor, join(dirs.dataDir, "queen"));
const rows = () => db.prepare("SELECT * FROM queen_audit ORDER BY id").all();
const create = (target, title) => commitQueenStateWrite("todo_create", target, { title }, () => ({
  todo_id: db.prepare("INSERT INTO todos (project_id, title) VALUES (?, ?) RETURNING id").get(target, title).id,
}));

it("captures only a running queen lead and excludes home, human, worker, wrong-home and closed identities", () => {
  process.env.HIVE_AGENT_ID = actor;
  assert.deepEqual(captureQueenWriteIdentity(alpha), { actor_id: actor, home_project_id: home });
  assert.equal(captureQueenWriteIdentity(home), null);
  delete process.env.HIVE_AGENT_ID;
  assert.equal(captureQueenWriteIdentity(alpha), null);
  process.env.HIVE_AGENT_ID = "agent:worker";
  db.prepare("INSERT INTO agents (project_id, actor_id, name, command, cwd, kind) VALUES (?, 'agent:worker', 'worker', 'claude', '/', 'agent')").run(home);
  assert.equal(captureQueenWriteIdentity(alpha), null);
  process.env.HIVE_AGENT_ID = "lead:ordinary";
  db.prepare("INSERT INTO agents (project_id, actor_id, name, command, cwd, kind) VALUES (?, 'lead:ordinary', 'lead', 'queen', '/', 'lead')").run(alpha);
  assert.equal(captureQueenWriteIdentity(beta), null);
  process.env.HIVE_AGENT_ID = actor;
  db.prepare("UPDATE agents SET status = 'closed' WHERE actor_id = ?").run(actor);
  assert.equal(captureQueenWriteIdentity(alpha), null);
  db.prepare("UPDATE agents SET status = 'running' WHERE actor_id = ?").run(actor);
});

it("records the actual SQL resource and bounds a large emoji/control summary without changing its title", () => {
  const before = rows().length;
  const title = "hello\n\u200d" + "😀".repeat(500);
  const receipt = create(alpha, title);
  const row = rows().at(-1);
  assert.equal(rows().length, before + 1);
  assert.equal(row.actor_id, actor);
  assert.equal(row.home_project_id, home);
  assert.equal(row.target_project_id, alpha);
  assert.equal(row.resource_id, receipt.todo_id);
  assert.equal(row.resource_type, "todo");
  assert.ok(row.summary.length <= 160);
  assert.ok(row.summary.endsWith("…"));
  assert.doesNotMatch(row.summary, /[\p{Cc}\p{Cf}]/u);
  assert.equal(db.prepare("SELECT title FROM todos WHERE id = ?").get(receipt.todo_id).title, title);
});

it("an audit insert failure rolls back the mutation and a missing descriptor refuses before mutate", () => {
  const before = db.prepare("SELECT COUNT(*) AS n FROM todos").get().n;
  const auditBefore = rows().length;
  db.exec("CREATE TRIGGER break_audit BEFORE INSERT ON queen_audit BEGIN SELECT RAISE(ABORT, 'audit broken'); END");
  assert.throws(() => create(alpha, "must roll back"), /audit broken/);
  db.exec("DROP TRIGGER break_audit");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM todos").get().n, before);
  assert.equal(rows().length, auditBefore);
  let invoked = false;
  assert.throws(() => commitQueenStateWrite("unclassified", alpha, {}, () => { invoked = true; return {}; }), /missing-coverage/);
  assert.equal(invoked, false);
});

it("home and ordinary mutations preserve their receipt and produce no audit rows", () => {
  const before = rows().length;
  create(home, "home");
  process.env.HIVE_AGENT_ID = "lead:ordinary";
  create(beta, "ordinary");
  process.env.HIVE_AGENT_ID = actor;
  assert.equal(rows().length, before);
});

it("all noop predicates exclude audit entries", () => {
  for (const [operation, receipt] of [
    ["wake_when_idle", { status: "already_satisfied", wake_id: 12 }],
    ["wake_update", { updated: false, wake_id: 12 }],
    ["wake_cancel", { cancelled: false, wake_id: 12 }],
    ["agent_send", { sent: false, agent_id: 12 }],
    ["hive lead", { agent_id: 12 }],
  ]) assert.equal(QUEEN_AUDIT_OPERATIONS[operation].resource(receipt), null);
});

it("interleaved async callers keep explicit target, operation and summary separate", async () => {
  const before = rows().length;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const first = (async () => { await gate; return create(alpha, "alpha request"); })();
  const second = (async () => { await Promise.resolve(); const result = create(beta, "beta request"); release(); return result; })();
  const [a, b] = await Promise.all([first, second]);
  assert.deepEqual(rows().slice(before).map((r) => [r.target_project_id, r.resource_id, r.summary]), [
    [beta, b.todo_id, "beta request"], [alpha, a.todo_id, "alpha request"],
  ]);
});

it("a confirmed send whose audit fails names the already-landed effect", () => {
  db.exec("CREATE TRIGGER break_audit BEFORE INSERT ON queen_audit BEGIN SELECT RAISE(ABORT, 'audit broken'); END");
  assert.throws(() => confirmQueenWrite("agent_send", alpha, { text: "hello" }, { sent: true, agent_id: 12 }), /write-completed-audit-failed.*agent #12.*already landed.*Do not resend blindly/);
  db.exec("DROP TRIGGER break_audit");
});
