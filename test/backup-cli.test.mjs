import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";

import { fakeFailingTmux, fakeHangingTmux, isolateTmux, makeFakeClaude, runCli, scratchDirs } from "./helpers.mjs";

const { hasTmux, cleanup: cleanupTmux } = isolateTmux("the backup CLI tests");
after(() => cleanupTmux());

describe("hive backups / hive restore", () => {
  it("lists snapshots, refuses to restore without confirmation, and restores with --yes", async () => {
    const dirs = scratchDirs();
    const cli = { cwd: dirs.projectDir, dataDir: dirs.dataDir, tmp: dirs.tmp };

    const listed = await runCli(["backups"], cli);
    assert.equal(listed.code, 0);
    assert.match(listed.stdout, /migration/);
    const name = listed.stdout.match(/^(\S+)\s+migration/m)?.[1];
    assert.ok(name, `expected a snapshot name in:\n${listed.stdout}`);

    const refused = await runCli(["restore", name], cli);
    assert.equal(refused.code, 0);
    assert.match(refused.stdout, /Not restored/);
    assert.equal((await runCli(["backups"], cli)).stdout, listed.stdout);

    const restored = await runCli(["restore", name, "--yes"], cli);
    assert.equal(restored.code, 0);
    assert.match(restored.stdout, /Restored hive\.db/);

    assert.match(restored.stdout, /Snapshotted the current store first/);
    assert.match((await runCli(["backups"], cli)).stdout, /manual/);

    const missing = await runCli(["restore", "not-a-real-snapshot"], cli);
    assert.equal(missing.code, 1);
    assert.match(missing.stderr + missing.stdout, /No snapshot named/);
  });
});

describe("hive restore refuses while the store looks active (PR #36, S1)", () => {
  it("refuses when an agent is recorded as running, and --force overrides it", async () => {
    const dirs = scratchDirs();
    const cli = { cwd: dirs.projectDir, dataDir: dirs.dataDir, tmp: dirs.tmp };

    await runCli(["pads"], cli);
    const listed = await runCli(["backups"], cli);
    const name = listed.stdout.match(/^(\S+)\s+migration/m)?.[1];
    assert.ok(name, `expected a snapshot name in:\n${listed.stdout}`);

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

    assert.match(refused.stdout, /will refuse every hive tool once it notices/);
    assert.match(refused.stdout, /older server/);
    assert.match(refused.stdout, /no longer exists/);
    assert.match(refused.stdout, /losing that work silently/);

    const forced = await runCli(["restore", name, "--yes", "--force"], cli);
    assert.equal(forced.code, 0);
    assert.match(forced.stdout, /Restored hive\.db/);
  });
});

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

    const stillRefused = await runCli(["restore", name, "--yes"], cli);
    assert.equal(stillRefused.code, 1, stillRefused.stdout + stillRefused.stderr);
    assert.match(stillRefused.stdout, /lead session\(s\) recorded as running/);
    assert.match(stillRefused.stdout, /agent_close/, "the refusal must name the retirement remedy, not just --force");

    assert.match(
      stillRefused.stdout,
      /claude session connected to this project's hive MCP server/,
      "the remedy must say where agent_close actually lives",
    );

    const db2 = new Database(join(dirs.dataDir, "hive.db"));
    db2.prepare("UPDATE agents SET status = 'closed', closed_at = datetime('now') WHERE id = ?").run(row.id);
    db2.close();

    const restored = await runCli(["restore", name, "--yes"], cli);
    assert.equal(restored.code, 0, restored.stdout + restored.stderr);
    assert.match(restored.stdout, /Restored hive\.db/);
  });
});

