import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import {
  DIST,
  assertScratchStore,
  clearHiveEnv,
  isolateTmux,
  runNode,
  scratchDirs,
  until,
} from "./helpers.mjs";

// Issue #24. wake_when_idle fired while a worker was blocked on its own
// background subagents, because the Stop hook fires when the worker's TURN
// ends and hive recorded that as idle. A lead that trusts the signal verifies a
// half-finished branch.
//
// Two halves, and both are pinned here because only the pair is the fix. The
// hook now reads background_tasks out of the Stop payload, so idle means the
// work stopped rather than the turn stopped. The scheduler carries the watched
// panes into the wake body, so a future regression in that payload field is
// something a lead can see instead of something hive hides.

const { hasTmux, cleanup } = isolateTmux("the false-idle tests");
const { dataDir, projectDir, tmp } = scratchDirs();

clearHiveEnv();
process.env.HIVE_DATA_DIR = dataDir;
// This file deletes rows between tests. Prove the store is scratch before
// opening it, not after.
await assertScratchStore();

const { db, migrate } = await import("../dist/db.js");
const { tick } = await import("../dist/scheduler.js");
const { ENTER_DELAY_MS, maskChoiceMarker, paneAwaitingChoice, sanitizeTail, sendText } = await import(
  "../dist/tmux.js"
);
migrate();

const HOOK = join(DIST, "hook.js");

const project = db
  .prepare("INSERT INTO projects (name, path) VALUES (?, ?) RETURNING id")
  .get("false-idle-test", projectDir).id;

// Age clears the janitor's 15-second spawn-race guard, which is a separate
// protection that must keep working.
//
// state defaults to "idle", the state the #24 bug PRODUCED, so a test asserting
// "working" can only pass if the hook actually wrote it. It defaulted to
// "working" and the two flagship pins seeded rows with the value they went on
// to assert. That matters more here than it looks: hook.ts swallows every
// exception and always exits 0, by design, so an inert hook is indistinguishable
// from a working one unless the row starts somewhere else. A missing migration,
// a bad HIVE_AGENT_ID handoff or a failed db open would all have left those
// tests green.
function agentRow(name, target, state = "idle") {
  return db
    .prepare(
      `INSERT INTO agents (project_id, actor_id, name, tmux_target, command, cwd, status,
         agent_state, created_at)
       VALUES (?, ?, ?, ?, 'claude', '/tmp', 'running', ?, datetime('now', '-60 seconds'))
       RETURNING id`,
    )
    .get(project, `agent:${name}`, name, target, state).id;
}

const stateOf = (id) => db.prepare("SELECT agent_state FROM agents WHERE id = ?").get(id).agent_state;

function reset() {
  db.exec("DELETE FROM timers; DELETE FROM agents; DELETE FROM agent_state_log;");
}

// What hive recorded, in order, rather than what the row happens to say now.
// The whole reason #24 survived its own fix and its own smoke test is that
// agents.agent_state is overwritten in place; asserting on a reading of it
// reproduces the blind spot rather than testing for it.
const sequenceFor = (actorId) =>
  db
    .prepare("SELECT event, state FROM agent_state_log WHERE actor_id = ? ORDER BY id")
    .all(actorId)
    .map((r) => [r.event, r.state]);

// Runs the real hook binary the way Claude Code runs it: a separate process,
// the event as argv[2], the payload as JSON on stdin. Nothing here is stubbed,
// which matters because reading stdin at all is part of what changed.
async function runHook(event, payload, actorId) {
  const { code } = await runNode(HOOK, [event], {
    dataDir,
    env: { HIVE_AGENT_ID: actorId },
    stdin: payload ?? "",
  });
  return code;
}

// The payloads below are the shapes captured from Claude Code 2.1.220, trimmed
// to the fields hive reads. The full captures are on todo 57.
const stopPayload = (tasks) =>
  JSON.stringify({
    session_id: "s",
    hook_event_name: "Stop",
    stop_hook_active: false,
    last_assistant_message: "ok",
    background_tasks: tasks,
    session_crons: [],
  });

const RUNNING_SUBAGENT = {
  id: "af205d5098bf85bc2",
  type: "subagent",
  status: "running",
  description: "Write paperclip history essay",
  agent_type: "general-purpose",
};

const RUNNING_SHELL = {
  id: "burq3th58",
  type: "shell",
  status: "running",
  description: "Sleep for 120 seconds in background",
  command: "sleep 120",
};

