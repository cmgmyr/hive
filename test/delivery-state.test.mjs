import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import {
  assertScratchStore,
  clearHiveEnv,
  DIST,
  insertStateLogRow,
  isolateTmux,
  runCli,
  runFixture,
  scratchDirs,
  until,
  wakeConfirmPayload,
} from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("the delivery-state tests");
const { dataDir, projectDir } = scratchDirs();

clearHiveEnv();
process.env.HIVE_DATA_DIR = dataDir;
await assertScratchStore();

const { db, migrate } = await import("../dist/db.js");
const { tick, ACTIVE_TIMER_WHERE, checkConfirmations } = await import("../dist/scheduler.js");
migrate();

const session = `hive-delivery-state-${process.pid}`;
let livePane;

before(() => {
  if (!hasTmux) return;
  execFileSync("tmux", ["new-session", "-d", "-s", session, "sleep 600"], { stdio: "ignore" });
  livePane = execFileSync("tmux", ["list-panes", "-t", `=${session}`, "-F", "#{pane_id}"], {
    encoding: "utf8",
  }).trim();
});

after(() => cleanup(session));

let projectCount = 0;
function seedProject() {

  return db
    .prepare("INSERT INTO projects (name, path) VALUES ('delivery-state-test', ?) RETURNING id")
    .get(`${projectDir}-${projectCount++}`).id;
}

const timerRow = (id) =>
  db
    .prepare(
      "SELECT fired_at, typed_at, held_at, held_reason, fire_count, due_at, typed_busy FROM timers WHERE id = ?",
    )
    .get(id);

describe("issue #27: the scheduler records what it did, not just that it claimed", () => {

  it("a sendText that throws leaves fired_at set and typed_at NULL", async () => {
    if (!hasTmux) return;
    const project = seedProject();

    const timerId = db
      .prepare(
        `INSERT INTO timers (project_id, owner, body, kind, watch, deliver_actor, deliver_pane,
           due_at, created_at)
         VALUES (?, 'user:test', 'wake body', 'delay', '[]', 'user:test', '%999999',
           datetime('now', '-1 seconds'), datetime('now', '-60 seconds'))
         RETURNING id`,
      )
      .get(project).id;
    const snapshot = { panes: new Set(["%999999"]), windows: new Set() };

    await tick(snapshot);

    const row = timerRow(timerId);
    assert.notEqual(row.fired_at, null, "the claim still happens before delivery is attempted");
    assert.equal(row.typed_at, null, "the paste never reached a pane, so no attempt may be recorded");
  });

  it("the repeating-timer claim path (due_at UPDATE, not claimOneShot) also records typed_at", async () => {
    if (!hasTmux) return;
    const project = seedProject();
    const timerId = db
      .prepare(
        `INSERT INTO timers (project_id, owner, body, kind, watch, deliver_actor, deliver_pane,
           due_at, created_at, repeat_every_ms)
         VALUES (?, 'user:test', 'repeat body', 'delay', '[]', 'user:test', ?,
           datetime('now', '-1 seconds'), datetime('now', '-60 seconds'), 5000)
         RETURNING id`,
      )
      .get(project, livePane).id;

    await tick();

    const row = timerRow(timerId);
    assert.notEqual(row.fired_at, null);
    assert.equal(row.fire_count, 1);
    assert.notEqual(row.typed_at, null, "delivery through the repeating path must record typed_at too");
    assert.ok(row.due_at, "the repeat schedule must still have advanced, unrelated to typed_at");
  });

  it("ACTIVE_TIMER_WHERE is unchanged - a wider clause would fire timers this lane must not touch", () => {
    assert.equal(
      ACTIVE_TIMER_WHERE,
      "cancelled_at IS NULL AND (fired_at IS NULL OR repeat_every_ms IS NOT NULL)",
      "this lane is reporting-only; widening this clause changes what fires, not just what is reported",
    );
  });
});

