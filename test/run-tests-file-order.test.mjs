import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

// Todo 423. scripts/run-tests.mjs hoists its longest file to the front of the
// schedule by spelling THAT file's path absolute while every other file
// stays "test/...", because node --test sorts its file list by path STRING
// before scheduling and "/" < "t" means an absolute spelling always sorts
// first. That's an implementation detail of node's own test runner, not a
// documented contract - see the comment above LONGEST_FILE_HOIST in
// scripts/run-tests.mjs. This pins the assumption directly, so a future node
// upgrade that changes it fails HERE instead of the suite quietly getting
// slower again with nothing going red.
//
// The fixture is built to rule out the other two plausible orderings, not
// just to demonstrate the intended one: the absolute-pathed file is given
// SECOND on argv (so argv order alone would run the other file first) and
// sorts AFTER it by name alone (so a plain alphabetical-by-name sort would
// also run the other file first). Only "an absolute spelling sorts before a
// relative one" puts it first, so a pass here is specific to the mechanism
// the hoist actually relies on.

const scratchDirs = [];
after(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

function writeFixture(dir, name, markerPath) {
  const path = join(dir, name);
  writeFileSync(
    path,
    `import { test } from "node:test";\n` +
      `import { appendFileSync } from "node:fs";\n` +
      `appendFileSync(${JSON.stringify(markerPath)}, ${JSON.stringify(name)} + "\\n");\n` +
      `test(${JSON.stringify(name)}, () => {});\n`,
  );
  return path;
}

describe("node --test's own file-list sort, which the longest-file hoist relies on", () => {
  it("starts an absolute-pathed file before a relative one, even when the relative one is given first on argv and would sort first by name alone", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hive-order-fixture-"));
    scratchDirs.push(dir);
    const markerPath = join(dir, "marker.log");
    writeFileSync(markerPath, "");

    writeFixture(dir, "aaa.test.mjs", markerPath);
    const absoluteFile = writeFixture(dir, "zzz.test.mjs", markerPath);

    // Strip NODE_TEST_CONTEXT/NODE_TEST_WORKER_ID: this file itself runs
    // under node --test, which sets them, and a nested `node --test` that
    // inherits them behaves as a coverage-collection child rather than a
    // normal top-level run - it exits 0 having never executed the fixtures'
    // top-level code, which reads as "test passed" while proving nothing.
    // The production hoist never hits this: scripts/run-tests.mjs's child is
    // spawned from a plain `node scripts/run-tests.mjs`, never from inside
    // another node --test.
    const childEnv = { ...process.env };
    delete childEnv.NODE_TEST_CONTEXT;
    delete childEnv.NODE_TEST_WORKER_ID;

    const { code, stderr } = await new Promise((resolve) => {
      const child = spawn(process.execPath, ["--test", "--test-concurrency=1", "aaa.test.mjs", absoluteFile], {
        cwd: dir,
        env: childEnv,
        stdio: ["ignore", "ignore", "pipe"],
      });
      let stderr = "";
      child.stderr.on("data", (c) => (stderr += c));
      child.on("exit", (c) => resolve({ code: c, stderr }));
    });
    assert.equal(code, 0, `the fixture files themselves must pass; stderr: ${stderr}`);

    const order = readFileSync(markerPath, "utf8").trim().split("\n");
    assert.deepEqual(
      order,
      ["zzz.test.mjs", "aaa.test.mjs"],
      "node --test should have started the absolute-pathed file first; if this fails, node no longer " +
        "sorts an absolute spelling ahead of a relative one, and scripts/run-tests.mjs's longest-file " +
        "hoist (LONGEST_FILE_HOIST) has silently stopped working",
    );
  });
});
