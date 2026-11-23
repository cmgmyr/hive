import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { assertScratchStore, clearHiveEnv, scratchDirs } from "./helpers.mjs";

const { dataDir } = scratchDirs();
clearHiveEnv();
process.env.HIVE_DATA_DIR = dataDir;
const { db, migrate } = await import("../dist/db.js");
await assertScratchStore();
const {
  PANE_LEASE_SETTLE_MS,
  PANE_LEASE_TTL_SECONDS,
  extendOwnedLease,
  insertLease,
  paneLeaseKey,
  purgeExpiredLeases,
  readLease,
  releaseOwnedLease,
  releasePaneLease,
  tryAcquirePaneLease,
} = await import("../dist/leaseStore.js");
migrate();

const project = (name) => db.prepare("INSERT INTO projects (name, path) VALUES (?, ?) RETURNING id").get(name, `/tmp/${name}`);
const actor = (id, name = id, kind = "agent") => db.prepare("INSERT INTO actors (id, name, kind) VALUES (?, ?, ?)").run(id, name, kind);

describe("lease store", () => {
  it("generic lease operations preserve scope and ownership", () => {
    const one = project("lease-store-one");
    const two = project("lease-store-two");
    actor("agent:lease-owner");
    actor("agent:lease-other");

    const inserted = insertLease(one.id, "file:one", "agent:lease-owner", 45);
    assert.ok(inserted);
    assert.equal(readLease(one.id, "file:one").expires_at, inserted.expires_at);
    assert.equal(readLease(two.id, "file:one"), undefined);
    assert.equal(insertLease(one.id, "file:one", "agent:lease-other", 45), undefined);
    assert.equal(extendOwnedLease(one.id, "file:one", "agent:lease-other", 60), false);
    assert.equal(extendOwnedLease(one.id, "file:one", "agent:lease-owner", 60), true);
    assert.equal(releaseOwnedLease(one.id, "file:one", "agent:lease-other"), false);
    assert.equal(releaseOwnedLease(one.id, "file:one", "agent:lease-owner"), true);
    assert.equal(readLease(one.id, "file:one"), undefined);
  });

  it("pane lease pins the legacy key TTL and settle values", () => {
    assert.equal(paneLeaseKey("/tmp/tmux:shared/default", "%7"), "wake-pane:/tmp/tmux:shared/default:%7");
    assert.equal(PANE_LEASE_TTL_SECONDS, 6);
    assert.equal(PANE_LEASE_SETTLE_MS, 500);

    const one = project("pane-lease-one");
    const key = paneLeaseKey("/tmp/tmux:shared/default", "%7");
    const scheduler = { id: "hive:scheduler", name: "hive scheduler", kind: "scheduler" };
    const acquiredAt = tryAcquirePaneLease(one.id, "/tmp/tmux:shared/default", "%7", scheduler);
    assert.ok(acquiredAt);
    const row = readLease(one.id, key);
    assert.equal(row.expires_at, acquiredAt);
    assert.equal(row.expires_at, db.prepare("SELECT datetime(?, '+6 seconds') AS value").get(row.acquired_at).value);

    const source = readFileSync(new URL("../dist/leaseStore.js", import.meta.url), "utf8");
    assert.match(source, /expires_at < datetime\('now'\)/, "expired leases use the shipped strict less-than purge");
  });

  it("pane contention excludes scheduler and sender actors", () => {
    const one = project("pane-contention-one");
    const two = project("pane-contention-two");
    const socket = "/tmp/tmux:shared/default";
    const pane = "%7";
    const scheduler = { id: "hive:scheduler", name: "hive scheduler", kind: "scheduler" };
    const sender = { id: "agent:pane-sender", name: "pane sender", kind: "agent" };
    const acquiredAt = tryAcquirePaneLease(one.id, socket, pane, scheduler);
    assert.ok(acquiredAt);
    assert.equal(readLease(one.id, paneLeaseKey(socket, pane)).owner, scheduler.id);
    assert.equal(tryAcquirePaneLease(one.id, socket, pane, sender), null);
    assert.equal(tryAcquirePaneLease(one.id, socket, pane, scheduler), null, "same-owner acquisition does not renew");
    assert.equal(readLease(one.id, paneLeaseKey(socket, pane)).expires_at, acquiredAt);
    assert.ok(tryAcquirePaneLease(two.id, socket, pane, sender), "project scopes the same pane key");
    assert.ok(tryAcquirePaneLease(one.id, socket, "%8", sender), "pane scopes the same socket");
  });

  it("expired purge distinguishes an exact empty key from a project purge", () => {
    const one = project("lease-purge-one");
    const two = project("lease-purge-two");
    actor("agent:lease-purge");
    db.prepare("INSERT INTO leases (project_id, lock_key, owner, expires_at) VALUES (?, ?, ?, datetime('now', '-30 seconds'))")
      .run(one.id, "", "agent:lease-purge");
    db.prepare("INSERT INTO leases (project_id, lock_key, owner, expires_at) VALUES (?, ?, ?, datetime('now', '-30 seconds'))")
      .run(one.id, "other", "agent:lease-purge");
    db.prepare("INSERT INTO leases (project_id, lock_key, owner, expires_at) VALUES (?, ?, ?, datetime('now', '+30 seconds'))")
      .run(one.id, "future", "agent:lease-purge");
    db.prepare("INSERT INTO leases (project_id, lock_key, owner, expires_at) VALUES (?, ?, ?, datetime('now', '-30 seconds'))")
      .run(two.id, "other", "agent:lease-purge");

    purgeExpiredLeases(one.id, "");
    assert.equal(readLease(one.id, ""), undefined);
    assert.ok(readLease(one.id, "other"));
    purgeExpiredLeases(one.id);
    assert.equal(readLease(one.id, "other"), undefined);
    assert.ok(readLease(one.id, "future"));
    assert.ok(readLease(two.id, "other"));
  });

  it("expired pane takeover survives release of the earlier token", () => {
    const one = project("pane-lease-takeover");
    const socket = "/tmp/tmux-takeover/default";
    const pane = "%21";
    const owner = { id: "hive:scheduler", name: "hive scheduler", kind: "scheduler" };
    const firstExpiry = tryAcquirePaneLease(one.id, socket, pane, owner);
    assert.ok(firstExpiry);
    db.prepare("UPDATE leases SET expires_at = datetime('now', '+120 seconds') WHERE project_id = ? AND lock_key = ?")
      .run(one.id, paneLeaseKey(socket, pane));
    const replacement = readLease(one.id, paneLeaseKey(socket, pane));
    assert.notEqual(replacement.expires_at, firstExpiry);

    releasePaneLease(one.id, socket, pane, firstExpiry);
    assert.equal(readLease(one.id, paneLeaseKey(socket, pane)).expires_at, replacement.expires_at);
    releasePaneLease(one.id, socket, pane, replacement.expires_at);
    assert.equal(readLease(one.id, paneLeaseKey(socket, pane)), undefined);
  });
});
