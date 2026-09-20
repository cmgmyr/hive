import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { REPO, isolateTmux, liveAgentRow, makeFakeClaude, McpClient, scratchDirs, until } from "./helpers.mjs";

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

    await until(async () => {
      const got = await mcp.call("wake_get", { wake_id: wake.wake_id });
      return got.fire_count >= 1 && got.typed_at != null;
    }, 10000);

    db.prepare("UPDATE wakes SET first_held_at = datetime('now') WHERE id = ?").run(wake.wake_id);
    const seeded = await mcp.call("wake_get", { wake_id: wake.wake_id });
    assert.ok(seeded.first_held_at != null, "the seed itself must have taken, or this test proves nothing");

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
