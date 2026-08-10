import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { failureCount, isolateTmux, runCli, scratchDirs } from "./helpers.mjs";

// Issue #43. `hive doctor` said nothing when a project's hive.yml named a
// profile this machine does not have, so a lead could start with no standing
// process (posture, runbook, kickoff) and no hint why: kickoff.ts's own
// silence there is correct, but nothing else looked either. These pin the
// three checks doctor gained for the current project: a named profile
// profileExists() cannot find, a profile directory that resolves nothing at
// all (never a legitimate partial fork, which resolves fine), and
// `profile: none` with no runbook pad.

// doctor runs the janitor, which reaches tmux; isolate first (test/CLAUDE.md).
const { cleanup } = isolateTmux("the doctor profile tests");
after(() => cleanup());

const dirs = scratchDirs();
const opts = { cwd: dirs.projectDir, dataDir: dirs.dataDir, tmp: dirs.tmp };
const ymlPath = join(dirs.projectDir, "hive.yml");

// dataDir is read at import time, so the store must be pointed at scratch
// before dist/db.js loads.
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { db } = await import("../dist/db.js");
const { shippedProfilesDir } = await import("../dist/profiles.js");

// TEST CAVEAT (issue #43, non-negotiable, also in test/CLAUDE.md): never
// assert doctor's global exit code. Two recorded instances of that shape have
// cost this project a red CI, and comparing two exit codes saturates at 1 so
// the test passes even after the thing under test breaks. Compare the
// FAILURE COUNT the summary line carries instead - failureCount is shared
// via test/helpers.mjs now that a second file needs it (issue #27's L4 fix
// round R7, todo 171).
let baseline;
let projectId;

before(async () => {
  const init = await runCli(["init"], opts);
  assert.equal(init.code, 0, init.stderr);
  projectId = db.prepare("SELECT id FROM projects LIMIT 1").get().id;
  // No profile key at all: out of scope, deliberately, and the baseline this
  // file's failure-count deltas are measured against.
  baseline = await runCli(["doctor"], opts);
});

