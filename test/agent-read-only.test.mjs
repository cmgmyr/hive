import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, it } from "node:test";
import { parse as parseToml } from "smol-toml";
import { isolateTmux, liveAgentRow, McpClient, scratchDirs, scratchGit, until } from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("read-only worker launch tests");
const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { db } = await import("../dist/db.js");
const { sessionName } = await import("../dist/tmux.js");
const { codexLaunchArgs } = await import("../dist/codexHome.js");
scratchGit(dirs.projectDir, "init", "-q");
scratchGit(dirs.projectDir, "commit", "-q", "--allow-empty", "-m", "root");
writeFileSync(join(dirs.projectDir, "hive.yml"), "agents: [claude, codex]\n");
const fakeHome = join(dirs.tmp, "home");
mkdirSync(join(fakeHome, ".codex"), { recursive: true });
writeFileSync(join(fakeHome, ".codex/auth.json"), "{}");
const bin = join(dirs.tmp, "bin");
mkdirSync(bin);
const argvFile = join(dirs.tmp, "argv");
for (const harness of ["claude", "codex"]) {
  const path = join(bin, harness);
  writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' "$@" > '${argvFile}'\nsleep 60\n`);
  chmodSync(path, 0o755);
}
let mcp;
before(async () => {
  mcp = new McpClient({ cwd: dirs.projectDir, dataDir: dirs.dataDir, env: { HOME: fakeHome, HIVE_SPAWN_READY_MS: "1" } });
  await mcp.start();
});
after(async () => {
  await mcp.close();
  cleanup(sessionName());
});
const gate = { skip: hasTmux ? false : "tmux is not installed" };
const argv = async () => {
  await until(() => existsSync(argvFile), 5000);
  return readFileSync(argvFile, "utf8").trim().split("\n");
};

