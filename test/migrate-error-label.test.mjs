import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it } from "node:test";

import { assertScratchStore, baseEnv, REPO, scratchDirs } from "./helpers.mjs";

const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
await assertScratchStore();
const { db, migrate, MIGRATIONS } = await import("../dist/db.js");

if (!db.name.startsWith(dirs.dataDir)) throw new Error(`refusing: opened ${db.name}`);

migrate();

const LAST_VERSION = MIGRATIONS.length;

db.prepare("DELETE FROM migrations WHERE version = ?").run(LAST_VERSION);
db.close();

const DB_JS_URL = pathToFileURL(join(REPO, "dist", "db.js")).href;
const script = join(dirs.tmp, "migrate-fail.mjs");
writeFileSync(script, `import { migrate } from ${JSON.stringify(DB_JS_URL)};\nmigrate();\n`);

const result = spawnSync(process.execPath, [script], {
  encoding: "utf8",
  env: { ...baseEnv(), HIVE_DATA_DIR: dirs.dataDir, HIVE_AUTO_ATTACH: "0" },
});

describe("a migration that fails for a reason other than SQLITE_BUSY (todo 1493)", () => {
  it("exits 1, same as a busy failure", () => {
    assert.equal(result.status, 1, result.stderr);
  });

  it("names the pending-migrations step and the failing migration's version", () => {
    assert.match(result.stderr, /applying pending migrations failed/);
    assert.match(result.stderr, new RegExp(`migration ${LAST_VERSION}\\b`));
  });

  it("carries the underlying SQL error", () => {
    assert.match(result.stderr, /duplicate column name/);
  });

  it("never claims the write lock never freed or points at a wedged process", () => {
    assert.doesNotMatch(result.stderr, /write lock|wedged/);
  });
});
