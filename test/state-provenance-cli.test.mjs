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
  failureCount,
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
// Todo 392 round 2 review (F7). doctor's own dialog case above only ever
// replays folder-trust-dialog.txt, which never carried `╰` to begin with -
// restoring `╰` to INPUT_BOX_PRESENT would leave doctor reporting "no
// dialog" for the fixture the bug was actually about while this file's
// existing dialog test stayed green. A second window in the same session,
// same technique as longPane/busyPane below.
let permissionPromptPane;
before(() => {
  if (!hasTmux) return;
  ({ livePane, dialogPane } = createLiveAndDialogPanes(session, "folder-trust-dialog.txt"));
  permissionPromptPane = execFileSync(
    "tmux",
    [
      "new-window",
      "-t",
      `=${session}`,
      "-P",
      "-F",
      "#{pane_id}",
      `cat '${join(REPO, "test", "fixtures", "panes", "tool-permission-prompt.txt")}'; sleep 600`,
    ],
    { encoding: "utf8" },
  ).trim();
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
const { tmuxSocketPath } = await import("../dist/tmux.js");
migrate();

const ownSocket = tmuxSocketPath(process.env.TMUX, process.env.TMUX_TMPDIR);
const FOREIGN_SOCKET = "/nonexistent/foreign-socket-dir/tmux-0/default";

writeFileSync(join(projectDir, "hive.yml"), "profile: orchestration\n");
const init = await runCli(["init"], opts);
assert.equal(init.code, 0, init.stderr);

const project = db.prepare("SELECT id FROM projects WHERE path = ?").get(projectDir).id;

// created_at defaults to now, which matters: it keeps the row inside the
// janitor's 15-second spawn-race guard, so `hive status`'s own janitor() call
// does not sweep it out from under the assertion before it can be read.
function agentRow({ name, command = "claude", state = "unknown", stateChangedAgo = null, target = "%9600", socket = "" }) {
  db.prepare(
    `INSERT INTO agents (project_id, actor_id, name, tmux_target, tmux_socket, command, cwd, status, kind, agent_state, state_changed_at)
     VALUES (?, ?, ?, ?, ?, ?, '/tmp/worker', 'running', 'agent', ?,
       ${stateChangedAgo == null ? "NULL" : "datetime('now', ?)"})`,
  ).run(
    ...[project, `agent:${name}`, name, target, socket, command, state],
    ...(stateChangedAgo == null ? [] : [`-${stateChangedAgo} seconds`]),
  );
}

const logRow = (actorId, event, state, agoSeconds) => insertStateLogRow(db, actorId, event, state, agoSeconds);

function reset() {
  db.exec("DELETE FROM agent_state_log; DELETE FROM agents;");
}

// Todo 323 audit (generated-data assertions). EVERY describe in this file
// that asserts against the FULL stdout of `hive status` or `hive doctor` -
// not just the two immediately below; also "hive doctor names a
// foreign-socket row it cannot sweep" further down, and any other doctor-
// asserting block added to this file later - is covered by this note.
// Corrected by counselors review from an earlier version that said "the two
// describes below," which undersold its own scope and would have read as
// file-wide to a reader while actually applying only to the first two.
// Both commands print real scratch paths as part of their own, unrelated
// output: `hive status` prints `${project.name}  (${project.path})`, and
// `hive doctor` prints `database: ${dataDir} (schema vN)` plus a
// `project ${project.name} (${project.path}): ...` line - project.path,
// project.name and dataDir are all built from scratchDirs()'s
// mkdtempSync() calls (helpers.mjs), so the haystack every doesNotMatch
// in this file runs against genuinely can carry generated data.
//
// What makes almost every doesNotMatch in this file safe anyway: mkdtempSync's
// random six-character suffix is drawn only from node's own alphabet,
// [0-9a-zA-Z] - it can never contain a space, ':', '(', ')', or '-' (those
// characters only appear in the FIXED "hive-test-"/"project-" prefixes
// around the random suffix, and neither prefix ever ends in text a pattern
// below also requires immediately before one of those characters). Every
// doesNotMatch pattern in this file's doctor/status describes is anchored on
// at least one such character, so the random suffix alone cannot satisfy it
// - this was checked at each site, not assumed, including the foreign-socket
// describe's own two hits. The one pattern with no such
// anchor at all, `/STOP/` in the sanitizeTail cap test below, is fixed
// separately by scoping it to the worker's own report section instead of
// relying on this fact.
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

  it("caps and cleans a hostile log event before printing it, same as the wake body does", async () => {
    // Round 2 (Chris's decision): describeLastLogEvent() is one shared
    // formatter, so fixing scheduler.ts's wake body without also proving
    // `hive status` inherits the same guard would leave this exact column -
    // agent_state_log's event, process.argv[2] verbatim (src/hook.ts) - open
    // on an operator's own terminal even after the pane-typed path was
    // closed. sanitizeEventForDisplay (src/tmux.ts) caps the raw event before
    // formatting, so a padded fake clause cannot push the real age out of
    // view here either.
    reset();
    agentRow({ name: "worker-hostile", state: "working", stateChangedAgo: 90 });
    logRow("agent:worker-hostile", "stop (0s ago)" + " ".repeat(200), "working", 3600);

    const { code, stdout } = await runCli(["status"], opts);

    assert.equal(code, 0, stdout);
    assert.match(
      stdout,
      /last log event: stop \(0s ago\)\s{7}\[truncated\] \(1h ago\)/,
      `the real age must survive right after the capped, marked event; got: ${stdout}`,
    );
  });

  it("omits the last-log-event line for a non-claude worker", async () => {
    reset();
    agentRow({ name: "probe-2", command: "sleep 600", state: "unknown" });

    const { code, stdout } = await runCli(["status"], opts);

    assert.equal(code, 0, stdout);
    assert.doesNotMatch(stdout, /last log event/);
  });
});

