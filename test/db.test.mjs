import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { DIST, FS_SWAP_IMPORT, runFixture, scratchDirs, storeReplaceScript } from "./helpers.mjs";

describe("storeReplaced()", () => {
  it("is false for a normally-opened store, and stays false across repeated calls", () => {
    const { dataDir, tmp } = scratchDirs();
    const out = runFixture(
      tmp,
      "normal",
      `const { migrate, storeReplaced } = await import(${JSON.stringify(join(DIST, "db.js"))});\n` +
        `migrate();\n` +
        `process.stdout.write(JSON.stringify({ first: storeReplaced(), second: storeReplaced() }));\n`,
      { HIVE_DATA_DIR: dataDir },
    );
    assert.deepEqual(out, { first: false, second: false });
  });

  it("is true once the file is replaced by a different inode", () => {
    const { dataDir, tmp } = scratchDirs();
    const dbPath = JSON.stringify(join(dataDir, "hive.db"));
    const out = runFixture(
      tmp,
      "replaced",
      FS_SWAP_IMPORT +
        `const { migrate, storeReplaced } = await import(${JSON.stringify(join(DIST, "db.js"))});\n` +
        `migrate();\n` +
        `const before = storeReplaced();\n` +
        storeReplaceScript(dbPath) +
        `const afterReplace = storeReplaced();\n` +
        `process.stdout.write(JSON.stringify({ before, afterReplace }));\n`,
      { HIVE_DATA_DIR: dataDir },
    );
    assert.deepEqual(out, { before: false, afterReplace: true });
  });

  it("is true when the file is deleted entirely", () => {

    const { dataDir, tmp } = scratchDirs();
    const dbPath = JSON.stringify(join(dataDir, "hive.db"));
    const out = runFixture(
      tmp,
      "deleted",
      `import { rmSync } from "node:fs";\n` +
        `const { migrate, storeReplaced } = await import(${JSON.stringify(join(DIST, "db.js"))});\n` +
        `migrate();\n` +
        `const before = storeReplaced();\n` +
        `rmSync(${dbPath}, { force: true });\n` +
        `const afterDelete = storeReplaced();\n` +
        `process.stdout.write(JSON.stringify({ before, afterDelete }));\n`,
      { HIVE_DATA_DIR: dataDir },
    );
    assert.deepEqual(out, { before: false, afterDelete: true });
  });

  it("stays true (latched) after the original file is put back", () => {
    const { dataDir, tmp } = scratchDirs();
    const dbPath = JSON.stringify(join(dataDir, "hive.db"));
    const out = runFixture(
      tmp,
      "latched-after-restore",
      `import { linkSync } from "node:fs";\n` +
        FS_SWAP_IMPORT +
        `const { migrate, storeReplaced } = await import(${JSON.stringify(join(DIST, "db.js"))});\n` +
        `migrate();\n` +

        `const originalLink = ${dbPath} + ".original-link";\n` +
        `linkSync(${dbPath}, originalLink);\n` +
        storeReplaceScript(dbPath) +
        `const afterReplace = storeReplaced();\n` +

        `renameSync(originalLink, ${dbPath});\n` +
        `const afterRestoringOriginal = storeReplaced();\n` +
        `process.stdout.write(JSON.stringify({ afterReplace, afterRestoringOriginal }));\n`,
      { HIVE_DATA_DIR: dataDir },
    );
    assert.deepEqual(out, { afterReplace: true, afterRestoringOriginal: true });
  });

  it("does not trip on a normal restart: a process that opens the file AFTER a swap sees no mismatch", () => {

    const { dataDir, tmp } = scratchDirs();
    const dbPath = join(dataDir, "hive.db");

    runFixture(
      tmp,
      "first-open",
      `const { migrate } = await import(${JSON.stringify(join(DIST, "db.js"))});\n` +
        `migrate();\n` +
        `process.stdout.write("{}");\n`,
      { HIVE_DATA_DIR: dataDir },
    );

    const swapDir = join(tmp, "swap-source");
    mkdirSync(swapDir, { recursive: true });
    runFixture(
      swapDir,
      "produce-swap-source",
      `const { migrate } = await import(${JSON.stringify(join(DIST, "db.js"))});\n` +
        `migrate();\n` +
        `process.stdout.write("{}");\n`,
      { HIVE_DATA_DIR: swapDir },
    );
    const beforeSwap = statSync(dbPath).ino;
    spawnSync("mv", [join(swapDir, "hive.db"), dbPath]);
    assert.notEqual(statSync(dbPath).ino, beforeSwap, "precondition: the swap actually changed the inode");

    const out = runFixture(
      tmp,
      "second-open",
      `const { migrate, storeReplaced } = await import(${JSON.stringify(join(DIST, "db.js"))});\n` +
        `migrate();\n` +
        `process.stdout.write(JSON.stringify({ replaced: storeReplaced() }));\n`,
      { HIVE_DATA_DIR: dataDir },
    );
    assert.deepEqual(out, { replaced: false });
  });
});
