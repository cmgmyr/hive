import assert from "node:assert/strict";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { clearHiveEnv, isolateTmux, McpClient, scratchDirs } from "./helpers.mjs";

const { cleanup } = isolateTmux("usage limit spawn admission from synthetic findings-limit-fork-spike records");
const dirs = scratchDirs();
clearHiveEnv();
process.env.HIVE_DATA_DIR = dirs.dataDir;
process.env.HIVE_SPAWN_READY_MS = "1000";
const fakeHome = join(dirs.tmp, "codex-home");
const fakeBin = join(dirs.tmp, "bin");
mkdirSync(join(fakeHome, ".codex"), { recursive: true });
mkdirSync(fakeBin, { recursive: true });
writeFileSync(join(fakeHome, ".codex", "auth.json"), "{}\n");
const codexBin = join(fakeBin, "codex");
writeFileSync(codexBin, `#!/bin/sh\ncat '${join(new URL("./fixtures/panes/codex-idle-empty-e.txt", import.meta.url).pathname)}'; exec sleep 60\n`);
chmodSync(codexBin, 0o755);
process.env.HOME = fakeHome;
process.env.PATH = `${fakeBin}:${process.env.PATH}`;
const projectDir = join(dirs.projectDir, "usage-limit-spawn");
mkdirSync(projectDir, { recursive: true });
writeFileSync(join(projectDir, "hive.yml"), "agents:\n  - claude\n  - codex\n");

const { db, migrate } = await import("../dist/db.js");
migrate();
const mcp = new McpClient({ cwd: projectDir, dataDir: dirs.dataDir, env: { HIVE_AGENT_ID: "lead:usage-limit-test" } });
after(async () => {
  await mcp.close();
  cleanup();
});

describe("spawn admission during a synthetic findings-limit-fork-spike A1-A2 episode", () => {
  it("refuses same-harness spawn and resume before row or pane creation, while another harness stays available", async () => {
    await mcp.start();
    const project = await mcp.call("whoami");
    const active = db.prepare(`INSERT INTO agents
      (project_id, actor_id, name, tmux_target, command, cwd, status, kind, session_id)
      VALUES (?, 'agent:limit-active', 'limit-active', '', 'claude', ?, 'running', 'agent', 'synthetic-claude') RETURNING id`)
      .get(project.project.id, projectDir).id;
    const sourceTranscript = join(dirs.tmp, "fork-source.jsonl");
    writeFileSync(sourceTranscript, "{}\n");
    const parked = db.prepare(`INSERT INTO agents
      (project_id, actor_id, name, tmux_target, command, cwd, status, kind, session_id, transcript_path, closed_at)
      VALUES (?, 'agent:limit-parked', 'limit-parked', '', 'claude', ?, 'closed', 'agent', 'synthetic-claude-parked', ?, datetime('now')) RETURNING id`)
      .get(project.project.id, projectDir, sourceTranscript).id;
    db.prepare(`INSERT INTO agent_usage_limits
      (agent_id, project_id, harness, pane_pid, session_id, signal_key, observed_at, reset_at, expires_at)
      VALUES (?, ?, 'claude', '', 'synthetic-claude', 'spike-A1-A2-synthetic', datetime('now'), NULL, datetime('now', '+5 hours'))`)
      .run(active, project.project.id);

    const rowsBefore = db.prepare("SELECT COUNT(*) AS n FROM agents WHERE project_id = ?").get(project.project.id).n;
    const spawnRefusal = await mcp.call("agent_spawn", { name: "must-not-exist", command: "claude" }).then(() => null, (error) => error);
    assert.match(spawnRefusal.message, /agent_spawn:usage-limit.*until/);
    const resumeRefusal = await mcp.call("agent_resume", { agent_id: parked }).then(() => null, (error) => error);
    assert.match(resumeRefusal.message, /agent_resume:usage-limit.*until/);
    const forkRefusal = await mcp.call("agent_fork", { agent_id: parked, name: "must-not-fork" }).then(() => null, (error) => error);
    assert.match(forkRefusal.message, /agent_fork:usage-limit.*until/);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM agents WHERE project_id = ?").get(project.project.id).n, rowsBefore);
    assert.equal(db.prepare("SELECT status FROM agents WHERE id = ?").get(parked).status, "closed");
    assert.equal(db.prepare("SELECT 1 FROM agent_usage_limits WHERE project_id = ? AND harness = 'codex' AND released_at IS NULL").get(project.project.id), undefined);

    const codex = await mcp.call("agent_spawn", { name: "other-harness", harness: "codex" });
    assert.ok(codex.agent_id, "a different harness remains available in the same project");
    await mcp.call("agent_close", { agent_id: codex.agent_id });
  });
});
