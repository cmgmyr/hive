import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { REPO, isolateTmux, until } from "./helpers.mjs";

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

    expect: { state: "ghost", text: "Press up to edit queued messages" },
  },
  {
    file: "dim-then-normal.txt",
    name: "dim-then-normal",
    marker: "REAL INPUT AFTER DIM RESET",

    expect: { state: "pending", text: "REAL INPUT AFTER DIM RESET" },
  },

  { file: "folder-trust-dialog.txt", name: "trust-dialog", marker: "trust this folder", expect: null },
  { file: "model-picker-dialog.txt", name: "model-dialog", marker: "Select model", expect: null },
  {
    file: "dialog-with-stale-input-line.txt",
    name: "dialog-with-stale-line",
    marker: "STALE GHOST FROM SCROLLBACK",

    expect: null,
  },
  {
    file: "drifted-prompt-glyph.txt",
    name: "drifted-glyph",
    marker: "for agents",

    expect: { state: "unknown", text: "" },
  },
  {
    file: "multiline-pending.txt",
    name: "multiline",
    marker: "SECOND LINE OF PENDING",

    expect: { state: "pending", text: "FIRST LINE OF PENDING SECOND LINE OF PENDING" },
  },
  {
    file: "multiline-empty-first-line.txt",
    name: "multiline-empty-first",
    marker: "SECOND LINE ONLY",

    expect: { state: "pending", text: "SECOND LINE ONLY, FIRST LINE EMPTY" },
  },
  {
    file: "manual-mode-pending.txt",
    name: "manual-pending",
    marker: "REAL UNSUBMITTED PENDING TEXT FOR F9",

    expect: { state: "pending", text: "REAL UNSUBMITTED PENDING TEXT FOR F9" },
  },

  {
    file: "footer-slot-taken.txt",
    name: "slot-taken",
    marker: "paste again to expand",
    expect: { state: "ghost", text: "Press up to edit queued messages" },
  },

  {
    file: "footer-slot-taken-pending.txt",
    name: "slot-taken-pending",
    marker: "REAL UNSUBMITTED TEXT, FOOTER SLOT TAKEN",
    expect: { state: "pending", text: "REAL UNSUBMITTED TEXT, FOOTER SLOT TAKEN" },
  },

  {
    file: "multiline-blank-interior.txt",
    name: "multiline-blank-interior",
    marker: "SECOND LINE OF PENDING",
    expect: { state: "pending", text: "FIRST LINE OF PENDING SECOND LINE OF PENDING" },
  },

  {
    file: "dialog-under-two-rules.txt",
    name: "dialog-two-rules",
    marker: "Do you want to run this command again",
    expect: { state: "unknown", text: "" },
  },

  {
    file: "scrollback-box-above-dialog.txt",
    name: "scrollback-box",
    marker: "Do you want to insert this cell",
    expect: null,
  },

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

        const rendered = await until(() =>
          execFileSync("tmux", ["capture-pane", "-p", "-t", target]).toString().includes(marker),
        );
        assert.ok(rendered, `fixture never rendered on ${target} (looked for ${JSON.stringify(marker)})`);

        assert.deepEqual(inputBoxState(target), expect);
      });
    }

    it("answers null for a pane it cannot read", () => {
      assert.equal(inputBoxState("%999999"), null);
    });

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
