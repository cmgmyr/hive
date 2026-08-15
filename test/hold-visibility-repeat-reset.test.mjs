import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { REPO, isolateTmux, liveAgentRow, makeFakeClaude, McpClient, scratchDirs, until } from "./helpers.mjs";

// Todo 409, edge 1 - the half of the lane that is not in the todo's own text.
// first_held_at (src/db.ts's migration; src/scheduler.ts's TimerRow) is a
// per-CYCLE fact: the first tick a wake was held this cycle. A repeating
// wake reuses one row across many deliveries, and the per-cycle reset UPDATE
// in fireDelay (src/scheduler.ts, next to typed_at/confirmed_at/held_at/
// held_reason/typed_busy/typed_seen) is what clears it BETWEEN cycles -
// deliver() then re-writes it for THIS cycle from the value it captured
// before that claim ran (see test/hold-visibility-repeat-hold.test.mjs for
// that half, a genuine hold on the cycle that delivers). This test is the
// other half: the reset itself, proving cycle 1's hold does not leak into
// cycle 2's report once cycle 2 has nothing holding it.
//
// Miss the reset and a wake held once is reported as held on every fire after
// it, forever: a stale hold from a morning cycle would read as evidence a
// cycle fired hours later was also held. This test seeds that stale record
// directly after a real cycle 1 delivers, then asserts a real cycle 2 -
// delivered with nothing holding it - reports no hold at all.
const { hasTmux, cleanup } = isolateTmux("the hold-visibility repeat-reset test");

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

describe("first_held_at resets per repeating-wake cycle", { skip: hasTmux ? false : "tmux is not installed" }, () => {
  it("a hold recorded on cycle 1 must not be reported on cycle 2", async () => {
    const spawned = await mcp.call("agent_spawn", {
      name: "repeat-reset-idle",
      command: fakeClaude(replayFixture("ready-idle.txt")),
      extra_args: [],
      placement: "window",
    });
    await liveAgentRow(mcp, "repeat-reset-idle");

    const wake = await mcp.call("wake_set", {
      delay_seconds: 1,
      repeat_every_seconds: 2,
      body: "INTEGRATION hold-visibility repeat-reset check",
      deliver_to: spawned.agent_id,
    });

    // Cycle 1: an ordinary immediate delivery against an idle pane, nothing
    // holds it. Wait for it to actually deliver before seeding the stale
    // hold record below, or the seed could be overwritten by the very
    // reset it is trying to prove works.
    await until(async () => {
      const got = await mcp.call("wake_get", { wake_id: wake.wake_id });
      return got.fire_count >= 1 && got.typed_at != null;
    }, 10000);

    // Simulate what a REAL hold on cycle 1 would have left behind - the
    // shape holdTimer()/claimModalHoldWithNotice() write - directly, rather
    // than orchestrating a genuine dialog or unsubmitted-input hold on a
    // repeating timer (test/hold-visibility-repeat-hold.test.mjs covers a
    // real hold on a repeating cycle end to end). What matters here is only
    // whether the NEXT cycle's claim clears it.
    db.prepare("UPDATE timers SET first_held_at = datetime('now') WHERE id = ?").run(wake.wake_id);
    const seeded = await mcp.call("wake_get", { wake_id: wake.wake_id });
    assert.ok(seeded.first_held_at != null, "the seed itself must have taken, or this test proves nothing");

    // Cycle 2: repeat_every_seconds later, against the same idle pane.
    // Nothing holds this cycle either.
    await until(async () => {
      const got = await mcp.call("wake_get", { wake_id: wake.wake_id });
      return got.fire_count >= 2 && got.typed_at != null;
    }, 10000);

    const afterCycle2 = await mcp.call("wake_get", { wake_id: wake.wake_id });
    assert.equal(
      afterCycle2.first_held_at,
      null,
      "cycle 1's hold record must not survive into cycle 2's report - the per-cycle reset must clear it",
    );

    await mcp.call("wake_cancel", { wake_id: wake.wake_id });
  });
});
