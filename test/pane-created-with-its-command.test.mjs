import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { clearHiveEnv, isolateTmux, recordingTmux, REPO, scratchDirs, tmux, tmuxCallsIn, withEnv } from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("the pane-creation tests");

const dirs = scratchDirs();
clearHiveEnv();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { claimInitialWindow, createWindow, ensureSession, envFlagKeys, panePid, sessionName } =
  await import("../dist/tmux.js");

const logDir = mkdtempSync(join(tmpdir(), "hive-panecreate-"));
const log = join(logDir, "tmux-calls.log");
const recorderDir = recordingTmux({ log });
after(() => {
  rmSync(logDir, { recursive: true, force: true });
  rmSync(recorderDir, { recursive: true, force: true });
});

const recorded = (fn) => {
  rmSync(log, { force: true });
  return withEnv({ PATH: `${recorderDir}:${process.env.PATH}` }, fn);
};
const verbs = () => tmuxCallsIn(log).map((argv) => argv[0]);
const callTo = (verb) => tmuxCallsIn(log).find((argv) => argv[0] === verb);
const startCommand = (pane) => tmux("display-message", "-p", "-t", pane, "#{pane_start_command}");
// The pane writes its probe file when the OS gets round to it, so read it only once it exists: a
// bare readFileSync here is a flake that reads as a failed assertion about the environment.
const probeFile = (path) => {
  const nap = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  for (let i = 0; i < 200 && !existsSync(path); i++) nap();
  assert.equal(existsSync(path), true, `the pane never wrote ${path}, so its command did not run`);
  return readFileSync(path, "utf8");
};

// The skip rides each it(), not the describe: a describe-level skip is absent from node --test's
// summary rather than counted in it, and ci.yml's skip budget can only see what is counted.
const needsTmux = hasTmux ? {} : { skip: "tmux is not installed" };

describe("hive never creates a pane it has to destroy", () => {
    it("ensureSession's own pane runs the command from birth, and the claim respawns nothing", needsTmux, () => {
      const session = `${sessionName()}-birth`;
      const out = join(logDir, "session-env");
      after(() => cleanup(session));

      const started = recorded(() =>
        ensureSession(session, dirs.projectDir, {
          envFlags: ["-e", "HIVE_PANE_PROBE=session"],
          command: `sh -c 'printf %s "$HIVE_PANE_PROBE" > ${out}; sleep 600'`,
        }),
      );
      assert.equal(started.created, true, "this session must be created by this call, not found");

      const bornAs = panePid(started.pane);
      recorded(() => claimInitialWindow(started, "mine", 1));

      assert.equal(
        panePid(started.pane),
        bornAs,
        "the pane must still be the process new-session started - respawn-pane gives a pane a NEW pid, so a " +
          "changed pid here means the login shell is back and something destroyed it",
      );
      assert.equal(verbs().includes("respawn-pane"), false, `the claim issued: ${verbs().join(", ")}`);
      assert.match(startCommand(started.pane), /HIVE_PANE_PROBE/, "the pane's start command is hive's own");
      assert.equal(probeFile(out), "session", "and -e reached the process it started");
    });

    it("createWindow's pane runs the command from birth, and respawns nothing", needsTmux, () => {
      const session = `${sessionName()}-window`;
      const out = join(logDir, "window-env");
      after(() => cleanup(session));

      ensureSession(session, dirs.projectDir, { envFlags: [], command: "sleep 600" });
      const made = recorded(() =>
        createWindow(
          session,
          "worker",
          dirs.projectDir,
          ["-e", "HIVE_PANE_PROBE=window"],
          `sh -c 'printf %s "$HIVE_PANE_PROBE" > ${out}; sleep 600'`,
          7,
          true,
        ),
      );

      assert.equal(verbs().includes("respawn-pane"), false, `createWindow issued: ${verbs().join(", ")}`);
      const created = callTo("new-window");
      assert.equal(
        created.at(-1).includes("HIVE_PANE_PROBE"),
        true,
        `new-window must carry the command as its last argument, got: ${created.join(" ")}`,
      );
      assert.match(startCommand(made.pane), /HIVE_PANE_PROBE/, "the pane's start command is hive's own");
      assert.equal(probeFile(out), "window", "and -e reached the process it started");
    });

    it("leaves none of hive's spawn variables at SESSION scope, where every project on the box would see them", needsTmux, () => {
      const session = `${sessionName()}-envscope`;
      const out = join(logDir, "envscope-later");
      after(() => cleanup(session));

      const envFlags = [
        "-e", "HIVE_AGENT_ID=lead:7",
        "-e", "HIVE_LEAD=1",
        "-e", "HIVE_PROJECT_LOCK=1",
        "-e", `HIVE_PROJECT_PATH=${dirs.projectDir}`,
      ];
      ensureSession(session, dirs.projectDir, { envFlags, command: "sleep 600" });

      const sessionEnv = tmux("show-environment", "-t", `=${session}`);
      for (const key of envFlagKeys(envFlags)) {
        assert.equal(
          new RegExp(`^${key}=`, "m").test(sessionEnv),
          false,
          `${key} is set on the shared session, so hive would hand it to every later bare pane: ${sessionEnv}`,
        );
      }

      // The second half, and the one that catches an unset that only LOOKS right: a pane made with no
      // -e of its own is what a human's `hive attach` window is, and it must not inherit the identity.
      createWindow(
        session,
        "later-bare",
        dirs.projectDir,
        [],
        `sh -c 'printf "[%s][%s]" "$HIVE_AGENT_ID" "$HIVE_PROJECT_PATH" > ${out}; sleep 600'`,
        7,
        true,
      );
      const seen = probeFile(out);
      assert.equal(seen.includes("lead:7"), false, `a later bare pane inherited this session's HIVE_AGENT_ID: ${seen}`);
      assert.equal(
        seen.includes(dirs.projectDir),
        false,
        `a later bare pane inherited this session's HIVE_PROJECT_PATH, which is how hive attach on one project ` +
          `hands a human a shell locked to another: ${seen}`,
      );
    });

    it("still stamps and configures the window it created, after the process is already live", needsTmux, () => {
      const session = `${sessionName()}-stamp`;
      after(() => cleanup(session));

      const started = ensureSession(session, dirs.projectDir, { envFlags: [], command: "sleep 600" });
      const { window, pane } = claimInitialWindow(started, "stamped", 42);

      assert.equal(tmux("show-options", "-w", "-v", "-t", window, "@hive-owned"), "1");
      assert.equal(tmux("show-options", "-w", "-v", "-t", window, "@hive-project-id"), "42");
      assert.equal(
        tmux("show-options", "-p", "-A", "-v", "-t", pane, "allow-passthrough"),
        "all",
        "a window option set AFTER its pane exists still reaches that pane - tmux resolves inheritance at " +
          "lookup time, which is what makes configuring the window after the command starts safe",
      );
      assert.equal(tmux("display-message", "-p", "-t", window, "#{window_name}"), "stamped");
    });

    it("hands back a session that tmux already destroyed when the command exits at once", needsTmux, () => {
      const session = `${sessionName()}-instant`;
      after(() => cleanup(session));

      const started = ensureSession(session, dirs.projectDir, { envFlags: [], command: "true" });
      assert.equal(started.created, true, "new-session still reports the pane and window it made");

      assert.throws(
        () => claimInitialWindow(started, "gone", 1),
        /no server running|can't find window|server exited/,
        "the claim is the caller's first news that the command it was given died on the spot; launchAgent " +
          "deletes its row and rethrows, so a spawn that cannot run fails loudly instead of recording a dead pane",
      );
    });

    it("leaves a live session standing when a LATER window's command exits at once", needsTmux, () => {
      const session = `${sessionName()}-instant-window`;
      after(() => cleanup(session));

      const first = ensureSession(session, dirs.projectDir, { envFlags: [], command: "sleep 600" });
      const made = createWindow(session, "doomed", dirs.projectDir, [], "true", 7, true);

      assert.equal(typeof made.pane, "string", "new-window still reports the pane it made");
      assert.doesNotThrow(
        () => tmux("has-session", "-t", `=${session}`),
        "the session survives, because the exiting command took only its own window with it",
      );
      const windows = tmux("list-windows", "-t", `=${session}`, "-F", "#{session_name}:#{window_id}").split("\n");
      assert.deepEqual(windows, [first.window], "and only the window whose command exited is gone");
    });
});

