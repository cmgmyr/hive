import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { DIST, REPO, scratchDirs } from "./helpers.mjs";

const dirs = scratchDirs();

function runIsolated(argv, env = {}) {
  try {
    const stdout = execFileSync(process.execPath, argv, {
      encoding: "utf8",
      env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, stdout, stderr: "" };
  } catch (e) {
    return { code: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

function runFixture(name, source, env = {}) {
  const file = join(dirs.tmp, `${name}.mjs`);
  writeFileSync(file, source);
  return runIsolated([file], env);
}

describe("a hand-rolled driver outside a test runner", () => {
  it("reproduces the todo-321 incident shape and is now refused", () => {

    const { code, stderr } = runFixture(
      "todo-321-shape",
      `const childEnv = { ...process.env, HIVE_DATA_DIR: ${JSON.stringify(dirs.dataDir)} };\n` +
        `void childEnv;\n` +
        `await import("${DIST}/db.js");\n`,
    );
    assert.notEqual(code, 0, "a driver outside hive's own entry points must not reach ~/.hive");
    assert.match(stderr, /^hive: refused to use its real store/, stderr);

    assert.match(stderr, /HIVE_ALLOW_DEFAULT_STORE/, stderr);
    assert.doesNotMatch(stderr, /test runner is the entry point/, stderr);
  });

  it("still refuses when the driver's own HIVE_DATA_DIR was never set at all", () => {
    const { code, stderr } = runFixture("no-datadir-at-all", `await import("${DIST}/db.js");\n`);
    assert.notEqual(code, 0);
    assert.match(stderr, /^hive: refused to use its real store/, stderr);
  });

  it("does not arrive as a stack trace", () => {

    const { stderr } = runFixture("stack-trace-shape", `await import("${DIST}/db.js");\n`);
    assert.doesNotMatch(stderr, /^\s+at /m, `the refusal must not arrive as a stack trace:\n${stderr}`);
  });
});

describe("the escape hatch", () => {

  it("lets a deliberate one-off through", () => {
    const { code, stdout, stderr } = runFixture(
      "escape-hatch",
      `const { storeDir, DEFAULT_DATA_DIR } = await import("${DIST}/dataDir.js");\n` +
        `process.stdout.write(JSON.stringify(storeDir() === DEFAULT_DATA_DIR));\n`,
      { HIVE_ALLOW_DEFAULT_STORE: "1" },
    );
    assert.equal(code, 0, stderr);
    assert.equal(JSON.parse(stdout), true);
  });

  it("cannot also defeat the test-runner refusal", () => {

    const { code, stderr } = runFixture(
      "escape-hatch-under-runner",
      `const { storeDir } = await import("${DIST}/dataDir.js");\nstoreDir();\n`,
      { NODE_TEST_CONTEXT: "child-v8", HIVE_ALLOW_DEFAULT_STORE: "1" },
    );
    assert.notEqual(code, 0, "HIVE_ALLOW_DEFAULT_STORE must not let a test runner through");
    assert.match(stderr, /test runner is the entry point/, stderr);
  });
});

describe("hive's own entry points", () => {
  const candidates = [
    join(DIST, "cli.js"),
    join(DIST, "index.js"),
    join(DIST, "hook.js"),
    join(DIST, "kickoff.js"),
    join(REPO, "claude-plugin", "kickoff.mjs"),
  ];

  it("recognises each of its five real scripts by exact path", () => {
    const source =
      `const { isProductEntryPoint } = await import("${DIST}/dataDir.js");\n` +
      `const candidates = ${JSON.stringify(candidates)};\n` +
      `const results = {};\n` +
      `for (const c of candidates) { process.argv[1] = c; results[c] = isProductEntryPoint(); }\n` +
      `process.stdout.write(JSON.stringify(results));\n`;
    const { code, stdout, stderr } = runFixture("five-entry-points", source);
    assert.equal(code, 0, stderr);
    const results = JSON.parse(stdout);
    for (const c of candidates) assert.equal(results[c], true, `${c} must be recognised`);
  });

  it("lets a recognised entry point resolve the default store outside a test runner", () => {
    const source =
      `process.argv[1] = ${JSON.stringify(join(DIST, "cli.js"))};\n` +
      `const { storeDir, DEFAULT_DATA_DIR } = await import("${DIST}/dataDir.js");\n` +
      `process.stdout.write(JSON.stringify(storeDir() === DEFAULT_DATA_DIR));\n`;
    const { code, stdout, stderr } = runFixture("recognised-entry-succeeds", source);
    assert.equal(code, 0, stderr);
    assert.equal(JSON.parse(stdout), true);
  });

  it("does not match on basename alone", () => {

    const impostor = join(dirs.tmp, "cli.js");
    writeFileSync(impostor, "");
    const source =
      `process.argv[1] = ${JSON.stringify(impostor)};\n` +
      `const { isProductEntryPoint } = await import("${DIST}/dataDir.js");\n` +
      `process.stdout.write(JSON.stringify(isProductEntryPoint()));\n`;
    const { code, stdout, stderr } = runFixture("impostor-basename", source);
    assert.equal(code, 0, stderr);
    assert.equal(JSON.parse(stdout), false);
  });
});

describe("scratchStoreOnSharedSocket exempts a real product entry point (todo 368 finding E)", () => {

  // HIVE_DATA_DIR is a documented user setting (docs/configuration.md), not evidence of a test or a hand-rolled
  // driver on its own - hive namespaces session names by data-dir tag precisely so a custom store can
  // share the real server. None of these fixtures touch a real tmux binary: scratchStoreOnSharedSocket()
  // only computes paths and reads env, so no isolateTmux() is needed here.

  it("does not refuse a non-default store on the shared socket from one of hive's own entry points", () => {
    const source =
      `process.argv[1] = ${JSON.stringify(join(DIST, "cli.js"))};\n` +
      `const { scratchStoreOnSharedSocket } = await import("${DIST}/tmux.js");\n` +
      `process.stdout.write(JSON.stringify(scratchStoreOnSharedSocket()));\n`;
    const { code, stdout, stderr } = runFixture(
      "product-entry-custom-store",
      source,
      { HIVE_DATA_DIR: dirs.dataDir },
    );
    assert.equal(code, 0, stderr);
    assert.equal(JSON.parse(stdout), false, "a real product entry point with a custom store must not be refused");
  });

  it("still refuses the identical pairing from a hand-rolled driver - not a blanket bypass", () => {
    const source =
      `const { scratchStoreOnSharedSocket } = await import("${DIST}/tmux.js");\n` +
      `process.stdout.write(JSON.stringify(scratchStoreOnSharedSocket()));\n`;
    const { code, stdout, stderr } = runFixture(
      "hand-rolled-custom-store",
      source,
      { HIVE_DATA_DIR: dirs.dataDir },
    );
    assert.equal(code, 0, stderr);
    assert.equal(JSON.parse(stdout), true, "a driver outside hive's own entry points must still be refused");
  });

  it("still refuses under a test runner even from a recognised entry point", () => {
    const source =
      `process.argv[1] = ${JSON.stringify(join(DIST, "cli.js"))};\n` +
      `const { scratchStoreOnSharedSocket } = await import("${DIST}/tmux.js");\n` +
      `process.stdout.write(JSON.stringify(scratchStoreOnSharedSocket()));\n`;
    const { code, stdout, stderr } = runFixture(
      "product-entry-under-test-runner",
      source,
      { HIVE_DATA_DIR: dirs.dataDir, NODE_TEST_CONTEXT: "child-v8" },
    );
    assert.equal(code, 0, stderr);
    assert.equal(JSON.parse(stdout), true, "a test runner must be refused regardless of argv[1]");
  });
});
