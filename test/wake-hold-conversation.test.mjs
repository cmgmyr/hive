import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { DIST, runFixture, scratchDirs } from "./helpers.mjs";

// todo 455 commit 2: a wake targeting a lead's own pane holds rather than delivers while a human
// recently talked to that lead, so a discussion is not split by whatever comes due. This exercises
// deliverable()'s new HELD_REASON_CONVERSATION branch directly via tick(), with synthetic panes -
// no real tmux pane is needed because a pane that fails to capture (paneAwaitingChoice/inputBoxState)
// reads as "no dialog, no input box", which is exactly the behaviour these fixtures want.

const IMPORTS =
  `const { db, migrate } = await import(${JSON.stringify(join(DIST, "db.js"))});\n` +
  `const { tick } = await import(${JSON.stringify(join(DIST, "scheduler.js"))});\n` +
  "migrate();\n";

const SEED = `
const project = db.prepare("INSERT INTO projects (name, path) VALUES ('conv', '/tmp/conv') RETURNING id").get().id;
db.prepare(
  \`INSERT INTO agents (project_id, actor_id, name, kind, tmux_target, command, cwd, status, agent_state, created_at)
   VALUES (?, 'lead:1', 'the-lead', 'lead', '%lead', 'claude', '/tmp', 'running', 'unknown', datetime('now', '-300 seconds'))\`,
).run(project);
db.prepare(
  \`INSERT INTO agents (project_id, actor_id, name, kind, tmux_target, command, cwd, status, agent_state, created_at)
   VALUES (?, 'agent:9', 'a-worker', 'agent', '%worker', 'claude', '/tmp', 'running', 'idle', datetime('now', '-300 seconds'))\`,
).run(project);
const addWake = (deliverActor, deliverPane) => db.prepare(
  \`INSERT INTO timers (project_id, owner, body, kind, deliver_actor, deliver_pane, due_at, created_at)
   VALUES (?, ?, 'wake body', 'delay', ?, ?, datetime('now', '-1 seconds'), datetime('now', '-60 seconds'))
   RETURNING id\`,
).get(project, deliverActor, deliverActor, deliverPane).id;
const logPrompt = (actor, offset, prompt) => db.prepare(
  "INSERT INTO agent_state_log (actor_id, event, state, payload, created_at) VALUES (?, 'prompt', 'working', ?, datetime('now', ?))",
).run(actor, JSON.stringify({ prompt }), offset);
const timerRow = (id) => db.prepare("SELECT held_at, held_reason, first_held_at, fired_at, typed_at FROM timers WHERE id = ?").get(id);
const snapshot = { panes: new Set(['%lead', '%worker']), windows: new Set() };
`;

const fixture = (name, body) => {
  const { dataDir, tmp } = scratchDirs();
  return runFixture(tmp, name, IMPORTS + SEED + body, { HIVE_DATA_DIR: dataDir });
};

const out = (expr) => `process.stdout.write(JSON.stringify(${expr}));\n`;

