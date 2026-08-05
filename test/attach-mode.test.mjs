import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { describe, it } from "node:test";

import { isolateTmux, runCli, scratchDirs, sleep, withEnv } from "./helpers.mjs";

// Issue #81. controlModeFor() and attachScripts() are pure and read
// storeDir()/config.json at call time (same reasoning as config.ts and
// dataDir.ts), so setting HIVE_DATA_DIR per case is enough; no subprocess is
// needed for those. The CLI-level cases at the bottom do need a subprocess
// and a private tmux server, since cmdAttach's non-TTY branch is only
// reachable through a real "hive attach" invocation.
const { hasTmux, cleanup } = isolateTmux("attach mode (issue #81)");

process.env.HIVE_DATA_DIR = scratchDirs().dataDir;
const { resolvedAttachMode, setAttachMode } = await import("../dist/config.js");
const { attachScripts, controlModeFor, createWindow, ensureSession, sessionName } = await import("../dist/tmux.js");

// Auto-attach's own behaviour lives in test/auto-attach-scope.test.mjs, which
// drives ensureAttached against fake tmux and osascript binaries. It used to
// live here as three assertions against a pure helper plus a regex over
// src/tmux.ts's source text; see that file's header for why none of them could
// fail when the behaviour regressed.

// HIVE_ATTACH_MODE is a one-off testing override; withEnv restores it after
// every case that sets it so a later, unrelated case does not inherit it.
const withEnvAttachMode = (value, fn) => withEnv({ HIVE_ATTACH_MODE: value }, fn);

describe("controlModeFor", () => {
  it("auto follows iTerm detection with no config file", () => {
    process.env.HIVE_DATA_DIR = scratchDirs().dataDir;
    assert.equal(controlModeFor(true), true);
    assert.equal(controlModeFor(false), false);
  });

  it("raw never carries control mode, regardless of detection", () => {
    process.env.HIVE_DATA_DIR = scratchDirs().dataDir;
    setAttachMode("raw");
    assert.equal(controlModeFor(true), false);
    assert.equal(controlModeFor(false), false);
  });

  it("control always carries it, regardless of detection", () => {
    process.env.HIVE_DATA_DIR = scratchDirs().dataDir;
    setAttachMode("control");
    assert.equal(controlModeFor(true), true);
    assert.equal(controlModeFor(false), true);
  });
});

describe("HIVE_ATTACH_MODE precedence", () => {
  it("beats a stored config value", () => {
    process.env.HIVE_DATA_DIR = scratchDirs().dataDir;
    setAttachMode("raw");
    withEnvAttachMode("control", () => {
      assert.deepEqual(resolvedAttachMode(), { mode: "control", source: "env" });
      // controlModeFor() is the one helper both call sites go through, so
      // proving the override reaches it here proves it reaches both.
      assert.equal(controlModeFor(false), true);
    });
    // Unaffected once the override is gone: the stored value is still raw.
    assert.deepEqual(resolvedAttachMode(), { mode: "raw", source: "config" });
  });

  it("falls through to config, then detection, when unset or unknown", () => {
    process.env.HIVE_DATA_DIR = scratchDirs().dataDir;
    assert.deepEqual(resolvedAttachMode(), { mode: "auto", source: "detection" });
    withEnvAttachMode("not-a-real-mode", () => {
      // An invalid override is not an override at all; falls through exactly
      // like a malformed config file does.
      assert.deepEqual(resolvedAttachMode(), { mode: "auto", source: "detection" });
    });
  });
});

