import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import {
  DIST,
  REPO,
  isolateTmux,
  liveAgentRow,
  makeFakeClaude,
  McpClient,
  repaintPaneAsSameWorker,
  runFixture,
  scratchDirs,
  until,
} from "./helpers.mjs";

// Todo 314, issue #28's fourth path. A wake held because its target pane is
// on a dialog now tells the wake's OWNER, once, instead of holding silently.
//
// Every assertion here is over a RECORD OF WHAT HAPPENED - rows in timers,
// and the owner pane's own screen - never a sample of what is (test/CLAUDE.md,
// .claude/rules/worker-state.md). The notification is itself a timers row, so
// COUNTING those rows is what makes the debounce testable at all: a per-tick
// version inserts one every three seconds for as long as the dialog is up,
// and this file's headline test was proven RED against exactly that before
// the conditional claim went in.
//
// Real tmux, real spawned workers, real dialog fixture, and the server's own
// natural scheduler tick - the same method test/wake-delivery-state.test.mjs
// uses for the hold this notification hangs off.
const { hasTmux, cleanup } = isolateTmux("the wake-hold notification tests");

const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { sessionName } = await import("../dist/tmux.js");
const { db } = await import("../dist/db.js");

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

const agentRow = (name) => db.prepare("SELECT id, actor_id, tmux_target FROM agents WHERE name = ?").get(name);

// The notification names the wake it is about, so every row it could have
// produced is findable from the held wake's own id. Excluding that id is what
// keeps this from counting the held wake itself, and the trailing space is
// not decoration: without it a query for wake #1 also matches a notice about
// wake #10, so the count assertions below would silently drift once this file
// has ten wakes in one store.
const noticesAbout = (wakeId) =>
  db
    .prepare("SELECT * FROM timers WHERE id != ? AND body LIKE ? ORDER BY id")
    .all(wakeId, `%wake #${wakeId} %`);

const timerRow = (id) => db.prepare("SELECT * FROM timers WHERE id = ?").get(id);

// A wake OWNED by a spawned worker, so the notification has a pane to reach.
// wake_set records currentActor() as the owner and this test session is a
// plain `user:` actor with no agents row, which is a genuine no-pane case the
// scheduler skips - so the owner is rewritten before the wake comes due. The
// row is otherwise exactly what wake_set built, delay long enough that no
// tick can evaluate it in the gap.
async function ownedWake(ownerName, targetAgentId, body) {
  const wake = await mcp.call("wake_set", { delay_seconds: 5, body, deliver_to: targetAgentId });
  db.prepare("UPDATE timers SET owner = ? WHERE id = ?").run(agentRow(ownerName).actor_id, wake.wake_id);
  return wake.wake_id;
}

// The same trick for an idle wake: wake_when_idle records this test session
// as the owner, and it has no pane. The wake itself is exactly what the real
// tool built, watching real agents, with a max_wait far outside every timeout
// in this file - so a notification arriving here can only be the block path,
// never the timeout the wide half exists to beat.
async function ownedIdleWake(ownerName, watchNames, deliverToAgentId, body) {
  const wake = await mcp.call("wake_when_idle", {
    agents: watchNames,
    body,
    deliver_to: deliverToAgentId,
    max_wait_seconds: 900,
  });
  db.prepare("UPDATE timers SET owner = ? WHERE id = ?").run(agentRow(ownerName).actor_id, wake.wake_id);
  return wake.wake_id;
}

// The standing-watch version of ownedIdleWake above, and it exists for the
// same reason: wake_when_idle records this session's rowless `user:` actor as
// the owner, which has no pane. It returns the ORIGINAL owner too, because
// wake_cancel is owner-scoped and a fixture that has re-owned a wake cannot
// cancel it back (see cancelWatch).
async function ownedStandingWatch(ownerName, deliverToAgentId, body) {
  const watch = await mcp.call("wake_when_idle", {
    scope: "project",
    body,
    deliver_to: deliverToAgentId,
    max_wait_seconds: 900,
  });
  const setBy = timerRow(watch.wake_id).owner;
  db.prepare("UPDATE timers SET owner = ? WHERE id = ?").run(agentRow(ownerName).actor_id, watch.wake_id);
  return { watchId: watch.wake_id, setBy };
}

// The store's own account of a worker being stopped on a dialog: what
// src/hook.ts writes when Claude Code raises a Notification (todo 313's
// capture measured exactly this sequence). Written directly because a fake
// claude fires no hooks - the pane fixture supplies the dialog, this supplies
// the latch that decides whether hive bothers to look at it.
//
// `since` is explicit so the re-arm test can move it: it is the block-episode
// key (wake_block_notices.blocked_since), and a second block with the same
// timestamp is the same episode by design.
function markWaiting(name, since) {
  db.prepare("UPDATE agents SET agent_state = 'waiting', state_changed_at = ? WHERE name = ?").run(since, name);
}

const noticeCount = (wakeId) => noticesAbout(wakeId).length;

