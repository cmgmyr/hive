import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { after, before, describe, it } from "node:test";

import { isolateTmux, McpClient, scratchDirs, until } from "./helpers.mjs";

// Issue #96. wake_get is a read-by-id (untruncated body, any state, still
// project-scoped like wake_list); wake_update reschedules or edits a pending
// wake WITHOUT minting a new id (owner-scoped like wake_cancel, pending-only
// via the same ACTIVE_TIMER_WHERE predicate pendingWakes() applies). Neither
// tool ever types into a pane - both are pure timers-row reads/writes - so
// most of this file needs no live tmux target at all. A handful of tests are
// the exception, individually marked with their own skip rather than the
// whole file: each needs a real pane so deliverable() lets a claim through,
// either driving the REAL running MCP server's own background scheduler (not
// a hand-called tick()), or calling tick() directly to prove wake_update
// landing WHILE a tick is already mid-flight cannot make a stale in-flight
// claim deliver old data - the CI review finding on PR #101, and the
// counselors round on that same fix that found due_at alone was not a
// sufficient guard. See claimOneShot's own comment in src/scheduler.ts for
// the full mechanism these race tests pin.

const { hasTmux, cleanup } = isolateTmux("the wake_get/wake_update tests");
const NEEDS_TMUX = { skip: hasTmux ? false : "tmux is not installed" };

const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { db } = await import("../dist/db.js");

const OWNER = "user:wake-update-owner";
const session = `hive-wake-get-update-${process.pid}`;
let livePane;
let mcp;
let projectId;

before(async () => {
  mcp = new McpClient({ cwd: dirs.projectDir, dataDir: dirs.dataDir, env: { HIVE_AGENT_ID: OWNER } });
  await mcp.start();
  projectId = (await mcp.call("whoami")).project.id;
  if (!hasTmux) return;
  execFileSync("tmux", ["new-session", "-d", "-s", session, "sleep 600"], { stdio: "ignore" });
  livePane = execFileSync("tmux", ["list-panes", "-t", `=${session}`, "-F", "#{pane_id}"], {
    encoding: "utf8",
  }).trim();
});

after(async () => {
  await mcp.close();
  cleanup(session);
});

// deliver_actor/deliver_pane are throwaway strings for every test but the
// last: neither wake_get nor wake_update ever reads them to deliver
// anything, so a pane no tmux server has ever issued is deliberate, not an
// oversight - it would make a test that accidentally exercised delivery fail
// loudly instead of quietly passing.
function seedTimer({
  owner = OWNER,
  body = "seeded wake",
  dueOffsetSeconds = 3600,
  repeatEveryMs = null,
  cancelled = false,
  fired = false,
  pane = "%nowhere",
  kind = "delay",
} = {}) {
  const sign = dueOffsetSeconds >= 0 ? "+" : "";
  // due_at only for a 'delay' wake, matching what wake_when_idle's own
  // INSERT does for idle_any/idle_all - never setting due_at at all, since
  // maybeFireIdle never reads it.
  return db
    .prepare(
      `INSERT INTO timers (project_id, owner, body, kind, watch, deliver_actor, deliver_pane,
         due_at, created_at, repeat_every_ms, cancelled_at, fired_at)
       VALUES (?, ?, ?, ?, '[]', 'user:test', ?,
         CASE WHEN ? = 'delay' THEN datetime('now', ?) ELSE NULL END,
         datetime('now', '-60 seconds'), ?,
         ${cancelled ? "datetime('now')" : "NULL"},
         ${fired ? "datetime('now', '-30 seconds')" : "NULL"})
       RETURNING id, due_at`,
    )
    .get(projectId, owner, body, kind, pane, kind, `${sign}${dueOffsetSeconds} seconds`, repeatEveryMs);
}

