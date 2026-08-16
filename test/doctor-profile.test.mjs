import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { failureCount, isolateTmux, runCli, scratchDirs } from "./helpers.mjs";

const { cleanup } = isolateTmux("the doctor profile tests");
after(() => cleanup());

const dirs = scratchDirs();
const opts = { cwd: dirs.projectDir, dataDir: dirs.dataDir, tmp: dirs.tmp };
const ymlPath = join(dirs.projectDir, "hive.yml");

process.env.HIVE_DATA_DIR = dirs.dataDir;
const { db } = await import("../dist/db.js");
const { shippedProfilesDir } = await import("../dist/profiles.js");

let baseline;
let projectId;

before(async () => {
  const init = await runCli(["init"], opts);
  assert.equal(init.code, 0, init.stderr);
  projectId = db.prepare("SELECT id FROM projects LIMIT 1").get().id;

  baseline = await runCli(["doctor"], opts);
});

it("the no-profile-key baseline itself stays quiet", () => {

  assert.doesNotMatch(baseline.stdout, /FAIL {2}profile/, "no profile: key is a legitimate quiet default");
});

describe("check 1: a named profile this machine does not have", () => {
  it("fails and names the profile", async () => {
    writeFileSync(ymlPath, "profile: not-a-real-profile\n");
    const out = await runCli(["doctor"], opts);

    assert.match(
      out.stdout,
      /FAIL {2}profile: "not-a-real-profile" is named in hive\.yml but is not on this machine/,
    );
    assert.match(out.stdout, /hive profile list/);
    assert.equal(failureCount(out.stdout), failureCount(baseline.stdout) + 1);
  });
});

describe("checks 1 and 2 do not need the project registered first", () => {

  it("fails on an unregistered project's hive.yml naming a profile this machine does not have", async () => {
    const fresh = scratchDirs();
    writeFileSync(join(fresh.projectDir, "hive.yml"), "profile: not-a-real-profile-either\n");

    const out = await runCli(["doctor"], { cwd: fresh.projectDir, dataDir: fresh.dataDir, tmp: fresh.tmp });

    assert.match(
      out.stdout,
      /FAIL {2}profile: "not-a-real-profile-either" is named in hive\.yml but is not on this machine/,
    );
  });
});

describe("check 2: a profile resolving no readable content, or none for runbook.md", () => {

  it("fails when no file resolves to readable content in either layer", async () => {
    mkdirSync(join(dirs.dataDir, "profiles", "empty-fork"), { recursive: true });
    writeFileSync(ymlPath, "profile: empty-fork\n");
    const out = await runCli(["doctor"], opts);

    assert.match(out.stdout, /FAIL {2}profile: "empty-fork" has a directory but none of its files.*resolve to readable content/);
    assert.equal(failureCount(out.stdout), failureCount(baseline.stdout) + 1);
  });

  it("fails when a resolved path exists but is not readable content", async () => {

    mkdirSync(join(dirs.dataDir, "profiles", "broken", "posture.md"), { recursive: true });
    writeFileSync(ymlPath, "profile: broken\n");
    const out = await runCli(["doctor"], opts);

    assert.match(out.stdout, /FAIL {2}profile: "broken" has a directory but none of its files.*resolve to readable content/);
    assert.equal(failureCount(out.stdout), failureCount(baseline.stdout) + 1);
  });

  it("fails when posture.md resolves but runbook.md does not, and there is no runbook pad either", async () => {

    const fresh = scratchDirs();
    const freshOpts = { cwd: fresh.projectDir, dataDir: dirs.dataDir, tmp: fresh.tmp };
    const init = await runCli(["init"], freshOpts);
    assert.equal(init.code, 0, init.stderr);
    const freshId = db.prepare("SELECT id FROM projects WHERE path = ?").get(fresh.projectDir).id;
    db.prepare("UPDATE scratchpads SET archived = 1 WHERE project_id = ? AND name = 'runbook'").run(freshId);
    writeFileSync(join(fresh.projectDir, "hive.yml"), "profile: simple\n");

    const out = await runCli(["doctor"], freshOpts);

    assert.match(out.stdout, /FAIL {2}profile: "simple" has no readable runbook\.md/);

    assert.match(out.stdout, /info {2}profile: simple \(posture\.md: shipped\)/);
  });

  it("stays quiet on profile: simple when a runbook pad exists for the project", async () => {

    const fresh = scratchDirs();
    const freshOpts = { cwd: fresh.projectDir, dataDir: dirs.dataDir, tmp: fresh.tmp };
    const init = await runCli(["init"], freshOpts);
    assert.equal(init.code, 0, init.stderr);

    writeFileSync(join(fresh.projectDir, "hive.yml"), "profile: simple\n");

    const out = await runCli(["doctor"], freshOpts);

    assert.doesNotMatch(out.stdout, /FAIL {2}profile/);
    assert.match(out.stdout, /info {2}profile: simple \(posture\.md: shipped\)/);
  });

  it("stays quiet when runbook.md resolves but a non-runbook file does not", async () => {
    mkdirSync(join(dirs.dataDir, "profiles", "custom-partial"), { recursive: true });
    writeFileSync(join(dirs.dataDir, "profiles", "custom-partial", "posture.md"), "# posture\n");
    writeFileSync(join(dirs.dataDir, "profiles", "custom-partial", "runbook.md"), "# runbook\n");

    writeFileSync(ymlPath, "profile: custom-partial\n");
    const out = await runCli(["doctor"], opts);

    assert.doesNotMatch(out.stdout, /FAIL {2}profile/);
    assert.match(out.stdout, /info {2}profile: custom-partial \(posture\.md: user, runbook\.md: user\)/);
    assert.equal(failureCount(out.stdout), failureCount(baseline.stdout));
  });

  it("resolves the rest of a real partial fork from hive's shipped defaults", async () => {

    mkdirSync(join(dirs.dataDir, "profiles", "orchestration"), { recursive: true });
    writeFileSync(join(dirs.dataDir, "profiles", "orchestration", "runbook.md"), "# forked runbook\n");
    writeFileSync(ymlPath, "profile: orchestration\n");
    const out = await runCli(["doctor"], opts);

    assert.doesNotMatch(out.stdout, /FAIL {2}profile/);
    assert.match(
      out.stdout,
      /info {2}profile: orchestration \(posture\.md: shipped, runbook\.md: user, worker\.md: shipped\)/,
    );
    assert.equal(failureCount(out.stdout), failureCount(baseline.stdout));
  });
});