function seedDueTimer(project, actor, pane) {
  return db
    .prepare(
      `INSERT INTO timers (project_id, owner, body, kind, watch, deliver_actor, deliver_pane,
         due_at, created_at)
       VALUES (?, 'user:test', 'busy-check wake', 'delay', '[]', ?, ?,
         datetime('now', '-1 seconds'), datetime('now', '-60 seconds'))
       RETURNING id`,
    )
    .get(project, actor, pane).id;
}

const TYPED_BUSY_CASES = [
  {
    label: "working",
    seed: (actor) => insertStateLogRow(db, actor, "prompt", "working", 5),
    expected: 1,
    message: "a target whose last hook row is 'working' must be recorded as busy",
  },
  {
    label: "waiting",
    seed: (actor) => insertStateLogRow(db, actor, "notify", "waiting", 5),
    expected: 1,
    message:
      "'waiting' (latched through however long an approved tool runs) must count as busy, not be reported as the real alarm",
  },
  {
    label: "idle",
    seed: (actor) => insertStateLogRow(db, actor, "stop", "idle", 5),
    expected: 0,
    message:
      "an idle target must record 0, not 1 and not NULL - a reader distinguishes 'observed idle' from 'never observed'",
  },
  {
    label: "unchanged",
    seed: (actor) => insertStateLogRow(db, actor, "notify", "unchanged", 5),
    expected: 0,
    message: "the notify sentinel 'unchanged' (Claude signalling it is genuinely free) must read as not-busy",
  },
  {
    label: "never instrumented",
    seed: null,
    expected: null,
    message: "no hook row at all must read as unknown, never coerced to 'not busy'",
  },
];

describe("issue #75: the scheduler records whether the target was busy at delivery time", () => {
  for (const { label, seed, expected, message } of TYPED_BUSY_CASES) {
    it(`records typed_busy = ${expected} when the target's last hook row is ${label}`, async () => {
      if (!hasTmux) return;
      const project = seedProject();
      const actor = `agent:busy-${label.replace(/\s+/g, "-")}-${project}`;
      seed?.(actor);
      const timerId = seedDueTimer(project, actor, livePane);

      await tick();

      const row = timerRow(timerId);
      assert.ok(row.typed_at, "must have actually delivered for this test to mean anything");
      assert.equal(row.typed_busy, expected, message);
    });
  }

  it("reads typed_busy from the log even for a lead, whose agents.agent_state latch never updates", async () => {
    if (!hasTmux) return;
    const project = seedProject();
    const actor = `lead:e2-${project}`;
    db.prepare(
      `INSERT INTO agents (project_id, actor_id, name, command, cwd, kind)
       VALUES (?, ?, 'e2-lead', 'claude', '/tmp', 'lead')`,
    ).run(project, actor);
    assert.equal(
      db.prepare("SELECT agent_state FROM agents WHERE actor_id = ?").get(actor).agent_state,
      "unknown",
      "a lead's latch must still be at its untouched default for this test to mean anything",
    );
    insertStateLogRow(db, actor, "prompt", "working", 5);
    const timerId = seedDueTimer(project, actor, livePane);

    await tick();

    const row = timerRow(timerId);
    assert.ok(row.typed_at, "must have actually delivered for this test to mean anything");
    assert.equal(row.typed_busy, 1, "typed_busy must come from the log, not the lead's never-updated latch");
  });

  it("resets typed_busy on every re-delivery of a repeating timer, not just its first", async () => {
    if (!hasTmux) return;
    const project = seedProject();
    const actor = `agent:busy-repeat-${project}`;
    insertStateLogRow(db, actor, "prompt", "working", 5);
    const timerId = db
      .prepare(
        `INSERT INTO timers (project_id, owner, body, kind, watch, deliver_actor, deliver_pane,
           due_at, created_at, repeat_every_ms)
         VALUES (?, 'user:test', 'repeat busy-check', 'delay', '[]', ?, ?,
           datetime('now', '-1 seconds'), datetime('now', '-60 seconds'), 999999999)
         RETURNING id`,
      )
      .get(project, actor, livePane).id;

    await tick();
    const fire1 = timerRow(timerId);
    assert.equal(fire1.typed_busy, 1, "fire 1 must record the working observation seeded above");

    insertStateLogRow(db, actor, "stop", "idle", 0);
    db.prepare("UPDATE timers SET due_at = datetime('now', '-1 seconds') WHERE id = ?").run(timerId);
    await tick();

    const fire2 = timerRow(timerId);
    assert.equal(fire2.fire_count, 2, "must have actually re-fired for this test to mean anything");
    assert.equal(
      fire2.typed_busy,
      0,
      "fire 2 must record its own, later observation - fire 1's busy=1 must not survive the claim",
    );
  });
});

