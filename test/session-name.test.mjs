import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { DEFAULT_DATA_DIR, tagFor } from "../dist/dataDir.js";

// A process per case, each with its own env. sessionName reads the data dir
// when asked rather than at module load, so this is no longer the only way to
// vary the store (see the call-time case at the bottom of this file); it stays
// because it exercises the whole path a real hive process takes, from an env
// var through to a name, rather than a function call in a process that already
// decided.
const nameUnder = (env) =>
  execFileSync(
    process.execPath,
    ["-e", 'import("./dist/tmux.js").then((m) => process.stdout.write(m.sessionName(1)))'],
    // stderr piped rather than inherited, so the refusal case can read it
    // instead of printing it into the suite's output.
    { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] },
  );

const sessionNameUnder = (dataDir) => nameUnder({ ...process.env, HIVE_DATA_DIR: dataDir });

// The default store is reachable only when a test runner is NOT the entry
// point, so the cases that want it ask the way a human at a terminal does.
// This process cannot ask: hive refuses to name a store it would refuse to
// open, because the name is what kill-session gets pointed at.
function asHuman(dataDir) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  if (dataDir === null) delete env.HIVE_DATA_DIR;
  else env.HIVE_DATA_DIR = dataDir;
  return env;
}

describe("tmux session naming", () => {
  it("keeps the documented hive-<project_id> for the default store", () => {
    assert.equal(nameUnder(asHuman(null)), "hive-1");
    // Naming the default explicitly is still the default, not a third store.
    assert.equal(nameUnder(asHuman(join(homedir(), ".hive"))), "hive-1");
    // And the pure half, in this process: an empty tag is what makes that
    // name. tagFor takes the directory, so a caller that genuinely means the
    // default store can say so without being handed one it may not use.
    assert.equal(tagFor(DEFAULT_DATA_DIR), "");
  });

  it("treats a symlink to the default store as the default store", () => {
    // The gap e0d6be5 left. isDefaultStore() taught storeDir/guardStoreDir and
    // untrustedTmuxServer to follow symlinks, but tagFor kept comparing
    // strings, and sessionName reaches tagFor through dataDirTag. So
    // HIVE_DATA_DIR symlinked at ~/.hive produced a hash-tagged name for the
    // same project that hive-1 names under the literal path.
    //
    // That is not cosmetic. A session name is the target argument for
    // kill-session and respawn-pane, which is the whole reason dataDirTag was
    // pulled behind the guard in the first place. One project answering to two
    // names means agent_close aims at hive-1 while the workers live under
    // <hash>-1: workers you cannot reach and a session you cannot kill.
    //
    // Safe to run: dist/tmux.js imports dist/dataDir.js and nothing else, so
    // resolving a NAME opens no database. If tmux.ts ever gains a db import,
    // this case has to be rethought.
    if (!existsSync(DEFAULT_DATA_DIR)) return;

    const dir = mkdtempSync(join(tmpdir(), "hive-session-symlink-"));
    const link = join(dir, "aliased-hive");
    symlinkSync(DEFAULT_DATA_DIR, link);
    try {
      assert.equal(nameUnder(asHuman(link)), "hive-1", "an alias of the default store is untagged");
      // The pure half, in this process. tagFor still takes a directory, so a
      // caller naming one gets an answer about that directory; it just answers
      // about where the directory IS rather than how it is spelled.
      assert.equal(tagFor(link), "");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("gives two aliases of one scratch store the same tag", () => {
    // The half the default-store case cannot show. The hash takes the
    // canonical path, not just the comparison, so the rule is one rule: two
    // spellings of one store share a namespace wherever that store is. Without
    // it the identical split happens one store further out, and the failure is
    // the same one - a project answering to two session names.
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
    // The hole this closes. A session name is the target argument for
    // kill-session and respawn-pane, so an unisolated test asking for
    // sessionName(1) used to get "hive-1" -- the live session of whatever real
    // project is id 1 -- and agent_close would have killed it with its workers
    // inside. Refusing costs a test nothing: every test that names a session
    // already sets HIVE_DATA_DIR.
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
    // Project ids restart at 1 in a scratch store, so without this a scratch
    // instance resolves to the live session of whatever project is really id
    // 1 -- which is how a test run once split panes into a live lead window.
    const scratch = sessionNameUnder("/tmp/hive-session-name-a");
    assert.notEqual(scratch, "hive-1");
    assert.match(scratch, /^hive-[0-9a-f]{8}-1$/);
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
    // tmux.js must not pull in db.js: importing it would create and migrate a
    // store as a side effect, including in tests that only inspect names.
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
    // The half the subprocess cases cannot see. dataDirTag used to be a
    // module-level const, so a process that imported tmux.js before setting
    // HIVE_DATA_DIR kept naming sessions after the store it no longer used.
    // Two names from ONE process, either side of the assignment. Run as a
    // human, because "before" is the default store and hive will not name that
    // one for a test runner.
    const both = execFileSync(
      process.execPath,
      [
        "-e",
        'import("./dist/tmux.js").then((m) => {' +
          "  const before = m.sessionName(1);" +
          '  process.env.HIVE_DATA_DIR = "/tmp/hive-session-name-a";' +
          "  process.stdout.write(JSON.stringify({ before, after: m.sessionName(1) }));" +
          "})",
      ],
      { encoding: "utf8", env: asHuman(null) },
    );
    const seen = JSON.parse(both);
    assert.equal(seen.before, "hive-1");
    assert.match(seen.after, /^hive-[0-9a-f]{8}-1$/);
  });
});
