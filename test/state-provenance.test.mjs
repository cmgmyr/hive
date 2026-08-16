import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { assertScratchStore, clearHiveEnv, scratchDirs } from "./helpers.mjs";

const { dataDir } = scratchDirs();
clearHiveEnv();
process.env.HIVE_DATA_DIR = dataDir;
await assertScratchStore();

const { db, migrate } = await import("../dist/db.js");
migrate();
const { deriveProvenance, ageSecondsSince, humanizeAge, describeForHuman, lastLogEvent, describeLastLogEvent, reportsAgentStateLog } =
  await import("../dist/stateProvenance.js");

const project = db
  .prepare("INSERT INTO projects (name, path) VALUES (?, ?) RETURNING id")
  .get("state-provenance-test", dataDir).id;

function reset() {
  db.exec("DELETE FROM agent_state_log; DELETE FROM agents; DELETE FROM actors;");
}

const NOW = Date.parse("2026-07-31T12:00:00Z");
const secondsAgo = (s) => new Date(NOW - s * 1000).toISOString().slice(0, 19).replace("T", " ");

function makeActor(actorId, lastSeenAgoSeconds) {
  db.prepare("INSERT INTO actors (id, name, kind, last_seen_at) VALUES (?, ?, 'agent', ?)").run(
    actorId,
    actorId,
    secondsAgoOrNow(lastSeenAgoSeconds),
  );
}

function secondsAgoOrNow(s) {
  return s == null ? secondsAgo(0) : secondsAgo(s);
}

function makeAgent({ actorId, command = "claude", agentState = "unknown", stateChangedAgoSeconds = null }) {
  return db
    .prepare(
      `INSERT INTO agents (project_id, actor_id, name, tmux_target, command, cwd, status, agent_state, state_changed_at)
       VALUES (?, ?, ?, '%9600', ?, '/tmp', 'running', ?, ?) RETURNING id`,
    )
    .get(
      project,
      actorId,
      actorId,
      command,
      agentState,
      stateChangedAgoSeconds == null ? null : secondsAgo(stateChangedAgoSeconds),
    ).id;
}

function logRow(actorId, event, state, agoSeconds) {

  db.prepare(
    "INSERT INTO agent_state_log (actor_id, event, state, payload, created_at) VALUES (?, ?, ?, '{}', ?)",
  ).run(actorId, event, state, `${secondsAgo(agoSeconds)}.000`);
}

