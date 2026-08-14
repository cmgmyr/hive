import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { REPO, isolateTmux, until } from "./helpers.mjs";

// Issue #34. inputBoxState reads a pane's input-box line with "-e", the one
// capture in the codebase that keeps SGR attributes, because the ghost
// suggestion and the "press up to edit queued messages" hint both render in
// SGR 2 (faint) and there is no other way to tell either from real
// unsubmitted input. It is a SEPARATE capture from the plain tail/output
// (capturePane), on purpose: see the comment on inputBoxField in
// src/tools/agents.ts for why a fused single-capture version of this was
// tried and reverted. Fixtures ghost-suggestion.txt, queued-hint.txt and
// real-input.txt are genuine full-screen captures off a live claude 2.1.220
// session (PR #37 counselors B6): the field previously carried a
// reconstruction of issue #34's own measured bytes rather than a fresh
// capture, and counselors flagged it as suspect. See
// test/fixtures/panes/README.md for how these were taken.
const { hasTmux, cleanup } = isolateTmux("the input-box fixture tests");

const { inputBoxState, holdsHumanInput } = await import("../dist/tmux.js");

const FIXTURES = join(REPO, "test", "fixtures", "panes");

const CASES = [
  { file: "ready-idle.txt", name: "empty", marker: "for agents", expect: { state: "empty", text: "" } },
  { file: "busy-mid-turn.txt", name: "busy", marker: "lighthouse keeper", expect: { state: "empty", text: "" } },
  {
    file: "real-input.txt",
    name: "real",
    marker: "REAL UNSUBMITTED INPUT",
    // The honest control (issue #34): real unsubmitted text in the same box,
    // on the same line, with no attribute change after the prompt. Without
    // this case the rule could not fail in the direction that matters --
    // mislabeling something the worker actually typed.
    expect: { state: "pending", text: "REAL UNSUBMITTED INPUT" },
  },
  {
    file: "ghost-suggestion.txt",
    name: "ghost",
    marker: "write the failing test case",
    expect: { state: "ghost", text: "write the failing test case for me" },
  },
  {
    file: "queued-hint.txt",
    name: "hint",
    marker: "Press up to edit queued",
    // Not distinguished from a ghost suggestion on purpose (issue #34): both
    // mean "not user input", which is the whole question.
    expect: { state: "ghost", text: "Press up to edit queued messages" },
  },
  {
    file: "dim-then-normal.txt",
    name: "dim-then-normal",
    marker: "REAL INPUT AFTER DIM RESET",
    // B1, counselors review on PR #37. A leading run that sets faint and then
    // cancels it (ESC[2m ESC[22m) before any visible character must read as
    // real input, not ghost: the destructive direction is telling a lead
    // typed text is safe to overwrite. See dim-then-normal.txt's note in
    // test/fixtures/panes/README.md -- this one is synthetic, not a claude
    // capture, since it pins the SGR-fold logic itself rather than claude's
    // chrome.
    expect: { state: "pending", text: "REAL INPUT AFTER DIM RESET" },
  },
  // The D5 dialog guard's own fixtures. A "❯" glyph appears in both (it is
  // the dialog's own option cursor), but never followed by NBSP the way the
  // input-box prompt is, so this must find no input-box line at all rather
  // than misreading the dialog's cursor as one. Ghost text is not a threat
  // to D5 by construction -- it renders only when the input box is present,
  // and D5 requires it absent -- but that is proven here rather than assumed.
  { file: "folder-trust-dialog.txt", name: "trust-dialog", marker: "trust this folder", expect: null },
  { file: "model-picker-dialog.txt", name: "model-dialog", marker: "Select model", expect: null },
  {
    file: "dialog-with-stale-input-line.txt",
    name: "dialog-with-stale-line",
    marker: "STALE GHOST FROM SCROLLBACK",
    // B3, counselors review on PR #37. folder-trust-dialog.txt with a
    // genuine glyph+NBSP row injected into its scrollback, simulating a
    // ghost/real line embedded into a pane's history (e.g. via a wake body)
    // before a real dialog appeared below it. INPUT_BOX_PRESENT is still
    // absent everywhere in this screen, so this must return null rather than
    // trusting the stale row as the pane's CURRENT input box -- the same D4
    // wedge CHOICE_DIALOG had, closed here the way D5 closed it there: by
    // requiring the input box actually present, not just a matching
    // substring somewhere in the window.
    expect: null,
  },
  {
    file: "drifted-prompt-glyph.txt",
    name: "drifted-glyph",
    marker: "for agents",
    // S1, counselors review on PR #37. ready-idle.txt with the prompt glyph
    // itself replaced (INPUT_BOX_PRESENT still true, so claude genuinely has
    // control and no modal is showing) simulates a chrome redesign, the same
    // failure shape issue #30 was for the readiness markers. This must
    // report "unknown", not null: null is reserved for "there is
    // legitimately nothing to report" (no box showing at all), and
    // collapsing the two made a broken detector indistinguishable from a
    // confirmed-empty box.
    expect: { state: "unknown", text: "" },
  },
  {
    file: "multiline-pending.txt",
    name: "multiline",
    marker: "SECOND LINE OF PENDING",
    // S2, counselors review on PR #37. Genuine multi-line unsubmitted input
    // (real capture, see the fixtures README): a wrapped/multi-line pending
    // message must not be silently truncated to its first physical row.
    expect: { state: "pending", text: "FIRST LINE OF PENDING SECOND LINE OF PENDING" },
  },
  {
    file: "multiline-empty-first-line.txt",
    name: "multiline-empty-first",
    marker: "SECOND LINE ONLY",
    // S2's dangerous direction: the PROMPT row itself is textless here (a
    // logical newline was typed before any text), so a detector that only
    // ever looks at the prompt row reports "empty" while real pending text
    // sits one row below -- the same failure direction B1 fixed for the
    // SGR-fold logic, telling a lead a worker's real input is safe to
    // overwrite.
    expect: { state: "pending", text: "SECOND LINE ONLY, FIRST LINE EMPTY" },
  },
  {
    file: "manual-mode-pending.txt",
    name: "manual-pending",
    marker: "REAL UNSUBMITTED PENDING TEXT FOR F9",
    // Todo 392 round 2 review (F9). D2 (manual-mode idle) and F9's dialog-
    // side reasoning cover idle and dialog states; genuine PENDING input
    // under manual mode was never measured, and it is the dangerous
    // direction to get wrong: if the footer this fixture's own D2 fix
    // depends on hid or changed while a human was mid-sentence,
    // holdsHumanInput would read false and a wake would paste onto the
    // human's half-typed line and submit it. Measured live: the footer
    // reads "manual mode on" during composition too (it drops only its own
    // trailing "· ← for agents" hint, which nothing here depends on), so
    // this reads pending exactly like every other mode's own pending
    // fixture.
    expect: { state: "pending", text: "REAL UNSUBMITTED PENDING TEXT FOR F9" },
  },
  // TODO 399, THE HEADLINE. A genuine capture of the lead's own pane on main
  // with a real input box on screen and NOT ONE of INPUT_BOX_PRESENT's four
  // alternatives anywhere in it, because the single UI line all four live on
  // was showing "paste again to expand". Against the footer gate this reads
  // null - "there is legitimately nothing to report" - on a pane that
  // plainly has a box, so the wake hold, agent_send's refusal and
  // agent_rename's refusal all silently revert to pre-guard behaviour.
  //
  // This case is RED against the footer regex and green against the box
  // anchor, which is the whole lane in one assertion. See the fixtures
  // README for why the state it records cannot be captured again on demand.
  {
    file: "footer-slot-taken.txt",
    name: "slot-taken",
    marker: "paste again to expand",
    expect: { state: "ghost", text: "Press up to edit queued messages" },
  },
  // The same screen with real unsubmitted text in the box, which is the case
  // that destroys a human's work rather than the one that happened to be
  // captured. The real capture's box is EMPTY (claude's own queued-messages
  // hint), so it classifies "ghost" and holdsHumanInput is correctly false
  // for it - it proves the detector was restored but says nothing about the
  // HOLD. This is that capture with real-input.txt's own measured prompt-row
  // shape grafted onto its prompt row; the fixtures README says exactly what
  // was changed. holdsHumanInput is asserted on it separately below.
  {
    file: "footer-slot-taken-pending.txt",
    name: "slot-taken-pending",
    marker: "REAL UNSUBMITTED TEXT, FOOTER SLOT TAKEN",
    expect: { state: "pending", text: "REAL UNSUBMITTED TEXT, FOOTER SLOT TAKEN" },
  },
  // TODO 399, COUNSELORS ROUND 1, ALL THREE SEATS: an empty INTERIOR logical
  // line renders as a genuinely blank row inside the box, and the first
  // version of findInputBox stopped its upward scan at any blank row - so
  // this whole screen read as NO BOX, holdsHumanInput was false, and the wake
  // pasted onto the half-typed message and submitted it. That is todo 389's
  // clobber re-armed by the lane that exists to close it, and it is the
  // INCIDENT'S OWN SHAPE: pad 142 records the destroyed message as "92
  // characters over three logical lines, including a deliberate blank line".
  //
  // It is also the case that proves the RECEIPT, not just the hold: the text
  // must carry BOTH paragraphs. The continuation scan used to stop at the
  // same blank row and report one paragraph of a message that has two, which
  // is what a lead reads when deciding whether it is safe to interrupt
  // someone. MUTATION: restore either stop. Red.
  {
    file: "multiline-blank-interior.txt",
    name: "multiline-blank-interior",
    marker: "SECOND LINE OF PENDING",
    expect: { state: "pending", text: "FIRST LINE OF PENDING SECOND LINE OF PENDING" },
  },
  // TODO 399, COUNSELORS ROUND 1, ALL THREE SEATS: two bare rules with no
  // prompt row between them are NOT an input box, and the first version of
  // inputBoxOnScreen counted them as one. Framed tool output above a genuine
  // dialog is the ordinary producer - `───` separators are routine in pytest,
  // rich, and most CLI output.
  //
  // Here the classifier's own answer is "unknown", and that is CORRECT and is
  // the whole point of the split: borders are on screen, the prompt row is
  // not findable, which is the partial drift `hive doctor` warns on. What
  // must NOT happen is the PRESENCE predicate reading that as a box - see
  // this fixture's rows in test/pane-fixtures.test.mjs, where the dialog is
  // detected. One anchor, two questions, two answers.
  {
    file: "dialog-under-two-rules.txt",
    name: "dialog-two-rules",
    marker: "Do you want to run this command again",
    expect: { state: "unknown", text: "" },
  },
  // TODO 399, THE ADVERSARIAL CASE AGAINST THE LANE'S OWN FIX, and the
  // reason the footer gate existed at all (counselors B3 on PR #37, restated
  // for todo 392): a glyph row can appear in SCROLLBACK, so a prompt row is
  // not proof the box is live. Here a COMPLETE box - top border, prompt row,
  // closing border, both status lines and the taken footer - sits in the
  // scrollback above a genuine tool-permission dialog, which is what a
  // worker that `cat`s a captured pane produces in its own transcript.
  //
  // dialog-with-stale-input-line.txt above cannot catch this: it splices a
  // BARE glyph row with no borders, so it dies against a detector that
  // requires no bracketing at all and passes one that does. This fixture
  // carries the whole chrome, so it is the one that actually tests the
  // bracketing. Green before and after - the point is the MUTATION: remove
  // the anchor's bottom-of-capture bound and this reads a box (state
  // "unknown"), so the dialog guard is told there is no dialog.
  {
    file: "scrollback-box-above-dialog.txt",
    name: "scrollback-box",
    marker: "Do you want to insert this cell",
    expect: null,
  },
  // The other half of the bracketing, which scrollback-box-above-dialog.txt
  // structurally cannot reach: measured while building it, a real dialog's
  // own block is 9 to 15 rows tall, so a scrollback echo above one is always
  // outside the tail bound and the TOP-border requirement never gets a vote.
  // Synthetic and minimal (the fixtures README says so): a glyph+NBSP row
  // with a bare rule directly under it and nothing box-shaped above it - the
  // shape a wake body carrying another pane's tail leaves in the LEAD's own
  // scrollback, which tmux-and-panes.md already names as a real producer.
  // MUTATION: drop the top-border requirement and this reads
  // {state: "pending"}, holding every wake aimed at that pane forever.
  {
    file: "tail-echo-no-top-border.txt",
    name: "tail-echo",
    marker: "ECHOED TAIL FROM ANOTHER PANE",
    expect: null,
  },
];