function seedDelivered(project, actor, typedAt) {
  return db
    .prepare(
      `INSERT INTO timers (project_id, owner, body, kind, watch, deliver_actor, deliver_pane,
         due_at, created_at, fired_at, typed_at)
       VALUES (?, 'user:test', 'wake body', 'delay', '[]', ?, '%confirm-pane',
         datetime('now', '-60 seconds'), datetime('now', '-60 seconds'), datetime('now', '-30 seconds'), ?)
       RETURNING id`,
    )
    .get(project, actor, typedAt).id;
}

const EMPTY_SNAPSHOT = { panes: new Set(), windows: new Set() };

const nowOffset = (sql) => db.prepare(`SELECT datetime('now', ?) AS v`).get(sql).v;

describe("issue #27: confirmation is read from agent_state_log, stamped once as a durable memo", () => {

  it("confirms only a prompt row that both matches this wake's marker and lands at or after typed_at", async () => {
    const project = seedProject();
    const actor = `agent:confirm-order-${project}`;
    const typedAt = nowOffset("-40 seconds");
    const timerId = seedDelivered(project, actor, typedAt);

    insertStateLogRow(db, actor, "prompt", "working", 50, wakeConfirmPayload(timerId));
    await tick(EMPTY_SNAPSHOT);
    assert.equal(
      db.prepare("SELECT confirmed_at FROM timers WHERE id = ?").get(timerId).confirmed_at,
      null,
      "an earlier turn must not confirm a later wake, even carrying that wake's own marker",
    );

    insertStateLogRow(db, actor, "prompt", "working", 35);
    await tick(EMPTY_SNAPSHOT);
    assert.equal(
      db.prepare("SELECT confirmed_at FROM timers WHERE id = ?").get(timerId).confirmed_at,
      null,
      "a same-actor prompt row at or after typed_at must NOT confirm without this wake's own marker - " +
        "an unrelated turn (a different wake, a background subagent's task-notification) is exactly this shape",
    );

    insertStateLogRow(db, actor, "prompt", "working", 20, wakeConfirmPayload(timerId));
    const confirming = db
      .prepare("SELECT created_at FROM agent_state_log WHERE actor_id = ? ORDER BY id DESC LIMIT 1")
      .get(actor).created_at;
    await tick(EMPTY_SNAPSHOT);

    assert.equal(
      db.prepare("SELECT confirmed_at FROM timers WHERE id = ?").get(timerId).confirmed_at,
      confirming,
      "a prompt row at or after typed_at carrying this wake's own marker must confirm it",
    );
  });

  it("stamps confirmed_at durably, so a later eviction of the log row does not un-confirm it", async () => {
    const project = seedProject();
    const actor = `agent:confirm-durable-${project}`;
    const typedAt = nowOffset("-40 seconds");
    const timerId = seedDelivered(project, actor, typedAt);
    insertStateLogRow(db, actor, "prompt", "working", 39, wakeConfirmPayload(timerId));

    await tick(EMPTY_SNAPSHOT);
    const stamped = db.prepare("SELECT confirmed_at FROM timers WHERE id = ?").get(timerId).confirmed_at;
    assert.notEqual(stamped, null, "must have observed and stamped the confirmation");

    db.prepare("DELETE FROM agent_state_log WHERE actor_id = ?").run(actor);

    await tick(EMPTY_SNAPSHOT);
    assert.equal(
      db.prepare("SELECT confirmed_at FROM timers WHERE id = ?").get(timerId).confirmed_at,
      stamped,
      "a stored confirmation must survive the log row it was derived from being evicted later",
    );
  });

  it("stays unconfirmed while nothing has arrived, without inferring loss", async () => {
    const project = seedProject();
    const actor = `agent:confirm-silent-${project}`;
    const timerId = seedDelivered(project, actor, nowOffset("-40 seconds"));

    await tick(EMPTY_SNAPSHOT);

    assert.equal(
      db.prepare("SELECT confirmed_at FROM timers WHERE id = ?").get(timerId).confirmed_at,
      null,
      "absence of a prompt row means not-yet-confirmed, never inferred loss",
    );
  });

  it("touches only the timer it can actually confirm, not every pending one in the window", () => {
    const project = seedProject();
    const pendingActor = `agent:a5-pending-${project}`;
    const confirmActor = `agent:a5-confirm-${project}`;
    const typedAt = nowOffset("-40 seconds");
    const pendingId = seedDelivered(project, pendingActor, typedAt);
    const confirmId = seedDelivered(project, confirmActor, typedAt);
    insertStateLogRow(db, confirmActor, "prompt", "working", 20, wakeConfirmPayload(confirmId));

    checkConfirmations();

    assert.notEqual(
      db.prepare("SELECT confirmed_at FROM timers WHERE id = ?").get(confirmId).confirmed_at,
      null,
      "the timer with a matching prompt row must actually be confirmed for this test to mean anything",
    );
    assert.equal(
      db.prepare("SELECT confirmed_at FROM timers WHERE id = ?").get(pendingId).confirmed_at,
      null,
    );
    assert.equal(
      db.prepare("SELECT changes() AS n").get().n,
      1,
      "AND EXISTS must keep a timer with no matching prompt row OUT of the UPDATE's WHERE match " +
        "entirely - writing NULL over an already-NULL confirmed_at still counts as a changed row",
    );
  });

  it("does not confirm from a prompt row genuinely before the real typed_at, even inside the same wall second", async () => {
    if (!hasTmux) return;
    const project = seedProject();
    const actor = `agent:confirm-subsecond-${project}`;
    const timerId = db
      .prepare(
        `INSERT INTO timers (project_id, owner, body, kind, watch, deliver_actor, deliver_pane,
           due_at, created_at)
         VALUES (?, 'user:test', 'wake body', 'delay', '[]', ?, ?,
           datetime('now', '-1 seconds'), datetime('now', '-60 seconds'))
         RETURNING id`,
      )
      .get(project, actor, livePane).id;

    await tick();
    const typedAt = db.prepare("SELECT typed_at FROM timers WHERE id = ?").get(timerId).typed_at;
    assert.ok(typedAt, "must have actually delivered for this test to mean anything");

    const hasMs = typedAt.includes(".");
    const datePart = hasMs ? typedAt.slice(0, 19) : typedAt;
    const msPart = hasMs ? typedAt.slice(20) : null;
    const before =
      msPart !== "000"
        ? `${datePart}.000`
        : new Date(new Date(`${datePart.replace(" ", "T")}Z`).getTime() - 1000)
            .toISOString()
            .replace("T", " ")
            .replace(/\.\d+Z$/, ".999");

    db.prepare(
      "INSERT INTO agent_state_log (actor_id, event, state, payload, created_at) VALUES (?, 'prompt', 'working', ?, ?)",
    ).run(actor, wakeConfirmPayload(timerId), before);

    await tick();

    assert.equal(
      db.prepare("SELECT confirmed_at FROM timers WHERE id = ?").get(timerId).confirmed_at,
      null,
      "a prompt row genuinely before typed_at must never confirm it, whole-second flooring or not",
    );
  });

  it("resets confirmed_at on every re-delivery of a repeating timer, not just its claim", async () => {
    if (!hasTmux) return;
    const project = seedProject();
    const actor = `agent:confirm-repeat-${project}`;

    const timerId = db
      .prepare(
        `INSERT INTO timers (project_id, owner, body, kind, watch, deliver_actor, deliver_pane,
           due_at, created_at, repeat_every_ms)
         VALUES (?, 'user:test', 'repeat confirm body', 'delay', '[]', ?, ?,
           datetime('now', '-1 seconds'), datetime('now', '-60 seconds'), 999999999)
         RETURNING id`,
      )
      .get(project, actor, livePane).id;

    await tick();
    const fire1 = db.prepare("SELECT typed_at FROM timers WHERE id = ?").get(timerId);
    assert.ok(fire1.typed_at, "must have actually delivered fire 1 for this test to mean anything");

    insertStateLogRow(db, actor, "prompt", "working", 0, wakeConfirmPayload(timerId));
    await tick();
    const confirmed1 = db.prepare("SELECT confirmed_at FROM timers WHERE id = ?").get(timerId).confirmed_at;
    assert.notEqual(confirmed1, null, "fire 1 must be confirmed before this test can prove anything about later fires");

    db.prepare(
      "UPDATE timers SET due_at = datetime('now', '-1 seconds'), deliver_pane = '%999999' WHERE id = ?",
    ).run(timerId);
    const fakePaneSnapshot = { panes: new Set(["%999999"]), windows: new Set() };
    await tick(fakePaneSnapshot);

    const failedCycle = db
      .prepare("SELECT typed_at, confirmed_at, held_at, fire_count FROM timers WHERE id = ?")
      .get(timerId);
    assert.equal(failedCycle.fire_count, 2, "the claim must still succeed even though the send then fails");
    assert.equal(
      failedCycle.typed_at,
      null,
      "a failed send must not leave the PREVIOUS cycle's typed_at in place - this cycle was never typed",
    );
    assert.equal(
      failedCycle.confirmed_at,
      null,
      "a failed send must not leave the previous cycle's confirmation attached to a cycle nobody typed",
    );
    assert.equal(failedCycle.held_at, null, "a send failure is not a hold; it must not be reported as one");

    db.prepare("UPDATE timers SET due_at = datetime('now', '-1 seconds'), deliver_pane = ? WHERE id = ?").run(
      livePane,
      timerId,
    );
    await tick();

    const fire3 = db.prepare("SELECT typed_at, confirmed_at, fire_count FROM timers WHERE id = ?").get(timerId);
    assert.equal(fire3.fire_count, 3, "must have actually re-fired for this test to mean anything");
    assert.notEqual(fire3.typed_at, fire1.typed_at, "fire 3 must record its own, later typed_at");
    assert.equal(
      fire3.confirmed_at,
      null,
      "fire 3 must start unconfirmed - fire 1's confirmation must not freeze on this row forever",
    );

    await tick();
    assert.equal(
      db.prepare("SELECT confirmed_at FROM timers WHERE id = ?").get(timerId).confirmed_at,
      null,
      "a stale prompt row from before this delivery must not confirm it",
    );

    insertStateLogRow(db, actor, "prompt", "working", 0, wakeConfirmPayload(timerId));
    await tick();
    const confirmed3 = db.prepare("SELECT confirmed_at FROM timers WHERE id = ?").get(timerId).confirmed_at;
    assert.notEqual(confirmed3, null, "a fresh prompt row after fire 3's typed_at must confirm it");
    assert.notEqual(confirmed3, confirmed1, "fire 3's confirmation must be its own, not fire 1's stale value");
  });
});

