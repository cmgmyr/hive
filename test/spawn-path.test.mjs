import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { after, describe, it } from "node:test";
import { dirname, join } from "node:path";

import { clearHiveEnv, isolateTmux, McpClient, scratchDirs, tmux, until } from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("the worker PATH tests");
const dirs = scratchDirs();
clearHiveEnv();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { paneEnvPath, sessionName } = await import("../dist/tmux.js");
const { db } = await import("../dist/db.js");

const userBin = join(dirs.tmp, "existing", "node_modules", ".bin");
const fakeBin = join(dirs.tmp, "fake-bin");
mkdirSync(userBin, { recursive: true });
mkdirSync(fakeBin, { recursive: true });
const nodeBin = dirname(process.execPath);
const tmuxBin = hasTmux ? dirname(execFileSync("which", ["tmux"], { encoding: "utf8" }).trim()) : "/usr/bin";
const basePath = [userBin, fakeBin, nodeBin, tmuxBin, "/usr/bin", "/bin"].join(":");
const npmPrefix = [
  join(dirs.tmp, "_npx", "hash", "node_modules", ".bin"),
  join(dirs.projectDir, "node_modules", ".bin"),
  join(dirname(dirs.projectDir), "node_modules", ".bin"),
  join(dirs.tmp, "parent", "node_modules", ".bin"),
  join(dirs.tmp, "npm", "node_modules", "@npmcli", "run-script", "lib", "node-gyp-bin"),
];
const npmExecPath = [...npmPrefix, basePath].join(":");
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const needsTmux = hasTmux ? {} : { skip: "tmux is not installed" };

function startMcp(serverPath, npmCommand, shell = "/bin/sh") {
  return new McpClient({
    cwd: dirs.projectDir,
    dataDir: dirs.dataDir,
    env: {
      PATH: serverPath,
      HOME: dirs.tmp,
      npm_command: npmCommand,
      npm_lifecycle_event: "test",
      HIVE_SPAWN_READY_MS: "1",
      TERM: "xterm-256color",
      SHELL: shell,
    },
  });
}

async function withMcp(serverPath, npmCommand, action, shell = "/bin/sh") {
  cleanup(sessionName());
  const mcp = startMcp(serverPath, npmCommand, shell);
  try {
    await mcp.start();
    return await action(mcp);
  } finally {
    await mcp.close();
    cleanup(sessionName());
  }
}

async function spawnPathProbe(mcp, name, output, placement = "window") {
  const command = `/usr/bin/printenv PATH > ${quote(output)}; sleep 600`;
  await mcp.call("agent_spawn", {
    name,
    command: "/bin/sh",
    extra_args: ["-c", command],
    placement,
  });
  await until(() => existsSync(output), 5000, 25, `the ${name} pane writes its PATH`);
  return readFileSync(output, "utf8").trim();
}

function installFakeClaude(output) {
  const fakeClaude = join(fakeBin, "claude");
  writeFileSync(fakeClaude, `#!/bin/sh\n/usr/bin/printenv PATH > ${quote(output)}\nsleep 600\n`);
  chmodSync(fakeClaude, 0o755);
}

function installStartupShell(startupPath) {
  const shell = join(dirs.tmp, "startup-shell");
  writeFileSync(
    shell,
    `#!/bin/sh\nif [ "$1" = "-c" ]; then\n  shift\n  PATH=${quote(startupPath)}:"$PATH" exec /bin/sh -c "$1"\nfi\nexec /bin/sh "$@"\n`,
  );
  chmodSync(shell, 0o755);
  return shell;
}

after(() => {
  cleanup(sessionName());
  rmSync(dirname(dirs.dataDir), { recursive: true, force: true });
});