describe("the Stop hook tells a finished turn from finished work", () => {
  beforeEach(reset);

  it("records working, not idle, while a background subagent is live", async () => {
    // The bug, exactly. Before this change the Stop hook wrote "idle" here and
    // a lead's wake_when_idle fired on a lane with four review subagents still
    // running.
    // Seeded "idle" explicitly, not by default: this is THE regression pin for
    // the whole branch and it should say out loud where it starts.
    const agent = agentRow("blocked-on-subagents", "%9500", "idle");

    const code = await runHook("stop", stopPayload([RUNNING_SUBAGENT]), "agent:blocked-on-subagents");

    assert.equal(code, 0, "a hook must always exit 0");
    assert.equal(
      stateOf(agent),
      "working",
      "a turn that ended because the worker is waiting on its own subagents is not idle",
    );
  });

  it("records idle once the subagents are gone", async () => {
    // The other half. If this ever stops passing, wake_when_idle never fires
    // at all and every wake rides to max_wait, which is a worse bug than the
    // one being fixed.
    const agent = agentRow("done", "%9501", "working");

    await runHook("stop", stopPayload([]), "agent:done");

    assert.equal(stateOf(agent), "idle");
  });

  it("does not count a background shell as work in flight", async () => {
    // Backgrounded Bash rides in the same array tagged type "shell". Counting
    // the array's length instead of filtering by type would leave a worker
    // running `npm run watch` permanently non-idle: unlike a subagent, a
    // background shell need never end and never re-prompts its parent when it
    // does.
    const agent = agentRow("watcher", "%9502", "working");

    await runHook("stop", stopPayload([RUNNING_SHELL]), "agent:watcher");

    assert.equal(stateOf(agent), "idle", "a background shell is not a reason to withhold idle");
  });

  it("counts the subagent even when a shell is alongside it", async () => {
    const agent = agentRow("both", "%9503", "idle");

    await runHook("stop", stopPayload([RUNNING_SHELL, RUNNING_SUBAGENT]), "agent:both");

    assert.equal(stateOf(agent), "working");
  });

  it("ignores a subagent that is no longer running", async () => {
    const agent = agentRow("finished-subagent", "%9504", "working");

    await runHook(
      "stop",
      stopPayload([{ ...RUNNING_SUBAGENT, status: "completed" }]),
      "agent:finished-subagent",
    );

    assert.equal(stateOf(agent), "idle");
  });

  it("counts a subagent that has not started yet", async () => {
    // The whitelist this replaced re-opened #24: status === "running" read
    // every other value as not-in-flight, so a subagent that is launched but
    // not yet started wrote idle and the lead woke on a lane with no subagent
    // output at all. Seeded "idle" so "working" can only come from the hook.
    const queued = agentRow("queued-subagent", "%9520", "idle");
    const starting = agentRow("starting-subagent", "%9521", "idle");
    const unknown = agentRow("unknown-status", "%9522", "idle");

    await runHook("stop", stopPayload([{ ...RUNNING_SUBAGENT, status: "queued" }]), "agent:queued-subagent");
    await runHook("stop", stopPayload([{ ...RUNNING_SUBAGENT, status: "starting" }]), "agent:starting-subagent");
    await runHook("stop", stopPayload([{ type: "subagent", id: "x" }]), "agent:unknown-status");

    assert.equal(stateOf(queued), "working", "a queued subagent is work in flight");
    assert.equal(stateOf(starting), "working");
    assert.equal(stateOf(unknown), "working", "a status hive does not recognise must count as live");
  });

  it("still lets every terminal status through as idle", async () => {
    // The other side of the denylist. If this stops passing, wake_when_idle
    // never fires and every wake rides to max_wait.
    for (const status of ["completed", "failed", "cancelled", "killed"]) {
      const agent = agentRow(`terminal-${status}`, `%95${status.length}0`, "working");

      await runHook("stop", stopPayload([{ ...RUNNING_SUBAGENT, status }]), `agent:terminal-${status}`);

      assert.equal(stateOf(agent), "idle", `${status} is a finished subagent`);
    }
  });

  it("falls back to idle when the payload says nothing hive understands", async () => {
    // A Claude Code that stops sending background_tasks, or sends nothing at
    // all, must land on the behaviour hive had before this change rather than
    // on a crash or a stuck worker.
    const missing = agentRow("no-field", "%9505", "working");
    const garbage = agentRow("not-json", "%9506", "working");
    const empty = agentRow("no-stdin", "%9507", "working");

    await runHook("stop", JSON.stringify({ hook_event_name: "Stop" }), "agent:no-field");
    await runHook("stop", "this is not json", "agent:not-json");
    await runHook("stop", "", "agent:no-stdin");

    assert.equal(stateOf(missing), "idle");
    assert.equal(stateOf(garbage), "idle");
    assert.equal(stateOf(empty), "idle");
  });

  it("still maps prompt and a permission notification the way it always has", async () => {
    // The Stop branch now reads stdin, and stdin is a one-shot read. A
    // regression that drained it in the wrong branch would show up here.
    //
    // The third case this used to cover, an idle prompt writing "idle", moved
    // to the notify describe below. It was pinning the bug.
    const working = agentRow("prompted", "%9508", "idle");
    const waiting = agentRow("notified", "%9509", "idle");

    await runHook("prompt", JSON.stringify({ prompt: "go" }), "agent:prompted");
    await runHook("notify", JSON.stringify({ message: "Permission needed" }), "agent:notified");

    assert.equal(stateOf(working), "working");
    assert.equal(stateOf(waiting), "waiting");
  });
});

