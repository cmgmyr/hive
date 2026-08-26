import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { isolateTmux, liveAgentRow, McpClient, scratchDirs, scratchGit, until } from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("the codex park/resume tests");

const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { db } = await import("../dist/db.js");
const { sessionName } = await import("../dist/tmux.js");

scratchGit(dirs.projectDir, "init", "-q");
scratchGit(dirs.projectDir, "commit", "-q", "--allow-empty", "-m", "root");

writeFileSync(join(dirs.projectDir, "hive.yml"), "agents: [claude, codex]\n");

// Same fake-HOME trick as test/codex-spawn.test.mjs: ensureCodexHome's auth.json lookup goes
// through homedir(), so this is the only way to feed it a fake credential at the process boundary.
const fakeHome = join(dirs.tmp, "fake-home");
mkdirSync(join(fakeHome, ".codex"), { recursive: true });
writeFileSync(join(fakeHome, ".codex", "auth.json"), JSON.stringify({ tokens: "not real" }));

const codexBinDir = join(dirs.tmp, "codex-bin");
mkdirSync(codexBinDir, { recursive: true });
const fakeCodexBin = join(codexBinDir, "codex");
const argvFile = join(dirs.tmp, "codex-argv.txt");
const envFile = join(dirs.tmp, "codex-env.txt");
// Same binary serves both the initial spawn and every resume - only the argv differs - so each
// call site below clears these two files first and waits for them to reappear.
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

const clearArgvEnv = () => {
  rmSync(argvFile, { force: true });
  rmSync(envFile, { force: true });
};

// The fake binary never calls hive's own hooks, so it never reports a session_id the way a real
// codex worker would (src/hook.ts:122-125). Writing one directly onto the row simulates that hook
// having already fired, which is all agent_park/agent_resume actually read.
const spawnCodex = async (name) => {
  clearArgvEnv();
  const receipt = await mcp.call("agent_spawn", { name, command: fakeCodexBin });
  await until(() => existsSync(argvFile) && existsSync(envFile), 5000);
  db.prepare("UPDATE agents SET session_id = ? WHERE id = ?").run(`fake-${name}-session`, receipt.agent_id);
  await liveAgentRow(mcp, name);
  return receipt;
};

describe(
  "agent_park / agent_resume for a codex worker (todo 563)",
  { skip: hasTmux ? false : "tmux is not installed" },
  () => {
    it("parks a codex worker and its CODEX_HOME survives, unlike an ordinary agent_close", async () => {
      const receipt = await spawnCodex("codex-park-keep");
      assert.ok(receipt.codex_home, "setup bug: a codex worker must get a real per-worker home");
      assert.ok(existsSync(receipt.codex_home));

      const parkReceipt = await mcp.call("agent_park", { agent_id: receipt.agent_id });
      assert.equal(parkReceipt.parked, true);

      assert.ok(
        existsSync(receipt.codex_home),
        "a parked codex worker's home must survive - only agent_close reaps it (src/scheduler.ts's parked_at = '' exclusion)",
      );
      const row = db.prepare("SELECT codex_home FROM agents WHERE id = ?").get(receipt.agent_id);
      assert.notEqual(row.codex_home, "", "the column must still name the surviving home");
    });

    it("resumes a parked codex worker with `codex resume <id>`, against its ORIGINAL CODEX_HOME, not a fresh one", async () => {
      const receipt = await spawnCodex("codex-resume-shape");
      await mcp.call("agent_park", { agent_id: receipt.agent_id });

      clearArgvEnv();
      const resumeReceipt = await mcp.call("agent_resume", { agent_id: receipt.agent_id });
      assert.equal(resumeReceipt.resumed_session_id, "fake-codex-resume-shape-session");
      await until(() => existsSync(argvFile) && existsSync(envFile), 5000);

      const argv = readFileSync(argvFile, "utf8").split("\n").filter(Boolean);
      assert.ok(argv.includes("resume"), `must use the subcommand form, not a flag: ${argv.join(" ")}`);
      assert.ok(
        argv.includes("fake-codex-resume-shape-session"),
        `must resume the recorded session id: ${argv.join(" ")}`,
      );
      assert.equal(argv.includes("--session-id"), false, "codex takes no --session-id flag (verified live, v0.149.0)");
      assert.equal(argv.includes("--settings"), false, "codex must not get claude's --settings hooks flag");
      assert.ok(argv.includes("--dangerously-bypass-hook-trust"), "must carry the same launch flags as spawn");

      const env = readFileSync(envFile, "utf8");
      const match = env.match(/^CODEX_HOME=(.*)$/m);
      assert.ok(match, "CODEX_HOME must be set on resume too");
      assert.equal(match[1], receipt.codex_home, "resume must reuse the ORIGINAL home, not mint a new one");

      await mcp.call("agent_close", { agent_id: receipt.agent_id });
    });

    it("carries the worker's pinned --model into the resume command, at the root position before `resume`", async () => {
      clearArgvEnv();
      const receipt = await mcp.call("agent_spawn", {
        name: "codex-resume-model",
        command: fakeCodexBin,
        model: "gpt-5-codex",
      });
      await until(() => existsSync(argvFile) && existsSync(envFile), 5000);
      db.prepare("UPDATE agents SET session_id = ? WHERE id = ?").run("fake-codex-resume-model-session", receipt.agent_id);
      await liveAgentRow(mcp, "codex-resume-model");
      await mcp.call("agent_park", { agent_id: receipt.agent_id });

      clearArgvEnv();
      await mcp.call("agent_resume", { agent_id: receipt.agent_id });
      await until(() => existsSync(argvFile) && existsSync(envFile), 5000);

      const argv = readFileSync(argvFile, "utf8").split("\n").filter(Boolean);
      const modelIndex = argv.indexOf("--model");
      const resumeIndex = argv.indexOf("resume");
      assert.notEqual(modelIndex, -1, `dropped the worker's pinned model on resume: ${argv.join(" ")}`);
      assert.equal(argv[modelIndex + 1], "gpt-5-codex");
      assert.ok(
        modelIndex < resumeIndex,
        `--model must sit at the root, before the resume subcommand: ${argv.join(" ")}`,
      );
    });

    it("refuses to resume a codex worker whose CODEX_HOME was already reaped by agent_close", async () => {
      const receipt = await spawnCodex("codex-resume-reaped");
      await mcp.call("agent_close", { agent_id: receipt.agent_id });
      assert.ok(!existsSync(receipt.codex_home), "setup bug: agent_close must reap the home");

      await assert.rejects(mcp.call("agent_resume", { agent_id: receipt.agent_id }), /no recorded CODEX_HOME/);
    });

    it("refuses to park a codex worker with no recorded session id, same guard claude already gets", async () => {
      const projectId = (await mcp.call("whoami")).project.id;
      const id = db
        .prepare(
          `INSERT INTO agents (project_id, actor_id, name, tmux_target, command, cwd, status, kind, session_id, codex_home)
           VALUES (?, 'agent:codex-park-legacy', 'codex-park-legacy', '', 'codex', ?, 'running', 'agent', '', '')
           RETURNING id`,
        )
        .get(projectId, dirs.projectDir).id;

      await assert.rejects(mcp.call("agent_park", { agent_id: id }), /no recorded session id/);

      db.prepare("DELETE FROM agents WHERE id = ?").run(id);
    });
  },
);
