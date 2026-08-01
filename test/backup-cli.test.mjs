import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";

import { isolateTmux, makeFakeClaude, runCli, scratchDirs } from "./helpers.mjs";

// Issue #23. `hive backups` and `hive restore` themselves never touch tmux,
// but runCli spawns hive, and every hive command runs migrate() first; the
// suite's own isolation guard (test/suite-isolation.test.mjs) does not
// distinguish by subcommand, so isolate like every other runCli-based file.
const { hasTmux, cleanup: cleanupTmux } = isolateTmux("the backup CLI tests");
after(() => cleanupTmux());

describe("hive backups / hive restore", () => {
  it("lists snapshots, refuses to restore without confirmation, and restores with --yes", async () => {
    const dirs = scratchDirs();
    const cli = { cwd: dirs.projectDir, dataDir: dirs.dataDir, tmp: dirs.tmp };

    // Every hive command runs migrate() first, and a fresh store has every
    // migration pending, so the very first command against this store already
    // leaves one "migration" snapshot behind for `hive backups` to list.
    const listed = await runCli(["backups"], cli);
    assert.equal(listed.code, 0);
    assert.match(listed.stdout, /migration/);
    const name = listed.stdout.match(/^(\S+)\s+migration/m)?.[1];
    assert.ok(name, `expected a snapshot name in:\n${listed.stdout}`);

    // No TTY, no --yes: must refuse rather than hang on a prompt nothing will answer.
    const refused = await runCli(["restore", name], cli);
    assert.equal(refused.code, 0);
    assert.match(refused.stdout, /Not restored/);
    assert.equal((await runCli(["backups"], cli)).stdout, listed.stdout);

    const restored = await runCli(["restore", name, "--yes"], cli);
    assert.equal(restored.code, 0);
    assert.match(restored.stdout, /Restored hive\.db/);
    // PR #36, S2: restore takes one more snapshot of the store as it stood
    // right before overwriting it, since restore is itself the kind of
    // mistake this whole feature exists to have a way back from.
    assert.match(restored.stdout, /Snapshotted the current store first/);
    assert.match((await runCli(["backups"], cli)).stdout, /manual/);

    const missing = await runCli(["restore", "not-a-real-snapshot"], cli);
    assert.equal(missing.code, 1);
    assert.match(missing.stderr + missing.stdout, /No snapshot named/);
  });
});

// PR #36, S1. Restore replaces the whole store out from under any live
// connection; SQLite's own docs call renaming a fresh inode over an open
// database, and unlinking its shared -wal, undefined behaviour. This gate
// makes "restart your other sessions first" enforcement rather than advice.
describe("hive restore refuses while the store looks active (PR #36, S1)", () => {
  it("refuses when an agent is recorded as running, and --force overrides it", async () => {
    const dirs = scratchDirs();
    const cli = { cwd: dirs.projectDir, dataDir: dirs.dataDir, tmp: dirs.tmp };

    // `hive backups` alone never registers a project (it never calls
    // resolveProject()); `hive pads` does, and this test needs a real
    // project row to attach the fake running agent to.
    await runCli(["pads"], cli);
    const listed = await runCli(["backups"], cli);
    const name = listed.stdout.match(/^(\S+)\s+migration/m)?.[1];
    assert.ok(name, `expected a snapshot name in:\n${listed.stdout}`);

    // A fake running agent, written directly to the store: this test is
    // about the CLI's own gate, not about spawning a real tmux worker.
    const db = new Database(join(dirs.dataDir, "hive.db"));
    const projectId = db.prepare("SELECT id FROM projects LIMIT 1").get().id;
    db.prepare(
      `INSERT INTO agents (project_id, actor_id, name, tmux_target, command, cwd, kind, status)
       VALUES (?, '', 'fake-worker', '', 'sleep 600', '/tmp', 'agent', 'running')`,
    ).run(projectId);
    db.close();

    const refused = await runCli(["restore", name, "--yes"], cli);
    assert.equal(refused.code, 1);
    assert.match(refused.stdout, /Refusing to restore/);
    assert.match(refused.stdout, /agent\(s\)\/command\(s\) recorded as running/);
    // Issue #49: --force is weak protection on its own (it cannot see a
    // session that started outside hive, or one that starts in the gap
    // between this check and the overwrite), so the message has to name what
    // choosing it actually costs. Two different servers pay differently: a
    // same-version one refuses at its next tool call once storeReplaced()
    // trips; an older one has no such guard and keeps writing until it exits.
    assert.match(refused.stdout, /will refuse every hive tool once it notices/);
    assert.match(refused.stdout, /older server/);
    assert.match(refused.stdout, /no longer exists/);
    assert.match(refused.stdout, /losing that work silently/);

    const forced = await runCli(["restore", name, "--yes", "--force"], cli);
    assert.equal(forced.code, 0);
    assert.match(forced.stdout, /Restored hive\.db/);
  });
});

