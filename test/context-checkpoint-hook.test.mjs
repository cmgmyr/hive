import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { after, describe, it } from "node:test";
import { clearHiveEnv, DIST, isolateTmux, scratchDirs } from "./helpers.mjs";

const { cleanup } = isolateTmux("context checkpoint hook");
after(cleanup);
clearHiveEnv();
const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
mkdirSync(dirs.dataDir, { recursive: true });
const { recordClaudeWindowSize } = await import("../dist/statusline.js");
const HOOK = join(DIST, "hook.js");
let seq = 0;
function fixture(kind) {
  const actor = `agent:checkpoint-${seq++}`;
  const path = join(dirs.dataDir, `${actor}.jsonl`);
  if (kind === "claude") recordClaudeWindowSize(actor, JSON.stringify({ context_window: { context_window_size: 100000 } }));
  const input = JSON.stringify({ cwd: dirs.tmp, session_id: "session", transcript_path: path });
  return { kind, actor, path, input, marker: join(dirs.dataDir, "context-checkpoints", `${encodeURIComponent(actor)}.fired`) };
}
function usage(f, input) {
  const record = f.kind === "claude"
    ? { type: "assistant", message: { id: `request-${input}`, usage: { input_tokens: input, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }
    : { type: "event_msg", payload: { type: "token_count", info: {
      last_token_usage: { input_tokens: input, cached_input_tokens: input - 1 },
      total_token_usage: { input_tokens: 41000000 }, model_context_window: 100000,
    } } };
  writeFileSync(f.path, JSON.stringify(record) + "\n");
}
function command(f, options = {}) {
  return {
    args: [...(options.nodeArgs ?? []), HOOK, "post_tool_use", f.kind],
    options: { input: options.input ?? f.input, encoding: "utf8", env: {
      ...process.env, HIVE_AGENT_ID: f.actor, HIVE_CONTEXT_CHECKPOINT_PERCENT: options.threshold ?? "35",
    } },
  };
}
function run(f, options) {
  const spec = command(f, options);
  const result = spawnSync(process.execPath, spec.args, spec.options);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}
function expected(percent, threshold = 35) {
  return { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext:
    `Context is at ${percent}% of its 100000-token window; the configured checkpoint threshold is ${threshold}%.`,
  } };
}
function concurrent(f) {
  const spec = command(f);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, spec.args, { env: spec.options.env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (data) => stdout += data);
    child.stderr.on("data", (data) => stderr += data);
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(stdout) : reject(new Error(stderr)));
    child.stdin.end(f.input);
  });
}

for (const kind of ["claude", "codex"]) {
  describe(`${kind} PostToolUse crossing`, () => {
    it("fires once at the exact threshold, stays silent above including resume, and rearms only after a low observation", () => {
      const f = fixture(kind);
      usage(f, 34995);
      assert.equal(run(f), "");
      assert.equal(existsSync(f.marker), false);
      usage(f, 35000);
      assert.deepEqual(JSON.parse(run(f)), expected(35));
      const marker = statSync(f.marker, { bigint: true });
      usage(f, 79000);
      assert.equal(run(f), "");
      f.input = JSON.stringify({ ...JSON.parse(f.input), session_id: "resumed-session" });
      assert.equal(run(f), "");
      assert.equal(statSync(f.marker, { bigint: true }).mtimeNs, marker.mtimeNs);
      usage(f, 12000);
      assert.equal(run(f), "");
      assert.equal(existsSync(f.marker), false);
      usage(f, 72000);
      assert.deepEqual(JSON.parse(run(f)), expected(72));
    });

    it("allows exactly one concurrent upward emission", async () => {
      const f = fixture(kind);
      usage(f, 10000);
      assert.equal(run(f), "");
      usage(f, 50000);
      const outputs = await Promise.all(Array.from({ length: 6 }, () => concurrent(f)));
      assert.equal(outputs.filter(Boolean).length, 1);
      assert.deepEqual(JSON.parse(outputs.find(Boolean)), expected(50));
    });

    it("silently ignores absent, malformed and mid-write data without creating a marker", () => {
      const f = fixture(kind);
      assert.equal(run(f), "");
      for (const body of ["", "not JSON\n", '{"type":"assistant","message":', 'x'.repeat(300000), "null\n"]) {
        writeFileSync(f.path, body);
        assert.equal(run(f), "");
        assert.equal(existsSync(f.marker), false);
      }
      usage(f, 10000);
      writeFileSync(f.path, readFileSync(f.path, "utf8") + '{"type":');
      assert.equal(run(f), "");
      for (const input of ["null", "[]", "not json", "{}", '{"transcript_path":12}']) assert.equal(run(f, { input }), "");
      assert.equal(existsSync(f.marker), false);
    });
  });
}

