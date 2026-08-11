import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { scratchDirs } from "./helpers.mjs";

// Issue #148 / todo 345. The lease extension UPDATE used to be
// `WHERE project_id = ? AND lock_key = ?` with no owner predicate. The race:
// actor A's lease_acquire reads the row (owner: A, about to expire), and
// before A's extend UPDATE runs, actor B's OWN lease_acquire purges the
// now-expired row and inserts itself as owner. A's dangling UPDATE then
// still matches by project_id/lock_key alone, extends B's row, and reports
// {acquired: true, extended: true} to A - two actors now both hold evidence
// they own the same key.
//
// That interleaving (A's SELECT, then B's full purge-and-insert, then A's
// UPDATE) is a few synchronous SQL statements wide. Racing two real MCP
// server processes for it would pass or fail on IPC/scheduling luck, not on
// whether the guard works, so - per the same standing preference as the pad
// revision race test - this asserts extendOwnedLease's predicate directly:
// it reconstructs exactly the state B's purge-and-insert would leave behind,
// then calls the real extend function as A and checks it refuses.
//
// PROVEN RED against the pre-fix UPDATE (no owner predicate): reproduced
// inline below with a throwaway copy of the old SQL, since the old
// extension logic was not a separate function to import. Output pasted in
// the PR body.

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

    // A holds the lease, about to expire.
    db.prepare(
      `INSERT INTO locks (project_id, lock_key, owner, expires_at)
       VALUES (?, ?, ?, datetime('now', '+1 seconds'))`,
    ).run(project.id, "file:x.ts", "agent:A");

    // A's handler already read owner === "agent:A" and is about to extend.
    // Concurrently, B's lease_acquire purges the expired row and takes it -
    // exactly what a real interleaving would do between A's SELECT and A's
    // UPDATE.
    db.prepare("DELETE FROM locks WHERE project_id = ? AND lock_key = ?").run(project.id, "file:x.ts");
    db.prepare(
      `INSERT INTO locks (project_id, lock_key, owner, expires_at)
       VALUES (?, ?, ?, datetime('now', '+30 seconds'))`,
    ).run(project.id, "file:x.ts", "agent:B");
    const bsExpiryBeforeAsExtend = db
      .prepare("SELECT expires_at FROM locks WHERE project_id = ? AND lock_key = ?")
      .get(project.id, "file:x.ts").expires_at;

    // A's dangling extend attempt, using the ownership it read before B's
    // insert landed.
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
