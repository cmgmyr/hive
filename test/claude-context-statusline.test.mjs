import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { assertScratchStore, clearHiveEnv, isolateTmux, scratchDirs } from "./helpers.mjs";

const { cleanup } = isolateTmux("Claude context statusline");
after(cleanup);
clearHiveEnv();
const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
process.env.CLAUDE_CONFIG_DIR = join(dirs.tmp, "claude");
mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
await assertScratchStore();
const { db, migrate } = await import("../dist/db.js");
const { ensureHooksFile, ensureWorkerHooksFile } = await import("../dist/hooks.js");
const { effectiveClaudeStatusLine, recordClaudeWindowSize, statusLineEntry } = await import("../dist/statusline.js");
const { claudeWindowPath, readContextFill } = await import("../dist/transcript.js");
const { shellQuote } = await import("../dist/tmux.js");
migrate();
const project = db.prepare("INSERT INTO projects (name, path) VALUES (?, ?) RETURNING id").get("statusline", dirs.tmp).id;
let seq = 0;
function worker() {
  const cwd = join(dirs.tmp, `worker-${++seq}`);
  mkdirSync(join(cwd, ".claude"), { recursive: true });
  return db.prepare("INSERT INTO agents (project_id, actor_id, name, command, cwd, kind) VALUES (?, ?, ?, 'claude', ?, 'agent') RETURNING *")
    .get(project, `agent:status-${seq}`, `status-${seq}`, cwd);
}
function settings(path, statusLine) {
  writeFileSync(path, JSON.stringify({ statusLine }));
}
function run(command, actor, input, extraEnv = {}) {
  return execFileSync("/bin/sh", ["-c", command], {
    input, env: { ...process.env, HIVE_AGENT_ID: actor, ...extraEnv },
  });
}
const payload = (size) => JSON.stringify({ context_window: { context_window_size: size } });

describe("Claude worker statusline bridge", () => {
  it("registers unique worker files and leaves common/lead settings without statusLine or PostToolUse", () => {
    const a = worker();
    const b = worker();
    const first = ensureWorkerHooksFile(a.id, { includePostToolUse: false });
    const second = ensureWorkerHooksFile(b.id, { includePostToolUse: false });
    assert.notEqual(first, second);
    const common = JSON.parse(readFileSync(ensureHooksFile(), "utf8"));
    const generated = JSON.parse(readFileSync(first, "utf8"));
    assert.equal(common.statusLine, undefined);
    assert.equal(common.hooks.PostToolUse, undefined);
    assert.deepEqual(generated.hooks, common.hooks);
    assert.match(generated.statusLine.command, /statusline\.js/);
    assert.throws(() => ensureWorkerHooksFile(-1, { includePostToolUse: false }), /does not exist/);
  });

  it("chains local over project over user statusLine for the worker cwd and preserves display options", () => {
    const row = worker();
    settings(join(process.env.CLAUDE_CONFIG_DIR, "settings.json"), { type: "command", command: "printf user" });
    const projectSetting = { type: "command", command: "printf project", refreshInterval: 3, padding: 2 };
    settings(join(row.cwd, ".claude", "settings.json"), projectSetting);
    assert.deepEqual(effectiveClaudeStatusLine(row.cwd), projectSetting);
    let generated = JSON.parse(readFileSync(ensureWorkerHooksFile(row.id, { includePostToolUse: false }), "utf8"));
    assert.equal(run(generated.statusLine.command, row.actor_id, payload(1000000)).toString(), "project");
    assert.equal(generated.statusLine.refreshInterval, 3);
    assert.equal(generated.statusLine.padding, 2);
    settings(join(row.cwd, ".claude", "settings.local.json"), { type: "command", command: "printf local", refreshInterval: 1 });
    generated = JSON.parse(readFileSync(ensureWorkerHooksFile(row.id, { includePostToolUse: false }), "utf8"));
    assert.equal(run(generated.statusLine.command, row.actor_id, payload(1000000)).toString(), "local");
    assert.equal(generated.statusLine.refreshInterval, 1);
  });

  it("forwards byte-equal stdin and stdout including whitespace, unicode, and two status rows", () => {
    const actor = "agent:bytes";
    const input = Buffer.from(' { "context_window": { "context_window_size": 1000000 }, "text": "é\\nrow" } \n');
    const entry = statusLineEntry({ type: "command", command: "/bin/cat; printf '\\nsecond row\\n'" });
    assert.deepEqual(run(entry.command, actor, input), Buffer.concat([input, Buffer.from("\nsecond row\n")]));
    assert.equal(JSON.parse(readFileSync(claudeWindowPath(actor), "utf8")), 1000000);
  });

  it("records a window with no user command and provides the shared reader's denominator", () => {
    const actor = "agent:no-command";
    assert.equal(run(statusLineEntry(null).command, actor, payload(200000)).length, 0);
    const path = join(dirs.tmp, "context.jsonl");
    writeFileSync(path, JSON.stringify({ type: "assistant", message: { usage: { input_tokens: 50000 } } }) + "\n");
    assert.deepEqual(readContextFill("claude", { actor_id: actor, cwd: dirs.tmp, session_id: "", transcript_path: path }), {
      used_tokens: 50000, window_tokens: 200000, used_percent: 25,
    });
  });

  it("ignores malformed and invalid windows while still running the saved command", () => {
    for (const input of ["not json", "null", payload(0), payload(-1), payload("1000000"), payload(1.5)]) {
      const actor = `agent:invalid-${++seq}`;
      assert.equal(run(statusLineEntry({ type: "command", command: "printf alive" }).command, actor, input).toString(), "alive");
      assert.equal(existsSync(claudeWindowPath(actor)), false);
    }
    recordClaudeWindowSize("lead:1", payload(1000000));
    assert.equal(existsSync(claudeWindowPath("lead:1")), false);
  });

  it("replaces window files atomically only when the denominator changes", () => {
    const actor = "agent:atomic";
    recordClaudeWindowSize(actor, payload(200000));
    const path = claudeWindowPath(actor);
    const before = statSync(path, { bigint: true });
    recordClaudeWindowSize(actor, payload(200000));
    const unchanged = statSync(path, { bigint: true });
    assert.equal(unchanged.ino, before.ino);
    assert.equal(unchanged.mtimeNs, before.mtimeNs);
    recordClaudeWindowSize(actor, payload(1000000));
    const changed = statSync(path, { bigint: true });
    assert.notEqual(changed.ino, before.ino);
    assert.equal(readFileSync(path, "utf8"), "1000000\n");
    assert.ok(readdirSync(join(dirs.dataDir, "context-windows")).every((name) => !name.endsWith(".tmp")));
  });

  it("pins an absolute interpreter and works when PATH has no node", () => {
    const actor = "agent:pinned";
    const entry = statusLineEntry(null);
    assert.ok(entry.command.startsWith(`${shellQuote(process.execPath)} `));
    run(entry.command, actor, payload(1000000), { PATH: "/nonexistent" });
    assert.equal(readFileSync(claudeWindowPath(actor), "utf8"), "1000000\n");
  });
});
