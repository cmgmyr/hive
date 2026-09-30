import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, it } from "node:test";
import { assertScratchStore, clearHiveEnv, isolateTmux, makeFakeClaude, McpClient, paneField, REPO, resolvedTmuxSocket, runCli, scratchDirs, until } from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("queen audit writes");
const needsTmux = { skip: hasTmux ? false : "tmux is not installed" };
clearHiveEnv();
const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { db, migrate } = await import("../dist/db.js");
const { QUEEN_REACH } = await import("../dist/context.js");
const { QUEEN_AUDIT_OPERATIONS } = await import("../dist/queenAudit.js");
const { configHash } = await import("../dist/projectYml.js");
const { sessionName } = await import("../dist/tmux.js");
await assertScratchStore();
migrate();
const project = (name, path) => {
  mkdirSync(path, { recursive: true });
  return { id: db.prepare("INSERT INTO projects (name, path) VALUES (?, ?) RETURNING id").get(name, path).id, path };
};
const queen = project("queen", join(dirs.dataDir, "queen"));
const alpha = project("alpha", join(dirs.tmp, "alpha"));
const beta = project("beta", join(dirs.tmp, "beta"));
const actor = (p, kind, name) => {
  const id = db.prepare("INSERT INTO agents (project_id, name, command, cwd, kind, tmux_target) VALUES (?, ?, 'claude', ?, ?, '%none') RETURNING id").get(p.id, name, p.path, kind).id;
  const actor_id = `${kind === "lead" ? "lead" : "agent"}:${id}`;
  db.prepare("UPDATE agents SET actor_id = ? WHERE id = ?").run(actor_id, id);
  return { id, actor_id };
};
const q = actor(queen, "lead", "lead");
const lead = actor(alpha, "lead", "lead");
const worker = actor(alpha, "agent", "worker");
const fakeClaude = makeFakeClaude(dirs.tmp)("sleep 600");
writeFileSync(join(beta.path, "hive.yml"), `lead: ${fakeClaude}\n`);
db.prepare("INSERT INTO command_trust (project_id, name, config_hash) VALUES (?, 'lead', ?)").run(beta.id, configHash("lead", fakeClaude, null, {}));
const trail = () => db.prepare("SELECT * FROM queen_audit ORDER BY id").all();
let client;
let paneNumber = 0;
async function freshPane() {
  execFileSync("tmux", ["new-session", "-d", "-s", `qaudit-${paneNumber++}`, "-x", "220", "-y", "60", `cat '${join(REPO, "test/fixtures/panes/ready-idle.txt")}'; sleep 600`], { encoding: "utf8" });
  const target = execFileSync("tmux", ["list-panes", "-t", `=qaudit-${paneNumber - 1}`, "-F", "#{pane_id}"], { encoding: "utf8" }).trim();
  db.prepare("UPDATE agents SET tmux_target = ?, tmux_socket = ?, pane_pid = ? WHERE id = ?").run(target, resolvedTmuxSocket(), paneField(target, "#{pane_pid}"), lead.id);
  assert.equal(await until(() => execFileSync("tmux", ["capture-pane", "-t", target, "-p"], { encoding: "utf8" }).includes("Claude Code")), true);
  return target;
}
before(async () => {
  if (!hasTmux) return;
  await freshPane();
  client = new McpClient({ cwd: queen.path, dataDir: dirs.dataDir, env: { HIVE_AGENT_ID: q.actor_id, HIVE_SCHEDULER_INTERVAL_MS: "3600000" } });
  await client.start();
});
after(async () => {
  await client?.close();
  for (let i = 0; i < paneNumber; i++) cleanup(`qaudit-${i}`);
  cleanup(sessionName());
});
let todo;
let wake;
const fixture = {
  todo_create: async () => { const r = await client.call("todo_create", { title: "foreign todo", project_id: alpha.id }); todo = r.todo_id; return [r.todo_id, "todo"]; },
  todo_comment: async () => { const r = await client.call("todo_comment", { todo_id: todo, body: "foreign context", project_id: alpha.id }); return [r.comment_id, "todo_comment"]; },
  wake_set: async () => { const r = await client.call("wake_set", { delay_seconds: 3600, body: "wake context", deliver_to: lead.id, project_id: alpha.id }); wake = r.wake_id; return [r.wake_id, "wake"]; },
  wake_when_idle: async () => { const r = await client.call("wake_when_idle", { agents: [worker.id], body: "watch context", deliver_to: lead.id, project_id: alpha.id }); return [r.wake_id, "wake"]; },
  wake_update: async () => { const r = await client.call("wake_update", { wake_id: wake, body: "edited context", repeat_every_seconds: 3600, project_id: alpha.id }); assert.equal(r.updated, true); return [r.wake_id, "wake"]; },
  wake_cancel: async () => { const r = await client.call("wake_cancel", { wake_id: wake, project_id: alpha.id }); assert.equal(r.cancelled, true); return [r.wake_id, "wake"]; },
  agent_send: async () => {
    const target = await freshPane();
    const r = await client.call("agent_send", { agent_id: lead.id, text: "unique audit delivery", project_id: alpha.id });
    assert.equal(r.sent, true);
    assert.equal(await until(() => execFileSync("tmux", ["capture-pane", "-t", target, "-p"], { encoding: "utf8" }).includes("unique audit delivery")), true);
    return [r.agent_id, "agent"];
  },
  "hive lead": async () => {
    const r = await runCli(["lead", beta.path, "--detach", "--no-dashboard"], { cwd: queen.path, dataDir: dirs.dataDir, env: { HIVE_AGENT_ID: q.actor_id } });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    const row = db.prepare("SELECT id FROM agents WHERE project_id = ? AND kind = 'lead'").get(beta.id);
    assert.match(r.stdout, /LEAD_PANE=/);
    return [row.id, "agent"];
  },
};
it("every foreign QUEEN_REACH category has a descriptor and an actual path fixture", () => {
  const nonforeign = new Set(["read", "home", "select", "global"]);
  const writes = Object.entries(QUEEN_REACH).filter(([, reach]) => !nonforeign.has(reach)).map(([name]) => name).sort();
  assert.deepEqual(Object.keys(QUEEN_AUDIT_OPERATIONS).sort(), writes);
  assert.deepEqual(Object.keys(fixture).sort(), writes);
  const files = execFileSync("rg", ["-l", "INSERT INTO queen_audit", join(REPO, "src")], { encoding: "utf8" }).trim().split("\n");
  assert.deepEqual(files, [join(REPO, "src/queenAudit.ts")]);
  assert.equal((readFileSync(files[0], "utf8").match(/INSERT INTO queen_audit/g) ?? []).length, 1);
});
for (const [operation, perform] of Object.entries(fixture)) {
  it(`${operation} writes exactly one row with its real receipt resource and initiating queen`, needsTmux, async () => {
    const before = trail().length;
    const [id, type] = await perform();
    const rows = trail();
    assert.equal(rows.length, before + 1);
    const row = rows.at(-1);
    assert.deepEqual([row.operation, row.resource_type, row.resource_id, row.actor_id, row.home_project_id, row.target_project_id], [operation, type, id, q.actor_id, queen.id, operation === "hive lead" ? beta.id : alpha.id]);
    assert.ok(row.summary.length <= 160);
    assert.match(row.created_at, /^\d{4}-\d\d-\d\d /);
  });
}
it("refused, invalid, cancelled and already-satisfied calls append no completed rows", needsTmux, async () => {
  const before = trail().length;
  const calls = [
    ["pad_write", { name: "blocked", content: "x" }],
    ["todo_complete", { todo_id: todo }],
    ["todo_comment", { todo_id: 999999, body: "x" }],
    ["agent_send", { agent_id: worker.id, text: "x" }],
    ["agent_send", { agent_id: lead.id, keys: ["Escape"] }],
    ["wake_when_idle", { scope: "project", deliver_to: lead.id, body: "x" }],
    ["wake_update", { wake_id: 999999, body: "x" }],
    ["wake_update", { wake_id: wake }],
    ["wake_set", { delay_seconds: 3600, deliver_to: lead.id, body: "unsafe\rbody" }],
    ["project_select", {}],
    ["project_prune", {}],
  ];
  for (const [name, args] of calls) await assert.rejects(client.call(name, { ...args, project_id: alpha.id }));
  assert.equal((await client.call("wake_update", { wake_id: wake, body: "cancelled noop", project_id: alpha.id })).updated, false);
  assert.equal((await client.call("wake_cancel", { wake_id: wake, project_id: alpha.id })).cancelled, false);
  assert.equal((await client.call("wake_when_idle", { agents: [worker.id], mode: "all", deliver_to: lead.id, body: "already idle", project_id: alpha.id })).status, "already_satisfied");
  assert.equal(trail().length, before);
});
it("blocker validation and audit failures roll back todo, comment touch, wake update and cancel notices", needsTmux, async () => {
  const before = trail().length;
  const todosBefore = db.prepare("SELECT COUNT(*) AS n FROM todos").get().n;
  const blockersBefore = db.prepare("SELECT * FROM todo_blockers").all();
  await assert.rejects(client.call("todo_create", { title: "invalid blocker", blocked_by: [todo, 999999], project_id: alpha.id }), /No todo/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM todos").get().n, todosBefore);
  assert.deepEqual(db.prepare("SELECT * FROM todo_blockers").all(), blockersBefore);
  const active = await client.call("wake_set", { delay_seconds: 3600, body: "keep", deliver_to: lead.id, project_id: alpha.id });
  db.prepare("INSERT INTO wakes (project_id, owner, body, kind, parent_wake_id, deliver_actor, deliver_pane, due_at) VALUES (?, ?, 'notice', 'delay', ?, ?, '%none', datetime('now', '+1 day'))").run(alpha.id, q.actor_id, active.wake_id, lead.actor_id);
  db.prepare("UPDATE todos SET updated_at = '2000-01-01' WHERE id = ?").run(todo);
  const state = () => ({ todos: db.prepare("SELECT * FROM todos").all(), comments: db.prepare("SELECT * FROM todo_comments").all(), blockers: db.prepare("SELECT * FROM todo_blockers").all(), wakes: db.prepare("SELECT * FROM wakes").all() });
  const snapshot = state();
  db.exec("CREATE TRIGGER break_audit BEFORE INSERT ON queen_audit BEGIN SELECT RAISE(ABORT, 'audit broken'); END");
  try {
    for (const [name, args] of [
      ["todo_create", { title: "roll back", blocked_by: [todo] }],
      ["todo_comment", { todo_id: todo, body: "roll back" }],
      ["wake_set", { delay_seconds: 3600, body: "roll back", deliver_to: lead.id }],
      ["wake_when_idle", { agents: [worker.id], body: "roll back", deliver_to: lead.id }],
      ["wake_update", { wake_id: active.wake_id, body: "roll back" }],
      ["wake_cancel", { wake_id: active.wake_id }],
    ]) {
      await assert.rejects(client.call(name, { ...args, project_id: alpha.id }), /audit broken/);
      assert.deepEqual(state(), snapshot, name);
    }
  } finally { db.exec("DROP TRIGGER break_audit"); }
  assert.equal(trail().length, before + 1);
});
it("home and ordinary-lead calls do not audit, and concurrent target calls keep their metadata separate", needsTmux, async () => {
  const before = trail().length;
  await client.call("todo_create", { title: "home", project_id: queen.id });
  const ordinary = new McpClient({ cwd: alpha.path, dataDir: dirs.dataDir, env: { HIVE_AGENT_ID: lead.actor_id } });
  try { await ordinary.start(); await ordinary.call("todo_create", { title: "ordinary", project_id: beta.id }); } finally { await ordinary.close(); }
  assert.equal(trail().length, before);
  const [a, b] = await Promise.all([client.call("todo_create", { title: "concurrent alpha", project_id: alpha.id }), client.call("todo_create", { title: "concurrent beta", project_id: beta.id })]);
  assert.equal(trail().length, before + 2);
  for (const [target, receipt, title] of [[alpha, a, "concurrent alpha"], [beta, b, "concurrent beta"]]) {
    const row = trail().find((r) => r.resource_id === receipt.todo_id && r.operation === "todo_create");
    assert.deepEqual([row.target_project_id, row.summary], [target.id, title]);
  }
});
it("successful submit=false paste audits its disposition and failed audit reports text already landed", needsTmux, async () => {
  let target = await freshPane();
  let before = trail().length;
  const sent = await client.call("agent_send", { agent_id: lead.id, text: "paste without enter", submit: false, project_id: alpha.id });
  assert.equal(sent.sent, true);
  assert.equal(trail().length, before + 1);
  assert.match(trail().at(-1).summary, /pasted without submit: paste without enter/);
  assert.ok(execFileSync("tmux", ["capture-pane", "-t", target, "-p"], { encoding: "utf8" }).includes("paste without enter"));
  target = await freshPane();
  before = trail().length;
  db.exec("CREATE TRIGGER break_audit BEFORE INSERT ON queen_audit BEGIN SELECT RAISE(ABORT, 'audit broken'); END");
  try { await assert.rejects(client.call("agent_send", { agent_id: lead.id, text: "already landed unique", project_id: alpha.id }), /write-completed-audit-failed.*already landed/); }
  finally { db.exec("DROP TRIGGER break_audit"); }
  assert.equal(trail().length, before);
  assert.equal(await until(() => execFileSync("tmux", ["capture-pane", "-t", target, "-p"], { encoding: "utf8" }).includes("already landed unique")), true);
});
it("paste failure, ambiguous timeout, stranded paste and guard refusal claim no completed send", needsTmux, async () => {
  const realTmux = execFileSync("which", ["tmux"], { encoding: "utf8" }).trim();
  const bin = join(dirs.tmp, "tmux-fault-bin");
  mkdirSync(bin);
  const control = join(bin, "control");
  const log = join(bin, "calls.jsonl");
  writeFileSync(log, "");
  writeFileSync(join(bin, "tmux"), `#!/usr/bin/env node\nconst fs = require('node:fs'); const {spawnSync} = require('node:child_process');
const args=process.argv.slice(2); const mode=fs.readFileSync(${JSON.stringify(control)},'utf8');
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args)+'\\n');
if(args[0]==='paste-buffer' && mode==='timeout') { setTimeout(()=>{},60000); }
else if((args[0]==='paste-buffer' && mode==='paste') || (args[0]==='send-keys' && args.includes('Enter') && mode==='enter') || (args[0]==='capture-pane' && mode==='tail')) { process.stderr.write('tmux: fixture error'); process.exit(1); }
else { const r=spawnSync(${JSON.stringify(realTmux)},args,{stdio:'inherit'}); if(args[0]==='send-keys' && args.includes('Enter') && mode==='after') fs.writeFileSync(${JSON.stringify(control)},'tail'); process.exit(r.status??1); }
`);
  chmodSync(join(bin, "tmux"), 0o755);
  for (const [mode, error] of [["paste", /fixture error/], ["timeout", /paste-timeout-ambiguous/], ["enter", /paste-landed-enter-failed/]]) {
    await freshPane();
    writeFileSync(control, mode);
    const faultClient = new McpClient({ cwd: queen.path, dataDir: dirs.dataDir, env: { HIVE_AGENT_ID: q.actor_id, PATH: `${bin}:${process.env.PATH}`, HIVE_TMUX_TIMEOUT_MS: "1000", HIVE_SCHEDULER_INTERVAL_MS: "3600000" } });
    const before = trail().length;
    try {
      await faultClient.start();
      await assert.rejects(faultClient.call("agent_send", { agent_id: lead.id, text: `fault ${mode}`, project_id: alpha.id }), error);
      assert.equal(trail().length, before);
    } finally { await faultClient.close(); }
  }
  const target = await freshPane();
  execFileSync("tmux", ["copy-mode", "-t", target]);
  const before = trail().length;
  const refused = await client.call("agent_send", { agent_id: lead.id, text: "copy mode hold", project_id: alpha.id });
  assert.equal(refused.sent, false);
  assert.equal(trail().length, before);
  execFileSync("tmux", ["send-keys", "-t", target, "-X", "cancel"]);
  await freshPane();
  writeFileSync(control, "after");
  const tailClient = new McpClient({ cwd: queen.path, dataDir: dirs.dataDir, env: { HIVE_AGENT_ID: q.actor_id, PATH: `${bin}:${process.env.PATH}`, HIVE_SCHEDULER_INTERVAL_MS: "3600000" } });
  try {
    await tailClient.start();
    const sent = await tailClient.call("agent_send", { agent_id: lead.id, text: "tail failure after send", wait_ms: 250, project_id: alpha.id });
    assert.equal(sent.sent, true);
    assert.match(sent.note, /tail could not be read/);
    assert.equal(trail().length, before + 1);
    assert.match(trail().at(-1).summary, /tail failure after send/);
  } finally { await tailClient.close(); }
  const calls = readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(calls.filter((a) => a[0] === "paste-buffer").length, 4);
});
it("real cross-project writes and adoption are readable through both surfaces and the target lead", needsTmux, async () => {
  const before = trail().length;
  const adopted = await runCli(["lead", beta.path, "--detach", "--no-dashboard"], { cwd: queen.path, dataDir: dirs.dataDir, env: { HIVE_AGENT_ID: q.actor_id } });
  assert.equal(adopted.code, 0, adopted.stdout + adopted.stderr);
  assert.equal(trail().length, before + 1);
  assert.match(trail().at(-1).summary, /^adopted/);
  const expected = trail().reverse();
  const all = await client.call("queen_audit_list", { limit: 100 });
  assert.deepEqual(all.entries, expected);
  assert.deepEqual(new Set(all.entries.map((r) => r.operation)), new Set(Object.keys(fixture)));
  assert.ok(all.entries.every((r) => r.actor_id === q.actor_id));
  const filtered = await client.call("queen_audit_list", { project_id: alpha.id, limit: 100 });
  const alphaEntries = expected.filter((r) => r.target_project_id === alpha.id);
  assert.deepEqual(filtered.entries, alphaEntries);
  const targetLead = new McpClient({ cwd: alpha.path, dataDir: dirs.dataDir, env: { HIVE_AGENT_ID: lead.actor_id, HIVE_SCHEDULER_INTERVAL_MS: "3600000" } });
  try { await targetLead.start(); assert.deepEqual((await targetLead.call("queen_audit_list", { limit: 100 })).entries, alphaEntries); }
  finally { await targetLead.close(); }
  const cli = await runCli(["queen-audit", "--json", "--limit", "100"], { cwd: queen.path, dataDir: dirs.dataDir, env: { HIVE_AGENT_ID: q.actor_id } });
  assert.equal(cli.code, 0, cli.stderr);
  assert.deepEqual(JSON.parse(cli.stdout).entries, expected);
  const cliAlpha = await runCli(["queen-audit", "--json", "--limit", "100", "--project-id", String(alpha.id)], { cwd: queen.path, dataDir: dirs.dataDir, env: { HIVE_AGENT_ID: q.actor_id } });
  assert.equal(cliAlpha.code, 0, cliAlpha.stderr);
  assert.deepEqual(JSON.parse(cliAlpha.stdout).entries, alphaEntries);
  const auditBefore = trail().length;
  await client.call("todo_create", { title: "another home todo", project_id: queen.id });
  await assert.rejects(client.call("pad_write", { name: "board", content: "refused", project_id: alpha.id }), /QUEEN_CROSS_PROJECT_WRITE_REFUSED/);
  assert.equal((await client.call("wake_cancel", { wake_id: wake, project_id: alpha.id })).cancelled, false);
  assert.equal(trail().length, auditBefore);
});
