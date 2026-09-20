import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { scratchDirs } from "./helpers.mjs";

const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { db, migrate } = await import("../dist/db.js");
const { readLease } = await import("../dist/tools/leases.js");
migrate();

describe("lease_acquire's conflict-path read cannot throw on a released row (fix round 1, P2)", () => {
  it("returns undefined, not a thrown TypeError, when the row is gone", () => {
    const project = db.prepare("INSERT INTO projects (name, path) VALUES (?, ?) RETURNING id").get("p2-conflict", "/tmp/lease-p2-conflict");

    const row = readLease(project.id, "file:x.ts");
    assert.equal(row, undefined);
  });

  it("still returns the real row when one exists, unaffected by the guard", () => {
    const project = db.prepare("INSERT INTO projects (name, path) VALUES (?, ?) RETURNING id").get("p2-conflict-2", "/tmp/lease-p2-conflict-2");
    db.prepare("INSERT INTO actors (id, name, kind) VALUES (?, ?, 'agent')").run("agent:C", "agent:C");
    db.prepare(
      `INSERT INTO leases (project_id, lock_key, owner, expires_at)
       VALUES (?, ?, ?, datetime('now', '+30 seconds'))`,
    ).run(project.id, "file:y.ts", "agent:C");
    const row = readLease(project.id, "file:y.ts");
    assert.equal(row?.owner, "agent:C");
  });
});
