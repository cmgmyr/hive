import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { CLI, DIST, isolateTmux, scratchDirs } from "./helpers.mjs";

// One case spawns `hive status`, which runs the janitor and probes tmux.
const { cleanup: cleanupTmux } = isolateTmux("the store isolation tests");
after(() => cleanupTmux());

// Issue #22. On 2026-07-28 the suite destroyed every agents and timers row in
// the developer's live store. Nothing was wrong with the test that did it
// except the order of two lines: a static `import { configHash } from
// "../dist/projectYml.js"` at the top of test/helpers.mjs is hoisted above the
// test file's body, projectYml pulls in dataDir, and dataDir resolved the
// store once, into a module-level const, from the env as it stood at that
// instant. HIVE_DATA_DIR was set a few lines later, dist/db.js agreed with the
// cached answer, and the between-test DELETEs ran on ~/.hive.
//
// assertScratchStore() shipped after that and works, but it is opt-in and the
// mistake it catches is exactly "did not realise the import order mattered".
// These tests pin the two structural guards that replaced the rule, and every
// case runs in its own process because the whole subject is what a process
// decides at load time.

const dirs = scratchDirs();

// A test runner is the entry point of every case below, stated rather than
// inherited: which of NODE_TEST_CONTEXT or --test the ambient run happens to
// carry is not what any of these are about. See underTestRunner().
const UNDER_RUNNER = { NODE_TEST_CONTEXT: "child-v8" };

