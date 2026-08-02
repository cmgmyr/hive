import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import {
  KICKOFF,
  REPO,
  assertScratchStore,
  clearHiveEnv,
  createLiveAndDialogPanes,
  firedSessionStart,
  insertStateLogRow,
  isolateTmux,
  runCli,
  runNode,
  scratchDirs,
} from "./helpers.mjs";

// L1 (design-l1). test/state-provenance.test.mjs pins deriveProvenance()'s own
// logic; this file pins that the two human-facing CLI surfaces -- `hive
// status` and the SessionStart kickoff digest's WORKERS section -- actually
// render it, with existing column/bracket formatting preserved. Neither of
// these tools probes tmux for this decoration (see the comments next to each
// call site in src/cli.ts and src/kickoff.ts), so `alive` is always null here
// and the tmux-probe "gone" source never appears on these two surfaces.

const { hasTmux, cleanup: cleanupTmux } = isolateTmux("the state-provenance CLI surface tests");
const session = `hive-provenance-cli-${process.pid}`;
after(() => cleanupTmux(session));

// hive doctor's per-worker signal (unlike status/kickoff) does capture a real
// pane, so it needs real targets: one ordinary pane and one replaying the
// same captured dialog fixture typing-guards.test.mjs pins paneChoiceCheck
// against.
let livePane;
let dialogPane;
// Fix round 1, item 5d. sanitizeTail's cap (6 lines, 160 chars each,
// src/tmux.ts) is unpinned at every call site that reaches it through a real
// pane -- the only direct test of it (test/false-idle.test.mjs) calls it in
// isolation. Ten distinct numbered lines, each padded well past 160 chars
// with a STOP marker after the cutoff, so both halves of the bound are
// provable through doctor's own tail output: only the LAST 6 survive, and
// none of them reach far enough to print STOP.
let longPane;
// Fix round 2, item 3(a) (both counselors seats, the most important item in
// that round). `livePane` (below) is `sleep 600`: a blank screen. Proving
// doctor prints the tail unconditionally (fix round 1, item 1) against a
// blank pane only proves the "tail:" LABEL prints, not that any CONTENT
// does -- a mutant that gated the actual line-printing back onto
// `awaitingChoice === true` (reverting item 1 exactly) would still pass a
// test built on nothing to print. This replays a real, non-dialog claude
// screen (the same busy-mid-turn.txt fixture pane-fixtures.test.mjs already
// pins paneChoiceCheck's awaitingChoice=false reading against) so the
// no-dialog case has real content to assert.
let busyPane;
before(() => {
  if (!hasTmux) return;
  ({ livePane, dialogPane } = createLiveAndDialogPanes(session, "folder-trust-dialog.txt"));
  longPane = execFileSync(
    "tmux",
    [
      "new-window",
      "-t",
      `=${session}`,
      "-P",
      "-F",
      "#{pane_id}",
      "for i in $(seq 1 10); do printf 'LINE-%02d-%s-STOP\\n' \"$i\" \"$(printf 'a%.0s' $(seq 1 200))\"; done; sleep 600",
    ],
    { encoding: "utf8" },
  ).trim();
  busyPane = execFileSync(
    "tmux",
    [
      "new-window",
      "-t",
      `=${session}`,
      "-P",
      "-F",
      "#{pane_id}",
      `cat '${join(REPO, "test", "fixtures", "panes", "busy-mid-turn.txt")}'; sleep 600`,
    ],
    { encoding: "utf8" },
  ).trim();
});

const { dataDir, projectDir, tmp } = scratchDirs();
const opts = { cwd: projectDir, dataDir, tmp };

clearHiveEnv();
process.env.HIVE_DATA_DIR = dataDir;
await assertScratchStore();

const { db, migrate } = await import("../dist/db.js");
migrate();

writeFileSync(join(projectDir, "hive.yml"), "profile: orchestration\n");
const init = await runCli(["init"], opts);
assert.equal(init.code, 0, init.stderr);

const project = db.prepare("SELECT id FROM projects WHERE path = ?").get(projectDir).id;

// created_at defaults to now, which matters: it keeps the row inside the
// janitor's 15-second spawn-race guard, so `hive status`'s own janitor() call
// does not sweep it out from under the assertion before it can be read.
function agentRow({ name, command = "claude", state = "unknown", stateChangedAgo = null, target = "%9600" }) {
  db.prepare(
    `INSERT INTO agents (project_id, actor_id, name, tmux_target, command, cwd, status, kind, agent_state, state_changed_at)
     VALUES (?, ?, ?, ?, ?, '/tmp/worker', 'running', 'agent', ?,
       ${stateChangedAgo == null ? "NULL" : "datetime('now', ?)"})`,
  ).run(
    ...[project, `agent:${name}`, name, target, command, state],
    ...(stateChangedAgo == null ? [] : [`-${stateChangedAgo} seconds`]),
  );
}