// Issue #27's L4 fix round R9, todo 176 (BOTH SEATS, codex HIGH). This used
// to probe the lead's own pane (targetAlive against a liveTargets()
// snapshot, todo 173), on the premise that status='running' alone cannot
// tell a live lead from one whose session ended hours ago (DECISION 3).
// That premise is still true, but cross-server liveness turned out
// unanswerable by probing: an empty snapshot means either "no server at
// all" (the ordinary post-reboot state, exactly when someone restores a
// backup) or "the wrong server" (a live lead on a different one), and
// nothing in a bare AliveSnapshot tells those apart. So this stops probing
// entirely - a running lead row refuses UNCONDITIONALLY now, dead pane or
// not - and the way out is a human retiring the row (agent_close, see
// test/agent-close-lead-guard.test.mjs), not a liveness guess.
describe("hive restore and a lead row that outlives its session (issue #27's L4 fix round, redesigned in R9)", () => {
  it("refuses while live, keeps refusing once the pane is dead, and allows it once the row is retired", async () => {
    const dirs = scratchDirs();
    const cli = { cwd: dirs.projectDir, dataDir: dirs.dataDir, tmp: dirs.tmp };
    const fakeClaude = makeFakeClaude(dirs.tmp);
    const claudePath = fakeClaude("sleep 600");
    const leadCli = { ...cli, env: { PATH: `${dirname(claudePath)}:${process.env.PATH}` } };

    await runCli(["lead"], leadCli);
    const listed = await runCli(["backups"], cli);
    const name = listed.stdout.match(/^(\S+)\s+migration/m)?.[1];
    assert.ok(name, `expected a snapshot name in:\n${listed.stdout}`);

    const db = new Database(join(dirs.dataDir, "hive.db"));
    const row = db.prepare("SELECT * FROM agents WHERE kind = 'lead' AND status = 'running'").get();
    db.close();
    assert.ok(row, "hive lead must have inserted a running lead row");

    const refusedLive = await runCli(["restore", name, "--yes"], cli);
    assert.equal(refusedLive.code, 1, refusedLive.stdout + refusedLive.stderr);
    assert.match(refusedLive.stdout, /Refusing to restore/);
    assert.match(refusedLive.stdout, /lead session\(s\) recorded as running/);

    execFileSync("tmux", ["kill-window", "-t", row.tmux_target], { stdio: "ignore" });

    // The pane is now genuinely dead, and restore must STILL refuse: no
    // probe means no exception for a dead pane either, only for a
    // deliberately closed row (below). This is the load-bearing assertion
    // for the redesign - the previous version of this test asserted the
    // opposite here.
    const stillRefused = await runCli(["restore", name, "--yes"], cli);
    assert.equal(stillRefused.code, 1, stillRefused.stdout + stillRefused.stderr);
    assert.match(stillRefused.stdout, /lead session\(s\) recorded as running/);
    assert.match(stillRefused.stdout, /agent_close/, "the refusal must name the retirement remedy, not just --force");
    // Issue #27's L4 fix round R10, todo 182 item 2 (opus F4). agent_close is
    // an MCP tool, not a `hive` CLI verb the person reading this refusal at a
    // bare terminal could just run.
    assert.match(
      stillRefused.stdout,
      /claude session connected to this project's hive MCP server/,
      "the remedy must say where agent_close actually lives",
    );

    // The deliberate retirement path itself (agent_close on a confirmed-dead
    // lead) is exercised directly in test/agent-close-lead-guard.test.mjs;
    // only its EFFECT on restore - a closed row - matters here.
    const db2 = new Database(join(dirs.dataDir, "hive.db"));
    db2.prepare("UPDATE agents SET status = 'closed', closed_at = datetime('now') WHERE id = ?").run(row.id);
    db2.close();

    const restored = await runCli(["restore", name, "--yes"], cli);
    assert.equal(restored.code, 0, restored.stdout + restored.stderr);
    assert.match(restored.stdout, /Restored hive\.db/);
  });
});

// Issue #27's L4 fix round R9, todo 176 HALF 1 (the lead's own regression
// finding, verified against the code). The reboot case: no tmux server
// answers at all, which is what a live server ALWAYS eventually becomes
// once its last session closes (tmux ships exit-empty on) - not an
// exotic edge, the ordinary state right when someone restores a backup.
// R8's snapshotEmpty rule refused here too, but by accident (an empty
// liveTargets() snapshot) and with --force as the only way out, which also
// disabled the runningNonLeads check above. This refuses because the row
// is running, full stop, with no tmux call involved in the decision at all.
describe("hive restore refuses on any running lead row with no tmux server reachable at all (todo 176)", () => {
  it("refuses the reboot case and names the remedy", async () => {
    const dirs = scratchDirs();
    const cli = { cwd: dirs.projectDir, dataDir: dirs.dataDir, tmp: dirs.tmp };
    await runCli(["pads"], cli); // registers a project row
    const listed = await runCli(["backups"], cli);
    const name = listed.stdout.match(/^(\S+)\s+migration/m)?.[1];
    assert.ok(name, `expected a snapshot name in:\n${listed.stdout}`);

    const db = new Database(join(dirs.dataDir, "hive.db"));
    const projectId = db.prepare("SELECT id FROM projects LIMIT 1").get().id;
    db.prepare(
      `INSERT INTO agents (project_id, actor_id, name, tmux_target, command, cwd, kind, status)
       VALUES (?, 'lead:1', 'lead', '%not-a-real-pane', 'claude', ?, 'lead', 'running')`,
    ).run(projectId, dirs.projectDir);
    db.close();

    // A socket directory that has never had a tmux server started on it -
    // "no server running", the same answer a machine gives right after a
    // reboot.
    const neverStartedSocket = mkdtempSync(join(tmpdir(), "hive-never-started-tmux-"));
    try {
      const refused = await runCli(["restore", name, "--yes"], { ...cli, env: { TMUX_TMPDIR: neverStartedSocket } });
      assert.equal(refused.code, 1, refused.stdout + refused.stderr);
      assert.match(refused.stdout, /Refusing to restore/);
      assert.match(refused.stdout, /lead session\(s\) recorded as running/);
      assert.match(refused.stdout, /agent_close/, "the refusal must name the remedy, not just --force");
    } finally {
      rmSync(neverStartedSocket, { recursive: true, force: true });
    }
  });
});