// Counselors review on PR #47, finding 2 (both seats independently): every
// other test in this file only ever compares a DELTA against baseline, so a
// baseline that already contains a spurious profile failure would be
// silently absorbed into every one of them rather than caught. Concretely,
// dropping `config?.profile === NO_PROFILE &&` from check 3's condition in
// cli.ts (leaving `else if (here && !getActivePadByName(...))`) makes
// doctor FAIL every project with no profile: key and no runbook pad -- the
// commonest state there is, and the baseline's own state -- while every
// delta-based assertion in this file keeps passing unchanged. Pin the
// baseline itself, once, so that mutation is caught here rather than nowhere.
it("the no-profile-key baseline itself stays quiet", () => {
  // IMMUNE to generated data, for every `/FAIL {2}profile/` check in this
  // file (six total): baseline.stdout does carry a generated project path
  // elsewhere in doctor's report, but this exact phrase is not composed
  // with it. `report()` in src/cli.ts prints `  ${level}  ${label}: ...`,
  // and every call site in the profile checks passes the LITERAL strings
  // "FAIL" and "profile" as level/label - nothing interpolated ever lands
  // between them. A match here can only mean doctor genuinely emitted a
  // profile failure line, never a coincidence of scratch-path text.
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
  // Counselors review on PR #47, finding 3. Every other test in this file
  // runs `hive init` in before(), which registers the project, before ever
  // running doctor -- so nothing above could have caught this. On a fresh
  // clone, before anything has registered the project (no `hive init`, no
  // `hive lead`, no MCP tool call), findProjectForCwd() returns null and the
  // old code gated checks 1 and 2 on `here && profile`, so both were skipped
  // entirely: `hive doctor` printed "All good." while hive.yml named a
  // profile this machine does not have, which is issue #43's own opening
  // scenario. hive.yml is still readable from the cwd doctor is actually run
  // from regardless of registration, so this test never calls `hive init` at
  // all -- registering the project first would make the bug this test exists
  // to catch unreachable.
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
  // Counselors review on PR #47, findings 5 and 6 (opus and codex
  // independently converged on the same reframe). The original check was
  // "files.length === 0", i.e. existence of a resolved PATH; that is not
  // proof of usable content, and it was also all-or-nothing, so a profile
  // resolving SOME files but not runbook.md stayed silent even though a lead
  // using it ends up with no standing process, the identical end state
  // check 3 FAILs for under profile: none.
  //
  // Six tests below: the original all-unreadable case broadened from "no
  // path resolves" to "no readable content", a genuinely new case a
  // path-only check could not catch (existence without usability), the new
  // runbook.md-specific failure using hive's own shipped profiles/simple/ as
  // the real-world trigger (not a synthetic fixture: `hive profile create`
  // itself produces exactly this shape), and three "must stay quiet" cases
  // -- a non-runbook file missing, a REAL user-layer fork of a shipped
  // profile (which the previous "stays quiet" test never built, finding 7:
  // it only ever selected all-shipped profiles/simple/, so it could not have
  // failed if per-file shipped fallback broke), and a runbook.md-missing
  // profile that has a runbook PAD instead. The last one is Chris's own
  // catch, by running doctor rather than reading it: the runbook.md check
  // must be gated on the same pad escape hatch check 3 depends on, or
  // `profile: simple` -- a profile hive itself ships -- fails doctor for
  // every project that legitimately keeps its process in a pad.

  it("fails when no file resolves to readable content in either layer", async () => {
    mkdirSync(join(dirs.dataDir, "profiles", "empty-fork"), { recursive: true });
    writeFileSync(ymlPath, "profile: empty-fork\n");
    const out = await runCli(["doctor"], opts);

    assert.match(out.stdout, /FAIL {2}profile: "empty-fork" has a directory but none of its files.*resolve to readable content/);
    assert.equal(failureCount(out.stdout), failureCount(baseline.stdout) + 1);
  });

  it("fails when a resolved path exists but is not readable content", async () => {
    // resolveProfileFile accepts any existing path, including one that is
    // not a regular file. A directory named posture.md resolves a path and,
    // before this reframe, reported healthy -- contradicting the "nothing
    // usable" reasoning the comment above reportProfile actually claims.
    mkdirSync(join(dirs.dataDir, "profiles", "broken", "posture.md"), { recursive: true });
    writeFileSync(ymlPath, "profile: broken\n");
    const out = await runCli(["doctor"], opts);

    assert.match(out.stdout, /FAIL {2}profile: "broken" has a directory but none of its files.*resolve to readable content/);
    assert.equal(failureCount(out.stdout), failureCount(baseline.stdout) + 1);
  });

  // The next two tests each register their OWN project, in the same store
  // (dataDir: dirs.dataDir, a different projectDir), rather than reusing the
  // shared `dirs` project: that project's runbook-pad state depends on
  // where in this file's execution order check 3 has archived it, and
  // reusing it here would silently couple two unrelated tests through pad
  // lifecycle -- exactly the shape that made the first version of the
  // "fails" test below pass for the wrong reason (the shared project still
  // had its hive-init-seeded pad active at this point, so it never actually
  // hit the runbook.md-missing failure it claimed to pin).
  it("fails when posture.md resolves but runbook.md does not, and there is no runbook pad either", async () => {
    // profiles/simple/ ships only posture.md -- not a synthetic fixture:
    // `hive profile create` itself writes only posture.md by default
    // (src/profiles.ts), so this is the shape that command actually
    // produces. `hive runbook` already exits 1 for profile: simple today;
    // doctor saying nothing about it was the gap.
    const fresh = scratchDirs();
    const freshOpts = { cwd: fresh.projectDir, dataDir: dirs.dataDir, tmp: fresh.tmp };
    const init = await runCli(["init"], freshOpts);
    assert.equal(init.code, 0, init.stderr);
    const freshId = db.prepare("SELECT id FROM projects WHERE path = ?").get(fresh.projectDir).id;
    db.prepare("UPDATE scratchpads SET archived = 1 WHERE project_id = ? AND name = 'runbook'").run(freshId);
    writeFileSync(join(fresh.projectDir, "hive.yml"), "profile: simple\n");

    const out = await runCli(["doctor"], freshOpts);

    assert.match(out.stdout, /FAIL {2}profile: "simple" has no readable runbook\.md/);
    // What DOES resolve is still reported alongside the failure.
    assert.match(out.stdout, /info {2}profile: simple \(posture\.md: shipped\)/);
  });

  it("stays quiet on profile: simple when a runbook pad exists for the project", async () => {
    // Chris caught this by running doctor by hand, and neither counselors
    // seat nor the gate found it: `simple` is a profile hive itself ships,
    // and the runbook.md check above must not fail a project whose process
    // legitimately lives in a runbook pad instead -- the same escape hatch
    // check 3 depends on three tests below. This is the false-positive
    // direction, and it is the one that matters for hive's own out-of-box
    // experience.
    const fresh = scratchDirs();
    const freshOpts = { cwd: fresh.projectDir, dataDir: dirs.dataDir, tmp: fresh.tmp };
    const init = await runCli(["init"], freshOpts);
    assert.equal(init.code, 0, init.stderr);
    // hive init already seeded a runbook pad for this project; leave it be.
    writeFileSync(join(fresh.projectDir, "hive.yml"), "profile: simple\n");

    const out = await runCli(["doctor"], freshOpts);

    // IMMUNE to generated data; see the baseline test at the top of this
    // file for why.
    assert.doesNotMatch(out.stdout, /FAIL {2}profile/);
    assert.match(out.stdout, /info {2}profile: simple \(posture\.md: shipped\)/);
  });

  it("stays quiet when runbook.md resolves but a non-runbook file does not", async () => {
    mkdirSync(join(dirs.dataDir, "profiles", "custom-partial"), { recursive: true });
    writeFileSync(join(dirs.dataDir, "profiles", "custom-partial", "posture.md"), "# posture\n");
    writeFileSync(join(dirs.dataDir, "profiles", "custom-partial", "runbook.md"), "# runbook\n");
    // worker.md deliberately absent from both layers: legitimate partiality,
    // the same as profiles/simple/ missing runbook.md and worker.md.
    writeFileSync(ymlPath, "profile: custom-partial\n");
    const out = await runCli(["doctor"], opts);

    // IMMUNE to generated data; see the baseline test at the top of this
    // file for why.
    assert.doesNotMatch(out.stdout, /FAIL {2}profile/);
    assert.match(out.stdout, /info {2}profile: custom-partial \(posture\.md: user, runbook\.md: user\)/);
    assert.equal(failureCount(out.stdout), failureCount(baseline.stdout));
  });

  it("resolves the rest of a real partial fork from hive's shipped defaults", async () => {
    // A user profile directory that forks exactly one file of a shipped
    // profile: prove the other two still resolve from shipped, not from
    // nowhere. profiles/orchestration/ ships all three files, so this
    // constructs an actual fork rather than reusing an all-shipped profile
    // that could never exercise the fallback at all.
    mkdirSync(join(dirs.dataDir, "profiles", "orchestration"), { recursive: true });
    writeFileSync(join(dirs.dataDir, "profiles", "orchestration", "runbook.md"), "# forked runbook\n");
    writeFileSync(ymlPath, "profile: orchestration\n");
    const out = await runCli(["doctor"], opts);

    // IMMUNE to generated data; see the baseline test at the top of this
    // file for why.
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
    // hive init already seeded a runbook pad on this project (it runs before
    // any profile is chosen), so profile: none is not yet the reportable
    // state; a project with a real, un-archived runbook pad must stay quiet.
    const withPad = await runCli(["doctor"], opts);
    // IMMUNE to generated data; see the baseline test at the top of this
    // file for why.
    assert.doesNotMatch(withPad.stdout, /FAIL {2}profile/, "hive init already seeded a runbook pad");

    db.prepare("UPDATE scratchpads SET archived = 1 WHERE project_id = ? AND name = 'runbook'").run(projectId);
    const withoutPad = await runCli(["doctor"], opts);

    assert.match(
      withoutPad.stdout,
      /FAIL {2}profile: this project is on "profile: none" but has no runbook pad/,
    );
    assert.equal(failureCount(withoutPad.stdout), failureCount(withPad.stdout) + 1);

    // Counselors review on PR #47, finding 2 (both seats independently).
    // Dropping `config?.profile === NO_PROFILE &&` from this branch's
    // condition (leaving only `here && !getActivePadByName(...)`) makes
    // doctor FAIL every project with no profile: key at all and no runbook
    // pad -- not just profile: none -- and every OTHER assertion in this
    // file still passes unchanged, because this file's own baseline (no
    // profile: key) has a real pad and so stays quiet either way. The only
    // state that tells the two conditions apart is no profile: key WITHOUT a
    // pad, which nothing above constructs. pad is still archived from the
    // step above; only hive.yml changes.
    writeFileSync(ymlPath, "{}\n");
    const noKeyNoPad = await runCli(["doctor"], opts);
    // IMMUNE to generated data; see the baseline test at the top of this
    // file for why.
    assert.doesNotMatch(
      noKeyNoPad.stdout,
      /FAIL {2}profile/,
      "no profile: key means the runbook pad is not where the process lives, so its absence is not this check's business",
    );
  });
});

// Todo 326 comment 721: "hive's default changed since you forked it" cannot
// ever clear for a fork that is a deliberate rewrite, because it fires again
// every time hive's shipped default moves -- 100% of this project's own
// doctor warning output, permanently, on a fork the board says must never be
// reconciled by copying. Below, both cases fake "upstream moved" the same way
// profiles.test.mjs does (a bogus recorded origin hash), because the two
// checks under test -- warn survives small drift, info replaces it past the
// rewrite threshold -- only ever fire once upstreamMoved is already true;
// what should change is which of the two this codepath picks, not whether it
// fires at all.
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