for (const harness of ["claude", "codex"]) {
  it(`${harness} read-only restrictions survive park/resume and status reports the stored mode`, gate, async () => {
    rmSync(argvFile, { force: true });
    const receipt = await mcp.call("agent_spawn", { name: `sealed-${harness}`, command: join(bin, harness), read_only: true });
    assert.equal(receipt.read_only, true);
    let args = await argv();
    await liveAgentRow(mcp, `sealed-${harness}`);
    assert.equal((await mcp.call("agent_status", { agent_id: receipt.agent_id })).read_only, true);
    const check = () => {
      if (harness === "codex") {
        assert.equal(args[args.indexOf("--sandbox") + 1], "read-only");
        assert.equal(args.includes("--dangerously-bypass-approvals-and-sandbox"), false);
        assert.equal(args[args.indexOf("-c") + 1], 'approval_policy="never"');
        assert.equal(parseToml(readFileSync(join(receipt.codex_home, "config.toml"), "utf8")).mcp_servers.hive.default_tools_approval_mode, "approve");
      } else {
        const settings = JSON.parse(readFileSync(args[args.indexOf("--settings") + 1], "utf8"));
        assert.deepEqual(settings.permissions.deny, ["SendMessage", "ListAgents", "Edit", "Write", "NotebookEdit"]);
        assert.deepEqual(settings.sandbox, { enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false, filesystem: { denyWrite: ["//"] } });
      }
    };
    check();
    if (harness === "codex") db.prepare("UPDATE agents SET session_id = ? WHERE id = ?").run("sealed-session", receipt.agent_id);
    await mcp.call("agent_park", { agent_id: receipt.agent_id });
    rmSync(argvFile, { force: true });
    await mcp.call("agent_resume", { agent_id: receipt.agent_id });
    args = await argv();
    check();
    assert.equal((await mcp.call("agent_status", { agent_id: receipt.agent_id })).read_only, true);
    await mcp.call("agent_close", { agent_id: receipt.agent_id });
  });

  it(`${harness} read-only planning seat accepts effort arguments and preserves them on resume`, gate, async () => {
    rmSync(argvFile, { force: true });
    const effortArgs = harness === "codex" ? ["-c", "model_reasoning_effort=medium"] : ["--effort", "medium"];
    const receipt = await mcp.call("agent_spawn", { name: `planner-${harness}`, command: join(bin, harness), model: harness === "codex" ? "gpt-6-sol" : "sonnet", read_only: true, extra_args: effortArgs });
    let args = await argv();
    const check = () => {
      const valueIndex = args.indexOf(effortArgs[1]);
      assert.ok(valueIndex > 0);
      assert.equal(args[valueIndex - 1], effortArgs[0]);
      if (harness === "codex") {
        assert.equal(args[args.indexOf("--sandbox") + 1], "read-only");
        assert.ok(args.includes('approval_policy="never"'));
        assert.equal(args.includes("--dangerously-bypass-approvals-and-sandbox"), false);
      } else {
        const settings = JSON.parse(readFileSync(args[args.indexOf("--settings") + 1], "utf8"));
        assert.deepEqual(settings.sandbox.filesystem.denyWrite, ["//"]);
        assert.equal(settings.sandbox.allowUnsandboxedCommands, false);
      }
    };
    check();
    await liveAgentRow(mcp, `planner-${harness}`);
    if (harness === "codex") db.prepare("UPDATE agents SET session_id = ? WHERE id = ?").run("planner-session", receipt.agent_id);
    await mcp.call("agent_park", { agent_id: receipt.agent_id });
    rmSync(argvFile, { force: true });
    await mcp.call("agent_resume", { agent_id: receipt.agent_id });
    args = await argv();
    check();
    assert.equal((await mcp.call("agent_status", { agent_id: receipt.agent_id })).read_only, true);
    await mcp.call("agent_close", { agent_id: receipt.agent_id });
  });

  it(`${harness} ordinary spawn keeps the existing argv and config permissions`, gate, async () => {
    rmSync(argvFile, { force: true });
    const receipt = await mcp.call("agent_spawn", { name: `ordinary-${harness}`, command: join(bin, harness), model: "test-model", extra_args: ["--example"] });
    const args = await argv();
    const row = db.prepare("SELECT * FROM agents WHERE id = ?").get(receipt.agent_id);
    assert.equal(row.extra_args, '["--example"]');
    assert.equal((await mcp.call("agent_status", { agent_id: receipt.agent_id })).read_only, false);
    if (harness === "codex") {
      assert.deepEqual(args, ["--model", "test-model", "--dangerously-bypass-hook-trust", "--dangerously-bypass-approvals-and-sandbox", "--add-dir", join(dirs.projectDir, ".git"), "--example"]);
      assert.equal(parseToml(readFileSync(join(receipt.codex_home, "config.toml"), "utf8")).mcp_servers.hive.default_tools_approval_mode, undefined);
    } else {
      assert.deepEqual(args, ["--model", "test-model", "--name", "ordinary-claude", "--settings", join(dirs.dataDir, `worker-${receipt.agent_id}-hooks.json`), "--append-system-prompt-file", join(dirs.dataDir, "briefs", `agent-${receipt.agent_id}.md`), "--session-id", row.session_id, "--example"]);
      const settings = JSON.parse(readFileSync(args[args.indexOf("--settings") + 1], "utf8"));
      assert.equal(settings.sandbox, undefined);
      assert.deepEqual(settings.permissions.deny, ["SendMessage", "ListAgents"]);
    }
    await mcp.call("agent_close", { agent_id: receipt.agent_id });
  });
}

it("read-only refuses unknown harnesses, permission overrides and unknown input keys before spawning", gate, async () => {
  for (const input of [
    { command: "/bin/sh" },
    { command: "claude --dangerously-skip-permissions" },
    { command: join(bin, "codex"), extra_args: ["--sandbox", "danger-full-access"] },
    { command: join(bin, "codex"), extra_args: ["-c", "sandbox_mode=\"danger-full-access\""] },
    { command: join(bin, "codex"), extra_args: ["-c", "approval_policy=\"never\""] },
    { command: join(bin, "codex"), extra_args: ["--dangerously-bypass-approvals-and-sandbox"] },
    { command: join(bin, "codex"), extra_args: ["-c", "model_reasoning_effort=medium", "--dangerously-bypass-approvals-and-sandbox"] },
    { command: join(bin, "codex"), extra_args: ["-c", "model_reasoning_effort=max"] },
    { command: join(bin, "claude"), extra_args: ["--dangerously-skip-permissions"] },
    { command: join(bin, "claude"), extra_args: ["--effort"] },
    { command: join(bin, "claude"), extra_args: ["--effort", "medium", "--settings", "override.json"] },
  ]) {
    await assert.rejects(mcp.call("agent_spawn", { ...input, read_only: true }), /read_only requires/);
  }
  await assert.rejects(mcp.call("agent_spawn", { command: join(bin, "claude"), read_only: true, read_ony: true }), /read_ony/);
});

it("codex's default launch argv remains byte-identical when readOnly is false", () => {
  assert.deepEqual(codexLaunchArgs(dirs.projectDir), codexLaunchArgs(dirs.projectDir, false));
});
