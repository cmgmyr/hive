import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { DEFAULT_DATA_DIR, tagFor } from "../dist/dataDir.js";

const nameUnder = (env) =>
  execFileSync(
    process.execPath,
    ["-e", 'import("./dist/tmux.js").then((m) => process.stdout.write(m.sessionName()))'],

    { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] },
  );

const sessionNameUnder = (dataDir) => nameUnder({ ...process.env, HIVE_DATA_DIR: dataDir });

function asHuman(dataDir) {
  const env = { ...process.env, HIVE_ALLOW_DEFAULT_STORE: "1" };
  delete env.NODE_TEST_CONTEXT;
  if (dataDir === null) delete env.HIVE_DATA_DIR;
  else env.HIVE_DATA_DIR = dataDir;
  return env;
}

describe("tmux session naming", () => {
  it("keeps the documented hive-main for the default store", () => {
    assert.equal(nameUnder(asHuman(null)), "hive-main");

    assert.equal(nameUnder(asHuman(join(homedir(), ".hive"))), "hive-main");

    assert.equal(tagFor(DEFAULT_DATA_DIR), "");
  });

  it("treats a symlink to the default store as the default store", () => {

    if (!existsSync(DEFAULT_DATA_DIR)) return;

    const dir = mkdtempSync(join(tmpdir(), "hive-session-symlink-"));
    const link = join(dir, "aliased-hive");
    symlinkSync(DEFAULT_DATA_DIR, link);
    try {
      assert.equal(nameUnder(asHuman(link)), "hive-main", "an alias of the default store is untagged");

      assert.equal(tagFor(link), "");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("gives two aliases of one scratch store the same tag", () => {

    const root = mkdtempSync(join(tmpdir(), "hive-alias-"));
    const real = join(root, "store");
    const link = join(root, "alias");
    mkdirSync(real);
    symlinkSync(real, link);
    try {
      assert.equal(tagFor(link), tagFor(real), "an alias is the same store");
      assert.notEqual(tagFor(real), "", "and neither of them is the default one");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses to name the default store under a test runner", () => {

    const env = { ...process.env, NODE_TEST_CONTEXT: "child-v8" };
    delete env.HIVE_DATA_DIR;
    let stderr = "";
    assert.throws(() => {
      try {
        nameUnder(env);
      } catch (e) {
        stderr = e.stderr ?? "";
        throw e;
      }
    });
    assert.match(stderr, /refused to use its real store/, stderr);
  });

  it("gives an isolated store its own namespace", () => {

    const scratch = sessionNameUnder("/tmp/hive-session-name-a");
    assert.notEqual(scratch, "hive-main");
    assert.match(scratch, /^hive-[0-9a-f]{8}-main$/);
  });

  it("keeps two different stores apart", () => {
    assert.notEqual(
      sessionNameUnder("/tmp/hive-session-name-a"),
      sessionNameUnder("/tmp/hive-session-name-b"),
    );
  });

  it("is stable for the same store across processes", () => {
    assert.equal(
      sessionNameUnder("/tmp/hive-session-name-a"),
      sessionNameUnder("/tmp/hive-session-name-a"),
    );
  });

  it("derives the name without opening the database", () => {

    const probe = mkdtempSync(join(tmpdir(), "hive-session-name-probe-"));
    rmSync(probe, { recursive: true, force: true });
    sessionNameUnder(probe);
    assert.equal(
      existsSync(join(probe, "hive.db")),
      false,
      "resolving a session name must not create a database",
    );
    assert.equal(existsSync(probe), false, "nor the data directory itself");
  });

  it("answers for the store as it is now, not as it was when tmux.js loaded", () => {

    const both = execFileSync(
      process.execPath,
      [
        "-e",
        'import("./dist/tmux.js").then((m) => {' +
          "  const before = m.sessionName();" +
          '  process.env.HIVE_DATA_DIR = "/tmp/hive-session-name-a";' +
          "  process.stdout.write(JSON.stringify({ before, after: m.sessionName() }));" +
          "})",
      ],
      { encoding: "utf8", env: asHuman(null) },
    );
    const seen = JSON.parse(both);
    assert.equal(seen.before, "hive-main");
    assert.match(seen.after, /^hive-[0-9a-f]{8}-main$/);
  });
});
