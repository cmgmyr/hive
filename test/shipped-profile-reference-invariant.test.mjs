import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { after, describe, it } from "node:test";

import { isolateTmux, runCli, scratchDirs } from "./helpers.mjs";

const { cleanup } = isolateTmux("the shipped-profile reference-invariant tests");
after(() => cleanup());

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const shippedDir = join(repoRoot, "profiles", "orchestration");

function copyShippedProfile(destDir) {
  mkdirSync(destDir, { recursive: true });
  for (const file of ["posture.md", "runbook.md", "worker.md"]) {
    writeFileSync(join(destDir, file), readFileSync(join(shippedDir, file), "utf8"));
  }
}

describe("todo 334: shipped profile references only what hive init creates or hive doctor reports", () => {
  it("hive doctor stays quiet against a freshly init'd project on the real shipped profile", async () => {
    const dirs = scratchDirs();
    const opts = { cwd: dirs.projectDir, dataDir: dirs.dataDir, tmp: dirs.tmp };

    const init = await runCli(["init", "--profile", "orchestration"], opts);
    assert.equal(init.code, 0, init.stderr);

    const out = await runCli(["doctor"], opts);

    assert.doesNotMatch(
      out.stdout,
      /profile references/,
      "the shipped profile referenced a pad or path that `hive init` does not create and " +
        "`hive doctor` had to flag as missing - see profiles/orchestration/*.md",
    );
  });

  it("catches a bad reference planted in a scratch copy of the shipped profile text", async () => {
    const dirs = scratchDirs();
    const opts = { cwd: dirs.projectDir, dataDir: dirs.dataDir, tmp: dirs.tmp };

    const copyDir = join(dirs.dataDir, "profiles", "shipped-copy-with-bad-ref");
    copyShippedProfile(copyDir);
    const runbookPath = join(copyDir, "runbook.md");
    writeFileSync(
      runbookPath,
      readFileSync(runbookPath, "utf8") +
        '\nRead the "totally-fake-pad" pad before doing anything, and check `scripts/does-not-exist.mjs`.\n',
    );
    writeFileSync(join(dirs.projectDir, "hive.yml"), "profile: shipped-copy-with-bad-ref\n");

    const init = await runCli(["init"], opts);
    assert.equal(init.code, 0, init.stderr);

    const out = await runCli(["doctor"], opts);

    assert.match(
      out.stdout,
      /info {2}profile references: pad\(s\) referenced but not here: totally-fake-pad$/m,
    );
    assert.match(
      out.stdout,
      /info {2}profile references: path\(s\) referenced but not here: scripts\/does-not-exist\.mjs$/m,
    );
  });
});
