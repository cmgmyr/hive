import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { scratchDirs } from "./helpers.mjs";

// Fix round 1 on todo 345 / issue #148, P2: lease_acquire's conflict-path
// read used to be `.get(...) as LeaseRow`, a non-optional cast, then
// dereferenced unguarded (`row.owner === actor`). A concurrent
// lease_release can remove that exact row between the failed insert
// attempt and this read - a couple of synchronous SQL statements, the same
// order of narrowness as the owner-extend race this same file already
// guards (test/lease-owner-race.test.mjs), and too tight to hit reliably
// by racing two real processes for the identical reason. The fix extracts
// the read into readLease, typed `LeaseRow | undefined` and guarded at
// both of its call sites (this one, and the extend-lost-race re-read a few
// lines down, which was already guarded before this round - the two used
// to disagree).
//
// PROVEN RED against the pre-fix shape: a throwaway repro of
// `.get(...) as LeaseRow` against an empty locks table, then dereferencing
// `.owner`, threw `TypeError: Cannot read properties of undefined (reading
// 'owner')`. Output pasted in the PR body.

const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { db, migrate } = await import("../dist/db.js");
const { readLease } = await import("../dist/tools/leases.js");
migrate();

describe("lease_acquire's conflict-path read cannot throw on a released row (fix round 1, P2)", () => {
  it("returns undefined, not a thrown TypeError, when the row is gone", () => {
    const project = db.prepare("INSERT INTO projects (name, path) VALUES (?, ?) RETURNING id").get("p2-conflict", "/tmp/lease-p2-conflict");
    // No row for this key at all - the state a release lands the row in,
    // reached between a failed insert attempt and the read that follows it.
    const row = readLease(project.id, "file:x.ts");
    assert.equal(row, undefined);
  });

  it("still returns the real row when one exists, unaffected by the guard", () => {
    const project = db.prepare("INSERT INTO projects (name, path) VALUES (?, ?) RETURNING id").get("p2-conflict-2", "/tmp/lease-p2-conflict-2");
    db.prepare("INSERT INTO actors (id, name, kind) VALUES (?, ?, 'agent')").run("agent:C", "agent:C");
    db.prepare(
      `INSERT INTO locks (project_id, lock_key, owner, expires_at)
       VALUES (?, ?, ?, datetime('now', '+30 seconds'))`,
    ).run(project.id, "file:y.ts", "agent:C");
    const row = readLease(project.id, "file:y.ts");
    assert.equal(row?.owner, "agent:C");
  });
});
