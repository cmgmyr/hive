import assert from "node:assert/strict";
import { dirname } from "node:path";
import { after, describe, it } from "node:test";

import { isolateTmux, makeFakeClaude, runCli, scratchDirs } from "./helpers.mjs";

// Issue #27's L4 fix round, DECISION 6. ensureLeadRow's INSERT, its actor_id
// UPDATE and upsertActor used to be three separate writes. A process dying
// between the first two leaves a running row with actor_id = '' that the
// next invocation used to FIND AND RETURN as if it were a normal hit, so the
// lead launched with HIVE_AGENT_ID= (empty) and the hook wrote neither a
// state log row nor last_seen_at for it - and idx_agents_running_name then
// stood in the way of ever replacing the row outright, since "lead" was
// already taken by it. This pins the fix: the three writes are now one
// transaction, and a damaged row found on a later call is healed in place
// rather than returned as-is or left to collide on a fresh INSERT.

const { hasTmux, cleanup } = isolateTmux("the lead identity transaction tests");

const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { db, migrate } = await import("../dist/db.js");
const { sessionName } = await import("../dist/tmux.js");
migrate();

describe("a damaged lead row (actor_id = '') is healed, not returned or collided on", { skip: hasTmux ? false : "tmux is not installed" }, () => {
  const fakeClaude = makeFakeClaude(dirs.tmp);
  const claudePath = fakeClaude("sleep 600");
  const cliOpts = {
    cwd: dirs.projectDir,
    dataDir: dirs.dataDir,
    tmp: dirs.tmp,
    env: { PATH: `${dirname(claudePath)}:${process.env.PATH}` },
  };
  const project = db
    .prepare("INSERT INTO projects (name, path) VALUES (?, ?) RETURNING id")
    .get("lead-transaction-test", dirs.projectDir);
  const session = sessionName(project.id);

  after(() => cleanup(session));

  it("heals a damaged row into a working identity, rather than launching with HIVE_AGENT_ID empty", async () => {
    // Simulates exactly what a crash between the INSERT and the actor_id
    // UPDATE used to leave behind: a running "lead" row with no actor_id at
    // all.
    const damagedId = db
      .prepare(
        `INSERT INTO agents (project_id, name, command, cwd, kind, status)
         VALUES (?, 'lead', 'claude', ?, 'lead', 'running')
         RETURNING id`,
      )
      .get(project.id, dirs.projectDir).id;
    assert.equal(
      db.prepare("SELECT actor_id FROM agents WHERE id = ?").get(damagedId).actor_id,
      "",
      "sanity check: the seeded row really is damaged",
    );

    const result = await runCli(["lead"], cliOpts);
    assert.equal(result.code, 0, result.stderr);

    const rows = db.prepare("SELECT * FROM agents WHERE project_id = ? AND kind = 'lead'").all(project.id);
    assert.equal(rows.length, 1, "the damaged row must be healed in place, not left behind next to a new one");
    assert.equal(rows[0].id, damagedId, "the SAME row, healed rather than replaced");
    assert.equal(rows[0].actor_id, `lead:${damagedId}`, "a real actor id must be assigned");
    assert.equal(rows[0].status, "running");
    assert.notEqual(rows[0].tmux_target, "", "a live pane must still get recorded on the healed row");

    // upsertActor's other half: the actors table row must exist too, since
    // that is what src/hook.ts's UPDATE and pad/todo attribution key on.
    const actor = db.prepare("SELECT * FROM actors WHERE id = ?").get(rows[0].actor_id);
    assert.ok(actor, "upsertActor must have run as part of healing the row");
    assert.equal(actor.kind, "lead");
  });
});
