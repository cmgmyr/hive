import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, it } from "node:test";
import { assertScratchStore, clearHiveEnv, isolateTmux, makeFakeClaude, runCli, scratchDirs } from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("queen audit lead CLI");
const needsTmux = { skip: hasTmux ? false : "tmux is not installed" };
clearHiveEnv();
const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { db, migrate } = await import("../dist/db.js");
const { configHash } = await import("../dist/projectYml.js");
const { sessionName } = await import("../dist/tmux.js");
await assertScratchStore();
migrate();
after(() => cleanup(sessionName()));
const project = (name, path) => {
  mkdirSync(path, { recursive: true });
  return { id: db.prepare("INSERT INTO projects (name, path) VALUES (?, ?) RETURNING id").get(name, path).id, path };
};
const queen = project("queen", join(dirs.dataDir, "queen"));
const queenId = db.prepare("INSERT INTO agents (project_id, name, command, cwd, kind, tmux_target) VALUES (?, 'lead', 'claude', ?, 'lead', '%none') RETURNING id").get(queen.id, queen.path).id;
const queenActor = `lead:${queenId}`;
db.prepare("UPDATE agents SET actor_id = ? WHERE id = ?").run(queenActor, queenId);
const fakeClaude = makeFakeClaude(dirs.tmp)("sleep 600");
let next = 0;
const foreign = () => {
  const p = project(`target${next}`, join(dirs.tmp, `target${next++}`));
  writeFileSync(join(p.path, "hive.yml"), `lead: ${fakeClaude}\n`);
  db.prepare("INSERT INTO command_trust (project_id, name, config_hash) VALUES (?, 'lead', ?)").run(p.id, configHash("lead", fakeClaude, null, {}));
  return p;
};
const run = (p, env = {}) => runCli(["lead", p.path, "--detach", "--no-dashboard"], { cwd: queen.path, dataDir: dirs.dataDir, env: { HIVE_AGENT_ID: queenActor, ...env } });
const rows = () => db.prepare("SELECT * FROM queen_audit ORDER BY id").all();
const leadRow = (p) => db.prepare("SELECT * FROM agents WHERE project_id = ? AND kind = 'lead'").get(p.id);
const panes = () => {
  try { return execFileSync("tmux", ["list-panes", "-s", "-t", `=${sessionName()}`, "-F", "#{pane_id}"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().split("\n").sort(); }
  catch { return []; }
};
it("start and sequential adoption each audit exactly once as the initiating queen, with truthful disposition", needsTmux, async () => {
  const p = foreign();
  const before = rows().length;
  const started = await run(p);
  assert.equal(started.code, 0, started.stdout + started.stderr);
  const row = leadRow(p);
  assert.match(started.stdout, new RegExp(`LEAD_PANE=${row.tmux_target}`));
  assert.equal(rows().length, before + 1);
  assert.deepEqual([rows().at(-1).actor_id, rows().at(-1).target_project_id, rows().at(-1).resource_id], [queenActor, p.id, row.id]);
  assert.match(rows().at(-1).summary, /^started lead #\d+ detached$/);
  const adopted = await run(p);
  assert.equal(adopted.code, 0, adopted.stdout + adopted.stderr);
  assert.equal(leadRow(p).tmux_target, row.tmux_target);
  assert.equal(rows().length, before + 2);
  assert.match(rows().at(-1).summary, /^adopted lead #\d+ detached$/);
});
it("audit failure restores the adopted CAS claim and wake bindings and preserves the existing pane", needsTmux, async () => {
  const p = foreign();
  assert.equal((await run(p)).code, 0);
  const lead = leadRow(p);
  const id = db.prepare("INSERT INTO wakes (project_id, owner, body, kind, deliver_actor, deliver_pane, due_at, held_at, held_reason) VALUES (?, ?, 'keep', 'delay', ?, '%old', datetime('now', '+1 day'), datetime('now'), 'keep') RETURNING id").get(p.id, queenActor, lead.actor_id).id;
  const before = { panes: panes(), row: lead.tmux_target, wake: db.prepare("SELECT * FROM wakes WHERE id = ?").get(id), audit: rows().length };
  db.exec("CREATE TRIGGER break_audit BEFORE INSERT ON queen_audit BEGIN SELECT RAISE(ABORT, 'audit broken'); END");
  let result;
  try { result = await run(p); } finally { db.exec("DROP TRIGGER break_audit"); }
  assert.notEqual(result.code, 0);
  assert.match(result.stdout + result.stderr, /audit broken/);
  assert.deepEqual(panes(), before.panes);
  assert.equal(leadRow(p).tmux_target, before.row);
  assert.deepEqual(db.prepare("SELECT * FROM wakes WHERE id = ?").get(id), before.wake);
  assert.equal(rows().length, before.audit);
});
it("audit failure cleans a newly created pane and rolls the lead claim back", needsTmux, async () => {
  const p = foreign();
  const before = { panes: panes(), audit: rows().length };
  db.exec("CREATE TRIGGER break_audit BEFORE INSERT ON queen_audit BEGIN SELECT RAISE(ABORT, 'audit broken'); END");
  let result;
  try { result = await run(p); } finally { db.exec("DROP TRIGGER break_audit"); }
  assert.notEqual(result.code, 0);
  assert.match(result.stdout + result.stderr, /audit broken/);
  assert.deepEqual(panes(), before.panes);
  assert.equal(leadRow(p).tmux_target, "");
  assert.equal(rows().length, before.audit);
});
it("a losing adopt CAS produces no audit row and does not kill the winner's live pane", needsTmux, async () => {
  const p = foreign();
  assert.equal((await run(p)).code, 0);
  const lead = leadRow(p);
  const before = { panes: panes(), audit: rows().length };
  db.exec(`CREATE TRIGGER steal_claim AFTER UPDATE OF actor_id ON agents WHEN NEW.id = ${lead.id} BEGIN UPDATE agents SET tmux_target = '%racer' WHERE id = ${lead.id}; END`);
  let result;
  try { result = await run(p); } finally { db.exec("DROP TRIGGER steal_claim"); }
  assert.notEqual(result.code, 0);
  assert.match(result.stdout + result.stderr, /won the race/);
  assert.deepEqual(panes(), before.panes);
  assert.equal(rows().length, before.audit);
});
it("refused foreign next, unregistered paths, and ordinary detached lead calls do not audit", needsTmux, async () => {
  const p = foreign();
  db.prepare("INSERT INTO todos (project_id, title, tags) VALUES (?, 'needs human', '[\"needs-human\"]')").run(p.id);
  const before = rows().length;
  const nextResult = await runCli(["next"], { cwd: queen.path, dataDir: dirs.dataDir, env: { HIVE_AGENT_ID: queenActor } });
  assert.notEqual(nextResult.code, 0);
  assert.match(nextResult.stdout + nextResult.stderr, /QUEEN_CROSS_PROJECT_WRITE_REFUSED/);
  const fresh = join(dirs.tmp, "unregistered");
  mkdirSync(fresh);
  const refused = await run({ path: fresh });
  assert.notEqual(refused.code, 0);
  assert.match(refused.stdout + refused.stderr, /QUEEN_CROSS_PROJECT_WRITE_REFUSED/);
  assert.equal(db.prepare("SELECT id FROM projects WHERE path = ?").get(fresh), undefined);
  const ordinary = await run(p, { HIVE_AGENT_ID: "" });
  assert.equal(ordinary.code, 0, ordinary.stdout + ordinary.stderr);
  assert.equal(rows().length, before);
});
