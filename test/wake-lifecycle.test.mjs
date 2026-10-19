import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, it } from "node:test";

const wakeSql = await import("../dist/wakeSql.js");

const column = (name) => `(?:[A-Za-z_$][\\w$]*\\.)?${name}`;
const pendingOneShotCopy = new RegExp(
  `(?:${column("cancelled_at")}\\s+IS\\s+NULL\\s+AND\\s+${column("fired_at")}\\s+IS\\s+NULL|${column("fired_at")}\\s+IS\\s+NULL\\s+AND\\s+${column("cancelled_at")}\\s+IS\\s+NULL)`,
  "iu",
);

function fixture(overrides = {}) {
  return {
    cancelled_at: null,
    fired_at: null,
    repeat_every_ms: null,
    held_at: null,
    kind: "delay",
    due_at: "2000-01-01 00:00:00",
    fire_count: 0,
    delivery_method: null,
    confirmed_at: null,
    typed_at: null,
    socket_attempt_at: null,
    socket_delivery_note: null,
    max_wait_at: null,
    typed_busy: 0,
    ...overrides,
  };
}

function evaluate(expression, row, params = []) {
  const db = new Database(":memory:");
  const keys = Object.keys(row);
  db.exec(`CREATE TABLE wakes (${keys.map((key) => `"${key}"`).join(", ")})`);
  const columns = keys.map((key) => `"${key}"`).join(", ");
  const placeholders = keys.map(() => "?").join(", ");
  db.prepare(`INSERT INTO wakes (${columns}) VALUES (${placeholders})`).run(...Object.values(row));
  const result = db.prepare(`SELECT (${expression}) AS result FROM wakes w`).get(...params).result;
  db.close();
  return result;
}

