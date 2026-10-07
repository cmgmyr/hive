import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, it } from "node:test";
import { CLI, isolateTmux, scratchDirs } from "./helpers.mjs";

function emitStdoutError(code, dirs) {
  const source = `
    process.argv = [process.execPath, ${JSON.stringify(CLI)}, "status"];
    const cli = import(${JSON.stringify(CLI)});
    const emitWhenReady = () => {
      if (process.stdout.listenerCount("error") === 0) {
        setImmediate(emitWhenReady);
        return;
      }
      process.stderr.write("stdout error handler registered\\n");
      process.stdout.emit("error", Object.assign(new Error("synthetic stdout failure"), { code: ${JSON.stringify(code)} }));
    };
    setImmediate(emitWhenReady);
    await cli;
  `;
  return spawnSync(process.execPath, ["--input-type=module", "-e", source], {
    cwd: dirs.projectDir,
    env: { ...process.env, HIVE_DATA_DIR: dirs.dataDir },
    encoding: "utf8",
  });
}

const { cleanup: cleanupTmux } = isolateTmux("the CLI EPIPE tests");
after(() => cleanupTmux());

it("hive profile read exits quietly when its stdout reader closes early", async () => {
  const dirs = scratchDirs();
  try {
    const profileDir = join(dirs.dataDir, "profiles", "large-output");
    mkdirSync(profileDir, { recursive: true });
    writeFileSync(join(profileDir, "runbook.md"), "x".repeat(1024 * 1024));

    const child = spawn(process.execPath, [CLI, "profile", "read", "runbook.md", "--profile", "large-output"], {
      cwd: dirs.projectDir,
      env: { ...process.env, HIVE_DATA_DIR: dirs.dataDir },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    let closedBeforeRead = false;
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    const closed = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolve(code));
    });
    child.stdout.once("data", () => {
      closedBeforeRead = child.exitCode === null;
      child.stdout.destroy();
    });

    const code = await closed;
    assert.equal(closedBeforeRead, true, "the reader must close while the CLI is still writing");
    assert.equal(code, 0, stderr);
    assert.doesNotMatch(stderr, /EPIPE|Error:/);
  } finally {
    rmSync(dirs.projectDir, { recursive: true, force: true });
    rmSync(dirs.dataDir, { recursive: true, force: true });
    rmSync(dirs.tmp, { recursive: true, force: true });
  }
});

it("the real stdout handler exits quietly on ENOTCONN", () => {
  const dirs = scratchDirs();
  try {
    const result = emitStdoutError("ENOTCONN", dirs);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "stdout error handler registered\n");
  } finally {
    rmSync(dirs.projectDir, { recursive: true, force: true });
    rmSync(dirs.dataDir, { recursive: true, force: true });
    rmSync(dirs.tmp, { recursive: true, force: true });
  }
});

it("the real stdout handler still throws errors other than EPIPE and ENOTCONN", () => {
  const dirs = scratchDirs();
  try {
    const result = emitStdoutError("EIO", dirs);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /^stdout error handler registered\n/);
    assert.match(result.stderr, /synthetic stdout failure/);
    assert.match(result.stderr, /EIO/);
  } finally {
    rmSync(dirs.projectDir, { recursive: true, force: true });
    rmSync(dirs.dataDir, { recursive: true, force: true });
    rmSync(dirs.tmp, { recursive: true, force: true });
  }
});