describe("attachScripts (ensureAttached's AppleScript)", () => {
  it("auto matches today's exact string with no config file", () => {
    process.env.HIVE_DATA_DIR = scratchDirs().dataDir;
    const [iterm, terminal] = attachScripts("/opt/homebrew/bin/tmux", "hive-1");
    assert.equal(
      iterm,
      'tell application "iTerm" to create window with default profile command "/opt/homebrew/bin/tmux -CC attach -t hive-1"',
    );
    assert.equal(
      terminal,
      'tell application "Terminal" to do script "/opt/homebrew/bin/tmux attach -t hive-1"',
    );
  });

  it("raw drops -CC from the iTerm script but keeps the app", () => {
    process.env.HIVE_DATA_DIR = scratchDirs().dataDir;
    setAttachMode("raw");
    const [iterm, terminal] = attachScripts("/opt/homebrew/bin/tmux", "hive-1");
    assert.equal(
      iterm,
      'tell application "iTerm" to create window with default profile command "/opt/homebrew/bin/tmux attach -t hive-1"',
    );
    assert.doesNotMatch(terminal, /-CC/);
  });

  it("control keeps -CC, unchanged from auto for this site", () => {
    process.env.HIVE_DATA_DIR = scratchDirs().dataDir;
    setAttachMode("control");
    const [iterm] = attachScripts("/opt/homebrew/bin/tmux", "hive-1");
    assert.match(iterm, /-CC attach/);
  });
});

describe(
  "hive attach's non-TTY hint honours the stored mode",
  { skip: hasTmux ? false : "tmux is not installed" },
  () => {
    it("auto follows TERM_PROGRAM, byte-identical to today when no config file exists", async () => {
      const dirs = scratchDirs();
      const opts = { cwd: dirs.projectDir, dataDir: dirs.dataDir, tmp: dirs.tmp };
      const init = await runCli(["init"], opts);
      assert.equal(init.code, 0, init.stderr);
      const session = sessionName();
      try {
        // `new-session -t`, not `attach -t`: todo 279 collapsed the two attach
        // branches into the view-session one, so the printed hint carries the
        // same chain the spawn path runs. What this case is about is the -CC
        // prefix and nothing else, so it asserts the prefix against whatever
        // subcommand follows it.
        const iterm = await runCli(["attach"], { ...opts, env: { TERM_PROGRAM: "iTerm.app" } });
        assert.match(iterm.stdout, /Attach from a terminal with: tmux -CC new-session -t /);

        const plain = await runCli(["attach"], { ...opts, env: { TERM_PROGRAM: "" } });
        assert.match(plain.stdout, /Attach from a terminal with: tmux new-session -t /);
        assert.doesNotMatch(plain.stdout, /-CC/);
      } finally {
        cleanup(session);
      }
    });

    it("raw never prints -CC, even under iTerm", async () => {
      const dirs = scratchDirs();
      const opts = { cwd: dirs.projectDir, dataDir: dirs.dataDir, tmp: dirs.tmp };
      const init = await runCli(["init"], opts);
      assert.equal(init.code, 0, init.stderr);
      // No `hive setup --attach` yet (issue #81 step 3): write the config the
      // same way that command will, by calling setAttachMode against the same
      // store the child process resolves.
      process.env.HIVE_DATA_DIR = dirs.dataDir;
      setAttachMode("raw");
      const session = sessionName();
      try {
        const result = await runCli(["attach"], { ...opts, env: { TERM_PROGRAM: "iTerm.app" } });
        assert.doesNotMatch(result.stdout, /-CC/);
      } finally {
        cleanup(session);
      }
    });

    it("control always prints -CC, even with no TERM_PROGRAM", async () => {
      const dirs = scratchDirs();
      const opts = { cwd: dirs.projectDir, dataDir: dirs.dataDir, tmp: dirs.tmp };
      const init = await runCli(["init"], opts);
      assert.equal(init.code, 0, init.stderr);
      process.env.HIVE_DATA_DIR = dirs.dataDir;
      setAttachMode("control");
      const session = sessionName();
      try {
        const result = await runCli(["attach"], { ...opts, env: { TERM_PROGRAM: "" } });
        assert.match(result.stdout, /-CC new-session/);
      } finally {
        cleanup(session);
      }
    });

    it("HIVE_ATTACH_MODE overrides a stored config value", async () => {
      const dirs = scratchDirs();
      const opts = { cwd: dirs.projectDir, dataDir: dirs.dataDir, tmp: dirs.tmp };
      const init = await runCli(["init"], opts);
      assert.equal(init.code, 0, init.stderr);
      process.env.HIVE_DATA_DIR = dirs.dataDir;
      setAttachMode("raw");
      const session = sessionName();
      try {
        const result = await runCli(["attach"], {
          ...opts,
          env: { TERM_PROGRAM: "", HIVE_ATTACH_MODE: "control" },
        });
        assert.match(result.stdout, /-CC new-session/, "the override, not the stored raw, must win");
      } finally {
        cleanup(session);
      }
    });
  },
);