describe(
  "a wake held on a dialogged pane tells its owner, once per hold condition",
  { skip: hasTmux ? false : "tmux is not installed" },
  () => {
    it("notifies the owner once, leaves the original pending, and delivers it when the dialog clears", async () => {
      const owner = await spawnShowing("hold-notify-owner", replayFixture("ready-idle.txt"));
      const stuck = await spawnShowing("hold-notify-stuck", replayFixture("folder-trust-dialog.txt"));
      const wakeId = await ownedWake("hold-notify-owner", stuck.agent_id, "INTEGRATION hold-notify original body");

      let notices;
      await until(async () => {
        notices = noticesAbout(wakeId);
        return notices.length > 0;
      }, 15000);
      assert.equal(notices.length, 1, "the hold must produce a notification to the wake's owner");
      const notice = notices[0];
      assert.equal(notice.owner, agentRow("hold-notify-owner").actor_id, "owned by the actor that set the wake");
      assert.equal(notice.deliver_pane, owner.tmux_target, "delivered to that owner's own pane");
      // deliver_actor and project_id are both unreadable from the delivered
      // screen, so nothing else in this file would notice them being wrong.
      // deliver_actor is how DELIVER_SOCKET_JOIN resolves the notification's
      // tmux socket and how checkConfirmations attributes it; project_id is
      // the deliberate cross-project choice (the HELD wake's project, not the
      // owner's own row's).
      assert.equal(
        notice.deliver_actor,
        agentRow("hold-notify-owner").actor_id,
        "delivered AS that actor, not just at its pane",
      );
      assert.equal(notice.project_id, timerRow(wakeId).project_id, "filed in the held wake's project");
      assert.match(notice.body, /hold-notify-stuck/, "it must name the worker that is stuck");
      assert.match(notice.body, /agent_send/, "and the way out, which is agent_send with keys");
      assert.match(notice.body, /keys/, "keys specifically: text is refused against a dialog");

      // THE HEADLINE ASSERTION. Not just "one notification exists" - one
      // notification exists AFTER the scheduler has gone on holding this
      // wake for several more ticks. held_at is rewritten by holdTimer on
      // every tick the hold still applies, so an advanced held_at is proof
      // the ticks kept happening and kept holding; without it, "still one
      // notification" would also be satisfied by a scheduler that had
      // stopped, which is the vacuous pass this file must not be able to
      // take (test/CLAUDE.md, shape 7).
      const heldAtFirst = timerRow(wakeId).held_at;
      assert.ok(heldAtFirst, "the original must be recorded as held");
      await until(async () => timerRow(wakeId).held_at > heldAtFirst, 12000);
      assert.ok(
        timerRow(wakeId).held_at > heldAtFirst,
        "the scheduler must have re-held this wake on a later tick, or the count below proves nothing",
      );
      assert.equal(
        noticesAbout(wakeId).length,
        1,
        "one notification per hold condition: a per-tick version inserts one every three seconds",
      );

      // HAND THE STORE TO A DIFFERENT SERVER PROCESS, which is why the
      // debounce had to be an atomic conditional UPDATE rather than anything
      // held in memory: hive runs one MCP server per Claude Code session, all
      // ticking against one WAL store, and sessions come and go. An
      // in-process Set of already-notified timer ids passes every assertion
      // above - measured, not assumed - and cannot pass this one, because the
      // fresh process starts with an empty one.
      //
      // The OLD server is closed first, deliberately. Leaving it running
      // makes an advancing held_at prove nothing about the new process (the
      // old one advances it every three seconds either way), and the count
      // below would then be asserted before the new server had necessarily
      // ticked at all - which is exactly how this assertion passed against
      // the in-process mutation on its first version.
      await mcp.close();
      mcp = new McpClient({ cwd: dirs.projectDir, dataDir: dirs.dataDir, env: { HIVE_SPAWN_READY_MS: "2000" } });
      await mcp.start();
      assert.ok((await mcp.call("whoami")).actor_id, "the replacement server must really be serving");
      const heldAtHandover = timerRow(wakeId).held_at;
      await until(async () => timerRow(wakeId).held_at > heldAtHandover, 15000);
      assert.ok(
        timerRow(wakeId).held_at > heldAtHandover,
        "the replacement server must have re-held this wake: nothing else is left to write that column",
      );
      assert.equal(
        noticesAbout(wakeId).length,
        1,
        "still one notification after the store changed hands: the claim is atomic across processes",
      );

      // The original wake is UNTOUCHED: not fired, not cancelled, not typed.
      // This is the line between this lane and the withdrawn also_when_stuck
      // design, so it is asserted rather than assumed.
      const original = timerRow(wakeId);
      assert.equal(original.fired_at, null, "the original wake must not have fired");
      assert.equal(original.cancelled_at, null, "and must not have been cancelled");
      assert.equal(original.typed_at, null, "and nothing was typed into the dialogged pane");
      assert.match(original.held_reason, /modal choice/, "it is still held for the dialog");

      // The notification really reached the owner's terminal, read back off
      // that pane rather than inferred from the timers row.
      await until(async () => timerRow(notice.id).typed_at != null, 15000);
      // `-S -` is the WHOLE history, not the visible screen. A project-scope
      // watch delivers one notice per condition and each is a multi-line
      // roster, so by the time this reads the pane the line naming this worker
      // has scrolled well past the visible rows - and how far depends on how
      // many OTHER crew members this file happens to have left blocked, which
      // would make this assertion a fixture depending on unrelated tests.
      const screen = execFileSync("tmux", ["capture-pane", "-p", "-J", "-S", "-", "-t", owner.tmux_target], {
        encoding: "utf8",
      });
      assert.match(screen, /hive wake #/, "the owner's pane must show the delivered notification");
      assert.match(screen, /hold-notify-stuck/, "naming the worker that needs a human");

      // Clearing the dialog lets the ORIGINAL deliver normally, which is the
      // whole reason it was held rather than fired or cancelled.
      repaintPaneAsSameWorker(db, stuck.tmux_target, "sleep 600");
      await until(async () => timerRow(wakeId).typed_at != null, 15000);
      const delivered = timerRow(wakeId);
      assert.ok(delivered.typed_at, "the original wake delivers once the dialog clears");
      assert.equal(delivered.held_at, null, "and a resolved hold stops being reported as current");
    });

    it("holds the notification too when the owner's own pane is on a dialog, and never chains", async () => {
      const owner = await spawnShowing("hold-notify-busy-owner", replayFixture("folder-trust-dialog.txt"));
      const stuck = await spawnShowing("hold-notify-stuck-2", replayFixture("model-picker-dialog.txt"));
      const wakeId = await ownedWake("hold-notify-busy-owner", stuck.agent_id, "INTEGRATION hold-notify busy owner");

      let notices;
      await until(async () => {
        notices = noticesAbout(wakeId);
        return notices.length > 0;
      }, 15000);
      assert.equal(notices.length, 1, "one notification, even though it cannot be delivered yet");
      const notice = notices[0];
      assert.equal(notice.deliver_pane, owner.tmux_target, "aimed at the owner's own dialogged pane");

      // It inherits deliverable()'s guards because it IS an ordinary wake:
      // held, not typed into the dialog. That is the property that makes
      // reusing the delivery path worth more than a direct call to deliver().
      await until(async () => timerRow(notice.id).held_at != null, 15000);
      const heldNotice = timerRow(notice.id);
      assert.ok(heldNotice.held_at, "the notification must hold against the owner's own dialog");
      assert.match(heldNotice.held_reason, /modal choice/, "for the same reason, recorded the same way");
      assert.equal(heldNotice.typed_at, null, "and must never be typed into a dialog");

      // THE RECURSION GUARD. A held notification is a hold like any other, so
      // without the "nobody else to tell" rule it would notify its own owner
      // and that notification would hold and notify again, one row per tick
      // forever. Nothing may be filed about the notification itself, and the
      // original must still have exactly one.
      //
      // WHAT THIS BOUNDS, said plainly because the guard is two rules and
      // this exercises one: no chain within these few ticks, with the owner's
      // agents row unchanged throughout. The owner === deliver_actor check in
      // ownerPaneToTell is what holds when that row DOES change (a lead
      // restart moving panes, or two running lead rows sharing one actor_id),
      // and nothing here moves a row, so this test does not see that half.
      await until(async () => noticesAbout(notice.id).length > 0, 9000);
      assert.equal(
        noticesAbout(notice.id).length,
        0,
        "a notification held on its own owner's pane must not notify anyone: there is nobody else to tell",
      );
      assert.equal(noticesAbout(wakeId).length, 1, "and the original still has exactly one");
      assert.equal(notice.owner, notice.deliver_actor, "the structural half of the guard: a notice owns itself");
    });

    it("says nothing when the hold is unsubmitted human text rather than a dialog", async () => {
      const owner = await spawnShowing("hold-notify-typing-owner", replayFixture("ready-idle.txt"));
      const stuck = await spawnShowing("hold-notify-typing", replayFixture("real-input.txt"));
      const wakeId = await ownedWake("hold-notify-typing-owner", stuck.agent_id, "INTEGRATION hold-notify typing");

      // The positive control this negative test needs: "nobody was told" is
      // equally satisfied by an owner nobody COULD have told (an empty
      // tmux_target, or the same pane as the target), which is
      // test/CLAUDE.md's shape 7. Assert the exact inputs the notify path
      // reads before asserting its silence.
      const ownerRow = agentRow("hold-notify-typing-owner");
      assert.ok(ownerRow.tmux_target, "the owner must have a pane, or silence proves nothing");
      assert.notEqual(ownerRow.tmux_target, stuck.tmux_target, "and a different one from the held target");
      assert.equal(ownerRow.tmux_target, owner.tmux_target, "the same pane the spawn receipt named");

      // real-input.txt is a human mid-sentence in that pane, not a stuck
      // worker, and a human does not need to be told about their own typing.
      await until(async () => timerRow(wakeId).held_at != null, 15000);
      assert.match(timerRow(wakeId).held_reason, /unsubmitted/, "held for the input-box reason, not the dialog one");
      await until(async () => noticesAbout(wakeId).length > 0, 9000);
      assert.equal(noticesAbout(wakeId).length, 0, "only the modal hold notifies; this one must stay silent");
    });
  },
);

// The third hold reason, and the one a real tmux cannot easily produce: a
// lead-owned wake whose own delivery pane is not live (mid-restart). There is
// no live pane to deliver a notification to, so the hold must stay silent -
// and this is reachable with a fabricated snapshot and no tmux at all, the
// same shape test/scheduler.test.mjs uses.
//
// The owner's pane IS in the snapshot on purpose. With it absent the janitor
// would close the owner's row before deliverable() ever ran, and "no
// notification" would be satisfied by the owner having no running row rather
// than by the hold reason - two indistinguishable causes for one assertion
// (test/CLAUDE.md, shape 7).
const LEAD_DEAD_SEED = `
const project = db.prepare("INSERT INTO projects (name, path) VALUES ('hold-notify', '/tmp/hold-notify') RETURNING id").get().id;
db.prepare(
  \`INSERT INTO agents (project_id, actor_id, name, kind, tmux_target, command, cwd, status, agent_state, created_at)
   VALUES (?, 'lead:1', 'the-lead', 'lead', '%dead', 'claude', '/tmp', 'running', 'unknown', datetime('now', '-60 seconds'))\`,
).run(project);
db.prepare(
  \`INSERT INTO agents (project_id, actor_id, name, kind, tmux_target, command, cwd, status, agent_state, created_at)
   VALUES (?, 'agent:9', 'the-owner', 'agent', '%live', 'claude', '/tmp', 'running', 'idle', datetime('now', '-60 seconds'))\`,
).run(project);
const timerId = db.prepare(
  \`INSERT INTO timers (project_id, owner, body, kind, watch, deliver_actor, deliver_pane, due_at, created_at)
   VALUES (?, 'agent:9', 'wake body', 'delay', '[]', 'lead:1', '%dead', datetime('now', '-1 seconds'), datetime('now', '-60 seconds'))
   RETURNING id\`,
).get(project).id;
const snapshot = { panes: new Set(['%live']), windows: new Set() };
`;

// AMENDMENT 1's half of the feature, and the one that makes it a fix rather
// than a delay. maybeFireIdle gates on `ready` before it ever consults
// deliverable(), and a worker stopped on a dialog is `waiting`, never idle -
// so a wake_when_idle watching it never becomes due, is never held, and its
// owner hears nothing until max_wait_seconds. Every wake below is created
// with max_wait_seconds: 900, an order of magnitude past every timeout in
// this file, so a notification arriving here CANNOT be the timeout path.
describe(
  "a wake waiting on a worker that is stopped on a dialog tells its owner",
  { skip: hasTmux ? false : "tmux is not installed" },
  () => {
    it("notifies once while the wake is still pending, and re-arms when the worker blocks again", async () => {
      const owner = await spawnShowing("block-notify-owner", replayFixture("ready-idle.txt"));
      const stuck = await spawnShowing("block-notify-stuck", replayFixture("folder-trust-dialog.txt"));
      markWaiting("block-notify-stuck", "2026-08-08 10:00:00");
      const wakeId = await ownedIdleWake(
        "block-notify-owner",
        ["block-notify-stuck"],
        owner.agent_id,
        "INTEGRATION block-notify original body",
      );

      let notices;
      await until(async () => {
        notices = noticesAbout(wakeId);
        return notices.length > 0;
      }, 15000);
      assert.equal(notices.length, 1, "the block must produce one notification to the wake's owner");
      assert.equal(notices[0].deliver_pane, owner.tmux_target, "delivered to the owner's pane");
      assert.match(notices[0].body, /block-notify-stuck/, "naming the blocked worker");
      assert.match(notices[0].body, /cannot go idle/, "and saying why the wake is not firing");

      // The wake itself is untouched: still pending, never fired, never
      // cancelled, and NOT marked held - it was never due, so writing held_at
      // would make wake_list and `hive status` report a delivery hive never
      // attempted.
      const original = timerRow(wakeId);
      assert.equal(original.fired_at, null, "the watched wake must not have fired");
      assert.equal(original.cancelled_at, null, "and must not have been cancelled");
      assert.equal(original.held_at, null, "and must not be reported as held: it was never due");
      assert.equal(original.held_reason, null, "nor carry a hold reason");

      // Still one after several more ticks, with the dialog still up: the
      // block-notice claim is per episode, not per tick. THE CONTROL WAKE is
      // what stops that being vacuous: the wide path writes nothing to the
      // watched timer, so there is no advancing column to prove the scheduler
      // was even running during the window (the held-wake half used held_at
      // for exactly this). A plain wake set to fire inside the window MUST be
      // delivered by the end of it, so a scheduler that had stopped fails
      // here rather than passing the count assertion for free.
      const control = await mcp.call("wake_set", {
        delay_seconds: 2,
        body: "INTEGRATION block-notify control wake",
        deliver_to: owner.agent_id,
      });
      await new Promise((resolve) => setTimeout(resolve, 9000));
      assert.ok(timerRow(control.wake_id).typed_at, "the scheduler must have been ticking through that window");
      assert.equal(noticeCount(wakeId), 1, "one per block, not one per tick");

      // AND NOT IN THIS PROCESS EITHER. Same mutation the held-wake half's
      // handover kills: an in-process Set keyed on (timer, agent, episode)
      // satisfies every count above, because one server has been doing all
      // the work. Hand the store to a fresh process, whose memo is empty, and
      // let it go on seeing the same block.
      await mcp.close();
      mcp = new McpClient({ cwd: dirs.projectDir, dataDir: dirs.dataDir, env: { HIVE_SPAWN_READY_MS: "2000" } });
      await mcp.start();
      const handoverControl = await mcp.call("wake_set", {
        delay_seconds: 2,
        body: "INTEGRATION block-notify handover control",
        deliver_to: owner.agent_id,
      });
      await until(async () => timerRow(handoverControl.wake_id).typed_at != null, 15000);
      assert.ok(
        timerRow(handoverControl.wake_id).typed_at,
        "the replacement server must be ticking, or the count below proves nothing",
      );
      assert.equal(noticeCount(wakeId), 1, "still one after the store changed hands: the claim is in the store");

      // THE RE-ARM. A worker that is unblocked and blocks again must be
      // reported again, which is why the claim is keyed on the agent's own
      // state_changed_at rather than on a boolean. Faithful to the real
      // sequence: the dialog is answered (pane clears, hive records the
      // worker moving off `waiting`), then a new dialog goes up with a new
      // state_changed_at.
      repaintPaneAsSameWorker(db, stuck.tmux_target, replayFixture("ready-idle.txt"));
      db.prepare("UPDATE agents SET agent_state = 'working', state_changed_at = ? WHERE name = ?").run(
        "2026-08-08 10:05:00",
        "block-notify-stuck",
      );
      await new Promise((resolve) => setTimeout(resolve, 4000));
      assert.equal(noticeCount(wakeId), 1, "nothing new while the worker is not blocked");

      repaintPaneAsSameWorker(db, stuck.tmux_target, replayFixture("model-picker-dialog.txt"));
      markWaiting("block-notify-stuck", "2026-08-08 10:06:00");
      await until(async () => noticeCount(wakeId) > 1, 15000);
      assert.equal(noticeCount(wakeId), 2, "a second block is a second condition and must be reported again");
    });

    // Todo 392, measured live before this fix: a standing watch armed over a
    // worker sitting on an ordinary tool-permission prompt filed ZERO block
    // notices in ~4 minutes, because noteBlockedWatched's own pane read
    // (paneChoiceCheck) answered "no dialog" - the preview box's own `╰`
    // again. Same mechanism as the folder-trust case above; this pins the
    // fixture the bug was actually about.
    it("notifies the owner when the blocked worker is on an ordinary tool-permission prompt (todo 392)", async () => {
      const owner = await spawnShowing("permission-block-owner", replayFixture("ready-idle.txt"));
      const stuck = await spawnShowing("permission-block-stuck", replayFixture("tool-permission-prompt.txt"));
      markWaiting("permission-block-stuck", "2026-08-13 20:00:00");
      const wakeId = await ownedIdleWake(
        "permission-block-owner",
        ["permission-block-stuck"],
        owner.agent_id,
        "INTEGRATION permission-block original body",
      );

      let notices;
      await until(async () => {
        notices = noticesAbout(wakeId);
        return notices.length > 0;
      }, 15000);
      assert.equal(notices.length, 1, "the block must produce one notification to the wake's owner");
      assert.equal(notices[0].deliver_pane, owner.tmux_target, "delivered to the owner's pane");
      assert.match(notices[0].body, /permission-block-stuck/, "naming the blocked worker");
      assert.match(notices[0].body, /cannot go idle/, "and saying why the wake is not firing");

      const original = timerRow(wakeId);
      assert.equal(original.fired_at, null, "the watched wake must not have fired");
      assert.equal(original.held_at, null, "and must not be reported as held: it was never due");
    });

    it("says nothing for a stale `waiting` whose pane has no dialog on it", async () => {
      const owner = await spawnShowing("stale-latch-owner", replayFixture("ready-idle.txt"));
      const resumed = await spawnShowing("stale-latch-worker", replayFixture("ready-idle.txt"));
      // The exact shape that killed also_when_stuck: `waiting` is latched and
      // nothing clears it, so a worker that answered its dialog and carried
      // on still reads `waiting` in the store for the rest of its turn. The
      // store cannot tell that from a live block - and is never asked to.
      // The pane read is the authority, and this pane has no dialog on it.
      markWaiting("stale-latch-worker", "2026-08-08 10:00:00");
      const wakeId = await ownedIdleWake(
        "stale-latch-owner",
        ["stale-latch-worker"],
        owner.agent_id,
        "INTEGRATION stale latch check",
      );

      // The positive control, or "nothing was sent" proves nothing: the owner
      // has a pane, it is not the watched pane, and the watched agent really
      // does read `waiting` in the store.
      assert.ok(agentRow("stale-latch-owner").tmux_target, "the owner must have a pane to be told at");
      assert.notEqual(agentRow("stale-latch-owner").tmux_target, resumed.tmux_target, "a different pane");
      assert.equal(
        db.prepare("SELECT agent_state FROM agents WHERE name = 'stale-latch-worker'").get().agent_state,
        "waiting",
        "the latch must really say waiting, or this tests nothing",
      );

      await until(async () => noticeCount(wakeId) > 0, 10000);
      assert.equal(noticeCount(wakeId), 0, "a stale latch over a pane with no dialog must say nothing");
      assert.equal(timerRow(wakeId).fired_at, null, "and the wake keeps waiting for a real idle");
    });

    // TODO 321, STEP 2. The lead suspected the shipped one-shot path files its
    // block notice at the wrong pane, and this is the measurement rather than
    // the suspicion. noteBlockedWatched resolves who to tell with ownerPane(),
    // which is `SELECT tmux_target FROM agents WHERE actor_id = ? AND status =
    // 'running'` - null for a session with no agents row. resolveDelivery
    // (src/tools/wakes.ts) DELIBERATELY supports that caller, falling back to
    // the TMUX_PANE it is running in, so a plain `user:` session that sets
    // wake_when_idle has a perfectly good delivery pane recorded on the wake
    // and was told NOTHING about a worker stopped on a dialog - exactly the
    // silence todo 314 exists to remove, in the configuration todo 315 found
    // the standing watch inert in.
    //
    // BOTH HALVES ARE ASSERTED IN ONE TEST ON PURPOSE, because each is the
    // other's control. "A notice was filed for the rowless owner" is
    // meaningless without proof that the owner really has no row; "the notice
    // still goes to the owner when it HAS one" is what pins that this is a
    // FALLBACK and not a redirect - the wake's deliver_to here names a
    // different session from the owner throughout, so a blanket switch to
    // deliver_pane fails the second half.
    it("tells a rowless owner at the pane the wake itself resolved, and the owner's own pane when it has one", async () => {
      const teller = await spawnShowing("rowless-block-teller", replayFixture("ready-idle.txt"));
      const later = await spawnShowing("rowless-block-owner", replayFixture("ready-idle.txt"));
      const stuck = await spawnShowing("rowless-block-stuck", replayFixture("folder-trust-dialog.txt"));
      markWaiting("rowless-block-stuck", "2026-08-09 09:00:00");

      // NOT ownedIdleWake: the owner is left exactly as wake_when_idle
      // recorded it, which for this test session is a `user:` actor with no
      // agents row at all. That is the case under test, not a fixture
      // shortcut.
      const wake = await mcp.call("wake_when_idle", {
        agents: ["rowless-block-stuck"],
        body: "INTEGRATION rowless-owner block",
        deliver_to: teller.agent_id,
        max_wait_seconds: 900,
      });
      const wakeId = wake.wake_id;
      const owner = timerRow(wakeId).owner;
      assert.equal(
        db.prepare("SELECT COUNT(*) AS n FROM agents WHERE actor_id = ?").get(owner).n,
        0,
        "the fixture must really be the rowless case, or it proves nothing",
      );
      assert.notEqual(timerRow(wakeId).deliver_pane, stuck.tmux_target, "and the pane told is not the stuck one");

      await until(async () => noticeCount(wakeId) > 0, 15000);
      assert.equal(noticeCount(wakeId), 1, "a rowless owner still gets told; the wake resolved a pane either way");
      assert.equal(
        noticesAbout(wakeId)[0].deliver_pane,
        teller.tmux_target,
        "at the pane the wake itself resolved, which is the only one hive knows for this caller",
      );
      assert.equal(
        noticesAbout(wakeId)[0].deliver_actor,
        agentRow("rowless-block-teller").actor_id,
        "and AS that actor: the pane and the actor must come from the same place or the socket join is wrong",
      );

      // THE FALLBACK CONTROL. Give the same wake an owner that HAS a running
      // row and re-arm the block (a new state_changed_at is a new episode, the
      // same way the re-arm test above does it). The owner is now a different
      // session from deliver_to, so the pane the second notice lands on says
      // which rule is in force.
      db.prepare("UPDATE timers SET owner = ? WHERE id = ?").run(agentRow("rowless-block-owner").actor_id, wakeId);
      assert.notEqual(later.tmux_target, teller.tmux_target, "the owner and the delivery target must differ here");
      markWaiting("rowless-block-stuck", "2026-08-09 09:10:00");
      await until(async () => noticeCount(wakeId) > 1, 15000);
      assert.equal(noticeCount(wakeId), 2, "a second block episode is reported again");
      assert.equal(
        noticesAbout(wakeId)[1].deliver_pane,
        later.tmux_target,
        "an owner with a live pane is told at ITS pane, not at the wake's delivery target",
      );
    });

    it("does not double-notify when the same block reaches both paths in sequence", async () => {
      const owner = await spawnShowing("both-paths-owner", replayFixture("ready-idle.txt"));
      const stuck = await spawnShowing("both-paths-stuck", replayFixture("folder-trust-dialog.txt"));
      const other = await spawnShowing("both-paths-other", replayFixture("ready-idle.txt"));
      markWaiting("both-paths-stuck", "2026-08-08 11:00:00");

      // mode=any watching both, DELIVERED TO the blocked worker, and the two
      // paths are reached IN SEQUENCE - which is the shape that matters,
      // since maybeFireIdle now skips the wide path for a wake that is ready.
      // Stage one: nothing is idle, so the wake is not ready and the wide
      // path speaks about the blocked worker. Stage two: the other watched
      // agent goes idle, the wake becomes ready, deliverable() finds the
      // delivery pane on that same dialog, and the held-wake path must stay
      // silent - both compute the same (wake, agent, episode) key.
      const wakeId = await ownedIdleWake(
        "both-paths-owner",
        ["both-paths-stuck", "both-paths-other"],
        stuck.agent_id,
        "INTEGRATION both paths",
      );

      await until(async () => noticeCount(wakeId) > 0, 15000);
      assert.equal(noticeCount(wakeId), 1, "one notification about one block, not one per path");
      assert.equal(noticesAbout(wakeId)[0].deliver_pane, owner.tmux_target, "and it went to the owner");
      // WHICH PATH SPOKE, asserted rather than left to the count (counselors
      // round 2, both seats: with the wide path deleted entirely, the held
      // path alone also produces exactly one notice to this same pane, so a
      // count-only test is green against gutting the feature). The wide
      // path's body is the one that says the wake cannot fire yet.
      assert.match(
        noticesAbout(wakeId)[0].body,
        /cannot go idle/,
        "the blocked-watched path is the one that must have spoken here",
      );
      // Stage two: make the wake READY while its delivery pane is still on
      // the dialog, which is the held-wake path's own condition. It must hold
      // the wake exactly as before and say nothing, because the wide path
      // already claimed this episode.
      // resumed_at IS CLEARED IN THE SAME STATEMENT, and todo 373 is why. This
      // worker was REALLY spawned (spawnShowing), so launchAgent stamped the
      // "started, and not yet given anything" latch on its row, and every idle
      // reader now declines to act on the idle of a worker nobody has given
      // anything to (src/firstPrompt.ts). The finish this line is simulating is
      // a worker that WAS given its lane and finished it, so clearing the latch
      // is what makes the seeded row mean what the test says it means - without
      // it, stage two's premise ("the wake becomes ready") is silently false
      // and the assertions below pass on a wake that was never held.
      db.prepare(
        "UPDATE agents SET agent_state = 'idle', state_changed_at = datetime('now'), resumed_at = '' WHERE name = ?",
      ).run("both-paths-other");
      const control = await mcp.call("wake_set", {
        delay_seconds: 2,
        body: "INTEGRATION both-paths control wake",
        deliver_to: other.agent_id,
      });
      await new Promise((resolve) => setTimeout(resolve, 9000));
      assert.ok(timerRow(control.wake_id).typed_at, "the scheduler must have been ticking through that window");
      assert.match(timerRow(wakeId).held_reason ?? "", /modal choice/, "the wake really did reach the held path");
      assert.equal(timerRow(wakeId).typed_at, null, "and was never typed into the dialog");
      assert.equal(noticeCount(wakeId), 1, "still one across later ticks");
    });
  },
);

// TODO 321. Todo 314's block half read its membership from
// JSON.parse(timer.watch) and answered [] for an empty list, and a STANDING
// watch stores watch='[]' on purpose - so a crew member stopped on a
// permission prompt was invisible to it. The finish half cannot see that
// worker either (it is `waiting`, never idle), so the owner heard nothing at
// all until the watch expired, four hours later by default. A lead taking the
// advice this project now gives - one standing watch instead of N one-shots -
// lost a signal it used to have.
//
// SAME METHOD AS THE ONE-SHOT HALF ABOVE: real tmux, a real spawned worker
// showing a real dialog fixture, the server's own natural tick, and every
// assertion over a RECORD OF WHAT HAPPENED (rows in timers and
// wake_block_notices) rather than a sample of agent_state.
describe(
  "a standing watch tells its owner when a crew member is stopped on a dialog",
  { skip: hasTmux ? false : "tmux is not installed" },
  () => {
    // A block notice carries no parent link (todo 322 is the open question of
    // whether it should), so it cannot be found the way a finish notice can.
    // The worker's name is unique per test and a finish notice about a
    // DIFFERENT worker can still name this one in its "Still going" roster, so
    // the parent filter is what separates the two kinds rather than decoration.
    // Matched on the worker's name alone, NOT on the standing body's own
    // wording. A matcher carrying "Standing watch #" reads well and is a trap:
    // it makes every count assertion below silently become "how many notices
    // used the standing WORDING", so a regression that files per-agent notices
    // with the one-shot body fails as "0 found" instead of "2 where 1 was
    // expected. Measured, not imagined - that is exactly what the first
    // version of this helper did under the batching mutation. Names are unique
    // per test and no one-shot wake in this file watches these workers, so the
    // name is enough on its own.
    // CANCELLING A WAKE THIS FILE HAS RE-OWNED DOES NOT WORK BY DEFAULT, and
    // finding that the hard way is why it is a helper. wake_cancel is
    // owner-scoped, and these fixtures rewrite `owner` to a spawned agent so
    // the notice has a pane to reach - so a plain wake_cancel from this
    // session matches nothing, returns a receipt, and leaves the watch
    // RUNNING. Two live standing watches then both file notices about the same
    // crew, and the second test reads the first watch's notice while looking
    // for its own claim rows. Give the wake back before cancelling it, and
    // assert the cancel actually landed rather than trusting the receipt.
    const cancelWatch = async (watchId, originalOwner) => {
      db.prepare("UPDATE timers SET owner = ? WHERE id = ?").run(originalOwner, watchId);
      await mcp.call("wake_cancel", { wake_id: watchId });
      assert.ok(timerRow(watchId).cancelled_at, "the watch must really be cancelled, or it outlives its own test");
    };

    // ONE DEFINITION OF THE CALL THE BODY SUGGESTS, shared by the matcher and
    // every assertion below. Written out twice, it drifted the moment the lane
    // corrected that call's parameter name (agent: -> name:): the matcher
    // silently stopped matching anything and three assertions failed as "0
    // notices filed" - a red that reads as the feature being broken rather
    // than the test being stale. test/CLAUDE.md's shape 5 from the other side.
    const readCall = (name) => `agent_output(name: "${name}")`;

    // A spawn receipt says the pane EXISTS; it does not say the fixture has
    // finished painting into it. Step 3's negative cache turned that race from
    // a one-tick delay into a 30-second one - a tick that reads the pane
    // between `liveAgentRow` and `cat` finishing gets "no dialog" and
    // suppresses for 30s - so every standing fixture here waits for the dialog
    // to be ON SCREEN before the watch that reads it exists. Found by
    // counselors round 1 (opus F8) as a flake this lane would otherwise have
    // added.
    const onScreen = (pane, text) =>
      execFileSync("tmux", ["capture-pane", "-p", "-J", "-t", pane], { encoding: "utf8" }).includes(text);
    const TRUST_DIALOG = "Yes, I trust this folder";
    const blockNoticesNaming = (name) =>
      db
        .prepare("SELECT * FROM timers WHERE parent_timer_id IS NULL AND kind = 'delay' AND body LIKE ? ORDER BY id")
        .all(`%${readCall(name)}%`);

    it("files a block notice for a crew member it never had in a watch list", async () => {
      const owner = await spawnShowing("standing-block-owner", replayFixture("ready-idle.txt"));
      const stuck = await spawnShowing("standing-block-stuck", replayFixture("folder-trust-dialog.txt"));
      await until(async () => onScreen(stuck.tmux_target, TRUST_DIALOG), 15000);
      assert.ok(onScreen(stuck.tmux_target, TRUST_DIALOG), "the dialog must be painted before the watch exists");
      markWaiting("standing-block-stuck", "2026-08-09 12:00:00");

      const { watchId, setBy } = await ownedStandingWatch(
        "standing-block-owner",
        owner.agent_id,
        "INTEGRATION standing-block crew update",
      );

      // The membership control, and it is the whole point of the lane: the
      // watch names NOBODY, and the blocked worker was never in a list.
      assert.equal(timerRow(watchId).watch, "[]", "a standing watch's watch list is empty by design");
      assert.equal(timerRow(watchId).watch_scope, "project", "and its membership is a query over the project");

      await until(async () => blockNoticesNaming("standing-block-stuck").length > 0, 20000);
      const filed = blockNoticesNaming("standing-block-stuck");
      assert.equal(filed.length, 1, "the standing watch must file exactly one notice about this block");
      assert.equal(filed[0].deliver_pane, owner.tmux_target, "delivered to the watch's own owner");
      assert.match(filed[0].body, /Standing watch #/, "and it says what kind of watch it is");
      assert.match(
        filed[0].body,
        /will report nothing about the workers above until their dialogs are answered/,
        "the one-shot's sentence is false for a standing watch: it never fires and has no max wait to race",
      );
      assert.doesNotMatch(
        filed[0].body,
        /will not fire until the dialog is answered/,
        "and specifically it must not claim a standing watch fires",
      );
      // NOT "it has no max wait": every standing watch carries max_wait_at as
      // its LIFETIME (counselors round 1, codex 5c). What is false for a
      // standing watch is that the max wait is a deadline it races to fire
      // before, which is what the one-shot's sentence means by it.
      assert.ok(timerRow(watchId).max_wait_at, "a standing watch does have a max_wait_at - it is the lifetime");
      assert.match(filed[0].body, /keys/, "the way out is agent_send with keys, as on the one-shot half");

      // THE NO-CHAIN FACT, PINNED RATHER THAN ARGUED. The reason a notice can
      // never itself become a block-notice candidate used to be "it carries
      // the default empty watch list"; an empty list is exactly what stopped
      // meaning "watches nothing" in this lane. What holds now is that
      // insertNotice sets no watch_scope, so the notice stays a one-shot row.
      // A future insertNotice that copied its parent's scope would pass every
      // other assertion in this file and fail here.
      assert.equal(filed[0].watch_scope, null, "a notice must never itself be a standing watch");
      assert.equal(filed[0].watch, "[]", "nor watch anything: deliver() would paste worker screens into the body");
      assert.equal(blockNoticesNaming("standing-block-owner").length, 0, "and nothing is filed about the owner");

      // THE WATCH'S OWN ROW IS UNTOUCHED. Writing fired_at would stop it
      // watching; writing held_at/held_reason would make wake_list and `hive
      // status` report a delivery hive never attempted.
      const row = timerRow(watchId);
      assert.equal(row.fired_at, null, "the watch must not have fired");
      assert.equal(row.held_at, null, "must not be reported as held: it was never due");
      assert.equal(row.held_reason, null, "nor carry a hold reason");
      assert.equal(row.cancelled_at, null, "and must still be watching");

      // ONE PER BLOCK, NOT ONE PER TICK, with the same control the one-shot
      // half uses: the wide path writes nothing to the watch, so a plain wake
      // set to fire inside the window is what proves the scheduler was still
      // ticking rather than stopped.
      const control = await mcp.call("wake_set", {
        delay_seconds: 2,
        body: "INTEGRATION standing-block control wake",
        deliver_to: owner.agent_id,
      });
      await new Promise((resolve) => setTimeout(resolve, 9000));
      assert.ok(timerRow(control.wake_id).typed_at, "the scheduler must have been ticking through that window");
      assert.equal(blockNoticesNaming("standing-block-stuck").length, 1, "one per block, not one per tick");
      // Scoped to THIS agent, not to the watch. A project-scope watch really
      // does report every blocked crew member, including the ones earlier
      // tests in this file left latched on their own dialogs, so a
      // watch-wide count here would assert that the lane's own feature does
      // not work.
      assert.equal(
        db.prepare("SELECT COUNT(*) AS n FROM wake_block_notices WHERE timer_id = ? AND agent_id = ?").get(
          watchId,
          agentRow("standing-block-stuck").id,
        ).n,
        1,
        "and the claim lives in wake_block_notices, which the finish half never touches",
      );
      assert.equal(
        db.prepare("SELECT COUNT(*) AS n FROM wake_idle_notices WHERE timer_id = ? AND agent_id = ?").get(
          watchId,
          agentRow("standing-block-stuck").id,
        ).n,
        0,
        "a block is not a finish: the two conditions have separate claim tables and must not collide",
      );

      // FILED IS NOT TOLD. Every assertion above reads a timers row or a claim
      // row, and .claude/rules/tmux-and-panes.md records what that misses:
      // todo 317's handler returned {sent: true} without ever calling sendText
      // and kept eight tests green. typed_at is set only after sendText has
      // RETURNED (deliver(), outside its own try/finally), so requiring it here
      // kills a standing block notice that is filed and never typed - proven
      // red by making claimBlockBatch file its notice with a due_at an hour
      // out.
      //
      // THE PANE ITSELF IS READ IN THE FIXTURE TEST AT THE BOTTOM OF THIS FILE,
      // not here, and that is a limit of THIS fixture rather than a weaker
      // standard. This owner is the delivery target of a project-scope watch in
      // a file that leaves a dozen workers running, so it also receives finish
      // notices whose rosters name all of them - and its pane is a shell in
      // `sleep`, which never consumes what is typed at it. Measured rather than
      // reasoned about: in a full-file run this pane's whole history ends
      // mid-way through the FIRST large notice delivered to it, with everything
      // after that absent, so whether this assertion passes depends on which
      // notice happened to arrive first. The bottom fixture reads a pane whose
      // only delivery is the block notice under test.
      await until(async () => timerRow(filed[0].id).typed_at != null, 20000);
      assert.ok(timerRow(filed[0].id).typed_at, "the notice must be typed, not merely filed");

      // A SECOND CREW MEMBER, SPAWNED AFTER THE WATCH WAS SET. This is the
      // coverage the assertion above gave up when it was scoped to one
      // agent_id, and it is worth more deliberately than it was by accident:
      // it pins that membership is a LIVE QUERY over the project rather than a
      // set fixed at creation, which is the property a one-shot does not have
      // and the whole reason a standing watch exists. A version that resolved
      // the crew once, when the watch was created, passes every assertion
      // above and fails here.
      const late = await spawnShowing("standing-block-latecomer", replayFixture("model-picker-dialog.txt"));
      assert.ok(
        db.prepare("SELECT created_at > (SELECT created_at FROM timers WHERE id = ?) AS after FROM agents WHERE id = ?")
          .get(watchId, agentRow("standing-block-latecomer").id).after,
        "the second worker must really postdate the watch, or it proves nothing about later joiners",
      );
      markWaiting("standing-block-latecomer", "2026-08-09 12:30:00");
      await until(async () => blockNoticesNaming("standing-block-latecomer").length > 0, 20000);
      const lateFiled = blockNoticesNaming("standing-block-latecomer");
      assert.equal(lateFiled.length, 1, "a crew member that appeared after the watch was set is watched too");
      assert.equal(lateFiled[0].deliver_pane, owner.tmux_target, "and reported to the same owner");
      assert.notEqual(late.tmux_target, stuck.tmux_target, "two distinct panes, or one notice could serve both");
      assert.equal(
        blockNoticesNaming("standing-block-stuck").length,
        1,
        "and the first worker is still reported exactly once: two blocks, two independent claims",
      );

      // Only one standing watch is allowed per project at a time, so this must
      // not outlive its own test.
      await cancelWatch(watchId, setBy);
    });

    // ONE NOTICE, NOT ONE PER WORKER. A notice is delivered by a paste into a
    // pane, so the per-agent shape todo 314 shipped means three blocked crew
    // members are three pastes and three user turns in a lead's session about
    // one situation. That was fine while membership was a list the caller
    // wrote; project scope is what removed the bound, which is the same
    // argument the fork cost gets.
    //
    // THE FIXTURE IS THE ORDINARY CASE RATHER THAN A CONTRIVED ONE: both
    // workers are already sitting on their dialogs when the watch is created,
    // which is what "a lead sets a standing watch over a crew that is already
    // stuck" looks like. The dialogs are confirmed ON THE PANES before the
    // watch exists, so the first tick that can see the watch can see both
    // blocks - otherwise this could pass by filing two notices a tick apart
    // and never exercise the batch at all.
    it("names every crew member blocked in one tick in ONE notice", async () => {
      const owner = await spawnShowing("batch-block-owner", replayFixture("ready-idle.txt"));
      const first = await spawnShowing("batch-block-one", replayFixture("folder-trust-dialog.txt"));
      // A LEGAL NAME CARRYING A QUOTE. normalizeAgentName rejects control
      // characters and nothing else, so this is a name a user can really
      // create, and interpolating it between literal quotes rendered
      // agent_output(name: "batch"two") - a remedy the reader cannot run,
      // invisible to test/wire-surface.test.mjs because that guard reads the
      // template in source rather than a rendered body. The expectation below
      // is written out LITERALLY rather than through JSON.stringify, which
      // would just be the renderer asserting about itself.
      const second = await spawnShowing('batch"two', replayFixture("model-picker-dialog.txt"));
      await until(
        async () => onScreen(first.tmux_target, TRUST_DIALOG) && onScreen(second.tmux_target, "Esc"),
        15000,
      );
      assert.ok(onScreen(first.tmux_target, TRUST_DIALOG), "both dialogs must really be up first");
      markWaiting("batch-block-one", "2026-08-09 13:00:00");
      markWaiting('batch"two', "2026-08-09 13:00:00");

      const { watchId, setBy } = await ownedStandingWatch(
        "batch-block-owner",
        owner.agent_id,
        "INTEGRATION batch-block crew update",
      );

      await until(async () => blockNoticesNaming("batch-block-one").length > 0, 20000);
      const filed = blockNoticesNaming("batch-block-one");
      assert.equal(filed.length, 1, "one notice, not one per worker");
      assert.ok(
        filed[0].body.includes('agent_output(name: "batch\\"two")'),
        `a quote in a legal agent name must be escaped, or the remedy cannot be run: ${filed[0].body}`,
      );
      assert.deepEqual(
        db
          .prepare("SELECT id FROM timers WHERE parent_timer_id IS NULL AND kind = 'delay' AND body LIKE ?")
          .all('%agent_output(name: "batch\\"two")%')
          .map((n) => n.id),
        [filed[0].id],
        "the second worker's report IS that same row, not a second one",
      );
      // The roster's own count, checked against the body rather than against a
      // literal: a project-scope watch legitimately names every OTHER crew
      // member this file has left latched on a dialog, so the honest assertion
      // is that the number the reader is given matches the number of workers
      // listed under it.
      // A TAUTOLOGY TODAY, KEPT WITH THAT SAID (counselors round 1, opus F7).
      // The header count and the per-worker lines are both rendered from the
      // one `names` array in standingBlockNoticeBody, so this cannot currently
      // fail. It has power only against a future version that renders the two
      // from different sources - which is exactly the shape that would tell a
      // lead "2 crew members" above a list of three - so it is worth its two
      // lines, and worth not being mistaken for coverage it does not provide.
      const listed = filed[0].body.match(/agent_output\(name: "/g)?.length ?? 0;
      assert.ok(listed >= 2, "this notice must cover at least the two workers this test blocked");
      assert.equal(
        Number(filed[0].body.match(/^(\d+) crew member\(s\)/)[1]),
        listed,
        "the roster's count must match what it actually lists, or the reader is told a wrong number",
      );
      // The claims are still PER AGENT - the batch is the delivery vehicle,
      // not the key. Without this a single row keyed on the timer would look
      // identical here and would stop the second worker ever being re-reported
      // after it blocks again.
      assert.equal(
        db
          .prepare("SELECT COUNT(*) AS n FROM wake_block_notices WHERE timer_id = ? AND agent_id IN (?, ?)")
          .get(watchId, agentRow("batch-block-one").id, agentRow('batch"two').id).n,
        2,
        "two blocks, two claim rows, one notice",
      );
      await cancelWatch(watchId, setBy);
    });
  },
);

// WHAT THIS PINS AND WHAT IT DOES NOT, because the first version of its name
// claimed more than the fixture can see (counselors, opus). The seeded row
// takes deliverable()'s `!live` branch, which calls holdTimer directly, so no
// mutation inside ownerPaneToTell, claimModalHoldWithNotice, heldTarget or
// holdNoticeBody can turn this red - gut all four and it still passes. What
// it does kill is routing the lead-pane-dead hold through noteModalHold,
// which would fail both assertions below: held_reason would read the modal
// string, and agent:9's live pane would get a notice.
//
// The case its old name suggested - a MODAL hold whose owner has no live pane
// - is a NAMED RESIDUAL rather than a covered one: that hold latches
// held_reason with nobody told, and no later tick claims again. See
// claimModalHoldWithNotice's own comment on why that is accepted here (it
// fails silent, the pre-lane behaviour) and what closing it would cost.
describe("the lead-pane-dead hold stays silent", () => {
  it("records the hold and notifies nobody", () => {
    const { dataDir, tmp } = scratchDirs();
    const out = runFixture(
      tmp,
      "lead-pane-dead-hold",
      `const { db, migrate } = await import(${JSON.stringify(join(DIST, "db.js"))});\n` +
        `const { tick } = await import(${JSON.stringify(join(DIST, "scheduler.js"))});\n` +
        `migrate();\n${LEAD_DEAD_SEED}\n` +
        `await tick(snapshot);\nawait tick(snapshot);\n` +
        `const row = db.prepare("SELECT held_reason, fired_at FROM timers WHERE id = ?").get(timerId);\n` +
        `const total = db.prepare("SELECT COUNT(*) AS n FROM timers").get().n;\n` +
        `const ownerRunning = db.prepare("SELECT status FROM agents WHERE actor_id = 'agent:9'").get().status;\n` +
        `process.stdout.write(JSON.stringify({ heldReason: row.held_reason, fired: row.fired_at !== null, total, ownerRunning }));`,
      { HIVE_DATA_DIR: dataDir },
    );
    assert.match(out.heldReason ?? "", /not live/, "the lead-pane-dead hold must still be recorded");
    assert.equal(out.fired, false, "and the wake must not have fired");
    assert.equal(out.ownerRunning, "running", "the owner row must still be running, or this proves nothing");
    assert.equal(out.total, 1, "no notification row: this hold reason has no live pane to deliver one to");
  });
});

// TODO 321, STEP 3: THE FORK THE BLOCK HALF PAYS FOR A PANE WITH NO DIALOG ON
// IT. A worker that answered its prompt and carried on still reads `waiting`
// forever (issue #28's latch), so the only gate in front of the pane read -
// "have I already reported this block" - never fires for it and hive re-reads
// its screen on every tick, in every running session. Todo 314 accepted that
// on the grounds that the set was "small by construction"; project scope
// removed the bound, and a standing watch stays a candidate for its whole life
// where a one-shot leaves at fired_at.
//
// THE ASSERTION IS A COUNT OF capture-pane INVOCATIONS, NEVER AN ELAPSED TIME.
// A timing assertion here would be a flake generator, and the thing under test
// is literally "how many times did we fork", so counting the forks is both the
// stronger and the cheaper measurement. A `tmux` shim earlier on PATH logs
// every invocation and execs the real binary, so the fixture drives a REAL
// tmux against a REAL pane and still gets an exact count.
//
// The snapshot is passed in, so tick() never calls liveTargets() and the only
// capture-pane naming this pane can be the block half's own read.
describe("the block half does not re-read a pane it just found no dialog on", () => {
  it("reads a stale-`waiting` worker's pane once, not once per tick", { skip: hasTmux ? false : "no tmux" }, () => {
    const { dataDir, tmp } = scratchDirs();
    const realTmux = execFileSync("sh", ["-c", "command -v tmux"], { encoding: "utf8" }).trim();
    const shimDir = join(tmp, "shim");
    const log = join(tmp, "tmux-calls.log");
    mkdirSync(shimDir, { recursive: true });
    writeFileSync(
      join(shimDir, "tmux"),
      `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\nexec ${JSON.stringify(realTmux)} "$@"\n`,
    );
    chmodSync(join(shimDir, "tmux"), 0o755);

    // A real pane showing a real screen with NO dialog on it: the stale latch
    // this cache exists for. Created through the real tmux, in this file's own
    // isolated session, so the fixture's rowAlive and paneAwaitingChoice are
    // answering about something that genuinely exists.
    const pane = execFileSync(
      "tmux",
      ["new-window", "-P", "-F", "#{pane_id}", "-t", sessionName(), replayFixture("ready-idle.txt")],
      { encoding: "utf8" },
    ).trim();

    const out = runFixture(
      tmp,
      "no-dialog-fork-count",
      `const { db, migrate } = await import(${JSON.stringify(join(DIST, "db.js"))});\n` +
        `const { tick } = await import(${JSON.stringify(join(DIST, "scheduler.js"))});\n` +
        `const { tmuxSocketPath } = await import(${JSON.stringify(join(DIST, "tmux.js"))});\n` +
        `migrate();\n` +
        `const socket = tmuxSocketPath(process.env.TMUX, process.env.TMUX_TMPDIR);\n` +
        `const pane = ${JSON.stringify(pane)};\n` +
        `const project = db.prepare("INSERT INTO projects (name, path) VALUES ('fc', '/tmp/fc') RETURNING id").get().id;\n` +
        `db.prepare(\`INSERT INTO agents (project_id, actor_id, name, tmux_target, tmux_socket, command, cwd, kind, status, created_at)\n` +
        `  VALUES (?, 'lead:1', 'lead', '%dead', ?, 'claude', '/tmp', 'lead', 'running', datetime('now', '-300 seconds'))\`).run(project, socket);\n` +
        `db.prepare(\`INSERT INTO agents (project_id, actor_id, name, tmux_target, tmux_socket, command, cwd, kind, status,\n` +
        `    agent_state, state_changed_at, created_at)\n` +
        `  VALUES (?, 'agent:1', 'stale', ?, ?, 'claude', '/tmp', 'agent', 'running', 'waiting',\n` +
        `    datetime('now', '-120 seconds'), datetime('now', '-300 seconds'))\`).run(project, pane, socket);\n` +
        `const watchId = db.prepare(\`INSERT INTO timers (project_id, owner, body, kind, watch_scope, deliver_actor,\n` +
        `    deliver_pane, max_wait_at, created_at)\n` +
        `  VALUES (?, 'lead:1', 'crew update', 'idle_any', 'project', 'lead:1', '%dead',\n` +
        `    datetime('now', '+4 hours'), datetime('now', '-60 seconds')) RETURNING id\`).get(project).id;\n` +
        `const snapshot = { panes: new Set([pane]), windows: new Set() };\n` +
        `await tick(snapshot);\nawait tick(snapshot);\nawait tick(snapshot);\n` +
        `const notices = db.prepare("SELECT COUNT(*) AS n FROM wake_block_notices WHERE timer_id = ?").get(watchId).n;\n` +
        `process.stdout.write(JSON.stringify({ notices, watching: db.prepare("SELECT fired_at FROM timers WHERE id = ?").get(watchId).fired_at }));`,
      { HIVE_DATA_DIR: dataDir, TMUX_TMPDIR: process.env.TMUX_TMPDIR, PATH: `${shimDir}:${process.env.PATH}` },
    );

    const captures = readFileSync(log, "utf8")
      .split("\n")
      .filter((line) => line.startsWith("capture-pane") && line.includes(pane));
    execFileSync("tmux", ["kill-pane", "-t", pane], { stdio: "ignore" });

    // The positive half FIRST: a count of 0 would satisfy "not re-read" while
    // meaning the block half never looked at all, which is two
    // indistinguishable causes for one assertion (test/CLAUDE.md, shape 7).
    assert.ok(captures.length > 0, "the block half must actually have read this pane, or the count below is vacuous");
    assert.equal(captures.length, 1, `three ticks, one read: ${captures.join(" | ")}`);
    // And nothing was reported, which is what makes this the STALE latch case
    // rather than a worker that really is on a dialog.
    assert.equal(out.notices, 0, "a pane with no dialog on it must produce no block notice");
    assert.equal(out.watching, null, "and the watch must still be watching");
  });
});

// COUNSELORS ROUND 1, codex 3. blockNoticeTarget preferred the OWNER's pane on
// the strength of `status = 'running'` alone - and the janitor deliberately
// EXEMPTS kind='lead' rows, so a lead whose pane died keeps a running row
// naming a dead pane for as long as it likes. Owner-first then chose that dead
// pane over a live deliver_to, claimed the block episode against it, and
// nobody was ever told: this lane's own defect - silence about a blocked
// worker - reintroduced by this lane's own targeting rule.
//
// Real tmux for the dialog, because the decision under test happens AFTER the
// pane read: a fabricated snapshot cannot produce a dialog, and without one no
// notice is filed at all and the test would pass for the wrong reason.
describe("a block notice falls back when the owner's pane is dead", () => {
  it("files at the live delivery target, not at a lead row that is still 'running'", { skip: hasTmux ? false : "no tmux" }, () => {
    const { dataDir, tmp } = scratchDirs();
    const spawnPane = (fixture) =>
      execFileSync("tmux", ["new-window", "-P", "-F", "#{pane_id}", "-t", sessionName(), replayFixture(fixture)], {
        encoding: "utf8",
      }).trim();
    const stuckPane = spawnPane("folder-trust-dialog.txt");
    const tellPane = spawnPane("ready-idle.txt");
    // The dialog has to be painted before the fixture reads it, for the same
    // reason the standing tests above wait: a read that lands early answers
    // "no dialog" and the fixture proves nothing.
    execFileSync("sh", ["-c", `for i in $(seq 1 60); do tmux capture-pane -p -t ${stuckPane} | grep -q 'I trust this folder' && exit 0; sleep 0.25; done; exit 1`]);

    const out = runFixture(
      tmp,
      "dead-owner-pane-fallback",
      `const { db, migrate } = await import(${JSON.stringify(join(DIST, "db.js"))});\n` +
        `const { tick } = await import(${JSON.stringify(join(DIST, "scheduler.js"))});\n` +
        `const { tmuxSocketPath } = await import(${JSON.stringify(join(DIST, "tmux.js"))});\n` +
        `migrate();\n` +
        `const socket = tmuxSocketPath(process.env.TMUX, process.env.TMUX_TMPDIR);\n` +
        `const stuckPane = ${JSON.stringify(stuckPane)};\n` +
        `const tellPane = ${JSON.stringify(tellPane)};\n` +
        `const project = db.prepare("INSERT INTO projects (name, path) VALUES ('df', '/tmp/df') RETURNING id").get().id;\n` +
        // The lead: running, janitor-exempt, and its pane is NOT in the
        // snapshot below. That pairing is the whole fixture.
        `db.prepare(\`INSERT INTO agents (project_id, actor_id, name, tmux_target, tmux_socket, command, cwd, kind, status, created_at)\n` +
        `  VALUES (?, 'lead:1', 'lead', '%dead', ?, 'claude', '/tmp', 'lead', 'running', datetime('now', '-300 seconds'))\`).run(project, socket);\n` +
        `db.prepare(\`INSERT INTO agents (project_id, actor_id, name, tmux_target, tmux_socket, command, cwd, kind, status, agent_state, state_changed_at, created_at)\n` +
        `  VALUES (?, 'agent:2', 'teller', ?, ?, 'claude', '/tmp', 'agent', 'running', 'idle', datetime('now', '-200 seconds'), datetime('now', '-300 seconds'))\`).run(project, tellPane, socket);\n` +
        `db.prepare(\`INSERT INTO agents (project_id, actor_id, name, tmux_target, tmux_socket, command, cwd, kind, status, agent_state, state_changed_at, created_at)\n` +
        `  VALUES (?, 'agent:3', 'stuck', ?, ?, 'claude', '/tmp', 'agent', 'running', 'waiting', datetime('now', '-120 seconds'), datetime('now', '-300 seconds'))\`).run(project, stuckPane, socket);\n` +
        // Owned by the lead, delivered to the live worker: the exact shape a
        // lead sets when it wants a reviewer told instead of itself.
        `const watchId = db.prepare(\`INSERT INTO timers (project_id, owner, body, kind, watch_scope, deliver_actor, deliver_pane, max_wait_at, created_at)\n` +
        `  VALUES (?, 'lead:1', 'crew update', 'idle_any', 'project', 'agent:2', ?, datetime('now', '+4 hours'), datetime('now', '-60 seconds')) RETURNING id\`).get(project, tellPane).id;\n` +
        `const snapshot = { panes: new Set([stuckPane, tellPane]), windows: new Set() };\n` +
        // Two ticks: the first files the notice, the second delivers it. The
        // notice is the ONLY thing ever typed at tellPane, which is what makes
        // reading it back off that pane a stable assertion.
        `await tick(snapshot);\n` +
        `await tick(snapshot);\n` +
        `const notices = db.prepare("SELECT deliver_pane, deliver_actor, body FROM timers WHERE id != ? AND kind = 'delay'").all(watchId);\n` +
        `const claims = db.prepare("SELECT COUNT(*) AS n FROM wake_block_notices WHERE timer_id = ?").get(watchId).n;\n` +
        `const typed = db.prepare("SELECT typed_at FROM timers WHERE id != ? AND kind = 'delay' ORDER BY id LIMIT 1").get(watchId).typed_at;\n` +
        `process.stdout.write(JSON.stringify({ notices, claims, typed }));`,
      { HIVE_DATA_DIR: dataDir, TMUX_TMPDIR: process.env.TMUX_TMPDIR },
    );
    const screen = execFileSync("tmux", ["capture-pane", "-p", "-J", "-S", "-", "-t", tellPane], { encoding: "utf8" });
    for (const pane of [stuckPane, tellPane]) execFileSync("tmux", ["kill-pane", "-t", pane], { stdio: "ignore" });

    const about = out.notices.filter((n) => n.body.includes("stuck"));
    assert.equal(about.length, 1, `exactly one notice about the blocked worker: ${JSON.stringify(out.notices)}`);
    assert.equal(about[0].deliver_pane, tellPane, "filed at the LIVE delivery target, not the lead's dead pane");
    assert.equal(about[0].deliver_actor, "agent:2", "and as that actor: the pane and the actor come from one place");
    assert.equal(out.claims, 1, "and the episode is claimed exactly once");
    // FILED IS NOT TOLD (counselors round 1, codex 6). Everything above reads
    // rows; this reads the terminal. A standing block notice that never reaches
    // sendText passes every row assertion in this file and fails here.
    assert.ok(out.typed, "the notice must actually be typed, not merely filed");
    assert.match(screen, /hive wake #/, "and the marker must be on the delivery pane itself");
    assert.match(screen, /stuck/, "naming the crew member that needs a human");
  });
});

// FOUND BY THE PR GATE ON THIS LANE, after blockNoticeTarget's identical defect
// was fixed: ownerPaneToTell resolved the owner's pane on `status = 'running'`
// alone, and the janitor exempts kind='lead', so a lead whose pane died keeps a
// running row naming a dead pane indefinitely.
//
// WHAT IT COSTS, and it is not the notice - it is the CLAIM.
// claimModalHoldWithNotice claims wake_block_notices on the same (timer, agent,
// episode) key the wide half uses, and nothing re-arms that key inside an
// episode. So filing at a dead pane SPENT the one report that block was ever
// going to get: `hive lead`'s restart clears held_at/held_reason and re-points
// every lead-owned timer at the fresh pane, so this path runs again - and then
// loses the block key it burned while nobody was listening. The lead comes
// back and is told nothing about a worker that is still stuck.
//
// The second tick below is that restart, which is why this test is a SEQUENCE
// rather than an assertion that a dead pane yields null: a version that
// returns null AFTER claiming passes the first half and fails the second.
describe("a modal hold does not spend its claim on a dead lead pane", () => {
  it("stays silent while the owner's pane is dead, and tells it once the pane is live", { skip: hasTmux ? false : "no tmux" }, () => {
    const { dataDir, tmp } = scratchDirs();
    const spawnPane = (fixture) =>
      execFileSync("tmux", ["new-window", "-P", "-F", "#{pane_id}", "-t", sessionName(), replayFixture(fixture)], {
        encoding: "utf8",
      }).trim();
    const stuckPane = spawnPane("folder-trust-dialog.txt");
    const leadPane = spawnPane("ready-idle.txt");
    execFileSync("sh", ["-c", `for i in $(seq 1 60); do tmux capture-pane -p -t ${stuckPane} | grep -q 'I trust this folder' && exit 0; sleep 0.25; done; exit 1`]);

    const out = runFixture(
      tmp,
      "modal-hold-dead-owner",
      `const { db, migrate } = await import(${JSON.stringify(join(DIST, "db.js"))});\n` +
        `const { tick } = await import(${JSON.stringify(join(DIST, "scheduler.js"))});\n` +
        `const { tmuxSocketPath } = await import(${JSON.stringify(join(DIST, "tmux.js"))});\n` +
        `migrate();\n` +
        `const socket = tmuxSocketPath(process.env.TMUX, process.env.TMUX_TMPDIR);\n` +
        `const stuckPane = ${JSON.stringify(stuckPane)};\n` +
        `const leadPane = ${JSON.stringify(leadPane)};\n` +
        `const project = db.prepare("INSERT INTO projects (name, path) VALUES ('mh', '/tmp/mh') RETURNING id").get().id;\n` +
        `db.prepare(\`INSERT INTO agents (project_id, actor_id, name, tmux_target, tmux_socket, command, cwd, kind, status, created_at)\n` +
        `  VALUES (?, 'lead:1', 'lead', '%dead', ?, 'claude', '/tmp', 'lead', 'running', datetime('now', '-300 seconds'))\`).run(project, socket);\n` +
        `const stuckId = db.prepare(\`INSERT INTO agents (project_id, actor_id, name, tmux_target, tmux_socket, command, cwd, kind, status, agent_state, state_changed_at, created_at)\n` +
        `  VALUES (?, 'agent:2', 'stuck', ?, ?, 'claude', '/tmp', 'agent', 'running', 'waiting', datetime('now', '-120 seconds'), datetime('now', '-300 seconds')) RETURNING id\`).get(project, stuckPane, socket).id;\n` +
        // owner != deliver_actor is what ownerPaneToTell requires before it
        // resolves a pane at all, and it is the ordinary shape: a lead sets a
        // wake on a worker's pane.
        `const wakeId = db.prepare(\`INSERT INTO timers (project_id, owner, body, kind, deliver_actor, deliver_pane, due_at, created_at)\n` +
        `  VALUES (?, 'lead:1', 'go on then', 'delay', 'agent:2', ?, datetime('now', '-5 seconds'), datetime('now', '-60 seconds')) RETURNING id\`).get(project, stuckPane).id;\n` +
        `const snapshot = { panes: new Set([stuckPane, leadPane]), windows: new Set() };\n` +
        `await tick(snapshot);\n` +
        `const dead = { notices: db.prepare("SELECT COUNT(*) AS n FROM timers WHERE id != ?").get(wakeId).n,\n` +
        `  claims: db.prepare("SELECT COUNT(*) AS n FROM wake_block_notices").get().n,\n` +
        `  held: db.prepare("SELECT held_reason FROM timers WHERE id = ?").get(wakeId).held_reason };\n` +
        // `hive lead` restarting: the row is re-pointed at the fresh pane and
        // the restart CAS clears held_at/held_reason.
        `db.prepare("UPDATE agents SET tmux_target = ? WHERE actor_id = 'lead:1'").run(leadPane);\n` +
        `db.prepare("UPDATE timers SET held_at = NULL, held_reason = NULL WHERE id = ?").run(wakeId);\n` +
        `await tick(snapshot);\n` +
        `const alive = { notices: db.prepare("SELECT deliver_pane, body FROM timers WHERE id != ?").all(wakeId),\n` +
        `  claims: db.prepare("SELECT agent_id FROM wake_block_notices").all() };\n` +
        `process.stdout.write(JSON.stringify({ dead, alive, stuckId }));`,
      { HIVE_DATA_DIR: dataDir, TMUX_TMPDIR: process.env.TMUX_TMPDIR },
    );
    for (const pane of [stuckPane, leadPane]) execFileSync("tmux", ["kill-pane", "-t", pane], { stdio: "ignore" });

    // While the owner's pane is dead: held, but NOTHING claimed and nothing
    // filed. The hold itself is unaffected - only who hears about it.
    assert.equal(out.dead.notices, 0, "no notice may be filed at a dead owner pane");
    assert.equal(out.dead.claims, 0, "and the block episode must NOT be claimed by a path that told nobody");
    assert.match(out.dead.held ?? "", /modal choice/, "the hold itself still happens, or this proves nothing");

    // After the restart: the same episode is reported, which is only possible
    // because the claim above was never spent.
    assert.equal(out.alive.notices.length, 1, "the returning lead must be told about the block it missed");
    assert.equal(out.alive.notices[0].deliver_pane, leadPane, "at its fresh pane");
    assert.deepEqual(
      out.alive.claims.map((c) => c.agent_id),
      [out.stuckId],
      "and the episode is claimed exactly once, now that someone has actually been told",
    );
  });
});