describe("hive restore refuses on any running lead row with no tmux server reachable at all (todo 176)", () => {
  it("refuses the reboot case and names the remedy", async () => {
    const dirs = scratchDirs();
    const cli = { cwd: dirs.projectDir, dataDir: dirs.dataDir, tmp: dirs.tmp };
    await runCli(["pads"], cli);
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

describe("hive restore and a tmux that does not answer (todo 375)", () => {
  const setup = async () => {
    const dirs = scratchDirs();
    const cli = { cwd: dirs.projectDir, dataDir: dirs.dataDir, tmp: dirs.tmp };
    await runCli(["pads"], cli);
    const listed = await runCli(["backups"], cli);
    const name = listed.stdout.match(/^(\S+)\s+migration/m)?.[1];
    assert.ok(name, `expected a snapshot name in:\n${listed.stdout}`);
    return { cli, name };
  };

  it("blocks the restore and says what to do about it", { skip: hasTmux ? false : "tmux not installed" }, async () => {
    const { cli, name } = await setup();

    const fakeDir = fakeHangingTmux({ hangOn: "ls" });
    try {
      const env = { PATH: `${fakeDir}:${process.env.PATH}`, HIVE_TMUX_TIMEOUT_MS: "500" };
      const refused = await runCli(["restore", name, "--yes"], { ...cli, env });
      assert.equal(refused.code, 1, refused.stdout + refused.stderr);
      assert.match(refused.stdout, /Refusing to restore/);
      assert.match(refused.stdout, /tmux did not answer/);
      assert.match(refused.stdout, /UNKNOWN/);

      assert.match(refused.stdout, /list-sessions/);

      const forced = await runCli(["restore", name, "--yes", "--force"], { ...cli, env });
      assert.equal(forced.code, 0, forced.stdout + forced.stderr);
      assert.match(forced.stdout, /Restored hive\.db/);
    } finally {
      rmSync(fakeDir, { recursive: true, force: true });
    }
  });

  it("blocks on a tmux failure that is not a timeout either", { skip: hasTmux ? false : "tmux not installed" }, async () => {

    const { cli, name } = await setup();
    const fakeDir = fakeFailingTmux({ failOn: "ls" });
    try {
      const refused = await runCli(["restore", name, "--yes"], {
        ...cli,
        env: { PATH: `${fakeDir}:${process.env.PATH}` },
      });
      assert.equal(refused.code, 1, refused.stdout + refused.stderr);
      assert.match(refused.stdout, /Refusing to restore/);
      assert.match(refused.stdout, /tmux did not answer/);

      assert.match(refused.stdout, /operation not permitted/);
    } finally {
      rmSync(fakeDir, { recursive: true, force: true });
    }
  });

  it("stays silent for a tmux that ANSWERS that no server is running", { skip: hasTmux ? false : "tmux not installed" }, async () => {

    const { cli, name } = await setup();
    const fakeDir = fakeFailingTmux({ failOn: "ls", stderr: "no server running on /tmp/tmux-501/default" });
    try {
      const restored = await runCli(["restore", name, "--yes"], {
        ...cli,
        env: { PATH: `${fakeDir}:${process.env.PATH}` },
      });
      assert.equal(restored.code, 0, restored.stdout + restored.stderr);
      assert.doesNotMatch(restored.stdout, /tmux did not answer/);
      assert.match(restored.stdout, /Restored hive\.db/);
    } finally {
      rmSync(fakeDir, { recursive: true, force: true });
    }
  });

  it("stays silent when tmux is simply not installed", async () => {
    const { cli, name } = await setup();

    const restored = await runCli(["restore", name, "--yes"], {
      ...cli,
      env: { PATH: dirname(process.execPath) },
    });
    assert.equal(restored.code, 0, restored.stdout + restored.stderr);
    assert.doesNotMatch(restored.stdout, /tmux did not answer/);
    assert.match(restored.stdout, /Restored hive\.db/);
  });
});

describe(
  "hive restore refuses a running lead row even against a POPULATED snapshot that does not contain its pane (todo 182 item 1)",
  { skip: hasTmux ? false : "tmux is not installed" },
  () => {
    it("refuses - the pre-R9 code this replaced would have allowed this exact case through", async () => {
      const dirs = scratchDirs();
      const cli = { cwd: dirs.projectDir, dataDir: dirs.dataDir, tmp: dirs.tmp };
      await runCli(["pads"], cli);
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