describe("check 3: profile: none with no runbook pad", () => {
  it("fails only once the pad hive init seeded is gone, and only under profile: none specifically", async () => {
    writeFileSync(ymlPath, "profile: none\n");

    const withPad = await runCli(["doctor"], opts);

    assert.doesNotMatch(withPad.stdout, /FAIL {2}profile/, "hive init already seeded a runbook pad");

    db.prepare("UPDATE scratchpads SET archived = 1 WHERE project_id = ? AND name = 'runbook'").run(projectId);
    const withoutPad = await runCli(["doctor"], opts);

    assert.match(
      withoutPad.stdout,
      /FAIL {2}profile: this project is on "profile: none" but has no runbook pad/,
    );
    assert.equal(failureCount(withoutPad.stdout), failureCount(withPad.stdout) + 1);

    writeFileSync(ymlPath, "{}\n");
    const noKeyNoPad = await runCli(["doctor"], opts);

    assert.doesNotMatch(
      noKeyNoPad.stdout,
      /FAIL {2}profile/,
      "no profile: key means the runbook pad is not where the process lives, so its absence is not this check's business",
    );
  });
});

describe("profile divergence: warn survives small drift, info replaces a rewrite (todo 326)", () => {
  function fakeUpstreamMoved(dataDir, file) {
    writeFileSync(
      join(dataDir, "profiles", "orchestration", ".hive-origin.json"),
      JSON.stringify({ [file]: "0000000000000000" }),
    );
  }

  it("keeps warn, with a percentage, for a lightly edited fork", async () => {
    const fresh = scratchDirs();
    const freshOpts = { cwd: fresh.projectDir, dataDir: fresh.dataDir, tmp: fresh.tmp };
    mkdirSync(join(fresh.dataDir, "profiles", "orchestration"), { recursive: true });
    const shipped = readFileSync(join(shippedProfilesDir, "orchestration", "posture.md"), "utf8");
    const lightlyEdited = shipped.replace(/^./, (c) => c.toUpperCase());
    writeFileSync(join(fresh.dataDir, "profiles", "orchestration", "posture.md"), lightlyEdited);
    fakeUpstreamMoved(fresh.dataDir, "posture.md");
    writeFileSync(join(fresh.projectDir, "hive.yml"), "profile: orchestration\n");

    const out = await runCli(["doctor"], freshOpts);

    assert.match(out.stdout, /warn {2}profile: hive's default posture\.md changed since you forked it \(\d+% diverged\)/);
    assert.doesNotMatch(out.stdout, /profile: posture\.md is a \d+% rewrite/);
  });

  it("drops to info, past the rewrite threshold, for a fork sharing almost no lines with hive's default", async () => {
    const fresh = scratchDirs();
    const freshOpts = { cwd: fresh.projectDir, dataDir: fresh.dataDir, tmp: fresh.tmp };
    mkdirSync(join(fresh.dataDir, "profiles", "orchestration"), { recursive: true });
    writeFileSync(
      join(fresh.dataDir, "profiles", "orchestration", "runbook.md"),
      "this runbook is written from scratch for this project and shares nothing with hive's shipped default\n",
    );
    fakeUpstreamMoved(fresh.dataDir, "runbook.md");
    writeFileSync(join(fresh.projectDir, "hive.yml"), "profile: orchestration\n");

    const out = await runCli(["doctor"], freshOpts);

    assert.match(out.stdout, /info {2}profile: runbook\.md is a \d+% rewrite of hive's default, not an edited copy of it/);
    assert.doesNotMatch(out.stdout, /warn {2}profile: hive's default runbook\.md changed since you forked it/);
  });
});