describe("issue #27, counselors A4: the held_at write is guarded against a concurrent claim", () => {

  it("does not hold a timer a concurrent instance already claimed and delivered", async () => {
    if (!hasTmux) return;
    const project = seedProject();
    const actor = `agent:held-race-${project}`;

    db.prepare(
      `INSERT INTO timers (project_id, owner, body, kind, watch, deliver_actor, deliver_pane,
         due_at, created_at)
       VALUES (?, 'user:test', 'decoy', 'delay', '[]', ?, ?,
         datetime('now', '-1 seconds'), datetime('now', '-60 seconds'))`,
    ).run(project, actor, livePane);

    execFileSync("tmux", ["new-window", "-t", `=${session}`, `printf 'Do you want to proceed?\\n 1. Yes\\n 2. No\\n\\n Esc to cancel\\n'; sleep 600`], {
      stdio: "ignore",
    });
    const panes = execFileSync("tmux", ["list-panes", "-s", "-t", `=${session}`, "-F", "#{pane_id}"], {
      encoding: "utf8",
    }).trim().split("\n");
    const dialogPane = panes[panes.length - 1];

    const timerId = db
      .prepare(
        `INSERT INTO timers (project_id, owner, body, kind, watch, deliver_actor, deliver_pane,
           due_at, created_at, repeat_every_ms)
         VALUES (?, 'user:test', 'raced repeat', 'delay', '[]', ?, ?,
           datetime('now', '-1 seconds'), datetime('now', '-60 seconds'), 999999999)
         RETURNING id`,
      )
      .get(project, actor, dialogPane).id;
    const staleDueAt = db.prepare("SELECT due_at FROM timers WHERE id = ?").get(timerId).due_at;

    setTimeout(() => {
      db.prepare(
        `UPDATE timers SET due_at = datetime('now', '+999999 seconds'),
           fired_at = datetime('now'), fire_count = fire_count + 1,
           typed_at = strftime('%Y-%m-%d %H:%M:%f', 'now'), confirmed_at = NULL,
           held_at = NULL, held_reason = NULL
         WHERE id = ? AND due_at = ?`,
      ).run(timerId, staleDueAt);
    }, 50);

    await tick();

    const decoyTyped = db
      .prepare("SELECT typed_at FROM timers WHERE deliver_actor = ? AND body = 'decoy'")
      .get(actor).typed_at;
    assert.ok(decoyTyped, "the decoy must have actually delivered - it is what buys this test its race window");

    const raced = db.prepare("SELECT held_at, held_reason, due_at FROM timers WHERE id = ?").get(timerId);
    assert.notEqual(raced.due_at, staleDueAt, "the simulated concurrent claim must have actually landed for this test to mean anything");
    assert.equal(
      raced.held_at,
      null,
      "a held write guarded by the claim's own due_at token must not land on a row a concurrent instance already claimed and delivered",
    );
    assert.equal(raced.held_reason, null);
  });
});

