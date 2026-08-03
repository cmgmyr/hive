import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { McpClient, isolateTmux, runCli, scratchDirs } from "./helpers.mjs";

// hive status/statusline below run through runCli, which spawns hive and
// probes tmux; isolate first (see helpers.mjs).
const { cleanup: cleanupTmux } = isolateTmux("the todo_archive tests");
after(() => cleanupTmux());

const dirs = scratchDirs();
let mcp;

before(async () => {
  mcp = new McpClient({ cwd: dirs.projectDir, dataDir: dirs.dataDir });
  await mcp.start();
});

after(async () => {
  await mcp.close();
});

describe("todo_archive", () => {
  it("excludes an archived todo from todo_list by default, and include_archived brings it back", async () => {
    const a = (await mcp.call("todo_create", { title: "archive me" })).todo_id;
    // Positive control (counselors round on #15): without an active todo in
    // the same call, a default query that returns NOTHING would still pass
    // the "archived target is absent" assertion below.
    const active = (await mcp.call("todo_create", { title: "stays active" })).todo_id;
    const receipt = await mcp.call("todo_archive", { todo_id: a });
    assert.equal(receipt.archived, true);
    assert.equal(receipt.todo_id, a);

    // Assert over what todo_list actually RETURNS, not just the receipt
    // (test/CLAUDE.md): a filter bug that returns the right count from the
    // wrong query would still pass a length-only assertion.
    const defaultList = await mcp.call("todo_list", {});
    assert.ok(
      !defaultList.todos.some((t) => t.todo_id === a),
      "an archived todo must not appear in the default todo_list",
    );
    assert.ok(
      defaultList.todos.some((t) => t.todo_id === active),
      "an active todo must still appear in the default todo_list",
    );

    const withArchived = await mcp.call("todo_list", { include_archived: true });
    const found = withArchived.todos.find((t) => t.todo_id === a);
    assert.ok(found, "include_archived=true must still return the archived todo");
    assert.equal(found.archived, true);
  });

  it("todo_get always reaches an archived todo and its comments, by id, including comments added after archiving", async () => {
    const a = (await mcp.call("todo_create", { title: "archived but readable" })).todo_id;
    await mcp.call("todo_comment", { todo_id: a, body: "handoff note before archiving" });
    await mcp.call("todo_archive", { todo_id: a });
    // Counselors round on #15: the original test only covered a comment
    // written BEFORE archiving. Comments are the whole reason this is
    // archive and not delete, so continued access afterward is the part
    // that actually matters.
    await mcp.call("todo_comment", { todo_id: a, body: "a note added after archiving" });

    const detail = await mcp.call("todo_get", { todo_id: a, include_comments: true });
    assert.equal(detail.todo_id, a);
    assert.equal(detail.archived, true);
    assert.ok(detail.comments.some((c) => c.body === "handoff note before archiving"));
    assert.ok(detail.comments.some((c) => c.body === "a note added after archiving"));
  });

  it("is reversible through the same tool, archived=false - verified against the store at each step", async () => {
    const a = (await mcp.call("todo_create", { title: "round trip" })).todo_id;
    await mcp.call("todo_archive", { todo_id: a });
    // Counselors round on #15: without this intermediate check, two
    // fabricated no-op receipts (never actually writing archived_at either
    // time) would still pass - the todo was never removed, so it is still
    // there to be "found again" at the end regardless of whether archiving
    // ever really happened.
    const archivedList = await mcp.call("todo_list", {});
    assert.ok(
      !archivedList.todos.some((t) => t.todo_id === a),
      "must actually be archived before the reversal is a meaningful test",
    );

    const unarchived = await mcp.call("todo_archive", { todo_id: a, archived: false });
    assert.equal(unarchived.archived, false);

    const defaultList = await mcp.call("todo_list", {});
    assert.ok(defaultList.todos.some((t) => t.todo_id === a));
  });

  it("archiving an already-archived todo is a no-op, verified against the store, not just the receipt", async () => {
    const a = (await mcp.call("todo_create", { title: "double archive" })).todo_id;
    const first = await mcp.call("todo_archive", { todo_id: a });
    assert.equal(first.archived, true);
    // Counselors round on #15: the original test inspected only the two
    // receipts, which pass even if todo_archive never writes to the store
    // at all. Confirm via an independent read (todo_get) after each call.
    assert.equal((await mcp.call("todo_get", { todo_id: a })).archived, true);

    const second = await mcp.call("todo_archive", { todo_id: a });
    assert.equal(second.archived, true);
    assert.equal(second.todo_id, a);
    assert.equal((await mcp.call("todo_get", { todo_id: a })).archived, true);

    // Exactly one archived row for this id: not zero (never written) and
    // not toggled back to active by the second, supposedly-no-op call.
    const list = await mcp.call("todo_list", { include_archived: true });
    const matches = list.todos.filter((t) => t.todo_id === a);
    assert.equal(matches.length, 1);
    assert.equal(matches[0].archived, true);
  });

  it("unarchiving an already-active todo is a no-op too, verified against the store", async () => {
    const a = (await mcp.call("todo_create", { title: "never archived" })).todo_id;
    const receipt = await mcp.call("todo_archive", { todo_id: a, archived: false });
    assert.equal(receipt.archived, false);
    assert.equal((await mcp.call("todo_get", { todo_id: a })).archived, false);
    // Still visible in the default (active-only) list - a todo silently
    // archived anyway despite the archived=false receipt would fail this.
    const list = await mcp.call("todo_list", {});
    assert.ok(list.todos.some((t) => t.todo_id === a));
  });

  it("refuses to archive a todo that still blocks a non-completed todo, naming it and only it", async () => {
    const blocker = (await mcp.call("todo_create", { title: "live blocker" })).todo_id;
    const blocked = (
      await mcp.call("todo_create", { title: "waiting on it", blocked_by: [blocker] })
    ).todo_id;
    // Negative control (counselors round on #15): an unrelated non-completed
    // todo, no blocking edge at all. Without this, a refusal that fires
    // whenever ANY non-completed todo exists anywhere in the project - not
    // specifically a dependent of this one - would still pass.
    const unrelated = (await mcp.call("todo_create", { title: "nothing to do with it" })).todo_id;

    await assert.rejects(mcp.call("todo_archive", { todo_id: blocker }), (err) => {
      assert.match(err.message, new RegExp(`\\b${blocked}\\b`));
      assert.doesNotMatch(err.message, new RegExp(`\\b${unrelated}\\b`));
      return true;
    });

    // The refusal must not have half-applied anything: still active.
    const stillListed = await mcp.call("todo_list", {});
    assert.ok(stillListed.todos.some((t) => t.todo_id === blocker));
  });

  it("names every dependent todo when a blocker blocks more than one", async () => {
    const blocker = (await mcp.call("todo_create", { title: "shared blocker" })).todo_id;
    const first = (
      await mcp.call("todo_create", { title: "dependent one", blocked_by: [blocker] })
    ).todo_id;
    const second = (
      await mcp.call("todo_create", { title: "dependent two", blocked_by: [blocker] })
    ).todo_id;

    await assert.rejects(mcp.call("todo_archive", { todo_id: blocker }), (err) => {
      assert.match(err.message, new RegExp(`\\b${first}\\b`));
      assert.match(err.message, new RegExp(`\\b${second}\\b`));
      return true;
    });
  });

  it("allows archiving a blocker once the dependent is completed, verified against the store", async () => {
    const blocker = (await mcp.call("todo_create", { title: "blocker to complete-first" })).todo_id;
    const blocked = (
      await mcp.call("todo_create", { title: "will be completed", blocked_by: [blocker] })
    ).todo_id;
    await mcp.call("todo_complete", { todo_id: blocked });

    const receipt = await mcp.call("todo_archive", { todo_id: blocker });
    assert.equal(receipt.archived, true);
    // Counselors round on #15: the original test stopped at the receipt,
    // which passes even if todo_archive reports success without writing.
    assert.equal((await mcp.call("todo_get", { todo_id: blocker })).archived, true);
    const list = await mcp.call("todo_list", {});
    assert.ok(!list.todos.some((t) => t.todo_id === blocker));
  });

  it("allows archiving a blocker that is itself completed, even while its dependent is still open", async () => {
    // The pad's "unless this todo is itself already completed" clause: a
    // completed blocker already contributes nothing to the dependent's
    // open_blockers (OPEN_BLOCKERS_SQL filters on the blocker's own status),
    // so archiving it must be allowed unconditionally - this is the ordinary
    // lane-teardown case the feature exists for.
    const blocker = (await mcp.call("todo_create", { title: "blocker that finishes" })).todo_id;
    const blocked = (
      await mcp.call("todo_create", { title: "still open dependent", blocked_by: [blocker] })
    ).todo_id;
    await mcp.call("todo_complete", { todo_id: blocker });

    const receipt = await mcp.call("todo_archive", { todo_id: blocker });
    assert.equal(receipt.archived, true);
    // Counselors round on #15, the sharpest of the discrimination gaps: the
    // original test checked the dependent's status but never is_blocked or
    // open_blockers - the actual premise this whole rule rests on. A
    // completed blocker not being an OPEN blocker is the claim; checking
    // only `status: "open"` on the dependent does not verify it.
    const dependent = await mcp.call("todo_get", { todo_id: blocked });
    assert.equal(dependent.status, "open");
    assert.equal(dependent.is_blocked, false, "a completed blocker must not count as an open blocker");
    assert.equal(dependent.open_blockers, 0);
    assert.equal((await mcp.call("todo_get", { todo_id: blocker })).archived, true);
  });

  it("does not refuse archiving a todo that is merely blocked, not a blocker", async () => {
    const blocker = (await mcp.call("todo_create", { title: "blocks the archived one" })).todo_id;
    const blocked = (
      await mcp.call("todo_create", { title: "archived while still blocked", blocked_by: [blocker] })
    ).todo_id;

    const receipt = await mcp.call("todo_archive", { todo_id: blocked });
    assert.equal(receipt.archived, true);
    assert.equal((await mcp.call("todo_get", { todo_id: blocked })).archived, true);
  });

  // Counselors round on #15, P2: archiving a blocked dependent is allowed,
  // but a naive LIVE_DEPENDENTS_SQL would still count that archived,
  // non-completed dependent as live, refusing to archive its blocker with
  // no way out but falsely completing the dependent or destroying the edge.
  it("allows archiving a blocker once its only dependent is archived too, not just completed", async () => {
    const blocker = (await mcp.call("todo_create", { title: "abandoned tree: blocker" })).todo_id;
    const blocked = (
      await mcp.call("todo_create", { title: "abandoned tree: dependent", blocked_by: [blocker] })
    ).todo_id;

    // Archive the dependent first - allowed today (it is not a blocker of
    // anything itself), and still open, never completed.
    await mcp.call("todo_archive", { todo_id: blocked });
    const dependentDetail = await mcp.call("todo_get", { todo_id: blocked });
    assert.equal(dependentDetail.status, "open");

    const receipt = await mcp.call("todo_archive", { todo_id: blocker });
    assert.equal(receipt.archived, true);
    assert.equal((await mcp.call("todo_get", { todo_id: blocker })).archived, true);
  });

  it("rejects an unknown todo_id the same way todo_get does", async () => {
    await assert.rejects(mcp.call("todo_archive", { todo_id: 999999 }), /No todo with id 999999/);
  });

  // Counselors round on #15: nothing pinned the slim-receipt invariant
  // (CLAUDE.md) itself - a handler that returned a full todo row or its
  // comments would still pass every other assertion in this file.
  it("returns a slim receipt: exactly project_id, todo_id, archived", async () => {
    const a = (await mcp.call("todo_create", { title: "slim receipt check" })).todo_id;
    const receipt = await mcp.call("todo_archive", { todo_id: a });
    assert.deepEqual(Object.keys(receipt).sort(), ["archived", "project_id", "todo_id"]);
  });
});

