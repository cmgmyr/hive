import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { McpClient, isolateTmux, scratchDirs } from "./helpers.mjs";

const { cleanup: cleanupTmux } = isolateTmux("the lease-acquire-returning tests");

describe("lease_acquire's success receipt (fix round 1, P1)", () => {
  it("reports the expiry from the row this call itself created, and that row is the real one on disk", async () => {
    const { dataDir, projectDir } = scratchDirs();

    process.env.HIVE_DATA_DIR = dataDir;
    const { db } = await import("../dist/db.js");
    const mcp = new McpClient({ cwd: projectDir, dataDir });
    await mcp.start();
    try {
      const acquired = await mcp.call("lease_acquire", { key: "file:x.ts", ttl_seconds: 30 });
      assert.equal(acquired.acquired, true);
      assert.ok(acquired.expires_at, "the receipt must carry the expiry the INSERT itself produced");

      const row = db.prepare("SELECT expires_at FROM leases WHERE lock_key = ?").get("file:x.ts");
      assert.equal(acquired.expires_at, row.expires_at, "the receipt's expiry must be the row's actual expiry, not a value computed separately");
    } finally {
      await mcp.close();
      cleanupTmux();
    }
  });
});
