import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { REPO } from "./helpers.mjs";

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

describe("scripts/run-tests.mjs's LONGEST_FILE_HOIST", () => {
  it("names a test file that exists, so a rename or split cannot leave the hoist pointing at nothing", () => {
    const source = readFileSync(join(REPO, "scripts", "run-tests.mjs"), "utf8");
    const hoisted = source.match(/const LONGEST_FILE_HOIST = "([^"]+)";/)?.[1];
    assert.ok(hoisted, "run-tests.mjs must still declare LONGEST_FILE_HOIST as a string literal");
    assert.ok(existsSync(join(REPO, "test", hoisted)), `LONGEST_FILE_HOIST names test/${hoisted}, which does not exist`);
  });
});