// Counselors round on #15, P1: todo_archive's refusal only ever looks at the
// moment of archiving. Nothing stopped an archived todo from becoming a live
// blocker afterward, through two separate routes.
describe("an archived todo cannot become an invisible active blocker", () => {
  it("refuses to add an archived todo as a blocker via todo_block", async () => {
    const a = (await mcp.call("todo_create", { title: "archived, route 1" })).todo_id;
    await mcp.call("todo_archive", { todo_id: a });
    const b = (await mcp.call("todo_create", { title: "would-be dependent" })).todo_id;

    await assert.rejects(
      mcp.call("todo_block", { todo_id: b, blocker_id: a }),
      /todo \d+ is archived/,
    );

    // The refusal must not have half-applied anything: b must still read as
    // unblocked, not silently linked to an invisible blocker.
    const detail = await mcp.call("todo_get", { todo_id: b });
    assert.equal(detail.is_blocked, false);
    assert.equal(detail.blockers.length, 0);
  });

  it("refuses to add an archived todo as a blocker via todo_create's blocked_by", async () => {
    const a = (await mcp.call("todo_create", { title: "archived, route 1b" })).todo_id;
    await mcp.call("todo_archive", { todo_id: a });

    await assert.rejects(
      mcp.call("todo_create", { title: "created already blocked", blocked_by: [a] }),
      /todo \d+ is archived/,
    );
  });

  it("refuses to reopen an archived, completed blocker through todo_complete", async () => {
    const blocker = (await mcp.call("todo_create", { title: "archived completed blocker" })).todo_id;
    const blocked = (
      await mcp.call("todo_create", { title: "still depends on it", blocked_by: [blocker] })
    ).todo_id;
    await mcp.call("todo_complete", { todo_id: blocker });
    await mcp.call("todo_archive", { todo_id: blocker });

    await assert.rejects(
      mcp.call("todo_complete", { todo_id: blocker, completed: false }),
      /Cannot reopen archived todo/,
    );

    // Confirm the refusal actually held: the blocker is still completed, and
    // the dependent is not newly blocked by an invisible edge.
    const blockerDetail = await mcp.call("todo_get", { todo_id: blocker });
    assert.equal(blockerDetail.status, "completed");
    const blockedDetail = await mcp.call("todo_get", { todo_id: blocked });
    assert.equal(blockedDetail.is_blocked, false);
  });

  it("refuses to un-complete an archived todo through todo_update", async () => {
    const blocker = (await mcp.call("todo_create", { title: "archived completed blocker, via update" })).todo_id;
    const blocked = (
      await mcp.call("todo_create", { title: "still depends on it too", blocked_by: [blocker] })
    ).todo_id;
    await mcp.call("todo_complete", { todo_id: blocker });
    await mcp.call("todo_archive", { todo_id: blocker });

    await assert.rejects(
      mcp.call("todo_update", { todo_id: blocker, status: "open" }),
      /Cannot change todo \d+'s status away from completed while archived/,
    );

    const blockedDetail = await mcp.call("todo_get", { todo_id: blocked });
    assert.equal(blockedDetail.is_blocked, false);
  });

  it("still allows completing an archived todo (the safe direction) and unarchiving to reopen it", async () => {
    const a = (await mcp.call("todo_create", { title: "archived while still open" })).todo_id;
    await mcp.call("todo_archive", { todo_id: a });

    // Moving TO completed is not the hazard - only leaving completed is.
    const completed = await mcp.call("todo_complete", { todo_id: a });
    assert.equal(completed.completed, true);

    // The documented escape hatch: unarchive first, then reopen freely.
    await mcp.call("todo_archive", { todo_id: a, archived: false });
    const reopened = await mcp.call("todo_complete", { todo_id: a, completed: false });
    assert.equal(reopened.completed, false);
  });

  it("still allows todo_update to change status on an archived todo that was never completed", async () => {
    const a = (await mcp.call("todo_create", { title: "archived, never completed" })).todo_id;
    await mcp.call("todo_archive", { todo_id: a });

    const updated = await mcp.call("todo_update", { todo_id: a, status: "in_progress" });
    assert.equal(updated.todo_id, a);
    const detail = await mcp.call("todo_get", { todo_id: a });
    assert.equal(detail.status, "in_progress");
  });
});

