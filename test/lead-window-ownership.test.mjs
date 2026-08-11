import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";

import { isolateTmux, leadRow, makeFakeClaude, McpClient, panesIn, runCli, scratchDirs, windowFor, windowOwners } from "./helpers.mjs";

// Todo 265 / plan-lane-3-tmux-topology. One store-scoped session, one window
// per project, found by the @hive-project-id ownership stamp rather than by
// window name (decisions/2026-08-05-tmux-topology-windows-not-sessions.md).
// This is the REAL entry point end to end: two real `hive lead` processes,
// not a helper cmdLead happens to call - lane 2's own lesson
// (dead-ends/2026-08-05-helper-whose-parameters-cannot-disagree.md) is that a
// helper's parameters can be made to agree in every call a suite can produce,
// which proves nothing about the caller that matters.

const { hasTmux, cleanup } = isolateTmux("the lead window-ownership tests");

const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { db, migrate } = await import("../dist/db.js");
const { sessionName } = await import("../dist/tmux.js");
migrate();

describe(
  "cmdLead claims one window per project in the one shared session, by ownership stamp",
  { skip: hasTmux ? false : "tmux is not installed" },
  () => {
    const fakeClaude = makeFakeClaude(dirs.tmp);
    const dirA = mkdtempSync(join(dirs.tmp, "proj-a-"));
    const dirB = mkdtempSync(join(dirs.tmp, "proj-b-"));
    // Deliberately the SAME name for both. Only `path` is unique in the
    // projects table; two real checkouts ("api" in two different orgs) can
    // legitimately share a name. This is the case a name-based window lookup
    // gets wrong and a stamp-based one does not - decisions/2026-08-05-tmux-
    // topology-windows-not-sessions.md: "two projects sharing a name stops
    // being a correctness problem and becomes a cosmetic one." A same-window
    // name for A and B would still pass every assertion below by accident if
    // this file used distinct names, since a name-based lookup would then
    // happen to disambiguate correctly too - the collision is what makes
    // mutation (1) (look up by name) provably fail.
    const projA = db.prepare("INSERT INTO projects (name, path) VALUES (?, ?) RETURNING id").get("same-name", dirA);
    const projB = db.prepare("INSERT INTO projects (name, path) VALUES (?, ?) RETURNING id").get("same-name", dirB);
    const session = sessionName();
    let mcpB;

    before(async () => {
      const claudeA = fakeClaude("sleep 600");
      const firstA = await runCli(["lead"], {
        cwd: dirA,
        dataDir: dirs.dataDir,
        tmp: dirs.tmp,
        env: { PATH: `${dirname(claudeA)}:${process.env.PATH}` },
      });
      assert.equal(firstA.code, 0, firstA.stderr);

      const claudeB = fakeClaude("sleep 600");
      const firstB = await runCli(["lead"], {
        cwd: dirB,
        dataDir: dirs.dataDir,
        tmp: dirs.tmp,
        env: { PATH: `${dirname(claudeB)}:${process.env.PATH}` },
      });
      assert.equal(firstB.code, 0, firstB.stderr);
    });

    after(async () => {
      if (mcpB) await mcpB.close();
      cleanup(session);
    });

    it("gives each project its own window in the ONE session, each stamped with its own id", () => {
      const owners = windowOwners(session);
      const ownerIds = owners.map(([, id]) => id).filter((id) => id !== "");
      assert.deepEqual(
        new Set(ownerIds),
        new Set([String(projA.id), String(projB.id)]),
        `expected windows stamped exactly for ${projA.id} and ${projB.id}, got: ${JSON.stringify(owners)}`,
      );
      assert.equal(ownerIds.length, 2, "each project owns exactly one window, not a duplicate");
    });

    it("keeps each lead's own pane inside ITS project's window, not the other one", () => {
      const windowA = windowFor(session, projA.id);
      const windowB = windowFor(session, projB.id);

      const rowA = leadRow(db, projA.id);
      const rowB = leadRow(db, projB.id);

      assert.ok(panesIn(windowA).includes(rowA.tmux_target), "project A's lead pane must be in project A's window");
      assert.ok(panesIn(windowB).includes(rowB.tmux_target), "project B's lead pane must be in project B's window");
      assert.ok(!panesIn(windowA).includes(rowB.tmux_target), "project B's lead must not share project A's window");
    });

    it("a split-placed worker for the SECOND project lands in that project's window, not the first project's (the old rows[0] fallback)", async () => {
      const windowA = windowFor(session, projA.id);
      const windowB = windowFor(session, projB.id);

      mcpB = new McpClient({ cwd: dirB, dataDir: dirs.dataDir, env: { HIVE_SPAWN_READY_MS: "500" } });
      await mcpB.start();
      const spawned = await mcpB.call("agent_spawn", {
        name: "b-worker",
        command: fakeClaude("sleep 600"),
        extra_args: [],
        placement: "split",
      });

      assert.ok(
        panesIn(windowB).includes(spawned.tmux_target),
        `worker spawned for project B must land in project B's window (${windowB}), got pane ${spawned.tmux_target}`,
      );
      assert.ok(
        !panesIn(windowA).includes(spawned.tmux_target),
        "must not land in project A's window - that is the old rows[0]/leadTitle fallback silently placing it in a stranger's tab",
      );
    });

    // Todo 266. stillThere's only ownership check is foundWindow's own
    // derivation (see the comment at foundWindow's lookup, src/cli.ts): a
    // pane cannot pass `list-panes -t foundWindow` membership while actually
    // living in a different project's window. That is provable from
    // foundWindow's own construction and adding a second, independent
    // ownership clause at the stillThere site would be untestable - any test
    // for it would have to reconstruct this same fact
    // (dead-ends/2026-08-05-helper-whose-parameters-cannot-disagree.md's
    // shape). So this test pins the OBSERVABLE property the derivation
    // exists to protect, at the entry point where a real regression would
    // actually show up, rather than a clause that cannot independently fail.
    it("a lead restart never adopts a pane from a DIFFERENT project's window, even when its own row's tmux_target names one (the cross-upgrade / stranded-pane shape)", async () => {
      const rowA = leadRow(db, projA.id);
      const rowBBefore = leadRow(db, projB.id);

      // Constructs THE ACCEPTED RESIDUAL's shape directly: B's own row made
      // to record a pane that is real, alive, and socket-matching, but
      // living in project A's window - what a cross-upgrade stale row would
      // look like if the old and new topologies happened to share a socket.
      // Getting a live tmux server into this state through the ordinary
      // `hive lead` path would need an actual topology upgrade to fake.
      //
      // Issue #157 (todo 352, counselors claude-opus-5). pane_pid copied
      // alongside target/socket now too, not just the two - without it, B's
      // row keeps naming B's OWN pane's pid, which disagrees with A's pane's
      // real pid this row now points at, and the adopt check's new
      // paneReissued() conjunct (src/cli.ts) short-circuits adopted to null
      // on the pid mismatch alone, BEFORE adoptableWindow's ownership
      // exclusion (src/tmux.ts) is ever reached. This test's whole claim is
      // that exclusion refusing a foreign-owned window, so a fixture that
      // never reaches it passes for an unrelated reason - test/CLAUDE.md
      // shape 7, an assertion satisfied by two indistinguishable causes.
      // Copying pane_pid too makes the row internally consistent (the pane
      // it names is A's, so the pid it records must be A's pane's real pid),
      // which is what a genuine cross-upgrade stale row would look like
      // anyway - it never had two independent facts to disagree with each
      // other in the first place.
      db.prepare("UPDATE agents SET tmux_target = ?, tmux_socket = ?, pane_pid = ? WHERE id = ?").run(
        rowA.tmux_target,
        rowA.tmux_socket,
        rowA.pane_pid,
        rowBBefore.id,
      );

      const claudeB2 = fakeClaude("sleep 600");
      const restarted = await runCli(["lead"], {
        cwd: dirB,
        dataDir: dirs.dataDir,
        tmp: dirs.tmp,
        env: { PATH: `${dirname(claudeB2)}:${process.env.PATH}` },
      });
      assert.equal(restarted.code, 0, restarted.stderr);

      // STORE ROWS FIRST, before any window lookup. A broken foundWindow
      // derivation can leave a project with no window to find at all
      // (windowFor's own assertion would then fire), and that must not hide
      // the more direct fact - whether B's row now points at A's pane - a
      // fact the store carries regardless of whether any window lookup
      // works. Reviewed 2026-08-05: an earlier version of this test computed
      // windowA/windowB before this point and asserted on windows first, so
      // a broken lookup threw a bare TypeError before ever reaching these
      // two assertions - real under the mutation below, but an inference
      // from the crash, not an observation of the adoption itself.
      const rowAAfter = leadRow(db, projA.id);
      const rowBAfter = leadRow(db, projB.id);
      assert.notEqual(
        rowBAfter.tmux_target,
        rowA.tmux_target,
        "project B's lead must not adopt project A's pane just because its own row was made to point at it",
      );
      assert.equal(
        rowAAfter.tmux_target,
        rowA.tmux_target,
        "project A's own row must be untouched by project B's restart",
      );

      const windowA = windowFor(session, projA.id);
      const windowB = windowFor(session, projB.id);
      assert.ok(
        panesIn(windowB).includes(rowBAfter.tmux_target),
        "project B's lead must land back in project B's own window, not wherever its stale tmux_target pointed",
      );
      assert.ok(
        panesIn(windowA).includes(rowA.tmux_target),
        "project A's own pane must still be alive and in its own window",
      );
    });
  },
);