// Todo 323. The trailing-marker cap test below used to assert a bare
// `doesNotMatch(stdout, /STOP/)` against the whole doctor report, which (per
// the file-level note above) has no punctuation anchor to protect it from a
// scratch path's random suffix. Pinned here in the shape
// test/attach-mode.test.mjs uses: prove the OLD pattern really would match a
// realistic string with "STOP" landing in the scratch path rather than the
// tail, and the NEW one, scoped to the worker's own report section, does
// not; then prove the new one still catches the real trailing marker it
// exists to catch.
//
// Counselors review (both seats, independently): a first attempt scoped the
// pattern with `[\s\S]*?`, a NON-greedy "anything up to the next STOP" -
// which has no upper bound, so it happily matches past worker-long's own
// block into whatever doctor prints afterward (sessions, backups, a LATER
// worker's own tail). That is the identical defect this lane exists to
// close, just moved down the string. Fixed by bounding the match to
// worker-long's own CONTINUATION LINES: report() (src/cli.ts:1845-1848)
// indents every line after a block's first with exactly 8 spaces, and the
// next top-level entry always starts at column 2, so
// `(\n {8}[^\n]*)*` cannot cross into the next block or worker.
describe("the /STOP/ negative assertion itself", () => {
  const STDOUT_WITH_STOP_IN_THE_SCRATCH_PATH =
    "database: /private/tmp/hive-test-STOPxy/hive.db (schema v9)\n" +
    "  info  worker worker-long: last log event: 5s ago\n        tail:\n        | LINE-05-...\n";

  it("ignores STOP inside an earlier line's scratch path, which random mkdtemp characters can produce", () => {
    assert.match(STDOUT_WITH_STOP_IN_THE_SCRATCH_PATH, /STOP/, "the old assertion really did match this");
    assert.doesNotMatch(STDOUT_WITH_STOP_IN_THE_SCRATCH_PATH, /worker worker-long:[^\n]*(\n {8}[^\n]*)*STOP/);
  });

  it("still catches a real uncapped trailing marker in the worker's own section", () => {
    const withRealStop =
      "  info  worker worker-long: last log event: 5s ago\n        tail:\n        | LINE-05-...STOP\n";
    assert.match(withRealStop, /worker worker-long:[^\n]*(\n {8}[^\n]*)*STOP/);
  });

  it("does NOT bleed into a later worker's own tail, which the un-scoped [\\s\\S]*? version would have", () => {
    const laterWorkerHasStop =
      "  info  worker worker-long: last log event: 5s ago\n        tail:\n        | LINE-05-...\n" +
      "  ok    sessions: hive-main\n" +
      "  info  worker worker-other: last log event: 5s ago\n        tail:\n        | LINE-05-...STOP\n";
    assert.doesNotMatch(laterWorkerHasStop, /worker worker-long:[^\n]*(\n {8}[^\n]*)*STOP/);
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

  it("caps and cleans a hostile log event before printing it, same as `hive status` and the wake body do", async () => {
    // Round 2 (Chris's decision): doctor is the third of three callers of
    // describeLastLogEvent(), and had no sanitizer at all before this fix
    // landed in the shared formatter.
    reset();
    agentRow({ name: "worker-hostile", state: "working", stateChangedAgo: 90, target: busyPane });
    logRow("agent:worker-hostile", "stop (0s ago)" + " ".repeat(200), "working", 3600);

    const { stdout } = await runCli(["doctor"], opts);

    assert.match(
      stdout,
      /worker worker-hostile: last log event: stop \(0s ago\)\s{7}\[truncated\] \(1h ago\)/,
      `the real age must survive right after the capped, marked event; got: ${stdout}`,
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

  // Counselors round 1 on #73, F2: this loop used to call paneChoiceCheck
  // unconditionally, with no socket check at all. busyPane is a REAL, alive
  // pane with real screen content ("auto mode on"); a foreign-socket row
  // recording it stands in for the coincidental pane-id collision the
  // finding depends on - the pane hive would actually have to read lives on
  // a server this process cannot see into, and busyPane only happens to
  // share its id.
  it("never captures a foreign-socket worker's screen, even one that happens to be alive here (fix round on #73, F2)", async () => {
    reset();
    agentRow({ name: "worker-foreign", state: "working", stateChangedAgo: 90, target: busyPane, socket: FOREIGN_SOCKET });
    logRow("agent:worker-foreign", "prompt", "working", 90);

    const { stdout } = await runCli(["doctor"], opts);

    assert.match(
      stdout,
      /worker worker-foreign:[\s\S]*?pane: recorded on a different tmux socket/,
      "must say plainly that the socket disagrees, not just 'could not be read'",
    );
    assert.match(stdout, /worker worker-foreign:[\s\S]*?tail: \(not read - foreign socket\)/);
    assert.doesNotMatch(
      stdout,
      /auto mode on/,
      "busyPane's real content must never be captured for a row whose recorded socket is foreign",
    );
  });

  it("control: still captures the identical pane's content when the worker's own recorded socket matches this process", async () => {
    reset();
    agentRow({ name: "worker-matching", state: "working", stateChangedAgo: 90, target: busyPane, socket: ownSocket });
    logRow("agent:worker-matching", "prompt", "working", 90);

    const { stdout } = await runCli(["doctor"], opts);

    assert.match(stdout, /worker worker-matching: last log event: prompt \(1m ago\)/);
    assert.match(stdout, /pane: no dialog/);
    assert.match(
      stdout,
      /\| .*auto mode on/,
      "a matching, non-empty socket must still capture real content exactly as before this lane",
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

  // Todo 392 round 2 review (F7). The mutation this file's own dialog test
  // above cannot kill: restore `╰` to INPUT_BOX_PRESENT and
  // folder-trust-dialog.txt (no `╰` in it) still reads correctly, so
  // doctor's own reporting path for the actual bug - an ordinary
  // tool-permission prompt - stayed uncovered right through the lane's own
  // acceptance run.
  it("reports awaiting a choice for a worker parked on an ordinary tool-permission prompt, not just a chrome dialog", async () => {
    reset();
    agentRow({ name: "worker-permission-prompt", state: "waiting", stateChangedAgo: 5, target: permissionPromptPane });

    const { stdout } = await runCli(["doctor"], opts);

    assert.match(stdout, /pane: awaiting a choice \(dialog\)/);
    assert.match(stdout, /Do you want to insert this cell/, "the prompt's own question should be in the tail");
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
    // Scoped to worker-long's own report section, not the whole stdout: an
    // unscoped /STOP/ has no punctuation anchor at all (see the note above
    // this describe), so unlike its neighbors here it would, in principle,
    // also match a bare "STOP" spelled by random characters in the
    // dataDir/project path doctor prints earlier in the same report.
    // Genuinely bounded to worker-long's own block (counselors review,
    // see "the /STOP/ negative assertion itself" above): report()'s 8-space
    // continuation indent is what stops this from also matching a LATER
    // worker's own leaked tail, which the earlier `[\s\S]*?` version did not.
    assert.doesNotMatch(
      stdout,
      /worker worker-long:[^\n]*(\n {8}[^\n]*)*STOP/,
      "each line is padded past 160 chars; the trailing marker must be cut off",
    );
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

// Counselors round 1 on #73, F4. A foreign-socket running row never gets
// closed by the janitor sweep (rowAlive reads unknown, never dead), so it
// stays 'running' forever from this process's point of view - correct, per
// D4, but silently stuck: its name stays taken, agent_close refuses it, and
// hive restore counts it as active usage. None of this needs a real tmux
// probe (foreignSocket() is a pure string comparison), so no isolateTmux
// skip is needed here.
describe("hive doctor names a foreign-socket row it cannot sweep (counselors F4 on #73)", () => {
  it("warns, naming both sockets, for a running row recorded on a socket this process does not use", async () => {
    reset();
    agentRow({ name: "stuck-worker", state: "unknown", target: "%9999", socket: FOREIGN_SOCKET });

    const { stdout } = await runCli(["doctor"], opts);

    assert.match(
      stdout,
      new RegExp(`agent stuck-worker:[\\s\\S]*?recorded on tmux socket ${FOREIGN_SOCKET.replace(/\//g, "\\/")}`),
    );
    assert.match(stdout, /but this process would use/, "must name the socket this process would actually use too");
  });

  it("control: says nothing for a running row on this process's own socket", async () => {
    reset();
    agentRow({ name: "healthy-worker", state: "unknown", target: "%9998", socket: ownSocket });

    const { stdout } = await runCli(["doctor"], opts);

    assert.doesNotMatch(stdout, /healthy-worker:[\s\S]*?recorded on tmux socket/);
  });

  it("control: says nothing for a legacy row with no socket recorded at all", async () => {
    reset();
    agentRow({ name: "legacy-worker", state: "unknown", target: "%9997" });

    const { stdout } = await runCli(["doctor"], opts);

    assert.doesNotMatch(stdout, /legacy-worker:[\s\S]*?recorded on tmux socket/);
  });

  // Counselors round 2, F4. The tests above read stdout only, so they never
  // pinned that this report is a warn() rather than a fail() - changing that
  // one call would still leave every assertion above green while doctor
  // started exiting 1 for a state D4 says is merely unknown, not broken.
  // test/CLAUDE.md forbids asserting doctor's global exit code directly (not
  // portable across machines missing an optional binary), so compare the
  // FAILURE COUNT the summary line carries against a baseline taken on the
  // same machine, same as test/doctor-profile.test.mjs and
  // test/lead-doctor-liveness.test.mjs already do for this exact shape.
  it("is a warn(), not a fail() - must not move doctor's own failure count", async () => {
    reset();
    const baseline = await runCli(["doctor"], opts);

    agentRow({ name: "stuck-worker-exit-code", state: "unknown", target: "%9996", socket: FOREIGN_SOCKET });
    const { stdout } = await runCli(["doctor"], opts);

    assert.match(
      stdout,
      /stuck-worker-exit-code:[\s\S]*?recorded on tmux socket/,
      "the report must actually fire in this run, or the comparison below proves nothing",
    );
    assert.equal(
      failureCount(stdout),
      failureCount(baseline.stdout),
      "F4's report must stay a warn(); a fail() here would move this count and this assertion would catch it",
    );
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
