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

const { hasTmux, cleanup: cleanupTmux } = isolateTmux("the state-provenance CLI surface tests");
const session = `hive-provenance-cli-${process.pid}`;
after(() => cleanupTmux(session));

let livePane;
let dialogPane;

let longPane;

let busyPane;

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

  it("adds a last-log-event line for a claude worker, independent of the provenance line", async () => {

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

    reset();
    agentRow({ name: "worker-1", state: "working", stateChangedAgo: 90, target: busyPane });
    logRow("agent:worker-1", "prompt", "working", 90);

    const { stdout } = await runCli(["doctor"], opts);

    assert.match(stdout, /worker worker-1: last log event: prompt \(1m ago\)/);
    assert.match(stdout, /pane: no dialog/);

    assert.match(
      stdout,
      /\| .*auto mode on/,
      "real screen content must survive, prefixed (fix round 2, item 4), not just a 'tail:' label",
    );
  });

  it("caps and cleans a hostile log event before printing it, same as `hive status` and the wake body do", async () => {

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

    reset();
    agentRow({ name: "worker-blank", state: "working", stateChangedAgo: 90, target: livePane });
    logRow("agent:worker-blank", "prompt", "working", 90);

    const { stdout } = await runCli(["doctor"], opts);

    assert.match(stdout, /tail: \(pane rendered nothing\)/);
    assert.doesNotMatch(stdout, /worker worker-blank:[\s\S]*?tail:\n/, "must not print a bare 'tail:' header with no content");
  });

  it("names an UNREADABLE tail differently from an empty one (fix round 3, PR gate finding)", async () => {

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

    assert.doesNotMatch(
      stdout,
      /worker worker-long:[^\n]*(\n {8}[^\n]*)*STOP/,
      "each line is padded past 160 chars; the trailing marker must be cut off",
    );
  });

  it("never fails or warns doctor's overall verdict on a worker's age alone", async () => {

    reset();
    agentRow({ name: "worker-dialog", state: "waiting", stateChangedAgo: 5, target: dialogPane });
    logRow("agent:worker-dialog", "notify", "waiting", 3600);

    const { stdout } = await runCli(["doctor"], opts);

    assert.match(stdout, /last log event: notify \(1h ago\)/, "the old age must actually be in play, not just seeded");
    assert.doesNotMatch(stdout, /FAIL {2}worker/);
    assert.doesNotMatch(stdout, /warn {2}worker/);
  });

  it("prints no worker line at all for a non-claude command row (fix round 1, item 5a)", async () => {

    reset();
    agentRow({ name: "dev-server", command: "sleep 600", state: "unknown", target: livePane });

    const { stdout } = await runCli(["doctor"], opts);

    assert.doesNotMatch(stdout, /worker dev-server:/);
  });
});

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

    agentRow({ name: "worker-3", state: "idle", stateChangedAgo: 400 });

    const { stdout } = await runNode(KICKOFF, [], opts);
    const { additionalContext } = firedSessionStart(stdout);

    assert.match(additionalContext, /worker-3 \[idle \(no record, 6m ago\)\] \/tmp\/worker/);
  });
});
