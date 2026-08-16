import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { scratchDirs } from "./helpers.mjs";

process.env.HIVE_DATA_DIR = scratchDirs().dataDir;
const { db, migrate } = await import("../dist/db.js");
const { extendOwnedLease } = await import("../dist/tools/leases.js");
migrate();

function makeProject(name) {
  return db.prepare("INSERT INTO projects (name, path) VALUES (?, ?) RETURNING id").get(name, `/tmp/lease-race-${name}`);
}

function makeActor(id) {
  db.prepare("INSERT INTO actors (id, name, kind) VALUES (?, ?, 'agent')").run(id, id);
}

describe("lease owner race (todo 345 / issue #148)", () => {
  it("does not extend a lease that changed owner between the read and the write", () => {
    const project = makeProject("owner-race-1");
    makeActor("agent:A");
    makeActor("agent:B");

    db.prepare(
      `INSERT INTO locks (project_id, lock_key, owner, expires_at)
       VALUES (?, ?, ?, datetime('now', '+1 seconds'))`,
    ).run(project.id, "file:x.ts", "agent:A");

    db.prepare("DELETE FROM locks WHERE project_id = ? AND lock_key = ?").run(project.id, "file:x.ts");
    db.prepare(
      `INSERT INTO locks (project_id, lock_key, owner, expires_at)
       VALUES (?, ?, ?, datetime('now', '+30 seconds'))`,
    ).run(project.id, "file:x.ts", "agent:B");
    const bsExpiryBeforeAsExtend = db
      .prepare("SELECT expires_at FROM locks WHERE project_id = ? AND lock_key = ?")
      .get(project.id, "file:x.ts").expires_at;

    const extended = extendOwnedLease(project.id, "file:x.ts", "agent:A", 60);
    assert.equal(extended, false, "A must not be told it extended a lease it no longer owns");

    const row = db.prepare("SELECT owner, expires_at FROM locks WHERE project_id = ? AND lock_key = ?").get(project.id, "file:x.ts");
    assert.equal(row.owner, "agent:B", "the row must still belong to B");
    assert.equal(row.expires_at, bsExpiryBeforeAsExtend, "B's expiry must be untouched by A's failed extend");
  });

  it("still extends when the caller genuinely owns the row", () => {
    const project = makeProject("owner-race-2");
    makeActor("agent:C");
    db.prepare(
      `INSERT INTO locks (project_id, lock_key, owner, expires_at)
       VALUES (?, ?, ?, datetime('now', '+1 seconds'))`,
    ).run(project.id, "file:y.ts", "agent:C");

    const extended = extendOwnedLease(project.id, "file:y.ts", "agent:C", 60);
    assert.equal(extended, true);
  });
});
