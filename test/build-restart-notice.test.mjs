import assert from "node:assert/strict";
import { cpSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, it } from "node:test";
import { clearHiveEnv, DIST, isolateTmux, McpClient, REPO, scratchDirs, tmux } from "./helpers.mjs";

const { cleanup, hasTmux } = isolateTmux("the build restart notice tests");
clearHiveEnv();
after(() => cleanup());
const stamp = { version: "1.2.3", sha: "abc", dirty: true, build_id: "loaded" };

async function fixture(kind) {
  const dirs = scratchDirs();
  const root = join(dirs.tmp, "package");
  mkdirSync(root);
  cpSync(DIST, join(root, "dist"), { recursive: true });
  symlinkSync(join(REPO, "node_modules"), join(root, "node_modules"), "dir");
  writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module" }));
  const path = join(root, "dist", "build-info.json");
  const swap = (value) => {
    writeFileSync(path + ".tmp", typeof value === "string" ? value : JSON.stringify(value));
    renameSync(path + ".tmp", path);
    assert.equal(readFileSync(path, "utf8"), typeof value === "string" ? value : JSON.stringify(value));
  };
  swap(stamp);
  process.env.HIVE_DATA_DIR = dirs.dataDir;
  delete process.env.HIVE_AGENT_ID;
  const { db, migrate } = await import(join(root, "dist", "db.js"));
  assert.ok(db.name.startsWith(dirs.dataDir));
  migrate();
  const project = db.prepare("INSERT INTO projects (name, path) VALUES ('fixture', ?) RETURNING id").get(dirs.projectDir);
  const actor = kind === "lead" ? "lead:900" : "agent:900";
  if (kind) db.prepare(`INSERT INTO agents (project_id, actor_id, name, command, cwd, kind)
    VALUES (?, ?, 'fixture-session', 'claude', ?, ?)`).run(project.id, actor, dirs.projectDir, kind);
  const client = () => new McpClient({ cwd: dirs.projectDir, dataDir: dirs.dataDir,
    server: join(root, "dist", "index.js"), env: kind ? { HIVE_AGENT_ID: actor } : {} });
  return { ...dirs, root, db, actor, project, path, swap, client };
}
const call = async (mcp, name = "whoami", args = {}) =>
  (await mcp.request("tools/call", { name, arguments: args })).result;
const changed = (id) => ({ ...stamp, build_id: id });

it("real server preserves its primary receipt and reports each disk id once, including concurrent calls", async () => {
  const f = await fixture("lead");
  const mcp = f.client();
  await mcp.start();
  try {
    const before = await call(mcp);
    assert.equal(before.content.length, 1);
    f.swap(changed("second"));
    const after = await call(mcp);
    assert.deepEqual(after.content[0], before.content[0]);
    assert.equal(after.content.length, 2);
    assert.match(after.content[1].text, /loaded hive 1\.2\.3 \(abc-dirty, build loaded\); the build on disk changed to hive 1\.2\.3 \(abc-dirty, build second\).*reconnect hive in \/mcp/);
    assert.equal((await call(mcp)).content.length, 1);
    f.swap(changed("third"));
    const results = await Promise.all([call(mcp), call(mcp)]);
    assert.equal(results.filter((r) => r.content.length === 2).length, 1);
    f.swap(changed("second"));
    assert.equal((await call(mcp)).content.length, 1);
  } finally { await mcp.close(); f.db.close(); }
});

it("index.js captures the build before its first tool call, not on first detector use", async () => {
  const f = await fixture();
  const mcp = f.client();
  await mcp.start();
  try {
    f.swap(changed("before-first-tool"));
    const result = await call(mcp);
    assert.equal(result.content.length, 2);
    assert.match(result.content[1].text, /loaded hive 1\.2\.3 \(abc-dirty, build loaded\);.*build before-f/);
  } finally { await mcp.close(); f.db.close(); }
});

