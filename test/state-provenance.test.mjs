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
const { deriveProvenance, ageSecondsSince, humanizeAge, describeForHuman, lastLogEvent, describeLastLogEvent, reportsAgentStateLog } =
  await import("../dist/stateProvenance.js");

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

// Fix round 1, item 4. Every row literal below now sets kind: "agent"
// explicitly. Before this round the gate was a lead-specific blocklist, so a
// literal with no `kind` at all happened to read as an ordinary agent by
// accident (undefined !== "lead"); that never represented a real row, since
// agents.kind is NOT NULL DEFAULT 'agent' (src/db.ts) and every row read
// from the table always has one. reportsAgentStateLog's allowlist takes that
// accident away, correctly, so these fixtures now say explicitly what they
// always meant.
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
    // Retention case: the latch survives, its own row does not.
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

  // Issue #27's L4 fix round, DECISION 4. A lead DOES get --settings and its
  // hook DOES fire (unlike the non-claude case above), but src/hook.ts's
  // agent_state UPDATE is scoped to kind = 'agent' (worker-state.md), so a
  // lead's agent_state never leaves its 'unknown' default. Without the kind
  // check, isClaudeCommand(row.command) alone cannot tell that apart from a
  // genuinely fresh worker that just has not reported in yet - which is
  // exactly what "no-record" means - so a lead used to read as a worker on
  // the verge of its first report, forever, rather than one with no state
  // channel at all, permanently, by design.
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

  // Fix round 2, item 2 (both counselors seats). Fix round 1, item 4's own
  // regression test never seeded this row through deriveProvenance itself --
  // reportsAgentStateLog's unit test above covers the predicate in
  // isolation, this covers the gate that actually calls it. A kind='command'
  // row (a hive.yml process started by `hive start`, src/cli.ts) running
  // claude gets no HIVE_AGENT_ID and no --settings (src/spawn.ts), so it can
  // never write a hook row, exactly like a lead -- before item 4 this fell
  // through to "no-record" forever, "a claude worker that hasn't checked in
  // yet", which is precisely the misreport DECISION 4 fixed for the lead.
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
    // agentSummary already collapses "gone" from the tmux probe into the same
    // field a hook writes (src/tools/agents.ts:282); this is the guard against
    // this module attributing that observation to the wrong witness.
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
    // Issue #24's fix: Stop fires while subagents are still running, so the
    // latch stays "working" even though the row that explains it is a stop.
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
    // The real state-writing row can be pruned while a LATER unchanged row for
    // the same actor survives, because retention deletes by a global id span,
    // not per actor. This must read as absent provenance, never as "notify"
    // explaining a state it did not write.
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

  // TODO 373, COUNSELORS F3. deriveProvenance is what `hive status` and the
  // SessionStart digest describe a worker with, and the digest is INJECTED
  // into a fresh lead's context beside the instruction to triage it. So "idle
  // for 3m" about a worker nobody has briefed is not a display nit: a model
  // reads that sentence and proposes lanes off it.
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
    // The raw latch is UNCHANGED for any caller reading JSON: this reports a
    // fact beside the state, it does not rewrite the state.
    assert.equal(prov.state, "idle");
    assert.equal(
      describeForHuman(prov, NOW),
      "idle (no assignment yet, 45s ago)",
      "the sentence a lead and the kickoff digest actually read",
    );

    // OMITTED, not `false`, for the ordinary row - these fields ride in every
    // agent_list and agent_status receipt.
    const briefed = deriveProvenance({ ...row, resumed_at: "" }, true, NOW);
    assert.equal("awaiting_first_prompt" in briefed, false);
    assert.equal(describeForHuman(briefed, NOW), "idle (stop, 45s ago)");
  });

  // A partial row literal is a caller bug, and the safe reading of it is "no
  // fact recorded" rather than "awaiting": this predicate only ever
  // SUPPRESSES, so reading an accident as SET would go silent about a worker
  // that really finished. Same shape as this file's own `kind` lesson above.
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
    // False-green shape 7 (test/CLAUDE.md): a fixture with only one state
    // cannot prove this picks the last of several. Three rows here, three
    // different events, so a function that returned the first, or a fixed
    // index, or the row matching some other state, goes red.
    const actorId = "agent:sequence";
    logRow(actorId, "prompt", "working", 300);
    logRow(actorId, "stop", "idle", 200);
    logRow(actorId, "notify", "waiting", 40);

    const last = lastLogEvent(actorId, NOW);

    assert.equal(last.event, "notify");
    assert.equal(last.state, "waiting");
    assert.equal(last.age_seconds, 40);
    // Fix round 1, item 5c: `at` was asserted nowhere in this suite, so
    // `at: row.created_at` -> `at: ""` survived the whole suite while still
    // shipping in agent_list's payload. A caller with a wrong timestamp has
    // no way to notice one that is never checked.
    assert.equal(last.at, `${secondsAgo(40)}.000`);
  });

  it("returns null when the actor has no log rows at all", () => {
    // Never a fabricated age of zero: absence is its own answer, distinct
    // from a fresh row at age 0.
    assert.equal(lastLogEvent("agent:never-logged", NOW), null);
  });

  it("scopes to the requested actor, not the whole table", () => {
    // A function that ignored actor_id (e.g. always returned MAX(id) across
    // every actor) would pass every other test here by accident and only
    // fail this one.
    logRow("agent:other", "prompt", "working", 5);
    logRow("agent:target", "stop", "idle", 500);

    const last = lastLogEvent("agent:target", NOW);

    assert.equal(last.event, "stop");
    assert.equal(last.age_seconds, 500);
  });

  it("breaks a created_at tie on id, matching the table's own forensic ordering", () => {
    // Two rows logged in the same millisecond must still resolve to the
    // truly-later one. Ordering by created_at string alone (rather than id)
    // would leave this nondeterministic and could return either row.
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
    // Unlike deriveProvenance (which must reach past an "unchanged" sentinel
    // to find the row that actually explains the latch), this function
    // reports whatever the log's own last row says, raw. Reaching past it
    // here would be the wrong behaviour for THIS question.
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
    // worker-state.md: a lead's hook DOES insert into agent_state_log (its
    // state UPDATE is what's scoped to kind='agent', not the log write) --
    // this predicate is deliberately about #72's worker-liveness surface,
    // not about whether a row physically exists in the table.
    assert.equal(reportsAgentStateLog({ kind: "lead", command: "claude --settings /tmp/hooks.json" }), false);
  });

  it("is false for a non-claude command, even with kind='agent'", () => {
    assert.equal(reportsAgentStateLog({ kind: "agent", command: "sleep 600" }), false);
  });

  it("is false for a command row running a non-claude command", () => {
    assert.equal(reportsAgentStateLog({ kind: "command", command: "npm run dev" }), false);
  });

  // Fix round 2, item 2 (both counselors seats). Every command-row fixture
  // anywhere in this suite before this test used a non-claude command, which
  // is false under BOTH this allowlist and the OLD lead-only blocklist it
  // replaced (fix round 1, item 4) -- so a mutant reverting to
  // `isClaudeCommand(row.command) && row.kind !== "lead"` passed the whole
  // suite. This is the one row shape that disagrees: a kind='command' row
  // (a hive.yml process started by `hive start`) running claude itself.
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
