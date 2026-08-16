import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { describe, it } from "node:test";

import { isolateTmux, runCli, scratchDirs, sleep, tmux, withEnv } from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("attach mode (issue #81)");

process.env.HIVE_DATA_DIR = scratchDirs().dataDir;
const { resolvedAttachMode, setAttachMode } = await import("../dist/config.js");
const { attachScripts, controlModeFor, createWindow, ensureSession, sessionName, viewSessionName } = await import(
  "../dist/tmux.js"
);

const withEnvAttachMode = (value, fn) => withEnv({ HIVE_ATTACH_MODE: value }, fn);

const CONTROL_MODE_FLAG = "-CC";

const carriesControlModeFlag = (output) => output.split(/\s+/).includes(CONTROL_MODE_FLAG);

const assertNoControlModeFlag = (output, what) =>
  assert.equal(
    carriesControlModeFlag(output),
    false,
    `${what} must not carry the ${CONTROL_MODE_FLAG} flag as its own argument; output was:\n${output}`,
  );

describe("the -CC negative assertion itself", () => {

  const STDOUT_WITH_CC_IN_THE_SCRATCH_PATH =
    'Session hive-main is ready for project "project-uScUZM" (/private/tmp/hive-test-CC2fL1/project-uScUZM).\n' +
    "Attach from a terminal with: tmux new-session -t '=hive-main' -s hive-view-13169 ';' set-option -t hive-view-13169 destroy-unattached on\n";

  it("ignores -CC inside a path component, which is what made this flake", () => {
    assert.match(STDOUT_WITH_CC_IN_THE_SCRATCH_PATH, /-CC/, "the old assertion really did match this");
    assert.equal(carriesControlModeFlag(STDOUT_WITH_CC_IN_THE_SCRATCH_PATH), false);
  });

  for (const [what, line] of [
    ["new-session", "Attach from a terminal with: tmux -CC new-session -t '=hive-main' -s hive-view-1\n"],
    ["attach", "Attach from a terminal with: tmux -CC attach -t '=hive-main'\n"],
  ]) {
    it(`still catches a real -CC before ${what}`, () => {
      assert.equal(carriesControlModeFlag(line), true);
      assert.throws(() => assertNoControlModeFlag(line, "this"), /must not carry the -CC flag/);
    });
  }
});

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

      assert.equal(controlModeFor(false), true);
    });

    assert.deepEqual(resolvedAttachMode(), { mode: "raw", source: "config" });
  });

  it("falls through to config, then detection, when unset or unknown", () => {
    process.env.HIVE_DATA_DIR = scratchDirs().dataDir;
    assert.deepEqual(resolvedAttachMode(), { mode: "auto", source: "detection" });
    withEnvAttachMode("not-a-real-mode", () => {

      assert.deepEqual(resolvedAttachMode(), { mode: "auto", source: "detection" });
    });
  });
});

