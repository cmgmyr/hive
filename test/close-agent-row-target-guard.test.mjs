import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { scratchDirs } from "./helpers.mjs";

// Issue #27's L4 fix round R10, todo 181 item 3 (codex F1). closeAgentRow()
// used to guard only on id and status='running', so a caller that reads
// tmux_target, decides the pane is dead, and calls this later can race a
// DIFFERENT writer recording a fresh pane on the SAME row in between - the
// real case is `hive lead`'s own CAS restarting a lead agent_close just
// probed as confirmed-dead. id and status alone would still match, closing a
// row that is genuinely running again on the strength of a probe that is no
// longer true. expectedTmuxTarget makes the close conditional on the row
// still naming the pane the caller actually probed.
//
// No tmux, no server, just the SQL: closeAgentRow does not touch tmux at
// all, and the race it guards against is a DB write racing a DB write, not
// anything tmux-shaped. Reproducing the real end-to-end race (a concurrent
// `hive lead` CAS landing between agent_close's probe and its own close) has
// no reliable hook to interject on - there is no SQL write between
// findAgent's SELECT and closeAgentRow's UPDATE inside agent_close to hang a
// trigger off, and a real race between two separate processes cannot be
// pointed at that exact gap without either process cooperating with the
// test. This pins the mechanism itself deterministically instead: exactly
// what closeAgentRow does when the column it is asked to expect does or does
// not match what is actually there. agent_close's own existing tests already
// cover the ordinary (non-raced) success path through the real MCP surface.

const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { db, migrate } = await import("../dist/db.js");
const { closeAgentRow } = await import("../dist/spawn.js");
migrate();

let nextProject = 0;

function seedRow(target) {
  const n = nextProject++;
  const project = db.prepare("INSERT INTO projects (name, path) VALUES (?, ?) RETURNING id").get(
    `close-guard-${n}`,
    `/tmp/close-guard-${n}`,
  );
  return db
    .prepare(
      `INSERT INTO agents (project_id, actor_id, name, tmux_target, command, cwd, kind, status)
       VALUES (?, 'lead:999', 'lead', ?, 'claude', '/tmp', 'lead', 'running')
       RETURNING id`,
    )
    .get(project.id, target).id;
}

describe("closeAgentRow's optional expectedTmuxTarget guard", () => {
  it("closes the row when no expected target is given - the pre-existing callers' shape, unchanged", () => {
    const id = seedRow("%whatever");
    assert.equal(closeAgentRow(id), true);
    assert.equal(db.prepare("SELECT status FROM agents WHERE id = ?").get(id).status, "closed");
  });

  it("closes the row when the expected target matches what is actually there", () => {
    const id = seedRow("%matches");
    assert.equal(closeAgentRow(id, "%matches"), true);
    assert.equal(db.prepare("SELECT status FROM agents WHERE id = ?").get(id).status, "closed");
  });

  it("refuses to close, and leaves the row untouched, when the target has changed since the caller probed it", () => {
    const id = seedRow("%probed-as-dead");
    // Stands in for a concurrent `hive lead` CAS recording a fresh pane on
    // this exact row after agent_close's own probe but before its close.
    db.prepare("UPDATE agents SET tmux_target = ? WHERE id = ?").run("%raced-in-by-a-concurrent-hive-lead", id);

    assert.equal(closeAgentRow(id, "%probed-as-dead"), false, "a stale expectation must not close the row");

    const row = db.prepare("SELECT status, tmux_target FROM agents WHERE id = ?").get(id);
    assert.equal(row.status, "running", "the row must survive - it changed out from under the probe");
    assert.equal(
      row.tmux_target,
      "%raced-in-by-a-concurrent-hive-lead",
      "and keep the racer's write, not get silently overwritten",
    );
  });

  it("refuses to close an already-closed row even with a matching target - status still gates every branch", () => {
    const id = seedRow("%already-closed");
    db.prepare("UPDATE agents SET status = 'closed', closed_at = datetime('now') WHERE id = ?").run(id);

    assert.equal(closeAgentRow(id, "%already-closed"), false);
  });
});
