import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { isolateTmux, runCli, scratchDirs } from "./helpers.mjs";

// Issue #23. `hive backups` and `hive restore` themselves never touch tmux,
// but runCli spawns hive, and every hive command runs migrate() first; the
// suite's own isolation guard (test/suite-isolation.test.mjs) does not
// distinguish by subcommand, so isolate like every other runCli-based file.
const { cleanup: cleanupTmux } = isolateTmux("the backup CLI tests");
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
