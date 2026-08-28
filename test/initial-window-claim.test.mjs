import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { DIST, isolateTmux, raceProcesses, scratchDirs, tmux } from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("the initial-window claim tests");

const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const {
  claimInitialWindow,
  createWindow,
  ensureSession,
  isDuplicateSession,
  sessionName,

  tmux: hiveTmux,
  windowOwner,
} = await import("../dist/tmux.js");

const OTHER_PROJECT = 99;
const startCommand = (pane) => tmux("display-message", "-p", "-t", pane, "#{pane_start_command}");

describe(
  "claimInitialWindow claims the window it was handed, never whichever one is current",
  { skip: hasTmux ? false : "tmux is not installed" },
  () => {
    const session = `${sessionName()}-claim`;
    const dirA = mkdtempSync(join(dirs.tmp, "claim-a-"));
    const dirB = mkdtempSync(join(dirs.tmp, "claim-b-"));
    let start;
    let intruder;

    before(() => {
      start = ensureSession(session, dirA, { envFlags: [], command: "sleep 600" });
      assert.equal(start.created, true, "this session must be created by this call, not found");

      intruder = createWindow(session, "other", dirB, [], "sleep 611", OTHER_PROJECT);
    });

    after(() => cleanup(session));

    it("leaves the intruder's window CURRENT, so the old lookup would resolve to it (fixture check)", () => {

      const current = tmux("list-windows", "-t", `=${session}`, "-F", "#{window_active} #{window_id}")
        .split("\n")
        .find((row) => row.startsWith("1 "))
        ?.slice(2);
      assert.equal(
        current,
        intruder.window.split(":")[1],
        "new-window must make its own window current for this fixture to reproduce the finding",
      );
    });

    it("claims its own pane and window, not the current one", () => {
      const claimed = claimInitialWindow(start, "mine", 1);
      assert.equal(claimed.pane, start.pane, "the claimed pane is the one ensureSession created");
      assert.equal(claimed.window.split(":")[1], start.window.split(":")[1], "and so is its window");
      assert.match(startCommand(claimed.pane), /sleep 600/, "the claim's own command is running in that pane");
    });

    it("does not kill the other project's lead or take its ownership stamp", () => {
      assert.match(
        startCommand(intruder.pane),
        /sleep 611/,
        "the other project's pane must still be running ITS command - that pane is the lead this finding kills",
      );
      assert.equal(
        windowOwner(intruder.window),
        OTHER_PROJECT,
        "the other project's window must still carry its own @hive-project-id",
      );
      assert.equal(
        tmux("display-message", "-p", "-t", intruder.window, "#{window_name}"),
        "other",
        "and must still carry its own name - the rename is the live witness now that the claim respawns nothing",
      );
    });
  },
);

describe(
  "ensureSession's check-then-act absorbs a lost race instead of dying on it",
  { skip: hasTmux ? false : "tmux is not installed" },
  () => {
    const session = `${sessionName()}-race`;

    after(() => cleanup(session));

    it("pins tmux's own duplicate-session wording against a REAL error", () => {

      const solo = `${session}-solo`;
      tmux("new-session", "-d", "-s", solo, "-c", dirs.tmp);
      try {
        assert.throws(
          () => hiveTmux("new-session", "-d", "-s", solo, "-c", dirs.tmp),
          (e) => isDuplicateSession(e),
          "tmux's duplicate-session error must be recognised as one",
        );

        assert.throws(
          () => hiveTmux("kill-window", "-t", "@nosuchwindow"),
          (e) => !isDuplicateSession(e),
          "an unrelated tmux failure must not read as a duplicate session",
        );
      } finally {
        cleanup(solo);
      }
    });

    it("two processes creating the same session concurrently both succeed, and exactly one creates it", async () => {

      const script = `
import { ensureSession } from ${JSON.stringify(join(DIST, "tmux.js"))};
const [session, cwd] = process.argv.slice(2);
const started = ensureSession(session, cwd, { bare: true });
console.log(JSON.stringify({ created: started.created }));
`;
      const results = await raceProcesses(
        script,
        [
          [session, dirs.tmp],
          [session, dirs.tmp],
        ],
        { env: { HIVE_DATA_DIR: dirs.dataDir, TMUX_TMPDIR: process.env.TMUX_TMPDIR } },
      );
      assert.equal(
        results.filter((r) => r.created).length,
        1,
        `exactly one process may report creating the session, got ${JSON.stringify(results)}`,
      );
    });
  },
);