// Runs a script in a fresh process and never throws, so a case can assert on a
// refusal and on a success in the same shape.
//
// env REPLACES the environment rather than extending it, which is why this
// does not go through runNode: the point of most of these cases is an exact
// minimal environment, and the "leaves a human alone" one needs
// NODE_TEST_CONTEXT to be absent, which any inherited env would supply.
// TMUX_TMPDIR is passed through so a child that reaches tmux reaches the
// isolated server, not the developer's.
function runNodeWith(argv, env = {}) {
  try {
    const stdout = execFileSync(process.execPath, argv, {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        TMUX_TMPDIR: process.env.TMUX_TMPDIR,
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, stdout, stderr: "" };
  } catch (e) {
    return { code: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

// Fixtures are written into the scratch dir this file already owns. Their
// whole subject is what a process decides while its imports resolve, so each
// one has to be a real file run by a real interpreter.
function runFixture(name, source, env = {}) {
  const file = join(dirs.tmp, `${name}.mjs`);
  writeFileSync(file, source);
  return runNodeWith([file], env);
}

describe("the hoist-order trap that lost a live store", () => {
  it("no longer points the store at ~/.hive when a dist import is hoisted above the env", () => {
    // The incident, reproduced line for line. The import is above the
    // assignment, which is the entire mistake; before the fix this printed
    // the developer's real store and the next DELETE went there.
    const { code, stdout, stderr } = runFixture(
      "incident",
      `import { configHash } from "${DIST}/projectYml.js";\n` +
        `process.env.HIVE_DATA_DIR = ${JSON.stringify(dirs.dataDir)};\n` +
        `const { dataDir } = await import("${DIST}/db.js");\n` +
        `process.stdout.write(dataDir);\n`,
      UNDER_RUNNER,
    );
    assert.equal(code, 0, stderr);
    assert.equal(
      stdout,
      dirs.dataDir,
      "a dist import above the HIVE_DATA_DIR assignment must not decide the store",
    );
  });

  it("refuses the real store outright when the hoisted import is the one that opens it", () => {
    // What resolving at call time cannot fix: db.js picks its store in its own
    // module body, so hoisting THAT above the assignment still asks for the
    // default. There is no answer to give a test runner here, so it refuses.
    const { code, stderr } = runFixture(
      "hoisted-db",
      `import "${DIST}/db.js";\n` +
        `process.env.HIVE_DATA_DIR = ${JSON.stringify(dirs.dataDir)};\n`,
      UNDER_RUNNER,
    );
    assert.notEqual(code, 0, "opening the real store from a test runner must fail");
    assert.match(stderr, /^hive: refused to use its real store/, stderr);
    assert.match(stderr, /Set HIVE_DATA_DIR/);
    // db.ts commits to a store during an import, so the refusal has to be
    // printed and exited the way guardAbi does. A throw out of an ESM module
    // body reaches the user as a stack trace with hive's sentence buried in
    // it, which is the shape CLAUDE.md says to avoid, and a bare
    // /refused to use its real store/ match cannot tell the two apart.
    assert.doesNotMatch(stderr, /^\s+at /m, `the refusal must not arrive as a stack trace:\n${stderr}`);
  });

  it("refuses a test that names ~/.hive explicitly", () => {
    // An explicit HIVE_DATA_DIR pointing at the real store is the thing being
    // prevented, not an exemption from it.
    const { code, stderr } = runFixture("explicit", `import "${DIST}/db.js";\n`, {
      ...UNDER_RUNNER,
      HIVE_DATA_DIR: join(homedir(), ".hive"),
    });
    assert.notEqual(code, 0);
    assert.match(stderr, /^hive: refused to use its real store/, stderr);
  });

  it("covers a process the suite spawned without passing HIVE_DATA_DIR", () => {
    // The guard reads an env var precisely so it crosses a spawn. A helper
    // that forgets to pass dataDir hands the child a real store otherwise, and
    // the child is where every CLI and MCP test does its writing.
    const { code, stderr } = runNodeWith([CLI, "status"], UNDER_RUNNER);
    assert.notEqual(code, 0, "a child with no HIVE_DATA_DIR must not reach ~/.hive");
    assert.match(stderr, /^hive: refused to use its real store/, stderr);
  });

  it("lets an isolated test open its own store", () => {
    // The guard has to be invisible to every test that does this right, or it
    // is just a slower way to fail.
    const { code, stdout, stderr } = runFixture(
      "isolated",
      `const { dataDir } = await import("${DIST}/db.js");\nprocess.stdout.write(dataDir);\n`,
      { ...UNDER_RUNNER, HIVE_DATA_DIR: dirs.dataDir },
    );
    assert.equal(code, 0, stderr);
    assert.equal(stdout, dirs.dataDir);
  });

  it("leaves a human running hive outside a test runner alone", () => {
    // The check is "a test runner is the entry point", not "HIVE_DATA_DIR is
    // unset", so `hive doctor` in a terminal still gets ~/.hive. Asked for as
    // a path rather than by opening it: storeDir touches no disk, and a test
    // proving the real store is reachable must not reach it.
    const { code, stdout, stderr } = runFixture(
      "human",
      `const { storeDir, underTestRunner } = await import("${DIST}/dataDir.js");\n` +
        `process.stdout.write(JSON.stringify({ dir: storeDir(), test: underTestRunner() }));\n`,
      {},
    );
    assert.equal(code, 0, stderr);
    assert.deepEqual(JSON.parse(stdout), { dir: join(homedir(), ".hive"), test: false });
  });
});

describe("the guard fires under the runner this suite actually uses", () => {
  it("detects the ambient test runner, not only the one the fixtures declare", async () => {
    // Every case above states NODE_TEST_CONTEXT itself, which is right for
    // them and leaves one thing unproven: that the signal underTestRunner
    // reads is the one node:test really sets. Without this, Node renaming the
    // variable, or a move to another runner, leaves the guard silently dead
    // with the whole suite still green. This process IS the ambient runner.
    const { underTestRunner } = await import("../dist/dataDir.js");
    assert.equal(underTestRunner(), true, "npm test must be recognised as a test runner");
  });
});

describe("naming a store is not opening one", () => {
  // test/layout.test.mjs imports dist/ statically and never sets
  // HIVE_DATA_DIR, which is the shape that caused the incident. It is safe,
  // and this is why rather than an assurance: neither module it imports can
  // reach the store at all. Pinned as a test because "projectYml and tmux do
  // not touch the database" is a property of an import graph, and an import
  // graph changes without anyone rereading a test file's header.
  it("cannot open the store from the modules layout.test.mjs imports", () => {
    const { code, stdout, stderr } = runFixture(
      "layout-graph",
      `import { createRequire } from "node:module";\n` +
        `import { loadProjectYml } from "${DIST}/projectYml.js";\n` +
        `import { sessionName } from "${DIST}/tmux.js";\n` +
        `const cache = createRequire(import.meta.url).cache;\n` +
        `let session;\n` +
        `try { session = sessionName(1); } catch (e) { session = String(e.message); }\n` +
        `process.stdout.write(JSON.stringify({\n` +
        `  session,\n` +
        `  sqlite: Object.keys(cache).some((k) => k.includes("better") && k.includes("sqlite")),\n` +
        `  yml: typeof loadProjectYml,\n` +
        `}));\n`,
      UNDER_RUNNER,
    );
    assert.equal(code, 0, stderr);
    const seen = JSON.parse(stdout);
    assert.equal(seen.sqlite, false, "nothing on this path may pull in better-sqlite3");
    assert.equal(seen.yml, "function");
    // And naming is refused on the same terms as opening, rather than handing
    // this process "hive-1". Building a string touches no disk, but the string
    // is what kill-session gets pointed at, and hive-1 is a live session.
    assert.match(seen.session, /refused to use its real store/);
  });
});
