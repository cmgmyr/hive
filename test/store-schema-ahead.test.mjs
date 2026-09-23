import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { isolateTmux, runCli, scratchDirs } from "./helpers.mjs";

const { cleanup } = isolateTmux("store schema ahead tests");
after(() => cleanup());

const helperDirs = scratchDirs();
process.env.HIVE_DATA_DIR = helperDirs.dataDir;
const { storeSchemaAhead, MIGRATIONS } = await import("../dist/db.js");

function cliOptions() {
  const dirs = scratchDirs();
  return { dirs, options: { cwd: dirs.projectDir, dataDir: dirs.dataDir, tmp: dirs.tmp } };
}

async function initialized(options) {
  const init = await runCli(["init", "--no-profile"], options);
  assert.equal(init.code, 0, init.stderr);
}

function addAheadMigration(dataDir) {
  const store = new Database(join(dataDir, "hive.db"));
  try {
    const latest = store.prepare("SELECT MAX(version) AS version FROM migrations").get().version;
    store.prepare("INSERT INTO migrations (version) VALUES (?)").run(latest + 1);
  } finally {
    store.close();
  }
}

describe("store schema ahead reporting", () => {
  it("warns in doctor and marks statusline when the store has a newer migration", async () => {
    const { dirs, options } = cliOptions();
    await initialized(options);
    addAheadMigration(dirs.dataDir);

    const doctor = await runCli(["doctor"], options);
    assert.match(
      doctor.stdout,
      new RegExp(`warn {2}database: store schema v${MIGRATIONS.length + 1} is ahead of this build`),
    );
    assert.match(doctor.stdout, new RegExp(`database: .*schema v${MIGRATIONS.length + 1}`));

    const statusline = await runCli(["statusline"], options);
    assert.match(statusline.stdout, /store ahead \(update hive\)/);
  });

  it("stays silent when the store schema and build agree", async () => {
    const { options } = cliOptions();
    await initialized(options);

    const doctor = await runCli(["doctor"], options);
    assert.doesNotMatch(doctor.stdout, /store schema v\d+ is ahead of this build/);

    const statusline = await runCli(["statusline"], options);
    assert.doesNotMatch(statusline.stdout, /store ahead \(update hive\)/);
  });

  it("treats an empty, missing, or unreadable migrations table as no ahead state", () => {
    const emptyStore = new Database(":memory:");
    try {
      assert.equal(storeSchemaAhead(emptyStore), null);
    } finally {
      emptyStore.close();
    }
    assert.equal(
      storeSchemaAhead({ prepare: () => ({ get: () => ({ version: MIGRATIONS.length - 1 }) }) }),
      null,
    );
    assert.equal(storeSchemaAhead({ prepare: () => { throw new Error("unreadable"); } }), null);
  });
});