describe(
  "inputBoxState against real claude 2.1.220 screens",
  { skip: hasTmux ? false : "tmux is not installed" },
  () => {
    const session = `hive-inputbox-${process.pid}`;

    before(() => {
      if (!hasTmux) return;
      CASES.forEach(({ file, name }, i) => {
        const fixture = join(FIXTURES, file);
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

    for (const { name, marker, expect } of CASES) {
      it(`reads ${name} as ${JSON.stringify(expect)}`, async () => {
        const target = `${session}:${name}`;
        // B4, counselors review on PR #37. until()'s return was discarded,
        // so a fixture that never rendered fell through to whatever
        // inputBoxState happened to read off a blank pane. For the five
        // non-null cases a blank pane fails loudly (an empty box does not
        // deep-equal ghost/pending text). It does NOT fail loudly for the
        // null-expecting cases, since a blank, unrendered pane ALSO answers
        // null -- exactly the cases whose whole job is to prove ghost
        // detection cannot collide with D5, proving nothing if this is
        // silently false.
        const rendered = await until(() =>
          execFileSync("tmux", ["capture-pane", "-p", "-t", target]).toString().includes(marker),
        );
        assert.ok(rendered, `fixture never rendered on ${target} (looked for ${JSON.stringify(marker)})`);

        assert.deepEqual(inputBoxState(target), expect);
      });
    }

    // Same shape as paneAwaitingChoice's own pin (decision D3 on the plan
    // pad): an unreadable pane must answer null, not silently read as
    // "empty", or a dead worker's box would misreport as confirmed clear.
    it("answers null for a pane it cannot read", () => {
      assert.equal(inputBoxState("%999999"), null);
    });

    // Todo 399. The CASES loop above pins the CLASSIFIER; this pins the
    // POLICY on the same two screens, because the classifier being restored
    // is not the same fact as the hold firing. tmux-and-panes.md's rule is
    // "only pending", and both directions have to be true on the very screen
    // the bug was measured on: the real capture's box is empty with claude's
    // own hint in it, so nothing may be held, and the pending graft must
    // hold. Against the footer gate BOTH read null and holdsHumanInput is
    // false for both - the false one passes for the wrong reason, which is
    // why the pending case is the one that carries this test.
    it("holdsHumanInput fires on the drifted screen only when the box really holds typed text", async () => {
      const ghost = `${session}:slot-taken`;
      const pending = `${session}:slot-taken-pending`;
      await until(() =>
        execFileSync("tmux", ["capture-pane", "-p", "-t", pending])
          .toString()
          .includes("REAL UNSUBMITTED TEXT, FOOTER SLOT TAKEN"),
      );

      assert.equal(holdsHumanInput(inputBoxState(pending)), true, "a wake must be held against real typed text");
      assert.equal(holdsHumanInput(inputBoxState(ghost)), false, "claude's own hint must not hold every wake forever");
    });
  },
);

// Todo 399, the same guard todo 392's F6 and M1 cases carry, applied
// pre-emptively rather than found by review. The `slot-taken` CASE above
// only discriminates the box anchor from the footer gate if this fixture
// genuinely carries NONE of INPUT_BOX_PRESENT's four alternatives - swap it
// for any ordinary idle capture and the case passes with the footer regex
// fully restored, proving nothing. Reads the fixture FILE rather than a
// replayed pane, so the bytes themselves are the assertion.
describe("footer-slot-taken.txt carries the bytes the slot-taken case actually needs (todo 399)", () => {
  const FOOTER_MARKERS = ["for shortcuts", "shift+tab to cycle", "mode on", "permissions on"];

  for (const file of ["footer-slot-taken.txt", "footer-slot-taken-pending.txt"]) {
    it(`${file} has a live input box and not one footer marker`, () => {
      const raw = readFileSync(join(FIXTURES, file), "utf8");
      for (const marker of FOOTER_MARKERS) {
        assert.ok(
          !raw.includes(marker),
          `${file} must not contain ${JSON.stringify(marker)}: the whole point of this fixture is that the ` +
            "one UI line all four markers share was showing something else",
        );
      }
      assert.match(raw, /paste again to expand/, "the hint that was occupying the slot - the fixture's whole subject");
      assert.match(raw, /❯ /, "a real prompt row must be on screen, or there is no bug to detect");
    });
  }
});
