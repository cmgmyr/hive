import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { REPO, isolateTmux, liveAgentRow, makeFakeClaude, McpClient, repaintPaneAsSameWorker, scratchDirs, until } from "./helpers.mjs";

// Todo 270. Chris's call 2026-08-05, after it bit him on both machines: he
// was typing into the lead's pane, a wake came due, and hive pasted the wake
// body after his half-typed text and pressed Enter, submitting both as one
// message. `deliverable()` (src/scheduler.ts) already held a wake against a
// pane sitting on a MODAL - this is that hold's sibling condition, for a
// pane whose input box is genuinely present but carries real unsubmitted
// text, which the modal check cannot see (a modal replaces the input box
// entirely; this is the opposite shape, box present, no dialog).
//
// Set a real wake against a real pane showing one of this project's own
// captured claude 2.1.220 screens, and read wake_list (the real MCP tool,
// through a real running server on its own natural scheduler tick) - the
// same method test/wake-delivery-state.test.mjs uses for the modal hold,
// applied to this sibling condition. Assert over wake_list's own held_at/
// typed_at, not a sample of pane content or agent_state - the timers row's
// own account of what happened, matching test/CLAUDE.md and
// .claude/rules/worker-state.md.
const { hasTmux, cleanup } = isolateTmux("the unsubmitted-input wake-hold tests");

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

async function spawnShowing(name, shellCommand) {
  const receipt = await mcp.call("agent_spawn", {
    name,
    command: fakeClaude(shellCommand),
    extra_args: [],
    placement: "window",
  });
  await liveAgentRow(mcp, name);
  return receipt;
}

const findWake = (wakes, wakeId) => wakes.find((w) => w.wake_id === wakeId);

describe(
  "the scheduler holds a wake against a pane with unsubmitted human text",
  { skip: hasTmux ? false : "tmux is not installed" },
  () => {
    it(
      "holds indefinitely while real-input.txt is up, never types, then delivers once the box clears",
      async () => {
        const spawned = await spawnShowing("unsubmitted-worker", replayFixture("real-input.txt"));

        const wake = await mcp.call("wake_set", {
          delay_seconds: 1,
          body: "INTEGRATION unsubmitted-input check",
          deliver_to: spawned.agent_id,
        });

        // Held: real-input.txt's own box carries genuine unsubmitted text
        // (issue #34's own honest control), so the scheduler must hold
        // rather than paste onto it. MUTATION 2's proof lives here - remove
        // the hold and this wake types within a tick or two instead of
        // sitting held.
        let held;
        await until(async () => {
          const list = await mcp.call("wake_list");
          held = findWake(list.wakes, wake.wake_id);
          return held?.held_at != null;
        }, 10000);
        assert.ok(held, "the wake must still be in the pending list while held");
        assert.match(
          held.held_reason,
          /unsubmitted/,
          "the reason must name what it is waiting on, not just that it is held",
        );
        assert.equal(held.typed_at, null, "nothing has been typed yet");

        // Stays held across several more ticks, not just the first one seen -
        // the accepted residual (no timeout, matching the dialog hold's own)
        // means this must not resolve on its own while the text is still up.
        await new Promise((resolve) => setTimeout(resolve, 3000));
        const stillHeld = await mcp.call("wake_list");
        const stillPending = findWake(stillHeld.wakes, wake.wake_id);
        assert.ok(stillPending?.held_at, "must still be held; nothing about this condition times out on its own");
        assert.equal(stillPending.typed_at, null, "still nothing typed");

        // Clear it by replacing the pane's screen with a genuinely empty
        // input box (ready-idle.txt), same pane id (tmux wipes the screen on
        // respawn) - the state change under test.
        repaintPaneAsSameWorker(db, spawned.tmux_target, replayFixture("ready-idle.txt"));

        let delivered;
        await until(async () => {
          const list = await mcp.call("wake_list");
          delivered = findWake(list.recently_delivered, wake.wake_id);
          return delivered?.typed_at != null;
        }, 10000);
        assert.ok(delivered.typed_at, "typed_at must be set once the box clears and delivery actually happens");
        assert.equal(delivered.held_at, null, "a resolved hold must stop being reported as current");
      },
    );

    // The negative controls: a ghost suggestion, the queued-messages hint,
    // and a genuinely empty box must NOT hold - a hold that fires on any of
    // these holds every idle pane forever, since ready-idle.txt's own empty
    // box is what a pane looks like between turns. MUTATION 1's proof lives
    // here - broaden the hold to ghost/empty and one of these three starts
    // sitting held instead of delivering.
    for (const file of ["ghost-suggestion.txt", "queued-hint.txt", "ready-idle.txt"]) {
      it(`does not hold against ${file}`, async () => {
        const spawned = await spawnShowing(`no-hold-${file}`, replayFixture(file));

        const wake = await mcp.call("wake_set", {
          delay_seconds: 1,
          body: `INTEGRATION no-hold check (${file})`,
          deliver_to: spawned.agent_id,
        });

        let delivered;
        await until(async () => {
          const list = await mcp.call("wake_list");
          delivered = findWake(list.recently_delivered, wake.wake_id);
          return delivered?.typed_at != null;
        }, 10000);
        assert.ok(delivered.typed_at, `${file} must not hold this wake - it must deliver promptly`);
        assert.equal(delivered.held_at, null, `${file} must never have been reported as held`);
      });
    }
  },
);
