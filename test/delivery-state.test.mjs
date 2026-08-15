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

// Issue #27, L3 step 2. typed_at and held_at/held_reason are assertions about
// what the scheduler itself did, distinct from fired_at (the claim). The
// "held" half - a real dialog holding a wake, then delivering it once the
// dialog clears - is exercised in test/false-idle.test.mjs, which already
// owns the fixture-driven dialog pane and only needed the new columns added
// to its existing assertions. This file covers the two obligations that do
// not fit that fixture: a sendText that genuinely throws, and the repeating
// timer's separate claim path (the due_at UPDATE, not claimOneShot).

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
  // projects.path is UNIQUE; each test seeds its own project, so each call
  // needs a distinct path rather than reusing the suite's one projectDir.
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
  // TODO 386 NARROWED WHAT THIS PINS, so read the title as "a sendText whose
  // PASTE throws". A throw from the Enter - the second tmux call, 300ms later,
  // with the body already on the reader's screen - now DOES record typed_at,
  // deliberately: reading that as "nothing was delivered" is what made a
  // standing watch file the same worker's obituary twice
  // (test/notice-partial-send.test.mjs). This case still asserts NULL because
  // %999999 fails the paste itself, so nothing ever reached a pane.
  it("a sendText that throws leaves fired_at set and typed_at NULL", async () => {
    if (!hasTmux) return;
    const project = seedProject();
    // %999999 is the suite's convention for a pane id no tmux server has ever
    // issued (see paneAwaitingChoice's own null-on-unreadable test). The
    // snapshot below lies and calls it alive, so deliverable() proceeds past
    // liveness, capturePane's failure inside awaitingChoice() reads as
    // "unknown" (null) rather than "dialog", and delivery reaches sendText,
    // which then genuinely fails against a target tmux has never heard of -
    // the real failure this column exists to distinguish from a successful
    // delivery, not a mock standing in for one.
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

// Issue #75. deliver() reads deliver_actor's last agent_state_log row right
// before typing (src/scheduler.ts) and stamps 1/0/NULL. The discriminating
// claim of this lane is that a wake typed at a BUSY target is recorded
// differently from one typed at an IDLE target - a fixture where the target
// was only ever idle cannot prove anything this lane claims, so both are
// exercised here, plus the never-instrumented case.
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

// One case table rather than three near-identical `it`s: each row differs
// only in the seeded hook state (or its absence) and the expected column
// value, so the shared shape - seed, deliver, assert typed_at, assert
// typed_busy - is written once. A future fourth observed state is a one-line
// addition here instead of a fourth copy-pasted test.
// Counselors round 1, item E1. This table used to cover only working, idle
// and absent, while the code comment specifically claims to handle 'waiting'
// and the notify sentinel 'unchanged' a certain way (deliver(),
// src/scheduler.ts) - neither was pinned. After item C1's fix, 'waiting'
// counts as busy (a worker mid-turn on an approved tool, e.g. a long test
// run, latches 'waiting' for the whole run - worker-state.md); 'unchanged'
// (a notify that left the latch alone, typically Claude signalling it is
// genuinely free) stays not-busy alongside plain idle.
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

  // Counselors round 1, item E2. Every actor in TYPED_BUSY_CASES above is a
  // bare string with no `agents` row at all, so a regression that made
  // deliver() read agents.agent_state (the LATCH) instead of the log would
  // go red there for the WRONG reason - a missing row, not the lead-scoping
  // argument deliver()'s own comment makes. Pin the actual claim: a
  // kind='lead' row, whose agent_state stays 'unknown' forever by design
  // (src/hook.ts's UPDATE is scoped to kind = 'agent' - worker-state.md),
  // must still read typed_busy = 1 from a working LOG row - proving the read
  // goes through the log, not the latch that never updates for a lead.
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

  // Counselors A3's own discipline (above), applied to the new column: a
  // held-before-claim write for a LATER cycle must never leave an EARLIER
  // cycle's busy observation sitting on the row once the new cycle claims.
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

    // The actor goes idle before the next cycle fires.
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

// L3 step 3. Confirmation never touches tmux, so every test below drives
// tick() with an explicit empty snapshot rather than real panes: that keeps
// liveTargets() (real tmux) out of the loop entirely, exactly like the
// scheduler's own "control" fixture in test/scheduler.test.mjs. The timers
// here are seeded already-delivered (fired_at and typed_at both set), which
// puts them outside ACTIVE_TIMER_WHERE and out of the candidates loop, so
// nothing here can accidentally re-deliver anything.
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

// checkConfirmations() bounds its scan to typed_at >= now - LOG_RETENTION, so
// every timestamp below is relative to real "now" rather than a fixed date -
// a hardcoded past date would fall outside that window and never be
// considered at all, which would make every test in this describe pass
// vacuously.
const nowOffset = (sql) => db.prepare(`SELECT datetime('now', ?) AS v`).get(sql).v;

describe("issue #27: confirmation is read from agent_state_log, stamped once as a durable memo", () => {
  // Counselors A1. (actor, time) alone is a proxy: this used to seed an
  // arbitrary unrelated prompt row and assert it confirmed, which was the
  // defect wearing a green test - a payload lacking THIS wake's own
  // `[hive wake #<id>] ` marker must never confirm it, at or after typed_at
  // or not. The three inserts below isolate the two conditions that now both
  // have to hold: timing (rejected by the first, an early row) and
  // correlation (rejected by the second, a same-actor row that is in order
  // but carries no marker at all - the exact shape a background subagent's
  // task-notification or an unrelated wake's own prompt row has).
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

    // pruneStateLog deletes by a GLOBAL id span across every actor; simulate
    // that evicting this actor's own row out from under it, unrelated to
    // anything this timer did.
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

  // Counselors A5. The correlated UPDATE used to match every typed-but-
  // unconfirmed timer within the retention window, not just the ones it
  // could actually confirm, and wrote confirmed_at = NULL over an already-
  // NULL column for every one of them - a store write per tick per pending
  // timer per running MCP instance, on a table nothing ever prunes. Calls
  // checkConfirmations() directly (exported for exactly this) rather than
  // through tick(), so SQLite's changes() - which reflects only the most
  // recently completed write - counts precisely what the UPDATE touched,
  // undiluted by tick()'s other housekeeping writes (janitor, pruneStateLog,
  // maybeBackupHourly).
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

  // Drives a REAL delivery through the shared livePane, so typed_at here is
  // whatever deliver() itself actually writes - not a value this test hands
  // it. A prior version wrote typed_at with datetime('now'), whole seconds,
  // while agent_state_log.created_at carries milliseconds; checkConfirmations
  // compares them as an EXACT match, so a whole-second typed_at matched any
  // prompt row in the same wall second, including one up to 999ms before
  // hive had typed anything - a FALSE CONFIRMED. This is the test that
  // catches a regression back to that: seeding typed_at by hand (as every
  // other test in this describe does) cannot, because it would just encode
  // whatever precision this test chose to write, not what deliver() does.
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

    // Counselors A8. This used to floor UNCONDITIONALLY to typed_at's own
    // wall SECOND (`${typedAt.slice(0, 19)}.000`), which is 1-in-1000
    // self-flaky by construction: when typed_at's own millisecond component
    // happens to be exactly .000, `before` and `typedAt` become the
    // IDENTICAL string, `>=` matches, and this test goes red on entirely
    // correct code - test/CLAUDE.md's own lesson from two backupNow() calls
    // landing in the same millisecond.
    //
    // Force the gap instead of documenting the flake, without losing what
    // the unconditional version was actually for: if typed_at itself has NO
    // fractional part at all (the regression this test exists to catch -
    // typed_at written back with datetime('now')'s whole seconds), datePart
    // is the full string and appending ".000" makes `before` LEXICALLY
    // GREATER than typed_at ("...13" < "...13.000"), which is exactly what
    // must trip this assertion red. Only the narrow real-code case - typed_at
    // DOES carry milliseconds and they happen to be exactly "000" - needs a
    // different value, since ".000" of that same second would tie rather than
    // precede; step back a whole second there instead, still genuinely
    // earlier, never the ambiguous equal case.
    // Not insertStateLogRow (test/helpers.mjs): that helper places a row
    // N seconds before real "now", and this needs an exact absolute
    // timestamp derived from typed_at itself, which is not expressible as
    // an offset from "now".
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
    // Carries this wake's own marker (counselors A1) so the assertion below
    // pins TIMING specifically - without it, the row would fail to confirm
    // for the unrelated reason of lacking the marker, and this test would
    // stop meaning anything about the comparison it exists to check.
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

  // PR review gate, verified by the lead against the code. The plan's own
  // listed trap: "a repeating timer keeps working - it takes a different
  // claim path and it is the path most likely to be missed." The earlier
  // repeating-timer test above covers the CLAIM path (typed_at gets set on
  // every fire); this one covers the CONFIRMATION path, which the claim
  // path's own test never touched. "Positive-only, never cleared"
  // (checkConfirmations' own comment) is a promise about ONE delivery, not
  // about a row a repeating timer reuses across many.
  it("resets confirmed_at on every re-delivery of a repeating timer, not just its claim", async () => {
    if (!hasTmux) return;
    const project = seedProject();
    const actor = `agent:confirm-repeat-${project}`;
    // A very long interval: this test forces every fire itself (by moving
    // due_at into the past directly), and the interval only needs to be long
    // enough that the real repeat schedule could never coincidentally
    // trigger an extra fire during the rest of the test.
    const timerId = db
      .prepare(
        `INSERT INTO timers (project_id, owner, body, kind, watch, deliver_actor, deliver_pane,
           due_at, created_at, repeat_every_ms)
         VALUES (?, 'user:test', 'repeat confirm body', 'delay', '[]', ?, ?,
           datetime('now', '-1 seconds'), datetime('now', '-60 seconds'), 999999999)
         RETURNING id`,
      )
      .get(project, actor, livePane).id;

    // Fire 1.
    await tick();
    const fire1 = db.prepare("SELECT typed_at FROM timers WHERE id = ?").get(timerId);
    assert.ok(fire1.typed_at, "must have actually delivered fire 1 for this test to mean anything");

    // Confirm fire 1.
    insertStateLogRow(db, actor, "prompt", "working", 0, wakeConfirmPayload(timerId));
    await tick();
    const confirmed1 = db.prepare("SELECT confirmed_at FROM timers WHERE id = ?").get(timerId).confirmed_at;
    assert.notEqual(confirmed1, null, "fire 1 must be confirmed before this test can prove anything about later fires");

    // Counselors A3. Force fire 2 due now, AND point the claim at a pane
    // tmux has never issued, the same %999999 device the throwing-sendText
    // test above uses - a fake snapshot calls it alive, deliverable() and the
    // dialog check both proceed past it, and sendText then genuinely fails.
    // The old fix only reset these columns in deliver()'s post-send write,
    // which a throw never reaches, so fire 1's typed_at/confirmed_at would
    // otherwise still be sitting on this row after a cycle that was never
    // typed at all - reporting a delivery nobody made as confirmed.
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

    // Fire 3: restore a real pane and force due now. This must deliver
    // cleanly and record its OWN typed_at, unrelated to fire 1's.
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

    // The old confirming row from fire 1 is still sitting in agent_state_log,
    // dated before fire 3's typed_at. A tick with nothing new inserted must
    // not let it confirm fire 3.
    await tick();
    assert.equal(
      db.prepare("SELECT confirmed_at FROM timers WHERE id = ?").get(timerId).confirmed_at,
      null,
      "a stale prompt row from before this delivery must not confirm it",
    );

    // A fresh row, after fire 3's own typed_at, does confirm it.
    insertStateLogRow(db, actor, "prompt", "working", 0, wakeConfirmPayload(timerId));
    await tick();
    const confirmed3 = db.prepare("SELECT confirmed_at FROM timers WHERE id = ?").get(timerId).confirmed_at;
    assert.notEqual(confirmed3, null, "a fresh prompt row after fire 3's typed_at must confirm it");
    assert.notEqual(confirmed3, confirmed1, "fire 3's confirmation must be its own, not fire 1's stale value");
  });
});

describe("issue #27, counselors A4: the held_at write is guarded against a concurrent claim", () => {
  // The held write used to carry no guard at all (`WHERE id = ?`), so a
  // concurrent instance that claims and fully delivers this SAME repeating
  // timer between this tick reading its candidates and this tick reaching
  // the held-write can still have its stale held_at land on top of a row
  // that just delivered successfully. Reproduced in ONE process without two
  // real MCP server instances: a decoy one-shot ahead of the racy timer in
  // this tick's own candidate order buys a real ~300ms window (tmux.ts's
  // ENTER_DELAY_MS, inside sendText's paste-then-Enter sleep) for a
  // setTimeout to land a raw "concurrent claim" mutation on the racy timer's
  // row BEFORE this tick's loop ever reaches it - the identical shape
  // counselors A4 traced: "B works serially through candidates ahead of #42
  // ... reaching #42 at t≈0.9".
  it("does not hold a timer a concurrent instance already claimed and delivered", async () => {
    if (!hasTmux) return;
    const project = seedProject();
    const actor = `agent:held-race-${project}`;

    // Decoy: an ordinary one-shot, due now, delivered cleanly through the
    // shared livePane. Its real sendText sleep is the window this race needs.
    db.prepare(
      `INSERT INTO timers (project_id, owner, body, kind, watch, deliver_actor, deliver_pane,
         due_at, created_at)
       VALUES (?, 'user:test', 'decoy', 'delay', '[]', ?, ?,
         datetime('now', '-1 seconds'), datetime('now', '-60 seconds'))`,
    ).run(project, actor, livePane);

    // A dialog pane the racy timer targets - not the same session's shared
    // livePane, since that must stay clean for the decoy above.
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

    // Fires during the decoy's real sendText sleep, well before this tick's
    // loop reaches the racy timer - simulating a CONCURRENT instance's own
    // atomic claim (fireDelay's own due_at-guarded UPDATE, unaffected by this
    // change) succeeding and delivering it in between.
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

// deliverable()'s held_at write and deliver()'s typed_at write both went from
// "no side effect" to "a write that can throw" in the same commit. Several
// MCP server instances tick concurrently against one WAL store, so
// SQLITE_BUSY on either write is the ordinary case, not the exotic one, and
// before these writes existed nothing about the dialog check or a successful
// sendText could abort the rest of a tick's candidates. This test breaks
// those two writes (drops the columns they set, in a throwaway store nothing
// else here shares) and proves the failure costs only itself: the held timer
// is still correctly held, an already-typed wake still lands, and a later
// candidate in the same tick still gets processed. Run in its own process
// against its own store, never the shared `db` above, because the schema
// break must not leak into the tests that ran before it.
//
// Counselors round 1 (todo 209, item A). Issue #75 added a THIRD unguarded
// read to this same window: lastLogEvent(timer.deliver_actor), called
// between the claim and sendText, with no try/catch of its own at first -
// every other statement in deliver() is guarded on exactly the ground this
// describe block exists to prove, and this one was not. A throw there would
// have burned a one-shot delivery entirely: the claim already committed
// fired_at, so the row would report fired_at set and typed_at forever NULL,
// never retried. Guarded now (falls back to typed_busy = null, the same
// answer a genuinely absent hook row gets); DROP TABLE agent_state_log below
// forces that exact throw for both ALPHA and BETA, so if the guard ever
// regresses, this makes them stop delivering rather than merely reporting
// typed_busy wrong.
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
          // Break the two bookkeeping writes; claimOneShot (fired_at,
          // fire_count) and sendText itself never touch these columns.
          `db.exec("ALTER TABLE timers DROP COLUMN held_at");\n` +
          `db.exec("ALTER TABLE timers DROP COLUMN typed_at");\n` +
          // Item A. Everything lastLogEvent() (src/stateProvenance.ts) reads
          // is gone, forcing the exact throw its new try/catch in deliver()
          // exists to survive.
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

    // A project with nothing at all (no agents, todos, or wakes) prints
    // nothing in `hive status` - seed one plain, un-held pending wake first,
    // so the project's line actually appears and the baseline is a real
    // "1, no suffix" rather than an absent block this regex could match by
    // accident.
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
