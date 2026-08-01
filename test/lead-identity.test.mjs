import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { after, describe, it } from "node:test";

import { clearHiveEnv, isolateTmux, leadRow, makeFakeClaude, runCli, scratchDirs } from "./helpers.mjs";

// #27's acknowledgement half, wave 10 (plan-l4-lead-identity). Two things
// under test: `hive lead` giving the lead a real agents row (kind='lead')
// that survives a restart with the SAME actor id, and cmdLead passing
// --settings to a claude lead so its hook writes finally land somewhere.

const { hasTmux, cleanup } = isolateTmux("the lead identity tests");

clearHiveEnv();

// ONE store for the whole file, queried directly and by every `hive lead`
// subprocess below. A second scratchDirs() call would open a SECOND sqlite
// file that the CLI subprocess never writes to, which reads exactly like the
// row this test looks for was never created.
const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { db, migrate } = await import("../dist/db.js");
const { janitor, tick } = await import("../dist/scheduler.js");
const { sessionName } = await import("../dist/tmux.js");
migrate();

// Each test needs its own project (agents.name is unique per running project,
// and hive.yml lives at the project root), but they all share one store.
function newProjectDir() {
  return realpathSync(mkdtempSync(join(dirname(dirs.projectDir), "project-")));
}

describe("the lead's hook identity", { skip: hasTmux ? false : "tmux is not installed" }, () => {
  describe("STEP 1: the row, and its reuse across a restart", () => {
    const fakeClaude = makeFakeClaude(dirs.tmp);
    // `sleep 600` so the pane survives long enough to be killed on purpose,
    // rather than exiting and closing its own window before the test gets to it.
    const claudePath = fakeClaude("sleep 600");
    const projectDir = newProjectDir();
    const cliOpts = {
      cwd: projectDir,
      dataDir: dirs.dataDir,
      tmp: dirs.tmp,
      env: { PATH: `${dirname(claudePath)}:${process.env.PATH}` },
    };
    const project = db
      .prepare("INSERT INTO projects (name, path) VALUES (?, ?) RETURNING id")
      .get("lead-reuse-test", projectDir);
    const session = sessionName(project.id);

    after(() => cleanup(session));

    it("inserts a kind='lead' row and reuses its actor id across a restart, surviving a janitor sweep in the gap", async () => {
      const first = await runCli(["lead"], cliOpts);
      assert.equal(first.code, 0, first.stderr);

      const row1 = leadRow(db, project.id);
      assert.ok(row1, "hive lead must insert an agents row for itself");
      assert.equal(row1.kind, "lead");
      assert.equal(row1.name, "lead");
      assert.equal(row1.status, "running");
      assert.equal(row1.actor_id, `lead:${row1.id}`);
      assert.notEqual(row1.tmux_target, "", "the lead's pane target must be recorded");

      // restart-lead.sh's job: kill the lead's pane, then re-run `hive lead`.
      // Backdated created_at past SETTLE_WINDOW first: a freshly inserted row
      // is protected by the settle window regardless of kind, so without this
      // the janitor() call below would have no discriminating power at all
      // over DECISION 3's kind='lead' filter - it would pass on the settle
      // window alone, the same fixture-too-small-to-reach-the-bound shape
      // this project's suite has shipped before (test/CLAUDE.md, shape 6).
      db.prepare("UPDATE agents SET created_at = datetime('now', '-1 hour') WHERE id = ?").run(row1.id);
      execFileSync("tmux", ["kill-window", "-t", row1.tmux_target], { stdio: "ignore" });

      // Issue #27's L4 fix round, DECISION 3. This is the janitor sweep that
      // used to close a reused lead row in exactly this gap - a `hive status`
      // or another session's own scheduler tick landing here was F1. Running
      // it explicitly, between the two `hive lead` invocations, is what gives
      // this test discriminating power over deployed behaviour: the previous
      // version of this test never ran anything here, so it passed for a
      // reason that had nothing to do with whether the janitor sweeps a lead.
      const swept = janitor();
      assert.equal(swept.closed_agents, 0, "the janitor must not close a kind='lead' row");
      assert.equal(leadRow(db, project.id).status, "running", "the row must still be running after the sweep");

      const second = await runCli(["lead"], cliOpts);
      assert.equal(second.code, 0, second.stderr);

      const row2 = leadRow(db, project.id);
      assert.equal(row2.id, row1.id, "a restart must reuse the same agents row, not mint a new one");
      assert.equal(row2.actor_id, row1.actor_id, "the actor id must survive a restart unchanged");
      assert.equal(row2.status, "running");
    });

    it("reuses a closed lead row's actor id, for the session that never got the janitor fix", async () => {
      // DECISION 3's second half. A kind='lead' filter in THIS process's
      // janitor cannot reach every OTHER already-running MCP server in the
      // project, which keeps ticking its own pre-fix janitor until its
      // session restarts - so identity has to survive the row actually being
      // closed by one of them, not merely avoid it here. Simulated directly,
      // since reproducing a second live pre-fix server is not practical in a
      // test: whatever closed it, ensureLeadRow must still find it.
      const before = leadRow(db, project.id);
      db.prepare("UPDATE agents SET status = 'closed', closed_at = datetime('now') WHERE id = ?").run(before.id);
      execFileSync("tmux", ["kill-window", "-t", before.tmux_target], { stdio: "ignore" });

      const result = await runCli(["lead"], cliOpts);
      assert.equal(result.code, 0, result.stderr);
      // Not leadRow(): the closed row above and the fresh one this call
      // inserts both match kind='lead' now, and leadRow() carries no status
      // filter, so it would answer whichever SQLite happens to return first.
      const after = db
        .prepare("SELECT * FROM agents WHERE project_id = ? AND kind = 'lead' AND status = 'running'")
        .get(project.id);
      assert.notEqual(after.id, before.id, "no running row existed, so this must be a new one");
      assert.equal(
        after.actor_id,
        before.actor_id,
        "the new row must inherit the closed row's actor id, not mint a fresh lead:<id>",
      );
      assert.equal(after.status, "running");
    });

    it("finds the running lead row by kind, not by name - DECISION 5", async () => {
      // agent_rename now refuses a lead outright (DECISION 4), so this
      // should be unreachable going forward; the point of DECISION 5 is
      // defence in depth for exactly that "should be" - a row whose name
      // drifted from "lead" some other way (a direct write, an older build)
      // must not fool ensureLeadRow into treating it as absent and minting a
      // SECOND identity under the still-free name.
      //
      // Not leadRow(): earlier tests in this describe block have already left
      // a CLOSED kind='lead' row behind alongside the running one, and
      // leadRow() carries no status filter (see the comment on the previous
      // test), so it could just as easily pick the closed one here.
      const before = db
        .prepare("SELECT * FROM agents WHERE project_id = ? AND kind = 'lead' AND status = 'running'")
        .get(project.id);
      const runningBefore = (
        db.prepare("SELECT COUNT(*) AS n FROM agents WHERE project_id = ? AND kind = 'lead' AND status = 'running'")
          .get(project.id)
      ).n;
      // "boss", not "not-lead-anymore": the old fixture shared the substring
      // "lead" with the real name, so a resolver that fell back to fuzzy
      // matching could have found this row by NAME after all and made the
      // test pass for the wrong reason. Sharing no substring means DECISION
      // 5 (found by kind, not by name) is what a name-only lookup could not
      // have gotten right by accident (counselors codex F5).
      db.prepare("UPDATE agents SET name = 'boss' WHERE id = ?").run(before.id);

      const result = await runCli(["lead"], cliOpts);
      assert.equal(result.code, 0, result.stderr);

      const runningAfter = db
        .prepare("SELECT * FROM agents WHERE project_id = ? AND kind = 'lead' AND status = 'running'")
        .all(project.id);
      assert.equal(
        runningAfter.length,
        runningBefore,
        "a name-drifted running row must be reused, not left behind as a second running lead",
      );
      assert.equal(runningAfter.length, 1);
      assert.equal(runningAfter[0].id, before.id, "the SAME row, found by kind + running rather than by name");
      assert.equal(runningAfter[0].actor_id, before.actor_id);
      // Issue #27's L4 fix round R6, todo 170 (counselors codex F5): this
      // USED TO assert the drifted name was preserved, not corrected - true
      // of the code at the time, but it meant a rename left behind by an
      // already-running pre-41bbd77 server (agent_rename did not yet refuse
      // a lead target) permanently stranded the canonical "lead" handle
      // every wake, pad and todo comment addresses this row by. ensureLeadRow
      // now resets the name on every reuse, the same "identity survives what
      // another version did to the row" argument decision 2 already rests
      // on for actor_id. Asserting the FIX now, not the bug it replaced.
      assert.equal(runningAfter[0].name, "lead");
    });

    // The brief's "ALSO CHECK": the janitor's SECOND sweep, timers rather
    // than agents. A lead's own pending wake is exactly as exposed to the
    // momentarily-dead-pane restart gap as its agents row was, since
    // wakes.ts's resolveDelivery stamps deliver_actor with the lead's own
    // actor_id at wake_set time.
    it("a lead-owned wake survives a janitor sweep even with a dead pane", () => {
      const lead = db
        .prepare("SELECT * FROM agents WHERE project_id = ? AND kind = 'lead' AND status = 'running'")
        .get(project.id);
      const timerId = db
        .prepare(
          `INSERT INTO timers (project_id, owner, body, kind, watch, deliver_actor, deliver_pane, due_at, created_at)
           VALUES (?, 'user:test', 'pending lead wake', 'delay', '[]', ?, '%nonexistent-dead-pane',
             datetime('now', '+1 hour'), datetime('now', '-1 hour'))
           RETURNING id`,
        )
        .get(project.id, lead.actor_id).id;

      const result = janitor();
      assert.equal(result.cancelled_timers, 0, "a lead-owned wake must not be cancelled by the janitor sweep");
      const timer = db.prepare("SELECT cancelled_at FROM timers WHERE id = ?").get(timerId);
      assert.equal(timer.cancelled_at, null, "the timer must remain active, not cancelled");
    });

    // Same exposure, the other entry point: deliverable() has no
    // SETTLE_WINDOW grace at all, so a wake becoming due in the exact gap
    // would otherwise be cancelled outright on its very first delivery
    // attempt, rather than just held for a tick until the restart lands a
    // live pane. created_at is deliberately recent, so janitor()'s own sweep
    // (run first, inside tick()) is settle-window-protected and cannot be
    // what saves this timer - only deliverable()'s exemption can.
    it("a due lead-owned wake is not cancelled by the per-tick delivery check either", async () => {
      const lead = db
        .prepare("SELECT * FROM agents WHERE project_id = ? AND kind = 'lead' AND status = 'running'")
        .get(project.id);
      const timerId = db
        .prepare(
          `INSERT INTO timers (project_id, owner, body, kind, watch, deliver_actor, deliver_pane, due_at, created_at)
           VALUES (?, 'user:test', 'due lead wake', 'delay', '[]', ?, '%nonexistent-dead-pane',
             datetime('now', '-1 second'), datetime('now'))
           RETURNING id`,
        )
        .get(project.id, lead.actor_id).id;

      await tick();
      const timer = db
        .prepare("SELECT cancelled_at, fired_at, held_at, held_reason FROM timers WHERE id = ?")
        .get(timerId);
      assert.equal(timer.cancelled_at, null, "a dead pane must not cancel a lead-owned wake on its due tick");
      assert.equal(timer.fired_at, null, "and it must not have been claimed as fired into a dead pane either");
      // Counselors R2-A on this lane's own review: not cancelling is not
      // enough on its own. Without a held_at/held_reason write, this row
      // reads identically to one that simply is not due yet - typed_at,
      // held_at and held_reason all NULL - which is the exact ambiguity
      // held_at/held_reason exist to remove (#27's own motivating defect,
      // one door over).
      assert.ok(timer.held_at, "the exemption must be RECORDED, not just applied silently");
      assert.match(timer.held_reason, /lead's pane is not live/);
    });
  });

  // Issue #27's L4 fix round R8, todo 175 item 1 (counselors opus F2,
  // MEDIUM). idx_agents_running_name is UNIQUE(project_id, name COLLATE
  // NOCASE) WHERE status='running', and the reuse branch's name reset
  // (todo 170) had no guard of its own against it - only the INSERT branch
  // wrapped its own constraint hit in asNameClash. Reproduces this round's
  // own premise directly: an already-running pre-41bbd77 server renames the
  // lead row away from "lead" (freeing the name), and a pre-7c agent_spawn
  // on that same old server takes it for a worker before this reset runs.
  describe("STEP 1d: the name reset cannot crash on a worker already holding \"lead\"", () => {
    it("names the worker holding the name instead of raising a raw SQLite constraint", async () => {
      const fakeClaude = makeFakeClaude(dirs.tmp);
      const claudePath = fakeClaude("sleep 600");
      const projectDir = newProjectDir();
      const cliOpts = {
        cwd: projectDir,
        dataDir: dirs.dataDir,
        tmp: dirs.tmp,
        env: { PATH: `${dirname(claudePath)}:${process.env.PATH}` },
      };
      const project = db
        .prepare("INSERT INTO projects (name, path) VALUES (?, ?) RETURNING id")
        .get("lead-name-clash-test", projectDir);
      const session = sessionName(project.id);
      try {
        const first = await runCli(["lead"], cliOpts);
        assert.equal(first.code, 0, first.stderr);
        const before = leadRow(db, project.id);

        db.prepare("UPDATE agents SET name = 'boss' WHERE id = ?").run(before.id);
        db.prepare(
          `INSERT INTO agents (project_id, actor_id, name, tmux_target, command, cwd, kind, status)
           VALUES (?, 'agent:name-thief', 'lead', '%not-a-real-pane', 'claude', ?, 'agent', 'running')`,
        ).run(project.id, projectDir);

        const result = await runCli(["lead"], cliOpts);
        const output = result.stdout + result.stderr;
        assert.notEqual(result.code, 0, "a name clash on the reset must not silently succeed");
        assert.doesNotMatch(output, /SQLITE_CONSTRAINT|idx_agents_running_name/, "must not surface the raw SQLite constraint");
        // Issue #27's L4 fix round R9, todo 179 item 2 (codex F4). Was
        // missing the /i flag: both candidate messages (src/spawn.ts's
        // asNameClash and this file's own error) start with a capital
        // "Another", so this assertion could never fail regardless of which
        // message actually fired - unpinned in exactly the direction that
        // matters, since a regression back to asNameClash's wrong-for-this-
        // case message would have passed silently.
        assert.doesNotMatch(
          output,
          /another `hive lead` won the race/i,
          "must not blame a peer lead for a worker holding the name",
        );
        assert.match(output, /agent:name-thief/, "must name the actual holder of the name");

        assert.equal(
          db.prepare("SELECT name FROM agents WHERE id = ?").get(before.id).name,
          "boss",
          "the failed reset must not have partially landed",
        );
      } finally {
        cleanup(session);
      }
    });

    // Issue #27's L4 fix round R9, todo 179 item 2 (codex F4). The test
    // above seeds the name-thief lowercase, which idx_agents_running_name's
    // own COLLATE NOCASE happily collides against - but the holder lookup
    // in asLeadNameReuseClash used plain `name = ?` with no collation, so a
    // legacy worker named with different casing would trip the SAME
    // constraint (the index does not care about case) while this function's
    // own lookup missed it, falling back to "could not find which one"
    // instead of naming the actual holder.
    it("names the holder even when its casing differs from the reserved name", async () => {
      const fakeClaude = makeFakeClaude(dirs.tmp);
      const claudePath = fakeClaude("sleep 600");
      const projectDir = newProjectDir();
      const cliOpts = {
        cwd: projectDir,
        dataDir: dirs.dataDir,
        tmp: dirs.tmp,
        env: { PATH: `${dirname(claudePath)}:${process.env.PATH}` },
      };
      const project = db
        .prepare("INSERT INTO projects (name, path) VALUES (?, ?) RETURNING id")
        .get("lead-name-clash-case-test", projectDir);
      const session = sessionName(project.id);
      try {
        const first = await runCli(["lead"], cliOpts);
        assert.equal(first.code, 0, first.stderr);
        const before = leadRow(db, project.id);

        db.prepare("UPDATE agents SET name = 'boss' WHERE id = ?").run(before.id);
        db.prepare(
          `INSERT INTO agents (project_id, actor_id, name, tmux_target, command, cwd, kind, status)
           VALUES (?, 'agent:name-thief-mixed-case', 'LEAD', '%not-a-real-pane', 'claude', ?, 'agent', 'running')`,
        ).run(project.id, projectDir);

        const result = await runCli(["lead"], cliOpts);
        const output = result.stdout + result.stderr;
        assert.notEqual(result.code, 0, "a name clash on the reset must not silently succeed");
        assert.match(
          output,
          /agent:name-thief-mixed-case/,
          "must name the actual holder even though its name's casing differs from the reserved \"lead\"",
        );
        assert.doesNotMatch(output, /could not find which one/, "must not fall back when the holder is findable");
      } finally {
        cleanup(session);
      }
    });
  });

  // Issue #27's L4 fix round R9, todo 178 (counselors opus F2, MEDIUM). The
  // sibling case to STEP 1's own "reuses a closed lead row's actor id" test:
  // that test kills the WINDOW along with the row's own close, so the pane
  // really is dead and a fresh split is correct. Here the row is closed (by
  // "another process", exactly what the CAS's own loser message advises a
  // re-run after) while the pane is genuinely still alive - the case that
  // used to leave the original pane running, untracked, still writing hook
  // state under the actor id the new row just inherited.
  describe("STEP 1e: a closed lead row whose pane is still live is reattached to, not orphaned", () => {
    it("hive lead adopts the closed row's still-live pane instead of splitting a second one", async () => {
      const fakeClaude = makeFakeClaude(dirs.tmp);
      const claudePath = fakeClaude("sleep 600");
      const projectDir = newProjectDir();
      const cliOpts = {
        cwd: projectDir,
        dataDir: dirs.dataDir,
        tmp: dirs.tmp,
        env: { PATH: `${dirname(claudePath)}:${process.env.PATH}` },
      };
      const project = db
        .prepare("INSERT INTO projects (name, path) VALUES (?, ?) RETURNING id")
        .get("lead-closed-row-live-pane-test", projectDir);
      const session = sessionName(project.id);
      try {
        const first = await runCli(["lead"], cliOpts);
        assert.equal(first.code, 0, first.stderr);
        const before = leadRow(db, project.id);
        const livePane = before.tmux_target;

        // Only the row is closed - the pane, window and session are
        // untouched, standing in for the row being closed by something
        // other than a real session ending (a pre-176 server, or the
        // documented cross-server residual in agent_close's own retirement
        // check per .claude/rules/tmux-and-panes.md).
        db.prepare("UPDATE agents SET status = 'closed', closed_at = datetime('now') WHERE id = ?").run(before.id);

        const second = await runCli(["lead"], cliOpts);
        assert.equal(second.code, 0, second.stderr);

        const after = db
          .prepare("SELECT * FROM agents WHERE project_id = ? AND kind = 'lead' AND status = 'running'")
          .get(project.id);
        assert.ok(after, "a new running row must exist");
        assert.equal(after.actor_id, before.actor_id, "the actor id must still be inherited");
        assert.equal(
          after.tmux_target,
          livePane,
          "the new row must adopt the original still-live pane, not split a second one",
        );

        // The load-bearing assertion: exactly one pane in the lead's window,
        // not two. A version of this fix that only fixed the actor_id
        // bookkeeping (or seeded previousTarget without also seeding the
        // new row's own tmux_target column, so the CAS never matches) would
        // still leak a second, untracked claude here.
        const leadWindow = execFileSync("tmux", [
          "display-message", "-p", "-t", livePane, "#{session_name}:#{window_id}",
        ]).toString().trim();
        const panesInWindow = execFileSync("tmux", ["list-panes", "-t", leadWindow, "-F", "#{pane_id}"])
          .toString()
          .trim()
          .split("\n")
          .filter(Boolean);
        assert.equal(
          panesInWindow.length,
          1,
          `expected exactly one pane in the lead window, found: ${panesInWindow.join(", ")}`,
        );
        assert.equal(panesInWindow[0], livePane);
      } finally {
        cleanup(session);
      }
    });
  });

  // Issue #27's L4 fix round R8, todo 172 (counselors opus F4, MEDIUM). The
  // previous version of this describe block ran raw `UPDATE ... WHERE
  // tmux_target = ?` statements directly against the database and never
  // called cmdLead at all: it pinned SQLite's own changes() semantics, which
  // were never in doubt, using literals copied from production. Deleting
  // `AND tmux_target = ?` from cli.ts's CAS left the suite green, and the
  // loser branch (cli.ts's kill-pane-and-throw) had zero coverage of any
  // kind, which is why the two holes below sat there unexamined.
  //
  // A true two-process concurrency test (two real `hive lead` invocations
  // synchronized to race) was judged not worth the flakiness risk, and here
  // that risk is concrete rather than hypothetical: this suite's CI runs on
  // macOS, which does not give a freshly forked child scheduling priority
  // the way Linux does, so racing a real spawned pane's own startup command
  // against this process's next few lines of JS would not be deterministic
  // here even if it might be on a Linux workstation. Forcing the loser
  // branch with a database trigger instead reproduces the exact interleaving
  // counselors reasoned through - something else changes this row between
  // ensureLeadRow's read and cmdLead's own CAS write - with ordinary
  // single-process, single-threaded ordering: the trigger fires inside
  // ensureLeadRow's own reuse transaction (the `UPDATE agents SET command =
  // ...` every restart performs), strictly before cmdLead's code reaches the
  // CAS a few lines later.
  //
  // Issue #27's L4 fix round R9, todo 177 item 3 (counselors opus, checked
  // against scheduler.ts and confirmed sound - keep this technique, do not
  // churn it). What it does NOT establish, written down here rather than
  // left implicit: a REAL racer that also read the pane as live would write
  // the SAME value back, and both CASes would succeed with no loser at all.
  // The loser branch is only reachable in production when the two processes
  // genuinely DISAGREE about liveness - one gets targetLive() === true while
  // the other gets null from an unreachable probe, or the pane dies in the
  // gap between the two probes. The trigger below manufactures the POST
  // STATE that disagreement would produce, not the disagreement itself, so
  // reachability in production rests on that reasoning, not on anything
  // these tests measure directly.
  describe("STEP 1c: the pane-record CAS is exercised end to end through cmdLead", () => {
    it("does not kill a live pane it did not create, and still refuses the race", async () => {
      const fakeClaude = makeFakeClaude(dirs.tmp);
      const claudePath = fakeClaude("sleep 600");
      const projectDir = newProjectDir();
      const cliOpts = {
        cwd: projectDir,
        dataDir: dirs.dataDir,
        tmp: dirs.tmp,
        env: { PATH: `${dirname(claudePath)}:${process.env.PATH}` },
      };
      const project = db
        .prepare("INSERT INTO projects (name, path) VALUES (?, ?) RETURNING id")
        .get("lead-cas-stillthere-test", projectDir);
      const session = sessionName(project.id);
      try {
        const first = await runCli(["lead"], cliOpts);
        assert.equal(first.code, 0, first.stderr);
        const before = leadRow(db, project.id);
        const livePane = before.tmux_target;

        // Stands in for a second `hive lead` recording its own fresh pane on
        // this row in the gap between THIS run's read of previousTarget and
        // its own CAS write - counselors opus's exact interleaving (P2 wins
        // the race while P1 is mid-flight), forced deterministically rather
        // than raced.
        db.exec(
          `CREATE TRIGGER hijack_${before.id} AFTER UPDATE OF command ON agents
           WHEN NEW.id = ${before.id}
           BEGIN UPDATE agents SET tmux_target = '%stolen-by-racer' WHERE id = ${before.id}; END;`,
        );
        try {
          const second = await runCli(["lead"], cliOpts);
          assert.notEqual(second.code, 0, "the loser must report failure, not silently attach to nothing");
          assert.match(second.stdout, /won the race/);

          // Reading the row still names the racer's value: the loser did not
          // clobber the winner's write, only failed to record its own.
          assert.equal(
            db.prepare("SELECT tmux_target FROM agents WHERE id = ?").get(before.id).tmux_target,
            "%stolen-by-racer",
          );

          // The bug this test exists to catch: leadPane === previousTarget in
          // this branch, a pane this process only PROBED, not one it made.
          assert.doesNotThrow(
            () => execFileSync("tmux", ["list-panes", "-t", livePane], { stdio: "ignore" }),
            "a live pane this process did not create must survive the loser branch",
          );
        } finally {
          db.exec(`DROP TRIGGER hijack_${before.id}`);
        }
      } finally {
        cleanup(session);
      }
    });

    it("refuses the CAS when this row was closed elsewhere, tmux_target unchanged", async () => {
      const fakeClaude = makeFakeClaude(dirs.tmp);
      const claudePath = fakeClaude("sleep 600");
      const projectDir = newProjectDir();
      const cliOpts = {
        cwd: projectDir,
        dataDir: dirs.dataDir,
        tmp: dirs.tmp,
        env: { PATH: `${dirname(claudePath)}:${process.env.PATH}` },
      };
      const project = db
        .prepare("INSERT INTO projects (name, path) VALUES (?, ?) RETURNING id")
        .get("lead-cas-closed-test", projectDir);
      const session = sessionName(project.id);
      try {
        const first = await runCli(["lead"], cliOpts);
        assert.equal(first.code, 0, first.stderr);
        const before = leadRow(db, project.id);

        // closeAgentRow() leaves tmux_target unchanged when it closes a row
        // (src/scheduler.ts) - reproduced here landing in the same gap as
        // above: ensureLeadRow's read still sees status='running', then this
        // row is closed by "another process" before cmdLead's own CAS runs.
        db.exec(
          `CREATE TRIGGER close_${before.id} AFTER UPDATE OF command ON agents
           WHEN NEW.id = ${before.id}
           BEGIN UPDATE agents SET status = 'closed', closed_at = datetime('now') WHERE id = ${before.id}; END;`,
        );
        try {
          const second = await runCli(["lead"], cliOpts);
          assert.notEqual(
            second.code,
            0,
            "the CAS must not win on a row this process's own read found running but is now closed",
          );
          assert.match(second.stdout, /won the race/);
          // Issue #27's L4 fix round R9, todo 179 item 2 (codex F4). A
          // `status = 'closed'` assertion used to sit here and could never
          // fail: this CAS's own UPDATE only ever touches tmux_target, never
          // status, so it reads 'closed' whether the CAS won or lost. Tried
          // replacing it with a tmux_target-unchanged check instead, and
          // found that one is ALSO non-discriminating for this exact
          // scenario before deciding to remove rather than keep it: this
          // test's own row takes the stillThere/no-op-write branch (leadPane
          // === previousTarget, both the live pane from the first call), so
          // even a CAS with no status guard at all would write the SAME
          // value back - SQLite counts that as a changed row regardless
          // (the comment on wonRace's own transaction above says so).
          // Verified directly: temporarily dropped the CAS's `AND status =
          // 'running'` clause and confirmed by hand that tmux_target stays
          // identical either way here. notEqual(second.code, 0) plus the
          // "won the race" match above are the only two assertions in this
          // test with real discriminating power; removed the rest rather
          // than leave a check that looks meaningful and is not.
        } finally {
          db.exec(`DROP TRIGGER close_${before.id}`);
        }
      } finally {
        cleanup(session);
      }
    });

    // Issue #27's L4 fix round R9, todo 177 item 2 (counselors codex F3).
    // Both tests above start from a LIVE EXISTING pane (leadPane ===
    // previousTarget in both), so the loser branch's kill-pane call is never
    // actually reached with createdPane=true in either one - replacing it
    // with a constant no-op leaves both green. That is precisely the
    // regression that would leak a loser's freshly launched claude process,
    // and nothing above catches it.
    it("kills a pane it genuinely created when it loses the race - a no-op cleanup must not pass this", async () => {
      const fakeClaude = makeFakeClaude(dirs.tmp);
      const claudePath = fakeClaude("sleep 600");
      const projectDir = newProjectDir();
      const cliOpts = {
        cwd: projectDir,
        dataDir: dirs.dataDir,
        tmp: dirs.tmp,
        env: { PATH: `${dirname(claudePath)}:${process.env.PATH}` },
      };
      const project = db
        .prepare("INSERT INTO projects (name, path) VALUES (?, ?) RETURNING id")
        .get("lead-cas-created-pane-test", projectDir);
      const session = sessionName(project.id);
      try {
        const first = await runCli(["lead"], cliOpts);
        assert.equal(first.code, 0, first.stderr);
        const before = leadRow(db, project.id);

        // Kills the whole SESSION, not just the pane, so the second `hive
        // lead` finds no session at all and takes the claimInitialWindow
        // branch (ensureSession returns true) - the branch that genuinely
        // creates a pane, unlike STEP 1c's other two tests.
        execFileSync("tmux", ["kill-session", "-t", `=${session}`], { stdio: "ignore" });

        db.exec(
          `CREATE TRIGGER hijack2_${before.id} AFTER UPDATE OF command ON agents
           WHEN NEW.id = ${before.id}
           BEGIN UPDATE agents SET tmux_target = '%stolen-by-a-different-racer' WHERE id = ${before.id}; END;`,
        );
        try {
          const second = await runCli(["lead"], cliOpts);
          assert.notEqual(second.code, 0, "the loser must report failure");
          assert.match(second.stdout, /won the race/);

          // No live pane may remain recording this failed attempt - the
          // session itself may also be gone (exit-empty, once its only
          // pane is killed), which is fine; either way nothing may survive.
          let anyPanesLeft = true;
          try {
            execFileSync("tmux", ["list-panes", "-t", `=${session}`], { stdio: "ignore" });
          } catch {
            anyPanesLeft = false;
          }
          assert.equal(
            anyPanesLeft,
            false,
            "a pane this process genuinely created must not survive losing the race - a no-op cleanup would leave it running",
          );
        } finally {
          db.exec(`DROP TRIGGER hijack2_${before.id}`);
        }
      } finally {
        cleanup(session);
      }
    });

    // Issue #27's L4 fix round R10, todo 181 item 2 (BOTH SEATS, opus's
    // fix). Before this fix, ensureLeadRow's fresh-INSERT branch seeded
    // tmux_target with the closed row's OWN stale pane, so a running row
    // advertised a pane from a previous tmux generation from the moment the
    // INSERT committed - before anything on THIS invocation had confirmed
    // it was still this lead's pane, or even still existed. A crash between
    // that INSERT and the CAS a few lines later in cmdLead (ensureSession
    // throwing, new-session failing) would leave the row running and
    // naming that stale pane, which the CURRENT server generation may have
    // already reissued to a completely different live agent - the "hive
    // types into a stranger's pane" failure class #27 exists to remove.
    //
    // A trigger on the INSERT captures what the column was actually SEEDED
    // with, independent of whatever the CAS later overwrites it with on a
    // successful run - deterministic, not timing-dependent, the same
    // technique this describe block's own hijack triggers use on UPDATE.
    it("the fresh-INSERT branch never seeds a closed row's stale pane onto the running row", async () => {
      const fakeClaude = makeFakeClaude(dirs.tmp);
      const claudePath = fakeClaude("sleep 600");
      const projectDir = newProjectDir();
      const cliOpts = {
        cwd: projectDir,
        dataDir: dirs.dataDir,
        tmp: dirs.tmp,
        env: { PATH: `${dirname(claudePath)}:${process.env.PATH}` },
      };
      const project = db
        .prepare("INSERT INTO projects (name, path) VALUES (?, ?) RETURNING id")
        .get("lead-insert-seed-test", projectDir);
      const session = sessionName(project.id);
      try {
        // A closed lead row from a PREVIOUS generation, naming a pane that
        // never existed on THIS server - exactly the shape ensureLeadRow's
        // priorClosed lookup finds on a fresh `hive lead` after a reboot.
        db.prepare(
          `INSERT INTO agents (project_id, actor_id, name, tmux_target, command, cwd, kind, status)
           VALUES (?, 'lead:1', 'lead', '%from-a-previous-generation', 'claude', ?, 'lead', 'closed')`,
        ).run(project.id, projectDir);

        db.exec(`CREATE TABLE seed_capture_${project.id} (agent_id INTEGER, tmux_target TEXT)`);
        db.exec(
          `CREATE TRIGGER capture_seed_${project.id} AFTER INSERT ON agents
           WHEN NEW.project_id = ${project.id} AND NEW.kind = 'lead'
           BEGIN INSERT INTO seed_capture_${project.id} (agent_id, tmux_target) VALUES (NEW.id, NEW.tmux_target); END;`,
        );
        try {
          const result = await runCli(["lead"], cliOpts);
          assert.equal(result.code, 0, result.stderr);

          const captured = db.prepare(`SELECT tmux_target FROM seed_capture_${project.id}`).get();
          assert.equal(
            captured.tmux_target,
            "",
            "a fresh running row must never advertise a previous generation's pane before this invocation confirmed anything",
          );

          // The golden path is unaffected: previousTarget (unchanged) still
          // lets stillThere do its own job, and the row ends up with a real,
          // live pane once the CAS runs against casExpected.
          const after = db
            .prepare("SELECT * FROM agents WHERE project_id = ? AND kind = 'lead' AND status = 'running'")
            .get(project.id);
          assert.notEqual(after.tmux_target, "");
          assert.notEqual(after.tmux_target, "%from-a-previous-generation");
          assert.doesNotThrow(() =>
            execFileSync("tmux", ["list-panes", "-t", after.tmux_target], { stdio: "ignore" }),
          );
        } finally {
          db.exec(`DROP TRIGGER capture_seed_${project.id}`);
          db.exec(`DROP TABLE seed_capture_${project.id}`);
        }
      } finally {
        cleanup(session);
      }
    });
  });

  // Issue #27's L4 fix round R6, todo 166 (counselors codex F1, verified by
  // the lead against the code). deliver_pane is snapshotted once at
  // wake_set time and nothing updated it before this fix, so a restart -
  // which normally lands a genuinely different pane, not the exotic case -
  // left every pending lead-owned wake naming a pane that no longer existed.
  // Own project and session, not STEP 1's shared one: this test wants a
  // clean before/after pane pair, not state several prior tests have already
  // mutated.
  describe("STEP 1b: a pending lead-owned wake follows the lead across a restart", () => {
    it("re-points deliver_pane to the new pane in the same transaction, and actually delivers there", async () => {
      const fakeClaude = makeFakeClaude(dirs.tmp);
      const claudePath = fakeClaude("sleep 600");
      const projectDir = newProjectDir();
      const cliOpts = {
        cwd: projectDir,
        dataDir: dirs.dataDir,
        tmp: dirs.tmp,
        env: { PATH: `${dirname(claudePath)}:${process.env.PATH}` },
      };
      const project = db
        .prepare("INSERT INTO projects (name, path) VALUES (?, ?) RETURNING id")
        .get("lead-wake-restart-test", projectDir);
      const session = sessionName(project.id);
      const WAKE_BODY = "wake-follows-restart marker";

      try {
        const first = await runCli(["lead"], cliOpts);
        assert.equal(first.code, 0, first.stderr);
        const before = leadRow(db, project.id);
        const oldPane = before.tmux_target;

        const timerId = db
          .prepare(
            `INSERT INTO timers (project_id, owner, body, kind, watch, deliver_actor, deliver_pane, due_at)
             VALUES (?, 'user:test', ?, 'delay', '[]', ?, ?, datetime('now', '+1 hour'))
             RETURNING id`,
          )
          .get(project.id, WAKE_BODY, before.actor_id, oldPane).id;

        // Killing the WINDOW (as STEP 1's own restart test above does) would
        // take the whole session, and therefore this scratch tmux SERVER,
        // down with it - a server with no sessions left exits, and the next
        // one to start renumbers panes from %0, which would make the "must
        // be a genuinely different pane" assertion below pass by accident
        // even if deliver_pane were never re-pointed. Split a second,
        // throwaway pane into the lead's window directly (standing in for
        // DECISION 2's split-worker scenario without spinning up a real
        // one), so the window - and so the session and server - survive
        // when only the lead's own pane is killed next.
        const leadWindow = execFileSync("tmux", [
          "display-message", "-p", "-t", oldPane, "#{session_name}:#{window_id}",
        ]).toString().trim();
        execFileSync("tmux", ["split-window", "-d", "-t", leadWindow, "sleep", "600"], { stdio: "ignore" });
        execFileSync("tmux", ["kill-pane", "-t", oldPane], { stdio: "ignore" });

        const second = await runCli(["lead"], cliOpts);
        assert.equal(second.code, 0, second.stderr);
        const after = leadRow(db, project.id);
        const newPane = after.tmux_target;
        assert.notEqual(newPane, oldPane, "sanity check: the restart must have landed a genuinely different pane");

        const timerAfterRestart = db
          .prepare("SELECT deliver_pane, held_at, held_reason FROM timers WHERE id = ?")
          .get(timerId);
        assert.equal(
          timerAfterRestart.deliver_pane,
          newPane,
          "the pending wake's deliver_pane must follow the lead to its new pane",
        );
        assert.equal(timerAfterRestart.held_at, null, "re-pointing clears any hold (none was set here, but the column must not carry one)");

        // Not just the column: fire it for real and read the delivery back
        // off the actual pane's terminal, the way lead-pane-target.test.mjs
        // proves delivery rather than trusting a receipt.
        db.prepare("UPDATE timers SET due_at = datetime('now', '-1 second') WHERE id = ?").run(timerId);
        await tick();

        const capture = (target) => execFileSync("tmux", ["capture-pane", "-p", "-t", target]).toString();
        assert.ok(capture(newPane).includes(WAKE_BODY), "the wake must actually be typed into the NEW pane, not just recorded there");

        const fired = db.prepare("SELECT typed_at FROM timers WHERE id = ?").get(timerId);
        assert.ok(fired.typed_at, "the delivery must be recorded, not just visible on the pane by coincidence");
      } finally {
        cleanup(session);
      }
    });
  });

  describe("STEP 2: --settings, gated on isClaudeCommand", () => {
    it("appends --settings to a claude lead's command", async () => {
      const projectDir = newProjectDir();
      const fakeClaude = makeFakeClaude(dirs.tmp);
      const claudePath = fakeClaude("sleep 600");
      const project = db
        .prepare("INSERT INTO projects (name, path) VALUES (?, ?) RETURNING id")
        .get("lead-settings-claude", projectDir);
      const session = sessionName(project.id);
      try {
        const result = await runCli(["lead"], {
          cwd: projectDir,
          dataDir: dirs.dataDir,
          tmp: dirs.tmp,
          env: { PATH: `${dirname(claudePath)}:${process.env.PATH}` },
        });
        assert.equal(result.code, 0, result.stderr);
        const row = leadRow(db, project.id);
        assert.match(row.command, /--settings /, "a claude lead must get the hooks file");
        assert.doesNotMatch(result.stdout, /skipping hooks/);
      } finally {
        cleanup(session);
      }
    });

    it("skips --settings for a non-claude lead command, and says so", async () => {
      const projectDir = newProjectDir();
      const { configHash } = await import("../dist/projectYml.js");
      const leadCommand = "sleep 600";
      writeFileSync(join(projectDir, "hive.yml"), `lead: ${leadCommand}\n`);
      const project = db
        .prepare("INSERT INTO projects (name, path) VALUES (?, ?) RETURNING id")
        .get("lead-settings-non-claude", projectDir);
      db.prepare(
        "INSERT INTO command_trust (project_id, name, config_hash) VALUES (?, ?, ?)",
      ).run(project.id, "lead", configHash("lead", leadCommand, null, {}));
      const session = sessionName(project.id);
      try {
        const result = await runCli(["lead"], { cwd: projectDir, dataDir: dirs.dataDir, tmp: dirs.tmp });
        assert.equal(result.code, 0, result.stderr);
        assert.match(result.stdout, /! lead command is not claude; skipping hooks\./);
        const row = leadRow(db, project.id);
        assert.equal(row.command, leadCommand, "a non-claude lead command must be unchanged");
      } finally {
        cleanup(session);
      }
    });
  });
});
