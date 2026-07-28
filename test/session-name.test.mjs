import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

// sessionName reads the data dir once at module load, so each case needs its
// own process with its own env.
const sessionNameUnder = (dataDir) =>
  execFileSync(
    process.execPath,
    ["-e", 'import("./dist/tmux.js").then((m) => process.stdout.write(m.sessionName(1)))'],
    {
      encoding: "utf8",
      env: dataDir === null ? withoutDataDir() : { ...process.env, HIVE_DATA_DIR: dataDir },
    },
  );

function withoutDataDir() {
  const env = { ...process.env };
  delete env.HIVE_DATA_DIR;
  return env;
}

describe("tmux session naming", () => {
  it("keeps the documented hive-<project_id> for the default store", () => {
    assert.equal(sessionNameUnder(null), "hive-1");
    // Naming the default explicitly is still the default, not a third store.
    assert.equal(sessionNameUnder(join(homedir(), ".hive")), "hive-1");
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
});
