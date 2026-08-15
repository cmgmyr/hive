import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { isolateTmux, makeFakeClaude, McpClient, REPO, scratchDirs, until } from "./helpers.mjs";

// TODO 418, agent_rename's own version of todo 414's fix for agent_send.
// sendText (src/tmux.ts) is a PASTE and then, ENTER_DELAY_MS later, a
// SEPARATE tmux call for the Enter. Before this lane, agent_rename's catch
// asserted a cause it never checked ("Pane died between the liveness check
// and the keystrokes") for EVERY sendText failure, so a paste that landed
// with only the Enter failing returned `retitled: false` and NO note at
// all - worse than the bare tmux error a caller would have seen before
// todo 386 even built onPasted.
//
// UNLIKE todo 414, this is a NOTE, not a throw. agent_rename sends one
// fixed, short command to a claude pane only, and a retry is already
// refused on both paths that could send one (holdsHumanInput's pending-box
// guard on the next agent_rename, and agent_send's own text path on the
// same predicate) - see the code comment at the fix itself. So the only
// thing missing was the receipt's truthfulness, not a stronger refusal.
//
// THE SHIM IS test/agent-send-partial.test.mjs's, reused rather than
// rebuilt: same env-var toggles, same reasoning for using a real tmux
// rather than killing the pane mid-gap.
const { hasTmux, cleanup } = isolateTmux("the agent_rename partial-send tests");
const NEEDS_TMUX = { skip: hasTmux ? false : "tmux is not installed" };

const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { sessionName } = await import("../dist/tmux.js");

const realTmux = hasTmux ? execFileSync("which", ["tmux"], { encoding: "utf8" }).trim() : "/usr/bin/false";
const shimDir = mkdtempSync(join(tmpdir(), "hive-renamepartial-"));
writeFileSync(
  join(shimDir, "tmux"),
  `#!/bin/sh
# HIVE_TEST_FAIL_ENTER: the submit only - \`send-keys -t <pane> Enter\`. The
# single-line paste (\`send-keys -l\`, /rename never carries a newline) is
# untouched.
if [ "$HIVE_TEST_FAIL_ENTER" = "1" ] && [ "$1" = "send-keys" ]; then
  for a in "$@"; do
    if [ "$a" = "Enter" ]; then echo "tmux: send-keys failed" >&2; exit 1; fi
  done
fi
# HIVE_TEST_FAIL_PASTE: the control. Fails the paste itself, before anything
# reaches the pane, so the pre-existing "nothing was sent" behaviour must
# stay untouched by this lane.
if [ "$HIVE_TEST_FAIL_PASTE" = "1" ] && [ "$1" = "send-keys" ]; then
  for a in "$@"; do
    if [ "$a" = "-l" ]; then echo "tmux: send-keys failed" >&2; exit 1; fi
  done
fi
exec ${realTmux} "$@"
`,
  { mode: 0o755 },
);
process.env.PATH = `${shimDir}:${process.env.PATH}`;

const FIXTURES = join(REPO, "test", "fixtures", "panes");
const fakeClaude = makeFakeClaude(dirs.tmp);
// 220 columns and placement "window": matches agent-send-partial.test.mjs's
// own reasoning - every fixture here was captured at 220, and a worker gets
// its own window so a tiled split does not shrink the pane the fixture's
// own box needs to classify.
const replayFixture = (file) => `cat '${join(FIXTURES, file)}'; sleep 600`;

let mcp; // The ordinary client: no HIVE_TEST_FAIL_ENTER/PASTE, so its own
// tmux calls (spawn, agent_output, agent_status) stay real throughout.

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
  return receipt.agent_id;
}

// A second, short-lived MCP server per failing call, spawned WITH its extra
// env baked in at process start - matches agent-send-partial.test.mjs's own
// callWithBrokenTmux, for the identical reason: toggling process.env in
// this file cannot reach a spawned server's own tmux calls.
async function callWithBrokenTmux(env, name, newName) {
  const failMcp = new McpClient({ cwd: dirs.projectDir, dataDir: dirs.dataDir, env });
  await failMcp.start();
  try {
    return await failMcp.call("agent_rename", { name, new_name: newName });
  } finally {
    await failMcp.close();
  }
}

describe("agent_rename tells the truth when the paste lands but the Enter fails (todo 418)", () => {
  it("reports retitled:false with a note naming the stranded text and the recovery keys", NEEDS_TMUX, async () => {
    const name = "rename418-truth";
    await spawnClaude(name);
    const newName = "rename418-truth-renamed";

    const receipt = await callWithBrokenTmux({ HIVE_TEST_FAIL_ENTER: "1" }, name, newName);

    assert.equal(receipt.retitled, false, "the Enter failed, so the pane was never actually retitled");
    assert.match(receipt.note, /Not retitled/i);
    assert.match(receipt.note, new RegExp(`/rename ${newName}`), "must name the exact stranded command");
    assert.match(receipt.note, /unsubmitted/i, "must say it is unsubmitted, not lost");
    assert.match(
      receipt.note,
      new RegExp(`agent_send\\(name: ${JSON.stringify(newName)}, keys: \\["Enter"\\]\\)`),
      "must name the exact call that finishes this delivery",
    );
    assert.match(
      receipt.note,
      new RegExp(`agent_send\\(name: ${JSON.stringify(newName)}, keys: \\["C-a", "C-k"\\]\\)`),
      "must also name the clear-the-line alternative",
    );
    assert.doesNotMatch(receipt.note, /not sent/i, "must never say the text was NOT sent - it was, that is the bug");

    // The row IS renamed either way; only the pane's own title was left
    // alone, same as the two guards above this one.
    assert.match(receipt.note, new RegExp(`"${newName}" now`));
    const status = await mcp.call("agent_status", { name: newName });
    assert.equal(status.name, newName, "the store's own name must already be the new one");

    // The paste really landed - without this the case is not the one this
    // lane closes.
    const { output } = await mcp.call("agent_output", { name: newName });
    assert.match(output, new RegExp(`/rename ${newName}`), "the /rename text must really be on screen, unsubmitted");
  });

  it("the tail it reports matches what is actually on screen", NEEDS_TMUX, async () => {
    const name = "rename418-tail";
    await spawnClaude(name);
    const newName = "rename418-tail-renamed";

    const receipt = await callWithBrokenTmux({ HIVE_TEST_FAIL_ENTER: "1" }, name, newName);

    assert.equal(typeof receipt.tail, "string");
    assert.match(receipt.tail, new RegExp(`/rename ${newName}`));
  });

  it("a paste that never lands (nothing reaches the pane) is untouched - no note, same as before this lane", NEEDS_TMUX, async () => {
    // CONTROL. DIES if the new branch is not gated on `pasted` actually
    // being set: a version that adds a note for every sendText failure,
    // not only the ones where the paste landed, would turn this
    // pre-existing "nothing happened" case into a false claim that text is
    // on screen.
    const name = "rename418-paste-failed";
    await spawnClaude(name);
    const newName = "rename418-paste-failed-renamed";

    const receipt = await callWithBrokenTmux({ HIVE_TEST_FAIL_PASTE: "1" }, name, newName);

    assert.equal(receipt.retitled, false);
    assert.equal(receipt.note, undefined, "no note - the pre-existing bare-catch behaviour for a genuine non-landing");
    assert.equal(receipt.tail, undefined);

    const { output } = await mcp.call("agent_output", { name: newName });
    assert.doesNotMatch(output, /\/rename/, "the text really never reached the pane in this case");
  });
});