describe("deriveProvenance", () => {
  beforeEach(reset);

  it("a claude worker with a normal prompt|working row reports source hook and the deciding event", () => {
    const actorId = "agent:normal";
    makeActor(actorId, 30);
    makeAgent({ actorId, agentState: "working", stateChangedAgoSeconds: 90 });
    logRow(actorId, "prompt", "working", 90);

    const prov = deriveProvenance(
      { actor_id: actorId, command: "claude", agent_state: "working", state_changed_at: secondsAgo(90), kind: "agent" },
      true,
      NOW,
    );

    assert.equal(prov.state, "working");
    assert.equal(prov.source, "hook");
    assert.equal(prov.event, "prompt");
    assert.equal(prov.age_seconds, 90);
    assert.equal(prov.last_seen, secondsAgo(30));
  });

  it("a claude worker with NO log rows still reports correct age, and flags the provenance absent", () => {

    const actorId = "agent:no-log";
    makeActor(actorId, 5);
    const stateChangedAt = secondsAgo(400);

    const prov = deriveProvenance(
      { actor_id: actorId, command: "claude", agent_state: "idle", state_changed_at: stateChangedAt, kind: "agent" },
      true,
      NOW,
    );

    assert.equal(prov.source, "no-record");
    assert.equal(prov.event, null);
    assert.equal(prov.state, "idle");
    assert.equal(prov.age_seconds, 400, "age must come from the latch, not the missing log row");
  });

  it("a non-claude worker reads not-instrumented, never stale, even with no state and no log", () => {
    const actorId = "agent:probe";
    makeActor(actorId, 3);

    const prov = deriveProvenance(
      { actor_id: actorId, command: "python3 probe.py", agent_state: "unknown", state_changed_at: null, kind: "agent" },
      true,
      NOW,
    );

    assert.equal(prov.source, "not-instrumented");
    assert.equal(prov.state, "unknown");
    assert.equal(prov.event, null);
    assert.equal(prov.since, null);
    assert.equal(prov.age_seconds, null);
  });

  it("a lead reads not-instrumented, never no-record, even though its command is claude", () => {
    const actorId = "lead:1";
    makeActor(actorId, 3);

    const prov = deriveProvenance(
      { actor_id: actorId, command: "claude --settings /tmp/hooks.json", agent_state: "unknown", state_changed_at: null, kind: "lead" },
      true,
      NOW,
    );

    assert.equal(prov.source, "not-instrumented");
    assert.equal(prov.state, "unknown");
    assert.equal(prov.event, null);
    assert.equal(prov.age_seconds, null);
  });

  it("a kind='command' row running claude reads not-instrumented, never no-record", () => {
    const actorId = "command:watch-build";
    makeActor(actorId, 3);

    const prov = deriveProvenance(
      { actor_id: actorId, command: "claude -p 'watch the build'", agent_state: "unknown", state_changed_at: null, kind: "command" },
      true,
      NOW,
    );

    assert.equal(prov.source, "not-instrumented");
    assert.equal(prov.state, "unknown");
    assert.equal(prov.event, null);
    assert.equal(prov.age_seconds, null);
  });

  it("a claude worker with alive=false reports the probe as the source, not a hook", () => {

    const actorId = "agent:dead";
    makeActor(actorId, 120);
    logRow(actorId, "prompt", "working", 500);

    const prov = deriveProvenance(
      { actor_id: actorId, command: "claude", agent_state: "working", state_changed_at: secondsAgo(500), kind: "agent" },
      false,
      NOW,
    );

    assert.equal(prov.state, "gone");
    assert.equal(prov.source, "tmux-probe");
    assert.equal(prov.event, null, "the probe answered, not a hook; there is no event to attribute");
    assert.equal(prov.last_seen, secondsAgo(120), "last contact survives even though the worker is gone");
  });

  it("a stop|working row (waitingOnSubagents) reports the stop row with state working, correctly", () => {

    const actorId = "agent:subagents";
    makeActor(actorId, 10);
    logRow(actorId, "prompt", "working", 200);
    logRow(actorId, "stop", "working", 100);

    const prov = deriveProvenance(
      { actor_id: actorId, command: "claude", agent_state: "working", state_changed_at: secondsAgo(100), kind: "agent" },
      true,
      NOW,
    );

    assert.equal(prov.state, "working");
    assert.equal(prov.source, "hook");
    assert.equal(prov.event, "stop", "the stop row is what explains this working, and that is correct");
    assert.equal(prov.age_seconds, 100);
  });

  it("a notify|unchanged row is never rendered as if it were a real state", () => {

    const actorId = "agent:idle-prompt";
    makeActor(actorId, 8);
    logRow(actorId, "prompt", "working", 300);
    logRow(actorId, "notify", "unchanged", 60);

    const prov = deriveProvenance(
      { actor_id: actorId, command: "claude", agent_state: "working", state_changed_at: secondsAgo(300), kind: "agent" },
      true,
      NOW,
    );

    assert.equal(prov.state, "working");
    assert.equal(prov.event, "prompt", "not notify: the unchanged row decided nothing");
    assert.equal(prov.source, "hook");
    assert.equal(prov.age_seconds, 300, "age is the latch's own age, unaffected by the later notify");
  });

  it("reports no-record, not a false hit, when only an unchanged row survives retention", () => {

    const actorId = "agent:only-unchanged";
    makeActor(actorId, 2);
    logRow(actorId, "notify", "unchanged", 20);

    const prov = deriveProvenance(
      { actor_id: actorId, command: "claude", agent_state: "working", state_changed_at: secondsAgo(300), kind: "agent" },
      true,
      NOW,
    );

    assert.equal(prov.source, "no-record");
    assert.equal(prov.event, null);
    assert.equal(prov.age_seconds, 300, "the latch's age is still known even though provenance is not");
  });

  it("carries 'not yet given anything' for a row whose latch is set, and omits the field otherwise", () => {
    const actorId = "agent:unbriefed";
    makeActor(actorId, 3);
    logRow(actorId, "stop", "idle", 45);
    const row = {
      actor_id: actorId,
      command: "claude",
      agent_state: "idle",
      state_changed_at: secondsAgo(45),
      kind: "agent",
      resumed_at: "2026-07-31 11:59:00",
    };

    const prov = deriveProvenance(row, true, NOW);
    assert.equal(prov.awaiting_first_prompt, true);

    assert.equal(prov.state, "idle");
    assert.equal(
      describeForHuman(prov, NOW),
      "idle (no assignment yet, 45s ago)",
      "the sentence a lead and the kickoff digest actually read",
    );

    const briefed = deriveProvenance({ ...row, resumed_at: "" }, true, NOW);
    assert.equal("awaiting_first_prompt" in briefed, false);
    assert.equal(describeForHuman(briefed, NOW), "idle (stop, 45s ago)");
  });

  it("a row with no resumed_at at all is not treated as awaiting", () => {
    const actorId = "agent:no-column";
    makeActor(actorId, 3);
    logRow(actorId, "stop", "idle", 10);
    const prov = deriveProvenance(
      { actor_id: actorId, command: "claude", agent_state: "idle", state_changed_at: secondsAgo(10), kind: "agent" },
      true,
      NOW,
    );
    assert.equal("awaiting_first_prompt" in prov, false);
  });
});

