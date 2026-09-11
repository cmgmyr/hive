import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { clearHiveEnv, isolateTmux, liveAgentRow, McpClient, scratchDirs, until } from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("context checkpoint spawn");
clearHiveEnv();
const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const home = join(dirs.tmp, "home");
mkdirSync(join(home, ".codex"), { recursive: true });
writeFileSync(join(home, ".codex", "auth.json"), '{}');
const binaries = join(dirs.tmp, "bin");
mkdirSync(binaries);
for (const kind of ["claude", "codex"]) {
  writeFileSync(join(binaries, kind), '#!/bin/sh\n/usr/bin/env > "$HIVE_DATA_DIR/$HIVE_AGENT_ID.env.tmp"\n/bin/mv "$HIVE_DATA_DIR/$HIVE_AGENT_ID.env.tmp" "$HIVE_DATA_DIR/$HIVE_AGENT_ID.env"\nprintf "%s\\n" "$@" > "$HIVE_DATA_DIR/$HIVE_AGENT_ID.args"\nexec sleep 600\n', { mode: 0o755 });
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
function config(value) {
  writeFileSync(join(dirs.projectDir, "hive.yml"), `agents: [claude, codex]\n${value == null ? "" : `context_checkpoint_percent: ${value}\n`}`);
}
async function capture(actor) {
  const path = join(dirs.dataDir, `${actor}.env`);
  assert.ok(await until(() => existsSync(path), 5000));
  return readFileSync(path, "utf8");
}
function hooks(row, kind) {
  const path = kind === "claude" ? join(dirs.dataDir, `worker-${row.id}-hooks.json`) : join(dirs.dataDir, "codex-homes", row.codex_home, "hooks.json");
  return JSON.parse(readFileSync(path, "utf8"));
}

describe("worker-only context checkpoint launch settings", () => {
  for (const kind of ["claude", "codex"]) {
    it(`${kind} captures configuration at spawn and refreshes it on resume, including disabling`, { skip: !hasTmux }, async () => {
      const { db } = await import("../dist/db.js");
      config(null);
      await mcp.call("agent_spawn", { name: `${kind}-off`, command: join(binaries, kind) });
      const offSummary = await liveAgentRow(mcp, `${kind}-off`);
      const off = db.prepare("SELECT * FROM agents WHERE id = ?").get(offSummary.agent_id);
      assert.doesNotMatch(await capture(off.actor_id), /^HIVE_CONTEXT_CHECKPOINT_PERCENT=/m);
      assert.equal(hooks(off, kind).hooks.PostToolUse, undefined);
      await mcp.call("agent_close", { name: `${kind}-off` });
      config(37);
      await mcp.call("agent_spawn", { name: `${kind}-on`, command: join(binaries, kind) });
      const onSummary = await liveAgentRow(mcp, `${kind}-on`);
      const on = db.prepare("SELECT * FROM agents WHERE id = ?").get(onSummary.agent_id);
      assert.match(await capture(on.actor_id), /^HIVE_CONTEXT_CHECKPOINT_PERCENT=37$/m);
      assert.match(hooks(on, kind).hooks.PostToolUse[0].hooks[0].command, new RegExp(`post_tool_use ${kind}$`));
      if (kind === "claude") assert.ok(hooks(on, kind).statusLine);
      db.prepare("UPDATE agents SET session_id = 'resume-context' WHERE id = ?").run(on.id);
      await mcp.call("agent_park", { name: `${kind}-on` });
      config(49);
      await mcp.call("agent_resume", { agent_id: on.id });
      assert.ok(await until(() => readFileSync(join(dirs.dataDir, `${on.actor_id}.env`), "utf8").includes("HIVE_CONTEXT_CHECKPOINT_PERCENT=49"), 5000));
      assert.ok(hooks(on, kind).hooks.PostToolUse);
      await mcp.call("agent_park", { name: `${kind}-on` });
      config(null);
      await mcp.call("agent_resume", { agent_id: on.id });
      assert.ok(await until(() => !readFileSync(join(dirs.dataDir, `${on.actor_id}.env`), "utf8").includes("HIVE_CONTEXT_CHECKPOINT_PERCENT="), 5000));
      assert.equal(hooks(on, kind).hooks.PostToolUse, undefined);
      await mcp.call("agent_close", { name: `${kind}-on` });
    });
  }
});
