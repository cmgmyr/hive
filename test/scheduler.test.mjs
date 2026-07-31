import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";

import { DIST, FS_SWAP_IMPORT, runFixture, scratchDirs, storeReplaceScript } from "./helpers.mjs";

// Issue #49. Once storeReplaced() (src/db.ts) is tripped, tick() must do none
// of its work - no janitor sweep, no retention, no hourly backup, no timer
// delivery - and never throw. Separately, the interval startScheduler created
// must actually stop, not just keep firing a tick() that no-ops forever.
//
// Every fixture below constructs its own AliveSnapshot literal ({ panes,
// windows }) rather than reaching real tmux, so nothing here needs
// isolateTmux(): an empty snapshot means "nothing alive", matching what
// src/tmux.ts documents for a server that answered with nothing running.

// Seeds a project, one running agent whose pane will not be in the snapshot,
// one stale agent_state_log row, and one due, undeliverable timer. Shared by
// both the tripped run and its control so the only difference between them
// is the latch.
const SEED = `
const project = db.prepare("INSERT INTO projects (name, path) VALUES ('sched-test', '/tmp/sched-test') RETURNING id").get().id;
db.prepare(
  \`INSERT INTO agents (project_id, actor_id, name, tmux_target, command, cwd, status, agent_state, created_at)
   VALUES (?, 'agent:dead', 'dead-one', '%dead', 'claude', '/tmp', 'running', 'working', datetime('now', '-60 seconds'))\`,
).run(project);
db.prepare(
  "INSERT INTO agent_state_log (actor_id, event, state, created_at) VALUES ('agent:dead', 'stop', 'idle', datetime('now', '-8 days'))",
).run();
const timerId = db.prepare(
  \`INSERT INTO timers (project_id, owner, body, kind, watch, deliver_actor, deliver_pane, due_at, created_at)
   VALUES (?, 'user:test', 'wake body', 'delay', '[]', 'user:test', '%dead', datetime('now', '-1 seconds'), datetime('now', '-60 seconds'))
   RETURNING id\`,
).get(project).id;
const snapshot = { panes: new Set(), windows: new Set() };
`;

const READBACK = `
const agentStatus = db.prepare("SELECT status FROM agents WHERE actor_id = 'agent:dead'").get().status;
const staleLogRows = db.prepare("SELECT COUNT(*) AS n FROM agent_state_log WHERE actor_id = 'agent:dead'").get().n;
const timerRow = db.prepare("SELECT fired_at, cancelled_at FROM timers WHERE id = ?").get(timerId);
const backupAttempted = db.prepare("SELECT last_attempt_at FROM backup_meta WHERE id = 1").get().last_attempt_at !== null;
process.stdout.write(JSON.stringify({ agentStatus, staleLogRows, timerFired: timerRow.fired_at !== null, timerCancelled: timerRow.cancelled_at !== null, backupAttempted }));
`;

describe("tick() and an orphaned store", () => {
  it("runs its normal work when the store is untouched (control)", () => {
    const { dataDir, tmp } = scratchDirs();
    const out = runFixture(
      tmp,
      "control",
      `const { db, migrate } = await import(${JSON.stringify(join(DIST, "db.js"))});\n` +
        `const { tick } = await import(${JSON.stringify(join(DIST, "scheduler.js"))});\n` +
        `migrate();\n${SEED}\n` +
        `await tick(snapshot);\n${READBACK}`,
      { HIVE_DATA_DIR: dataDir },
    );
    assert.equal(out.agentStatus, "closed", "janitor should have closed the dead agent");
    assert.equal(out.staleLogRows, 0, "pruneStateLog should have deleted the stale row");
    assert.equal(out.timerFired, false, "an undeliverable timer is never fired");
    assert.equal(out.timerCancelled, true, "deliverable() should have cancelled it, proving the timer path ran");
    assert.equal(out.backupAttempted, true, "maybeBackupHourly should have claimed and attempted a backup");
  });

  it("skips every piece of tick's work once the store was replaced, and never throws", () => {
    const { dataDir, tmp } = scratchDirs();
    const dbPath = JSON.stringify(join(dataDir, "hive.db"));
    const out = runFixture(
      tmp,
      "tripped",
      FS_SWAP_IMPORT +
        `const { db, migrate } = await import(${JSON.stringify(join(DIST, "db.js"))});\n` +
        `const { tick } = await import(${JSON.stringify(join(DIST, "scheduler.js"))});\n` +
        `migrate();\n${SEED}\n` +
        storeReplaceScript(dbPath) +
        // If tick() threw, this await would reject and the fixture process
        // would exit non-zero, which runFixture already asserts against.
        `await tick(snapshot);\n${READBACK}`,
      { HIVE_DATA_DIR: dataDir },
    );
    assert.equal(out.agentStatus, "running", "janitor must not run once the store was replaced");
    assert.equal(out.staleLogRows, 1, "pruneStateLog must not run");
    assert.equal(out.timerFired, false);
    assert.equal(out.timerCancelled, false, "the timer path (deliverable/cancelTimer) must never be reached");
    assert.equal(out.backupAttempted, false, "maybeBackupHourly must not run");
  });

  it("stops the interval permanently, rather than firing a tick that no-ops forever", () => {
    const { dataDir, tmp } = scratchDirs();
    const dbPath = JSON.stringify(join(dataDir, "hive.db"));
    const out = runFixture(
      tmp,
      "interval-stops",
      FS_SWAP_IMPORT +
        // Observe clearInterval without touching production code: wrap the
        // globals before startScheduler ever calls setInterval.
        `const timers = [];\n` +
        `let cleared = null;\n` +
        `const realSetInterval = globalThis.setInterval;\n` +
        `const realClearInterval = globalThis.clearInterval;\n` +
        `globalThis.setInterval = (fn, ms) => { const h = realSetInterval(fn, ms); timers.push(h); return h; };\n` +
        `globalThis.clearInterval = (h) => { cleared = h; return realClearInterval(h); };\n` +
        `const { migrate } = await import(${JSON.stringify(join(DIST, "db.js"))});\n` +
        `const { startScheduler } = await import(${JSON.stringify(join(DIST, "scheduler.js"))});\n` +
        `migrate();\n` +
        storeReplaceScript(dbPath) +
        `startScheduler(20);\n` +
        // Long enough for several 20ms ticks to have had the chance to fire.
        `await new Promise((r) => setTimeout(r, 300));\n` +
        `process.stdout.write(JSON.stringify({ intervalsCreated: timers.length, clearedTheOneItCreated: cleared !== null && cleared === timers[0] }));\n`,
      { HIVE_DATA_DIR: dataDir },
    );
    assert.equal(out.intervalsCreated, 1);
    assert.equal(out.clearedTheOneItCreated, true, "tick() must clear the exact interval startScheduler created");
  });
});