describe("hot-path isolation", () => {
  it("returns before any transcript read when the project threshold is unset or invalid", () => {
    const f = fixture("codex");
    usage(f, 50000);
    const observed = join(dirs.tmp, "transcript-read");
    const preload = join(dirs.tmp, "observe-read.mjs");
    writeFileSync(preload, `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
      const open = fs.openSync;
      fs.openSync = function(path, ...args) {
        if (path === ${JSON.stringify(f.path)}) fs.writeFileSync(${JSON.stringify(observed)}, 'read');
        return open.call(this, path, ...args);
      }; syncBuiltinESMExports();`);
    const nodeArgs = ["--import", pathToFileURL(preload).href];
    for (const threshold of ["", "0", "101", "1.5", "bad"]) {
      assert.equal(run(f, { threshold, nodeArgs }), "");
      assert.equal(existsSync(observed), false);
    }
    assert.deepEqual(JSON.parse(run(f, { nodeArgs })), expected(50));
    assert.equal(existsSync(observed), true);
  });

  it("emits context without loading hooks, SQLite or the native addon, while the same guard detects a state event", () => {
    const f = fixture("codex");
    usage(f, 50000);
    const observed = join(dirs.tmp, "forbidden-import");
    const loader = join(dirs.tmp, "guard-loader.mjs");
    writeFileSync(loader, `import { writeFileSync } from 'node:fs';
      export async function resolve(specifier, context, next) {
        if (specifier.endsWith('/db.js') || specifier.endsWith('/hooks.js') || specifier === 'better-sqlite3' || specifier.endsWith('.node')) {
          writeFileSync(${JSON.stringify(observed)}, specifier); throw new Error('forbidden import ' + specifier);
        }
        return next(specifier, context);
      }`);
    const nodeArgs = ["--loader", pathToFileURL(loader).href];
    assert.deepEqual(JSON.parse(run(f, { nodeArgs })), expected(50));
    assert.equal(existsSync(observed), false);
    const control = spawnSync(process.execPath, [...nodeArgs, HOOK, "prompt"], { env: { ...process.env, HIVE_AGENT_ID: f.actor }, encoding: "utf8", input: "{}" });
    assert.notEqual(control.status, 0);
    assert.match(readFileSync(observed, "utf8"), /db\.js$/);
  });

  it("writes nothing in the data directory on steady low observations", () => {
    const f = fixture("codex");
    usage(f, 10000);
    const snapshot = () => readdirSync(dirs.dataDir, { recursive: true }).map((entry) => {
      const stat = statSync(join(dirs.dataDir, entry), { bigint: true });
      return [entry, String(stat.mtimeNs), String(stat.size)];
    });
    const before = snapshot();
    assert.equal(run(f), "");
    assert.equal(run(f), "");
    assert.deepEqual(snapshot(), before);
  });

  it("never injects into a lead or an unknown harness", () => {
    const f = fixture("codex");
    usage(f, 50000);
    assert.equal(run({ ...f, actor: "lead:1" }), "");
    assert.equal(run({ ...f, kind: "unknown" }), "");
  });
});
