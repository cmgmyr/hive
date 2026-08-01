import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { isolateTmux, runCli, scratchDirs, seedTrustedYml } from "./helpers.mjs";

// Issue #27's L4 fix round, DECISION 7c, the hive.yml half. Same shape as a
// worker spawned with name "lead" (test/agent-names.test.mjs), through the
// other door: a hive.yml `processes:` entry named "lead" reaches
// startYmlCommand (src/cli.ts) directly, which never called requireNameFree
// in the first place. Two bugs, not one: its own "already running?" lookup
// carries no kind filter, so it could mistake the REAL lead's row for its
// own and report "already running" without starting anything; and if no
// lead happened to be running yet, launchAgent would take the name outright,
// so the next `hive lead` would collide on idx_agents_running_name the same
// way agent_spawn used to.

const { hasTmux, cleanup } = isolateTmux("the lead reserved process-name tests");

const dirs = scratchDirs();
const opts = { cwd: dirs.projectDir, dataDir: dirs.dataDir, tmp: dirs.tmp };
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { db } = await import("../dist/db.js");
const { sessionName } = await import("../dist/tmux.js");

let projectId;
let session;

before(async () => {
  const init = await runCli(["init"], opts);
  assert.equal(init.code, 0, init.stderr);
  projectId = db.prepare("SELECT id FROM projects LIMIT 1").get().id;
  session = sessionName(projectId);
  await seedTrustedYml({
    db,
    projectId,
    projectDir: dirs.projectDir,
    processes: { lead: "sleep 600", web: "sleep 600" },
  });
});

after(() => cleanup(session));

describe("hive start refuses a process named \"lead\"", { skip: hasTmux ? false : "tmux is not installed" }, () => {
  it("skips it and names the reason, starting nothing", async () => {
    const { code, stdout } = await runCli(["start", "lead"], opts);

    assert.equal(code, 0, stdout);
    assert.match(stdout, /reserved/);
    const rows = db.prepare("SELECT * FROM agents WHERE project_id = ? AND name = 'lead'").all(projectId);
    assert.equal(rows.length, 0, "a refused start must not leave any row behind, of any kind");
  });

  it("does not mistake a REAL running lead for itself and report 'already running'", async () => {
    db.prepare(
      `INSERT INTO agents (project_id, actor_id, name, tmux_target, command, cwd, kind, status)
       VALUES (?, 'lead:1', 'lead', '%9700', 'claude', ?, 'lead', 'running')`,
    ).run(projectId, dirs.projectDir);

    const { code, stdout } = await runCli(["start", "lead"], opts);

    assert.equal(code, 0, stdout);
    assert.doesNotMatch(stdout, /already running/, "the real lead's row must not stand in for the process");
    assert.match(stdout, /reserved/);

    const leadRows = db.prepare("SELECT * FROM agents WHERE project_id = ? AND kind = 'lead'").all(projectId);
    assert.equal(leadRows.length, 1, "the guard must not touch the lead's own row either");

    db.prepare("DELETE FROM agents WHERE project_id = ? AND kind = 'lead'").run(projectId);
  });

  it("still starts an ordinary process, the accept case for this guard", async () => {
    const { code, stdout } = await runCli(["start", "web"], opts);

    assert.equal(code, 0, stdout);
    assert.match(stdout, /started/);
    const row = db
      .prepare("SELECT * FROM agents WHERE project_id = ? AND name = 'web' AND status = 'running'")
      .get(projectId);
    assert.ok(row, "an ordinary hive.yml process must still start");

    db.prepare("DELETE FROM agents WHERE project_id = ? AND name = 'web'").run(projectId);
  });
});
