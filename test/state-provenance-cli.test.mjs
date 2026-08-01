import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import {
  KICKOFF,
  assertScratchStore,
  clearHiveEnv,
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

const { cleanup: cleanupTmux } = isolateTmux("the state-provenance CLI surface tests");
after(() => cleanupTmux());

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
function agentRow({ name, command = "claude", state = "unknown", stateChangedAgo = null }) {
  db.prepare(
    `INSERT INTO agents (project_id, actor_id, name, tmux_target, command, cwd, status, kind, agent_state, state_changed_at)
     VALUES (?, ?, ?, '%9600', ?, '/tmp/worker', 'running', 'agent', ?,
       ${stateChangedAgo == null ? "NULL" : "datetime('now', ?)"})`,
  ).run(
    ...[project, `agent:${name}`, name, command, state],
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
