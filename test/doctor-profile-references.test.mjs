import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { failureCount, isolateTmux, runCli, scratchDirs, warningCount } from "./helpers.mjs";

// Todo 332. `hive doctor` already reports referenced-but-unset profile VARS
// (doctor-profile.test.mjs's sibling checks); a referenced-but-missing PAD or
// PATH is the same class of fact with a different noun, and nothing reported
// it. sideproj hit four of these adopting the orchestration profile in one
// night: pads "goal-prompts" and "lane-ledger", and paths `.claude/rules/`
// and `scripts/covering-rules.mjs`. Those four are the regression bar this
// file pins.
//
// The design is Option A (scan resolved profile prose for high-confidence
// shapes), not Option B (profiles declare their expected pads/paths) - see
// plan-332-doctor-references and todo 332 comment for the argument. THIS IS A
// NOTE, NEVER A GATE: decisions/2026-08-07-strict-promotes-only-gating-warns.md.

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
  // The one path reference in this fixture that genuinely exists in the
  // project, so a real hit proves the "found and present" half stays quiet.
  writeFileSync(join(dirs.projectDir, "docs", "notes.md"), "notes\n");
}

describe("todo 332: referenced-but-missing pads and paths", () => {
  it("catches all four sideproj regression cases, and stays non-gating", async () => {
    // Baseline BEFORE the profile is wired up, so the failure/warning
    // comparison below is a real delta from this check's own output, not a
    // no-op comparison of "out" against itself.
    const init = await runCli(["init"], opts);
    assert.equal(init.code, 0, init.stderr);
    const baseline = await runCli(["doctor"], opts);

    mkdirSync(join(dirs.projectDir, "docs"), { recursive: true });
    writesideprojRepro();
    writeFileSync(ymlPath, "profile: sideproj-repro\n");

    const out = await runCli(["doctor"], opts);

    // Both regression-bar pads, sorted, and nothing else - "board" already
    // exists (hive init seeds it), so it must not appear here.
    assert.match(
      out.stdout,
      /info {2}profile references: pad\(s\) referenced but not here: goal-prompts, lane-ledger$/m,
    );
    // Both regression-bar paths, sorted, and nothing else - `docs/notes.md`
    // genuinely exists in this scratch project, so it must not appear here.
    assert.match(
      out.stdout,
      /info {2}profile references: path\(s\) referenced but not here: \.claude\/rules\/, scripts\/covering-rules\.mjs$/m,
    );
    assert.doesNotMatch(out.stdout, /docs\/notes\.md/);

    // NON-GATING: an info-level note changes neither count.
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
    // Same reasoning as check 1/2 above (doctor-profile.test.mjs): checks
    // that only need hive.yml must not gate on `here`. An unregistered
    // project has no project row to look pads up against at all, so every
    // referenced pad would trivially read "missing" - noise, not a finding -
    // and the pad half is skipped entirely rather than reporting that.
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
