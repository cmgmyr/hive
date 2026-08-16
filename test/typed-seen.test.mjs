import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import {
  REPO,
  fakeHangingTmux,
  isolateTmux,
  liveAgentRow,
  makeFakeClaude,
  McpClient,
  repaintPaneAsSameWorker,
  scratchDirs,
  until,
} from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("the typed_seen tests");

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

async function spawnShowing(name, shellCommand, client = mcp) {
  const receipt = await client.call("agent_spawn", {
    name,
    command: fakeClaude(shellCommand),
    extra_args: [],
    placement: "window",
  });
  await liveAgentRow(client, name);
  return receipt;
}

const findWake = (wakes, wakeId) => wakes.find((w) => w.wake_id === wakeId);

describe("typed_seen records what deliverable() saw at delivery time", { skip: hasTmux ? false : "tmux is not installed" }, () => {
  it(
    "records live=yes pid=ok dialog=no box=empty on an ordinary delivery",
    async () => {

      const spawned = await spawnShowing("typed-seen-idle", replayFixture("ready-idle.txt"));

      const wake = await mcp.call("wake_set", {
        delay_seconds: 1,
        body: "INTEGRATION typed_seen ordinary-delivery check",
        deliver_to: spawned.agent_id,
      });

      let delivered;
      await until(async () => {
        const list = await mcp.call("wake_list");
        delivered = findWake(list.recently_delivered, wake.wake_id);
        return delivered?.typed_at != null;
      }, 10000);

      assert.match(
        delivered.typed_seen,
        /^live=yes pid=ok dialog=no box=empty$/,
        "an idle, real claude pane with a live, freshly-recorded pid must read ok and box=empty",
      );

      const got = await mcp.call("wake_get", { wake_id: wake.wake_id });
      assert.equal(got.typed_seen, delivered.typed_seen, "wake_get must report the identical value wake_list does");
    },
  );

  it(
    "is still written on a delivery that follows a real hold, not only on an immediate one",
    async () => {

      const spawned = await spawnShowing("typed-seen-held", replayFixture("real-input.txt"));

      const wake = await mcp.call("wake_set", {
        delay_seconds: 1,
        body: "INTEGRATION typed_seen post-hold delivery check",
        deliver_to: spawned.agent_id,
      });

      let held;
      await until(async () => {
        const list = await mcp.call("wake_list");
        held = findWake(list.wakes, wake.wake_id);
        return held?.held_at != null;
      }, 10000);
      assert.ok(held, "the wake must be held first, or this test is not exercising the post-hold path");
      assert.equal(held.typed_seen, null, "nothing has been judged safe to type yet, so nothing is recorded");

      const heldGet = await mcp.call("wake_get", { wake_id: wake.wake_id });
      assert.ok(heldGet.first_held_at != null, "a wake that is visibly held must have a first_held_at recorded");

      repaintPaneAsSameWorker(db, spawned.tmux_target, replayFixture("ready-idle.txt"));

      let delivered;
      await until(async () => {
        const list = await mcp.call("wake_list");
        delivered = findWake(list.recently_delivered, wake.wake_id);
        return delivered?.typed_at != null;
      }, 10000);

      assert.match(
        delivered.typed_seen,
        /^live=yes pid=ok dialog=no box=empty$/,
        "once the hold clears and delivery actually happens, typed_seen must be populated exactly as an unheld delivery's is",
      );
      assert.equal(delivered.held_at, null, "a resolved hold must stop being reported as current (unchanged behaviour)");

      const deliveredGet = await mcp.call("wake_get", { wake_id: wake.wake_id });
      assert.ok(
        deliveredGet.first_held_at != null,
        "a delivery that followed a real hold must still show first_held_at after delivery, unlike an immediate one",
      );
    },
  );

  it(
    "records box=absent for a pane with no detectable input box at all",
    async () => {

      const spawned = await spawnShowing(
        "typed-seen-no-box",
        `printf 'building the thing\\nplease wait\\n'; sleep 600`,
      );

      const wake = await mcp.call("wake_set", {
        delay_seconds: 1,
        body: "INTEGRATION typed_seen no-box check",
        deliver_to: spawned.agent_id,
      });

      let delivered;
      await until(async () => {
        const list = await mcp.call("wake_list");
        delivered = findWake(list.recently_delivered, wake.wake_id);
        return delivered?.typed_at != null;
      }, 10000);

      assert.match(
        delivered.typed_seen,
        /^live=yes pid=ok dialog=no box=absent$/,
        "a screen with no box chrome at all must read box=absent, not box=empty",
      );
    },
  );

  it(
    "records pid=no-fact when the agents row carries no pane_pid, even though the pane is genuinely live",
    async () => {

      const spawned = await spawnShowing("typed-seen-no-pid", replayFixture("ready-idle.txt"));

      const wake = await mcp.call("wake_set", {
        delay_seconds: 1,
        body: "INTEGRATION typed_seen no-pid check",
        deliver_to: spawned.agent_id,
      });

      db.prepare("UPDATE agents SET pane_pid = '' WHERE tmux_target = ?").run(spawned.tmux_target);

      let delivered;
      await until(async () => {
        const list = await mcp.call("wake_list");
        delivered = findWake(list.recently_delivered, wake.wake_id);
        return delivered?.typed_at != null;
      }, 10000);

      assert.match(
        delivered.typed_seen,
        /^live=yes pid=no-fact dialog=no box=empty$/,
        "a live pane whose agents row carries no recorded pid must read pid=no-fact, not pid=ok",
      );
    },
  );

  it(
    "records dialog=unknown when the tmux probe itself fails, not dialog=no",
    async () => {

      const soloDirs = scratchDirs();
      const fakeDir = fakeHangingTmux({ hangOn: "capture-pane" });

      const savedDataDir = process.env.HIVE_DATA_DIR;
      process.env.HIVE_DATA_DIR = soloDirs.dataDir;
      const soloSession = sessionName();
      process.env.HIVE_DATA_DIR = savedDataDir;
      execFileSync("tmux", [
        "new-session", "-d", "-s", soloSession, "-x", "220", "-y", "50", "-c", soloDirs.projectDir,
      ]);
      const dedicated = new McpClient({
        cwd: soloDirs.projectDir,
        dataDir: soloDirs.dataDir,
        env: {
          PATH: `${fakeDir}:${process.env.PATH}`,
          HIVE_TMUX_TIMEOUT_MS: "300",
          HIVE_SPAWN_READY_MS: "500",
        },
      });
      try {
        await dedicated.start();
        const spawned = await spawnShowing("typed-seen-probe-fails", replayFixture("ready-idle.txt"), dedicated);

        const wake = await dedicated.call("wake_set", {
          delay_seconds: 1,
          body: "INTEGRATION typed_seen probe-failure check",
          deliver_to: spawned.agent_id,
        });

        let delivered;
        await until(async () => {
          const list = await dedicated.call("wake_list");
          delivered = findWake(list.recently_delivered, wake.wake_id);
          return delivered?.typed_at != null;
        }, 15000);

        assert.match(
          delivered.typed_seen,
          /^live=yes pid=ok dialog=unknown box=absent$/,
          "a failing tmux probe must read dialog=unknown - the guard could not check, which is not the same claim as checking and finding no dialog",
        );
      } finally {
        await dedicated.close();
        cleanup(soloSession);
        rmSync(fakeDir, { recursive: true, force: true });
      }
    },
  );
});
