import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { DIST, FS_SWAP_IMPORT, runFixture, scratchDirs, storeReplaceScript } from "./helpers.mjs";

// Issue #49. restoreSnapshot renames a new hive.db into place, which orphans
// any process that already opened the old one: same path, different inode,
// no error either side. storeReplaced() in src/db.ts is the detection
// primitive - a latched predicate comparing a fresh statSync against the
// inode the process actually opened.
//
// The latch is process-global state, so each scenario below runs in its own
// child process: a single process cannot both prove "false immediately after
// a normal open" and "true and stuck there once tripped" without one
// contaminating the other's starting condition.

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
    // Its own process and its own fixture, not chained after a replace: a
    // deletion checked once the latch is already tripped from a prior
    // replace never reaches statSync at all (storeReplaced() returns early
    // on the latch), so it would never actually exercise the ENOENT path
    // this case exists to pin.
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
        // A hard link to the just-migrated file, BEFORE swapping anything:
        // a new directory entry pointing at the exact same inode `db` has
        // open, not a copy with an inode of its own. cpSync here would give
        // "the original restored" a NEW inode, which a broken, non-latched
        // implementation (a plain `current !== openedInode` with no latch)
        // would read as "back to normal" and pass this test for the wrong
        // reason.
        `const originalLink = ${dbPath} + ".original-link";\n` +
        `linkSync(${dbPath}, originalLink);\n` +
        storeReplaceScript(dbPath) +
        `const afterReplace = storeReplaced();\n` +
        // Rename the link back onto dbPath: this is the same inode `db` was
        // opened against, restored exactly, not a fresh copy of it. If
        // storeReplaced() re-stat'd instead of latching, this would read as
        // "unreplaced" again; the latch must keep answering true regardless.
        `renameSync(originalLink, ${dbPath});\n` +
        `const afterRestoringOriginal = storeReplaced();\n` +
        `process.stdout.write(JSON.stringify({ afterReplace, afterRestoringOriginal }));\n`,
      { HIVE_DATA_DIR: dataDir },
    );
    assert.deepEqual(out, { afterReplace: true, afterRestoringOriginal: true });
  });

  it("does not trip on a normal restart: a process that opens the file AFTER a swap sees no mismatch", () => {
    // The false-positive case the issue calls out by name. A rename only
    // orphans a process that already had the old file open; a fresh process
    // opening whatever is at the path right now commits to THAT inode and
    // must read as unreplaced.
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

    // Swap the file out from under it while no process has it open, the same
    // way a restart between two sessions would. `mv` between two directories
    // on the same filesystem is a real rename, so dbPath ends up with the
    // swap file's inode, not its old content rewritten in place.
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
