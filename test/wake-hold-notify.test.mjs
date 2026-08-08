import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import {
  DIST,
  REPO,
  isolateTmux,
  liveAgentRow,
  makeFakeClaude,
  McpClient,
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

const agentRow = (name) => db.prepare("SELECT actor_id, tmux_target FROM agents WHERE name = ?").get(name);

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
      const screen = execFileSync("tmux", ["capture-pane", "-p", "-J", "-t", owner.tmux_target], {
        encoding: "utf8",
      });
      assert.match(screen, /hive wake #/, "the owner's pane must show the delivered notification");
      assert.match(screen, /hold-notify-stuck/, "naming the worker that needs a human");

      // Clearing the dialog lets the ORIGINAL deliver normally, which is the
      // whole reason it was held rather than fired or cancelled.
      execFileSync("tmux", ["respawn-pane", "-k", "-t", stuck.tmux_target, "sleep 600"], { stdio: "ignore" });
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
      execFileSync("tmux", ["respawn-pane", "-k", "-t", stuck.tmux_target, replayFixture("ready-idle.txt")], {
        stdio: "ignore",
      });
      db.prepare("UPDATE agents SET agent_state = 'working', state_changed_at = ? WHERE name = ?").run(
        "2026-08-08 10:05:00",
        "block-notify-stuck",
      );
      await new Promise((resolve) => setTimeout(resolve, 4000));
      assert.equal(noticeCount(wakeId), 1, "nothing new while the worker is not blocked");

      execFileSync(
        "tmux",
        ["respawn-pane", "-k", "-t", stuck.tmux_target, replayFixture("model-picker-dialog.txt")],
        { stdio: "ignore" },
      );
      markWaiting("block-notify-stuck", "2026-08-08 10:06:00");
      await until(async () => noticeCount(wakeId) > 1, 15000);
      assert.equal(noticeCount(wakeId), 2, "a second block is a second condition and must be reported again");
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
      db.prepare("UPDATE agents SET agent_state = 'idle', state_changed_at = datetime('now') WHERE name = ?").run(
        "both-paths-other",
      );
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