describe("wake_get / wake_update", () => {
  it("returns the untruncated body, while wake_list truncates the same row at 120 chars", async () => {
    const body = "B".repeat(200);
    const seeded = seedTimer({ body });

    const got = await mcp.call("wake_get", { wake_id: seeded.id });
    assert.equal(got.body, body, "wake_get must return the body in full, never truncated");
    assert.equal(got.wake_id, seeded.id);
    assert.equal(got.due_at, seeded.due_at);

    const list = await mcp.call("wake_list");
    const listed = list.wakes.find((w) => w.wake_id === seeded.id);
    assert.ok(listed, "the pending wake must still show up in wake_list");
    assert.equal(listed.body.length, 121, "wake_list truncates at 120 chars plus its ellipsis marker");
    assert.notEqual(listed.body, body, "wake_list's own body field must stay the truncated one");
  });

  it("is scoped to the current project; a wake in another project is not found", async () => {
    const otherProject = db
      .prepare("INSERT INTO projects (name, path) VALUES ('wake-get-other', ?) RETURNING id")
      .get(`${dirs.projectDir}-other`).id;
    const foreign = db
      .prepare(
        `INSERT INTO timers (project_id, owner, body, kind, watch, deliver_actor, deliver_pane,
           due_at, created_at)
         VALUES (?, ?, 'foreign project wake', 'delay', '[]', 'user:test', '%nowhere',
           datetime('now', '+3600 seconds'), datetime('now', '-60 seconds'))
         RETURNING id`,
      )
      .get(otherProject, OWNER).id;

    await assert.rejects(mcp.call("wake_get", { wake_id: foreign }), /not found in this project/);
  });

  it("reads a cancelled wake too - a lookup by id, not filtered by pending state the way wake_list is", async () => {
    const seeded = seedTimer({ cancelled: true });
    const got = await mcp.call("wake_get", { wake_id: seeded.id });
    assert.ok(got.cancelled_at, "a cancelled wake must still be readable, with its cancellation visible");
  });

  it("edits in place: the wake keeps its id, and no second row is created", async () => {
    const seeded = seedTimer();
    const before = db.prepare("SELECT COUNT(*) AS n FROM timers WHERE project_id = ?").get(projectId).n;

    const result = await mcp.call("wake_update", { wake_id: seeded.id, body: "edited body" });
    assert.equal(result.wake_id, seeded.id);
    assert.equal(result.updated, true);

    const afterCount = db.prepare("SELECT COUNT(*) AS n FROM timers WHERE project_id = ?").get(projectId).n;
    assert.equal(afterCount, before, "wake_update must edit the existing row, never insert a new one");
    assert.equal(db.prepare("SELECT body FROM timers WHERE id = ?").get(seeded.id).body, "edited body");
  });

  it("delay_seconds moves due_at relative to NOW, not relative to the wake's original due_at", async () => {
    // Seeded an hour out, so "relative to the original due_at" and "relative
    // to now" predict very different results if this were ever confused.
    const seeded = seedTimer({ dueOffsetSeconds: 3600 });
    const now = db.prepare("SELECT datetime('now') AS v").get().v;
    const expected = db.prepare("SELECT datetime(?, '+30 seconds') AS v").get(now).v;

    const result = await mcp.call("wake_update", { wake_id: seeded.id, delay_seconds: 30 });

    const toDate = (s) => new Date(`${s.replace(" ", "T")}Z`);
    const diffMs = Math.abs(toDate(result.due_at) - toDate(expected));
    assert.ok(
      diffMs < 3000,
      `due_at ${result.due_at} should land within a couple seconds of now+30s (${expected}), ` +
        "nowhere near the original due_at an hour out",
    );
  });

  it("a body-only update does not move due_at", async () => {
    const seeded = seedTimer({ dueOffsetSeconds: 3600 });
    const result = await mcp.call("wake_update", { wake_id: seeded.id, body: "only the body changed" });
    assert.equal(result.due_at, seeded.due_at, "due_at must be untouched when only body is edited");
    assert.equal(db.prepare("SELECT due_at FROM timers WHERE id = ?").get(seeded.id).due_at, seeded.due_at);
  });

  it("a repeat_every_seconds-only update does not move due_at either - the two fields are independent", async () => {
    const seeded = seedTimer({ dueOffsetSeconds: 3600, repeatEveryMs: 5000 });
    const result = await mcp.call("wake_update", { wake_id: seeded.id, repeat_every_seconds: 10 });
    assert.equal(result.due_at, seeded.due_at, "changing the interval alone must not move the next fire time");
    const row = db.prepare("SELECT due_at, repeat_every_ms FROM timers WHERE id = ?").get(seeded.id);
    assert.equal(row.due_at, seeded.due_at);
    assert.equal(row.repeat_every_ms, 10000, "the interval itself must still have changed");
  });

  it("refuses a cancelled wake", async () => {
    const seeded = seedTimer({ cancelled: true });
    const result = await mcp.call("wake_update", { wake_id: seeded.id, body: "should not apply" });
    assert.equal(result.updated, false);
    assert.notEqual(db.prepare("SELECT body FROM timers WHERE id = ?").get(seeded.id).body, "should not apply");
  });

  it("refuses an already-fired one-shot wake, but a repeating wake stays editable after firing once", async () => {
    const oneShot = seedTimer({ fired: true });
    const oneShotResult = await mcp.call("wake_update", { wake_id: oneShot.id, body: "too late" });
    assert.equal(oneShotResult.updated, false, "a fired one-shot has left pendingWakes() and must be refused");

    const repeating = seedTimer({ fired: true, repeatEveryMs: 5000, dueOffsetSeconds: 3600 });
    const repeatingResult = await mcp.call("wake_update", { wake_id: repeating.id, body: "still editable" });
    assert.equal(
      repeatingResult.updated,
      true,
      "ACTIVE_TIMER_WHERE keeps a repeating timer active after it has fired; wake_update must too",
    );
  });

  it("refuses another actor's wake", async () => {
    const seeded = seedTimer({ owner: "user:someone-else" });
    const result = await mcp.call("wake_update", { wake_id: seeded.id, body: "not yours" });
    assert.equal(result.updated, false);
    assert.notEqual(db.prepare("SELECT body FROM timers WHERE id = ?").get(seeded.id).body, "not yours");
  });

  it(
    "delay_seconds against another actor's idle wake, or a cancelled idle wake, falls through to the " +
      "plain updated: false every other miss already returns - not the kind-specific throw",
    async () => {
      const foreign = seedTimer({ kind: "idle_any", owner: "user:someone-else" });
      const foreignResult = await mcp.call("wake_update", { wake_id: foreign.id, delay_seconds: 60 });
      assert.equal(foreignResult.updated, false, "not yours, regardless of kind - same shape as a foreign delay wake");

      const cancelledIdle = seedTimer({ kind: "idle_all", cancelled: true });
      const cancelledResult = await mcp.call("wake_update", { wake_id: cancelledIdle.id, delay_seconds: 60 });
      assert.equal(cancelledResult.updated, false, "not pending, regardless of kind");
    },
  );

  it("throws when no field is given to change", async () => {
    const seeded = seedTimer();
    await assert.rejects(mcp.call("wake_update", { wake_id: seeded.id }), /at least one of/);
  });

  it(
    "refuses delay_seconds on an idle wake - due_at is not what maybeFireIdle reads for it",
    async () => {
      const seeded = seedTimer({ kind: "idle_any" });
      await assert.rejects(mcp.call("wake_update", { wake_id: seeded.id, delay_seconds: 60 }), /idle_any/);
      assert.equal(
        db.prepare("SELECT due_at FROM timers WHERE id = ?").get(seeded.id).due_at,
        null,
        "a refused update must not write a due_at nothing would ever read",
      );
    },
  );

  it(
    "refuses repeat_every_seconds on an idle wake - it would leave a permanently-pending wake that " +
      "can never fire again once ACTIVE_TIMER_WHERE keeps it 'active' past its own fired_at",
    async () => {
      const seeded = seedTimer({ kind: "idle_all" });
      await assert.rejects(
        mcp.call("wake_update", { wake_id: seeded.id, repeat_every_seconds: 30 }),
        /idle_all/,
      );
      assert.equal(
        db.prepare("SELECT repeat_every_ms FROM timers WHERE id = ?").get(seeded.id).repeat_every_ms,
        null,
      );
    },
  );

  it("still allows a body-only update on an idle wake", async () => {
    const seeded = seedTimer({ kind: "idle_any" });
    const result = await mcp.call("wake_update", { wake_id: seeded.id, body: "idle wake edited" });
    assert.equal(result.updated, true);
    assert.equal(db.prepare("SELECT body FROM timers WHERE id = ?").get(seeded.id).body, "idle wake edited");
  });

  // Shared by every mid-tick race test below. A: any due 'delay' wake on the
  // same live pane. Its real delivery (a genuine sendText, with tmux.ts's
  // real 300ms ENTER_DELAY_MS sleep before pressing Enter) is what gives
  // tick() its first true await point - everything before that (janitor,
  // the candidates SELECT, A's own deliverable()+claim, sendText's
  // synchronous tmux calls) runs in one synchronous stretch. B, already
  // read into this SAME tick's in-memory candidates array, has not been
  // touched yet when that await point is reached, so a wake_update call
  // landing there lands in exactly the window claimOneShot's full-state
  // guard has to defend.
  //
  // A is guaranteed to be read and claimed before B, not just usually:
  // tick()'s candidates query has no ORDER BY, but EXPLAIN QUERY PLAN shows
  // it scans idx_timers_active(project_id, kind) WHERE cancelled_at IS NULL
  // - a non-unique index, so SQLite ties break on rowid. A and B share this
  // test's project_id and kind ('delay'), so A (inserted first, lower id)
  // sorts before B deterministically.
  function seedRacePair(bOverrides = {}) {
    const a = seedTimer({ body: "filler wake A", dueOffsetSeconds: -5, pane: livePane });
    const b = seedTimer({ dueOffsetSeconds: -5, pane: livePane, ...bOverrides });
    return { a, b };
  }

  function assertFillerFired(aId) {
    const aRow = db.prepare("SELECT fired_at FROM timers WHERE id = ?").get(aId);
    assert.ok(aRow.fired_at, "sanity check: the filler wake must actually have fired, or nothing was raced");
  }

  it(
    "a wake_update landing WHILE a tick is already mid-flight cannot make a stale in-flight claim " +
      "deliver the old due_at (CI review finding on PR #101, claimOneShot's due_at guard)",
    NEEDS_TMUX,
    async () => {
      const { tick } = await import("../dist/scheduler.js");
      const { a, b } = seedRacePair({ body: "OLD body" });

      // Not awaited yet: everything up through A's sendText call happens
      // synchronously inside this expression, before this line returns.
      const tickPromise = tick();

      // The REAL wake_update tool, landing in exactly the window the CI
      // reviewer flagged: after B was already read as a candidate, before
      // its own claim. A local stdio round-trip to the MCP server is
      // microseconds to low milliseconds - comfortably inside A's real
      // 300ms sendText sleep, so this is deterministic, not a timing hope.
      const updateResult = await mcp.call("wake_update", { wake_id: b.id, delay_seconds: 3600 });
      assert.equal(updateResult.updated, true);

      await tickPromise;
      assertFillerFired(a.id);

      const bRow = db.prepare("SELECT fired_at, fire_count, due_at, body FROM timers WHERE id = ?").get(b.id);
      assert.equal(
        bRow.fired_at,
        null,
        "B's due_at changed underneath the in-flight claim; the guard must refuse it rather than " +
          "deliver the stale in-memory row",
      );
      assert.equal(bRow.fire_count, 0, "a refused claim must not advance fire_count either");
      assert.equal(
        bRow.due_at,
        updateResult.due_at,
        "the row must still carry wake_update's new due_at - a refused claim must not reset it",
      );
      assert.equal(bRow.body, "OLD body", "this test never changed the body; only the claim refusal is under test");
    },
  );

  it(
    "a body-only wake_update landing mid-tick is not silently overwritten by the stale in-memory body " +
      "(counselors round on #101, P1: due_at alone was not a sufficient guard)",
    NEEDS_TMUX,
    async () => {
      const { tick } = await import("../dist/scheduler.js");
      const { a, b } = seedRacePair({ body: "OLD body" });

      const tickPromise = tick();
      // due_at is deliberately untouched here - this is the exact case the
      // due_at-only guard missed: nothing about due_at changed, so a guard
      // scoped to due_at alone would still match and let the stale claim
      // through, delivering "OLD body" instead of refusing.
      const updateResult = await mcp.call("wake_update", { wake_id: b.id, body: "NEW body" });
      assert.equal(updateResult.updated, true);

      await tickPromise;
      assertFillerFired(a.id);

      const bRow = db.prepare("SELECT fired_at, fire_count, body FROM timers WHERE id = ?").get(b.id);
      assert.equal(
        bRow.fired_at,
        null,
        "the body changed underneath the in-flight claim; the full-state guard must refuse it even " +
          "though due_at never moved",
      );
      assert.equal(bRow.fire_count, 0);
      assert.equal(bRow.body, "NEW body", "the row must still carry wake_update's new body, untouched by the refusal");
    },
  );

  it(
    "converting a due one-shot into a repeating wake mid-tick does not fire it twice " +
      "(counselors round on #101, P1's 'worse case')",
    NEEDS_TMUX,
    async () => {
      const { tick } = await import("../dist/scheduler.js");
      // B starts a plain one-shot (repeatEveryMs default null) - this is the
      // specific shape P1 named worse than the body case: fireDelay's own
      // branch decision (timer.repeat_every_ms != null) is read from this
      // SAME stale in-memory row, BEFORE either claim runs, so an unguarded
      // fix could take the ONE-SHOT branch on stale data even after the row
      // became repeating underneath it.
      const { a, b } = seedRacePair({ body: "convert-me" });

      const tickPromise = tick();
      // repeat_every_seconds only, matching the pad's own "independent
      // fields" design - due_at is deliberately left alone, exactly the
      // update wake_update actually recommends for "start repeating this".
      const updateResult = await mcp.call("wake_update", { wake_id: b.id, repeat_every_seconds: 5 });
      assert.equal(updateResult.updated, true);

      await tickPromise;
      assertFillerFired(a.id);

      const afterFirstTick = db.prepare("SELECT fired_at, fire_count, due_at FROM timers WHERE id = ?").get(b.id);
      assert.equal(
        afterFirstTick.fired_at,
        null,
        "the stale one-shot branch's own claim must be refused once repeat_every_ms no longer matches " +
          "what this tick read - without this, fired_at gets set here while due_at (only the REPEATING " +
          "claim advances it) stays in the past, and the row becomes a candidate again on the very next tick",
      );
      assert.equal(afterFirstTick.fire_count, 0);
      assert.equal(afterFirstTick.due_at, b.due_at, "an untouched delay_seconds must leave due_at exactly as seeded");

      // The row is now genuinely, correctly repeating and still due. A
      // second, ordinary tick() - reading it fresh this time, no race - must
      // take the REPEATING branch and fire it exactly once, proving the
      // "fires a second time immediately" failure mode P1 described is
      // actually closed, not just deferred.
      await tick();
      const afterSecondTick = db.prepare("SELECT fired_at, fire_count, due_at FROM timers WHERE id = ?").get(b.id);
      assert.equal(afterSecondTick.fire_count, 1, "exactly one delivery total, never two");
      assert.ok(afterSecondTick.fired_at, "the second, unraced tick must claim it normally");
      const toDate = (s) => new Date(`${s.replace(" ", "T")}Z`);
      const advancedSeconds = (toDate(afterSecondTick.due_at) - toDate(afterSecondTick.fired_at)) / 1000;
      assert.ok(
        advancedSeconds >= 4 && advancedSeconds <= 7,
        `due_at should land ~5s after fired_at (the repeat_every_seconds: 5 from this test's own update) ` +
          `once it correctly takes the repeating branch, got ${advancedSeconds}s`,
      );
    },
  );

  it(
    "changing repeat_every_seconds changes the interval used for the NEXT firing only, without moving " +
      "the currently scheduled due_at - proven against the real running scheduler, not a hand-called tick()",
    NEEDS_TMUX,
    async () => {
      const seeded = seedTimer({
        body: "repeat interval wake",
        dueOffsetSeconds: 2,
        repeatEveryMs: 5000,
        pane: livePane,
      });

      const updated = await mcp.call("wake_update", { wake_id: seeded.id, repeat_every_seconds: 1 });
      assert.equal(
        updated.due_at,
        seeded.due_at,
        "the update must not move the fire time already scheduled for this cycle",
      );

      // The claim UPDATE in fireDelay() sets the NEXT due_at from
      // repeat_every_ms read off the row at claim time - so once the real
      // background scheduler (unmodified 3s tick) claims this cycle, the
      // resulting due_at must reflect the UPDATED 1s interval, not the
      // original 5s one.
      assert.ok(
        await until(() => db.prepare("SELECT fire_count FROM timers WHERE id = ?").get(seeded.id).fire_count >= 1, 15000),
        "the real scheduler must have fired this wake within its own tick cadence",
      );

      const row = db.prepare("SELECT due_at, fired_at FROM timers WHERE id = ?").get(seeded.id);
      const toDate = (s) => new Date(`${s.replace(" ", "T")}Z`);
      const advancedSeconds = (toDate(row.due_at) - toDate(row.fired_at)) / 1000;
      assert.ok(
        advancedSeconds >= 0.5 && advancedSeconds <= 3,
        `next due_at should land ~1s after fired_at (the UPDATED interval), got ${advancedSeconds}s - ` +
          "the stale 5s interval would fail this bound",
      );
    },
  );
});

