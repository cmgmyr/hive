import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { isolateTmux, McpClient, scratchDirs, scratchGit } from "./helpers.mjs";

// This is the real-spawn protection the manual "watch it together" command (todo 524 comment 1741)
// was standing in for. A manual command is not a test and does not run on its own; this does, and it
// is the only thing in the suite that ever renders codex's real chrome - codex-spawn.test.mjs's fake
// binary proves env and launch flags reach the pane and proves nothing chrome-shaped (see the
// predecessor's handoff, todo 524 comment 1749). Skipped by default: it spends real codex usage and
// needs real network and real ~/.codex credentials, none of which CI has or should be given.
const REAL_CODEX_ENV = "HIVE_TEST_REAL_CODEX";

const { hasTmux, cleanup } = isolateTmux("the real codex live-spawn test");

let hasCodex = true;
try {
  execFileSync("codex", ["--version"], { stdio: "ignore" });
} catch {
  hasCodex = false;
}

const skip = !hasTmux
  ? "tmux is not installed"
  : process.env[REAL_CODEX_ENV] !== "1"
    ? `set ${REAL_CODEX_ENV}=1 to run this - it spends real codex usage against your real ~/.codex credentials`
    : !hasCodex
      ? "codex is not installed on PATH"
      : false;

describe(`agent_spawn against a real codex binary (env-gated: ${REAL_CODEX_ENV})`, () => {
  it("reaches a real ready prompt, not codex-spawn.test.mjs's fake chrome", { skip }, async () => {
    const dirs = scratchDirs();
    process.env.HIVE_DATA_DIR = dirs.dataDir;
    scratchGit(dirs.projectDir, "init", "-q");
    scratchGit(dirs.projectDir, "commit", "-q", "--allow-empty", "-m", "root");
    // Absent means claude only (todo 526's gate), and this file's whole point is spawning codex.
    writeFileSync(join(dirs.projectDir, "hive.yml"), "agents: [claude, codex]\n");

    const { migrate } = await import("../dist/db.js");
    migrate();
    const { sessionName } = await import("../dist/tmux.js");

    // No HOME override: this deliberately resolves ensureCodexHome's authSource to the real
    // ~/.codex/auth.json, the only way to reach codex's real ready prompt rather than its
    // "Sign in with ChatGPT" screen. A generous timeout - real captures this session took ~4s.
    const mcp = new McpClient({
      cwd: dirs.projectDir,
      dataDir: dirs.dataDir,
      env: { HIVE_SPAWN_READY_MS: "20000" },
    });
    await mcp.start();

    try {
      const receipt = await mcp.call("agent_spawn", { name: "codex-live-spawn-test", command: "codex" });
      assert.equal(
        receipt.ready,
        true,
        `codex never reached a readable input box - see receipt.tail for what the pane actually showed:\n${JSON.stringify(receipt, null, 2)}`,
      );

      await mcp.call("agent_close", { name: "codex-live-spawn-test" });
    } finally {
      await mcp.close();
      cleanup(sessionName());
      rmSync(dirname(dirs.tmp), { recursive: true, force: true });
    }
  });
});
