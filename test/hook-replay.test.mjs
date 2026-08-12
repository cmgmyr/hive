import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { DIST, REPO, assertScratchStore, clearHiveEnv, isolateTmux, runNode, scratchDirs } from "./helpers.mjs";

// Issue #32, half E. #24 was not a logic bug: stateFor's branches were
// probably correct for every payload the #24 lane had tried, and Claude Code
// sent one it did not have. This corpus does not fix that gap and cannot: it
// replays payloads Claude Code has ALREADY been observed sending, through the
// BUILT dist/hook.js, against a scratch store, and asserts the state it
// decides. A payload of a shape Claude Code has not yet been observed sending
// is not in here, by construction, so a next-version change to hook shapes
// gets past this suite exactly the way it got past #24's. Half D (a canary
// running a real claude against an isolated store, diffing observed shapes
// against a committed corpus) is what closes that gap; this is a net under
// it, never a substitute. See test/fixtures/hook-payloads/README.md for what
// is and is not covered, and why.
//
// Every fixture here was read out of agent_state_log on the live store,
// read-only, and copied byte-for-byte; none were hand-written from docs.

isolateTmux("the hook replay tests");
const { dataDir } = scratchDirs();

clearHiveEnv();
process.env.HIVE_DATA_DIR = dataDir;
await assertScratchStore();

const { db, migrate } = await import("../dist/db.js");
migrate();

const HOOK = join(DIST, "hook.js");
const FIXTURES = join(REPO, "test", "fixtures", "hook-payloads");

const project = db
  .prepare("INSERT INTO projects (name, path) VALUES (?, ?) RETURNING id")
  .get("hook-replay-test", dataDir).id;

function agentRow(name, state) {
  return db
    .prepare(
      `INSERT INTO agents (project_id, actor_id, name, tmux_target, command, cwd, status, agent_state)
       VALUES (?, ?, ?, '%9600', 'claude', '/tmp', 'running', ?) RETURNING id`,
    )
    .get(project, `agent:${name}`, name, state).id;
}

const stateOf = (id) => db.prepare("SELECT agent_state FROM agents WHERE id = ?").get(id).agent_state;

const logStateFor = (actorId) =>
  db.prepare("SELECT state FROM agent_state_log WHERE actor_id = ? ORDER BY id DESC LIMIT 1").get(actorId).state;

function fixture(name) {
  return readFileSync(join(FIXTURES, name), "utf8");
}

async function runHook(event, payload, actorId) {
  const { code } = await runNode(HOOK, [event], { dataDir, env: { HIVE_AGENT_ID: actorId }, stdin: payload });
  assert.equal(code, 0, `hook must always exit 0, actor ${actorId}`);
}

// The row stateFor decides, mirrored into agent_state_log verbatim except for
// its one non-value: a null decision (the notify/idle_prompt branch) logs as
// "unchanged" rather than a state agent_state can hold, and leaves the row at
// whatever it already was. That is the only row where "already was" matters:
// every other branch overwrites unconditionally, so a wrong starting value
// there would still pass. Deriving agent_state from it, rather than listing
// both, keeps the two from being able to disagree.
function expectedState(startState, decidedLogState) {
  return decidedLogState === "unchanged" ? startState : decidedLogState;
}

// [fixture file, hook event argv, starting agent_state]. Starting state is
// inert everywhere except notify-idle-prompt, where it is "working"
// specifically so a regression that started writing idle there would be
// caught rather than mistaken for the value the row already had.
const CASES = [
  ["prompt-user.json", "prompt", "idle", "working"],
  // Todo 373. Its STATE decision is the same as any other prompt, which is the
  // point: what differs is the latch it deliberately does not clear, and that
  // half is pinned in test/spawn-false-finish.test.mjs.
  ["prompt-spawn-announcement.json", "prompt", "idle", "working"],
  ["prompt-task-notification.json", "prompt", "idle", "working"],
  ["stop-subagents-running.json", "stop", "idle", "working"],
  ["stop-idle.json", "stop", "idle", "idle"],
  ["notify-idle-prompt.json", "notify", "working", "unchanged"],
  ["notify-permission-prompt.json", "notify", "idle", "waiting"],
];

describe("dist/hook.js decides the recorded state for every captured payload", () => {
  // No per-case reset: each row uses a distinct fixture file as its actor id
  // and gets its own agents row, so rows never collide and nothing another
  // case wrote is ever in scope for this one's assertions.
  for (const [file, event, startState, decidedLogState] of CASES) {
    it(`${file} (${event}) -> ${decidedLogState}`, async () => {
      const actorId = `agent:${file}`;
      const agent = agentRow(file, startState);

      await runHook(event, fixture(file), actorId);

      assert.equal(stateOf(agent), expectedState(startState, decidedLogState));
      assert.equal(logStateFor(actorId), decidedLogState);
    });
  }
});