// Issue #24, the second door. The branch above was fixed and shipped as 2565164
// and the bug reproduced the same morning, because the idle that fired the wake
// was never written by the Stop hook at all. Claude Code emits a Notification
// sixty seconds after a Stop with no user input, hive matched its message text
// and wrote "idle", and a worker blocked on four live subagents was recorded
// finished. The captured payloads are on todo 61 comment 82.
//
// Every assertion here is over the SEQUENCE in agent_state_log, never over a
// reading of agents.agent_state. The original lane passed its smoke test by
// sampling two seconds late.
describe("a notification can never write idle", () => {
  beforeEach(reset);

  // Verbatim from the capture, trimmed to the fields hive reads.
  const notification = (extra) =>
    JSON.stringify({ session_id: "ea2dc8a9", hook_event_name: "Notification", ...extra });

  const IDLE_PROMPT = notification({
    message: "Claude is waiting for your input",
    notification_type: "idle_prompt",
  });
  const PERMISSION_PROMPT = notification({
    message: "Claude needs your permission",
    notification_type: "permission_prompt",
  });

  it("leaves a worker blocked on live subagents exactly where the Stop hook left it", async () => {
    // THE regression. Seeded "idle" so "working" can only come from the hook,
    // then driven through the real sequence: a Stop with a subagent still
    // running, then the sixty-second notification that used to undo it.
    const agent = agentRow("blocked-then-notified", "%9530", "idle");

    await runHook("stop", stopPayload([RUNNING_SUBAGENT]), "agent:blocked-then-notified");
    await runHook("notify", IDLE_PROMPT, "agent:blocked-then-notified");

    assert.deepEqual(
      sequenceFor("agent:blocked-then-notified"),
      [
        ["stop", "working"],
        ["notify", "unchanged"],
      ],
      "the notification must decide nothing; it cannot see whether subagents are live",
    );
    assert.equal(
      stateOf(agent),
      "working",
      "scheduler.ts fires idle_any only on agent_state = 'idle', so this is the wake not firing",
    );
  });

  it("records the no-op instead of passing over it in silence", async () => {
    // A branch that deliberately does nothing is invisible unless it says so.
    // Both #24 lanes lost a day to not knowing which branch wrote an idle.
    const agent = agentRow("noop-logged", "%9531", "waiting");

    await runHook("notify", IDLE_PROMPT, "agent:noop-logged");

    const rows = db
      .prepare("SELECT event, state, payload FROM agent_state_log WHERE actor_id = ?")
      .all("agent:noop-logged");
    assert.equal(rows.length, 1, "the event still happened and still gets a row");
    assert.equal(rows[0].state, "unchanged");
    assert.match(rows[0].payload, /idle_prompt/, "with the payload that decided it");
    assert.equal(stateOf(agent), "waiting", "and a worker stuck on a dialog is not idle either");
  });

  it("still reports a worker blocked on a permission prompt", async () => {
    // The half of this branch that was always right. If it stops working a lead
    // loses the one signal that says a worker needs a human.
    const agent = agentRow("needs-human", "%9532", "working");

    await runHook("notify", PERMISSION_PROMPT, "agent:needs-human");

    assert.deepEqual(sequenceFor("agent:needs-human"), [["notify", "waiting"]]);
    assert.equal(stateOf(agent), "waiting");
  });

  it("writes waiting, never idle, for a notification type hive does not know", async () => {
    // Statuses and vocabularies grow. "waiting" is not idle, so an unrecognised
    // notification can cost a wake its promptness and can never fire one early.
    const agent = agentRow("unknown-type", "%9533", "working");

    await runHook("notify", notification({ message: "?", notification_type: "some_new_thing" }), "agent:unknown-type");

    assert.equal(stateOf(agent), "waiting");
  });

  it("falls back to the message text only when notification_type is absent", async () => {
    // An older Claude Code sends no notification_type. hive pins no version, so
    // that payload is real, and its answer is inverted along with everything
    // else: the idle prose decides nothing rather than deciding idle.
    const old = agentRow("old-claude-idle", "%9534", "working");
    const older = agentRow("old-claude-permission", "%9535", "working");

    await runHook("notify", JSON.stringify({ message: "Claude is waiting for your input" }), "agent:old-claude-idle");
    await runHook("notify", JSON.stringify({ message: "Permission needed" }), "agent:old-claude-permission");

    assert.deepEqual(sequenceFor("agent:old-claude-idle"), [["notify", "unchanged"]]);
    assert.equal(stateOf(old), "working", "the fallback path cannot re-open this either");
    assert.equal(stateOf(older), "waiting");
  });

  it("prefers notification_type over the prose when they disagree", async () => {
    // The wording is Claude Code's to change and the field is the contract. A
    // reworded idle prompt must not be able to reach the "waiting" branch, and a
    // permission prompt that happens to quote the old sentence must not be able
    // to reach the no-op.
    const reworded = agentRow("reworded", "%9536", "working");
    const quoting = agentRow("quoting", "%9537", "working");

    await runHook("notify", notification({ message: "Claude is idle", notification_type: "idle_prompt" }), "agent:reworded");
    await runHook(
      "notify",
      notification({ message: "Claude is waiting for your input to a permission prompt", notification_type: "permission_prompt" }),
      "agent:quoting",
    );

    assert.deepEqual(sequenceFor("agent:reworded"), [["notify", "unchanged"]]);
    assert.deepEqual(sequenceFor("agent:quoting"), [["notify", "waiting"]]);
  });

  it("lets the next real event move the worker on, so nothing gets stuck", async () => {
    // The failure mode of "do not downgrade a working state" is a state machine
    // that can never leave it. This one has no memory to get stuck in: the
    // notification writes nothing and the next Stop decides with the payload in
    // hand, which is the same self-healing the stop branch rests on.
    const agent = agentRow("unsticks", "%9538", "idle");

    await runHook("stop", stopPayload([RUNNING_SUBAGENT]), "agent:unsticks");
    await runHook("notify", IDLE_PROMPT, "agent:unsticks");
    await runHook("prompt", JSON.stringify({ prompt: "<task-notification>" }), "agent:unsticks");
    await runHook("stop", stopPayload([]), "agent:unsticks");

    assert.deepEqual(sequenceFor("agent:unsticks"), [
      ["stop", "working"],
      ["notify", "unchanged"],
      ["prompt", "working"],
      ["stop", "idle"],
    ]);
    assert.equal(stateOf(agent), "idle", "the wake fires here, which is where it always should have");
  });
});

