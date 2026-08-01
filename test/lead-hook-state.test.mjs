import assert from "node:assert/strict";
import { join } from "node:path";
import { beforeEach, describe, it } from "node:test";

import { DIST, assertScratchStore, clearHiveEnv, isolateTmux, runNode, scratchDirs } from "./helpers.mjs";

// Issue #27, step 3. The lead now has an agents row (kind='lead'), so
// src/hook.ts's `UPDATE agents SET agent_state ... WHERE actor_id = ?` would
// MATCH one for the first time and write exactly the state
// .claude/rules/worker-state.md's "never set a /goal on a worker" says a
// lead running unattended under /goal cannot be trusted to hold: nine
// consecutive false idles were measured on agent:53 in 50 seconds with no
// prompt|working between them, and the lead has no supervisor above it the
// way a lead polls a worker. The fix is a discriminator on kind, read once
// per invocation, not "the UPDATE matches zero rows anyway" - that reasoning
// is exactly what stopped being true here.

isolateTmux("the lead hook state tests");
const { dataDir } = scratchDirs();

clearHiveEnv();
process.env.HIVE_DATA_DIR = dataDir;
await assertScratchStore();

const { db, migrate } = await import("../dist/db.js");
migrate();

const HOOK = join(DIST, "hook.js");

const project = db
  .prepare("INSERT INTO projects (name, path) VALUES (?, ?) RETURNING id")
  .get("lead-hook-state-test", dataDir).id;

function agentRow(name, kind, state = "unknown") {
  return db
    .prepare(
      `INSERT INTO agents (project_id, actor_id, name, kind, tmux_target, command, cwd, status, agent_state)
       VALUES (?, ?, ?, ?, '%9600', 'claude', '/tmp', 'running', ?) RETURNING id`,
    )
    .get(project, `${kind}:${name}`, name, kind, state).id;
}

const stateOf = (id) => db.prepare("SELECT agent_state FROM agents WHERE id = ?").get(id).agent_state;

const logFor = (actorId) =>
  db.prepare("SELECT * FROM agent_state_log WHERE actor_id = ? ORDER BY id").all(actorId);

async function runHook(event, payload, actorId) {
  const { code } = await runNode(HOOK, [event], {
    dataDir,
    env: { HIVE_AGENT_ID: actorId },
    stdin: payload ?? "",
  });
  return code;
}

function reset() {
  db.exec("DELETE FROM agent_state_log; DELETE FROM agents;");
}

describe("the lead's hook writes the log row and nothing else", () => {
  beforeEach(reset);

  it("writes a log row for a lead and leaves agents.agent_state untouched", async () => {
    const lead = agentRow("l1", "lead", "unknown");

    const code = await runHook("prompt", "{}", "lead:l1");

    assert.equal(code, 0);
    assert.equal(stateOf(lead), "unknown", "agents.agent_state must not move for a lead");

    const rows = logFor("lead:l1");
    assert.equal(rows.length, 1, "the log row is the whole point of this design");
    assert.equal(rows[0].event, "prompt");
    assert.equal(rows[0].state, "working", "the computed state is still logged, just not written to agents");
  });

  it("does not overwrite a state a lead already carried into the run", async () => {
    // The negative control for the test above: a lead whose agent_state is
    // NOT 'unknown' proves the skip is a real branch, not a coincidence of
    // the column's default value matching what the UPDATE would have set.
    const lead = agentRow("l2", "lead", "working");

    await runHook("stop", JSON.stringify({ background_tasks: [] }), "lead:l2");

    assert.equal(stateOf(lead), "working", "stop would write 'idle' for a worker; a lead must keep its old value");
  });

  it("still writes state for a worker, the accept case for this change", async () => {
    // The half of the acceptance criteria a skip is most likely to break by
    // accident: proving kind='agent' still goes through the UPDATE at all.
    const worker = agentRow("w1", "agent", "unknown");

    await runHook("prompt", "{}", "agent:w1");

    assert.equal(stateOf(worker), "working", "a worker's state must still be written");
    assert.equal(logFor("agent:w1").length, 1);
  });
});
