import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { isolateTmux, scratchDirs, until } from "./helpers.mjs";

// codex's title and its live input box are dynamic facts a static fixture cannot carry: a fixture
// PRINTS a screen, so its cursor sits below whatever it drew and a captured file has no pane_title at
// all (.claude/sessions/dead-ends/2026-08-14-staging-a-pending-box-on-a-static-fixture-pane.md). These
// panes are driven live instead - a real tmux title (set the way any program sets one, via
// select-pane -T) and a script that redraws its box on every keystroke, so typing more into it changes
// what the next read sees. Neither pane runs the real codex binary: the screen shape codex renders is
// pinned separately, against real captures, in codex-pane-fixtures.test.mjs.
const { hasTmux, cleanup } = isolateTmux("the codex live-pane tests");
const { tmp } = scratchDirs();

const { codexInputBoxState, codexPaneChoiceCheck, codexPaneHasInputBox, paneTitle, waitForPaneInput } =
  await import("../dist/tmux.js");

describe(
  "codex's title-based awaitingChoice against a real pane title (todo 523)",
  { skip: hasTmux ? false : "tmux is not installed" },
  () => {
    const session = `hive-codex-title-${process.pid}`;

    before(() => {
      if (!hasTmux) return;
      execFileSync("tmux", [
        "new-session", "-d", "-s", session, "-n", "idle", "-x", "80", "-y", "20", "sleep 600",
      ]);
      // A screen shaped like a codex choice dialog (a highlighted numbered option), so the title
      // tests below can prove the title is consulted BEFORE the screen, not merely in addition to it.
      execFileSync("tmux", [
        "new-window", "-d", "-t", `=${session}`, "-n", "dialog-screen",
        "printf '\\xe2\\x80\\xba 1. Yes\\n  2. No\\n'; sleep 600",
      ]);
    });

    after(() => cleanup(session));

    it("reads a plain title as saying nothing, so the screen decides", async () => {
      const target = `${session}:idle`;
      execFileSync("tmux", ["select-pane", "-t", target, "-T", "codex-cwd"]);
      assert.equal(paneTitle(target), "codex-cwd");
      assert.equal(codexPaneChoiceCheck(target).awaitingChoice, false, "no choice line on screen, and a plain title");
    });

    it("lets a braille-spinner title override a screen that alone reads as a dialog", async () => {
      const target = `${session}:dialog-screen`;
      await until(() => execFileSync("tmux", ["capture-pane", "-p", "-t", target]).toString().includes("1. Yes"));
      execFileSync("tmux", ["select-pane", "-t", target, "-T", "codex-cwd"]);
      assert.equal(
        codexPaneChoiceCheck(target).awaitingChoice,
        true,
        "screen alone: a highlighted numbered option is codex's own choice-menu shape",
      );
      execFileSync("tmux", ["select-pane", "-t", target, "-T", "⠙ codex-cwd"]);
      assert.equal(
        codexPaneChoiceCheck(target).awaitingChoice,
        false,
        "a spinner-prefixed title must short-circuit to busy before the screen is ever consulted",
      );
    });

    it('lets an "Action Required" title override a screen that alone reads as idle', () => {
      const target = `${session}:idle`;
      execFileSync("tmux", ["select-pane", "-t", target, "-T", "codex-cwd"]);
      assert.equal(codexPaneChoiceCheck(target).awaitingChoice, false, "screen alone: nothing here looks like a dialog");
      execFileSync("tmux", ["select-pane", "-t", target, "-T", "[ ! ] Action Required | codex-cwd"]);
      assert.equal(
        codexPaneChoiceCheck(target).awaitingChoice,
        true,
        "the bracket marker is measured-unstable (todo 523: [ . ] once, [ ! ] once) - only the substring is trusted",
      );
    });
  },
);

describe(
  "codex's input-box state against a real, live-typed pane (todo 523)",
  { skip: hasTmux ? false : "tmux is not installed" },
  () => {
    const session = `hive-codex-box-${process.pid}`;
    const script = join(tmp, "fake-codex-repl.sh");

    before(() => {
      if (!hasTmux) return;
      // Redraws the whole box on every keystroke, footer included, exactly the shape
      // findCodexPromptBox anchors on - a real per-keystroke cursor, not a one-time print.
      writeFileSync(
        script,
        [
          "#!/bin/bash",
          'buf=""',
          "draw() {",
          "  clear",
          "  printf '\\n\\xe2\\x80\\xba %s\\n\\n  Context 0%% used \\xc2\\xb7 weekly 100%% left \\xc2\\xb7 0 in \\xc2\\xb7 0 out \\xc2\\xb7 fake-model default\\n' \"$buf\"",
          "}",
          "draw",
          "while IFS= read -r -n1 c; do",
          '  buf="$buf$c"',
          "  draw",
          "done",
          "",
        ].join("\n"),
      );
      chmodSync(script, 0o755);
      execFileSync("tmux", ["new-session", "-d", "-s", session, "-x", "100", "-y", "20", script]);
    });

    after(() => cleanup(session));

    it("reads empty, then reads exactly what was typed, live, as more is typed", async () => {
      const target = session;
      await until(() => codexPaneHasInputBox(target) === true);
      assert.deepEqual(codexInputBoxState(target), { state: "empty", text: "" });

      execFileSync("tmux", ["send-keys", "-t", target, "-l", "hello"]);
      await until(() => codexInputBoxState(target)?.text === "hello");
      assert.deepEqual(codexInputBoxState(target), { state: "pending", text: "hello" });

      // The differential proof this is a live cursor, not a static replay (dead-ends
      // 2026-08-14): a fixture printed once could never pick up a second round of keystrokes.
      execFileSync("tmux", ["send-keys", "-t", target, "-l", " world"]);
      await until(() => codexInputBoxState(target)?.text === "hello world");
      assert.deepEqual(codexInputBoxState(target), { state: "pending", text: "hello world" });
    });

    it("waitForPaneInput resolves once codex's own readiness predicate sees the box, not claude's", async () => {
      assert.equal(await waitForPaneInput(session, 3000, codexPaneHasInputBox), true);
    });
  },
);