describe("sanitizeTail keeps a worker's screen from typing into a lead's prompt", () => {
  // The wake body is delivered verbatim into a terminal as a user turn, and the
  // tail is the one part of it hive did not author. tmux renders a pane to a
  // screen, so capture-pane output is normally already clean, which is why this
  // is pinned directly: nothing reachable through a real pane would notice if
  // it stopped working.
  //
  // Control bytes are constructed, never written literally into this file.
  const ESC = String.fromCharCode(27);
  const ETX = String.fromCharCode(3);
  const DEL = String.fromCharCode(127);

  it("strips control bytes and keeps the text around them", () => {
    const out = sanitizeTail(`before${ETX}after`);

    assert.equal(out, "beforeafter");
    assert.ok(!out.includes(ETX), "a literal 0x03 in a lead's prompt is Ctrl-C");
  });

  it("strips ESC, which would otherwise close the bracketed paste early", () => {
    const out = sanitizeTail(`${ESC}[201~ rest of the tail`);

    assert.ok(!out.includes(ESC), "an ESC ends the paste and the remainder arrives as keys");
    assert.match(out, /rest of the tail/);
  });

  it("strips DEL too", () => {
    assert.equal(sanitizeTail(`a${DEL}b`), "ab");
  });

  it("keeps newlines, because the note is meant to be several lines", () => {
    assert.equal(sanitizeTail("one\ntwo"), "one\ntwo");
  });

  it("drops blank lines and keeps the last few lines of content", () => {
    const raw = Array.from({ length: 20 }, (_, i) => `line${i}`).join("\n\n");

    const lines = sanitizeTail(raw).split("\n");

    assert.equal(lines.length, 6, "the tail is capped so a wake stays cheap");
    assert.equal(lines.at(-1), "line19", "and it is the END of the screen that matters");
    assert.ok(!lines.includes(""), "blank rows waste the cap");
  });

  it("truncates a very long line instead of pasting a whole screen width", () => {
    const out = sanitizeTail("x".repeat(500));

    assert.equal(out.length, 160);
  });
});

// Round 2, D5. watchedTail embeds a captured worker screen into a wake body
// that hive itself types into the LEAD's pane. A worker sitting on a real
// dialog carries "Esc to cancel" in its tail, so without masking it, hive
// would type its own detector's trigger into the lead's terminal, and
// deliver()'s cache invalidation guarantees the next timer re-reads it. D5
// mostly closes this already (the lead's pane also carries the input-box
// marker, so it no longer reads as a dialog either way), but the mask is
// cheap and does not depend on that holding: hive should not be able to
// trigger itself.
describe("maskChoiceMarker keeps a wake body from becoming its own trigger", () => {
  it("removes the exact substring paneAwaitingChoice matches on", () => {
    const out = maskChoiceMarker("some transcript\n Enter to confirm · Esc to cancel\nmore text");

    assert.ok(!out.includes("Esc to cancel"), "the marker must not survive into a wake body");
    assert.match(out, /some transcript/);
    assert.match(out, /more text/);
  });

  it("leaves ordinary text with no marker untouched", () => {
    assert.equal(maskChoiceMarker("nothing to see here"), "nothing to see here");
  });
});