describe("wake lifecycle vocabulary", () => {
  it("wake lifecycle predicates match the explicit state matrix", () => {
    const cases = [
      { name: "cancelled unfired", row: fixture({ cancelled_at: "2026-01-01" }), active: 0, pending: 0, fired: 0, held: 0, candidate: 0 },
      { name: "ordinary pending", row: fixture(), active: 1, pending: 1, fired: 0, held: 0, candidate: 1 },
      { name: "held pending", row: fixture({ held_at: "2026-01-01" }), active: 1, pending: 1, fired: 0, held: 1, candidate: 1 },
      { name: "future delay", row: fixture({ due_at: "2999-01-01 00:00:00" }), active: 1, pending: 1, fired: 0, held: 0, candidate: 0 },
      { name: "unfired idle watch", row: fixture({ kind: "idle", due_at: null }), active: 1, pending: 1, fired: 0, held: 0, candidate: 1 },
      { name: "fired one-shot never pasted", row: fixture({ fired_at: "2026-01-01" }), active: 0, pending: 0, fired: 1, held: 0, candidate: 0 },
      { name: "pasted unconfirmed", row: fixture({ fired_at: "2026-01-01", typed_at: "2026-01-01" }), active: 0, pending: 0, fired: 1, held: 0, candidate: 0 },
      { name: "posted one-shot socket", row: fixture({ fired_at: "2026-01-01", socket_attempt_at: "2026-01-01", delivery_method: "socket" }), active: 0, pending: 0, fired: 1, held: 0, candidate: 0 },
      { name: "active standing watch", row: fixture({ kind: "idle", due_at: null, max_wait_at: "2999-01-01 00:00:00" }), active: 1, pending: 1, fired: 0, held: 0, candidate: 1 },
      { name: "expired standing watch", row: fixture({ kind: "idle", due_at: null, max_wait_at: "2000-01-01 00:00:00" }), active: 1, pending: 1, fired: 0, held: 0, candidate: 1 },
    ];

    for (const testCase of cases) {
      const prefix = "w.";
      const actual = {
        active: evaluate(wakeSql.activeWakeWhere(prefix), testCase.row),
        pending: evaluate(wakeSql.pendingOneShotWhere(prefix), testCase.row),
        fired: evaluate(wakeSql.firedOneShotWhere(prefix), testCase.row),
        held: evaluate(wakeSql.heldWakeWhere(prefix), testCase.row),
        candidate: evaluate(wakeSql.schedulerCandidateWhere(prefix), testCase.row),
      };
      assert.deepEqual(actual, {
        active: testCase.active,
        pending: testCase.pending,
        fired: testCase.fired,
        held: testCase.held,
        candidate: testCase.candidate,
      }, testCase.name);
    }

    assert.equal(wakeSql.sentWakeAtSql("w."), "COALESCE(w.socket_attempt_at, w.typed_at)");
    assert.equal(evaluate(wakeSql.watchWatchingWhere("w."), fixture({ kind: "idle", max_wait_at: null })), 1);
    assert.equal(evaluate(wakeSql.watchWatchingWhere("w."), fixture({ kind: "idle", fired_at: "2026-01-01" })), 0);
  });

  it("socket lifecycle predicates keep confirmation, firing, fallback, and retention distinct", () => {
    const currentSocket = fixture({
      fired_at: "2026-10-19 12:00:00",
      repeat_every_ms: 60_000,
      delivery_method: wakeSql.DELIVERY_METHOD.socketRepeating,
      socket_attempt_at: "2026-10-19 12:00:00",
    });
    const staleSocket = { ...currentSocket, fired_at: "2026-10-19 12:01:00" };
    const claimedFallback = {
      ...currentSocket,
      delivery_method: wakeSql.DELIVERY_METHOD.ptyAfterSocketTimeout,
      socket_delivery_note: "retrying",
    };
    const droppedFallback = { ...claimedFallback, socket_delivery_note: wakeSql.FIRING_DROPPED_NOTE };

    assert.equal(evaluate(wakeSql.socketAwaitingWhere("w."), fixture({
      fired_at: "2026-10-19 12:00:00", delivery_method: wakeSql.DELIVERY_METHOD.socket,
      socket_attempt_at: "2026-10-19 12:00:00",
    })), 1);
    assert.equal(evaluate(wakeSql.currentAttempt("w."), currentSocket), 1);
    assert.equal(evaluate(wakeSql.currentAttempt("w."), staleSocket), 0);
    assert.equal(evaluate(wakeSql.repeatingSocketAwaitingWhere("w."), currentSocket), 1);
    assert.equal(evaluate(wakeSql.repeatingSocketAwaitingWhere("w."), staleSocket), 0);
    assert.equal(evaluate(wakeSql.repeatingFallbackClaimedWhere("w."), claimedFallback), 1);
    assert.equal(evaluate(wakeSql.repeatingFallbackClaimedWhere("w."), droppedFallback), 0);
    assert.equal(evaluate(wakeSql.repeatingFiringPendingWhere("w."), currentSocket), 1);
    assert.equal(evaluate(wakeSql.repeatingFiringPendingWhere("w."), {
      ...currentSocket, socket_attempt_at: "2000-01-01 00:00:00",
    }), 0);
    assert.equal(evaluate(wakeSql.repeatingSocketFiringWhere("w."), claimedFallback), 1);
    assert.equal(evaluate(wakeSql.spentUntypedNotice("w"), fixture({
      fired_at: "2000-01-01 00:00:00",
    })), 1);
    assert.equal(evaluate(wakeSql.spentUntypedNotice("w"), fixture({
      fired_at: "2000-01-01 00:00:00", typed_at: "2000-01-01 00:00:01",
    })), 0);

    const held = fixture({ fired_at: "2026-10-19 11:00:00", repeat_every_ms: 60_000, due_at: "2026-10-19 12:00:00", fire_count: 4 });
    assert.equal(evaluate(wakeSql.holdableWakeWhere("w."), held, [held.due_at, 4, 4]), 1);
    assert.equal(evaluate(wakeSql.holdableWakeWhere("w."), held, [held.due_at, 3, 3]), null);
    assert.equal(evaluate(wakeSql.handoffSocketInFlightWhere("w."), fixture({
      fired_at: "2026-10-19 12:00:00", delivery_method: "socket-legacy",
      socket_attempt_at: "2026-10-19 12:00:00",
    }), ["-7 days"]), 1);
    assert.equal(evaluate(wakeSql.handoffSocketInFlightWhere("w."), fixture({
      fired_at: "2026-10-19 12:00:00", delivery_method: "socket-legacy",
      socket_attempt_at: "2000-01-01 00:00:00",
    }), ["-7 days"]), 0);

    const confirmation = (row, hasChannel) => wakeSql.wakeConfirmation(row, hasChannel);
    assert.equal(confirmation(fixture(), true), null);
    assert.equal(confirmation(fixture({ typed_at: "2026-10-19 12:00:00" }), true), "unconfirmed");
    assert.equal(confirmation(fixture({ socket_attempt_at: "2026-10-19 12:00:00", typed_busy: 1 }), true), "unconfirmed_busy");
    assert.equal(confirmation(fixture({ socket_attempt_at: "2026-10-19 12:00:00" }), false), "no_confirmation_channel");
    assert.equal(confirmation(fixture({ typed_at: "2026-10-19 12:00:00", confirmed_at: "2026-10-19 12:00:01" }), false), "confirmed");
    assert.equal(confirmation(fixture({ confirmed_at: "2026-10-19 12:00:01" }), false), null);
  });

  it("hold vocabulary preserves persisted bytes and matching modes", () => {
    assert.deepEqual(wakeSql.DELIVERY_METHOD, {
      socket: "socket",
      socketRepeating: "socket-repeating",
      pty: "pty",
      ptyAfterSocketTimeout: "pty-after-socket-timeout",
    });
    assert.equal(wakeSql.LOG_RETENTION, "-7 days");
    assert.equal(wakeSql.NOTICE_RETRY_AFTER, "-60 seconds");
    assert.equal(wakeSql.FIRING_DROPPED_NOTE, "dropped");

    assert.equal(wakeSql.HELD_REASON_MODAL_CHOICE, "pane is awaiting a modal choice (folder-trust or /model picker)");
    assert.equal(wakeSql.HELD_REASON_LEAD_BOOT_INPUT_BOX, "the lead's input box is not on screen yet; holding while its session starts");
    assert.equal(wakeSql.HELD_REASON_LEAD_PANE_DEAD,
      "the lead's pane is not live right now (likely mid-restart); lead-owned wakes are exempt from cancellation for this alone, so it is held rather than lost");
    assert.equal(wakeSql.HELD_REASON_PANE_REISSUED_PREFIX,
      "the pane id recorded for this wake now belongs to a different pane than the one it was set against (its pid no longer matches, most likely a tmux server restart reissuing the id); held rather than typed into the wrong pane - ");
    assert.equal(wakeSql.HELD_REASON_PANE_REISSUED_LEAD,
      "the pane id recorded for this wake now belongs to a different pane than the one it was set against (its pid no longer matches, most likely a tmux server restart reissuing the id); held rather than typed into the wrong pane - run `hive lead` to re-point it at the live one");
    assert.equal(wakeSql.HELD_REASON_PANE_REISSUED_WORKER,
      "the pane id recorded for this wake now belongs to a different pane than the one it was set against (its pid no longer matches, most likely a tmux server restart reissuing the id); held rather than typed into the wrong pane - nothing re-points a worker's wake automatically, so cancel it with wake_cancel and set a fresh one once the worker's pane is confirmed live, or leave it: it will keep holding rather than deliver wrongly");
    assert.equal(wakeSql.HELD_REASON_PANE_REISSUED_THEN_DEAD,
      "the pane id recorded for this wake now belongs to a different pane than the one it was set against (its pid no longer matches, most likely a tmux server restart reissuing the id); held rather than typed into the wrong pane - the pane it was reissued to has since gone dead too; nothing re-points a worker's wake automatically, so cancel it with wake_cancel (any running lead may do this even though the wake is not theirs) if it is no longer needed");
    assert.equal(wakeSql.HELD_REASON_PANE_UNKNOWN_PREFIX,
      "pane ownership for this wake's row cannot be verified (no pane pid was recorded for it, its row now records a different pane, or the pane is on another tmux socket); held rather than typed into a pane that may not be its own - ");
    assert.equal(wakeSql.HELD_REASON_PANE_UNKNOWN_LEAD,
      "pane ownership for this wake's row cannot be verified (no pane pid was recorded for it, its row now records a different pane, or the pane is on another tmux socket); held rather than typed into a pane that may not be its own - run `hive lead` to start or adopt a lead with a recorded pane and re-point it");
    assert.equal(wakeSql.HELD_REASON_PANE_UNKNOWN_WORKER,
      "pane ownership for this wake's row cannot be verified (no pane pid was recorded for it, its row now records a different pane, or the pane is on another tmux socket); held rather than typed into a pane that may not be its own - nothing re-points a worker's wake automatically, so cancel it with wake_cancel (any running lead may, even though the wake is not theirs), or leave it: it keeps holding rather than deliver wrongly");
    assert.equal(wakeSql.HELD_REASON_PANE_UNKNOWN_THEN_DEAD,
      "pane ownership for this wake's row cannot be verified (no pane pid was recorded for it, its row now records a different pane, or the pane is on another tmux socket); held rather than typed into a pane that may not be its own - that pane has since gone dead too; nothing re-points a worker's wake automatically, so cancel it with wake_cancel (any running lead may) if it is no longer needed");
    assert.equal(wakeSql.HELD_REASON_ACTOR_CLOSED,
      "delivery actor closed: the row this wake was bound to is closed, so nothing was typed and the wake was cancelled rather than delivered into a pane that row no longer owns");
    assert.equal(wakeSql.HELD_REASON_LEAD_ROW_CLOSED,
      "the lead's row is closed, so no pane is this wake's to type into; held until `hive lead` starts or adopts a lead and re-points it");
    assert.equal(wakeSql.HELD_REASON_OWNERSHIP_LOST_AFTER_CLAIM, "delivery stopped after claim: ");
    assert.equal(wakeSql.HELD_REASON_UNCLASSIFIABLE_PANE_PREFIX, "the pane's harness is not one hive can classify; ");
    assert.equal(wakeSql.HELD_REASON_UNCLASSIFIABLE_PANE,
      "the pane's harness is not one hive can classify; neither the dialog guard nor the unsubmitted-text guard can read this screen and delivery would type blind. wake_set and wake_when_idle refuse such a target outright now, so this wake predates that or its pane's command changed underneath it. Nothing hive does on its own clears this: it lifts only when that pane is replaced by one hive starts itself (`hive lead` after the pane exits). Cancel it with wake_cancel (any running lead may, even though the wake is not theirs) and drive that pane with agent_send(keys: [...])");
    assert.equal(wakeSql.HELD_REASON_COPY_MODE,
      "the pane is in tmux copy mode; tmux clears its bracketed-paste flag there, so the body would arrive with no paste markers (losing everything before the last 1022-byte write) and the Enter would be eaten by the mode instead of submitting - both silently, with tmux reporting success. It delivers once whoever is reading that pane leaves copy mode");
    assert.equal(wakeSql.HELD_REASON_UNSUBMITTED_INPUT_PREFIX, "the pane's input box has unsubmitted human text; ");
    assert.equal(wakeSql.HELD_REASON_UNSUBMITTED_INPUT,
      "the pane's input box has unsubmitted human text; delivering now would paste the wake body onto it and submit both as one message");
    assert.equal(wakeSql.HELD_REASON_UNSUBMITTED_INPUT_OWNER_UNRESOLVED,
      "the pane's input box has unsubmitted human text; hive could not resolve a live pane for the wake's owner on this tick - retrying, since that may be transient rather than permanent");
    assert.equal(wakeSql.HELD_REASON_CONVERSATION,
      "a human talked to this lead more recently than the conversation-hold window; holding so a wake does not split an in-progress discussion - it delivers once the window passes or the hold's own ceiling is reached, whichever comes first");
    assert.equal(wakeSql.HELD_REASON_HANDOFF,
      "the lead is handing off to a fresh session; held through the wind-down and the successor's boot, and delivered to the lead row once the successor completes its first turn, or when the handoff fails or releases its hold");

    assert.equal(wakeSql.wasHeldForPaneReissue(`${wakeSql.HELD_REASON_PANE_REISSUED_PREFIX}anything`), true);
    assert.equal(wakeSql.wasHeldForPaneReissue(wakeSql.HELD_REASON_PANE_REISSUED_PREFIX.slice(1)), false);
    assert.equal(wakeSql.wasHeldForPaneIdentity(`${wakeSql.HELD_REASON_PANE_UNKNOWN_PREFIX}anything`), true);
    assert.equal(wakeSql.isUnsubmittedInputHold(`${wakeSql.HELD_REASON_UNSUBMITTED_INPUT_PREFIX}retrying`), true);
    assert.equal(wakeSql.isLeadRowClosedHold(wakeSql.HELD_REASON_LEAD_ROW_CLOSED), true);
    assert.equal(wakeSql.isUnclassifiablePaneHold(`${wakeSql.HELD_REASON_UNCLASSIFIABLE_PANE_PREFIX}detail`), true);
  });

  it("finishedIdle and SQL agree across worker states and resume latches", async () => {
    const firstPrompt = await import("../dist/firstPrompt.js");
    const rows = [
      { agent_state: "idle", resumed_at: "" },
      { agent_state: "idle", resumed_at: "2026-01-01" },
      { agent_state: "working", resumed_at: "" },
      { agent_state: "waiting", resumed_at: "" },
      { agent_state: "unknown", resumed_at: "" },
    ];
    const expected = [true, false, false, false, false];
    rows.forEach((row, index) => {
      const sqlResult = evaluate(firstPrompt.finishedIdleSql("w"), fixture(row));
      assert.equal(firstPrompt.finishedIdle(row), expected[index], JSON.stringify(row));
      assert.equal(Boolean(sqlResult), expected[index], JSON.stringify(row));
    });
    assert.equal(firstPrompt.finishedIdle({ agent_state: "idle", resumed_at: 1 }), true);
  });

  it("wake lifecycle vocabulary has one source owner", () => {
    const root = fileURLToPath(new URL("../src/", import.meta.url));
    const files = [];
    const walk = (dir) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (name.endsWith(".ts")) files.push(path);
      }
    };
    walk(root);
    const sources = new Map(files.map((path) => [path, readFileSync(path, "utf8")]));
    const declarations = new Map();
    const record = (name, path) => declarations.set(name, [...(declarations.get(name) ?? []), path]);
    const helpers = [
      "activeWakeWhere", "pendingOneShotWhere", "firedOneShotWhere", "heldWakeWhere", "sentWakeAtSql",
      "schedulerCandidateWhere", "socketAwaitingWhere", "currentAttempt", "repeatingSocketAwaitingWhere",
      "repeatingFallbackClaimedWhere", "repeatingFiringPendingWhere", "repeatingSocketFiringWhere",
      "spentUntypedNotice", "watchWatchingWhere", "handoffSocketInFlightWhere", "holdableWakeWhere", "wakeConfirmation",
    ];
    for (const [path, source] of sources) {
      if (path !== join(root, "wakeSql.ts")) {
        const duplicate = pendingOneShotCopy.exec(source);
        assert.equal(duplicate, null, `${path}: copied pending-one-shot predicate ${duplicate?.[0] ?? ""}`);
      }
      for (const name of ["DELIVERY_METHOD", "ACTIVE_TIMER_WHERE", "LOG_RETENTION", "NOTICE_RETRY_AFTER", "FIRING_DROPPED_NOTE", ...helpers]) {
        if (new RegExp(`(?:const|let|var|function) ${name}\\s*(?:=|\\()`, "u").test(source)) {
          record(name, path);
        }
      }
      for (const match of source.matchAll(/(?:export\s+)?const\s+(HELD_REASON_(?!LABELS\b)[A-Z_]+)\s*=/gu)) record(match[1], path);
    }
    for (const [name, owners] of declarations) {
      assert.deepEqual(owners, [join(root, "wakeSql.ts")], `${name} owners`);
    }
    assert.equal(declarations.size, helpers.length + 5 + [...sources.values()].reduce((n, source) =>
      n + [...source.matchAll(/(?:export\s+)?const\s+HELD_REASON_(?!LABELS\b)[A-Z_]+\s*=/gu)].length, 0));
  });

  it("wake and first-prompt vocabulary imports have no runtime effects", async () => {
    const { spawnSync } = await import("node:child_process");
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
      const before = process.env.HIVE_DATA_DIR;
      await import(${JSON.stringify(new URL("../dist/wakeSql.js", import.meta.url).href)});
      await import(${JSON.stringify(new URL("../dist/firstPrompt.js", import.meta.url).href)});
      if (process.env.HIVE_DATA_DIR !== before) process.exit(2);
      if (Object.keys(process._getActiveHandles()).length !== 0) process.exit(3);
    `], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  });
});
