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
const { sanitizeTail, sendText } = await import("../dist/tmux.js");
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
  db.exec("DELETE FROM timers; DELETE FROM agents;");
}

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

  it("still maps the other events the way it always has", async () => {
    // The Stop branch now reads stdin, and stdin is a one-shot read. A
    // regression that drained it in the wrong branch would show up here.
    const working = agentRow("prompted", "%9508", "idle");
    const waiting = agentRow("notified", "%9509", "idle");
    const asking = agentRow("needs-input", "%9510", "working");

    await runHook("prompt", JSON.stringify({ prompt: "go" }), "agent:prompted");
    await runHook("notify", JSON.stringify({ message: "Permission needed" }), "agent:notified");
    await runHook(
      "notify",
      JSON.stringify({ message: "Claude is waiting for your input" }),
      "agent:needs-input",
    );

    assert.equal(stateOf(working), "working");
    assert.equal(stateOf(waiting), "waiting");
    assert.equal(stateOf(asking), "idle");
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
    const panes = execFileSync("tmux", ["list-panes", "-a", "-s", "-t", `=${session}`, "-F", "#{pane_id}"], {
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

  function idleWake(agentId) {
    return db
      .prepare(
        `INSERT INTO timers (project_id, owner, body, kind, watch, deliver_actor, deliver_pane,
           max_wait_at, created_at)
         VALUES (?, 'user:test', 'lane check', 'idle_any', ?, 'user:test', ?,
           datetime('now', '+1 hour'), datetime('now', '-60 seconds'))
         RETURNING id`,
      )
      .get(project, JSON.stringify([agentId]), deliveryPane).id;
  }

  it("delivers the watched worker's terminal alongside the body", async () => {
    const agent = agentRow("tailed", watchedPane, "working");
    // A fresh idle transition, which is what idle_any waits for.
    db.prepare("UPDATE agents SET agent_state = 'idle', state_changed_at = datetime('now') WHERE id = ?").run(
      agent,
    );
    const wake = idleWake(agent);

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
    db.prepare("UPDATE agents SET agent_state = 'idle', state_changed_at = datetime('now') WHERE id = ?").run(
      agent,
    );
    idleWake(agent);

    await tick();
    await until(() => delivered().includes("named-in-tail"));

    const text = delivered();
    assert.match(text, /named-in-tail/, "a lead watching several workers needs to know which one");
    assert.match(text, /hive state now: idle/);
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
