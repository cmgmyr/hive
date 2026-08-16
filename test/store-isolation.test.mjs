import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import { after, describe, it } from "node:test";

import { CLI, DIST, REPO, isolateTmux, scratchDirs } from "./helpers.mjs";

const { cleanup: cleanupTmux } = isolateTmux("the store isolation tests");
after(() => cleanupTmux());

const dirs = scratchDirs();

const UNDER_RUNNER = { NODE_TEST_CONTEXT: "child-v8" };

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

function runFixture(name, source, env = {}) {
  const file = join(dirs.tmp, `${name}.mjs`);
  writeFileSync(file, source);
  return runNodeWith([file], env);
}

describe("the hoist-order trap that lost a live store", () => {
  it("no longer points the store at ~/.hive when a dist import is hoisted above the env", () => {

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

    const { code, stderr } = runFixture(
      "hoisted-db",
      `import "${DIST}/db.js";\n` +
        `process.env.HIVE_DATA_DIR = ${JSON.stringify(dirs.dataDir)};\n`,
      UNDER_RUNNER,
    );
    assert.notEqual(code, 0, "opening the real store from a test runner must fail");
    assert.match(stderr, /^hive: refused to use its real store/, stderr);
    assert.match(stderr, /Set HIVE_DATA_DIR/);

    assert.doesNotMatch(stderr, /^\s+at /m, `the refusal must not arrive as a stack trace:\n${stderr}`);
  });

  it("refuses a test that names ~/.hive explicitly", () => {

    const { code, stderr } = runFixture("explicit", `import "${DIST}/db.js";\n`, {
      ...UNDER_RUNNER,
      HIVE_DATA_DIR: join(homedir(), ".hive"),
    });
    assert.notEqual(code, 0);
    assert.match(stderr, /^hive: refused to use its real store/, stderr);
  });

  it("covers a process the suite spawned without passing HIVE_DATA_DIR", () => {

    const { code, stderr } = runNodeWith([CLI, "status"], UNDER_RUNNER);
    assert.notEqual(code, 0, "a child with no HIVE_DATA_DIR must not reach ~/.hive");
    assert.match(stderr, /^hive: refused to use its real store/, stderr);
  });

  it("lets an isolated test open its own store", () => {

    const { code, stdout, stderr } = runFixture(
      "isolated",
      `const { dataDir } = await import("${DIST}/db.js");\nprocess.stdout.write(dataDir);\n`,
      { ...UNDER_RUNNER, HIVE_DATA_DIR: dirs.dataDir },
    );
    assert.equal(code, 0, stderr);
    assert.equal(stdout, dirs.dataDir);
  });

  it("no longer leaves an arbitrary script outside a test runner alone (todo 324)", () => {

    const { code, stdout, stderr } = runFixture(
      "human",
      `const { storeDir, underTestRunner } = await import("${DIST}/dataDir.js");\n` +
        `let dir; try { dir = storeDir(); } catch (e) { dir = e.message; }\n` +
        `process.stdout.write(JSON.stringify({ dir, test: underTestRunner() }));\n`,
      {},
    );
    assert.equal(code, 0, stderr);
    const seen = JSON.parse(stdout);
    assert.equal(seen.test, false, "this process is genuinely not a test runner");
    assert.notEqual(seen.dir, join(homedir(), ".hive"), "an arbitrary script must not reach the real store");
    assert.match(seen.dir, /refused to use its real store/);
  });
});

describe("the guard fires under the runner this suite actually uses", () => {
  it("detects the ambient test runner, not only the one the fixtures declare", async () => {

    const { underTestRunner } = await import("../dist/dataDir.js");
    assert.equal(underTestRunner(), true, "npm test must be recognised as a test runner");
  });
});

describe("naming a store is not opening one", () => {

  it("cannot open the store from the modules layout.test.mjs imports", () => {

    const betterSqlite3Prefix = join(REPO, "node_modules", "better-sqlite3") + sep;
    const { code, stdout, stderr } = runFixture(
      "layout-graph",
      `import { createRequire } from "node:module";\n` +
        `import { loadProjectYml } from "${DIST}/projectYml.js";\n` +
        `import { sessionName } from "${DIST}/tmux.js";\n` +
        `const cache = createRequire(import.meta.url).cache;\n` +
        `let session;\n` +
        `try { session = sessionName(); } catch (e) { session = String(e.message); }\n` +
        `process.stdout.write(JSON.stringify({\n` +
        `  session,\n` +
        `  sqlite: Object.keys(cache).some((k) => k.startsWith(${JSON.stringify(betterSqlite3Prefix)})),\n` +
        `  yml: typeof loadProjectYml,\n` +
        `}));\n`,
      UNDER_RUNNER,
    );
    assert.equal(code, 0, stderr);
    const seen = JSON.parse(stdout);
    assert.equal(seen.sqlite, false, "nothing on this path may pull in better-sqlite3");
    assert.equal(seen.yml, "function");

    assert.match(seen.session, /refused to use its real store/);
  });
});

describe("a symlink to the real store is the real store", () => {
  it("follows the link rather than comparing spellings", async () => {
    const { DEFAULT_DATA_DIR, isDefaultStore, storeDir } = await import("../dist/dataDir.js");
    const { mkdtempSync, rmSync, symlinkSync, existsSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");

    if (!existsSync(DEFAULT_DATA_DIR)) return;

    const dir = mkdtempSync(join(tmpdir(), "hive-symlink-"));
    const link = join(dir, "live-hive");
    symlinkSync(DEFAULT_DATA_DIR, link);
    const saved = process.env.HIVE_DATA_DIR;
    try {

      assert.equal(isDefaultStore(link), true, "the link names the real store");
      assert.equal(isDefaultStore(dir), false, "an ordinary scratch dir still does not");

      process.env.HIVE_DATA_DIR = link;
      assert.throws(() => storeDir(), /refused to use its real store/, "and it is refused");
    } finally {
      if (saved === undefined) delete process.env.HIVE_DATA_DIR;
      else process.env.HIVE_DATA_DIR = saved;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
