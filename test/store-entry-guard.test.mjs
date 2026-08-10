import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { DIST, REPO, scratchDirs } from "./helpers.mjs";

// Todo 324. test/store-isolation.test.mjs pins the two structural guards that
// keep a TEST RUNNER off ~/.hive; this file pins the guard those two cannot
// see, because it exists for a process that is neither: a hand-rolled step-11
// driver, run as a plain `node driver.mjs` with no NODE_TEST_CONTEXT at all.
// assertScratchStore() answers a different question again -- it is an OPT-IN
// self-check a destructive test file calls to confirm its own isolation
// worked, from the inside. This guard is involuntary and structural: it fires
// on any process reaching the default store, whether or not that process ever
// thought to call assertScratchStore().
//
// The incident, verbatim from the todo: a driver script set HIVE_DATA_DIR in
// the env it handed a CHILD server, then imported dist/db.js in ITSELF to
// seed a row a scratch store starts without. Handing the child its env is the
// obvious half; the parent's own import choosing ~/.hive is the half that
// bites. It changed nothing only because no live agent was named "impl".

const dirs = scratchDirs();

// A fresh, minimal-environment process, deliberately not helpers.mjs's own
// spawn helper: that helper's baseEnv() strips HIVE_* but keeps everything
// else, including NODE_TEST_CONTEXT, and the entire subject here is a driver
// that carries neither. Mirrors test/store-isolation.test.mjs's own pair of
// local helpers with the same shape; not hoisted into helpers.mjs because
// this is the only file that needs an entry point with NO ambient
// test-runner signal at all.
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
    // The incident's precise shape: HIVE_DATA_DIR lives only in an env
    // object meant for a CHILD server, never assigned to this process's own
    // process.env. This process's own db.js import still sees no
    // HIVE_DATA_DIR and defaults to ~/.hive -- the half that bites.
    const { code, stderr } = runFixture(
      "todo-321-shape",
      `const childEnv = { ...process.env, HIVE_DATA_DIR: ${JSON.stringify(dirs.dataDir)} };\n` +
        `void childEnv;\n` +
        `await import("${DIST}/db.js");\n`,
    );
    assert.notEqual(code, 0, "a driver outside hive's own entry points must not reach ~/.hive");
    assert.match(stderr, /^hive: refused to use its real store/, stderr);
    // Pins the RIGHT reason. No NODE_TEST_CONTEXT was ever set here, so a
    // pass could only mean this hit the OLD (test-runner) refusal by
    // accident -- exactly the false green test/CLAUDE.md warns against.
    // Only the not-product-entry wording names the escape hatch.
    assert.match(stderr, /HIVE_ALLOW_DEFAULT_STORE/, stderr);
    assert.doesNotMatch(stderr, /test runner is the entry point/, stderr);
  });

  it("still refuses when the driver's own HIVE_DATA_DIR was never set at all", () => {
    const { code, stderr } = runFixture("no-datadir-at-all", `await import("${DIST}/db.js");\n`);
    assert.notEqual(code, 0);
    assert.match(stderr, /^hive: refused to use its real store/, stderr);
  });

  it("does not arrive as a stack trace", () => {
    // Same reasoning as store-isolation.test.mjs's identical assertion:
    // db.ts commits to a store during an import, so the refusal has to be
    // printed and exited, not thrown out of a module body.
    const { stderr } = runFixture("stack-trace-shape", `await import("${DIST}/db.js");\n`);
    assert.doesNotMatch(stderr, /^\s+at /m, `the refusal must not arrive as a stack trace:\n${stderr}`);
  });
});

describe("the escape hatch", () => {
  // storeDir() only resolves and validates a path -- it opens nothing -- which
  // is what makes it safe to prove these two cases against the REAL default
  // store rather than a stand-in. db.js is deliberately never combined with
  // HIVE_ALLOW_DEFAULT_STORE=1 anywhere in this file: proving the override
  // also lets db.js proceed would mean actually opening ~/.hive/hive.db on
  // whatever machine runs this suite.
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
    // The order inside defaultStoreRefusal() (src/dataDir.ts) is load-bearing:
    // a test runner is refused outright, before the override is ever
    // consulted. Checked here at the storeDir() layer rather than by
    // importing db.js, so even a latent ordering bug could not reach the
    // real store from this test.
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
    // The deliberate improvement over a basename check, pinned so a future
    // simplification back to one fails here instead of shipping quietly: a
    // same-named file OUTSIDE dist/ must not pass.
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
