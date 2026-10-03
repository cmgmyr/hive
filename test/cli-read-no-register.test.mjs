import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { assertScratchStore, clearHiveEnv, isolateTmux, runCli, scratchDirs } from "./helpers.mjs";

isolateTmux("read verbs never register");
clearHiveEnv();
const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { db, migrate } = await import("../dist/db.js");
await assertScratchStore();
migrate();

const stranger = join(dirs.tmp, "scratchpad");
mkdirSync(stranger, { recursive: true });
const projects = () => db.prepare("SELECT id, path FROM projects").all();

const READ_VERBS = [
  ["pads"],
  ["pad", "anything"],
  ["todos"],
  ["todo", "1"],
  ["runbook"],
  ["posture"],
  ["profile", "read", "posture"],
];

describe("read-only CLI verbs from an unregistered cwd", () => {
  for (const args of READ_VERBS) {
    it(`hive ${args.join(" ")} refuses on stderr with exit 1 and registers nothing`, async () => {
      const before = projects().length;
      const r = await runCli(args, { cwd: stranger, dataDir: dirs.dataDir });
      assert.equal(r.code, 1, r.stdout + r.stderr);
      assert.match(r.stderr, new RegExp(`^hive ${args[0]}.*not a registered hive project.*hive init`));
      assert.equal(r.stdout, "");
      assert.equal(projects().length, before);
      assert.equal(projects().filter((p) => p.path.includes("scratchpad")).length, 0);
    });
  }

  it("runbook given a path to an unregistered dir refuses without registering it", async () => {
    const r = await runCli(["runbook", stranger], { cwd: dirs.tmp, dataDir: dirs.dataDir });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /not a registered hive project/);
    assert.equal(projects().length, 0);
  });

  it("posture and runbook refuse an unregistered git repo without registering it", async () => {
    const gitStranger = join(dirs.tmp, "git-scratchpad");
    mkdirSync(gitStranger, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: gitStranger });

    for (const verb of ["posture", "runbook"]) {
      const before = projects().length;
      const r = await runCli([verb], { cwd: gitStranger, dataDir: dirs.dataDir });
      assert.equal(r.code, 1, r.stdout + r.stderr);
      assert.match(r.stderr, new RegExp(`^hive ${verb}.*not a registered hive project.*hive init`));
      assert.equal(r.stdout, "");
      assert.equal(projects().length, before);
      assert.equal(projects().some((p) => p.path === gitStranger), false);
    }
  });

  it("a registered project still reads", async () => {
    const root = join(dirs.tmp, "real");
    mkdirSync(root, { recursive: true });
    db.prepare("INSERT INTO projects (name, path) VALUES ('real', ?)").run(root);
    const r = await runCli(["pads"], { cwd: root, dataDir: dirs.dataDir });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /No pads in project "real"/);
  });
});
