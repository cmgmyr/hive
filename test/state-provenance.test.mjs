import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { assertScratchStore, clearHiveEnv, scratchDirs } from "./helpers.mjs";

// L1 (design-l1, issue #38/#28/#27's design pad). deriveProvenance() is the
// one place every surface reads a worker's state, its age and where it came
// from. No tmux is touched by this file: deriveProvenance takes liveness as a
// plain argument rather than probing, so this suite needs no isolateTmux().

const { dataDir } = scratchDirs();
clearHiveEnv();
process.env.HIVE_DATA_DIR = dataDir;
await assertScratchStore();

const { db, migrate } = await import("../dist/db.js");
migrate();
const { deriveProvenance, ageSecondsSince, humanizeAge, describeForHuman } = await import(
  "../dist/stateProvenance.js"
);

const project = db
  .prepare("INSERT INTO projects (name, path) VALUES (?, ?) RETURNING id")
  .get("state-provenance-test", dataDir).id;

function reset() {
  db.exec("DELETE FROM agent_state_log; DELETE FROM agents; DELETE FROM actors;");
}

// now() is fixed to noon on an arbitrary day so age math never depends on the
// wall clock the test happens to run under; every timestamp below is written
// relative to it.
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
  // created_at is written explicitly (milliseconds format) rather than left to
  // the column default, so ordering between rows in one test is deterministic
  // instead of racing the real clock.
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
      { actor_id: actorId, command: "claude", agent_state: "working", state_changed_at: secondsAgo(90) },
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
    // Retention case: the latch survives, its own row does not.
    const actorId = "agent:no-log";
    makeActor(actorId, 5);
    const stateChangedAt = secondsAgo(400);

    const prov = deriveProvenance(
      { actor_id: actorId, command: "claude", agent_state: "idle", state_changed_at: stateChangedAt },
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
      { actor_id: actorId, command: "python3 probe.py", agent_state: "unknown", state_changed_at: null },
      true,
      NOW,
    );

    assert.equal(prov.source, "not-instrumented");
    assert.equal(prov.state, "unknown");
    assert.equal(prov.event, null);
    assert.equal(prov.since, null);
    assert.equal(prov.age_seconds, null);
  });

  it("a claude worker with alive=false reports the probe as the source, not a hook", () => {
    // agentSummary already collapses "gone" from the tmux probe into the same
    // field a hook writes (src/tools/agents.ts:282); this is the guard against
    // this module attributing that observation to the wrong witness.
    const actorId = "agent:dead";
    makeActor(actorId, 120);
    logRow(actorId, "prompt", "working", 500);

    const prov = deriveProvenance(
      { actor_id: actorId, command: "claude", agent_state: "working", state_changed_at: secondsAgo(500) },
      false,
      NOW,
    );

    assert.equal(prov.state, "gone");
    assert.equal(prov.source, "tmux-probe");
    assert.equal(prov.event, null, "the probe answered, not a hook; there is no event to attribute");
    assert.equal(prov.last_seen, secondsAgo(120), "last contact survives even though the worker is gone");
  });

  it("a stop|working row (waitingOnSubagents) reports the stop row with state working, correctly", () => {
    // Issue #24's fix: Stop fires while subagents are still running, so the
    // latch stays "working" even though the row that explains it is a stop.
    const actorId = "agent:subagents";
    makeActor(actorId, 10);
    logRow(actorId, "prompt", "working", 200);
    logRow(actorId, "stop", "working", 100);

    const prov = deriveProvenance(
      { actor_id: actorId, command: "claude", agent_state: "working", state_changed_at: secondsAgo(100) },
      true,
      NOW,
    );

    assert.equal(prov.state, "working");
    assert.equal(prov.source, "hook");
    assert.equal(prov.event, "stop", "the stop row is what explains this working, and that is correct");
    assert.equal(prov.age_seconds, 100);
  });

  it("a notify|unchanged row is never rendered as if it were a real state", () => {
    // stateForNotification returns null for idle_prompt, so hook.ts logs the
    // literal state "unchanged" (src/hook.ts's UNCHANGED sentinel) and leaves
    // the latch on whatever a real event wrote earlier. The unchanged row must
    // not be picked as the explaining row -- it explains nothing -- so the
    // derivation must reach past it to the real prompt|working underneath.
    const actorId = "agent:idle-prompt";
    makeActor(actorId, 8);
    logRow(actorId, "prompt", "working", 300);
    logRow(actorId, "notify", "unchanged", 60);

    const prov = deriveProvenance(
      { actor_id: actorId, command: "claude", agent_state: "working", state_changed_at: secondsAgo(300) },
      true,
      NOW,
    );

    assert.equal(prov.state, "working");
    assert.equal(prov.event, "prompt", "not notify: the unchanged row decided nothing");
    assert.equal(prov.source, "hook");
    assert.equal(prov.age_seconds, 300, "age is the latch's own age, unaffected by the later notify");
  });

  it("reports no-record, not a false hit, when only an unchanged row survives retention", () => {
    // The real state-writing row can be pruned while a LATER unchanged row for
    // the same actor survives, because retention deletes by a global id span,
    // not per actor. This must read as absent provenance, never as "notify"
    // explaining a state it did not write.
    const actorId = "agent:only-unchanged";
    makeActor(actorId, 2);
    logRow(actorId, "notify", "unchanged", 20);

    const prov = deriveProvenance(
      { actor_id: actorId, command: "claude", agent_state: "working", state_changed_at: secondsAgo(300) },
      true,
      NOW,
    );

    assert.equal(prov.source, "no-record");
    assert.equal(prov.event, null);
    assert.equal(prov.age_seconds, 300, "the latch's age is still known even though provenance is not");
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
    // The pin: a naive Date parse of "YYYY-MM-DD HH:MM:SS" reads as LOCAL time
    // on most engines, which would be off by the machine's UTC offset -- zero
    // on a UTC box, which is exactly the case that would hide this bug on CI.
    // Comparing against a known instant catches it regardless of the runner's
    // own timezone.
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
