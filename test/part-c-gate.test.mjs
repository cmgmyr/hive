import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { after, describe, it } from "node:test";

import { isolateTmux } from "./helpers.mjs";
import { checkDataDirForResultRecording, McpClient } from "../scripts/part-c-gate.mjs";

const { cleanup: cleanupTmux } = isolateTmux("the part-c-gate script tests");
after(() => cleanupTmux());

describe("McpClient.close()", () => {
  it("resolves promptly when the child already exited before close() was called", async () => {

    const dir = mkdtempSync(join(tmpdir(), "part-c-gate-mcpclient-test-"));
    writeFileSync(join(dir, "index.js"), "process.exit(0);\n");
    try {
      const client = new McpClient(dir, process.env);
      const deadline = Date.now() + 5000;
      while (client.child.exitCode == null && Date.now() < deadline) {
        await sleep(10);
      }
      assert.notEqual(client.child.exitCode, null, "the fake child never exited; test setup is broken");

      const start = Date.now();
      await client.close();
      const elapsedMs = Date.now() - start;
      assert.ok(
        elapsedMs < 1000,
        `close() took ${elapsedMs}ms -- expected well under the 3000ms exit-race timeout, since the child had already exited`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("still waits for a REAL exit after SIGKILL when the child has not exited on its own", async () => {

    const dir = mkdtempSync(join(tmpdir(), "part-c-gate-mcpclient-test-"));
    writeFileSync(join(dir, "index.js"), "setInterval(() => {}, 1000);\n");
    try {
      const client = new McpClient(dir, process.env);
      await sleep(100);
      await client.close();

      assert.equal(client.child.signalCode, "SIGKILL", "close() must not return before the child has actually exited");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("checkDataDirForResultRecording", () => {

  it("refuses when HIVE_DATA_DIR is set but does not exist", () => {
    const missing = join(tmpdir(), `part-c-gate-missing-${Math.random().toString(36).slice(2)}`);
    const refusal = checkDataDirForResultRecording(missing);
    assert.match(refusal, /does not exist -- writing here would silently recreate an empty store/);
  });

  it("accepts when HIVE_DATA_DIR is set and exists", () => {
    assert.equal(checkDataDirForResultRecording(tmpdir()), null);
  });

  it("accepts when HIVE_DATA_DIR is unset -- the ambient default store applies", () => {
    assert.equal(checkDataDirForResultRecording(undefined), null);
  });
});
