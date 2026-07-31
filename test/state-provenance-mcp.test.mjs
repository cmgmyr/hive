import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { after, before, beforeEach, describe, it } from "node:test";

import {
  McpClient,
  assertScratchStore,
  clearHiveEnv,
  insertStateLogRow,
  isolateTmux,
  scratchDirs,
} from "./helpers.mjs";

// L1 (design-l1). test/state-provenance.test.mjs already pins
// deriveProvenance()'s own logic exhaustively; this file pins that the two
// decorated MCP surfaces actually carry it through a real server -- agentSummary
// (agent_list, agent_status) and wake_when_idle's watching array -- and that
// wake_when_idle's already_satisfied path is untouched, since that predicate
// is explicitly out of scope for this lane (it belongs to L2).

const { hasTmux, cleanup } = isolateTmux("the state-provenance MCP surface tests");
const { dataDir, projectDir } = scratchDirs();

clearHiveEnv();
process.env.HIVE_DATA_DIR = dataDir;
await assertScratchStore();

const { db, migrate } = await import("../dist/db.js");
migrate();

const project = db
  .prepare("INSERT INTO projects (name, path) VALUES (?, ?) RETURNING id")
  .get("state-provenance-mcp-test", projectDir).id;

const session = `hive-provenance-${process.pid}`;
let livePane;

before(() => {
  if (!hasTmux) return;
  execFileSync("tmux", ["new-session", "-d", "-s", session, "sleep 600"], { stdio: "ignore" });
  livePane = execFileSync("tmux", ["list-panes", "-t", `=${session}`, "-F", "#{pane_id}"], {
    encoding: "utf8",
  })
    .trim()
    .split("\n")[0];
});

after(() => cleanup(session));

function makeActor(actorId) {
  db.prepare("INSERT INTO actors (id, name, kind) VALUES (?, ?, 'agent')").run(actorId, actorId);
}

// stateChangedAgo=null leaves state_changed_at NULL: a latch that has never
// changed, same as a freshly-spawned row before its first hook event.
function agentRow({ name, command = "claude", state = "unknown", target = livePane, stateChangedAgo = null }) {
  const actorId = `agent:${name}`;
  makeActor(actorId);
  return db
    .prepare(
      `INSERT INTO agents (project_id, actor_id, name, tmux_target, command, cwd, status,
         agent_state, state_changed_at, created_at)
       VALUES (?, ?, ?, ?, ?, '/tmp', 'running', ?,
         ${stateChangedAgo == null ? "NULL" : "datetime('now', ?)"}, datetime('now', '-60 seconds'))
       RETURNING id`,
    )
    .get(
      ...[project, actorId, name, target, command, state],
      ...(stateChangedAgo == null ? [] : [`-${stateChangedAgo} seconds`]),
    ).id;
}

const logRow = (actorId, event, state, agoSeconds) => insertStateLogRow(db, actorId, event, state, agoSeconds);

function reset() {
  db.exec("DELETE FROM agent_state_log; DELETE FROM agents; DELETE FROM actors;");
}

async function callTool(tool, args = {}) {
  const mcp = new McpClient({ cwd: projectDir, dataDir });
  await mcp.start();
  try {
    return await mcp.call(tool, args);
  } finally {
    await mcp.close();
  }
}