describe("issue #27: a bookkeeping write that fails costs the record, never the delivery", () => {
  it("does not turn a held timer into a crash, or a delivered wake into an aborted tick, even with agent_state_log gone", async () => {
    if (!hasTmux) return;
    const { dataDir: bkDataDir, tmp: bkTmp } = scratchDirs();
    const outFile = join(bkTmp, "bookkeeping-delivered.txt");
    writeFileSync(outFile, "");

    const bkSession = `hive-bookkeeping-${process.pid}`;
    execFileSync(
      "tmux",
      [
        "new-session", "-d", "-s", bkSession, "-x", "200", "-y", "50",
        "printf 'Do you want to proceed?\\n 1. Yes\\n 2. No\\n\\n Esc to cancel\\n'; sleep 600",
      ],
      { stdio: "ignore" },
    );
    execFileSync("tmux", ["new-window", "-t", bkSession, `cat > ${outFile}`], { stdio: "ignore" });
    const [dialogPane, deliveryPane] = execFileSync(
      "tmux",
      ["list-panes", "-s", "-t", `=${bkSession}`, "-F", "#{pane_id}"],
      { encoding: "utf8" },
    )
      .trim()
      .split("\n");

    try {
      const seed = (pane, body) =>
        `db.prepare(\`INSERT INTO timers (project_id, owner, body, kind, watch, deliver_actor, deliver_pane, due_at, created_at) VALUES (?, 'user:test', ?, 'delay', '[]', 'user:test', ?, datetime('now', '-1 seconds'), datetime('now', '-60 seconds'))\`).run(project, ${JSON.stringify(body)}, ${JSON.stringify(pane)});\n`;
      const out = runFixture(
        bkTmp,
        "bookkeeping",
        `const { db, migrate } = await import(${JSON.stringify(join(DIST, "db.js"))});\n` +
          `const { tick } = await import(${JSON.stringify(join(DIST, "scheduler.js"))});\n` +
          `migrate();\n` +
          `const project = db.prepare("INSERT INTO projects (name, path) VALUES ('bk-test', '/tmp/bk-test') RETURNING id").get().id;\n` +
          seed(dialogPane, "HELD wake") +
          seed(deliveryPane, "ALPHA delivered") +
          seed(deliveryPane, "BETA delivered") +

          `db.exec("ALTER TABLE timers DROP COLUMN held_at");\n` +
          `db.exec("ALTER TABLE timers DROP COLUMN typed_at");\n` +

          `db.exec("DROP TABLE agent_state_log");\n` +
          `await tick();\n` +
          `const dialogRow = db.prepare("SELECT fired_at, cancelled_at FROM timers WHERE deliver_pane = ? AND body = 'HELD wake'").get(${JSON.stringify(dialogPane)});\n` +
          `process.stdout.write(JSON.stringify({ dialogFired: dialogRow.fired_at !== null, dialogCancelled: dialogRow.cancelled_at !== null }));\n`,
        { HIVE_DATA_DIR: bkDataDir, TMUX_TMPDIR: process.env.TMUX_TMPDIR },
      );

      assert.equal(
        out.dialogFired,
        false,
        "deliverable() must still correctly hold the dialog timer even though recording the hold threw",
      );
      assert.equal(out.dialogCancelled, false, "and must not cancel it either; the pane is alive");

      await until(() => {
        const delivered = readFileSync(outFile, "utf8");
        return delivered.includes("ALPHA delivered") && delivered.includes("BETA delivered");
      });
      const delivered = readFileSync(outFile, "utf8");
      assert.match(
        delivered,
        /ALPHA delivered/,
        "a bookkeeping write failing after a successful sendText must not cost the delivery",
      );
      assert.match(
        delivered,
        /BETA delivered/,
        "and must not abort the candidates after it in the same tick either",
      );
    } finally {
      execFileSync("tmux", ["kill-session", "-t", `=${bkSession}`], { stdio: "ignore" });
    }
  });
});