describe("archived todos stay invisible to the counted surfaces (#15)", () => {
  it("hive status counts each active todo individually and drops it exactly when archived", async () => {
    // Its own scratch project: the shared `mcp`/`dirs` above accumulate
    // todos across this file's other tests, and this assertion needs an
    // exact count.
    const dirs3 = scratchDirs();
    const mcp3 = new McpClient({ cwd: dirs3.projectDir, dataDir: dirs3.dataDir });
    await mcp3.start();
    try {
      const openTodo = (await mcp3.call("todo_create", { title: "open one" })).todo_id;
      const inProgressTodo = (await mcp3.call("todo_create", { title: "in-progress one" })).todo_id;
      await mcp3.call("todo_update", { todo_id: inProgressTodo, status: "in_progress" });

      // Counselors round on #15: a single static "count == 1" snapshot
      // accepts any query that happens to land on the right number from the
      // wrong rows. Tying the count to the SPECIFIC todo being archived,
      // one step at a time, closes that: each archive must drop the count
      // by exactly one, not just produce some number that matches by luck.
      const both = await runCli(["status"], { cwd: dirs3.projectDir, dataDir: dirs3.dataDir });
      assert.match(both.stdout, /open todos: 2\b/);

      await mcp3.call("todo_archive", { todo_id: openTodo });
      const oneLeft = await runCli(["status"], { cwd: dirs3.projectDir, dataDir: dirs3.dataDir });
      assert.match(oneLeft.stdout, /open todos: 1\b/);

      await mcp3.call("todo_archive", { todo_id: inProgressTodo });
      const none = await runCli(["status"], { cwd: dirs3.projectDir, dataDir: dirs3.dataDir });
      // Archived and completed are independent axes: both rows' statuses
      // are still 'open'/'in_progress', so a naive status-only count would
      // have kept counting them. Zero live todos (plus no agents, no
      // timers) means cmdStatus's own "nothing here" gate skips the
      // project block entirely.
      assert.match(none.stdout, /Nothing running and no open work in any project\./);
    } finally {
      await mcp3.close();
    }
  });

  it("hive statusline drops to silence once the only todo is archived", async () => {
    const dirs2 = scratchDirs();
    const mcp2 = new McpClient({ cwd: dirs2.projectDir, dataDir: dirs2.dataDir });
    await mcp2.start();
    try {
      const t = (await mcp2.call("todo_create", { title: "solo todo" })).todo_id;
      const before = await runCli(["statusline"], { cwd: dirs2.projectDir, dataDir: dirs2.dataDir });
      // Counselors round on #15: without asserting the exit code and
      // stderr, a crash that happens to also produce empty stdout would
      // pass the "prints nothing" assertion below just as well as the
      // intended behaviour would.
      assert.equal(before.code, 0, before.stderr);
      assert.equal(before.stderr, "");
      assert.match(before.stdout, /1 todo/);

      await mcp2.call("todo_archive", { todo_id: t });
      const after_ = await runCli(["statusline"], { cwd: dirs2.projectDir, dataDir: dirs2.dataDir });
      assert.equal(after_.code, 0, after_.stderr);
      assert.equal(after_.stderr, "");
      assert.equal(after_.stdout.trim(), "", "statusline must print nothing once its only todo is archived");
    } finally {
      await mcp2.close();
    }
  });
});
