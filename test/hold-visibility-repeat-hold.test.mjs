import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { REPO, isolateTmux, liveAgentRow, makeFakeClaude, McpClient, repaintPaneAsSameWorker, scratchDirs, until } from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("the hold-visibility repeat-hold test");

const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { db } = await import("../dist/db.js");
const { sessionName } = await import("../dist/tmux.js");

const FIXTURES = join(REPO, "test", "fixtures", "panes");
const fixturePath = (file) => join(FIXTURES, file);
const replayFixture = (file) => `cat '${fixturePath(file)}'; sleep 600`;

let mcp;

before(async () => {
  mcp = new McpClient({ cwd: dirs.projectDir, dataDir: dirs.dataDir, env: { HIVE_SPAWN_READY_MS: "2000" } });
  await mcp.start();
  if (!hasTmux) return;
  execFileSync("tmux", [
    "new-session", "-d", "-s", sessionName(), "-x", "220", "-y", "50", "-c", dirs.projectDir,
  ]);
});

after(async () => {
  await mcp.close();
  cleanup(sessionName());
});

const fakeClaude = makeFakeClaude(dirs.tmp);

describe("first_held_at survives delivery on a repeating wake's own held cycle", { skip: hasTmux ? false : "tmux is not installed" }, () => {
  it("a repeating wake genuinely held on the cycle that then delivers reports first_held_at afterwards", async () => {

    const spawned = await mcp.call("agent_spawn", {
      name: "repeat-hold-unsubmitted",
      command: fakeClaude(replayFixture("real-input.txt")),
      extra_args: [],
      placement: "window",
    });
    await liveAgentRow(mcp, "repeat-hold-unsubmitted");

    const wake = await mcp.call("wake_set", {
      delay_seconds: 1,
      repeat_every_seconds: 3,
      body: "INTEGRATION hold-visibility repeat-hold check",
      deliver_to: spawned.agent_id,
    });

    let held;
    await until(async () => {
      held = await mcp.call("wake_get", { wake_id: wake.wake_id });
      return held.held_at != null;
    }, 10000);
    assert.ok(held.held_at, "the wake must be held first, or this test is not exercising the post-hold path");
    assert.ok(held.first_held_at != null, "first_held_at must already be recording the hold while it is still live");
    assert.equal(held.fire_count, 0, "cycle 1 must not have delivered yet, or the hold never engaged");

    repaintPaneAsSameWorker(db, spawned.tmux_target, replayFixture("ready-idle.txt"));

    let delivered;
    await until(async () => {
      delivered = await mcp.call("wake_get", { wake_id: wake.wake_id });
      return delivered.fire_count >= 1 && delivered.typed_at != null;
    }, 10000);

    assert.ok(
      delivered.first_held_at != null,
      "a REPEATING wake held on the cycle that then delivers must still show first_held_at after that " +
        "delivery - the reset opening the next cycle must not outrun deliver()'s own record of this one",
    );
    assert.equal(delivered.held_at, null, "a resolved hold must stop being reported as current (unchanged behaviour)");

    await mcp.call("wake_cancel", { wake_id: wake.wake_id });
  });
});