describe("issue #27: `hive status` surfaces the held count, not just the pending count", () => {
  it("appends '(N held)' only when a pending wake is actually held right now", async () => {
    const project = seedProject();
    const statusTmp = scratchDirs().tmp;

    db.prepare(
      `INSERT INTO timers (project_id, owner, body, kind, watch, deliver_actor, deliver_pane,
         due_at, created_at)
       VALUES (?, 'user:test', 'wake body', 'delay', '[]', 'user:test', '%status-plain',
         datetime('now', '+60 seconds'), datetime('now'))`,
    ).run(project);

    const plain = await runCli(["status"], { cwd: projectDir, dataDir, tmp: statusTmp });
    assert.equal(plain.code, 0, plain.stderr);
    assert.match(
      plain.stdout,
      /pending wake-ups: 1$/m,
      "a plain, not-currently-held pending wake must not print a held annotation",
    );

    db.prepare(
      `INSERT INTO timers (project_id, owner, body, kind, watch, deliver_actor, deliver_pane,
         due_at, created_at, held_at, held_reason)
       VALUES (?, 'user:test', 'wake body', 'delay', '[]', 'user:test', '%status-held',
         datetime('now', '+60 seconds'), datetime('now'), datetime('now'), 'pane is awaiting a modal choice')`,
    ).run(project);

    const withHeld = await runCli(["status"], { cwd: projectDir, dataDir, tmp: statusTmp });
    assert.equal(withHeld.code, 0, withHeld.stderr);
    assert.match(
      withHeld.stdout,
      /pending wake-ups: 2 \(1 held\)$/m,
      "a currently-held pending wake must show up in the count `hive status` already prints",
    );
  });
});
