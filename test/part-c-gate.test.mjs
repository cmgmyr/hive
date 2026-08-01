import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { after, describe, it } from "node:test";

import { isolateTmux } from "./helpers.mjs";
import { checkDataDirForResultRecording, McpClient } from "../scripts/part-c-gate.mjs";

// McpClient spawns a plain node child (never a real hive server in these
// tests -- see the fixtures below), so nothing here actually touches tmux.
// But constructing one trips suite-isolation's own textual scan regardless
// (it cannot tell that apart from a real hive spawn, by design -- see that
// file's own header), so isolate the same way every other file here does.
const { cleanup: cleanupTmux } = isolateTmux("the part-c-gate script tests");
after(() => cleanupTmux());

// A minimal stand-in for a real hive dist/index.js: exits immediately, no MCP
// handshake needed, because this only exercises McpClient's own process
// lifecycle (close()), not protocol behavior. Real hive MCP client behavior
// (start/call/JSON-RPC framing) is exercised for real by scripts/part-c-gate.mjs
// itself when run by hand -- see that file's own header on why it costs real
// tokens and is not part of `npm test`.
describe("McpClient.close()", () => {
  it("resolves promptly when the child already exited before close() was called", async () => {
    // Todo 141 item 7: close() used to attach a `once("exit", ...)` listener
    // unconditionally, but Node emits "exit" exactly once -- if the child
    // exited before close() was ever called, that event is already gone by
    // the time the listener is attached, and only the exit-race's own
    // unref'd 3-second timeout is left to resolve the wait. This pins the
    // fix (checking child.exitCode before attaching the listener) by timing:
    // the buggy shape takes at least 3000ms here (the test's own event loop
    // has other referenced handles keeping it alive long enough for the
    // unref'd timer to actually fire), a fixed close() returns immediately.
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
    // Guards the OTHER direction (todo 130's own fix, kept intact by item 7):
    // close() must not return the instant SIGKILL is merely sent -- it must
    // wait for the process to actually be gone, or cmdDown's rmSync can race
    // a still-dying process's open file descriptors.
    const dir = mkdtempSync(join(tmpdir(), "part-c-gate-mcpclient-test-"));
    writeFileSync(join(dir, "index.js"), "setInterval(() => {}, 1000);\n");
    try {
      const client = new McpClient(dir, process.env);
      await sleep(100); // let it actually start before closing
      await client.close();
      // A SIGKILLed process reports its death via signalCode, not exitCode
      // (which stays null for a signal exit) -- checking exitCode alone here
      // would be the same category of mistake close() itself had to avoid.
      assert.equal(client.child.signalCode, "SIGKILL", "close() must not return before the child has actually exited");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("checkDataDirForResultRecording", () => {
  // Todo 141 item 10: Part B's documented usage is
  // eval "$(node scripts/isolated-hive.mjs up)", which EXPORTS HIVE_DATA_DIR
  // into the interactive shell; it survives a later `down` even though the
  // directory is gone. Without this guard, recordResultInStore would let
  // db.ts silently recreate an empty store there and report success into it.
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
