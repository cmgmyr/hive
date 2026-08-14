import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import {
  McpClient,
  assertScratchStore,
  clearHiveEnv,
  createLiveAndDialogPanes,
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
// Issue #72's pane signal. dialogPane replays a real captured dialog screen
// (test/fixtures/panes/folder-trust-dialog.txt, same fixture
// typing-guards.test.mjs pins paneChoiceCheck against) rather than typing
// anything synthetic: what is under test here is agent_list carrying
// paneChoiceCheck's answer through, not paneChoiceCheck itself.
let livePane;
let dialogPane;

before(() => {
  if (!hasTmux) return;
  ({ livePane, dialogPane } = createLiveAndDialogPanes(session, "folder-trust-dialog.txt"));
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
  "agent_list surfaces #72's stopped-worker signals",
  { skip: hasTmux ? false : "tmux is not installed" },
  () => {
    beforeEach(reset);

    it("carries last_log_event for a claude worker, the LAST of several rows", async () => {
      // False-green shape 7 (test/CLAUDE.md): a fixture with only one state
      // cannot prove this is the last row, not just any row.
      agentRow({ name: "sequenced", state: "waiting" });
      logRow("agent:sequenced", "prompt", "working", 300);
      logRow("agent:sequenced", "stop", "idle", 200);
      logRow("agent:sequenced", "notify", "waiting", 40);

      const out = await callTool("agent_list", {});
      const row = out.agents.find((a) => a.name === "sequenced");

      assert.equal(row.last_log_event.event, "notify");
      assert.equal(row.last_log_event.state, "waiting");
      assert.ok(row.last_log_event.age_seconds >= 40 && row.last_log_event.age_seconds < 45);
    });

    it("reports last_log_event null, not absent, for a claude worker with no log rows", async () => {
      agentRow({ name: "no-log-72", state: "unknown" });

      const out = await callTool("agent_list", {});
      const row = out.agents.find((a) => a.name === "no-log-72");

      assert.ok("last_log_event" in row, "the key itself must be present for a claude worker");
      assert.equal(row.last_log_event, null);
    });

    it("omits last_log_event and pane entirely for a non-claude worker, which never writes this log", async () => {
      // Fix round 1, item 5b. paneField's reportsAgentStateLog half used to
      // be unpinned here: this worker is on a LIVE pane (alive === true), so
      // a mutant that gated pane only on `alive !== true return {}` -- never
      // checking reportsAgentStateLog at all -- passed every other test in
      // this file and would only go red here.
      agentRow({ name: "probe-72", command: "sleep 600", state: "unknown" });
      logRow("agent:probe-72", "prompt", "working", 10);

      const out = await callTool("agent_list", {});
      const row = out.agents.find((a) => a.name === "probe-72");

      assert.equal("last_log_event" in row, false, "a non-claude worker has no hook, so no field to report");
      assert.equal("pane" in row, false, "nor does it write a state a dialog could ever be checked against");
    });

    it("reports the dialog label for a worker parked on a real dialog screen, no tail (fix round 1, item 2)", async () => {
      agentRow({ name: "on-dialog", state: "waiting", target: dialogPane, stateChangedAgo: 5 });

      const out = await callTool("agent_list", {});
      const row = out.agents.find((a) => a.name === "on-dialog");

      assert.equal(row.pane, "awaiting a choice (dialog)");
      assert.equal("tail" in row, false, "agent_list's pane field is state-only; agent_output/agent_status carry the tail");
    });

    it("reports 'no dialog' for a worker on an ordinary, non-dialog pane", async () => {
      agentRow({ name: "no-dialog", state: "working", target: livePane, stateChangedAgo: 5 });

      const out = await callTool("agent_list", {});
      const row = out.agents.find((a) => a.name === "no-dialog");

      assert.equal(row.pane, "no dialog");
    });

    it("omits pane entirely for a worker the tmux probe cannot find, rather than probing a dead target", async () => {
      // Same bogus target the existing "dead" case above uses. alive is
      // false here, and #72's pane signal is specifically about a worker
      // that IS alive but stuck -- a dead one has nothing to capture.
      agentRow({ name: "gone-72", state: "working", target: "%9999", stateChangedAgo: 5 });

      const out = await callTool("agent_list", {});
      const row = out.agents.find((a) => a.name === "gone-72");

      assert.equal(row.alive, false);
      assert.equal("pane" in row, false);
      assert.ok("last_log_event" in row, "last_log_event does not depend on liveness, unlike pane");
    });

    it("agent_status does NOT carry a pane field from agentSummary (fix round 1, item 2b)", async () => {
      // paneField used to live inside the shared agentSummary, so agent_status
      // silently got a SECOND, independently-timed pane snapshot next to its
      // own capturePane/inputBoxField below -- a dialog clearing between the
      // two captures could leave one response with a dialog pane field beside
      // a top-level tail showing no dialog at all. agent_status must build
      // its pane picture from its own single capture only.
      agentRow({ name: "status-no-pane", state: "waiting", target: dialogPane, stateChangedAgo: 5 });

      const out = await callTool("agent_status", { name: "status-no-pane" });

      assert.equal("pane" in out, false);
      assert.ok(out.tail.includes("Esc to cancel"), "agent_status's own single capture still carries the dialog");
    });
  },
);

// Todo 392. The dialog fixture above (folder-trust-dialog.txt) never carried
// `╰`, so it could never have caught the bug: an ordinary tool-permission
// prompt's own preview box closes with `╰`, the same glyph paneChoiceCheck's
// INPUT_BOX_PRESENT used to trust as proof no dialog was up, and agent_list
// reported "no dialog" for a worker sitting on a real, unread prompt. Its own
// session and panes, deliberately: reusing dialogPane above would only prove
// the fixture that was already fine still works.
const permissionPromptSession = `hive-provenance-permission-${process.pid}`;
let permissionPromptDialogPane;

describe(
  "agent_list and agent_status report an ordinary tool-permission prompt as a dialog (todo 392)",
  { skip: hasTmux ? false : "tmux is not installed" },
  () => {
    beforeEach(reset);

    before(() => {
      if (!hasTmux) return;
      ({ dialogPane: permissionPromptDialogPane } = createLiveAndDialogPanes(
        permissionPromptSession,
        "tool-permission-prompt.txt",
      ));
    });

    after(() => cleanup(permissionPromptSession));

    it("agent_list reports the dialog label, not 'no dialog'", async () => {
      agentRow({ name: "on-permission-prompt", state: "waiting", target: permissionPromptDialogPane, stateChangedAgo: 5 });

      const out = await callTool("agent_list", {});
      const row = out.agents.find((a) => a.name === "on-permission-prompt");

      assert.equal(row.pane, "awaiting a choice (dialog)");
    });

    it("agent_status's own capture still carries the prompt's tail", async () => {
      agentRow({ name: "status-on-permission-prompt", state: "waiting", target: permissionPromptDialogPane, stateChangedAgo: 5 });

      const out = await callTool("agent_status", { name: "status-on-permission-prompt" });

      assert.ok(out.tail.includes("Esc to cancel"), "the prompt's own footer must be in the tail");
      assert.ok(out.tail.includes("Do you want to insert this cell"), "and its own question, not a generic dialog label");
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
