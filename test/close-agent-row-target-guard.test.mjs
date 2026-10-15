import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { scratchDirs } from "./helpers.mjs";

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

describe("closeAgentRow's optional identity guard", () => {
  it("closes the row when no expected identity is given", () => {
    const id = seedRow("%whatever");
    assert.equal(closeAgentRow(id), true);
    assert.equal(db.prepare("SELECT status FROM agents WHERE id = ?").get(id).status, "closed");
  });
});

describe("closeAgentRow's identity-object guard", () => {
  const identity = { tmux_target: "%7", tmux_socket: "/tmp/sock", pane_pid: "4242" };
  const seedIdentity = () => {
    const id = seedRow(identity.tmux_target);
    db.prepare("UPDATE agents SET tmux_socket = ?, pane_pid = ? WHERE id = ?").run(identity.tmux_socket, identity.pane_pid, id);
    return id;
  };
  const rowOf = (id) => db.prepare("SELECT status, closed_at, tmux_target, tmux_socket, pane_pid FROM agents WHERE id = ?").get(id);

  it("closes the row when target, socket and pid all match", () => {
    const id = seedIdentity();
    assert.equal(closeAgentRow(id, { ...identity }), true);
    assert.equal(rowOf(id).status, "closed");
  });

  for (const [field, republished] of [
    ["tmux_target", "%8"],
    ["tmux_socket", "/tmp/other-sock"],
    ["pane_pid", "5151"],
  ]) {
    it(`refuses, leaving the republished row untouched, when only ${field} changed under it`, () => {
      const id = seedIdentity();
      db.prepare(`UPDATE agents SET ${field} = ? WHERE id = ?`).run(republished, id);
      const before = rowOf(id);
      assert.equal(closeAgentRow(id, { ...identity }), false);
      assert.deepEqual(rowOf(id), before);
      assert.equal(before.status, "running");
      assert.equal(before.closed_at, null);
    });
  }

  it("returns false for a row that is already closed", () => {
    const id = seedIdentity();
    assert.equal(closeAgentRow(id), true);
    assert.equal(closeAgentRow(id, { ...identity }), false);
  });
});
