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

// Todo 407, pad 142 PART 2. Before this column, a delivery that decided to
// TYPE wrote nothing about what it saw - held_reason covers a HOLD, and
// deliver() clears held_at/held_reason on the very write that records
// success, so a wake held for ten minutes and one that was never held read
// as byte-identical rows once delivered (todo 389's incident). typed_seen is
// deliverable()'s own four facts, in the order it computes them, encoded as
// a short fixed vocabulary and written into the UPDATE deliver() already
// runs - see src/scheduler.ts's DeliverableResult and src/db.ts's migration
// for the full argument.
//
// Set a real wake against a real pane and read wake_list/wake_get (the real
// MCP tools, through a real running server on its own natural scheduler
// tick) - the same method test/wake-delivery-state.test.mjs and
// test/wake-hold-unsubmitted-input.test.mjs use for the sibling columns this
// one sits beside.
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
      // MUTATION: revert deliver()'s UPDATE to drop `typed_seen = ?` (the
      // pre-todo-407 shape). typed_seen stays NULL forever and this
      // assert.match throws on null. Proven red against that revert before
      // writing the fix; see todo 407's own comments for the run.
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

      // wake_get carries the same fact, untruncated - the receipt pad 142
      // names as this column's whole reason to ride along verbatim.
      const got = await mcp.call("wake_get", { wake_id: wake.wake_id });
      assert.equal(got.typed_seen, delivered.typed_seen, "wake_get must report the identical value wake_list does");
    },
  );

  it(
    "is still written on a delivery that follows a real hold, not only on an immediate one",
    async () => {
      // Reuses test/wake-hold-unsubmitted-input.test.mjs's own scenario: a
      // pane holding genuine unsubmitted text holds the wake, then delivers
      // once the box clears. This exercises fireDelay's post-hold branch,
      // the second of deliverable()'s three call sites, not only the
      // first-tick path the test above covers.
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
    },
  );

  it(
    "records box=absent for a pane with no detectable input box at all",
    async () => {
      // THE FIFTH BOX VALUE IS THE WHOLE POINT (pad 142), AND IT HAS THREE
      // CAUSES (see deliverable()'s own box comment, src/scheduler.ts). This
      // test exercises ONE of the three: a pane with no recognisable claude
      // chrome at all - here, a fake claude binary that just echoes plain
      // text, the same shape tmux-and-panes.md calls "THIS PROTECTION IS
      // CLAUDE-CHROME-SHAPED" - not a drifted claude pane and not a failed
      // read. A reader seeing box=absent on a real delivery cannot tell
      // which of the three it is without first checking whether the pane
      // even runs claude; this fixture is deliberately the "it never did"
      // case, not the drift case pad 142 Part 1 diagnosed.
      //
      // MUTATION: swap the box mapping in deliverable() so `boxState ===
      // null` reads "empty" instead of "absent" (collapsing the fifth value
      // into the fourth). The test above ("ordinary delivery") still passes
      // unchanged - both would read box=empty - but this one dies, because
      // it is the only test in this file that can tell "absent" and "empty"
      // apart. Run: swap the ternary branch, `npm run build`, re-run this
      // file; the mutation must fail exactly this test.
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
      // FIX 1 (counselors, fix round 2): the pid branch was production-
      // reachable and pinned by nothing - `const pid = "ok";` killed no test
      // here, because every other spawned worker in this file has a
      // freshly-recorded, matching pid, so "ok" is what they would all read
      // anyway regardless of whether the ternary is real.
      //
      // `deliver_pane_pid` is `COALESCE(agents.pane_pid, '')` over a LEFT
      // JOIN keyed on deliver_actor (src/scheduler.ts, DELIVER_SOCKET_JOIN) -
      // a wake owned by a plain `user:` session with no agents row, or one
      // whose worker row has closed, misses that join and reads ''. This
      // test reproduces the SAME join-miss shape directly (blanking
      // agents.pane_pid for a real, live worker) rather than constructing a
      // rowless actor, because the fact under test is what deliverable()
      // does with an empty recorded pid against a genuinely live pane, not
      // how a rowless actor gets there.
      //
      // MUTATION: replace the pid ternary with `const pid = "ok";`. Dies
      // here and only here - this is the only test in the file with a
      // blanked agents.pane_pid.
      const spawned = await spawnShowing("typed-seen-no-pid", replayFixture("ready-idle.txt"));

      const wake = await mcp.call("wake_set", {
        delay_seconds: 1,
        body: "INTEGRATION typed_seen no-pid check",
        deliver_to: spawned.agent_id,
      });

      // Blanks the RECORDED pid while the real tmux pane stays alive and
      // unchanged - the exact "cannot judge identity" shape paneReissued()
      // itself already treats as no-fact rather than as a mismatch.
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
      // FIX 1 (counselors, fix round 2): the dialog branch was equally
      // unpinned - `const dialog = "no";` killed no test here either, for
      // the identical reason: every other delivery in this file reads a
      // real, successful capture-pane, so "no" is what they would all read
      // regardless of whether the ternary is real.
      //
      // paneAwaitingChoice (src/tmux.ts) returns null from a bare catch on
      // ANY throw, including the real 10s TmuxTimeoutError a wedged tmux
      // server produces. This test forces exactly that: a fake tmux binary
      // that hangs on capture-pane and forwards every other subcommand
      // (list-panes, split-window, ...) to the real one, paired with a short
      // HIVE_TMUX_TIMEOUT_MS so the hang resolves to a timeout in
      // milliseconds rather than the real 10s bound. Liveness and pid both
      // read through list-panes (rowAliveProbe/targetLiveProbe), never
      // capture-pane, so they are unaffected and this delivery still
      // proceeds - it is ONLY the dialog and box reads that fail.
      //
      // A DEDICATED STORE, NOT ONLY A DEDICATED CLIENT, AND THIS IS THE PART
      // THAT WAS WRONG THE FIRST TIME THIS TEST WAS WRITTEN. "Every hive MCP
      // server instance runs this scheduler... As long as any session with
      // hive is open, timers fire" (src/scheduler.ts's own header) is not
      // decoration - the file's shared `mcp` client is itself a live server,
      // ticking against the SAME database, the whole time this test runs.
      // Pointing a hung-tmux client at the SHARED dataDir does not isolate
      // anything: the shared server's own healthy tmux wins the atomic claim
      // first and delivers the wake with a real capture-pane, and this test
      // was measured green-for-the-wrong-reason that way - reading
      // dialog=no, from the OTHER server. A dedicated scratch dataDir (and
      // therefore a dedicated, differently-tagged tmux session -
      // .claude/rules/tmux-and-panes.md, "tmux session names are namespaced
      // by data store") makes the hung server the ONLY server that can ever
      // see this wake at all.
      //
      // MUTATION: replace the dialog ternary with `const dialog = "no";`.
      // Dies here and only here - this is the only test in the file whose
      // tmux probe genuinely fails rather than genuinely answering.
      const soloDirs = scratchDirs();
      const fakeDir = fakeHangingTmux({ hangOn: "capture-pane" });
      // sessionName() reads HIVE_DATA_DIR at call time (store-and-datadir.md)
      // rather than caching it, so the swap has to bracket this one call -
      // restored in the finally below regardless of what happens in between.
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

        // box=absent is the same failed-read route inputBoxState's own
        // try/catch takes (route 3 of the three the box comment now names),
        // not the fifth-value drift case - deterministic here, not
        // incidental, since inputBoxHoldsWake always runs and always caches
        // its result before deliverable() reads it back.
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