describe("todo 455 commit 2: the conversation hold", () => {
  it("holds a wake to the lead's pane when a human message landed within the TTL", () => {
    const result = fixture(
      "holds-within-ttl",
      `
      const wakeId = addWake('lead:1', '%lead');
      logPrompt('lead:1', '-30 seconds', 'what do you think about this');
      await tick(snapshot);
      ${out("{ row: timerRow(wakeId) }")}
      `,
    );
    assert.equal(result.row.fired_at, null, "a fresh human message must hold delivery, not let it through");
    assert.equal(result.row.typed_at, null);
    assert.match(
      result.row.held_reason ?? "",
      /talked to this lead/,
      "the hold must carry its own reason, not an unrelated one",
    );
  });

  it("delivers normally when no human has spoken to the lead at all", () => {
    const result = fixture(
      "no-human-message",
      `
      const wakeId = addWake('lead:1', '%lead');
      await tick(snapshot);
      ${out("{ row: timerRow(wakeId) }")}
      `,
    );
    assert.ok(result.row.fired_at !== null, "with no prior human turn, the wake must deliver on schedule");
  });

  it("delivers when the most recent prompt row is hive's own typed wake, not a human message", () => {
    const result = fixture(
      "hive-typed-not-human",
      `
      const wakeId = addWake('lead:1', '%lead');
      logPrompt('lead:1', '-30 seconds', '[hive wake #999] an earlier notice landed here');
      await tick(snapshot);
      ${out("{ row: timerRow(wakeId) }")}
      `,
    );
    assert.ok(
      result.row.fired_at !== null,
      "a row shaped like hive's own delivery must not be mistaken for a human talking",
    );
  });

  it("delivers once the TTL has passed, even though a human did message this lead earlier", () => {
    const result = fixture(
      "ttl-expired",
      `
      const wakeId = addWake('lead:1', '%lead');
      logPrompt('lead:1', '-600 seconds', 'a message from ten minutes ago');
      await tick(snapshot);
      ${out("{ row: timerRow(wakeId) }")}
      `,
    );
    assert.ok(result.row.fired_at !== null, "a human message outside the TTL window must not hold delivery");
  });

  it("stops holding once the hold's own ceiling is reached, even with a fresh human message", () => {
    const result = fixture(
      "ceiling-overrides-fresh-message",
      `
      const wakeId = addWake('lead:1', '%lead');
      // The ceiling is measured against due_at (todo 455 fix 2), stamped once at creation - a wake
      // due 20 minutes ago is well past CONVERSATION_HOLD_MAX (15 minutes).
      db.prepare(
        "UPDATE timers SET due_at = datetime('now', '-1200 seconds'), held_at = datetime('now', '-1200 seconds'), held_reason = 'a human talked to this lead', first_held_at = datetime('now', '-1200 seconds') WHERE id = ?",
      ).run(wakeId);
      logPrompt('lead:1', '-30 seconds', 'still talking, right now');
      await tick(snapshot);
      ${out("{ row: timerRow(wakeId) }")}
      `,
    );
    assert.ok(
      result.row.fired_at !== null,
      "a due_at older than the ceiling must deliver regardless of how recently the human spoke",
    );
    // held_reason clearing on a successful delivery is deliver()'s own existing behaviour (recordTyped),
    // exercised by hold-visibility-repeat-hold.test.mjs against a real pane; this fixture's synthetic
    // pane cannot complete a real send, so it is not re-asserted here.
  });

  it("todo 455 fix 2: an ordinary hive-lead reattach clearing held_at must not launder the ceiling", () => {
    const result = fixture(
      "reattach-does-not-launder-ceiling",
      `
      const wakeId = addWake('lead:1', '%lead');
      // The wake genuinely became due 20 minutes ago (past CONVERSATION_HOLD_MAX). first_held_at is
      // set to a RECENT time, exactly the state a prior reattach-during-hold cycle would leave behind:
      // src/cli.ts:639-641 clears held_at/held_reason on every \`hive lead\` invocation but leaves
      // first_held_at untouched, and holdTimer's own COALESCE resets first_held_at the next time it
      // finds held_at IS NULL - so a first_held_at that looks fresh despite a long-overdue due_at is
      // exactly what that laundering produces, not a contrived state.
      db.prepare(
        "UPDATE timers SET due_at = datetime('now', '-1200 seconds'), held_at = NULL, held_reason = NULL, first_held_at = datetime('now', '-30 seconds') WHERE id = ?",
      ).run(wakeId);
      logPrompt('lead:1', '-15 seconds', 'still talking, right after the reattach');
      await tick(snapshot);
      ${out("{ row: timerRow(wakeId) }")}
      `,
    );
    assert.ok(
      result.row.fired_at !== null,
      "the ceiling must still expire measured against due_at, even when first_held_at reads fresh",
    );
  });

  it("only holds a LEAD delivery target; a worker's pane is unaffected by this hold", () => {
    const result = fixture(
      "worker-target-not-held",
      `
      const wakeId = addWake('agent:9', '%worker');
      logPrompt('agent:9', '-30 seconds', 'text in a worker actor_id row, for the control');
      await tick(snapshot);
      ${out("{ row: timerRow(wakeId) }")}
      `,
    );
    assert.ok(
      result.row.fired_at !== null,
      "the conversation hold is gated on isLeadActorId; a worker target must never be held by it",
    );
  });
});
