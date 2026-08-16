import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { REPO, isolateTmux, until } from "./helpers.mjs";

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

  {
    file: "tool-permission-prompt.txt",
    name: "t392prompt",
    marker: "Esc to cancel",
    awaitingChoice: true,
    ready: false,
  },

  {
    file: "manual-mode-idle.txt",
    name: "t392manual",
    marker: "manual mode on",
    awaitingChoice: false,
    ready: true,
  },

  {
    file: "plan-approval-dialog.txt",
    name: "t392plan",
    marker: "ctrl+g to edit in Zed",
    awaitingChoice: true,
    ready: false,
  },

  {
    file: "bypass-mode-idle-narrow.txt",
    name: "t392bypass",
    marker: "permissions on",
    awaitingChoice: false,
    ready: true,
  },

  {
    file: "footer-slot-taken.txt",
    name: "t399slot",
    marker: "paste again to expand",
    awaitingChoice: false,
    ready: true,
  },

  {
    file: "dialog-under-two-rules.txt",
    name: "t399tworules",
    marker: "Do you want to run this command again",
    awaitingChoice: true,
    ready: false,
  },

  {
    file: "scrollback-box-above-dialog.txt",
    name: "t399scrollback",
    marker: "Do you want to insert this cell",
    awaitingChoice: true,
    ready: false,
  },

  {
    file: "tail-echo-no-top-border.txt",
    name: "t399echo",
    marker: "ECHOED TAIL FROM ANOTHER PANE",
    awaitingChoice: true,
    ready: false,
  },

  {
    file: "tall-pending-esc-to-cancel.txt",
    name: "t403tall",
    marker: "nothing scrolls a static screen away",
    awaitingChoice: false,
    ready: true,
  },

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

    it("answers null, not false, for a pane it cannot read", () => {
      const result = paneAwaitingChoice("%999999");
      assert.equal(result, null);
      assert.notEqual(result, false);
    });

    for (const { name, ready } of CASES) {
      it(`waitForPaneInput reads ${name} as ready=${ready}`, async () => {
        const target = `${session}:${name}`;
        const result = await waitForPaneInput(target, ready ? 2000 : 700);
        assert.equal(result, ready);
      });
    }
  },
);

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

        assert.equal(
          paneHasInputBox(target),
          false,
          `at ${h} rows: the presence predicate must NOT see a box this tall - its callers kill panes and type on a ` +
            "yes, so being fooled is their destructive direction",
        );

        assert.equal(
          inputBoxState(target)?.state,
          "pending",
          `at ${h} rows: the hold path was always right about this pane - the point is that the dialog path now agrees`,
        );
      });
    }
  },
);

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

describe("describePaneChoice", () => {
  it("distinguishes all three states, null included", () => {
    assert.equal(describePaneChoice(true), "awaiting a choice (dialog)");
    assert.equal(describePaneChoice(false), "no dialog");
    assert.equal(describePaneChoice(null), "could not be read");
  });
});
