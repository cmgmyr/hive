import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, it } from "node:test";
import { CLI, isolateTmux, scratchDirs } from "./helpers.mjs";

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