// Issue #150. deliver() (src/scheduler.ts) types a wake's body verbatim into
// a pane via sendText, exactly as agent_send's text path does, so an
// unvalidated body is the identical text-becomes-keys breach one door over
// (.claude/rules/tmux-and-panes.md). No live pane needed here: the check
// runs before resolveDelivery and before the INSERT/UPDATE, so these tests
// never touch tmux.
describe("control bytes in a wake body (issue #150)", () => {
  it("wake_set refuses a body carrying a raw control byte, names it, and its offset", async () => {
    await assert.rejects(
      mcp.call("wake_set", { delay_seconds: 60, body: "helloworld" }),
      /BEL, 0x07.*at offset 5/,
    );
  });

  it("wake_set still accepts tab and newline - a wake body is multi-line prose", async () => {
    // This test session runs outside tmux, so wake_set still fails - but only
    // at delivery-target resolution, which runs AFTER body validation. That
    // proves a clean multi-line, tabbed body passed the control-byte check
    // rather than a passing assertion of convenience: a regression that
    // started rejecting tab or newline would fail here with a body-shaped
    // message instead of this one.
    await assert.rejects(
      mcp.call("wake_set", { delay_seconds: 60, body: "line one\nline two\twith a tab" }),
      /cannot receive wake-ups/,
    );
  });

  it("wake_set refuses CR specifically: it is the byte a literal Enter keypress sends", async () => {
    await assert.rejects(
      mcp.call("wake_set", { delay_seconds: 60, body: "part one\rpart two" }),
      /CR, 0x0D/,
    );
  });

  it("names agent_send(keys) as the remedy, not a way to keep the raw byte in a wake body", async () => {
    await assert.rejects(
      mcp.call("wake_set", { delay_seconds: 60, body: "bad byte" }),
      /agent_send\(keys/,
    );
  });

  it("nothing is inserted when wake_set refuses a bad body", async () => {
    const before = db.prepare("SELECT COUNT(*) AS n FROM timers WHERE project_id = ?").get(projectId).n;
    await assert.rejects(mcp.call("wake_set", { delay_seconds: 60, body: "bad byte" }));
    const after = db.prepare("SELECT COUNT(*) AS n FROM timers WHERE project_id = ?").get(projectId).n;
    assert.equal(after, before, "a refused body must never reach the INSERT");
  });

  it("wake_update refuses the same way, on the same field, and leaves the existing body untouched", async () => {
    const seeded = seedTimer({ body: "clean body" });
    await assert.rejects(
      mcp.call("wake_update", { wake_id: seeded.id, body: "onetwo" }),
      /ESC, 0x1B/,
    );
    assert.equal(
      db.prepare("SELECT body FROM timers WHERE id = ?").get(seeded.id).body,
      "clean body",
      "a refused update must not partially land",
    );
  });

  it("wake_when_idle refuses a control byte in its body before watching anything", async () => {
    await assert.rejects(
      mcp.call("wake_when_idle", { scope: "project", body: "status" }),
      /ETX \(Ctrl-C\), 0x03/,
    );
  });
});
