import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import {
  REPO,
  isolateTmux,
  liveAgentRow,
  makeFakeClaude,
  McpClient,
  repaintPaneAsSameWorker,
  scratchDirs,
  until,
} from "./helpers.mjs";

// TODO 391, ARM 2 - the half an implementer is most tempted to drop, and the
// half that covers the commonest death shape on a machine that actually
// prompts.
//
// WHY IT EXISTS AT ALL. stateForNotification (src/hook.ts) returns `waiting`
// for every notification that is not idle_prompt, latched until that turn's
// own stop, so a turn that dies AFTER a permission prompt reads `waiting` and
// never `working`. Measured against the live store: real workers sat `waiting`
// for 3.9 and 11.5 minutes, and three notify|waiting rows were the LAST ROW
// their worker ever wrote. An arm-1-only implementation passes every row of
// test/stall-report.test.mjs and misses all of that.
//
// THESE THREE CASES NEED A REAL PANE, which is why they are not in that file:
// arm 2's evidence is a FRESH, DEFINITE `awaitingChoice === false`, and the
// three answers it can give (false, true, null) are three different outcomes.
// The null case is pinned next door, since "no fact" is reachable without a
// pane at all.
//
// Real tmux, real spawned workers, real dialog fixtures, and the MCP server's
// own natural scheduler tick - the method test/wake-hold-notify.test.mjs uses
// for the sibling condition.
//
// EVERY ASSERTION IS OVER A RECORD OF WHAT HAPPENED: timers rows,
// wake_idle_notices rows and wake_block_notices rows, never a sample of
// agents.agent_state (test/CLAUDE.md).
const { hasTmux, cleanup } = isolateTmux("the stall report pane tests");

const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
// Claude Code relocates its whole state tree - transcripts included - when
// this is set, so hive resolves a worker's transcript under a directory this
// file owns instead of the developer's real ~/.claude.
const configDir = join(dirs.tmp, "claude-config");
process.env.CLAUDE_CONFIG_DIR = configDir;

const { sessionName } = await import("../dist/tmux.js");
const { db } = await import("../dist/db.js");

const FIXTURES = join(REPO, "test", "fixtures", "panes");
const replayFixture = (file) => `cat '${join(FIXTURES, file)}'; sleep 600`;

let mcp;

