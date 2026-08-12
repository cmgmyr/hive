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

// Issue #27's L4 fix round R6, todo 167 (counselors codex F4, HIGH, verified
// by the lead against the code before dispatch). cmdLead's envFlags
// (src/cli.ts) never carried HIVE_DATA_DIR, unlike launchAgent's for every
// worker (src/spawn.ts). Consequence: the CLI subprocess that runs `hive
// lead` always knows the right store (it has to, to write the lead's own
// row), but the CLAUDE PROCESS the tmux pane actually launches inherited
// whatever the tmux SERVER's own environment carried, which is only ever
// the right value BY COINCIDENCE when the same invocation also happens to be
// the one that first started that server.
//
// This is exactly the case the rest of the suite structurally conceals: every
// other file's isolateTmux() call starts its own tmux server, and the very
// first `hive lead`/agent_spawn against it is what creates that server, so
// the server's ambient environment always coincidentally already carries the
// matching HIVE_DATA_DIR. Reproducing the bug means a server that existed
// BEFORE this file's own `hive lead` call, started with no HIVE_DATA_DIR of
// its own - the "start a tmux server without HIVE_DATA_DIR, then run
// HIVE_DATA_DIR=/tmp/alternate hive lead" repro from the finding, not
// something a shared per-file socket can produce on its own.
//
// So this file uses a SECOND, bespoke TMUX_TMPDIR distinct from its own
// isolateTmux() socket (needed for the file-level suite-isolation check;
// nothing here targets it) - both remain private sockets paired with scratch
// stores, never the live pair.
const { cleanup: cleanupIsolatedSuite } = isolateTmux("the lead data-dir test's own default socket");
after(() => cleanupIsolatedSuite());

// Issue #27's L4 fix round R8, todo 175 item 2 (counselors codex F4,
// MEDIUM). tmux panes inherit the SERVER's own environment - src/spawn.ts's
// HIVE_LEAD: "" clear for a worker exists for exactly this reason, in the
// opposite direction. cmdLead's envFlags used to never mention
// HIVE_PROJECT_LOCK or HIVE_PROJECT_PATH at all, on the reasoning that a
// lead is never locked to a project so setting them would be inert - true
// only if they were also absent from the server's ambient environment,
// which nothing guarantees. A pre-existing server carrying HIVE_PROJECT_LOCK=1
// (started by a worker, or a stray shell) hands a lead session a lock it
// must never have, and a mismatched inherited HIVE_PROJECT_PATH makes its
// project-scoped calls fail outright.
describe("the lead's spawned session clears HIVE_PROJECT_LOCK and HIVE_PROJECT_PATH", () => {
  it("does not inherit them from a pre-existing tmux server's own environment", async () => {
    const dirs = scratchDirs();
    const bareTmuxTmpDir = mkdtempSync(join(tmpdir(), "hive-bare-tmux2-"));
    // Todo 375, counselors round 2 (F6). A SECOND server on a bespoke
    // socket, which isolateTmux does not register - so the run-level leak
    // check only sees it if this says so.
    recordScratchTmuxSocket(tmuxSocketUnder(bareTmuxTmpDir));
    const keepaliveSession = "bare-server-keepalive-2";

    // The pre-existing server's OWN environment carries both vars, standing
    // in for a worker's tmux server a lead is later started on.
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

      // Not just existsSync: the shell's own `>` redirection truncates
      // (creates) the file as part of setting up the subshell, strictly
      // before either echo inside it has run, so a bare existence check can
      // observe the file between truncation and content landing and read a
      // false-negative "empty" - polls for content instead.
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
        // Nothing left to tear down.
      }
    }
  });
});

describe("the lead's spawned session gets HIVE_DATA_DIR", () => {
  it("passes it to the lead's own pane process, not just to the CLI subprocess that launched it", async () => {
    const dirs = scratchDirs();
    // Short prefix, matching isolateTmux()'s own: the tmux socket path caps
    // near 104 bytes (test/CLAUDE.md), and this dir nests under mkdtemp's
    // own already-long scratch path.
    const bareTmuxTmpDir = mkdtempSync(join(tmpdir(), "hive-bare-tmux-"));
    // Todo 375, counselors round 2 (F6). A SECOND server on a bespoke
    // socket, which isolateTmux does not register - so the run-level leak
    // check only sees it if this says so.
    recordScratchTmuxSocket(tmuxSocketUnder(bareTmuxTmpDir));
    const keepaliveSession = "bare-server-keepalive";

    // The "server without HIVE_DATA_DIR" half of the repro: start the server
    // ourselves, directly, with HIVE_DATA_DIR absent from the env that
    // creates it - so its ambient environment cannot coincidentally already
    // carry the value this test is about to check for.
    const bareEnv = { ...process.env, TMUX_TMPDIR: bareTmuxTmpDir };
    delete bareEnv.HIVE_DATA_DIR;
    delete bareEnv.TMUX;
    execFileSync("tmux", ["new-session", "-d", "-s", keepaliveSession, "sleep", "600"], { env: bareEnv, stdio: "ignore" });

    const markerFile = join(dirs.tmp, "lead-env-marker");
    const fakeClaude = makeFakeClaude(dirs.tmp);
    // Dumps the SPAWNED PANE PROCESS's own actual environment, not a value
    // observed some other way - ground truth for what the fix claims.
    const claudePath = fakeClaude(`printenv HIVE_DATA_DIR > "${markerFile}" 2>/dev/null || true; exec sleep 600`);

    try {
      const result = await runCli(["lead"], {
        cwd: dirs.projectDir,
        dataDir: dirs.dataDir,
        tmp: dirs.tmp,
        // TMUX_TMPDIR here overrides this suite's own default socket,
        // pointing `hive lead` at the pre-existing bare server instead.
        env: { PATH: `${dirname(claudePath)}:${process.env.PATH}`, TMUX_TMPDIR: bareTmuxTmpDir },
      });
      assert.equal(result.code, 0, result.stderr);

      // `hive lead` returns once the pane is CREATED, not once its command
      // has run far enough to have written the marker - the fake claude's
      // own shell needs a moment to start and run the printenv line. Not
      // just existsSync either (found while adding a sibling test, todo
      // 175): shell `>` redirection truncates (creates) the file as part of
      // setting up printenv's stdout, strictly before printenv itself has
      // run, so a bare existence check can observe the file in that gap and
      // read a false-negative "empty" rather than a real one - poll for
      // actual content landing instead.
      await until(() => existsSync(markerFile) && readFileSync(markerFile, "utf8").trim() !== "", 5000);
      const seen = existsSync(markerFile) ? readFileSync(markerFile, "utf8").trim() : "(marker file was never written)";
      assert.equal(
        seen,
        dirs.dataDir,
        "the lead's own pane must see the SAME HIVE_DATA_DIR the CLI was launched with, not whatever " +
          "the pre-existing tmux server's own ambient environment carried (here: nothing)",
      );
    } finally {
      // Never kill-server (.claude/rules/tmux-and-panes.md): enumerate this
      // private socket's own sessions and kill each by name instead, even
      // though bareEnv's TMUX_TMPDIR should already scope kill-server
      // correctly here - the rule is categorical, not confidence-based.
      try {
        const sessions = execFileSync("tmux", ["list-sessions", "-F", "#{session_name}"], { env: bareEnv, encoding: "utf8" })
          .trim()
          .split("\n")
          .filter(Boolean);
        for (const s of sessions) {
          execFileSync("tmux", ["kill-session", "-t", `=${s}`], { env: bareEnv, stdio: "ignore" });
        }
      } catch {
        // Nothing left to tear down.
      }
    }
  });
});
