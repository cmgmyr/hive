import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { McpClient, isolateTmux, scratchDirs } from "./helpers.mjs";

// Fix round 1 on todo 345 / issue #148, P1: lease_acquire's success receipt
// used to come from a SEPARATE SELECT run after the INSERT, not from the
// INSERT itself. Actor A inserts a short-TTL lease and stalls before that
// follow-up SELECT runs; the lease expires, actor B's own lease_acquire
// purges it and inserts its own; A's SELECT - reached only after the stall -
// then reads B's row, and A's receipt reports B's expiry as evidence of A's
// own acquisition.
//
// The fix reads the expiry back with RETURNING on the INSERT statement
// itself, so the receipt is generated in the exact same statement that
// created the row - there is no later read left to interleave a
// concurrent purge-and-reinsert into. That collapses the vulnerable window
// entirely rather than narrowing it (the same shape as the pad_append
// separator fix in this same round), so unlike the revision and lease-
// extend races there is no interleaving left to reconstruct: nothing runs
// between the INSERT and the receipt being built. This test is therefore an
// ordinary regression check that the RETURNING path reports the row it
// actually created, not a race reconstruction - said plainly rather than
// implying coverage the single-statement fix doesn't leave room for.
//
// PROVEN RED against the pre-fix INSERT-then-SELECT shape: a throwaway
// repro of the exact scenario above (A's insert, a purge-and-reinsert by B
// landing before A's follow-up SELECT, then that SELECT) reported A's
// receipt as acquired:true with B's row's expiry. Output pasted in the PR
// body.

const { cleanup: cleanupTmux } = isolateTmux("the lease-acquire-returning tests");

describe("lease_acquire's success receipt (fix round 1, P1)", () => {
  it("reports the expiry from the row this call itself created, and that row is the real one on disk", async () => {
    const { dataDir, projectDir } = scratchDirs();
    // HIVE_DATA_DIR must be set BEFORE dist/db.js is ever imported in this
    // process - it opens the store in its module body, so an import hoisted
    // above this line would choose the wrong store (test/CLAUDE.md).
    process.env.HIVE_DATA_DIR = dataDir;
    const { db } = await import("../dist/db.js");
    const mcp = new McpClient({ cwd: projectDir, dataDir });
    await mcp.start();
    try {
      const acquired = await mcp.call("lease_acquire", { key: "file:x.ts", ttl_seconds: 30 });
      assert.equal(acquired.acquired, true);
      assert.ok(acquired.expires_at, "the receipt must carry the expiry the INSERT itself produced");

      const row = db.prepare("SELECT expires_at FROM locks WHERE lock_key = ?").get("file:x.ts");
      assert.equal(acquired.expires_at, row.expires_at, "the receipt's expiry must be the row's actual expiry, not a value computed separately");
    } finally {
      await mcp.close();
      cleanupTmux();
    }
  });
});