describe("an idle wake carries what hive saw on the watched panes", { skip: hasTmux ? false : "tmux is not installed" }, () => {
  // The safety net half. The idle signal is correct now, but it rests on an
  // undocumented Claude Code payload field; if that field is renamed hive goes
  // quietly back to reporting a worker as finished while its subagents run. A
  // lead holding only "Act now" has nothing to catch that with. Carrying the
  // pane makes the regression visible instead of silent.
  const session = `hive-falseidle-${process.pid}`;
  const outFile = join(tmp, "delivered.txt");
  // What the watched worker's screen shows: the real bug's own line.
  const MARKER = "HIVE24 waiting for 4 background agents to finish";
  let watchedPane;
  let deliveryPane;

  before(() => {
    if (!hasTmux) return;
    execFileSync(
      "tmux",
      ["new-session", "-d", "-s", session, "-x", "200", "-y", "50", `printf '%s\\n' '${MARKER}'; sleep 600`],
      { stdio: "ignore" },
    );
    // The delivery pane runs cat, so whatever the scheduler types is captured
    // as bytes rather than inferred from the store. A wake body asserted from
    // the row it was built from proves nothing about what reached the terminal.
    execFileSync("tmux", ["new-window", "-d", "-t", `=${session}`, `cat > ${outFile}`], {
      stdio: "ignore",
    });
    const panes = execFileSync("tmux", ["list-panes", "-s", "-t", `=${session}`, "-F", "#{pane_id}"], {
      encoding: "utf8",
    })
      .trim()
      .split("\n");
    [watchedPane, deliveryPane] = panes;
  });

  after(() => cleanup(session));
  // The delivery pane appends, so a test that does not start from empty can
  // match the previous test's output and pass for the wrong reason.
  beforeEach(() => {
    reset();
    writeFileSync(outFile, "");
  });

  const delivered = () => readFileSync(outFile, "utf8");

  // created_at is REAL, not backdated, and every caller sets the wake BEFORE the
  // transition it is waiting for. That is production ordering and it used to be
  // inverted here: the timer was aged sixty seconds, so a transition that
  // happened before the wake was set still satisfied
  // `state_changed_at >= timer.created_at` and every test read as passing
  // whichever way round it was written. Counselors found it by way of a feature
  // whose whole failure mode was an agent that never transitions again, and no
  // test in this file could see it.
  //
  // Note this is specific to idle_any, where created_at is part of the FIRING
  // decision. The delay wakes below still age their rows, because there
  // created_at only clears the janitor's spawn-race settle window and has no
  // part in whether the timer fires.
  function idleWake(agentId) {
    return db
      .prepare(
        `INSERT INTO timers (project_id, owner, body, kind, watch, deliver_actor, deliver_pane,
           max_wait_at, created_at)
         VALUES (?, 'user:test', 'lane check', 'idle_any', ?, 'user:test', ?,
           datetime('now', '+1 hour'), datetime('now'))
         RETURNING id`,
      )
      .get(project, JSON.stringify([agentId]), deliveryPane).id;
  }

  // The transition idle_any is waiting for, written after the wake exists.
  const goIdle = (agentId) =>
    db
      .prepare("UPDATE agents SET agent_state = 'idle', state_changed_at = datetime('now') WHERE id = ?")
      .run(agentId);

  it("delivers the watched worker's terminal alongside the body", async () => {
    const agent = agentRow("tailed", watchedPane, "working");
    // Wake first, then the transition: the order a lead actually produces.
    const wake = idleWake(agent);
    goIdle(agent);

    await tick();
    await until(() => delivered().includes(MARKER));

    const text = delivered();
    assert.match(text, new RegExp(`\\[hive wake #${wake}\\]`), "the wake still delivers");
    assert.match(text, /lane check/, "and still carries the body it was given");
    assert.ok(
      text.includes(MARKER),
      `the watched pane's screen must ride along; got: ${JSON.stringify(text)}`,
    );
    assert.match(text, /read agent_output before acting/, "and say what to do with it");
    // The block used to be built as a sparse array whose leading blank line was
    // eaten by the filter that dropped the optional "N more" entry, so the body
    // ran straight into the header: "lane check--- what hive sees ---". Nothing
    // asserted the separator, so nothing caught it.
    assert.match(
      text,
      /lane check\r?\n/,
      "the body must end before the tail block starts, not run into it",
    );
  });

  it("names the worker and the state hive reports for it now", async () => {
    const agent = agentRow("named-in-tail", watchedPane, "working");
    idleWake(agent);
    goIdle(agent);

    await tick();
    await until(() => delivered().includes("named-in-tail"));

    const text = delivered();
    assert.match(text, /named-in-tail/, "a lead watching several workers needs to know which one");
    assert.match(text, /hive state now: idle/);
  });

  it("does not fire on a transition that happened before the wake was set", async () => {
    // The documented half of idle_any, and until now nothing exercised it: a
    // worker that was ALREADY idle when the lead set the wake does not count,
    // because the lead is waiting for the NEXT thing to finish, not for the
    // state it could already see. The wake rides to max_wait instead.
    //
    // This is also the shape that hid a real bug: a watched agent that never
    // transitions again can never satisfy an idle_any wake. That is correct for
    // "idle", which a worker leaves and re-enters every turn. It is fatal for
    // any state nothing writes back, which is why also_when_stuck was dropped.
    const agent = agentRow("idle-before-the-wake", watchedPane, "working");
    goIdle(agent);
    // Strictly before the wake, since these timestamps have one-second
    // granularity and `>=` is deliberate.
    db.prepare("UPDATE agents SET state_changed_at = datetime('now', '-5 seconds') WHERE id = ?").run(agent);
    const wake = idleWake(agent);

    await tick();
    await tick();

    const row = db.prepare("SELECT fired_at FROM timers WHERE id = ?").get(wake);
    assert.equal(row.fired_at, null, "an idle the lead could already see is not a fresh transition");
    assert.ok(!delivered().includes("lane check"), "and nothing was typed at the lead");
  });

  it("fires once the worker goes idle after that", async () => {
    // The other side of the same pair, so neither ordering is covered only by
    // accident. Same agent shape, same wake, only the ordering differs.
    const agent = agentRow("idle-after-the-wake", watchedPane, "working");
    const wake = idleWake(agent);
    goIdle(agent);

    await tick();
    await until(() => delivered().includes("lane check"));

    assert.notEqual(
      db.prepare("SELECT fired_at FROM timers WHERE id = ?").get(wake).fired_at,
      null,
    );
  });

  it("never types through a buffer name another hive process could be using", async () => {
    // tmux buffers are SERVER-GLOBAL, and sendText used a fixed name,
    // "hive-input". Every claude session runs its own scheduler against one
    // database, so two of them delivering in the same 3s window interleave as
    // A set-buffer, B set-buffer, A paste-and-delete, B paste-fails. A types
    // B's wake into its own lead, and B throws after its timer is already
    // claimed, so B's wake is lost for good.
    //
    // The race predates this branch. The tail is what made it likely, by making
    // every watched wake multiline and so pushing all of them onto this path.
    //
    // Staged deterministically rather than by racing: park a buffer under the
    // OLD shared name and require sendText to leave it completely alone. The
    // old code would overwrite it and then delete it with paste-buffer -d.
    execFileSync("tmux", ["set-buffer", "-b", "hive-input", "--", "FOREIGN CONTENT"]);

    await sendText(deliveryPane, "first line\nsecond line", false);

    const survivor = execFileSync("tmux", ["show-buffer", "-b", "hive-input"], { encoding: "utf8" });
    assert.match(survivor, /FOREIGN CONTENT/, "another process's buffer must be untouched");
    execFileSync("tmux", ["delete-buffer", "-b", "hive-input"]);
  });

  it("leaves a plain delay wake alone", async () => {
    // A delay wake watches nothing, so there is no pane to report and no
    // reason to make the lead pay for one.
    const wake = db
      .prepare(
        `INSERT INTO timers (project_id, owner, body, kind, watch, deliver_actor, deliver_pane,
           due_at, created_at)
         VALUES (?, 'user:test', 'plain body', 'delay', '[]', 'user:test', ?,
           datetime('now', '-1 second'), datetime('now', '-60 seconds'))
         RETURNING id`,
      )
      .get(project, deliveryPane).id;

    await tick();
    await until(() => delivered().includes("plain body"));

    const text = delivered();
    assert.match(text, new RegExp(`\\[hive wake #${wake}\\] plain body`));
    // Matched against what the code actually emits. This asserted "what hive
    // saw" while production emits "what hive sees", so a tail leaking onto
    // plain delay wakes would have passed. Anchored on the stable half of the
    // sentence rather than the whole thing.
    assert.doesNotMatch(text, /what hive se[ae]/, "nothing is watched, so nothing is reported");
    assert.doesNotMatch(text, /read agent_output before acting/, "and no tail footer either");
  });
});

