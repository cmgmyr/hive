import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { describe, it } from "node:test";

import { isolateTmux, runCli, scratchDirs, sleep, tmux, withEnv } from "./helpers.mjs";

// Issue #81. controlModeFor() is pure and reads storeDir()/config.json at
// call time (same reasoning as config.ts and dataDir.ts), so setting
// HIVE_DATA_DIR per case is enough; no subprocess is needed for it.
// attachScripts() no longer is (issue #117 counselors): it now probes the
// real tmux server through freeViewSessionName's has-session check before
// naming a view, so its cases need isolateTmux()'s isolation below even
// though they never assert on a live tmux server directly - a bare `tmux`
// call still needs somewhere safe to land. The CLI-level cases at the bottom
// need a subprocess AND a private tmux server for a different reason:
// cmdAttach's non-TTY branch is only reachable through a real "hive attach"
// invocation.
const { hasTmux, cleanup } = isolateTmux("attach mode (issue #81)");

process.env.HIVE_DATA_DIR = scratchDirs().dataDir;
const { resolvedAttachMode, setAttachMode } = await import("../dist/config.js");
const { attachScripts, controlModeFor, createWindow, ensureSession, sessionName, viewSessionName } = await import(
  "../dist/tmux.js"
);

// Auto-attach's own behaviour lives in test/auto-attach-scope.test.mjs, which
// drives ensureAttached against fake tmux and osascript binaries. It used to
// live here as three assertions against a pure helper plus a regex over
// src/tmux.ts's source text; see that file's header for why none of them could
// fail when the behaviour regressed.

// HIVE_ATTACH_MODE is a one-off testing override; withEnv restores it after
// every case that sets it so a later, unrelated case does not inherit it.
const withEnvAttachMode = (value, fn) => withEnv({ HIVE_ATTACH_MODE: value }, fn);

// FOUND BY CI ON PR #132, one red macOS leg against a diff that could not have
// caused it. The two negative assertions over CLI stdout below were
// `doesNotMatch(stdout, /-CC/)`, and `hive attach` prints the project's own
// path in its first line, so the regex was reading the SCRATCH DIRECTORY NAME:
//
//   'Session ... for project "project-wBTbTT" (/T/hive-test-CC2fL1/project-wBTbTT).
//    Attach from a terminal with: tmux new-session -t ...'
//
// `scratchDirs()` builds that root with `mkdtemp(tmpdir() + "hive-test-")`,
// whose six random characters are drawn from a set that includes upper case,
// so roughly one run in a few thousand produces a suffix starting "CC" and
// this test fails on the name alone. Latent since it was written; nothing to
// do with control mode, and no `-CC` flag anywhere in that output.
//
// WHY A TOKEN TEST RATHER THAN A NARROWER REGEX. The obvious repair is to
// copy the positive assertions and look for /-CC new-session/, and that trades
// a false red for a FALSE GREEN, which is the worse direction and the one this
// project keeps re-shipping: `-CC` also legitimately precedes `attach` (see
// the already-attached case near the bottom of this file, which matches
// /tmux (-CC )?attach -t /), so a negative scoped to new-session would stop
// catching a `-CC attach` regression entirely and say nothing.
//
// Splitting on whitespace and asking for an exact token is immune to whatever
// the path contains, because a path is one token and can never equal "-CC" -
// it is absolute, so it always carries a "/". It catches the flag in every
// position it can appear, including ones nobody has written a test for yet,
// which is the property a NEGATIVE assertion needs: it is asserting the
// absence of something, so it must not depend on knowing where it would be.
// Pinned by its own cases in "the -CC negative assertion itself" below, which
// need no tmux and no subprocess.
const CONTROL_MODE_FLAG = "-CC";

const carriesControlModeFlag = (output) => output.split(/\s+/).includes(CONTROL_MODE_FLAG);

const assertNoControlModeFlag = (output, what) =>
  assert.equal(
    carriesControlModeFlag(output),
    false,
    `${what} must not carry the ${CONTROL_MODE_FLAG} flag as its own argument; output was:\n${output}`,
  );

