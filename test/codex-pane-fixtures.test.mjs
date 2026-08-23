import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { REPO, isolateTmux, until } from "./helpers.mjs";

// Real captures off a live codex-cli 0.146.0 pane, private tmux socket, torn down after (todo 523).
// Replayed into a real tmux pane (cat file; sleep) so the exported, target-based functions under
// test - codexPaneChoiceCheck, codexPaneHasInputBox, codexInputBoxState - read exactly the same
// capture-pane call path a live worker's pane would go through, the same technique
// pane-fixtures.test.mjs and input-box.test.mjs use for claude's own screens.
const { hasTmux, cleanup } = isolateTmux("the codex pane fixture tests");

const { codexInputBoxState, codexPaneChoiceCheck, codexPaneHasInputBox } = await import("../dist/tmux.js");

const FIXTURES = join(REPO, "test", "fixtures", "panes");

const CHOICE_CASES = [
  {
    file: "codex-directory-trust-dialog.txt",
    name: "dir-trust",
    marker: "Press enter to continue",
    awaitingChoice: true,
    hasInputBox: false,
  },
  {
    file: "codex-sandbox-approval-dialog.txt",
    name: "approval",
    marker: "Press enter to confirm or esc to cancel",
    awaitingChoice: true,
    hasInputBox: false,
  },
  {
    file: "codex-idle-ghost.txt",
    name: "idle-ghost",
    marker: "Summarize recent commits",
    awaitingChoice: false,
    hasInputBox: true,
  },
  {
    file: "codex-idle-pending.txt",
    name: "idle-pending",
    marker: "check the current git status",
    awaitingChoice: false,
    hasInputBox: true,
  },
  {
    file: "codex-multiline-pending.txt",
    name: "multiline-pending",
    marker: "line three",
    awaitingChoice: false,
    hasInputBox: true,
  },
  {
    file: "codex-production-idle-ghost.txt",
    name: "production-idle",
    marker: "Write tests for @filename",
    awaitingChoice: false,
    hasInputBox: true,
  },
  {
    file: "codex-unpredictable-footer.txt",
    name: "unpredictable-footer",
    marker: "Summarize recent commits",
    awaitingChoice: false,
    hasInputBox: true,
  },
  {
    file: "codex-stale-prompt-scrollback.txt",
    name: "stale-prompt",
    marker: "creating the requested file now",
    awaitingChoice: false,
    hasInputBox: false,
  },
];

describe(
  "codexPaneChoiceCheck and codexPaneHasInputBox against real codex 0.146.0 screens",
  { skip: hasTmux ? false : "tmux is not installed" },
  () => {
    const session = `hive-codexchoice-${process.pid}`;

    before(() => {
      if (!hasTmux) return;
      CHOICE_CASES.forEach(({ file, name }, i) => {
        const fixture = join(FIXTURES, file);
        const cmd = `cat '${fixture}'; sleep 600`;
        if (i === 0) {
          execFileSync("tmux", ["new-session", "-d", "-s", session, "-n", name, "-x", "220", "-y", "50", cmd], {
            stdio: "ignore",
          });
        } else {
          execFileSync("tmux", ["new-window", "-d", "-t", `=${session}`, "-n", name, cmd], { stdio: "ignore" });
        }
      });
    });

    after(() => cleanup(session));

    for (const { name, marker, awaitingChoice, hasInputBox } of CHOICE_CASES) {
      it(`reads ${name} as awaitingChoice=${awaitingChoice}, hasInputBox=${hasInputBox}`, async () => {
        const target = `${session}:${name}`;
        await until(() => execFileSync("tmux", ["capture-pane", "-p", "-t", target]).toString().includes(marker));

        assert.equal(codexPaneChoiceCheck(target).awaitingChoice, awaitingChoice);
        assert.equal(codexPaneHasInputBox(target), hasInputBox);
      });
    }
  },
);

const STATE_CASES = [
  {
    file: "codex-idle-ghost-e.txt",
    name: "ghost",
    marker: "Summarize recent commits",
    expect: { state: "ghost", text: "Summarize recent commits" },
  },
  {
    file: "codex-idle-pending-e.txt",
    name: "pending",
    marker: "check the current git status",
    expect: { state: "pending", text: "check the current git status" },
  },
  {
    file: "codex-multiline-pending-e.txt",
    name: "multiline",
    marker: "line three",
    expect: { state: "pending", text: "check the current git statusline one line two line three" },
  },
  {
    file: "codex-production-idle-ghost-e.txt",
    name: "production-idle",
    marker: "Write tests for @filename",
    expect: { state: "ghost", text: "Write tests for @filename" },
  },
];

describe(
  "codexInputBoxState against real codex 0.146.0 screens",
  { skip: hasTmux ? false : "tmux is not installed" },
  () => {
    const session = `hive-codexstate-${process.pid}`;

    before(() => {
      if (!hasTmux) return;
      STATE_CASES.forEach(({ file, name }, i) => {
        const fixture = join(FIXTURES, file);
        const cmd = `cat '${fixture}'; sleep 600`;
        if (i === 0) {
          execFileSync("tmux", ["new-session", "-d", "-s", session, "-n", name, "-x", "220", "-y", "50", cmd], {
            stdio: "ignore",
          });
        } else {
          execFileSync("tmux", ["new-window", "-d", "-t", `=${session}`, "-n", name, cmd], { stdio: "ignore" });
        }
      });
    });

    after(() => cleanup(session));

    for (const { name, marker, expect } of STATE_CASES) {
      it(`reads ${name} as ${JSON.stringify(expect)}`, async () => {
        const target = `${session}:${name}`;
        await until(() => execFileSync("tmux", ["capture-pane", "-p", "-t", target]).toString().includes(marker));

        assert.deepEqual(codexInputBoxState(target), expect);
      });
    }
  },
);
