import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { after, describe, it } from "node:test";

import { DIST, REPO, baseEnv, isolateTmux, runCli, scratchDirs } from "./helpers.mjs";

const { cleanup: cleanupTmux } = isolateTmux("read verbs against a store the process cannot write");
const isRoot = process.getuid?.() === 0;
const DB_JS = pathToFileURL(join(DIST, "db.js")).href;
const holders = [];
const lockedDirs = [];

after(() => {
  for (const dir of lockedDirs) unlock(dir);
  for (const h of holders) h.kill();
  cleanupTmux();
});

const FILES = ["hive.db", "hive.db-wal", "hive.db-shm"];

function unlock(dataDir) {
  chmodSync(dataDir, 0o755);
  for (const f of FILES) {
    try {
      chmodSync(join(dataDir, f), 0o644);
    } catch {}
  }
}

function lock(dataDir) {
  for (const f of FILES) chmodSync(join(dataDir, f), 0o444);
  chmodSync(dataDir, 0o555);
  lockedDirs.push(dataDir);
}

function digest(dataDir) {
  return Object.fromEntries(
    readdirSync(dataDir)
      .filter((f) => f.startsWith("hive.db"))
      .map((f) => [f, createHash("sha256").update(readFileSync(join(dataDir, f))).digest("hex")]),
  );
}

const BOOKKEEPING = `CREATE TABLE backup_meta (id INTEGER PRIMARY KEY CHECK (id = 1), last_attempt_at TEXT, last_success_at TEXT, last_error TEXT, last_error_at TEXT);
INSERT INTO backup_meta (id) VALUES (1);`;

async function holdStore(dirs, { v30 = false, v30Bookkeeping = false } = {}) {
  mkdirSync(dirs.dataDir, { recursive: true });
  const script = join(dirs.tmp, "holder.mjs");
  writeFileSync(
    script,
    `import { readFileSync } from "node:fs";
import { db, migrate, MIGRATIONS } from ${JSON.stringify(DB_JS)};
${v30 ? `db.exec(readFileSync(${JSON.stringify(join(REPO, "test", "fixtures", "store-v30.sql"))}, "utf8"));` : "migrate();"}
${v30Bookkeeping ? `db.exec(${JSON.stringify(BOOKKEEPING)});` : ""}
const pid = db.prepare("INSERT INTO projects (name, path) VALUES ('ro', ?) RETURNING id").get(process.env.HOLD_PROJECT).id;
db.prepare("INSERT INTO todos (project_id, title, body) VALUES (?, 'a todo to read', 'its body')").run(pid);
console.log("READY " + MIGRATIONS.length);
setInterval(() => {}, 1000);
`,
  );
  writeFileSync(join(dirs.projectDir, "hive.yml"), "profile: orchestration\n");
  const child = spawn(process.execPath, [script], {
    env: { ...baseEnv(), HIVE_DATA_DIR: dirs.dataDir, HOLD_PROJECT: dirs.projectDir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  holders.push(child);
  let out = "";
  let err = "";
  child.stderr.on("data", (d) => (err += d));
  await new Promise((resolve, reject) => {
    child.stdout.on("data", (d) => {
      out += d;
      if (out.includes("READY")) resolve();
    });
    child.on("exit", () => reject(new Error(`holder exited: ${err}`)));
  });
  return Number(out.match(/READY (\d+)/)[1]);
}

const VERBS = [["profile", "read", "posture.md"], ["profile", "list"], ["runbook"], ["todo", "1"]];
const run = (args, dirs) => runCli(args, { cwd: dirs.projectDir, dataDir: dirs.dataDir });

describe("hive CLI reads against a store the process cannot write", () => {
  const dirs = scratchDirs();
  const writable = {};
  let before;

  it("setup: a current store held open, every verb's writable output captured, then the files made read-only", { skip: isRoot && "root ignores file modes" }, async () => {
    await holdStore(dirs);
    for (const args of VERBS) writable[args.join(" ")] = await run(args, dirs);
    lock(dirs.dataDir);
    before = digest(dirs.dataDir);
    assert.ok(before["hive.db-wal"] && before["hive.db-shm"], "the fixture needs the -wal and -shm files a sandbox leaves behind");
  });

  for (const args of VERBS) {
    it(`hive ${args.join(" ")} exits 0 and prints what it prints on the writable store`, { skip: isRoot && "root ignores file modes" }, async () => {
      const r = await run(args, dirs);
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.code, writable[args.join(" ")].code);
      assert.equal(r.stdout, writable[args.join(" ")].stdout);
      assert.ok(r.stdout.length > 0 || args[0] === "todo", `hive ${args.join(" ")} printed nothing`);
    });
  }

  it("the store's files are byte-identical after the four verbs ran", { skip: isRoot && "root ignores file modes" }, () => {
    assert.deepEqual(digest(dirs.dataDir), before);
  });
});

describe("a read-only store that needs a write", () => {
  it("with migrations pending exits non-zero and names the pending migration count", { skip: isRoot && "root ignores file modes" }, async () => {
    const dirs = scratchDirs();
    const total = await holdStore(dirs, { v30: true, v30Bookkeeping: true });
    lock(dirs.dataDir);
    const r = await run(["profile", "list"], dirs);
    assert.equal(r.code, 1, r.stdout + r.stderr);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, new RegExp(`applying pending migrations failed: .*readonly database \\(${total - 30} migrations pending\\)`));
  });

  it("with the bookkeeping tables missing exits non-zero and says so", { skip: isRoot && "root ignores file modes" }, async () => {
    const dirs = scratchDirs();
    await holdStore(dirs, { v30: true });
    lock(dirs.dataDir);
    const r = await run(["profile", "list"], dirs);
    assert.equal(r.code, 1, r.stdout + r.stderr);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /preparing the store's bookkeeping tables failed: .*readonly database \(bookkeeping tables missing\)/);
  });
});

describe("a fresh writable store", () => {
  it("ends up with both bookkeeping tables, the backup_meta row and every migration applied", async () => {
    const dirs = scratchDirs();
    const total = await holdStore(dirs);
    const probe = join(dirs.tmp, "probe.mjs");
    writeFileSync(
      probe,
      `import { db } from ${JSON.stringify(DB_JS)};
const tables = db.prepare("SELECT name FROM sqlite_master WHERE name IN ('migrations','backup_meta') ORDER BY name").all().map((r) => r.name);
const meta = db.prepare("SELECT id FROM backup_meta").all().map((r) => r.id);
const applied = db.prepare("SELECT COUNT(*) AS n FROM migrations").get().n;
console.log(JSON.stringify({ tables, meta, applied }));
`,
    );
    const { spawnSync } = await import("node:child_process");
    const r = spawnSync(process.execPath, [probe], { encoding: "utf8", env: { ...baseEnv(), HIVE_DATA_DIR: dirs.dataDir } });
    assert.deepEqual(JSON.parse(r.stdout), { tables: ["backup_meta", "migrations"], meta: [1], applied: total });
  });
});