const logRow = (actorId, event, state, agoSeconds) => insertStateLogRow(db, actorId, event, state, agoSeconds);

function reset() {
  db.exec("DELETE FROM agent_state_log; DELETE FROM agents;");
}

describe("hive status decorates worker lines with provenance", () => {
  it("renders a normal claude worker with its event and age, columns intact", async () => {
    reset();
    agentRow({ name: "worker-1", state: "working", stateChangedAgo: 90 });
    logRow("agent:worker-1", "prompt", "working", 90);

    const { code, stdout } = await runCli(["status"], opts);

    assert.equal(code, 0, stdout);
    assert.match(stdout, /agent {2}worker-1 {13}working \(prompt, 1m ago\)/);
  });

  it("renders a non-claude worker as not instrumented", async () => {
    reset();
    agentRow({ name: "probe-2", command: "sleep 600", state: "unknown" });

    const { code, stdout } = await runCli(["status"], opts);

    assert.equal(code, 0, stdout);
    assert.match(stdout, /agent {2}probe-2 {14}unknown \(not instrumented\)/);
  });

  // Issue #27's L4 fix round, DECISION 4. This used to be a two-way ternary
  // (command vs. everything else), so a lead's own row printed as
  // `agent  lead  running` - indistinguishable from an actual worker named
  // "lead", and wrong on the one row this project ever has exactly one of.
  it("labels a lead row 'lead', not 'agent'", async () => {
    reset();
    db.prepare(
      `INSERT INTO agents (project_id, actor_id, name, tmux_target, command, cwd, status, kind)
       VALUES (?, 'lead:1', 'lead', '%9602', 'claude --settings /tmp/hooks.json', ?, 'running', 'lead')`,
    ).run(project, projectDir);

    const { code, stdout } = await runCli(["status"], opts);

    assert.equal(code, 0, stdout);
    assert.match(stdout, /lead {3}lead {17}running/);
    assert.doesNotMatch(stdout, /agent {2}lead /, "must not print the two-way ternary's old 'agent' label");
  });

  it("leaves a command row's plain 'running' alone -- it has no provenance to report", async () => {
    reset();
    db.prepare(
      `INSERT INTO agents (project_id, actor_id, name, tmux_target, command, cwd, status, kind)
       VALUES (?, 'cmd:web', 'web', '%9601', 'sleep 600', ?, 'running', 'command')`,
    ).run(project, projectDir);

    const { code, stdout } = await runCli(["status"], opts);

    assert.equal(code, 0, stdout);
    assert.match(stdout, /cmd {4}web {18}running/);
  });

  // Issue #72. A second, deliberately DIFFERENT fact from the provenance
  // line above: the log's own last row, not the row that explains the
  // current latch. logRow here is the LAST of two, so a function that
  // picked the first, or re-derived from the latch, goes red.
  it("adds a last-log-event line for a claude worker, independent of the provenance line", async () => {
    // Fix round 1, item 6a. The log's true last row must NOT be the row that
    // also explains the latch, or a mutant that re-derived this from "the
    // latest row matching the latch" (deriveProvenance's own question, one
    // line up) would print the identical line and this test could not tell
    // the two apart -- which is the whole claim the test makes. The notify
    // row at 200s explains the waiting latch; the notify|unchanged row at 40s
    // is more recent still and explains nothing (hook.ts's UNCHANGED
    // sentinel), so only a true "log's own last row" reads it.
    reset();
    agentRow({ name: "worker-1", state: "waiting", stateChangedAgo: 200 });
    logRow("agent:worker-1", "prompt", "working", 300);
    logRow("agent:worker-1", "notify", "waiting", 200);
    logRow("agent:worker-1", "notify", "unchanged", 40);

    const { code, stdout } = await runCli(["status"], opts);

    assert.equal(code, 0, stdout);
    assert.match(stdout, /waiting \(notify, 3m ago\)/, "the provenance line above still explains the latch, unaffected");
    const match = stdout.match(/last log event: notify \((\d+)s ago\)/);
    assert.ok(match, `expected a fresh notify age line, got: ${stdout}`);
    assert.ok(Number(match[1]) < 60, `expected ~40s (the unchanged row), not ~200s (the latch's own row): got ${match[1]}s`);
  });

  it("omits the last-log-event line for a non-claude worker", async () => {
    reset();
    agentRow({ name: "probe-2", command: "sleep 600", state: "unknown" });

    const { code, stdout } = await runCli(["status"], opts);

    assert.equal(code, 0, stdout);
    assert.doesNotMatch(stdout, /last log event/);
  });
});

