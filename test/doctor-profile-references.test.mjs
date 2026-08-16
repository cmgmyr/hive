import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { failureCount, isolateTmux, runCli, scratchDirs, warningCount } from "./helpers.mjs";

const { cleanup } = isolateTmux("the doctor profile-references tests");
after(() => cleanup());

const dirs = scratchDirs();
const opts = { cwd: dirs.projectDir, dataDir: dirs.dataDir, tmp: dirs.tmp };
const ymlPath = join(dirs.projectDir, "hive.yml");

function writesideprojRepro() {
  const dir = join(dirs.dataDir, "profiles", "sideproj-repro");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "posture.md"), "# posture\nMinimal.\n");
  writeFileSync(
    join(dir, "runbook.md"),
    [
      "# sideproj repro runbook",
      'Read the "board" pad first, always - a new project has only this one.',
      'Read the "goal-prompts" pad before drafting a goal.',
      'Append to the "lane-ledger" pad when you ship.',
      "THE COVERING RULES live under `.claude/rules/` in the main checkout.",
      "See also `docs/notes.md`, which every project on this profile carries.",
    ].join("\n") + "\n",
  );
  writeFileSync(
    join(dir, "worker.md"),
    "# sideproj repro worker\nThe matcher script is `scripts/covering-rules.mjs`.\n",
  );

  writeFileSync(join(dirs.projectDir, "docs", "notes.md"), "notes\n");
}

describe("todo 332: referenced-but-missing pads and paths", () => {
  it("catches all four sideproj regression cases, and stays non-gating", async () => {

    const init = await runCli(["init"], opts);
    assert.equal(init.code, 0, init.stderr);
    const baseline = await runCli(["doctor"], opts);

    mkdirSync(join(dirs.projectDir, "docs"), { recursive: true });
    writesideprojRepro();
    writeFileSync(ymlPath, "profile: sideproj-repro\n");

    const out = await runCli(["doctor"], opts);

    assert.match(
      out.stdout,
      /info {2}profile references: pad\(s\) referenced but not here: goal-prompts, lane-ledger$/m,
    );

    assert.match(
      out.stdout,
      /info {2}profile references: path\(s\) referenced but not here: \.claude\/rules\/, scripts\/covering-rules\.mjs$/m,
    );
    assert.doesNotMatch(out.stdout, /docs\/notes\.md/);

    assert.equal(failureCount(out.stdout), failureCount(baseline.stdout));
    assert.equal(warningCount(out.stdout), warningCount(baseline.stdout));
  });

  it("stays quiet on the zero-state: every reference resolves", async () => {
    const fresh = scratchDirs();
    const freshOpts = { cwd: fresh.projectDir, dataDir: fresh.dataDir, tmp: fresh.tmp };
    const dir = join(fresh.dataDir, "profiles", "all-clean");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "posture.md"), "# posture\n");
    writeFileSync(join(dir, "runbook.md"), 'Read the "board" pad, always present from `hive init`.\n');
    writeFileSync(join(fresh.projectDir, "hive.yml"), "profile: all-clean\n");
    const init = await runCli(["init"], freshOpts);
    assert.equal(init.code, 0, init.stderr);

    const out = await runCli(["doctor"], freshOpts);

    assert.doesNotMatch(out.stdout, /profile references/);
  });

  it("skips the pad half, but still checks paths, before the project is registered", async () => {

    const fresh = scratchDirs();
    const freshOpts = { cwd: fresh.projectDir, dataDir: fresh.dataDir, tmp: fresh.tmp };
    const dir = join(fresh.dataDir, "profiles", "unregistered-repro");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "posture.md"), "# posture\n");
    writeFileSync(
      join(dir, "runbook.md"),
      'Read the "board" pad. THE COVERING RULES live under `.claude/rules/`.\n',
    );
    writeFileSync(join(fresh.projectDir, "hive.yml"), "profile: unregistered-repro\n");

    const out = await runCli(["doctor"], freshOpts);

    assert.doesNotMatch(out.stdout, /pad\(s\) referenced but not here/);
    assert.match(out.stdout, /info {2}profile references: path\(s\) referenced but not here: \.claude\/rules\/$/m);
  });
});
