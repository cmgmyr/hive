import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { isolateTmux, makeFakeClaude, McpClient, REPO, scratchDirs, until } from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("the copy-mode guard tests");
const NEEDS_TMUX = { skip: hasTmux ? false : "tmux is not installed" };

const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { sessionName } = await import("../dist/tmux.js");

const FIXTURES = join(REPO, "test", "fixtures", "panes");
const fakeClaude = makeFakeClaude(dirs.tmp);
const replayFixture = (file) => `cat '${join(FIXTURES, file)}'; sleep 600`;

let mcp;

before(async () => {
  if (!hasTmux) return;
  execFileSync("tmux", ["new-session", "-d", "-s", sessionName(), "-x", "220", "-y", "60", "-c", dirs.projectDir]);
  mcp = new McpClient({ cwd: dirs.projectDir, dataDir: dirs.dataDir, env: { HIVE_SPAWN_READY_MS: "2000" } });
  await mcp.start();
});

after(async () => {
  if (mcp) await mcp.close();
  cleanup(sessionName());
});

async function spawnClaude(name) {
  const receipt = await mcp.call("agent_spawn", {
    name,
    command: fakeClaude(replayFixture("ready-idle.txt")),
    extra_args: [],
    placement: "window",
  });
  await until(async () => (await mcp.call("agent_output", { name })).output.trim() !== "");
  return receipt;
}

const enterCopyMode = (pane) => execFileSync("tmux", ["copy-mode", "-t", pane]);
const leaveCopyMode = (pane) => execFileSync("tmux", ["send-keys", "-X", "-t", pane, "cancel"]);
const inMode = (pane) =>
  execFileSync("tmux", ["display-message", "-p", "-t", pane, "#{pane_in_mode}"], { encoding: "utf8" }).trim();

describe("a pane in tmux copy mode is not typed into, because a paste there loses its markers and its Enter", () => {
  it("agent_send's text path REFUSES, naming the state, and nothing reaches the pane", NEEDS_TMUX, async () => {
    const name = "copymode-send-refuse";
    const receipt = await spawnClaude(name);
    const pane = receipt.tmux_target;

    enterCopyMode(pane);
    assert.equal(inMode(pane), "1", "the fixture is meaningless unless the pane really entered copy mode");

    const sent = await mcp.call("agent_send", { name, text: "MARKERCOPY" });
    assert.equal(sent.sent, false, "a copy-mode pane silently mangles a long paste and swallows the Enter");
    assert.match(sent.note, /copy mode/i, "the refusal has to name the state, or nobody can clear it");

    const { output } = await mcp.call("agent_output", { name });
    assert.doesNotMatch(output, /MARKERCOPY/, "assert the PANE - the receipt is the handler's claim about itself");

    leaveCopyMode(pane);
    assert.equal(inMode(pane), "0");
    const after = await mcp.call("agent_send", { name, text: "MARKERCLEAR" });
    assert.notEqual(after.sent, false, "the refusal must be retriable: leaving copy mode has to unblock it");
  });

  it("wake delivery HOLDS instead of firing, so the wake survives to be delivered later", NEEDS_TMUX, async () => {
    const name = "copymode-wake-hold";
    const receipt = await spawnClaude(name);
    const pane = receipt.tmux_target;

    enterCopyMode(pane);
    assert.equal(inMode(pane), "1");

    await mcp.call("wake_set", { delay_seconds: 1, body: "MARKERWAKE", deliver_to: name });
    await until(async () => {
      const wakes = await mcp.call("wake_list", {});
      return /copy mode/i.test(JSON.stringify(wakes));
    }, 20000);

    const { output } = await mcp.call("agent_output", { name });
    assert.doesNotMatch(output, /MARKERWAKE/, "a held wake must not have been typed into the copy-mode pane");

    const wakes = await mcp.call("wake_list", {});
    const held = JSON.stringify(wakes);
    assert.match(held, /copy mode/i, "the hold has to say why, the way the dialog and unsubmitted-text holds do");

    leaveCopyMode(pane);
    await until(async () => /MARKERWAKE/.test((await mcp.call("agent_output", { name })).output), 20000);
    const delivered = await mcp.call("agent_output", { name });
    assert.match(
      delivered.output,
      /MARKERWAKE/,
      "a hold is a delay, not a drop - it must deliver once the mode is gone",
    );
  });

  it(
    "agent_send(keys: [\"-X\", \"cancel\"]) - the refusal's own named remedy - actually cancels copy mode " +
      "instead of typing the literal string \"-Xcancel\" into the pane",
    NEEDS_TMUX,
    async () => {
      const name = "copymode-keys-cancel";
      const receipt = await spawnClaude(name);
      const pane = receipt.tmux_target;

      enterCopyMode(pane);
      assert.equal(inMode(pane), "1", "the fixture is meaningless unless the pane really entered copy mode");

      const sent = await mcp.call("agent_send", { name, keys: ["-X", "cancel"] });
      assert.equal(sent.sent, true, "the remedy is a keys send, not a refusal");

      assert.equal(inMode(pane), "0", "the pane must actually leave copy mode, not just report success");

      const { output } = await mcp.call("agent_output", { name });
      assert.doesNotMatch(
        output,
        /-Xcancel/,
        "\"--\" ends option parsing on the generic keys path, so \"-X\" arrives as a KEY NAME and types literally",
      );
      assert.doesNotMatch(output, /-X\b/, "no trace of the flag itself should land on the pane's input line");
    },
  );

  it(
    "agent_send(keys: [\"-X\", \"cancel\"]) on a pane that is NOT in copy mode is a silent no-op, " +
      "never a thrown tmux error and never typed text",
    NEEDS_TMUX,
    async () => {
      const name = "copymode-keys-cancel-noop";
      const receipt = await spawnClaude(name);
      const pane = receipt.tmux_target;

      assert.equal(inMode(pane), "0", "the pane must start out of copy mode for this case to mean anything");
      const before = (await mcp.call("agent_output", { name })).output;

      const sent = await mcp.call("agent_send", { name, keys: ["-X", "cancel"] });
      assert.equal(sent.sent, true, "the call must not throw just because there was nothing to cancel");

      assert.equal(inMode(pane), "0", "still not in copy mode");
      const after = (await mcp.call("agent_output", { name })).output;
      assert.equal(after, before, "nothing should be typed into a pane that was never in copy mode");
    },
  );
});