describe("hive doctor reports #72's stopped-worker signal per worker", { skip: hasTmux ? false : "tmux is not installed" }, () => {
  it("reports the log event and 'no dialog' for a worker on an ordinary pane, AND still prints the tail's CONTENT", async () => {
    // Fix round 1, item 1 (found independently by both counselors seats).
    // Fix round 2, item 3 (both seats, the most important item in that
    // round): the original version of this test ran against `livePane`, a
    // blank `sleep 600` screen, so it could only ever pin the "tail:" LABEL
    // -- a mutant reverting `...tail.split("\n")` back to `...[]` (i.e.
    // restoring item 1's exact inverted gate) still passed, because there
    // was never any content to lose. busyPane replays a real, non-dialog
    // claude screen, so this now asserts an actual line from it survives.
    reset();
    agentRow({ name: "worker-1", state: "working", stateChangedAgo: 90, target: busyPane });
    logRow("agent:worker-1", "prompt", "working", 90);

    const { stdout } = await runCli(["doctor"], opts);

    assert.match(stdout, /worker worker-1: last log event: prompt \(1m ago\)/);
    assert.match(stdout, /pane: no dialog/);
    // "lighthouse keeper" (the fixture's actual prompt text) sits above
    // sanitizeTail's own 6-line cap and does not survive it; "auto mode on"
    // is claude's own status-bar text and is always within the last 6 lines
    // of this fixture, so it is the reliable content check.
    assert.match(
      stdout,
      /\| .*auto mode on/,
      "real screen content must survive, prefixed (fix round 2, item 4), not just a 'tail:' label",
    );
  });

  it("names an empty tail as its own fact, rather than a 'tail:' header over nothing (fix round 2, item 3b)", async () => {
    // A blank pane (livePane, sleep 600) is reachable with no tmux failure
    // at all -- sanitizeTail filters every blank row, leaving "". The old
    // rendering printed "tail:" followed by one whitespace-only continuation
    // line here, which reads as content that happens to be blank rather
    // than as "nothing was captured".
    reset();
    agentRow({ name: "worker-blank", state: "working", stateChangedAgo: 90, target: livePane });
    logRow("agent:worker-blank", "prompt", "working", 90);

    const { stdout } = await runCli(["doctor"], opts);

    assert.match(stdout, /tail: \(pane rendered nothing\)/);
    assert.doesNotMatch(stdout, /worker worker-blank:[\s\S]*?tail:\n/, "must not print a bare 'tail:' header with no content");
  });

  it("names an UNREADABLE tail differently from an empty one (fix round 3, PR gate finding)", async () => {
    // tail === "" is true for two different reasons: a successful capture of
    // an all-blank screen (the previous test), and a capture that FAILED
    // outright -- paneChoiceCheck's own catch (src/tmux.ts) returns
    // {awaitingChoice: null, tail: ""} having read nothing at all. Fix round
    // 2's "(pane rendered nothing)" collapsed both onto the same string,
    // which for THIS case asserts a successful blank read that never
    // happened. A killed/nonexistent target (the same "%9999" convention
    // used elsewhere in this suite for a dead pane) is what makes capture-pane
    // throw and reach that catch. Surviving mutation this closes: collapsing
    // the awaitingChoice === null branch back onto the empty-tail string.
    reset();
    agentRow({ name: "worker-unreadable", state: "working", stateChangedAgo: 90, target: "%9999" });
    logRow("agent:worker-unreadable", "prompt", "working", 90);

    const { stdout } = await runCli(["doctor"], opts);

    assert.match(stdout, /worker worker-unreadable:[\s\S]*?pane: could not be read/);
    assert.match(stdout, /worker worker-unreadable:[\s\S]*?tail: \(pane could not be read\)/);
    assert.doesNotMatch(
      stdout,
      /worker worker-unreadable:[\s\S]*?tail: \(pane rendered nothing\)/,
      "an unreadable pane must not be reported as a successful blank read",
    );
  });

  it("reports awaiting a choice, plus the dialog's own tail, for a worker parked on a real dialog", async () => {
    reset();
    agentRow({ name: "worker-dialog", state: "waiting", stateChangedAgo: 5, target: dialogPane });

    const { stdout } = await runCli(["doctor"], opts);

    assert.match(stdout, /worker worker-dialog: last log event: no record/);
    assert.match(stdout, /pane: awaiting a choice \(dialog\)/);
    assert.match(stdout, /Esc to cancel/, "the dialog's own tail should be printed, not just the verdict");
  });

  it("caps the tail at sanitizeTail's own bound: last 6 lines, each cut before 160 chars (fix round 1, item 5d)", async () => {
    reset();
    agentRow({ name: "worker-long", state: "working", stateChangedAgo: 5, target: longPane });

    const { stdout } = await runCli(["doctor"], opts);

    for (const n of [5, 6, 7, 8, 9, 10]) {
      assert.match(stdout, new RegExp(`LINE-0?${n}-`), `line ${n} of 10 should survive the 6-line cap`);
    }
    for (const n of [1, 2, 3, 4]) {
      assert.doesNotMatch(stdout, new RegExp(`LINE-0${n}-`), `line ${n} of 10 is older than the 6-line cap`);
    }
    assert.doesNotMatch(stdout, /STOP/, "each line is padded past 160 chars; the trailing marker must be cut off");
  });

  it("never fails or warns doctor's overall verdict on a worker's age alone", async () => {
    // L1's own rule, extended to this new check: no ok/warn/FAIL tied to how
    // old a worker's state is. Fix round 1, item 6b: the worker's LATCH being
    // five seconds old (stateChangedAgo) never exercised this at all -- the
    // new block reads the LOG's age, not the latch's -- so a mutant adding
    // `warn whenever last-log age > 60s` still passed this test unchanged.
    // An old log row is what actually pins the L1 rule this lane argued its
    // way past: the age here is real and large, and doctor must still stay
    // silent about it.
    reset();
    agentRow({ name: "worker-dialog", state: "waiting", stateChangedAgo: 5, target: dialogPane });
    logRow("agent:worker-dialog", "notify", "waiting", 3600);

    const { stdout } = await runCli(["doctor"], opts);

    assert.match(stdout, /last log event: notify \(1h ago\)/, "the old age must actually be in play, not just seeded");
    assert.doesNotMatch(stdout, /FAIL {2}worker/);
    assert.doesNotMatch(stdout, /warn {2}worker/);
  });

  it("prints no worker line at all for a non-claude command row (fix round 1, item 5a)", async () => {
    // reportsAgentStateLog's isClaudeCommand half was unpinned here: every
    // seeded worker above uses the default command "claude", and the SQL
    // already filters kind='agent', so a mutant deleting
    // `if (!reportsAgentStateLog(w)) continue;` entirely stayed green.
    //
    // Fix round 2, item 5 (codex). This proves the LINE never prints, by
    // reading stdout only -- it does NOT prove doctor skips the
    // capture-pane fork for this row. Moving `paneChoiceCheck(w.tmux_target)`
    // above the `continue` guard would still leave stdout looking identical
    // and this assertion green; the fork-ordering half is unpinned. Not
    // worth a fork-counting harness to close.
    reset();
    agentRow({ name: "dev-server", command: "sleep 600", state: "unknown", target: livePane });

    const { stdout } = await runCli(["doctor"], opts);

    assert.doesNotMatch(stdout, /worker dev-server:/);
  });
});

