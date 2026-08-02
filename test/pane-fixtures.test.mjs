import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { REPO, isolateTmux, until } from "./helpers.mjs";

// Todo 68 / issues #27 and #30. paneAwaitingChoice and waitForPaneInput are
// both matched against claude's chrome, which is version-coupled and cannot be
// pinned by writing a screen by hand: a fixture nothing real produced is valid
// only because nothing real ever checked it, which is exactly how #30 went
// unnoticed (three tests pinned the announcement's CONTENT and never asked
// whether it was sent). These fixtures are captured byte-for-byte off a real
// claude 2.1.220 pane; see test/fixtures/panes/README.md for how and when.
const { hasTmux, cleanup } = isolateTmux("the pane fixture tests");

const { paneAwaitingChoice, waitForPaneInput, describePaneChoice } = await import("../dist/tmux.js");

const FIXTURES = join(REPO, "test", "fixtures", "panes");

const CASES = [
  { file: "ready-idle.txt", name: "ready", marker: "for agents", awaitingChoice: false, ready: true },
  { file: "folder-trust-dialog.txt", name: "trust", marker: "trust this folder", awaitingChoice: true, ready: false },
  { file: "model-picker-dialog.txt", name: "model", marker: "Select model", awaitingChoice: true, ready: false },
  { file: "busy-mid-turn.txt", name: "busy", marker: "lighthouse keeper", awaitingChoice: false, ready: true },
];

describe(
  "paneAwaitingChoice against real claude 2.1.220 screens",
  { skip: hasTmux ? false : "tmux is not installed" },
  () => {
    const session = `hive-panefixtures-${process.pid}`;

    before(() => {
      if (!hasTmux) return;
      CASES.forEach(({ file, name }, i) => {
        const fixture = join(FIXTURES, file);
        // cat replays the exact captured bytes into a fresh pane, then sleeps so
        // the screen stays put for capture-pane to read back; nothing here is
        // driven by a live claude, only the fixture text is.
        const cmd = `cat '${fixture}'; sleep 600`;
        if (i === 0) {
          execFileSync(
            "tmux",
            ["new-session", "-d", "-s", session, "-n", name, "-x", "220", "-y", "50", cmd],
            { stdio: "ignore" },
          );
        } else {
          execFileSync("tmux", ["new-window", "-d", "-t", `=${session}`, "-n", name, cmd], {
            stdio: "ignore",
          });
        }
      });
    });

    after(() => cleanup(session));

    for (const { name, marker, awaitingChoice } of CASES) {
      it(`reads ${name} as awaitingChoice=${awaitingChoice}`, async () => {
        const target = `${session}:${name}`;
        await until(() => execFileSync("tmux", ["capture-pane", "-p", "-t", target]).toString().includes(marker));

        assert.equal(paneAwaitingChoice(target), awaitingChoice);
      });
    }

    // Decision D3 on the plan pad: null (pane unreadable) is not the same
    // answer as false (pane readable, no dialog). A caller that conflated them
    // would treat a dead pane as safe to type into, which is the scheduler's
    // call to make, not paneAwaitingChoice's.
    it("answers null, not false, for a pane it cannot read", () => {
      const result = paneAwaitingChoice("%999999");
      assert.equal(result, null);
      assert.notEqual(result, false);
    });

    // Issue #30. This is the regression pin: before the fix, none of these
    // four screens matched waitForPaneInput's regex, so a real spawn timed
    // out on a pane that was already ready. ready/busy must read true or
    // agent_spawn goes back to announced:false on every healthy spawn; the
    // two dialog screens must read false, which is decision D4 -- the
    // readiness probe must not tell the announcement to type into a choice.
    for (const { name, ready } of CASES) {
      it(`waitForPaneInput reads ${name} as ready=${ready}`, async () => {
        const target = `${session}:${name}`;
        const result = await waitForPaneInput(target, ready ? 2000 : 700);
        assert.equal(result, ready);
      });
    }
  },
);

// Issue #72 fix round 2, item 1 (both counselors seats). No test in the
// suite referenced describePaneChoice directly; agent_list/doctor tests only
// ever observed "no dialog" or "awaiting a choice (dialog)", so this mutant
// survived the full suite:
//   describePaneChoice = (a) => a === true ? "awaiting a choice (dialog)" : "no dialog"
// which collapses the null branch into false and reverts the exact failure
// the function exists to fix: a pane that dies between liveTargets()'s
// snapshot and paneField's own capture-pane call reports awaitingChoice:null,
// and the collapsed version would have agent_list/doctor claim "no dialog"
// for a pane that was never actually read. A direct assertion on all three
// inputs is what makes that mutation impossible to pass unnoticed.
describe("describePaneChoice", () => {
  it("distinguishes all three states, null included", () => {
    assert.equal(describePaneChoice(true), "awaiting a choice (dialog)");
    assert.equal(describePaneChoice(false), "no dialog");
    assert.equal(describePaneChoice(null), "could not be read");
  });
});