// Issue #27's L4 fix round R10, todo 182 item 1 (codex F4). The two describe
// blocks above both refuse restore over an EMPTY tmux snapshot (no server,
// or a server nobody has ever started a session on) - and the pre-R9 code
// they replaced refused there too, by accident, via its own snapshotEmpty
// rule. Reverting the R9 fix and rerunning either test above still goes
// green, so neither one actually pins the redesign; they only pin "restore
// refuses when nothing is reachable," which both versions already did. The
// distinguishing case is a POPULATED snapshot that simply does not contain
// this row's target - the wrong-server case R9 exists for - and nothing in
// this file exercised it before now.
describe(
  "hive restore refuses a running lead row even against a POPULATED snapshot that does not contain its pane (todo 182 item 1)",
  { skip: hasTmux ? false : "tmux is not installed" },
  () => {
    it("refuses - the pre-R9 code this replaced would have allowed this exact case through", async () => {
      const dirs = scratchDirs();
      const cli = { cwd: dirs.projectDir, dataDir: dirs.dataDir, tmp: dirs.tmp };
      await runCli(["pads"], cli); // registers a project row
      const listed = await runCli(["backups"], cli);
      const name = listed.stdout.match(/^(\S+)\s+migration/m)?.[1];
      assert.ok(name, `expected a snapshot name in:\n${listed.stdout}`);

      const db = new Database(join(dirs.dataDir, "hive.db"));
      const projectId = db.prepare("SELECT id FROM projects LIMIT 1").get().id;
      db.prepare(
        `INSERT INTO agents (project_id, actor_id, name, tmux_target, command, cwd, kind, status)
         VALUES (?, 'lead:1', 'lead', '%not-on-this-snapshot', 'claude', ?, 'lead', 'running')`,
      ).run(projectId, dirs.projectDir);
      db.close();

      // A REAL, reachable, non-empty tmux session - so liveTargets() answers
      // a populated snapshot, not null and not empty - that simply has
      // nothing to do with this row's pane. Named so it does NOT start with
      // SESSION_PREFIX ("hive-"), or the OTHER signal activeHiveUsage checks
      // (a live hive-* session) would refuse for an unrelated reason and this
      // test would stop discriminating anything about the lead-row signal at
      // all.
      execFileSync("tmux", ["new-session", "-d", "-s", "unrelated-populated-session", "sleep", "600"], {
        stdio: "ignore",
      });
      try {
        const refused = await runCli(["restore", name, "--yes"], cli);
        assert.equal(refused.code, 1, refused.stdout + refused.stderr);
        assert.match(refused.stdout, /Refusing to restore/);
        assert.match(refused.stdout, /lead session\(s\) recorded as running/);
      } finally {
        execFileSync("tmux", ["kill-session", "-t", "=unrelated-populated-session"], { stdio: "ignore" });
      }
    });
  },
);

// PR #36, C2. HIVE_BACKUP_KEEP_LAST=1 makes the bug reproducible with one
// snapshot instead of ten: without protecting the restore target, the
// pre-restore "manual" backup this call takes would itself be the only
// snapshot retention keeps, pruning the very thing being restored before
// restoreSnapshot ever looks for it.
describe("hive restore does not let its own pre-restore backup prune the restore target (PR #36, C2)", () => {
  it("restores the chosen snapshot even when retention would otherwise evict it", async () => {
    const dirs = scratchDirs();
    const cli = { cwd: dirs.projectDir, dataDir: dirs.dataDir, tmp: dirs.tmp, env: { HIVE_BACKUP_KEEP_LAST: "1" } };

    const listed = await runCli(["backups"], cli);
    const target = listed.stdout.match(/^(\S+)\s+migration/m)?.[1];
    assert.ok(target, `expected a snapshot name in:\n${listed.stdout}`);

    const restored = await runCli(["restore", target, "--yes"], cli);
    assert.equal(restored.code, 0, `expected a successful restore, got:\n${restored.stdout}`);
    assert.match(restored.stdout, /Restored hive\.db/);
  });
});