// Todo 65. A wake fired, the store recorded it delivered, and the lead never
// saw it. The standing hypothesis was that a busy lead pane loses the message;
// it does not, which was established before this was written by driving a real
// claude session mid-turn and reading its transcript off disk. A pane sitting
// on a MODAL CHOICE loses it, and does something worse on the way: the paste
// has nowhere to go and is dropped, and the Enter that follows is read as
// "choose the highlighted option". Reproduced against claude 2.1.220, where it
// accepted a folder-trust prompt using the text of a wake-up.
//
// The screens here are printed by a shell rather than driven out of a real
// claude. What is under test is hive's decision not to type into a pane whose
// SCREEN shows a dialog, and a printf reproduces that screen exactly. The claude
// coupling is one regex, pinned separately below.
describe("a wake is never typed into a pane that is waiting on a choice", { skip: hasTmux ? false : "tmux is not installed" }, () => {
  const session = `hive-choice-${process.pid}`;
  const outFile = join(tmp, "choice-delivered.txt");
  // The footer claude renders under a permission prompt, verbatim.
  const DIALOG = "Do you want to proceed?\\n 1. Yes\\n 2. No\\n\\n Esc to cancel";
  let dialogPane;

  before(() => {
    if (!hasTmux) return;
    writeFileSync(outFile, "");
    execFileSync(
      "tmux",
      [
        "new-session", "-d", "-s", session, "-x", "200", "-y", "50",
        `printf '${DIALOG}\\n'; sleep 600`,
      ],
      { stdio: "ignore" },
    );
    dialogPane = execFileSync("tmux", ["list-panes", "-t", `=${session}`, "-F", "#{pane_id}"], {
      encoding: "utf8",
    }).trim();
  });

  after(() => cleanup(session));

  beforeEach(reset);

  const delivered = () => readFileSync(outFile, "utf8");

  // Clears the dialog by replacing what the pane is RUNNING, keeping the pane
  // id. A wake names a pane, so the second half of this has to be the same
  // pane; a new one would prove nothing about the timer that was held. tmux
  // wipes the screen on respawn, which is the state change under test.
  const clearDialog = () =>
    execFileSync("tmux", ["respawn-pane", "-k", "-t", dialogPane, `cat > ${outFile}`], {
      stdio: "ignore",
    });

  function wakeInto(pane, body) {
    return db
      .prepare(
        `INSERT INTO timers (project_id, owner, body, kind, watch, deliver_actor, deliver_pane,
           due_at, created_at)
         VALUES (?, 'user:test', ?, 'delay', '[]', 'user:test', ?,
           datetime('now', '-1 second'), datetime('now', '-60 seconds'))
         RETURNING id`,
      )
      .get(project, body, pane).id;
  }

  const timerRow = (id) =>
    db
      .prepare("SELECT fired_at, cancelled_at, fire_count, typed_at, held_at, held_reason FROM timers WHERE id = ?")
      .get(id);

  it("sees a dialog on the screen", async () => {
    // The regex is claude's chrome, so it gets its own assertion rather than
    // being implied by the behaviour tests. If claude restyles its prompts this
    // fails first and names the reason.
    await until(() => paneAwaitingChoice(dialogPane) === true);

    assert.equal(paneAwaitingChoice(dialogPane), true);
  });

  it("answers null rather than false for a pane it cannot read", () => {
    // A dead target is not a pane with no dialog on it. Reading a capture
    // failure as "no dialog, go ahead" would be defensible for the scheduler,
    // which has already probed liveness, but only because the scheduler decides
    // that; the reader must not decide it here.
    assert.equal(paneAwaitingChoice("%99999"), null);
  });

  it("re-reads the pane after each delivery, so one tick cannot type into a dialog it raised", async () => {
    // Counselors finding 5, and a regression the /simplify pane cache
    // introduced: deliveries within a tick are serial, so a later timer was
    // judged against a screen read before the earlier ones typed into it. Wake
    // #7 delivers, the session takes that turn and raises a permission prompt,
    // wake #11 is delivered against the cached "no dialog" and its Enter answers
    // it.
    //
    // Staged with a pane that raises a dialog the moment it is written to, which
    // is what a claude session does when the turn it was just handed asks for
    // permission. Both timers are due in the SAME tick, so the second one can
    // only be held if the cache was invalidated by the first delivery.
    //
    // The dialog is raised on the PASTE, not on the Enter that follows it.
    // Issue #55: raising it on a completed line (`read line`) made the test
    // depend on an unforced race between this fixture's shell round-trip and
    // the scheduler's fresh capture-pane for the second timer, with a ~2-3ms
    // margin on a quiet machine (see todo 125's table) - enough to pass
    // locally almost every time and lose under CI contention. Delivery
    // (src/tmux.ts sendText) already waits ENTER_DELAY_MS between the paste
    // and the Enter, so a fixture that reacts to the FIRST character of the
    // paste has the dialog on screen for the rest of that gap before the
    // Enter even lands, let alone before the second timer's capture. The
    // ordering stops being a race and becomes a consequence of the real
    // delivery timing - a 100x margin, not a happens-before, and asserted on
    // below so a shrinking ENTER_DELAY_MS fails loudly here instead of
    // quietly turning this back into a flake. The first character is
    // consumed separately by the -n1 read, so it is reassembled with `rest`
    // below rather than dropped.
    assert.ok(
      ENTER_DELAY_MS >= 250,
      "this fixture's ordering margin comes from ENTER_DELAY_MS (src/tmux.ts); it dropped, so this test is a race again",
    );
    const session2 = `${session}-raise`;
    const out = join(tmp, "raise-delivered.txt");
    writeFileSync(out, "");
    execFileSync(
      "tmux",
      [
        "new-session", "-d", "-s", session2, "-x", "200", "-y", "50",
        // Explicit bash: the pane's default shell tracks $SHELL, which is not
        // always bash (zsh has no `-n1` on its `read` builtin), and `read -n1`
        // is exactly the mechanism the ordering depends on.
        //
        // `cat -u >> out` replaces the old `sleep 600`: it keeps the pane
        // alive the same way, but if the cache-invalidation guard this test
        // covers ever regresses and SECONDWAKE's Enter reaches this pane, it
        // is appended to `out` instead of vanishing into a sleeping shell.
        // Without this, the "must not have been typed" assertion below could
        // never fail no matter how broken the guard was: the old fixture was
        // parked in `sleep 600` reading nothing by the time a leaked delivery
        // could arrive.
        `bash -c 'IFS= read -r -n1 c; printf "${DIALOG}\\n"; IFS= read -r rest; printf "%s%s\\n" "$c" "$rest" > ${out}; cat -u >> ${out}'`,
      ],
      { stdio: "ignore" },
    );
    try {
      const pane = execFileSync("tmux", ["list-panes", "-s", "-t", `=${session2}`, "-F", "#{pane_id}"], {
        encoding: "utf8",
      }).trim();
      await until(() => paneAwaitingChoice(pane) === false);
      const first = wakeInto(pane, "FIRSTWAKE");
      const second = wakeInto(pane, "SECONDWAKE");

      await tick();

      assert.notEqual(timerRow(first).fired_at, null, "the first wake delivers as it always did");
      await until(() => paneAwaitingChoice(pane) === true);
      assert.equal(
        timerRow(second).fired_at,
        null,
        "the second must be held: the pane it targets is now asking a question",
      );
      // This fixture now raises the dialog BEFORE writing `out` (the printf
      // to `out` happens after the dialog printf), so the dialog wait above
      // is no longer an accidental guarantee that `out` has been written.
      // Poll for the content instead of reading once.
      await until(() => readFileSync(out, "utf8").includes("FIRSTWAKE"));
      const text = readFileSync(out, "utf8");
      assert.match(text, /FIRSTWAKE/);
      assert.ok(!text.includes("SECONDWAKE"), "and its body must not have been typed at the dialog");
    } finally {
      cleanup(session2);
    }
  });

  it("holds the wake, then delivers it once the choice is gone", async () => {
    // Both halves in one test, because they are one claim about one timer: held
    // rather than lost. Split in two, the first half alone would also pass under
    // a guard that never delivers anything, which is its own silent loss.
    await until(() => paneAwaitingChoice(dialogPane) === true);
    const wake = wakeInto(dialogPane, "MUSTNOTLAND lane check");

    await tick();
    await tick();

    const held = timerRow(wake);
    assert.equal(held.fired_at, null, "an unanswerable pane must not consume the wake");
    assert.equal(held.cancelled_at, null, "and must not destroy it either; the pane is alive");
    assert.equal(held.fire_count, 0);
    assert.ok(
      !delivered().includes("MUSTNOTLAND"),
      "nothing may be typed at a pane whose Enter key means yes",
    );
    // Issue #27. The hold itself must be legible even though the timer is
    // otherwise untouched: deliverable()'s answer did not change, but a lead
    // reading this row should see why it has not fired yet.
    assert.equal(held.typed_at, null, "not typed yet: the pane was never written to");
    assert.notEqual(held.held_at, null, "the hold must be recorded, not just inferred from silence");
    assert.notEqual(held.held_reason, null, "and the reason must say why, not just that");

    clearDialog();
    await until(() => paneAwaitingChoice(dialogPane) === false);

    await tick();
    await until(() => delivered().includes("MUSTNOTLAND"));

    assert.match(
      delivered(),
      new RegExp(`\\[hive wake #${wake}\\] MUSTNOTLAND`),
      "the same wake, still whole, delivered late rather than lost",
    );
    const done = timerRow(wake);
    assert.notEqual(done.fired_at, null);
    assert.equal(done.fire_count, 1, "and delivered exactly once");
    assert.notEqual(done.typed_at, null, "typed_at follows a successful sendText");
    assert.equal(done.held_at, null, "a resolved hold must stop being reported as current");
    assert.equal(done.held_reason, null);
  });
});