it("a worker-row server reports neither a trailer nor a scheduler notice after two builds", async () => {
  const f = await fixture("agent");
  f.db.prepare("UPDATE agents SET tmux_target = '%900' WHERE actor_id = ?").run(f.actor);
  f.db.prepare(`INSERT INTO agents (project_id, actor_id, name, command, cwd, kind, tmux_target)
    VALUES (?, 'lead:901', 'other-lead', 'claude', ?, 'lead', '%901')`).run(f.project.id, f.projectDir);
  const mcp = f.client();
  await mcp.start();
  try {
    for (const id of ["second", "third"]) {
      f.swap(changed(id));
      assert.equal((await call(mcp)).content.length, 1);
      process.env.HIVE_AGENT_ID = f.actor;
      const { tick } = await import(join(f.root, "dist", "scheduler.js"));
      await tick({ panes: new Set(["%900", "%901"]), windows: new Set(), pids: new Map() });
      assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM wakes").get().n, 0);
    }
  } finally { await mcp.close(); f.db.close(); }
});

it("missing, malformed and legacy disk stamps stay silent through both surfaces and recover", async () => {
  const f = await fixture("lead");
  process.env.HIVE_AGENT_ID = f.actor;
  const { tick } = await import(join(f.root, "dist", "scheduler.js"));
  const mcp = f.client();
  await mcp.start();
  try {
    for (const value of [null, "{", { version: "1.2.3", sha: "abc", dirty: true }]) {
      if (value === null) rmSync(f.path); else f.swap(value);
      assert.equal((await call(mcp)).content.length, 1);
      await assert.doesNotReject(tick({ panes: new Set(), windows: new Set(), pids: new Map() }));
      assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM wakes").get().n, 0);
    }
    f.swap(changed("recovered"));
    assert.equal((await call(mcp)).content.length, 2);
  } finally { await mcp.close(); f.db.close(); }
});

it("error receipts retain isError and primary text when the restart trailer is appended", async () => {
  const f = await fixture();
  const mcp = f.client();
  await mcp.start();
  try {
    const before = await call(mcp, "todo_get", { todo_id: 999 });
    assert.equal(before.isError, true);
    f.swap(changed("error-build"));
    const after = await call(mcp, "todo_get", { todo_id: 999 });
    assert.equal(after.isError, true);
    assert.deepEqual(after.content[0], before.content[0]);
    assert.equal(after.content.length, 2);
  } finally { await mcp.close(); f.db.close(); }
});

