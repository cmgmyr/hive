import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
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
  // Todo 392. An ordinary tool-permission prompt renders a bordered PREVIEW
  // of the pending change, and that box's own closing border is `╰` -- the
  // same glyph INPUT_BOX_PRESENT counted as proof the input box (not a
  // dialog) is on screen. Before D1, this reads awaitingChoice=false and
  // ready=true: the dialog's own chrome proves there is no dialog.
  {
    file: "tool-permission-prompt.txt",
    name: "t392prompt",
    marker: "Esc to cancel",
    awaitingChoice: true,
    ready: false,
  },
  // Todo 392, D2. Manual (`default`) permission mode's footer reads "manual
  // mode on" with no "(shift+tab to cycle)" -- the only mode that drops it --
  // and this screen carries no `╰` either. Captured after a warm-up turn;
  // see the fixture README for what that warm-up does and does not protect
  // against (round 2 review corrected the original reasoning -- the banner's
  // `╰` was never inside capturePane()'s real trim-then-slice window even
  // without it, only inside the RAW `capture-pane -S -N` output a naive
  // reading of tailCaptureLines() would expect). Before D2, ready reads
  // false on a pane that is, in fact, perfectly ready. INPUT_BOX_PRESENT's
  // marker for this screen is "mode on" as of round 2 (M1: "manual mode on"
  // alone did not survive narrow-pane truncation testing the way "mode on"
  // does), matched below via its own substring.
  //
  // Todo 392 round 1 review (F8/opus 5): this fixture carries no
  // CHOICE_DIALOG alternative either way, so its `awaitingChoice: false`
  // row cannot fail against a mutation to the INPUT_BOX_PRESENT half - the
  // `ready: true` row below it is the one that actually dies against D2's
  // mutation, and is the only reason this fixture is here.
  {
    file: "manual-mode-idle.txt",
    name: "t392manual",
    marker: "manual mode on",
    awaitingChoice: false,
    ready: true,
  },
  // Todo 392, D3. The plan-approval dialog renders no "Esc to cancel" at
  // all, so CHOICE_DIALOG missed it outright. Round 2 (M2) replaced the
  // original "Would you like to proceed" alternative with "ctrl+g to edit
  // in" -- the dialog's own chrome rather than its prose, measured stable
  // across two different $EDITOR configurations. Before D3, awaitingChoice
  // reads false with no INPUT_BOX_PRESENT involvement whatsoever.
  //
  // Todo 392 round 1 review (F8/opus 5): the symmetric case to t392manual
  // above - this fixture carries no INPUT_BOX_PRESENT marker either way, so
  // its `ready: false` row cannot fail against a mutation to CHOICE_DIALOG.
  // `awaitingChoice: true` is the one that dies against D3's mutation.
  {
    file: "plan-approval-dialog.txt",
    name: "t392plan",
    marker: "ctrl+g to edit in Zed",
    awaitingChoice: true,
    ready: false,
  },
  // Todo 392, M1 completion. bypassPermissions's footer reads "bypass
  // permissions on (shift+tab to cycle) ...", not "<word> mode on" - "mode
  // on" alone left this population with the identical total miss M1 closed
  // for auto/plan at narrow widths. Captured at 40 COLUMNS deliberately
  // (every other fixture here is 220): at that width "(shift+tab to
  // cycle)" is gone and "permissions on" is the ONLY INPUT_BOX_PRESENT
  // alternative left standing, so this fixture actually discriminates the
  // new alternative - a 220-column capture would also carry "(shift+tab to
  // cycle)" intact and pass with "permissions on" removed entirely,
  // proving nothing (F6/F8's own lesson, applied before shipping rather
  // than found after).
  {
    file: "bypass-mode-idle-narrow.txt",
    name: "t392bypass",
    marker: "permissions on",
    awaitingChoice: false,
    ready: true,
  },
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

// Todo 392 round 2 review (F6). The t392prompt CASE above asserts only
// "Esc to cancel" (via `marker`), awaitingChoice=true, ready=false - every
// one of which folder-trust-dialog.txt or model-picker-dialog.txt would
// also satisfy. Swap tool-permission-prompt.txt's file for either and every
// assertion in the CASES loop still passes, and then restoring `╰` to
// INPUT_BOX_PRESENT also passes, because neither of those fixtures ever
// carried `╰` to begin with - test/CLAUDE.md's own named false-green shape,
// a fixture with no power to catch the mutation it is filed under. This
// reads the fixture FILE directly (not through a replayed pane) and asserts
// on the bytes themselves, so the case cannot be silently swapped for a
// fixture that looks equivalent to the CASES loop but cannot discriminate
// the bug.
describe("tool-permission-prompt.txt carries the bytes the t392prompt case actually needs (todo 392 round 2, F6)", () => {
  it("contains the preview box's own closing border and the dialog's own question", () => {
    const raw = readFileSync(join(FIXTURES, "tool-permission-prompt.txt"), "utf8");
    assert.match(raw, /╰/, "the preview box's closing border - the whole bug - must be in this fixture");
    assert.match(
      raw,
      /Do you want to insert this cell/,
      "the dialog's own question, not just a generic dialog marker any captured screen could share",
    );
  });
});

// Todo 392, M1 completion, same reasoning as F6 immediately above: applied
// pre-emptively here rather than found by review. t392bypass's `ready: true`
// CASE only discriminates the "permissions on" alternative if this fixture
// genuinely has no OTHER surviving INPUT_BOX_PRESENT marker - swap it for a
// wide bypass-mode capture (where "(shift+tab to cycle)" also survives) and
// the case would pass with "permissions on" removed entirely, proving
// nothing.
describe("bypass-mode-idle-narrow.txt carries the bytes the t392bypass case actually needs (todo 392, M1)", () => {
  it("contains 'permissions on' and genuinely lacks every other INPUT_BOX_PRESENT alternative", () => {
    const raw = readFileSync(join(FIXTURES, "bypass-mode-idle-narrow.txt"), "utf8");
    assert.match(raw, /permissions on/, "the alternative this fixture exists to pin");
    assert.doesNotMatch(
      raw,
      /shift\+tab to cycle|for shortcuts|mode on/,
      "if any other alternative survived here too, this fixture could not tell 'permissions on' apart from an untested regression",
    );
  });
});

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
