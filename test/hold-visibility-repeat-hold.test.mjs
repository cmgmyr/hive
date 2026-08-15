import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { REPO, isolateTmux, liveAgentRow, makeFakeClaude, McpClient, repaintPaneAsSameWorker, scratchDirs, until } from "./helpers.mjs";

// Todo 409, round 2, finding 1 - the gap the round-1 test suite did not
// cover. test/typed-seen.test.mjs's own post-hold case proves first_held_at
// survives delivery for a ONE-SHOT wake, whose claim (claimOneShot) never
// touches first_held_at at all - so that test cannot see the defect a
// REPEATING wake has: fireDelay's own per-cycle claim UPDATE resets
// first_held_at as part of opening the next cycle, and that claim runs
// BEFORE deliver() - so a repeating wake held for several ticks and then
// delivered had its hold record wiped microseconds before the delivery
// could record it. Proven red against the pre-fix code (git stash the
// firstHeldAt threading through deliverable()/deliver() and rerun): wake_get
// reported first_held_at: null after a delivery that had genuinely been
// held, identical to an unheld delivery's.
//
// The fix threads the hold record through the same way typedSeen already
// is - captured off the row before the claim, passed into deliver(), and
// written back by recordTyped - but gated on held_at (not first_held_at
// itself) to avoid resurrecting a stale value from an earlier cycle; see
// test/hold-visibility-repeat-reset.test.mjs for that half. This test is the
// positive case those two do not cover between them: a GENUINE hold on the
// cycle that then delivers, on a REPEATING wake specifically.
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
    // real-input.txt carries genuine unsubmitted text, which
    // deliverable()'s own unsubmitted-input hold (holdTimer) holds against -
    // the same fixture and mechanism test/wake-hold-unsubmitted-input.test.mjs
    // and typed-seen.test.mjs's post-hold case already use, applied here to
    // a REPEATING wake for the first time.
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

    // Cycle 1 becomes due and holds: the pane's unsubmitted text is up, so
    // deliverable() holds every tick until the box clears.
    let held;
    await until(async () => {
      held = await mcp.call("wake_get", { wake_id: wake.wake_id });
      return held.held_at != null;
    }, 10000);
    assert.ok(held.held_at, "the wake must be held first, or this test is not exercising the post-hold path");
    assert.ok(held.first_held_at != null, "first_held_at must already be recording the hold while it is still live");
    assert.equal(held.fire_count, 0, "cycle 1 must not have delivered yet, or the hold never engaged");

    // Clear the box, matching the one-shot post-hold test's own method:
    // repaint the same pane to an idle screen so deliverable() stops
    // holding and cycle 1 finally delivers.
    repaintPaneAsSameWorker(db, spawned.tmux_target, replayFixture("ready-idle.txt"));

    let delivered;
    await until(async () => {
      delivered = await mcp.call("wake_get", { wake_id: wake.wake_id });
      return delivered.fire_count >= 1 && delivered.typed_at != null;
    }, 10000);

    // THE ACTUAL FINDING. Round 1's fix left this null - the reset that
    // opens the next cycle runs before deliver() records the delivery, so
    // "deliver() never clears it" was not enough on its own.
    assert.ok(
      delivered.first_held_at != null,
      "a REPEATING wake held on the cycle that then delivers must still show first_held_at after that " +
        "delivery - the reset opening the next cycle must not outrun deliver()'s own record of this one",
    );
    assert.equal(delivered.held_at, null, "a resolved hold must stop being reported as current (unchanged behaviour)");

    await mcp.call("wake_cancel", { wake_id: wake.wake_id });
  });
});