// Every place in src/ that asks tmux for a pane, and what it hands that pane to run. A new entry
// here is a new chance to create a bare login shell hive then destroys, so this list is the review
// prompt: the test fails until whoever added the call site says which kind it is.
const PANE_CREATION_SITES = [
  ["src/cli.ts", "new-window", "hive attach's project window - DELIBERATELY BARE, and nothing destroys it"],
  ["src/cli.ts", "split-window", "carries leadCommand"],
  ["src/spawn.ts", "split-window", "splitInto, used by placement split and placement processes - carries commandString"],
  ["src/tmux.ts", "new-session", "ensureSession - carries initial.command on every claiming path"],
  ["src/tmux.ts", "new-session", "a GROUPED view session (-t), which shares windows and forks nothing"],
  ["src/tmux.ts", "new-session", "a GROUPED view session (-t), which shares windows and forks nothing"],
  ["src/tmux.ts", "new-window", "createWindow - carries command"],
];

describe("the inventory of places hive asks tmux for a pane", () => {
  it("has not grown or moved without someone saying what the new pane runs", () => {
    const sources = (dir) =>
      readdirSync(join(REPO, dir), { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory() ? sources(`${dir}/${entry.name}`) : entry.name.endsWith(".ts") ? [`${dir}/${entry.name}`] : [],
      );
    const scanned = sources("src");
    assert.ok(
      scanned.includes("src/tools/agents.ts"),
      `the scan must descend into src/tools, which .claude/rules/tmux-and-panes.md governs; it saw ${scanned.length} files`,
    );
    const found = [];
    for (const file of scanned) {
      const source = readFileSync(join(REPO, file), "utf8");
      for (const verb of ["new-session", "new-window", "split-window"]) {
        for (const _ of source.matchAll(new RegExp(`"${verb}"`, "g"))) found.push([file, verb]);
      }
    }
    assert.deepEqual(
      found.sort(),
      PANE_CREATION_SITES.map(([file, verb]) => [file, verb]).sort(),
      "a pane-creating call site appeared, moved or vanished; add it to PANE_CREATION_SITES with what it " +
        "runs, and read .claude/rules/tmux-and-panes.md before you make it a bare one",
    );
  });
});
