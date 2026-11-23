import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { assertScratchStore, clearHiveEnv, scratchDirs } from "./helpers.mjs";

const { dataDir } = scratchDirs();
clearHiveEnv();
process.env.HIVE_DATA_DIR = dataDir;
await assertScratchStore();

const { MESSAGE_MAX_ROWS, MESSAGE_METHOD, MESSAGE_RETENTION, MESSAGE_STATUS } = await import("../dist/leadMessage.js");
const { LOG_RETENTION } = await import("../dist/wakeSql.js");

describe("message delivery vocabulary", () => {
  it("message delivery vocabulary keeps the shipped literals", () => {
    assert.deepEqual(MESSAGE_STATUS, {
      socketPending: "socket-pending",
      fallbackPending: "fallback-pending",
      fallbackClaimed: "fallback-claimed",
      complete: "complete",
      failed: "failed",
    });
    assert.deepEqual(MESSAGE_METHOD, {
      socket: "socket",
      pty: "pty",
      ptyAfterSocketTimeout: "pty-after-socket-timeout",
    });
    assert.equal(MESSAGE_RETENTION, "-7 days");
    assert.equal(LOG_RETENTION, "-7 days");
    assert.equal(MESSAGE_MAX_ROWS, 5_000);
  });
});
