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

const { paneAwaitingChoice, paneHasInputBox, waitForPaneInput, describePaneChoice, inputBoxState } = await import(
  "../dist/tmux.js"
);

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
  // TODO 399, the READINESS half of the same bug. A genuine claude pane with
  // its input box on screen and every INPUT_BOX_PRESENT alternative absent,
  // because the single UI line all four share was showing another hint. The
  // `ready: true` row is the one that dies against the footer regex: a spawn
  // landing in this window reports ready:false with a "may lose typed text"
  // note on a pane that has been ready the whole time - issue #30's own
  // failure shape, reached by a transient hint rather than by a version
  // change.
  //
  // The `awaitingChoice: false` row cannot fail against the box anchor on
  // its own (this screen carries no CHOICE_DIALOG alternative either way, so
  // it reads false from the first half of the pair regardless - the same
  // F8 caveat t392manual carries). It is here as the control that the anchor
  // did not turn an ordinary idle screen into a dialog.
  {
    file: "footer-slot-taken.txt",
    name: "t399slot",
    marker: "paste again to expand",
    awaitingChoice: false,
    ready: true,
  },
  // TODO 399, COUNSELORS ROUND 1, ALL THREE SEATS INDEPENDENTLY - THE ROW
  // THAT MATTERS MOST IN THIS FILE. Two bare rules with no prompt row between
  // them used to satisfy the presence predicate, so a REAL dialog with framed
  // tool output above it read awaitingChoice=false: delivery would paste and
  // press Enter, and the Enter picks "1. Yes". That is todo 392's `╰` bug
  // rebuilt with a different glyph by the lane told not to rebuild it, and it
  // is a REGRESSION AGAINST THE RETIRED REGEX, which classified this screen
  // correctly because it carries no footer string.
  //
  // Reproduced against the real paneAwaitingChoice on an isolated tmux server
  // before the fix. MUTATION: drop `?.prompt != null` from inputBoxOnScreen
  // (back to `!== null`) and both rows here flip.
  //
  // Its `ready: false` row is the same fact from the readiness side: a pane
  // showing a dialog must never report ready, or a spawn types its brief into
  // the prompt and answers it.
  {
    file: "dialog-under-two-rules.txt",
    name: "t399tworules",
    marker: "Do you want to run this command again",
    awaitingChoice: true,
    ready: false,
  },
  // TODO 399, the OVER-matching direction, which is what the dialog guard and
  // the readiness probe are hurt by and the input-box hold is not. A complete
  // box - top border, prompt row, closing border, status lines, footer - in
  // the scrollback above a genuine tool-permission dialog, the shape a worker
  // that `cat`s a captured pane produces in its own transcript.
  //
  // Green before and after: against the footer regex this fixture carries no
  // marker, and against the anchor the box is too far from the bottom of the
  // capture to be the live one. It is here for the MUTATION - drop the
  // anchor's bottom-of-capture bound and both rows flip, which is todo 392's
  // `╰` bug rebuilt with a different glyph: a dialog's own surroundings
  // proving there is no dialog, and a spawn typing its brief into a pane
  // sitting on a permission prompt.
  {
    file: "scrollback-box-above-dialog.txt",
    name: "t399scrollback",
    marker: "Do you want to insert this cell",
    awaitingChoice: true,
    ready: false,
  },
  // The top-border half of the bracketing, which the fixture above cannot
  // reach - a real dialog's own block is 9 to 15 rows tall, so a scrollback
  // echo above one never falls inside the tail bound in the first place.
  // Synthetic and minimal; see the fixtures README. MUTATION: drop the
  // top-border requirement and both rows flip here instead.
  {
    file: "tail-echo-no-top-border.txt",
    name: "t399echo",
    marker: "ECHOED TAIL FROM ANOTHER PANE",
    awaitingChoice: true,
    ready: false,
  },
  // TODO 403. A REAL LEAD PANE HOLDING A PENDING MESSAGE TALLER THAN THE
  // NARROW CAPTURE WINDOW, whose text quotes "Esc to cancel" - which is what
  // a human writing to the lead ABOUT the dialog predicate types. Before the
  // window split this read awaitingChoice=TRUE: the footer half matched the
  // human's own typing and the box half went absent, because the box's top
  // border sat above the last 18 rows, so the pair degenerated to bare
  // CHOICE_DIALOG on a REAL claude pane with no dialog anywhere on it.
  // agent_send's text path then refuses forever and deliverable() holds every
  // wake aimed at that pane, and nothing clears it - a static screen does not
  // scroll away.
  //
  // ONE ROW HERE IS LOAD-BEARING AND THE OTHER IS A CONTROL, and this comment
  // claimed both until counselors round 2 (two seats) checked it against the
  // mutation table 200 lines below. `awaitingChoice: false` dies against the
  // box half reading the narrow window - that is the pin. `ready: true` does
  // NOT die against the readiness probe doing the same: this fixture's top
  // border sits 20 rows above the last non-blank row, inside the readiness
  // probe's own 30-row window, so it reads ready either way. It is a control
  // that the fix did not turn a live lead pane into a not-ready one.
  //
  // Worth keeping the correction rather than just the corrected text: an
  // overclaimed row is the F8 shape this file already documents twice, filed
  // under a mutation it cannot catch, and the next reader checking whether a
  // revert is pinned would have believed line-for-line that it was.
  {
    file: "tall-pending-esc-to-cancel.txt",
    name: "t403tall",
    marker: "nothing scrolls a static screen away",
    awaitingChoice: false,
    ready: true,
  },
  // TODO 403, THE OTHER HALF OF THE PAIR, AND THE ONE THAT PINS A DECISION
  // RATHER THAN A FIX. The window split leaves CHOICE_DIALOG on the narrow
  // window deliberately, and until this fixture existed nothing in the suite
  // enforced that: unifying the two windows "for consistency" turned nothing
  // red, so the argument lived only in prose - and prose that no test defends
  // reads as arbitrary to the next person to refactor it.
  //
  // A worker's own bash pane, no claude chrome anywhere on it, that grepped
  // the dialog predicate - which is what a worker on this lane does - so
  // "Esc to cancel" sits in its scrollback 36 rows above the last non-blank
  // row: OUTSIDE the narrow window, INSIDE the raw one.
  //
  // Shipped: no footer match in the narrow window, so awaitingChoice=false on
  // a pane with nothing on it. MUTATION - hand the footer half the raw window
  // (`CHOICE_DIALOG.test(wide)`) - and it matches, the box is absent because a
  // bash pane has none, and this pane reads as a PERMANENT unclearable dialog:
  // agent_send's text path refuses forever and every wake aimed here is held,
  // with nothing ever coming to falsify it. That is the failure the CHOICE_
  // DIALOG comment and the rule file both argue against, made red.
  {
    file: "stray-esc-above-the-narrow-window.txt",
    name: "t403stray",
    marker: "git add -A",
    awaitingChoice: false,
    ready: false,
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
// TODO 399. FOUND BY RUNNING THE LANE'S OWN SCRIPTS HALF, NOT BY REVIEW - all
// three counselors seats missed it, because none of them could execute
// anything.
//
// Every other case in this file replays a 220-column capture into a
// 220-column pane, so no line ever wraps and the box's borders are one row
// each. test/restart-lead.test.mjs replays the SAME ready-idle.txt into the
// 80-column pane `hive lead` creates by default, where each 220-character
// border renders as THREE consecutive rows. The first version of findInputBox
// took the lowest of those as the closing border and then matched the second
// row of that same edge as the "top" border, closing the bracket on two rows
// of one rule with the prompt row outside it: box absent, hold gone, on a
// screen that plainly has one. Measured before the fix: paneHasInputBox false
// at 80x24, true at 220x50, identical bytes.
//
// This pins the width directly rather than leaving it to restart-lead's
// end-to-end suite, which found it by accident and would stop covering it the
// moment that file changed how it fakes a claude pane. MUTATION: remove the
// `while (bottom > 0 && BOX_BORDER.test(text[bottom - 1])) bottom -= 1;` run
// collapse in src/tmux.ts. Red at 80 and 60, green at 220 - which is the
// shape that made it invisible.
describe(
  "a border wider than the pane wraps into several rows and is still ONE edge (todo 399)",
  { skip: hasTmux ? false : "tmux is not installed" },
  () => {
    const session = `hive-panewrap-${process.pid}`;
    const WIDTHS = [220, 80, 60];

    before(async () => {
      if (!hasTmux) return;
      const cmd = `cat '${join(FIXTURES, "ready-idle.txt")}'; sleep 600`;
      WIDTHS.forEach((w, i) => {
        const name = `w${w}`;
        if (i === 0) {
          execFileSync("tmux", ["new-session", "-d", "-s", session, "-n", name, "-x", String(w), "-y", "24", cmd], {
            stdio: "ignore",
          });
        } else {
          execFileSync("tmux", ["new-window", "-d", "-t", `=${session}`, "-n", name, "-e", "X=1", cmd], {
            stdio: "ignore",
          });
          execFileSync("tmux", ["resize-window", "-t", `${session}:${name}`, "-x", String(w), "-y", "24"], {
            stdio: "ignore",
          });
        }
      });
      await Promise.all(
        WIDTHS.map((w) =>
          until(() =>
            execFileSync("tmux", ["capture-pane", "-p", "-t", `${session}:w${w}`]).toString().includes("auto mode on"),
          ),
        ),
      );
    });

    after(() => cleanup(session));

    for (const w of WIDTHS) {
      it(`finds the input box at ${w} columns`, async () => {
        const target = `${session}:w${w}`;
        const rendered = await until(() =>
          execFileSync("tmux", ["capture-pane", "-p", "-t", target]).toString().includes("auto mode on"),
        );
        assert.ok(rendered, `the fixture never rendered at ${w} columns`);

        assert.equal(
          paneHasInputBox(target),
          true,
          `ready-idle.txt is an idle claude screen at every width; at ${w} columns its borders wrap, and a wrapped ` +
            "border is still one edge",
        );
        assert.equal(paneAwaitingChoice(target), false, "an idle screen is never a dialog, at any width");
      });
    }
  },
);

// TODO 403. THE HEIGHT AXIS, WHICH THIS CORPUS WAS AS BLIND TO AS IT WAS TO
// WIDTH BEFORE THE DESCRIBE ABOVE. Every case in the CASES loop is replayed
// into one 220x50 pane, so nothing there can tell a defect in the capture
// WINDOW from a defect that happens to depend on the pane's own height - and
// this todo is entirely about row windows.
//
// The claim under test is a pair, and it needs both heights to be a claim at
// all: the narrow window's cap is height-INDEPENDENT (the bug reproduced
// identically at 50, 30 and 20 rows), and so is the fix. `capture-pane -S -18`
// returns the visible pane PLUS 18 rows, so the raw window shrinks with the
// pane - 69, 49 and 39 rows at these three heights, measured - while the
// narrow window stays 18 at all of them. A fix that only worked because a
// tall pane happened to hold the whole box on screen would pass at 50 and
// fail at 20; a fix that read the visible pane rather than the capture would
// do the same.
//
// MUTATIONS, RUN ONE AT A TIME AND VERIFIED PRESENT IN dist/ BEFORE EACH RUN,
// with what each one actually killed rather than what it was expected to:
//
//   box half back on the narrow window          -> 4 red (the t403tall CASE
//     (`inputBoxOnScreen(tail)`)                   plus all three heights)
//   paneHasInputBox moved to the RAW window     -> 3 red (the box assertion
//                                                  at all three heights)
//   footer half moved to the raw window         -> 1 red, and NOT from this
//     (`CHOICE_DIALOG.test(wide)`)                 fixture - see t403stray
//   paneChoiceCheck back on ONE narrow capture  -> 3 red (added round 2b:
//     (`isAwaitingChoiceScreen(tail, tail)`)       every assertion above ran
//                                                  through paneAwaitingChoice,
//                                                  so this caller could be
//                                                  reverted alone and stay
//                                                  green - and it is the
//                                                  agent_send refusal path)
//
// TWO OF THOSE ROWS CHANGED DIRECTION IN ROUND 2 AND THAT IS THE HONEST
// RECORD. `paneHasInputBox` shipped on the RAW window in round 1, so the
// mutation that killed those three assertions was moving it back to the
// narrow one. Counselors found that the raw window there reversed a recorded
// decision at its destructive caller, it went back to narrow, and the
// mutation inverted with it. The readiness row is gone from this table
// entirely for the same reason: it shipped raw, was reverted, and there is
// no mutation left to name - what pins it now is the argument at its own
// definition, which is the only thing that ever pinned it.
//
// THE FOOTER ROW WAS "NOTHING RED" UNTIL THE LEAD REFUSED THAT, AND THE
// REFUSAL WAS RIGHT. This fixture genuinely cannot discriminate that half -
// its "Esc to cancel" sits inside BOTH windows - but the conclusion drawn
// from it, that a decision not to widen has no screen to prove it, was
// false. A decision not to widen is testable by a screen where widening
// CHANGES THE ANSWER: `stray-esc-above-the-narrow-window.txt`, a bash pane
// whose scrollback quotes the footer above the narrow window and inside the
// raw one. Recorded here because the wrong version of this reasoning is
// exactly what leaves an argued decision defended only in prose.
//
// THE READINESS ROW GOT THE SAME TREATMENT AND THE OPPOSITE OUTCOME, which
// is worth reading next to the paragraph above rather than as a repeat of it.
// It was also "nothing red", it was also defended as accepted, and there the
// answer was not to build a discriminating fixture but to REVERT the change:
// a counselors seat constructed the case (a wrapper printing box chrome and
// blocking in `read` before exec'ing claude, top border 32 rows up) and it
// showed the probe had been widened in the one direction that loses a human's
// text silently. "Nothing red" is a question, not a verdict - sometimes the
// answer is a fixture the corpus was missing, and sometimes it is that the
// change should not have been made.
//
// The first mutation is also the control that the split is inert everywhere
// else: it turns nothing else in this file red, so no existing fixture's
// answer moved when the box half changed windows.
//
// AND ONE MUTATION THAT IS NOT ABOUT src/ AT ALL, run because a pin is only
// worth what it does in the condition it exists for: point the t403stray CASE
// at a fixture file that does not exist, so the pane renders NOTHING. Before
// round 2b that case passed green - a blank pane satisfies awaitingChoice
// false and ready false, and the footer-half mutation passes with it, because
// a pane that never rendered carries no stray quote. It now fails in 3.0s on
// the `until` return. That is the difference between a pin and a pin-shaped
// assertion, and it was invisible until someone asked what happens when the
// `cat` loses a race.
describe(
  "a pending message taller than the narrow window is not a dialog, at any pane height (todo 403)",
  { skip: hasTmux ? false : "tmux is not installed" },
  () => {
    const session = `hive-panetall-${process.pid}`;
    const HEIGHTS = [50, 30, 20];
    const MARKER = "nothing scrolls a static screen away";

    before(async () => {
      if (!hasTmux) return;
      const cmd = `cat '${join(FIXTURES, "tall-pending-esc-to-cancel.txt")}'; sleep 600`;
      HEIGHTS.forEach((h, i) => {
        const name = `h${h}`;
        if (i === 0) {
          execFileSync("tmux", ["new-session", "-d", "-s", session, "-n", name, "-x", "220", "-y", String(h), cmd], {
            stdio: "ignore",
          });
        } else {
          execFileSync("tmux", ["new-window", "-d", "-t", `=${session}`, "-n", name, "-e", "X=1", cmd], {
            stdio: "ignore",
          });
          execFileSync("tmux", ["resize-window", "-t", `${session}:${name}`, "-x", "220", "-y", String(h)], {
            stdio: "ignore",
          });
        }
      });
    });

    after(() => cleanup(session));

    for (const h of HEIGHTS) {
      it(`reads the tall pending box at ${h} rows`, async () => {
        const target = `${session}:h${h}`;
        await until(() => execFileSync("tmux", ["capture-pane", "-p", "-t", target]).toString().includes(MARKER));

        assert.equal(
          paneAwaitingChoice(target),
          false,
          `at ${h} rows: a human's own message quoting "Esc to cancel" is not a dialog, and the box that proves it ` +
            "is taller than the narrow window",
        );
        // AND THIS ONE READS FALSE ON PURPOSE, WHICH IS THE ROUND-2
        // CORRECTION. The presence predicate stays on the NARROW window, so
        // it does not see this box - and that is the answer its callers need,
        // because both of them are destroyed by a false PRESENT rather than
        // by a miss: restart-lead.sh's refusal 1 has `tmux kill-pane` on the
        // other side of it, and its readiness wait types the moment this says
        // yes. A bash pane that had merely `cat`-ed THIS FIXTURE would pass
        // refusal 1 as claude over the raw window. The lead pane this fixture
        // represents is still recognised there, by CLAUDE_PANE_CMD's own
        // branch of that OR.
        //
        // MUTATION: move paneHasInputBox back to captureRawPane and all three
        // heights go red here.
        assert.equal(
          paneHasInputBox(target),
          false,
          `at ${h} rows: the presence predicate must NOT see a box this tall - its callers kill panes and type on a ` +
            "yes, so being fooled is their destructive direction",
        );
        // THE TWO READERS OF ONE FACT, ASSERTED TOGETHER. This is the whole
        // shape of todo 403: inputBoxState was ALREADY right about this pane
        // (the unsubmitted-text hold never broke), and the dialog path
        // disagreed with it. Asserting only awaitingChoice would pin the
        // symptom; asserting both pins that they agree, which is the thing
        // that was false.
        assert.equal(
          inputBoxState(target)?.state,
          "pending",
          `at ${h} rows: the hold path was always right about this pane - the point is that the dialog path now agrees`,
        );
      });
    }
  },
);

// TODO 403, the F6/M1 defence applied before review rather than after: the
// t403tall CASE and the height describe above assert awaitingChoice=false and
// ready=true, both of which ready-idle.txt and footer-slot-taken-pending.txt
// would also satisfy. Swap the file for either and every one of those
// assertions still passes with the window split reverted entirely, because
// neither fixture has a box tall enough to fall outside the narrow window.
// A bound can only be tested by a fixture that exceeds it (test/CLAUDE.md's
// own named false-green shape 6), so this asserts on the bytes that make it
// exceed the bound.
describe("tall-pending-esc-to-cancel.txt carries the bytes the todo 403 cases actually need", () => {
  const rows = readFileSync(join(FIXTURES, "tall-pending-esc-to-cancel.txt"), "utf8")
    .split("\n")
    .map((row) => row.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());
  const lastNonBlank = rows.reduce((last, row, i) => (row.trim() === "" ? last : i), -1);
  const isRule = (row) => /^─{4,}/.test(row.trim());

  it("quotes the dialog footer inside the narrow window, so the loose half really does match", () => {
    const narrow = rows.slice(Math.max(0, lastNonBlank - 17), lastNonBlank + 1);
    assert.ok(
      narrow.some((row) => row.includes("Esc to cancel")),
      "if this string were outside the 18-row window the case would read false for the wrong reason entirely",
    );
  });

  it("puts the box's top border OUTSIDE the narrow window and inside BOX_MAX_ROWS", () => {
    const bottom = rows.findLastIndex((row, i) => i <= lastNonBlank && isRule(row));
    const top = rows.findLastIndex((row, i) => i < bottom && isRule(row));
    assert.ok(top >= 0 && bottom > top, "the fixture must carry both of the box's own borders");

    const rowsFromEnd = lastNonBlank - top;
    assert.ok(
      rowsFromEnd > 18,
      `the top border sits ${rowsFromEnd} rows above the last non-blank row; at 18 or fewer it is inside the narrow ` +
        "window and this fixture cannot reach the bound it exists to test",
    );
    assert.ok(
      bottom - top <= 24,
      `the box is ${bottom - top} rows tall; past BOX_MAX_ROWS (24) it reads absent to BOTH windows and the fixture ` +
        "would be pinning the cap rather than the window",
    );
  });
});

// TODO 403. The same defence for the fixture that pins the OTHER half. This
// one is more fragile than tall-pending, because its whole discriminating
// power is a row OFFSET: the quoted footer has to fall outside the narrow
// window and inside the raw one, and an edit that adds ten lines to the
// bottom of the transcript silently moves it into the narrow window, where
// the case would then read awaitingChoice=true and someone would "fix" the
// expectation. Both bounds are asserted so that edit fails here instead.
describe("stray-esc-above-the-narrow-window.txt carries the bytes the t403stray case actually needs", () => {
  const rows = readFileSync(join(FIXTURES, "stray-esc-above-the-narrow-window.txt"), "utf8")
    .split("\n")
    .map((row) => row.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());
  const lastNonBlank = rows.reduce((last, row, i) => (row.trim() === "" ? last : i), -1);
  const lowestStray = rows.reduce((last, row, i) => (row.includes("Esc to cancel") ? i : last), -1);

  it("quotes the dialog footer OUTSIDE the narrow window and INSIDE the raw one", () => {
    assert.ok(lowestStray >= 0, "the whole point of this fixture is that it quotes the footer somewhere");

    const rowsAbove = lastNonBlank - lowestStray;
    assert.ok(
      rowsAbove > 18,
      `the lowest quote sits ${rowsAbove} rows above the last non-blank row; at 18 or fewer the narrow window sees ` +
        "it too and this fixture stops discriminating the footer half's window",
    );
    // The raw window is the visible pane PLUS tailCaptureLines(), so at the
    // 50-row height the CASES loop replays into, the quote has to be within
    // 68 rows of the end for the mutation to be able to see it at all. A
    // fixture the mutation cannot see is one that passes for the wrong
    // reason, which is the same failure in the opposite direction.
    assert.ok(
      rowsAbove < 50 + 18,
      `the lowest quote sits ${rowsAbove} rows above the last non-blank row, outside the raw window at the replay ` +
        "height - the mutation this fixture exists to kill would never even match it",
    );
  });

  it("has no claude chrome at all, so the box half cannot be what answers here", () => {
    const raw = rows.join("\n");
    assert.doesNotMatch(
      raw,
      /^─{4,}/m,
      "a rule near the bottom would let the box anchor engage, and then this fixture would be testing that half",
    );
    assert.doesNotMatch(raw, /\u276f\u00a0/, "the prompt row is the other half of the box anchor and must not be here either");
  });
});

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