// Smoke-test finding against the branch build: cmdAttach's non-TTY hint used
// to be hand-built (`tmux attach -t <session>`) with no idea of the
// project's window or an already-attached base session, so it could walk a
// human into the exact current-window fight this lane exists to prevent
// (pad 71's opening complaint - two pieces of hive's own advice pointing
// opposite ways). Fixed by making resolveAttachTarget (src/tmux.ts) the ONE
// source both the spawn path and this print path read from; these two
// cases are the ones that could never have been wrong before the reversal
// (there was no window/view awareness to be wrong about) and are the ones
// that regressed.
describe(
  "hive attach's non-TTY hint knows about the project's window and an already-attached base",
  { skip: hasTmux ? false : "tmux is not installed" },
  () => {
    it("prints a command that selects the project's own window, not a bare attach", async () => {
      const dirs = scratchDirs();
      const opts = { cwd: dirs.projectDir, dataDir: dirs.dataDir, tmp: dirs.tmp };
      const init = await runCli(["init"], opts);
      assert.equal(init.code, 0, init.stderr);
      process.env.HIVE_DATA_DIR = dirs.dataDir;
      const { db } = await import("../dist/db.js");
      const project = db.prepare("SELECT id FROM projects WHERE path = ?").get(dirs.projectDir);
      const session = sessionName();
      ensureSession(session, dirs.projectDir);
      const { window } = createWindow(session, "attach-hint-test", dirs.projectDir, [], "sleep 600", project.id);
      try {
        const result = await runCli(["attach"], { ...opts, env: { TERM_PROGRAM: "" } });
        // The window ID, qualified with the VIEW session the chain creates
        // rather than with the base session's name (todo 279): every attach
        // takes a view now, and a base-qualified select-window is the yank
        // this round removed. The view is named for the CLI child's own pid,
        // which this process cannot know, so the session part is matched
        // loosely and the window id exactly.
        assert.match(
          result.stdout,
          new RegExp(`select-window -t \\S*view-\\d+:${window.split(":")[1]}\\b`),
          `must print a select-window naming the project's own window; stdout:\n${result.stdout}`,
        );
      } finally {
        cleanup(session);
      }
    });

    it("prints the VIEW SESSION form, never a bare attach, once base already has a client", async () => {
      const dirs = scratchDirs();
      const opts = { cwd: dirs.projectDir, dataDir: dirs.dataDir, tmp: dirs.tmp };
      const init = await runCli(["init"], opts);
      assert.equal(init.code, 0, init.stderr);
      process.env.HIVE_DATA_DIR = dirs.dataDir;
      const session = sessionName();
      ensureSession(session, dirs.projectDir);

      // A headless control-mode client, the standing way this suite forces a
      // session to already have one (test/view-session.test.mjs).
      const client = spawn("tmux", ["-C", "attach", "-t", `=${session}`], { stdio: ["pipe", "pipe", "pipe"] });
      try {
        await sleep(300);
        const result = await runCli(["attach"], { ...opts, env: { TERM_PROGRAM: "" } });
        assert.match(
          result.stdout,
          /Attach from a terminal with: tmux (-CC )?new-session -t /,
          `an already-attached base must print the view-session chain, never a bare attach; stdout:\n${result.stdout}`,
        );
        assert.doesNotMatch(
          result.stdout,
          /tmux (-CC )?attach -t /,
          `must never print a plain second attach onto base while it already has a client; stdout:\n${result.stdout}`,
        );
      } finally {
        client.kill("SIGTERM");
        cleanup(session);
      }
    });
  },
);