describe(
  "agent_list and agent_status carry provenance",
  { skip: hasTmux ? false : "tmux is not installed" },
  () => {
    beforeEach(reset);

    it("a normal prompt|working row reports source hook with its event and age", async () => {
      agentRow({ name: "normal", state: "working", stateChangedAgo: 90 });
      logRow("agent:normal", "prompt", "working", 90);

      const out = await callTool("agent_list", {});
      const row = out.agents.find((a) => a.name === "normal");

      assert.equal(row.provenance.source, "hook");
      assert.equal(row.provenance.event, "prompt");
      assert.ok(
        row.provenance.age_seconds >= 90 && row.provenance.age_seconds < 95,
        `age drifted too far from the seeded 90s: ${JSON.stringify(row.provenance)}`,
      );
      assert.ok(row.provenance.last_seen, "last_seen should flow through from actors.last_seen_at");
    });

    it("a claude worker with no log rows still carries the latch's age, provenance flagged absent", async () => {
      agentRow({ name: "no-log", state: "idle", stateChangedAgo: 400 });

      const out = await callTool("agent_list", {});
      const row = out.agents.find((a) => a.name === "no-log");

      assert.equal(row.provenance.source, "no-record");
      assert.equal(row.provenance.event, null);
      assert.ok(row.provenance.age_seconds >= 400, `age should still come from the latch: ${JSON.stringify(row.provenance)}`);
    });

    it("a non-claude worker reads not-instrumented, never stale", async () => {
      agentRow({ name: "probe", command: "sleep 600", state: "unknown" });

      const out = await callTool("agent_list", {});
      const row = out.agents.find((a) => a.name === "probe");

      assert.equal(row.provenance.source, "not-instrumented");
      assert.equal(row.provenance.age_seconds, null);
    });

    it("a worker the tmux probe reports gone carries the probe as the source, not a hook", async () => {
      agentRow({ name: "dead", state: "working", target: "%9999", stateChangedAgo: 50 });
      logRow("agent:dead", "prompt", "working", 50);

      const out = await callTool("agent_list", {});
      const row = out.agents.find((a) => a.name === "dead");

      assert.equal(row.agent_state, "gone", "agentSummary's own tmux-probe override, unchanged by this lane");
      assert.equal(row.provenance.source, "tmux-probe");
      assert.equal(row.provenance.event, null, "the probe answered; it is not a hook's observation");
    });

    it("a stop|working row (waitingOnSubagents, issue #24's fix) reports the stop event, correctly", async () => {
      agentRow({ name: "subagents", state: "working", stateChangedAgo: 100 });
      logRow("agent:subagents", "prompt", "working", 200);
      logRow("agent:subagents", "stop", "working", 100);

      const out = await callTool("agent_status", { name: "subagents" });

      assert.equal(out.agent_state, "working");
      assert.equal(out.provenance.source, "hook");
      assert.equal(out.provenance.event, "stop", "odd-looking and correct: a stop row explaining `working`");
    });

    it("a notify|unchanged row is never surfaced as the deciding event", async () => {
      agentRow({ name: "idle-prompt", state: "working", stateChangedAgo: 300 });
      logRow("agent:idle-prompt", "prompt", "working", 300);
      logRow("agent:idle-prompt", "notify", "unchanged", 20);

      const out = await callTool("agent_status", { name: "idle-prompt" });

      assert.equal(out.provenance.event, "prompt", "not notify: the unchanged row decided nothing");
      assert.equal(out.provenance.source, "hook");
    });
  },
);

describe(
  "wake_when_idle's watching array carries provenance",
  { skip: hasTmux ? false : "tmux is not installed" },
  () => {
    beforeEach(reset);

    it("decorates each watched agent without changing what gets scheduled", async () => {
      agentRow({ name: "watched", state: "working", stateChangedAgo: 30 });
      logRow("agent:watched", "prompt", "working", 30);
      agentRow({ name: "deliverer", state: "idle" });

      const out = await callTool("wake_when_idle", {
        agents: ["watched"],
        body: "check in",
        deliver_to: "deliverer",
      });

      assert.ok(out.wake_id, "decoration must not stop the call from scheduling normally");
      assert.equal(out.watching.length, 1);
      assert.equal(out.watching[0].name, "watched");
      assert.equal(out.watching[0].state, "working", "the bare state field still reports the live latch");
      assert.equal(out.watching[0].provenance.source, "hook");
      assert.equal(out.watching[0].provenance.event, "prompt");
    });

    it("reports gone for a watched agent the tmux probe can't find, matching agent_list", async () => {
      // src/tools/wakes.ts's `state` field used to come straight from
      // a.agent_state, so a dead watched agent showed its last real state
      // ("working") with no hint anything was wrong -- agent_list, on the
      // same row, already said "gone". Both now derive `state` from the same
      // deriveProvenance() call, so they cannot disagree about the same
      // worker again.
      agentRow({ name: "watched-dead", state: "working", target: "%9998", stateChangedAgo: 30 });
      logRow("agent:watched-dead", "prompt", "working", 30);
      agentRow({ name: "deliverer", state: "idle" });

      const out = await callTool("wake_when_idle", {
        agents: ["watched-dead"],
        body: "check in",
        deliver_to: "deliverer",
      });

      assert.equal(out.watching[0].state, "gone");
      assert.equal(out.watching[0].provenance.source, "tmux-probe");
    });

    it("leaves the already_satisfied path alone: no watching field, no freshness check added", async () => {
      // Pinned because this file touches wakes.ts: the already_satisfied
      // predicate at src/tools/wakes.ts is explicitly NOT this lane's to
      // change (that is L2), and this proves the edit here did not brush it.
      agentRow({ name: "idle-agent", state: "idle" });
      agentRow({ name: "deliverer", state: "idle" });

      const out = await callTool("wake_when_idle", {
        agents: ["idle-agent"],
        mode: "all",
        body: "check in",
        deliver_to: "deliverer",
      });

      assert.equal(out.status, "already_satisfied");
      assert.equal(out.watching, undefined, "the already_satisfied branch returns before watching is built");
    });
  },
);
