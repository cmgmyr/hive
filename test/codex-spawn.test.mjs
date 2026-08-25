import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { parse as parseToml } from "smol-toml";
import { fakeFailingTmux, isolateTmux, liveAgentRow, McpClient, scratchDirs, scratchGit, until } from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("the codex spawn integration tests");

const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { db } = await import("../dist/db.js");
const { sessionName } = await import("../dist/tmux.js");

scratchGit(dirs.projectDir, "init", "-q");
scratchGit(dirs.projectDir, "commit", "-q", "--allow-empty", "-m", "root");

// Absent means claude only (todo 526's gate), and this file's whole point is spawning codex.
writeFileSync(join(dirs.projectDir, "hive.yml"), "agents: [claude, codex]\n");

// A fake HOME so the spawned hive process's own homedir()-based auth.json lookup resolves to a
// fake credential rather than the real ~/.codex - the same reason ensureCodexHome takes an
// authSource override for its own unit tests, applied here at the process boundary instead, since
// the real agent_spawn call site never threads that override through.
const fakeHome = join(dirs.tmp, "fake-home");
mkdirSync(join(fakeHome, ".codex"), { recursive: true });
writeFileSync(join(fakeHome, ".codex", "auth.json"), JSON.stringify({ tokens: "not real" }));

const codexBinDir = join(dirs.tmp, "codex-bin");
mkdirSync(codexBinDir, { recursive: true });
const fakeCodexBin = join(codexBinDir, "codex");
const argvFile = join(dirs.tmp, "codex-argv.txt");
const envFile = join(dirs.tmp, "codex-env.txt");
writeFileSync(
  fakeCodexBin,
  `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(argvFile)}\nenv > ${JSON.stringify(envFile)}\nsleep 30\n`,
);
chmodSync(fakeCodexBin, 0o755);

let mcp;

before(async () => {
  mcp = new McpClient({
    cwd: dirs.projectDir,
    dataDir: dirs.dataDir,
    env: { HIVE_SPAWN_READY_MS: "1", HOME: fakeHome },
  });
  await mcp.start();
});

after(async () => {
  await mcp.close();
  cleanup(sessionName());
});

describe("agent_spawn: codex worker gets a real per-worker CODEX_HOME", () => {
  let agentId;
  let target;

  before(async () => {
    if (!hasTmux) return;
    const receipt = await mcp.call("agent_spawn", { name: "codex-worker-1", command: fakeCodexBin });
    agentId = receipt.agent_id;
    target = receipt.tmux_target;
    assert.ok(receipt.codex_home, "the receipt must name where the brief and MCP config landed");
    await until(() => existsSync(argvFile) && existsSync(envFile), 5000);
  });

  it("sets CODEX_HOME in the pane's real environment, pointing at the generated files", { skip: hasTmux ? false : "tmux is not installed" }, () => {
    const env = readFileSync(envFile, "utf8");
    const match = env.match(/^CODEX_HOME=(.*)$/m);
    assert.ok(match, "CODEX_HOME must be set in the spawned process's environment");
    assert.ok(existsSync(join(match[1], "config.toml")), "the env's CODEX_HOME must be the real generated home");
    assert.ok(existsSync(join(match[1], "hooks.json")));
    assert.ok(existsSync(join(match[1], "auth.json")));
  });

  it("passes both bypass flags on the actual command line, not just in the generator's own return value", { skip: hasTmux ? false : "tmux is not installed" }, () => {
    const argv = readFileSync(argvFile, "utf8").split("\n");
    assert.ok(argv.includes("--dangerously-bypass-hook-trust"));
    assert.ok(argv.includes("--dangerously-bypass-approvals-and-sandbox"));
  });

  it("passes --add-dir pointing at this repo's real .git", { skip: hasTmux ? false : "tmux is not installed" }, () => {
    const argv = readFileSync(argvFile, "utf8").split("\n");
    const i = argv.indexOf("--add-dir");
    assert.notEqual(i, -1);
    assert.equal(argv[i + 1], join(dirs.projectDir, ".git"));
  });

  it("bakes this exact worker's own actor_id into config.toml's HIVE_AGENT_ID, not a placeholder", { skip: hasTmux ? false : "tmux is not installed" }, () => {
    const env = readFileSync(envFile, "utf8");
    const home = env.match(/^CODEX_HOME=(.*)$/m)[1];
    const config = parseToml(readFileSync(join(home, "config.toml"), "utf8"));
    const row = db.prepare("SELECT actor_id FROM agents WHERE id = ?").get(agentId);
    assert.equal(config.mcp_servers.hive.env.HIVE_AGENT_ID, row.actor_id);
  });

  it("reads back as attributed to this worker, matching liveAgentRow's alive check", { skip: hasTmux ? false : "tmux is not installed" }, async () => {
    const row = await liveAgentRow(mcp, "codex-worker-1");
    assert.equal(row.agent_id, agentId);
    assert.equal(row.tmux_target, target);
  });
});