it("two ticks file one notice to the server's own lead and a second build files another, preserving authored wakes", { skip: !hasTmux }, async () => {
  const f = await fixture("lead");
  process.env.HIVE_AGENT_ID = f.actor;
  const { tick } = await import(join(f.root, "dist", "scheduler.js"));
  const { liveTargets, tmuxSocketPath } = await import(join(f.root, "dist", "tmux.js"));
  mkdirSync(dirname(tmuxSocketPath(process.env.TMUX, process.env.TMUX_TMPDIR)), { recursive: true, mode: 0o700 });
  const pane = tmux("new-session", "-d", "-s", "restart-notice", "-P", "-F", "#{pane_id}", "cat");
  f.db.prepare("UPDATE agents SET tmux_target = ?, tmux_socket = ? WHERE actor_id = ?").run(pane, tmuxSocketPath(process.env.TMUX, process.env.TMUX_TMPDIR), f.actor);
  f.db.prepare(`INSERT INTO agents (project_id, actor_id, name, command, cwd, kind)
    VALUES (?, 'lead:901', 'other-lead', 'claude', ?, 'lead')`).run(f.project.id, f.projectDir);
  const authored = "Remember the exact body.\nNo added restart instructions.";
  const wake = f.db.prepare(`INSERT INTO wakes (project_id, owner, body, kind, deliver_actor, deliver_pane, due_at)
    VALUES (?, ?, ?, 'delay', ?, ?, datetime('now', '+1 day')) RETURNING id`).get(f.project.id, f.actor, authored, f.actor, pane);
  const notices = () => f.db.prepare("SELECT * FROM wakes WHERE id != ? ORDER BY id").all(wake.id);
  try {
    await tick(liveTargets());
    assert.equal(notices().length, 0);
    f.swap(changed("second"));
    assert.ok(liveTargets()?.panes.has(pane), JSON.stringify({pane, rows: [...(liveTargets()?.panes ?? [])]}));
    const { runningBuildChange } = await import(join(f.root, "dist", "version.js"));
    assert.equal(runningBuildChange()?.disk.build_id, "second");
    await tick(liveTargets());
    await tick(liveTargets());
    assert.equal(notices().length, 1);
    const notice = notices()[0];
    assert.equal(notice.deliver_actor, f.actor);
    assert.equal(notice.deliver_pane, pane);
    assert.equal(notice.parent_wake_id, null);
    assert.match(notice.body, /this session's hive server loaded hive 1\.2\.3 \(abc-dirty, build loaded\);.*second.*Restart this session/);
    assert.ok(notice.typed_at, "the real private pane must receive the notice");
    const screen = tmux("capture-pane", "-p", "-t", pane, "-J", "-S", "-100");
    assert.ok(screen.includes(notice.body), screen);
    f.swap(changed("third"));
    await tick(liveTargets());
    await tick(liveTargets());
    assert.equal(notices().length, 2);
    assert.equal(f.db.prepare("SELECT body FROM wakes WHERE id = ?").get(wake.id).body, authored);
  } finally { cleanup("restart-notice"); f.db.close(); }
});

it("no live own lead or a failed insertion stays retryable, and never targets another lead", async () => {
  const f = await fixture("lead");
  process.env.HIVE_AGENT_ID = f.actor;
  const { reportRunningBuildChange } = await import(join(f.root, "dist", "scheduler.js"));
  const snapshot = { panes: new Set(["%900"]), windows: new Set(), pids: new Map([["%900", "900"]]) };
  const count = () => f.db.prepare("SELECT COUNT(*) AS n FROM wakes").get().n;
  f.db.prepare(`INSERT INTO agents (project_id, actor_id, name, command, cwd, kind, tmux_target)
    VALUES (?, 'lead:901', 'other-lead', 'claude', ?, 'lead', '%900')`).run(f.project.id, f.projectDir);
  try {
    f.swap(changed("retry"));
    delete process.env.HIVE_AGENT_ID;
    reportRunningBuildChange(snapshot);
    assert.equal(count(), 0);
    process.env.HIVE_AGENT_ID = f.actor;
    reportRunningBuildChange(snapshot);
    assert.equal(count(), 0);
    f.db.prepare("UPDATE agents SET tmux_target = '%900', pane_pid = '901' WHERE actor_id = ?").run(f.actor);
    reportRunningBuildChange(snapshot);
    assert.equal(count(), 0, "a reused pane is not the lead's live pane");
    f.db.prepare("UPDATE agents SET pane_pid = '900' WHERE actor_id = ?").run(f.actor);
    f.db.exec("CREATE TRIGGER reject_notice BEFORE INSERT ON wakes BEGIN SELECT RAISE(ABORT, 'fixture failure'); END");
    assert.doesNotThrow(() => reportRunningBuildChange(snapshot));
    assert.equal(count(), 0);
    f.db.exec("DROP TRIGGER reject_notice");
    reportRunningBuildChange(snapshot);
    assert.equal(count(), 1);
    reportRunningBuildChange(snapshot);
    assert.equal(count(), 1);
  } finally { f.db.close(); }
});


it("a store-replaced refusal remains primary and does not consume or lose the build trailer", async () => {
  const f = await fixture("lead");
  process.env.HIVE_AGENT_ID = f.actor;
  const { run } = await import(join(f.root, "dist", "result.js"));
  try {
    f.swap(changed("replacement-build"));
    const replacement = f.db.name + ".replacement";
    writeFileSync(replacement, "replacement inode");
    renameSync(replacement, f.db.name);
    const result = await run(() => { throw new Error("must not execute"); });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /store on disk was replaced/);
    assert.equal(result.content.length, 2);
    assert.match(result.content[1].text, /build replacem/);
    assert.equal((await run(() => null)).content.length, 1);
  } finally { f.db.close(); }
});