describe("the -CC negative assertion itself", () => {
  // The reproduction, kept as a fixture rather than as a story: this is the
  // real stdout from the CI failure's shape, with the scratch path that broke
  // it. `/-CC/` matches this string; the token test must not.
  const STDOUT_WITH_CC_IN_THE_SCRATCH_PATH =
    'Session hive-main is ready for project "project-uScUZM" (/private/tmp/hive-test-CC2fL1/project-uScUZM).\n' +
    "Attach from a terminal with: tmux new-session -t '=hive-main' -s hive-view-13169 ';' set-option -t hive-view-13169 destroy-unattached on\n";

  it("ignores -CC inside a path component, which is what made this flake", () => {
    assert.match(STDOUT_WITH_CC_IN_THE_SCRATCH_PATH, /-CC/, "the old assertion really did match this");
    assert.equal(carriesControlModeFlag(STDOUT_WITH_CC_IN_THE_SCRATCH_PATH), false);
  });

  // BOTH positions, because a negative that only knew about one of them would
  // be a false green rather than a false red. These are the two subcommands
  // the flag is ever printed in front of.
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

// Issue #117. attachScripts used to embed a plain `attach -t hive-1`, so two
// auto-attaches racing each other both landed a client on hive-1 itself.
// viewSessionName() is pid-tagged, and this test process's pid is fixed for
// the whole run, so the expected view name is computed once rather than
// pinned as a literal - a literal here would silently stop discriminating
// the moment the pid tag format changed elsewhere.
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
    // M1 (pad 80): reverting either script back to a plain `attach -t hive-1`
    // must fail here, since neither string would match the assertions above.
    assert.doesNotMatch(iterm, /\bmux attach -t hive-1"/);
    assert.doesNotMatch(terminal, /\bmux attach -t hive-1"/);
  });

  it("sets destroy-unattached on the view, not on base", () => {
    // M3 (pad 80): dropping destroy-unattached from the emitted chain must
    // fail this - it is what keeps a stray view from outliving its client
    // (todo 273's stray-view report; pad 80 decision 3).
    //
    // Issue #117 counselors, F2. A doesNotMatch against the literal passed-in
    // session ("hive-1") used to sit here too, meant to prove the option
    // never lands on base. Deleted: v (viewSessionName()'s own output)
    // always ends "view-<pid>" and can never literally render as "hive-1",
    // so no mutation of this code could ever make that assertion fail - and
    // the exact-string equality test above already pins destroy-unattached's
    // target as v, not session, which is the only way that could go wrong.
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

  // M2 (pad 80) is void, recorded rather than faked. Measured on this machine
  // (see the comment above attachScripts, src/tmux.ts): despite running with
  // no shell, iTerm's own command tokenizer strips single quotes and groups
  // quoted spans exactly like a POSIX shell, and never treats a bare `;`
  // specially either way, so renderAttachCommand's quoting does not need to
  // differ between the two branches - there is no branch-specific quoting
  // left to pin a test on. The only real difference between the two scripts
  // is -CC, already covered by the three cases above.
});

// Issue #117 counselors, F1. Both review seats independently refuted the
// pid-collision reasoning attachScripts' comment used to carry: a pid cannot
// collide with ANOTHER pid, but ensureAttached runs once per agent_spawn
// inside the long-lived MCP server (one pid for its whole life), so a SECOND
// spawn can find the FIRST spawn's own view still alive and try to recreate
// it under the identical name. Reproduced here directly: pre-create the
// session viewSessionName() would hand back for this test process's own pid,
// then confirm attachScripts bumps past it instead of colliding.
describe(
  "attachScripts avoids a live view collision (issue #117 counselors)",
  { skip: hasTmux ? false : "tmux is not installed" },
  () => {
    it("bumps past a view session this same pid already left running", () => {
      process.env.HIVE_DATA_DIR = scratchDirs().dataDir;
      const session = sessionName();
      const firstView = viewSessionName();
      ensureSession(session, process.cwd());
      // Grouped with base, matching the exact shape the real chain creates -
      // a stray plain session named the same would not exercise the same
      // has-session probe attachScripts actually runs.
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

// Issue #117 counselors. A two-process race fixture for attachScripts lived
// in test/attach-view-race.test.mjs for three CI rounds and flaked on
// alternating ubuntu legs each time - round 2 red on node 22 and green on
// node 24, round 3 the opposite, same commit shape, no product change
// between rounds. The failure was the child dying at process startup
// (empty stdout, exit 1, well under half a second), never an assertion
// about base clients - harness instability, not the concurrency property
// finding anything. It was cut deliberately rather than chased further: the
// invariant it asserted is ORDER-INSENSITIVE (counselors, opus), so a
// single process proves the same thing a race would, and what the race
// fixture actually added beyond M1-M3 above was reading LIVE tmux state
// instead of the emitted string - which is what this test keeps. The
// sibling race block for resolveAttachTarget in attach-view-race.test.mjs
// predates this lane, was never the one flaking, and is untouched. Do not
// rebuild the attachScripts race fixture on the strength of this comment
// alone; it did not hold still across three real attempts.
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
      // -C, not the product's own -CC: the transport that lets a headless
      // client exist with no tty, orthogonal to what is under test (the
      // sibling race block's own comment makes the identical point).
      const withDashC = shellCmd.replace(tmuxPath, tmuxPath + " -C");
      // zsh when it exists, else sh - the leading-'=' EQUALS-expansion trap
      // renderAttachCommand quotes for is a zsh behaviour and invisible to
      // sh, but every other property this test checks is shell-agnostic.
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
        // show-options' -t does not accept the "=" exact-match form other
        // targets in this file use (measured against a real, live,
        // client-attached view where has-session/list-clients/list-windows
        // all succeed with it) - bare here, deliberately.
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
      // Todo 294. sessionName() reads process.env.HIVE_DATA_DIR in THIS
      // process, not the runCli child's own env (that gets it only via
      // opts.dataDir below) - every sibling case in this file sets it here
      // before computing session for exactly that reason. Omitting it left
      // `session` computed against whatever the previous case's assignment
      // happened to leave behind, so cleanup(session) below killed the wrong
      // name and the real session (and its server) outlived the file.
      process.env.HIVE_DATA_DIR = dirs.dataDir;
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
      // No `hive setup --attach` yet (issue #81 step 3): write the config the
      // same way that command will, by calling setAttachMode against the same
      // store the child process resolves.
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
