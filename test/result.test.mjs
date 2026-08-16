import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";

import { DIST, FS_SWAP_IMPORT, runFixture, scratchDirs, storeReplaceScript } from "./helpers.mjs";

describe("run() and an orphaned store", () => {
  it("calls the handler and returns its result when the store is untouched", () => {

    const { dataDir, tmp } = scratchDirs();
    const out = runFixture(
      tmp,
      "normal",
      `const { migrate } = await import(${JSON.stringify(join(DIST, "db.js"))});\n` +
        `const { run } = await import(${JSON.stringify(join(DIST, "result.js"))});\n` +
        `migrate();\n` +
        `let invoked = false;\n` +
        `const result = await run(() => { invoked = true; return "ok-value"; });\n` +
        `process.stdout.write(JSON.stringify({ isError: result.isError ?? false, text: result.content[0].text, invoked }));\n`,
      { HIVE_DATA_DIR: dataDir },
    );
    assert.deepEqual(out, { isError: false, text: "ok-value", invoked: true });
  });

  it("refuses the call and never invokes the handler once the store was replaced", () => {
    const { dataDir, tmp } = scratchDirs();
    const dbPath = JSON.stringify(join(dataDir, "hive.db"));
    const out = runFixture(
      tmp,
      "tripped",
      FS_SWAP_IMPORT +
        `const { migrate } = await import(${JSON.stringify(join(DIST, "db.js"))});\n` +
        `const { run } = await import(${JSON.stringify(join(DIST, "result.js"))});\n` +
        `migrate();\n` +
        storeReplaceScript(dbPath) +
        `let invoked = false;\n` +
        `const result = await run(() => { invoked = true; return "should never be seen"; });\n` +
        `process.stdout.write(JSON.stringify({ isError: result.isError ?? false, text: result.content[0].text, invoked }));\n`,
      { HIVE_DATA_DIR: dataDir },
    );
    assert.equal(out.isError, true);
    assert.equal(out.invoked, false, "the handler must not run once the store was replaced");
    assert.match(out.text, /replaced/i, "names what happened");
    assert.match(out.text, /no longer exists/i, "does not imply the store is intact");
    assert.match(out.text, /may already be lost/i, "names that writes may be lost");
    assert.match(out.text, /restart this session/i, "names the remedy");
  });

  it("refuses a read the same as a write, with no per-call exemption", () => {

    const { dataDir, tmp } = scratchDirs();
    const dbPath = JSON.stringify(join(dataDir, "hive.db"));
    const out = runFixture(
      tmp,
      "read-refused",
      FS_SWAP_IMPORT +
        `const { migrate } = await import(${JSON.stringify(join(DIST, "db.js"))});\n` +
        `const { run } = await import(${JSON.stringify(join(DIST, "result.js"))});\n` +
        `migrate();\n` +
        storeReplaceScript(dbPath) +

        `let invoked = false;\n` +
        `const result = await run(() => { invoked = true; return { actor_id: "user:test" }; });\n` +
        `process.stdout.write(JSON.stringify({ isError: result.isError ?? false, invoked }));\n`,
      { HIVE_DATA_DIR: dataDir },
    );
    assert.deepEqual(out, { isError: true, invoked: false });
  });
});
