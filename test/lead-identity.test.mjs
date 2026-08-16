import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { after, describe, it } from "node:test";

import { clearHiveEnv, isolateTmux, leadRow, makeFakeClaude, runCli, scratchDirs } from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("the lead identity tests");

clearHiveEnv();

const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { db, migrate } = await import("../dist/db.js");
const { janitor, tick } = await import("../dist/scheduler.js");
const { sessionName } = await import("../dist/tmux.js");
migrate();

function newProjectDir() {
  return realpathSync(mkdtempSync(join(dirname(dirs.projectDir), "project-")));
}

describe("the lead's hook identity", { skip: hasTmux ? false : "tmux is not installed" }, () => {
  describe("STEP 1: the row, and its reuse across a restart", () => {
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
      .get("lead-reuse-test", projectDir);
    const session = sessionName();

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

      db.prepare("UPDATE agents SET created_at = datetime('now', '-1 hour') WHERE id = ?").run(row1.id);
      execFileSync("tmux", ["kill-window", "-t", row1.tmux_target], { stdio: "ignore" });

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

      const before = leadRow(db, project.id);
      db.prepare("UPDATE agents SET status = 'closed', closed_at = datetime('now') WHERE id = ?").run(before.id);
      execFileSync("tmux", ["kill-window", "-t", before.tmux_target], { stdio: "ignore" });

      const result = await runCli(["lead"], cliOpts);
      assert.equal(result.code, 0, result.stderr);

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

      const before = db
        .prepare("SELECT * FROM agents WHERE project_id = ? AND kind = 'lead' AND status = 'running'")
        .get(project.id);
      const runningBefore = (
        db.prepare("SELECT COUNT(*) AS n FROM agents WHERE project_id = ? AND kind = 'lead' AND status = 'running'")
          .get(project.id)
      ).n;

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

      assert.equal(runningAfter[0].name, "lead");
    });

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

      assert.ok(timer.held_at, "the exemption must be RECORDED, not just applied silently");
      assert.match(timer.held_reason, /lead's pane is not live/);
    });
  });

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
      const session = sessionName();
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
      const session = sessionName();
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
      const session = sessionName();
      try {
        const first = await runCli(["lead"], cliOpts);
        assert.equal(first.code, 0, first.stderr);
        const before = leadRow(db, project.id);
        const livePane = before.tmux_target;

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
      const session = sessionName();
      try {
        const first = await runCli(["lead"], cliOpts);
        assert.equal(first.code, 0, first.stderr);
        const before = leadRow(db, project.id);
        const livePane = before.tmux_target;

        db.exec(
          `CREATE TRIGGER hijack_${before.id} AFTER UPDATE OF command ON agents
           WHEN NEW.id = ${before.id}
           BEGIN UPDATE agents SET tmux_target = '%stolen-by-racer' WHERE id = ${before.id}; END;`,
        );
        try {
          const second = await runCli(["lead"], cliOpts);
          assert.notEqual(second.code, 0, "the loser must report failure, not silently attach to nothing");
          assert.match(second.stdout, /won the race/);

          assert.equal(
            db.prepare("SELECT tmux_target FROM agents WHERE id = ?").get(before.id).tmux_target,
            "%stolen-by-racer",
          );

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
      const session = sessionName();
      try {
        const first = await runCli(["lead"], cliOpts);
        assert.equal(first.code, 0, first.stderr);
        const before = leadRow(db, project.id);

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

        } finally {
          db.exec(`DROP TRIGGER close_${before.id}`);
        }
      } finally {
        cleanup(session);
      }
    });

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
      const session = sessionName();
      try {
        const first = await runCli(["lead"], cliOpts);
        assert.equal(first.code, 0, first.stderr);
        const before = leadRow(db, project.id);

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
      const session = sessionName();
      try {

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
      const session = sessionName();
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
      const session = sessionName();
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
      const session = sessionName();
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
