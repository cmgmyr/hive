import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { after, describe, it } from "node:test";

import {
  isolateTmux,
  makeFakeClaude,
  recordScratchTmuxSocket,
  runCli,
  scratchDirs,
  tmuxSocketUnder,
  until,
} from "./helpers.mjs";

const { cleanup: cleanupIsolatedSuite } = isolateTmux("the lead data-dir test's own default socket");
after(() => cleanupIsolatedSuite());

describe("the lead's spawned session clears HIVE_PROJECT_LOCK and HIVE_PROJECT_PATH", () => {
  it("does not inherit them from a pre-existing tmux server's own environment", async () => {
    const dirs = scratchDirs();
    const bareTmuxTmpDir = mkdtempSync(join(tmpdir(), "hive-bare-tmux2-"));

    recordScratchTmuxSocket(tmuxSocketUnder(bareTmuxTmpDir));
    const keepaliveSession = "bare-server-keepalive-2";

    const bareEnv = {
      ...process.env,
      TMUX_TMPDIR: bareTmuxTmpDir,
      HIVE_PROJECT_LOCK: "1",
      HIVE_PROJECT_PATH: "/some/other/project",
    };
    delete bareEnv.HIVE_DATA_DIR;
    delete bareEnv.TMUX;
    execFileSync("tmux", ["new-session", "-d", "-s", keepaliveSession, "sleep", "600"], { env: bareEnv, stdio: "ignore" });

    const markerFile = join(dirs.tmp, "lead-project-lock-marker");
    const fakeClaude = makeFakeClaude(dirs.tmp);
    const claudePath = fakeClaude(
      `(echo "HIVE_PROJECT_LOCK=$HIVE_PROJECT_LOCK"; echo "HIVE_PROJECT_PATH=$HIVE_PROJECT_PATH") > "${markerFile}" 2>/dev/null || true; exec sleep 600`,
    );

    try {
      const result = await runCli(["lead"], {
        cwd: dirs.projectDir,
        dataDir: dirs.dataDir,
        tmp: dirs.tmp,
        env: { PATH: `${dirname(claudePath)}:${process.env.PATH}`, TMUX_TMPDIR: bareTmuxTmpDir },
      });
      assert.equal(result.code, 0, result.stderr);

      await until(() => existsSync(markerFile) && readFileSync(markerFile, "utf8").includes("HIVE_PROJECT_PATH="), 5000);
      const seen = existsSync(markerFile) ? readFileSync(markerFile, "utf8") : "(marker file was never written)";
      assert.match(
        seen,
        /^HIVE_PROJECT_LOCK=$/m,
        `the lead's own pane must not inherit HIVE_PROJECT_LOCK from the server; saw:\n${seen}`,
      );
      assert.match(
        seen,
        /^HIVE_PROJECT_PATH=$/m,
        `the lead's own pane must not inherit HIVE_PROJECT_PATH from the server; saw:\n${seen}`,
      );
    } finally {
      try {
        const sessions = execFileSync("tmux", ["list-sessions", "-F", "#{session_name}"], { env: bareEnv, encoding: "utf8" })
          .trim()
          .split("\n")
          .filter(Boolean);
        for (const s of sessions) {
          execFileSync("tmux", ["kill-session", "-t", `=${s}`], { env: bareEnv, stdio: "ignore" });
        }
      } catch {

      }
    }
  });
});

describe("the lead's spawned session gets HIVE_DATA_DIR", () => {
  it("passes it to the lead's own pane process, not just to the CLI subprocess that launched it", async () => {
    const dirs = scratchDirs();

    const bareTmuxTmpDir = mkdtempSync(join(tmpdir(), "hive-bare-tmux-"));

    recordScratchTmuxSocket(tmuxSocketUnder(bareTmuxTmpDir));
    const keepaliveSession = "bare-server-keepalive";

    const bareEnv = { ...process.env, TMUX_TMPDIR: bareTmuxTmpDir };
    delete bareEnv.HIVE_DATA_DIR;
    delete bareEnv.TMUX;
    execFileSync("tmux", ["new-session", "-d", "-s", keepaliveSession, "sleep", "600"], { env: bareEnv, stdio: "ignore" });

    const markerFile = join(dirs.tmp, "lead-env-marker");
    const fakeClaude = makeFakeClaude(dirs.tmp);

    const claudePath = fakeClaude(`printenv HIVE_DATA_DIR > "${markerFile}" 2>/dev/null || true; exec sleep 600`);

    try {
      const result = await runCli(["lead"], {
        cwd: dirs.projectDir,
        dataDir: dirs.dataDir,
        tmp: dirs.tmp,

        env: { PATH: `${dirname(claudePath)}:${process.env.PATH}`, TMUX_TMPDIR: bareTmuxTmpDir },
      });
      assert.equal(result.code, 0, result.stderr);

      await until(() => existsSync(markerFile) && readFileSync(markerFile, "utf8").trim() !== "", 5000);
      const seen = existsSync(markerFile) ? readFileSync(markerFile, "utf8").trim() : "(marker file was never written)";
      assert.equal(
        seen,
        dirs.dataDir,
        "the lead's own pane must see the SAME HIVE_DATA_DIR the CLI was launched with, not whatever " +
          "the pre-existing tmux server's own ambient environment carried (here: nothing)",
      );
    } finally {

      try {
        const sessions = execFileSync("tmux", ["list-sessions", "-F", "#{session_name}"], { env: bareEnv, encoding: "utf8" })
          .trim()
          .split("\n")
          .filter(Boolean);
        for (const s of sessions) {
          execFileSync("tmux", ["kill-session", "-t", `=${s}`], { env: bareEnv, stdio: "ignore" });
        }
      } catch {

      }
    }
  });
});
