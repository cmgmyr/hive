import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { isolateTmux, McpClient, scratchDirs, scratchGit, until } from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("the agent_spawn harness tests");

const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { sessionName } = await import("../dist/tmux.js");

scratchGit(dirs.projectDir, "init", "-q");
scratchGit(dirs.projectDir, "commit", "-q", "--allow-empty", "-m", "root");

// The gate tests below overwrite this per test; this is just the default state for the tests
// that don't care about it, so codex isn't refused before the gate itself is under test.
writeFileSync(join(dirs.projectDir, "hive.yml"), "agents: [claude, codex]\n");

// A fake HOME so ensureCodexHome's auth.json lookup resolves to a fake credential rather than the
// real ~/.codex, the same reason codex-spawn.test.mjs needs one.
const fakeHome = join(dirs.tmp, "fake-home");
mkdirSync(join(fakeHome, ".codex"), { recursive: true });
writeFileSync(join(fakeHome, ".codex", "auth.json"), JSON.stringify({ tokens: "not real" }));

// Named exactly "codex" so a bare `harness: "codex"` (no path) resolves through PATH the way a
// real spawn would, proving the name -> command resolution and not just a literal path passthrough.
const binDir = join(dirs.tmp, "harness-bin");
mkdirSync(binDir, { recursive: true });
const argvFile = join(dirs.tmp, "harness-argv.txt");
writeFileSync(join(binDir, "codex"), `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(argvFile)}\nsleep 30\n`);
chmodSync(join(binDir, "codex"), 0o755);

let mcp;

before(async () => {
  mcp = new McpClient({
    cwd: dirs.projectDir,
    dataDir: dirs.dataDir,
    env: { HIVE_SPAWN_READY_MS: "1", HOME: fakeHome, PATH: `${binDir}:${process.env.PATH}` },
  });
  await mcp.start();
});

after(async () => {
  await mcp.close();
  cleanup(sessionName());
});

describe("agent_spawn: harness parameter", () => {
  it("rejects an unrecognized harness name, naming the known set", async () => {
    await assert.rejects(
      mcp.call("agent_spawn", { name: "bad-harness", harness: "aider" }),
      /Unknown harness "aider"\. Known harnesses: claude, codex\./,
    );
  });

  it(
    "spawns by harness name instead of a raw command",
    { skip: hasTmux ? false : "tmux is not installed" },
    async () => {
      const receipt = await mcp.call("agent_spawn", { name: "by-harness", harness: "codex" });
      assert.ok(
        receipt.codex_home,
        "harness: codex must run the codex spawn path (CODEX_HOME et al), not an unknown-harness fallback",
      );
      await until(() => existsSync(argvFile), 5000);
      const argv = readFileSync(argvFile, "utf8").split("\n");
      assert.ok(
        argv.includes("--dangerously-bypass-hook-trust"),
        "the process harness: codex resolved to must be the codex harness's own argv shape",
      );
    },
  );
});

describe("agent_spawn: hive.yml agents: gate", () => {
  it(
    "refuses a harness not in this project's agents: list",
    { skip: hasTmux ? false : "tmux is not installed" },
    async () => {
      writeFileSync(join(dirs.projectDir, "hive.yml"), "agents: [claude]\n");
      await assert.rejects(
        mcp.call("agent_spawn", { name: "gated-by-harness", harness: "codex" }),
        /\[agent_spawn:harness-not-allowed\] "codex" is not in this project's hive\.yml agents: list \(claude\)/,
      );
    },
  );

  it(
    "refuses a raw command resolving to the same disallowed harness - the bypass command left open",
    { skip: hasTmux ? false : "tmux is not installed" },
    async () => {
      writeFileSync(join(dirs.projectDir, "hive.yml"), "agents: [claude]\n");
      await assert.rejects(
        mcp.call("agent_spawn", { name: "gated-by-command", command: "codex" }),
        /\[agent_spawn:harness-not-allowed\] "codex" is not in this project's hive\.yml agents: list \(claude\)/,
      );
    },
  );

  it(
    "does not gate a command hive cannot classify as any known harness",
    { skip: hasTmux ? false : "tmux is not installed" },
    async () => {
      writeFileSync(join(dirs.projectDir, "hive.yml"), "agents: [claude]\n");
      const receipt = await mcp.call("agent_spawn", { name: "ungated-unknown", command: "sleep", extra_args: ["600"] });
      assert.ok(receipt.agent_id > 0, "a command hive can't classify as claude or codex was never part of the agents: pool");
      await mcp.call("agent_close", { agent_id: receipt.agent_id });
    },
  );
});

describe("agent_spawn: hive.yml agents: default", () => {
  it(
    "uses the configured list's first entry when neither command nor harness is given",
    { skip: hasTmux ? false : "tmux is not installed" },
    async () => {
      writeFileSync(join(dirs.projectDir, "hive.yml"), "agents:\n  - codex\n  - claude\n");
      const receipt = await mcp.call("agent_spawn", { name: "config-default" });
      assert.ok(receipt.codex_home, "with agents: [codex, claude] and no command/harness, the default must be codex");
    },
  );
});
