import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { DIST, isolateTmux, raceProcesses, scratchDirs, tmux } from "./helpers.mjs";

// Todo 278 (counselors codex #1), the most destructive finding of its round.
//
// claimInitialWindow used to find "the initial window" with
// `list-panes -t =<session>`, which resolves the session's CURRENT window
// rather than the one the caller created - and `new-window` makes its result
// current. Project A creates the session; project B creates and stamps its own
// window in it before A gets to the claim; A's lookup then resolves B's
// window, A overwrites B's stamp and runs `respawn-pane -k`, KILLING LEAD B
// and putting lead A in its place. Both lead rows then name one pane, and B's
// liveness probe succeeds because that pane is alive, so B's sends and wakes
// go to A.
//
// WHAT THIS FILE CAN AND CANNOT PIN, stated rather than implied. The
// interleaving itself is no longer reachable between two hive processes on one
// store: todo 277's withWindowClaim serializes ensureSession and the claim
// together, so an end-to-end race between two `hive lead` runs would now pass
// with this fix reverted, for the other fix's reasons. A test that cannot fail
// for its own reason is worth less than no test (test/CLAUDE.md), so the first
// describe below pins the MECHANISM deterministically instead: the claim
// targets the ids it was handed, with another project's window sitting there
// as the current one. That is what stays true no matter who else is holding
// the lock - a human running `tmux new-window` in hive's session takes no lock
// at all.
//
// The second describe covers ensureSession's own check-then-act directly,
// racing real processes against it rather than against any caller. Pad 79
// T5(b) put the last caller that reached it unguarded (`hive attach`) inside
// withWindowClaim too, so every production call now serializes through that
// exclusion and this race is no longer reachable end to end through any of
// them - see ensureSession's own comment (src/tmux.ts) for why the handling
// stays regardless: it is defence in depth for a future call site added
// outside a withWindowClaim section, and this file is what keeps it tested
// on its own rather than only through callers that can no longer exercise it.

const { hasTmux, cleanup } = isolateTmux("the initial-window claim tests");

const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const {
  claimInitialWindow,
  createWindow,
  ensureSession,
  isDuplicateSession,
  sessionName,
  // hive's own tmux wrapper, deliberately, for the one assertion below that
  // is ABOUT its error type: the raw execFileSync helper throws a plain
  // Error, and isDuplicateSession takes a TmuxError. Everything else in this
  // file checks hive's work with the suite's independent tmux() instead.
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
      start = ensureSession(session, dirA);
      assert.equal(start.created, true, "this session must be created by this call, not found");

      // The other project arrives between the session's creation and the
      // claim, exactly as codex's interleaving describes: its window is
      // stamped for a different project and, because new-window makes its
      // result current, it is what "the current window" now resolves to.
      intruder = createWindow(session, "other", dirB, [], "sleep 611", OTHER_PROJECT);
    });

    after(() => cleanup(session));

    it("leaves the intruder's window CURRENT, so the old lookup would resolve to it (fixture check)", () => {
      // Without this the test could pass against the old code purely because
      // new-window did not move the session's current window - the fixture
      // would then be reproducing nothing and every assertion below would be
      // vacuous.
      // list-windows, not `display-message -t =<session>`: that answered
      // empty here, and .claude/rules/tmux-and-panes.md already records that
      // display-message falls back silently rather than failing on a target
      // it cannot resolve.
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

    it("respawns into its own pane and window, not the current one", () => {
      const claimed = claimInitialWindow(start, "mine", dirA, [], "sleep 600", 1);
      assert.equal(claimed.pane, start.pane, "the claimed pane is the one ensureSession created");
      assert.equal(claimed.window.split(":")[1], start.window.split(":")[1], "and so is its window");
      assert.match(startCommand(claimed.pane), /sleep 600/, "the claim's own command is running in that pane");
    });

    it("does not kill the other project's lead or take its ownership stamp", () => {
      assert.match(
        startCommand(intruder.pane),
        /sleep 611/,
        "the other project's pane must still be running ITS command - respawn-pane -k in that pane is the lead " +
          "this finding kills, and the pane id survives a respawn, so the command is the only witness",
      );
      assert.equal(
        windowOwner(intruder.window),
        OTHER_PROJECT,
        "the other project's window must still carry its own @hive-project-id",
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
      // A hand-built TmuxError would only prove the regex matches the string
      // this test wrote. The point is the string TMUX writes, which is the
      // half that can rot under a tmux upgrade.
      const solo = `${session}-solo`;
      tmux("new-session", "-d", "-s", solo, "-c", dirs.tmp);
      try {
        assert.throws(
          () => hiveTmux("new-session", "-d", "-s", solo, "-c", dirs.tmp),
          (e) => isDuplicateSession(e),
          "tmux's duplicate-session error must be recognised as one",
        );
        // The control: any OTHER tmux failure must NOT read as a duplicate,
        // or ensureSession would swallow real failures as lost races.
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
      // Static imports are hoisted ABOVE raceProcesses' barrier, so both
      // children finish loading dist/ before either one starts spinning and
      // they reach ensureSession within microseconds of each other. Two calls
      // in one process would prove nothing here: the first would always
      // complete before the second began.
      const script = `
import { ensureSession } from ${JSON.stringify(join(DIST, "tmux.js"))};
const [session, cwd] = process.argv.slice(2);
const started = ensureSession(session, cwd);
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
