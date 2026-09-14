import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { clearHiveEnv, isolateTmux, liveAgentRow, McpClient, scratchDirs, until } from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("worker peer messaging off");
clearHiveEnv();
const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const home = join(dirs.tmp, "home");
mkdirSync(join(home, ".codex"), { recursive: true });
writeFileSync(join(home, ".codex", "auth.json"), "{}");
const binaries = join(dirs.tmp, "bin");
mkdirSync(binaries);
for (const kind of ["claude", "codex"]) {
  writeFileSync(join(binaries, kind), '#!/bin/sh\nsleep 600\n', { mode: 0o755 });
}
let mcp;
before(async () => {
  mcp = new McpClient({ cwd: dirs.projectDir, dataDir: dirs.dataDir, env: { HOME: home, HIVE_SPAWN_READY_MS: "1" } });
  await mcp.start();
});
after(async () => {
  await mcp.close();
  const { sessionName } = await import("../dist/tmux.js");
  cleanup(sessionName());
});
function config() {
  writeFileSync(join(dirs.projectDir, "hive.yml"), "agents: [claude, codex]\n");
}
function hooks(row, kind) {
  const path = kind === "claude" ? join(dirs.dataDir, `worker-${row.id}-hooks.json`) : join(dirs.dataDir, "codex-homes", row.codex_home, "hooks.json");
  return JSON.parse(readFileSync(path, "utf8"));
}
function assertWorkerMessagingOff(settings) {
  assert.deepEqual(settings.permissions.deny, ["SendMessage", "ListAgents"]);
  assert.equal(settings.crossSessionInbound, "refuse");
  assert.ok(settings.hooks.Stop);
  assert.ok(settings.hooks.UserPromptSubmit);
  assert.ok(settings.hooks.Notification);
  assert.ok(settings.hooks.SessionEnd);
}

describe("worker peer messaging settings", () => {
  it("a spawned claude worker's settings deny SendMessage and ListAgents and refuse inbound peer messages", { skip: !hasTmux }, async () => {
    config();
    await mcp.call("agent_spawn", { name: "claude-peer-off", command: join(binaries, "claude") });
    const summary = await liveAgentRow(mcp, "claude-peer-off");
    const { db } = await import("../dist/db.js");
    const row = db.prepare("SELECT * FROM agents WHERE id = ?").get(summary.agent_id);
    assertWorkerMessagingOff(hooks(row, "claude"));
    await mcp.call("agent_close", { name: "claude-peer-off" });
  });

  it("a resumed claude worker's settings carry the same two keys", { skip: !hasTmux }, async () => {
    config();
    await mcp.call("agent_spawn", { name: "claude-peer-resume", command: join(binaries, "claude") });
    const summary = await liveAgentRow(mcp, "claude-peer-resume");
    const { db } = await import("../dist/db.js");
    const row = db.prepare("SELECT * FROM agents WHERE id = ?").get(summary.agent_id);
    db.prepare("UPDATE agents SET session_id = 'resume-peer' WHERE id = ?").run(row.id);
    await mcp.call("agent_park", { name: "claude-peer-resume" });
    await mcp.call("agent_resume", { agent_id: row.id });
    assert.ok(await until(() => existsSync(join(dirs.dataDir, `worker-${row.id}-hooks.json`)), 5000));
    assertWorkerMessagingOff(hooks(row, "claude"));
    await mcp.call("agent_close", { name: "claude-peer-resume" });
  });

  it("a codex worker's hooks file carries neither key", { skip: !hasTmux }, async () => {
    config();
    await mcp.call("agent_spawn", { name: "codex-peer-off", command: join(binaries, "codex") });
    const summary = await liveAgentRow(mcp, "codex-peer-off");
    const { db } = await import("../dist/db.js");
    const row = db.prepare("SELECT * FROM agents WHERE id = ?").get(summary.agent_id);
    const settings = hooks(row, "codex");
    assert.equal(settings.permissions, undefined);
    assert.equal(settings.crossSessionInbound, undefined);
    await mcp.call("agent_close", { name: "codex-peer-off" });
  });

  it("the lead's hooks file carries neither key", { skip: !hasTmux }, async () => {
    config();
    const { ensureHooksFile } = await import("../dist/hooks.js");
    const settings = JSON.parse(readFileSync(ensureHooksFile(), "utf8"));
    assert.equal(settings.permissions, undefined);
    assert.equal(settings.crossSessionInbound, undefined);
  });
});