describe("attachScripts (ensureAttached's AppleScript)", () => {
  const view = () => viewSessionName();

  it("auto: both scripts route through a view session grouped with base, never a bare attach", () => {
    process.env.HIVE_DATA_DIR = scratchDirs().dataDir;
    const [iterm, terminal] = attachScripts("/opt/homebrew/bin/tmux", "hive-1");
    const v = view();
    assert.equal(
      iterm,
      `tell application "iTerm" to create window with default profile command "/opt/homebrew/bin/tmux -CC new-session -t '=hive-1' -s ${v} ';' set-option -t ${v} destroy-unattached on"`,
    );
    assert.equal(
      terminal,
      `tell application "Terminal" to do script "/opt/homebrew/bin/tmux new-session -t '=hive-1' -s ${v} ';' set-option -t ${v} destroy-unattached on"`,
    );

  });

  it("sets destroy-unattached on the view, not on base", () => {

    process.env.HIVE_DATA_DIR = scratchDirs().dataDir;
    const [iterm, terminal] = attachScripts("/opt/homebrew/bin/tmux", "hive-1");
    const v = view();
    for (const script of [iterm, terminal]) {
      assert.match(script, new RegExp(`set-option -t ${v} destroy-unattached on`));
    }
  });

  it("raw drops -CC from the iTerm script but keeps the app", () => {
    process.env.HIVE_DATA_DIR = scratchDirs().dataDir;
    setAttachMode("raw");
    const [iterm, terminal] = attachScripts("/opt/homebrew/bin/tmux", "hive-1");

    assert.doesNotMatch(iterm, /-CC/);
    assert.match(iterm, /create window with default profile command "\/opt\/homebrew\/bin\/tmux new-session/);
    assert.doesNotMatch(terminal, /-CC/);
  });

  it("control keeps -CC, unchanged from auto for this site", () => {
    process.env.HIVE_DATA_DIR = scratchDirs().dataDir;
    setAttachMode("control");
    const [iterm] = attachScripts("/opt/homebrew/bin/tmux", "hive-1");
    assert.match(iterm, /-CC new-session/);
  });

});

describe(
  "attachScripts avoids a live view collision (issue #117 counselors)",
  { skip: hasTmux ? false : "tmux is not installed" },
  () => {
    it("bumps past a view session this same pid already left running", () => {
      process.env.HIVE_DATA_DIR = scratchDirs().dataDir;
      const session = sessionName();
      const firstView = viewSessionName();
      ensureSession(session, process.cwd());

      tmux("new-session", "-d", "-t", `=${session}`, "-s", firstView);
      try {
        const [, terminal] = attachScripts("/opt/homebrew/bin/tmux", session);

        assert.doesNotMatch(
          terminal,
          new RegExp(`-s ${firstView} `),
          `must not reuse ${firstView}, which is still a live session; got: ${terminal}`,
        );
        assert.match(
          terminal,
          new RegExp(`-s ${firstView}-2 `),
          `must bump to ${firstView}-2, the first free name; got: ${terminal}`,
        );
      } finally {
        cleanup(session, firstView, `${firstView}-2`);
      }
    });
  },
);

describe(
  "attachScripts' live tmux behaviour (issue #117 counselors, replacing a flaked race fixture)",
  { skip: hasTmux ? false : "tmux is not installed" },
  () => {
    it("puts a real client on its own view, grouped with base, with destroy-unattached in effect", async () => {
      process.env.HIVE_DATA_DIR = scratchDirs().dataDir;
      const session = `${sessionName()}-live`;
      ensureSession(session, process.cwd());
      createWindow(session, "live", process.cwd(), [], "sleep 600", null);
      const tmuxPath = execFileSync("which", ["tmux"], { encoding: "utf8" }).trim();
      const [, terminalScript] = attachScripts(tmuxPath, session);
      const shellCmd = terminalScript.match(/^tell application "Terminal" to do script "(.+)"$/)[1];
      const myView = shellCmd.match(/-s (\S+)/)?.[1];
      assert.ok(myView, `attachScripts must name a view session; got: ${shellCmd}`);

      const withDashC = shellCmd.replace(tmuxPath, tmuxPath + " -C");

      const shellPath = existsSync("/bin/zsh") ? "/bin/zsh" : "/bin/sh";
      const client = spawn(withDashC, { shell: shellPath, stdio: ["pipe", "pipe", "pipe"] });
      const clientsOn = (target) => {
        try {
          return tmux("list-clients", "-t", `=${target}`, "-F", "#{client_session}");
        } catch (e) {
          if (/can't find session|no such session/i.test(String(e.stderr ?? e.message ?? e))) return "";
          throw e;
        }
      };
      try {
        for (const deadline = Date.now() + 8000; Date.now() < deadline && clientsOn(myView) === ""; ) {
          await sleep(50);
        }
        assert.equal(clientsOn(session), "", "no client must land on the base session");
        assert.equal(clientsOn(myView), myView, "the client must be on its own view");

        assert.equal(
          tmux("show-options", "-t", myView, "-v", "destroy-unattached"),
          "on",
          "destroy-unattached must actually be set on the live view, not merely asked for in the emitted string",
        );
        const baseWindows = tmux("list-windows", "-t", `=${session}`, "-F", "#{window_id}");
        const viewWindows = tmux("list-windows", "-t", `=${myView}`, "-F", "#{window_id}");
        assert.equal(viewWindows, baseWindows, "the view must show base's own windows, proving it is grouped");
      } finally {
        client.kill("SIGTERM");
        cleanup(session, myView);
      }
    });
  },
);

describe(
  "hive attach's non-TTY hint honours the stored mode",
  { skip: hasTmux ? false : "tmux is not installed" },
  () => {
    it("auto follows TERM_PROGRAM, byte-identical to today when no config file exists", async () => {
      const dirs = scratchDirs();
      const opts = { cwd: dirs.projectDir, dataDir: dirs.dataDir, tmp: dirs.tmp };
      const init = await runCli(["init"], opts);
      assert.equal(init.code, 0, init.stderr);

      process.env.HIVE_DATA_DIR = dirs.dataDir;
      const session = sessionName();
      try {

        const iterm = await runCli(["attach"], { ...opts, env: { TERM_PROGRAM: "iTerm.app" } });
        assert.match(iterm.stdout, /Attach from a terminal with: tmux -CC new-session -t /);

        const plain = await runCli(["attach"], { ...opts, env: { TERM_PROGRAM: "" } });
        assert.match(plain.stdout, /Attach from a terminal with: tmux new-session -t /);
        assertNoControlModeFlag(plain.stdout, "a non-iTerm terminal under auto");
      } finally {
        cleanup(session);
      }
    });

    it("raw never prints -CC, even under iTerm", async () => {
      const dirs = scratchDirs();
      const opts = { cwd: dirs.projectDir, dataDir: dirs.dataDir, tmp: dirs.tmp };
      const init = await runCli(["init"], opts);
      assert.equal(init.code, 0, init.stderr);

      process.env.HIVE_DATA_DIR = dirs.dataDir;
      setAttachMode("raw");
      const session = sessionName();
      try {
        const result = await runCli(["attach"], { ...opts, env: { TERM_PROGRAM: "iTerm.app" } });
        assertNoControlModeFlag(result.stdout, "raw mode, even under iTerm");
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
