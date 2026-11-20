import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { clearHiveEnv, isolateTmux, liveAgentRow, McpClient, scratchDirs, until } from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("worker ide autoconnect");
clearHiveEnv();
delete process.env.CLAUDE_CODE_AUTO_CONNECT_IDE;
const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const home = join(dirs.tmp, "home");
mkdirSync(join(home, ".codex"), { recursive: true });
writeFileSync(join(home, ".codex", "auth.json"), "{}");
const binaries = join(dirs.tmp, "bin");
mkdirSync(binaries);
for (const kind of ["claude", "codex"]) {
  writeFileSync(join(binaries, kind), '#!/bin/sh\n/usr/bin/env | /usr/bin/grep "^CLAUDE_CODE_AUTO_CONNECT_IDE=" > "$HIVE_DATA_DIR/$HIVE_AGENT_ID.env.tmp"\n/bin/mv "$HIVE_DATA_DIR/$HIVE_AGENT_ID.env.tmp" "$HIVE_DATA_DIR/$HIVE_AGENT_ID.env"\nexec sleep 600\n', { mode: 0o755 });
}
writeFileSync(join(dirs.projectDir, "hive.yml"), "agents: [claude, codex]\n");

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

async function paneEnv(actorId) {
  const path = join(dirs.dataDir, `${actorId}.env`);
  assert.ok(await until(() => existsSync(path), 5000));
  const text = readFileSync(path, "utf8").trim();
  return text === "" ? [] : text.split("\n");
}

describe("worker IDE auto-connect", () => {
  for (const kind of ["claude", "codex"]) {
    it(`${kind} worker pane env ${kind === "claude" ? "disables" : "does not set"} IDE auto-connect on spawn and resume`, { skip: !hasTmux }, async () => {
      const { db } = await import("../dist/db.js");
      await mcp.call("agent_spawn", { name: `${kind}-ide`, command: join(binaries, kind) });
      const summary = await liveAgentRow(mcp, `${kind}-ide`);
      const row = db.prepare("SELECT * FROM agents WHERE id = ?").get(summary.agent_id);
      const spawnEnv = await paneEnv(row.actor_id);
      assert.deepEqual(spawnEnv, kind === "claude" ? ["CLAUDE_CODE_AUTO_CONNECT_IDE=false"] : []);

      db.prepare("UPDATE agents SET session_id = 'resume-ide' WHERE id = ?").run(row.id);
      await mcp.call("agent_park", { name: `${kind}-ide` });
      const path = join(dirs.dataDir, `${row.actor_id}.env`);
      rmSync(path);
      await mcp.call("agent_resume", { agent_id: row.id });
      const resumeEnv = await paneEnv(row.actor_id);
      assert.deepEqual(resumeEnv, kind === "claude" ? ["CLAUDE_CODE_AUTO_CONNECT_IDE=false"] : []);
      await mcp.call("agent_close", { name: `${kind}-ide` });
    });
  }

  it("claude fork child pane env disables IDE auto-connect", { skip: !hasTmux }, async () => {
    const { db } = await import("../dist/db.js");
    await mcp.call("agent_spawn", { name: "claude-fork-src", command: join(binaries, "claude") });
    const summary = await liveAgentRow(mcp, "claude-fork-src");
    const transcript = join(dirs.tmp, "fork-src.jsonl");
    writeFileSync(transcript, "{}\n");
    db.prepare("UPDATE agents SET transcript_path = ? WHERE id = ?").run(transcript, summary.agent_id);
    const receipt = await mcp.call("agent_fork", { agent_id: summary.agent_id, name: "claude-fork-child" });
    assert.deepEqual(await paneEnv(receipt.actor_id), ["CLAUDE_CODE_AUTO_CONNECT_IDE=false"]);
    await mcp.call("agent_close", { name: "claude-fork-child" });
    await mcp.call("agent_close", { name: "claude-fork-src" });
  });
});
