import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isolateTmux, runCli, scratchDirs, withEnv } from "./helpers.mjs";

// Issue #81. controlModeFor() and attachScripts() are pure and read
// storeDir()/config.json at call time (same reasoning as config.ts and
// dataDir.ts), so setting HIVE_DATA_DIR per case is enough; no subprocess is
// needed for those. The CLI-level cases at the bottom do need a subprocess
// and a private tmux server, since cmdAttach's non-TTY branch is only
// reachable through a real "hive attach" invocation.
const { hasTmux, cleanup } = isolateTmux("attach mode (issue #81)");

process.env.HIVE_DATA_DIR = scratchDirs().dataDir;
const { resolvedAttachMode, setAttachMode } = await import("../dist/config.js");
const { attachScripts, controlModeFor, sessionName } = await import("../dist/tmux.js");

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
      const session = sessionName(1);
      try {
        const iterm = await runCli(["attach"], { ...opts, env: { TERM_PROGRAM: "iTerm.app" } });
        assert.match(iterm.stdout, /Attach from a terminal with: tmux -CC attach -t /);

        const plain = await runCli(["attach"], { ...opts, env: { TERM_PROGRAM: "" } });
        assert.match(plain.stdout, /Attach from a terminal with: tmux attach -t /);
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
      const session = sessionName(1);
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
      const session = sessionName(1);
      try {
        const result = await runCli(["attach"], { ...opts, env: { TERM_PROGRAM: "" } });
        assert.match(result.stdout, /-CC attach/);
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
      const session = sessionName(1);
      try {
        const result = await runCli(["attach"], {
          ...opts,
          env: { TERM_PROGRAM: "", HIVE_ATTACH_MODE: "control" },
        });
        assert.match(result.stdout, /-CC attach/, "the override, not the stored raw, must win");
      } finally {
        cleanup(session);
      }
    });
  },
);