const BUILD_NOTICE = /the build on disk changed to hive 1\.2\.3 \(abc-dirty, build second\)/;

it("an outputSchema tool carries the restart notice in structuredContent.hive_notice on the first result only", async () => {
  const f = await fixture("lead");
  const mcp = f.client();
  await mcp.start();
  try {
    const listed = (await mcp.request("tools/list", {})).result.tools.find((t) => t.name === "kv_set");
    assert.equal(listed.outputSchema.properties.hive_notice.type, "string");
    assert.ok(!listed.outputSchema.required?.includes("hive_notice"));
    const set = (key) => call(mcp, "kv_set", { key, value: 1 });
    const quiet = await set("a");
    assert.equal(quiet.structuredContent.hive_notice, undefined);
    f.swap(changed("second"));
    const first = await set("b");
    assert.match(first.structuredContent.hive_notice, BUILD_NOTICE);
    assert.equal(first.structuredContent.key, "b");
    assert.match(first.content[1].text, BUILD_NOTICE);
    const second = await set("c");
    assert.equal(second.structuredContent.hive_notice, undefined);
    assert.equal(second.content.length, 1);
  } finally { await mcp.close(); f.db.close(); }
});

it("the registration notice and the restart notice share one hive_notice string, then neither repeats", async () => {
  const f = await fixture();
  const mcp = new McpClient({ cwd: f.tmp, dataDir: f.dataDir, server: join(f.root, "dist", "index.js") });
  await mcp.start();
  try {
    f.swap(changed("second"));
    const first = await call(mcp, "kv_set", { key: "a", value: 1 });
    const notice = first.structuredContent.hive_notice;
    assert.match(notice, /no registered project matched this session's working directory/);
    assert.match(notice, BUILD_NOTICE);
    const again = await call(mcp, "kv_set", { key: "b", value: 1 });
    assert.equal(again.structuredContent.hive_notice, undefined);
  } finally { await mcp.close(); f.db.close(); }
});

it("an error result on an outputSchema tool keeps the restart notice in content and never sets structuredContent", async () => {
  const f = await fixture("lead");
  const mcp = f.client();
  await mcp.start();
  try {
    f.swap(changed("second"));
    const failed = await call(mcp, "todo_comment", { todo_id: 999, body: "x" });
    assert.equal(failed.isError, true);
    assert.equal(failed.structuredContent, undefined);
    assert.match(failed.content[1].text, BUILD_NOTICE);
    assert.equal((await call(mcp, "kv_set", { key: "a", value: 1 })).structuredContent.hive_notice, undefined);
  } finally { await mcp.close(); f.db.close(); }
});

it("a tool without outputSchema keeps the restart notice as a second content item", async () => {
  const f = await fixture("lead");
  const mcp = f.client();
  await mcp.start();
  try {
    f.swap(changed("second"));
    const result = await call(mcp, "pad_list");
    assert.equal(result.structuredContent, undefined);
    assert.match(result.content[1].text, BUILD_NOTICE);
  } finally { await mcp.close(); f.db.close(); }
});

it("a kind=agent actor gets no hive_notice on an outputSchema tool after a rebuild", async () => {
  const f = await fixture("agent");
  const mcp = f.client();
  await mcp.start();
  try {
    f.swap(changed("second"));
    const result = await call(mcp, "kv_set", { key: "a", value: 1 });
    assert.equal(result.structuredContent.hive_notice, undefined);
    assert.equal(result.content.length, 1);
  } finally { await mcp.close(); f.db.close(); }
});