describe("kickoff's WORKERS section decorates with provenance", () => {
  it("decorates a normal claude worker with its event and age", async () => {
    reset();
    agentRow({ name: "worker-1", state: "working", stateChangedAgo: 90 });
    logRow("agent:worker-1", "prompt", "working", 90);

    const { code, stdout } = await runNode(KICKOFF, [], opts);
    assert.equal(code, 0, stdout);
    const { additionalContext } = firedSessionStart(stdout);

    assert.match(additionalContext, /WORKERS/);
    assert.match(additionalContext, /worker-1 \[working \(prompt, 1m ago\)\] \/tmp\/worker/);
  });

  it("reads a non-claude worker as not instrumented, never stale", async () => {
    reset();
    agentRow({ name: "probe-2", command: "sleep 600", state: "unknown" });

    const { stdout } = await runNode(KICKOFF, [], opts);
    const { additionalContext } = firedSessionStart(stdout);

    assert.match(additionalContext, /probe-2 \[unknown \(not instrumented\)\] \/tmp\/worker/);
  });

  it("reports absent provenance honestly when the log row has been evicted", async () => {
    reset();
    // No agent_state_log row at all: the retention case. Age still comes
    // from the latch.
    agentRow({ name: "worker-3", state: "idle", stateChangedAgo: 400 });

    const { stdout } = await runNode(KICKOFF, [], opts);
    const { additionalContext } = firedSessionStart(stdout);

    assert.match(additionalContext, /worker-3 \[idle \(no record, 6m ago\)\] \/tmp\/worker/);
  });
});
