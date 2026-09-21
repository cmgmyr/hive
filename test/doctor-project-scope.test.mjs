import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { isolateTmux, runCli, scratchDirs } from "./helpers.mjs";

const { cleanup } = isolateTmux("the doctor project scope tests");
after(() => cleanup());

describe("hive doctor project scope warnings", () => {
  it("warns once per registered ancestor pair and once per home-directory project, and stays quiet in a store with neither", async () => {
    const clean = scratchDirs();
    const cleanOpts = { cwd: clean.projectDir, dataDir: clean.dataDir, tmp: clean.tmp };
    const cleanDoctor = await runCli(["doctor"], cleanOpts);
    assert.doesNotMatch(cleanDoctor.stdout, /project scope:/);

    const dirs = scratchDirs();
    const home = join(dirs.tmp, "home");
    const ancestor = join(dirs.tmp, "ancestor");
    const child = join(ancestor, "child");
    mkdirSync(child, { recursive: true });
    mkdirSync(home, { recursive: true });
    const opts = {
      cwd: dirs.projectDir,
      dataDir: dirs.dataDir,
      tmp: dirs.tmp,
      env: { HOME: home },
    };
    assert.equal((await runCli(["init", "--no-profile", ancestor], opts)).code, 0);
    assert.equal((await runCli(["init", "--no-profile", child], opts)).code, 0);
    process.env.HIVE_DATA_DIR = dirs.dataDir;
    const { addProject } = await import("../dist/context.js");
    addProject(home);
    delete process.env.HIVE_DATA_DIR;

    const doctor = await runCli(["doctor"], opts);
    const scopeLines = doctor.stdout.split("\n").filter((line) => line.includes("project scope:"));
    assert.equal(scopeLines.length, 2, doctor.stdout);
    assert.match(doctor.stdout, /is a home directory/);
    assert.match(doctor.stdout, /is registered above/);
  });
});