describe("worker pane PATH from npm exec", () => {
  it("cuts the npm exec PATH prefix from a split worker using the server's explicit environment", needsTmux, async () => {
    assert.notEqual(npmExecPath, process.env.PATH, "the PATH fixture must differ from the test runner's PATH");
    await withMcp(npmExecPath, "exec", async (mcp) => {
      await mcp.call("agent_spawn", {
        name: "path-split-anchor",
        command: "/bin/sleep",
        extra_args: ["600"],
        placement: "window",
      });
      const actual = await spawnPathProbe(mcp, "path-split-worker", join(dirs.tmp, "split.path"), "split");
      assert.equal(actual, basePath, "the first node-gyp-bin boundary removes only npm exec's prefix");
    });
  });

  it("cuts PATH on the first new-session pane and leaves no session-scope PATH", needsTmux, async () => {
    await withMcp(npmExecPath, "exec", async (mcp) => {
      const actual = await spawnPathProbe(mcp, "path-first-pane", join(dirs.tmp, "first-pane.path"));
      assert.equal(actual, basePath, "the first pane gets the PATH after npm exec's boundary");
      assert.throws(
        () => tmux("show-environment", "-t", `=${sessionName()}`, "PATH"),
        /unknown variable: PATH/,
        "new-session -e must not leave PATH at session scope after its pane starts",
      );
    });
  });

  it("preserves PATH entries added by the pane shell startup", needsTmux, async () => {
    const startupBin = join(dirs.tmp, "startup-bin");
    mkdirSync(startupBin);
    const startupShell = installStartupShell(startupBin);
    await withMcp(npmExecPath, "exec", async (mcp) => {
      const actual = await spawnPathProbe(mcp, "path-shell-startup", join(dirs.tmp, "startup.path"));
      assert.equal(actual, [startupBin, basePath].join(":"));
      for (const injected of npmPrefix) assert.equal(actual.includes(injected), false);
    }, startupShell);
  });

  it("cuts PATH again when agent_resume creates the resumed pane", needsTmux, async () => {
    const output = join(dirs.tmp, "resume.path");
    installFakeClaude(output);

    await withMcp(npmExecPath, "exec", async (mcp) => {
      const spawned = await mcp.call("agent_spawn", { name: "path-resume", harness: "claude", placement: "window" });
      await until(() => existsSync(output), 5000, 25, "the initial claude pane writes its PATH");
      assert.equal(readFileSync(output, "utf8").trim(), basePath, "agent_spawn uses the test-set npx environment");

      await mcp.call("agent_close", { agent_id: spawned.agent_id });
      rmSync(output, { force: true });
      await mcp.call("agent_resume", { agent_id: spawned.agent_id });
      await until(() => existsSync(output), 5000, 25, "the resumed claude pane writes its PATH");
      assert.equal(readFileSync(output, "utf8").trim(), basePath, "agent_resume reads and cuts the server's PATH");
    });
  });

  it("cuts PATH when agent_fork creates a child pane", needsTmux, async () => {
    const output = join(dirs.tmp, "fork.path");
    const transcript = join(dirs.tmp, "fork-source.jsonl");
    installFakeClaude(output);

    await withMcp(npmExecPath, "exec", async (mcp) => {
      const source = await mcp.call("agent_spawn", { name: "path-fork-source", harness: "claude", placement: "window" });
      const sourceStatus = await mcp.call("agent_status", { agent_id: source.agent_id });
      writeFileSync(transcript, `${JSON.stringify({ session_id: sourceStatus.session_id })}\n`);
      db.prepare("UPDATE agents SET transcript_path = ? WHERE id = ?").run(transcript, source.agent_id);
      rmSync(output, { force: true });

      await mcp.call("agent_fork", { agent_id: source.agent_id, name: "path-fork-child", placement: "window" });
      await until(() => existsSync(output), 5000, 25, "the forked claude pane writes its PATH");
      assert.equal(readFileSync(output, "utf8").trim(), basePath, "agent_fork uses the test-set npx environment");
    });
  });

  it("leaves PATH unchanged when npm_command is not exec", needsTmux, async () => {
    await withMcp(basePath, "run-script", async (mcp) => {
      const actual = await spawnPathProbe(mcp, "path-non-exec", join(dirs.tmp, "non-exec.path"));
      assert.equal(actual, basePath, "a server outside npm exec gets its test-set PATH unchanged");
    });
  });

  it("keeps spawn working and PATH unchanged when npm exec has no boundary entry", needsTmux, async () => {
    const pathWithoutBoundary = [join(dirs.tmp, "_npx", "hash", "node_modules", ".bin"), basePath].join(":");
    await withMcp(pathWithoutBoundary, "exec", async (mcp) => {
      const actual = await spawnPathProbe(mcp, "path-missing-boundary", join(dirs.tmp, "missing-boundary.path"));
      assert.equal(actual, pathWithoutBoundary, "an unknown clean PATH falls back to current spawn behavior");
    });
  });

  it("reads npm_command and PATH at each pane PATH lookup", async () => {
    const oldPath = process.env.PATH;
    const oldNpmCommand = process.env.npm_command;
    try {
      process.env.npm_command = "exec";
      process.env.PATH = [...npmPrefix, "/first/original/bin"].join(":");
      assert.equal(paneEnvPath(), "/first/original/bin");
      process.env.PATH = [...npmPrefix, "/second/original/bin"].join(":");
      assert.equal(paneEnvPath(), "/second/original/bin");
    } finally {
      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;
      if (oldNpmCommand === undefined) delete process.env.npm_command;
      else process.env.npm_command = oldNpmCommand;
    }
  });
});
