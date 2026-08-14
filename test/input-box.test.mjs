import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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

const { inputBoxState } = await import("../dist/tmux.js");

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
  },
);