describe("agent_spawn: a failed codex launch does not orphan its CODEX_HOME", () => {
  it("removes the per-worker home when pane creation fails, not just the agents row", { skip: hasTmux ? false : "tmux is not installed" }, async () => {
    // buildCommand (and the ensureCodexHome call inside it) runs before launchAgent's own
    // pane-creation step, so failing deterministically at that step - a fake tmux that fails
    // `new-session` specifically, not a timing race against a real one - reproduces the exact
    // ordering the orphan bug needs: CODEX_HOME already written to disk, then the launch fails.
    const failDirs = scratchDirs();
    scratchGit(failDirs.projectDir, "init", "-q");
    scratchGit(failDirs.projectDir, "commit", "-q", "--allow-empty", "-m", "root");
    // Otherwise the gate refuses this before CODEX_HOME is ever written, and the "no orphan"
    // assertion below would pass for the wrong reason - it needs the real tmux failure to fire.
    writeFileSync(join(failDirs.projectDir, "hive.yml"), "agents: [claude, codex]\n");
    const fakeTmuxDir = fakeFailingTmux({ failOn: "new-session" });

    const failMcp = new McpClient({
      cwd: failDirs.projectDir,
      dataDir: failDirs.dataDir,
      env: { HIVE_SPAWN_READY_MS: "1", HOME: fakeHome, PATH: `${fakeTmuxDir}:${process.env.PATH}` },
    });
    await failMcp.start();
    try {
      await assert.rejects(failMcp.call("agent_spawn", { name: "codex-doomed", command: "codex" }));

      const codexHomes = join(failDirs.dataDir, "codex-homes");
      const leftover = existsSync(codexHomes) ? readdirSync(codexHomes) : [];
      assert.deepEqual(leftover, [], `expected no orphaned CODEX_HOME, found: ${leftover.join(", ")}`);
    } finally {
      await failMcp.close();
      rmSync(fakeTmuxDir, { recursive: true, force: true });
    }
  });
});

describe("launchAgent: the agents row is queryable before a function commandString ever runs", () => {
  // codexHome reaping (agent_close, the janitor backstop) trusts that a codex-homes/<key>
  // directory never exists without an agents row naming it first, because that ordering is what
  // rules out a sweep racing a spawn that made the directory but has not yet written its row
  // (todo 532's design checkpoint). ensureCodexHome's mkdirSync runs inside buildCommand, which is
  // exactly launchAgent's `commandString` callback - so this pins the general invariant that
  // callback depends on, not codex specifically. If a future edit ever moves the INSERT below the
  // commandString call, this goes red.
  it(
    "a raw SELECT for the row succeeds from inside the commandString callback itself",
    { skip: hasTmux ? false : "tmux is not installed" },
    async () => {
      const { launchAgent, closeAgentRow } = await import("../dist/spawn.js");
      const { addProject } = await import("../dist/context.js");
      const projectDir = join(dirs.tmp, "row-before-home-proj");
      mkdirSync(projectDir, { recursive: true });
      const project = addProject(projectDir, "row-before-home-proj");

      let rowExistedWhenCallbackRan;
      let agentId;
      try {
        ({ agentId } = launchAgent({
          projectId: project.id,
          projectName: project.name,
          projectPath: project.path,
          name: "row-before-home-check",
          kind: "agent",
          commandString: ({ agentId: id }) => {
            rowExistedWhenCallbackRan = db.prepare("SELECT 1 FROM agents WHERE id = ?").get(id) !== undefined;
            return "sleep 30";
          },
          cwd: project.path,
          env: {},
          placement: "window",
          parentActor: "test:row-before-home",
        }));
        assert.equal(
          rowExistedWhenCallbackRan,
          true,
          "the agents row must exist before commandString's callback runs, or a codex-home directory " +
            "that callback creates could exist with no row yet naming it - exactly the race the janitor's " +
            "reap sweep depends on not being possible",
        );
      } finally {
        if (agentId != null) closeAgentRow(agentId);
        cleanup(sessionName());
      }
    },
  );
});