describe("lastLogEvent", () => {
  beforeEach(reset);

  it("reports the LAST row in the sequence, not the first", () => {

    const actorId = "agent:sequence";
    logRow(actorId, "prompt", "working", 300);
    logRow(actorId, "stop", "idle", 200);
    logRow(actorId, "notify", "waiting", 40);

    const last = lastLogEvent(actorId, NOW);

    assert.equal(last.event, "notify");
    assert.equal(last.state, "waiting");
    assert.equal(last.age_seconds, 40);

    assert.equal(last.at, `${secondsAgo(40)}.000`);
  });

  it("returns null when the actor has no log rows at all", () => {

    assert.equal(lastLogEvent("agent:never-logged", NOW), null);
  });

  it("scopes to the requested actor, not the whole table", () => {

    logRow("agent:other", "prompt", "working", 5);
    logRow("agent:target", "stop", "idle", 500);

    const last = lastLogEvent("agent:target", NOW);

    assert.equal(last.event, "stop");
    assert.equal(last.age_seconds, 500);
  });

  it("breaks a created_at tie on id, matching the table's own forensic ordering", () => {

    const actorId = "agent:tie";
    const at = secondsAgo(10);
    db.prepare(
      "INSERT INTO agent_state_log (actor_id, event, state, payload, created_at) VALUES (?, 'prompt', 'working', '{}', ?)",
    ).run(actorId, `${at}.500`);
    db.prepare(
      "INSERT INTO agent_state_log (actor_id, event, state, payload, created_at) VALUES (?, 'stop', 'idle', '{}', ?)",
    ).run(actorId, `${at}.500`);

    const last = lastLogEvent(actorId, NOW);

    assert.equal(last.event, "stop", "the second INSERT has the higher id and must win the tie");
  });

  it("reports a notify|unchanged row as-is, never silently reaching past it", () => {

    const actorId = "agent:unchanged-tail";
    logRow(actorId, "prompt", "working", 300);
    logRow(actorId, "notify", "unchanged", 20);

    const last = lastLogEvent(actorId, NOW);

    assert.equal(last.event, "notify");
    assert.equal(last.state, "unchanged");
    assert.equal(last.age_seconds, 20);
  });
});

