import assert from "node:assert/strict";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { isolateTmux, McpClient, scratchDirs, scratchGit } from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("the created-pane pid tests");

const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { sessionName } = await import("../dist/tmux.js");

scratchGit(dirs.projectDir, "init", "-q");
scratchGit(dirs.projectDir, "commit", "-q", "--allow-empty", "-m", "root");
writeFileSync(join(dirs.projectDir, "hive.yml"), "agents: [claude, codex]\n");

const fakeHome = join(dirs.tmp, "fake-home");
mkdirSync(join(fakeHome, ".codex"), { recursive: true });
writeFileSync(join(fakeHome, ".codex", "auth.json"), JSON.stringify({ tokens: "not real" }));

const MARKER = "instant-exit-marker";
const binDir = join(dirs.tmp, "harness-bin");
mkdirSync(binDir, { recursive: true });
writeFileSync(join(binDir, "codex"), `#!/bin/sh\necho ${MARKER}\nexit 1\n`);
chmodSync(join(binDir, "codex"), 0o755);

const ATTEMPTS = 12;
let mcp;

before(async () => {
  mcp = new McpClient({
    cwd: dirs.projectDir,
    dataDir: dirs.dataDir,
    env: { HIVE_SPAWN_READY_MS: "10000", HOME: fakeHome, PATH: `${binDir}:${process.env.PATH}` },
  });
  await mcp.start();
  if (hasTmux) await mcp.call("agent_spawn", { name: "anchor", command: "sleep", extra_args: ["600"] });
});

after(async () => {
  await mcp.close();
  cleanup(sessionName());
});

describe("a worker whose command exits immediately", () => {
  it(
    `is reported exited with its tail on every one of ${ATTEMPTS} attempts, never refused for a missing pid`,
    { skip: hasTmux ? false : "tmux is not installed" },
    async () => {
      const failures = [];
      for (let i = 0; i < ATTEMPTS; i++) {
        try {
          const receipt = await mcp.call("agent_spawn", { name: `instant-${i}`, harness: "codex" });
          if (receipt.exited !== true || !String(receipt.tail ?? "").includes(MARKER)) {
            failures.push(`attempt ${i}: ${JSON.stringify(receipt)}`);
          }
        } catch (e) {
          failures.push(`attempt ${i}: ${e.message}`);
        }
      }
      assert.deepEqual(failures, []);
    },
  );
});

describe("a non-classifying spawn whose command exits at once", () => {
  for (const placement of ["split", "window"]) {
    it(
      `is refused, not recorded (${placement} placement)`,
      { skip: hasTmux ? false : "tmux is not installed" },
      async () => {
        const name = `instant-false-${placement}`;
        await assert.rejects(
          mcp.call("agent_spawn", { name, command: "false", placement }),
          /exited immediately/,
        );
        const { agents } = await mcp.call("agent_list", { include_closed: true });
        assert.deepEqual(agents.filter((a) => a.name === name), []);
      },
    );
  }
});