before(async () => {
  mcp = new McpClient({
    cwd: dirs.projectDir,
    dataDir: dirs.dataDir,
    env: { HIVE_SPAWN_READY_MS: "2000", CLAUDE_CONFIG_DIR: configDir },
  });
  await mcp.start();
  if (!hasTmux) return;
  execFileSync("tmux", ["new-session", "-d", "-s", sessionName(), "-x", "220", "-y", "50", "-c", dirs.projectDir]);
  // TWO PANES FOR THE WHOLE FILE, spawned once and repainted per case rather
  // than a fresh pair per case. Every pane is a pty, and this suite has hit
  // `fork failed: Device not configured` on a loaded machine - six panes to
  // exercise three screens is a cost with no assertion behind it. Nothing here
  // is about pane identity, so repaintPaneAsSameWorker is the right
  // instrument (its own comment says as much).
  await spawnShowing("stall-watcher", "sleep 600");
  await spawnShowing("stall-stuck", replayFixture("ready-idle.txt"));
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

const agentRow = (name) =>
  db.prepare("SELECT id, actor_id, tmux_target, cwd FROM agents WHERE name = ?").get(name);

// The store's own account of a worker latched `waiting`: what src/hook.ts
// writes on a Notification. Written directly because a fake claude fires no
// hooks - the pane fixture supplies the screen, this supplies the latch that
// decides whether hive bothers to look at it, and the session_id that decides
// which transcript it samples.
//
// `since` is the EPISODE, shared by the stall claim and the block claim, which
// is the whole point of the cross-condition rule below.
function markWaiting(name, since) {
  db.prepare("UPDATE agents SET agent_state = 'waiting', state_changed_at = ?, session_id = ? WHERE name = ?").run(
    since,
    `sid-${name}`,
    name,
  );
}

// The transcript Claude Code would have written for that session, at a chosen
// age. hive resolves it as <transcriptDir(agents.cwd)>/<session_id>.jsonl.
function writeTranscript(cwd, sessionId, ageSeconds) {
  const dir = join(configDir, "projects", cwd.replace(/[/.]/g, "-"));
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${sessionId}.jsonl`);
  writeFileSync(path, '{"type":"assistant"}\n');
  const when = (Date.now() - ageSeconds * 1000) / 1000;
  utimesSync(path, when, when);
}

// A standing watch owned by, and delivered to, a live worker's pane - the
// test session itself is a rowless `user:` actor with no pane, which is a
// genuine "nobody to tell" case the detector skips.
async function watchOwnedBy(name) {
  const watch = await mcp.call("wake_when_idle", {
    scope: "project",
    body: "crew update",
    deliver_to: agentRow(name).id,
    max_wait_seconds: 900,
  });
  db.prepare("UPDATE timers SET owner = ? WHERE id = ?").run(agentRow(name).actor_id, watch.wake_id);
  return watch.wake_id;
}

// A stall notice is the only notice this watch files that carries a parent
// link (claimBlockBatch passes null), so the parent is the discriminator
// between the two conditions rather than a substring of prose.
const stallNotices = (watchId) =>
  db.prepare("SELECT id, body FROM timers WHERE parent_timer_id = ? ORDER BY id").all(watchId);
const stallCursor = (watchId) =>
  db
    .prepare("SELECT agent_id, episode FROM wake_idle_notices WHERE timer_id = ? AND condition = 'stall'")
    .all(watchId);
const blockCursor = (watchId) =>
  db.prepare("SELECT agent_id, blocked_since FROM wake_block_notices WHERE timer_id = ?").all(watchId);
const blockNotices = (watchId) =>
  db
    .prepare("SELECT id, body FROM timers WHERE parent_timer_id IS NULL AND body LIKE ? ORDER BY id")
    .all(`%watch #${watchId}%`);

const STALE_SECONDS = 30 * 60;

// ONE MCP SERVER AND ONE STORE SERVE EVERY CASE, and the crew is a QUERY
// rather than a list, so an earlier case's leftovers are members of the next
// one's. Each case therefore starts from a known floor: the latch cleared
// (which takes the row out of the stall population without closing it, since
// closing would put it into the gone half's instead) and every earlier watch
// retired so its own ticks stop adding rows to the tables this case counts.
//
// EACH CASE ALSO GETS ITS OWN EPISODE. The episode key is the latch's own
// moment and both the stall claim and the block claim are keyed on it, so
// reusing one value across cases would let case two lose a claim case one
// already made and read as a product decision.
function freshCase(episode, fixture) {
  db.prepare("UPDATE agents SET agent_state = 'unknown', state_changed_at = NULL WHERE kind = 'agent'").run();
  db.prepare(
    "UPDATE timers SET cancelled_at = datetime('now') WHERE cancelled_at IS NULL AND watch_scope IS NOT NULL",
  ).run();
  const row = agentRow("stall-stuck");
  repaintPaneAsSameWorker(db, row.tmux_target, replayFixture(fixture));
  markWaiting("stall-stuck", episode);
  writeTranscript(row.cwd, "sid-stall-stuck", STALE_SECONDS);
  return agentRow("stall-stuck");
}

describe("arm 2: a `waiting` worker whose pane shows no dialog", { skip: hasTmux ? false : "no tmux" }, () => {
  // THE ROW THE WHOLE MATRIX EXISTS FOR. Without it, an implementation that
  // ships ARM 1 ONLY passes every other test in this lane.
  it("is reported when its transcript has gone quiet past the bound", async () => {
    const row = freshCase("2020-01-01 00:00:00", "ready-idle.txt");
    const watchId = await watchOwnedBy("stall-watcher");

    // ASSERT THE WAIT ITSELF. `until` RETURNS false on timeout rather than
    // throwing, so an un-asserted call turns a slow machine into a confusing
    // failure on the NEXT assertion instead of naming the real cause.
    assert.ok(
      await until(() => stallNotices(watchId).length > 0, 30000),
      "no stall notice was filed within 30s - the scheduler ticks every 3s, so this is a stalled tick, not a count",
    );

    const filed = stallNotices(watchId);
    assert.equal(filed.length, 1, "one stall notice for the one stalled crew member");
    assert.match(filed[0].body, /stall-stuck: has claimed `waiting`/);
    assert.match(
      filed[0].body,
      /its pane shows no dialog/,
      "arm 2's sentence must say what it actually checked, or the body mis-describes its own evidence",
    );
    assert.match(filed[0].body, /transcript has not been written for/);
    assert.equal(stallCursor(watchId).length, 1, "and the episode was claimed once");
    assert.equal(stallCursor(watchId)[0].agent_id, row.id);

  });

  // A LIVE DIALOG BELONGS TO THE BLOCK HALF, NOT HERE. Being wrong in this
  // direction means telling a lead that a worker sitting on a prompt nobody
  // has answered has a dead turn - a different remedy from the true one, on
  // the one fact that decides what to do next.
  it("says nothing while a dialog really is up, and leaves that to the block report", async () => {
    freshCase("2020-01-02 00:00:00", "folder-trust-dialog.txt");
    const watchId = await watchOwnedBy("stall-watcher");

    // The block half speaking is the POSITIVE CONTROL: it proves this fixture
    // reached the code at all, so "no stall notice" is a decision rather than
    // a tick that never ran.
    assert.ok(
      await until(() => blockNotices(watchId).length > 0, 30000),
      "the block half never spoke, so this case cannot say anything about what the stall half did",
    );
    // Several more ticks with the dialog still up.
    await new Promise((r) => setTimeout(r, 5000));

    assert.equal(stallNotices(watchId).length, 0, "a dialogged pane is not a stall, whatever the transcript says");
    assert.equal(stallCursor(watchId).length, 0, "and no stall episode was claimed");
    assert.equal(blockNotices(watchId).length, 1, "the block half said the true thing, once");
  });

  // THE CROSS-CONDITION CLAIM. The block half and arm 2 read ONE population,
  // so without a shared key they claim in different tables and the lead gets
  // two paragraphs about one worker that contradict each other on the one
  // fact that decides what to do next. The sequence below is the real one: a
  // dialog goes up and is reported, a human answers it, and the pane then
  // shows no dialog while the LATCH HAS NOT MOVED - which is exactly what arm
  // 2 fires on.
  it("stays quiet about an episode the block half has already spoken about", async () => {
    const row = freshCase("2020-01-03 00:00:00", "folder-trust-dialog.txt");
    const watchId = await watchOwnedBy("stall-watcher");

    assert.ok(
      await until(() => blockNotices(watchId).length > 0, 30000),
      "the block half never spoke, so there is no prior claim for arm 2 to lose against",
    );
    assert.equal(blockCursor(watchId).length, 1, "the block half claimed the episode first");

    // The dialog is answered. The pane clears; the latch does NOT move,
    // because nothing about answering a dialog writes a hook event on its
    // own - which is the very latch this feature exists to distrust.
    repaintPaneAsSameWorker(db, row.tmux_target, replayFixture("ready-idle.txt"));
    await new Promise((r) => setTimeout(r, 6000));

    assert.equal(
      stallNotices(watchId).length,
      0,
      "one episode, one report: arm 2 must lose the block key rather than contradict it",
    );
    assert.equal(stallCursor(watchId).length, 0);
    assert.equal(blockNotices(watchId).length, 1, "and the block half still spoke exactly once");
  });
});