describe("describeLastLogEvent", () => {
  it("renders the event and its age", () => {
    assert.equal(describeLastLogEvent({ event: "notify", state: "waiting", age_seconds: 2400, at: "x" }), "notify (40m ago)");
  });

  it("renders 'no record' for null, never a fabricated age", () => {
    assert.equal(describeLastLogEvent(null), "no record");
  });
});

describe("reportsAgentStateLog", () => {
  it("is true only for kind='agent' running a claude command", () => {
    assert.equal(reportsAgentStateLog({ kind: "agent", command: "claude" }), true);
  });

  it("is false for a lead, even though its command is claude and it does write log rows", () => {

    assert.equal(reportsAgentStateLog({ kind: "lead", command: "claude --settings /tmp/hooks.json" }), false);
  });

  it("is false for a non-claude command, even with kind='agent'", () => {
    assert.equal(reportsAgentStateLog({ kind: "agent", command: "sleep 600" }), false);
  });

  it("is false for a command row running a non-claude command", () => {
    assert.equal(reportsAgentStateLog({ kind: "command", command: "npm run dev" }), false);
  });

  it("is false for a command row running claude -- the row shape item 4 was fixed for", () => {
    assert.equal(reportsAgentStateLog({ kind: "command", command: "claude -p 'watch the build'" }), false);
  });
});

describe("humanizeAge boundaries", () => {
  it("stays in seconds up to 59", () => {
    assert.equal(humanizeAge(0), "0s");
    assert.equal(humanizeAge(59), "59s");
  });

  it("crosses into minutes at 60", () => {
    assert.equal(humanizeAge(60), "1m");
    assert.equal(humanizeAge(3599), "59m");
  });

  it("crosses into hours at 3600", () => {
    assert.equal(humanizeAge(3600), "1h");
    assert.equal(humanizeAge(7200), "2h");
  });
});

describe("ageSecondsSince", () => {
  it("reads a UTC store timestamp as UTC, not local wall-clock", () => {

    assert.equal(ageSecondsSince("2026-07-31 11:59:00", NOW), 60);
  });

  it("never goes negative for a timestamp at or after now", () => {
    assert.equal(ageSecondsSince("2026-07-31 12:00:00", NOW), 0);
  });
});

describe("describeForHuman", () => {
  it("renders a hook-sourced state with its event and age", () => {
    assert.equal(
      describeForHuman({ state: "working", source: "hook", event: "prompt", since: null, age_seconds: 90, last_seen: null }),
      "working (prompt, 1m ago)",
    );
  });

  it("renders not-instrumented with no age at all", () => {
    assert.equal(
      describeForHuman({ state: "unknown", source: "not-instrumented", event: null, since: null, age_seconds: null, last_seen: null }),
      "unknown (not instrumented)",
    );
  });

  it("renders no-record with the age it still has", () => {
    assert.equal(
      describeForHuman({ state: "idle", source: "no-record", event: null, since: null, age_seconds: 400, last_seen: null }),
      "idle (no record, 6m ago)",
    );
  });

  it("renders no-record with no age at all when the latch itself was never observed", () => {
    assert.equal(
      describeForHuman({ state: "unknown", source: "no-record", event: null, since: null, age_seconds: null, last_seen: null }),
      "unknown (no record)",
    );
  });

  it("renders gone with last contact, and bare gone when contact was never recorded", () => {
    assert.equal(
      describeForHuman(
        { state: "gone", source: "tmux-probe", event: null, since: null, age_seconds: null, last_seen: "2026-07-31 11:58:00" },
        NOW,
      ),
      "gone (last seen 2m ago)",
    );
    assert.equal(
      describeForHuman({ state: "gone", source: "tmux-probe", event: null, since: null, age_seconds: null, last_seen: null }),
      "gone",
    );
  });
});
