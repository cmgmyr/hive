import assert from "node:assert/strict";
import { mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
  alternateInterpreter,
  classicAddonFixture,
  isolateTmux,
  runCli,
  runNode,
  scratchDirs,
  scratchGit as git,
  warningCount,
  writeScratchAddon,
} from "./helpers.mjs";

// Todos 306 and 307. Two questions doctor could not answer, and one silent
// failure in the hook that makes the second one matter:
//
//   306: can a session starting in ANOTHER registered project load hive's
//        addon? Everything else doctor reports is about the machine and the
//        directory doctor itself ran in. A single project pinning a Node
//        below better-sqlite3's floor is why one symptom looked intermittent
//        and project-specific for as long as that project existed.
//   307: the SessionStart hook's re-exec resolves ONE pinned interpreter. If
//        a version manager retires it, the pre-#122 banner returns with the
//        fix still in place and nothing naming the pin as the reason.
//
// WHAT WOULD MAKE THESE TESTS GREEN WHILE THE BEHAVIOUR IS BROKEN, since that
// is the question test/CLAUDE.md asks and this lane's whole subject is a
// measurement:
//
//   - "doctor names an interpreter per project" would pass trivially if
//     doctor reported its own process.execPath for every project. So the
//     per-directory case puts a REAL version-manager-shaped shim first on
//     PATH and requires doctor to name a DIFFERENT absolute path for the
//     project that shim redirects - derived from alternateInterpreter(),
//     never a literal, so the fixture cannot collide with process.execPath.
//   - "the probe reports a failure" would pass against a mocked verdict. So
//     the failing verdict is produced by a scratch better-sqlite3 declaring a
//     Node-API level no interpreter provides, or by a pre-N-API addon a second
//     real interpreter genuinely cannot load.
//   - COUNSELORS ROUND 1, FINDING 2, and it is the reason this file grew: the
//     info-vs-warn decision itself had no test. Mutating sessionStartVerdict
//     to `if (true)` made doctor report "which loads hive's addon" for a
//     project that cannot, with the whole suite green. The pure unit block
//     below pins every branch, and the end-to-end block pins that doctor is
//     actually wired to it - a unit test alone would still pass with
//     probeSessionInterpreter hardcoded to ok.
//   - Exit codes are not asserted anywhere here. Doctor already exits 1 on CI
//     over a missing `claude`, and exit codes saturate at 1.
//
// WHAT THIS FILE CANNOT REACH, stated rather than implied: a REAL sub-floor
// Node resolved from a real .tool-versions. This machine has one Node and no
// asdf, and a Node below the floor cannot run doctor in the first place.
const { cleanup } = isolateTmux("the doctor session-interpreter tests");
after(() => cleanup());

const dirs = scratchDirs();
const alt = alternateInterpreter();

// A scratch checkout whose better-sqlite3 declares a Node-API level no
// interpreter provides, so checkAbi() refuses for real under any Node, on any
// machine and every CI leg. ONE variable moves: the addon installed is the
// real, working one, so the tree runs fine with the requirement removed, which
// is what makes a refusal mean something. The assertion is inside the helper so
// no caller can drop the control and silently pass `prebuild: undefined`.
async function brokenAddonTree(dir) {
  const { checkAbi } = await import("../dist/abi.js");
  const real = checkAbi().addon;
  assert.ok(real, "this test needs the real, working addon as its control");
  return writeScratchAddon(dir, { prebuild: real, napiVersion: 99 });
}

// The two probe shapes the verdict consumes, built by hand so every branch is
// reachable without a second machine. These are the only hand-built values in
// this file; everything they feed is the real function.
const answered = (over) => ({
  probed: true,
  ok: true,
  execPath: "/opt/nodes/24/bin/node",
  version: "v24.19.0",
  detail: "addon loaded",
  ...over,
});
const failed = () =>
  answered({ ok: false, detail: "addon is built against Node-API 10, this interpreter provides Node-API 9" });

describe("sessionStartVerdict decides info vs warn, and every branch is reachable", () => {
  // COUNSELORS FINDING 2. This block exists because the decision it covers had
  // no test at all: the end-to-end cases below assert which interpreter got
  // named, never whether hive believed it worked. Pure and exported, so this
  // needs no second Node, no scratch tree and no spawn.
  let verdict;
  let cliPath;

  before(async () => {
    ({ sessionStartVerdict: verdict } = await import("../dist/sessionProbe.js"));
    ({ cliPath } = await import("../dist/dispatcher.js"));
  });

  it("reports info, and asks nothing about the fallback, when the project's own node loads it", () => {
    let asked = 0;
    const result = verdict(answered(), () => {
      asked += 1;
      return null;
    });
    assert.equal(result.level, "info");
    assert.match(result.lines[0], /which loads hive's addon/);
    // The thunk is the cost decision made testable: resolving the re-exec
    // target now costs a spawn, and a healthy machine must never pay it.
    assert.equal(asked, 0, "a healthy project must not resolve the re-exec target");
  });

  it("says the re-exec covers it only when the pinned interpreter was MEASURED to load it", () => {
    const result = verdict(failed(), () => ({ path: "/opt/nodes/24/bin/node2", state: "loads" }));
    assert.equal(result.level, "warn");
    const text = result.lines.join("\n");
    assert.match(text, /CANNOT load hive's addon/);
    assert.match(text, /re-execing into the interpreter the dispatcher/);
    assert.match(text, /hive loaded the addon under that interpreter to check/);
  });

  it("does NOT claim the re-exec covers it when the pinned interpreter cannot load it either", () => {
    // Counselors P1, the scenario in one assertion: doctor runs under Node 24,
    // the project resolves Node 20, and a stale dispatcher pins an EXISTING
    // Node 22.13 that is itself below the floor. Before this round the verdict
    // read "an existing file" as "session start survives" and said so.
    const result = verdict(failed(), () => ({
      path: "/opt/nodes/22.13/bin/node",
      state: "cannot",
      detail: "addon is built against Node-API 10, this interpreter provides Node-API 9",
    }));
    assert.equal(result.level, "warn");
    const text = result.lines.join("\n");
    assert.match(text, /CANNOT load the addon either/);
    assert.match(text, /does not rescue this/);
    assert.doesNotMatch(text, /survives this/, "the whole defect was claiming survival unmeasured");
  });

  it("says unknown, not fine, when the pinned interpreter could not be verified", () => {
    const result = verdict(failed(), () => ({
      path: "/opt/nodes/22/bin/node",
      state: "unverified",
      detail: "`/opt/nodes/22/bin/node` did not answer the probe (exit 1)",
    }));
    assert.equal(result.level, "warn");
    const text = result.lines.join("\n");
    assert.match(text, /could not verify that/);
    assert.doesNotMatch(text, /survives this/);
  });

  it("names the missing interpreter when the pin is gone, and repairs by naming a Node", () => {
    const result = verdict(failed(), () => ({ path: "/opt/nodes/gone/bin/node", state: "gone" }));
    const text = result.lines.join("\n");
    assert.equal(result.level, "warn");
    assert.match(text, /\/opt\/nodes\/gone\/bin\/node/);
    assertNamesAnInterpreter(text, cliPath());
  });

  it("repairs by naming a Node when there is no dispatcher at all", () => {
    const result = verdict(failed(), () => null);
    const text = result.lines.join("\n");
    assert.equal(result.level, "warn");
    assert.match(text, /no dispatcher at all/);
    assertNamesAnInterpreter(text, cliPath());
  });

  it("says re-execing would change nothing when the pin IS this interpreter", () => {
    const probe = failed();
    const result = verdict(probe, () => ({ path: probe.execPath, state: "loads" }));
    assert.equal(result.level, "warn");
    assert.match(result.lines.join("\n"), /pins this same interpreter/);
  });

  it("reports could-not-tell as its own outcome, never as broken or fine", () => {
    const result = verdict({ probed: false, detail: "no node version set for this directory" }, () => null);
    assert.equal(result.level, "warn");
    const text = result.lines.join("\n");
    assert.match(text, /cannot say/);
    assert.doesNotMatch(text, /CANNOT load/, "nothing was measured, so nothing may be asserted");
  });
});

// COUNSELORS P2, and .claude/rules/native-addon.md's own words: "Any advice
// ending in a bare `hive setup` is a loop, and this repo has shipped that loop
// TWICE." This is the property, asserted at the new site because
// test/interpreter.test.mjs asserts it over abiFixLines' output specifically
// and so could not see a fourth remediation surface being added elsewhere.
function assertNamesAnInterpreter(text, cli) {
  assert.match(text, /<a Node matching .+> ".+" setup/, `the repair must name an interpreter:\n${text}`);
  assert.ok(text.includes(`"${cli}" setup`), `the repair must name the CLI by absolute path:\n${text}`);
  for (const line of text.split("\n")) {
    assert.doesNotMatch(
      line,
      /(^|[^"])\bhive setup\b/,
      `a bare \`hive setup\` cannot run in the state this text fires in:\n${line}`,
    );
  }
}

describe("the ABI probe answers for the interpreter running it", () => {
  const probeDirs = scratchDirs();
  const opts = { cwd: probeDirs.projectDir, dataDir: probeDirs.dataDir, tmp: probeDirs.tmp };
  const PROBE = join(new URL("../dist", import.meta.url).pathname, "abiProbe.js");

  it("reports its own absolute execPath and a loaded addon", async () => {
    const { code, stdout, stderr } = await runNode(PROBE, [], opts);
    assert.equal(code, 0, stderr);
    const answer = JSON.parse(stdout);
    assert.equal(answer.execPath, process.execPath);
    assert.equal(answer.ok, true, stdout);
    assert.equal(answer.failure, null);
  });

  it(
    "reports the interpreter it RAN under, not the one that asked",
    { skip: alt ? false : "no second Node on this machine" },
    async () => {
      // The control for every per-project claim below. A probe that reported
      // a constant, or the spawning process's own interpreter, passes the
      // test above and fails this one.
      const { code, stdout, stderr } = await runNode(PROBE, [], { ...opts, node: alt.path });
      assert.equal(code, 0, stderr);
      assert.equal(JSON.parse(stdout).execPath, realpathSync(alt.path));
    },
  );

  it("reports a real Node-API refusal, measured rather than described", async () => {
    // Same construction interpreter.test.mjs uses for the in-process guard;
    // see brokenAddonTree for why it discriminates.
    const root = join(probeDirs.tmp, "napi-probe");
    mkdirSync(root, { recursive: true });
    const scratch = await brokenAddonTree(root);
    const { code, stdout, stderr } = await runNode(join(scratch.dist, "abiProbe.js"), [], opts);
    // Exit 0 with a verdict on stdout, NOT a crash: doctor reads this back,
    // and a probe that dies has told it nothing.
    assert.equal(code, 0, stderr);
    const answer = JSON.parse(stdout);
    assert.equal(answer.ok, false);
    assert.equal(answer.failure, "napi");
    assert.match(answer.detail, /built against Node-API 99/);
  });
});

// Todo 307, driven by the GENERAL condition rather than the specific one.
// "asdf pruned 24.12.0 on a second machine" cannot be reproduced here - one Node,
// no asdf - but "the interpreter the dispatcher pins is no longer on disk" is
// a scratch dispatcher naming a path nobody ever created, which is the same
// condition with the version manager taken out of it.
describe("a pinned interpreter that is gone says so instead of vanishing quietly", () => {
  const goneDirs = scratchDirs();
  const binDir = join(goneDirs.tmp, "gone-bin");
  const okBin = join(goneDirs.tmp, "ok-bin");
  const goneNode = join(goneDirs.tmp, "pruned-by-a-version-manager", "bin", "node");
  const leadProject = join(goneDirs.tmp, "gone-project");
  const featureProject = join(goneDirs.tmp, "feature-branch-project");
  // doctor answers "what does typing `hive` run" from PATH, so HIVE_BIN_DIR
  // alone does not isolate this: a real ~/.local/bin/hive on the developer's
  // PATH would win and doctor would report THAT dispatcher. Same reasoning as
  // interpreter.test.mjs's own hivelessPath.
  const hivelessPath = `${join(process.execPath, "..")}:/usr/bin:/bin`;
  const opts = { cwd: goneDirs.projectDir, dataDir: goneDirs.dataDir, tmp: goneDirs.tmp };
  let cliPath;
  let report;
  // One tree, reused: writeScratchAddon copies all of dist/ and claude-plugin/
  // and symlinks every real node_modules entry, so building it per test is a
  // real cost. Same pattern as kickoff-reexec.test.mjs's own scratch tree.
  let scratch;

  before(async () => {
    for (const dir of [binDir, okBin, leadProject, featureProject]) mkdirSync(dir, { recursive: true });
    const dispatcher = await import("../dist/dispatcher.js");
    cliPath = dispatcher.cliPath();
    writeFileSync(join(binDir, "hive"), dispatcher.dispatcherScript(goneNode, cliPath));
    writeFileSync(join(okBin, "hive"), dispatcher.dispatcherScript(process.execPath, cliPath));
    // A lead checkout: hive.yml, a profile this machine has, and the default
    // lead branch. This one reaches the store and so reaches the banner.
    writeFileSync(join(leadProject, "hive.yml"), "profile: orchestration\n");
    git(leadProject, "init", "-q", "-b", "main");
    git(leadProject, "commit", "-q", "--allow-empty", "-m", "root");
    // Identical except for the branch, which is what makes it the control.
    writeFileSync(join(featureProject, "hive.yml"), "profile: orchestration\n");
    git(featureProject, "init", "-q", "-b", "some-feature");
    git(featureProject, "commit", "-q", "--allow-empty", "-m", "root");
    scratch = await brokenAddonTree(join(goneDirs.tmp, "kickoff-gone"));
    // One doctor run, read by the two cases below. Doctor is the most
    // expensive command in this suite and now forks a probe per project.
    report = await runCli(["doctor"], { ...opts, env: { HIVE_BIN_DIR: binDir, PATH: hivelessPath } });
  });

  it("doctor names the missing interpreter, in the warning itself", () => {
    const line = report.stdout.split("\n").find((l) => l.startsWith("  warn  dispatcher:")) ?? "";
    // The path on the warn line, not only on the info line above it: this is
    // the line that gets read on its own out of an update script's output.
    assert.ok(line.includes(goneNode), `the warn should name the missing interpreter:\n${report.stdout}`);
  });

  it("doctor's repair names an interpreter, because a bare `hive setup` cannot run at all here", () => {
    // `hive` on PATH is the dispatcher whose exec target just went missing, so
    // the old advice did not merely re-pin the wrong Node - it failed with an
    // exec error naming a path the user has never seen.
    assert.ok(
      report.stdout.includes(`"${cliPath}" setup`),
      `the repair has to name the CLI by path:\n${report.stdout}`,
    );
    // IMMUNE to generated data: report.stdout does carry scratch paths (this
    // describe block's goneNode/leadProject/featureProject), but every
    // segment of them comes from mkdtempSync/join - alphanumeric and hyphens
    // only, never a space or "&" - so they can never reproduce this literal,
    // space-and-&&-laden phrase. A match here can only mean doctor's own
    // code actually emitted the old, retired remediation advice.
    assert.doesNotMatch(report.stdout, /npm install && npm run build && hive setup/);
  });

  it("the addon banner names the pruned pin, so the symptom identifies its own cause", async () => {
    // Todo 307's naming lives in guardAbi() (src/abi.ts), NOT in kickoff.mjs.
    // The scratch tree declares an impossible Node-API level, so checkAbi()
    // fails under the running interpreter and this reaches the banner with no
    // second Node needed.
    const { code, stderr } = await runNode(scratch.kickoffMjs, [], {
      cwd: leadProject,
      dataDir: goneDirs.dataDir,
      tmp: goneDirs.tmp,
      env: { HIVE_BIN_DIR: binDir },
    });
    assert.match(stderr, /hive: this Node is too old/, "the banner is the thing being annotated");
    assert.match(stderr, new RegExp(`dispatcher pins ${goneNode}, which is not on disk`));
    assert.match(stderr, /SessionStart hook re-execs into/);
    assert.equal(code, 1);
  });

  it("stays silent about the pin when the pinned interpreter is there", async () => {
    // The discriminator. Same broken tree, same failing addon, same banner -
    // only the pin differs. Without this, "the banner says something about a
    // dispatcher whenever the addon fails" would satisfy the case above just
    // as well as "when the PIN is gone".
    const { stderr } = await runNode(scratch.kickoffMjs, [], {
      cwd: leadProject,
      dataDir: goneDirs.dataDir,
      tmp: goneDirs.tmp,
      env: { HIVE_BIN_DIR: okBin },
    });
    // IMMUNE to generated data, same reasoning as the "npm install && npm run
    // build && hive setup" check above: "is not on disk" is a fixed suffix in
    // sessionProbe.ts's own template (the dynamic part, `${pinned.path}`, is
    // interpolated BEFORE it), and every scratch path in this describe block
    // is alphanumeric-and-hyphen only, so it can never contain the space
    // characters this phrase requires.
    assert.doesNotMatch(stderr, /is not on disk/);
    assert.match(stderr, /hive: this Node is too old/, "the banner is still the control");
  });

  it("prints NOTHING in a session that declines before the banner", async () => {
    // COUNSELORS FINDING 1, and the reason the message moved out of
    // kickoff.mjs. This is the same directory as the banner case above except
    // for its branch: kickoff clears its two cheap mirrored gates, checkAbi()
    // fails, the pin is gone - and then runKickoff declines at the lead-branch
    // gate (src/kickoff.ts) BEFORE db.js is imported, so no banner follows.
    // For one commit this printed four [hive] lines here: net-new output on a
    // session that was silent and working. Kickoff's contract is silence, and
    // this lane may only replace a misleading message, never add one.
    const { code, stdout, stderr } = await runNode(scratch.kickoffMjs, [], {
      cwd: featureProject,
      dataDir: goneDirs.dataDir,
      tmp: goneDirs.tmp,
      env: { HIVE_BIN_DIR: binDir },
    });
    assert.equal(stderr, "", "a declining session must stay silent");
    assert.equal(stdout, "", "a declining session must stay silent");
    assert.equal(code, 0);
  });
});

describe("hive doctor's per-project loop, on any machine", () => {
  // COUNSELORS, SMALLER FINDING: these two cases need no second Node, and they
  // sat inside a describe gated on one - so on a one-Node machine the gate
  // they pin was untested and the suite still reported green. "A matrix that
  // hides its own skips is worse than one leg" (.claude/rules/native-addon.md).
  const loopDirs = scratchDirs();
  const withYml = join(loopDirs.tmp, "has-yml");
  const withoutYml = join(loopDirs.tmp, "no-yml");
  const opts = { cwd: withYml, dataDir: loopDirs.dataDir, tmp: loopDirs.tmp };

  before(async () => {
    for (const dir of [withYml, withoutYml]) mkdirSync(dir, { recursive: true });
    for (const dir of [withYml, withoutYml]) {
      const init = await runCli(["init"], { ...opts, cwd: dir });
      assert.equal(init.code, 0, init.stderr);
    }
    // Registered, then the config removed: `hive init` is the only way to get
    // a project row here and it always writes one.
    rmSync(join(withoutYml, "hive.yml"));
  });

  it("skips a registered project with no hive.yml, which never reaches the addon", async () => {
    // Both kickoff gates return before the addon without one, so a warning
    // there would be a warning about nothing - and the spawn would be paid for
    // a project with nothing to say.
    const { stdout } = await runCli(["doctor"], opts);
    assert.ok(
      stdout.includes(`(${realpathSync(withYml)})`),
      `the control: a project WITH hive.yml is reported:\n${stdout}`,
    );
    assert.ok(!stdout.includes(`(${realpathSync(withoutYml)})`), stdout);
  });

  it("reports only this project under HIVE_PROJECT_LOCK", async () => {
    // Every spawned worker gets HIVE_PROJECT_LOCK=1, and doctor is a command
    // workers run. Before this lane doctor was cwd-scoped, so a machine-wide
    // loop that prints every project's absolute path and spawns a process in
    // each is new reach into a locked context.
    const second = join(loopDirs.tmp, "other-project");
    mkdirSync(second, { recursive: true });
    const init = await runCli(["init"], { ...opts, cwd: second });
    assert.equal(init.code, 0, init.stderr);
    const unlocked = await runCli(["doctor"], opts);
    assert.ok(
      unlocked.stdout.includes(`(${realpathSync(second)})`),
      `the control: unlocked, doctor reports every project:\n${unlocked.stdout}`,
    );
    const locked = await runCli(["doctor"], { ...opts, env: { HIVE_PROJECT_LOCK: "1" } });
    assert.ok(!locked.stdout.includes(`(${realpathSync(second)})`), locked.stdout);
    assert.ok(locked.stdout.includes(`(${realpathSync(withYml)})`), locked.stdout);
    assert.match(locked.stdout, /this project only: HIVE_PROJECT_LOCK is set/);
  });
});

describe("hive doctor resolves an interpreter per project directory", () => {
  // One shim that resolves a different interpreter per directory - the exact
  // mechanism a version manager uses, and the reason this question cannot be
  // answered without spawning something.
  const home = join(dirs.tmp, "proj-home");
  const other = join(dirs.tmp, "proj-other");
  const broken = join(dirs.tmp, "proj-broken");
  const shimDir = join(dirs.tmp, "shim-bin");
  const opts = { cwd: home, dataDir: dirs.dataDir, tmp: dirs.tmp };
  let report;

  const SKIP = alt ? false : "no second Node on this machine to resolve a project onto";

  before(async () => {
    if (SKIP) return;
    for (const dir of [home, other, broken, shimDir]) mkdirSync(dir, { recursive: true });
    for (const dir of [home, other, broken]) {
      const init = await runCli(["init"], { ...opts, cwd: dir });
      assert.equal(init.code, 0, init.stderr);
    }
    writeShim(shimDir, [
      [other, `exec ${JSON.stringify(realpathSync(alt.path))} "$@"`],
      [broken, 'echo "shim: no node version set for this directory" >&2; exit 1'],
    ]);
    report = await runCli(["doctor"], { ...opts, env: { PATH: `${shimDir}:${process.env.PATH}` } });
  });

  it("names the resolved interpreter per directory, by absolute path", { skip: SKIP }, () => {
    const line = (dir) => report.stdout.split("\n").find((l) => l.includes(`(${realpathSync(dir)})`)) ?? "";
    assert.ok(
      line(home).includes(process.execPath),
      `the home project should resolve this interpreter:\n${report.stdout}`,
    );
    // The discriminator. If doctor answered from its own process instead of
    // spawning per directory, this line would name process.execPath too.
    assert.ok(
      line(other).includes(realpathSync(alt.path)),
      `the redirected project should resolve ${realpathSync(alt.path)}:\n${report.stdout}`,
    );
    assert.ok(!line(other).includes(process.execPath), report.stdout);
  });

  it("says it could not tell, rather than nothing, when the probe fails", { skip: SKIP }, () => {
    const lines = report.stdout.split("\n");
    const index = lines.findIndex((l) => l.includes(`(${realpathSync(broken)})`));
    assert.ok(index >= 0, `no line for the broken project:\n${report.stdout}`);
    assert.match(lines[index], /^ {2}warn {2}project /);
    assert.match(lines[index], /hive cannot say/);
    // The shim's own words: doctor has to pass the reason through, or a
    // reader has nothing to act on.
    assert.match(lines[index + 1], /no node version set for this directory/);
    assert.ok(warningCount(report.stdout) >= 1, report.stdout);
  });
});

// `pwd -P`, not $PWD: a shell inherits PWD from its parent and only corrects it
// at startup, and the physical path is what the project rows hold (addProject
// realpaths, and os.tmpdir() sits under a symlinked /var on darwin).
function writeShim(dir, branches) {
  writeFileSync(
    join(dir, "node"),
    [
      "#!/bin/sh",
      'case "$(pwd -P)" in',
      ...branches.map(([target, action]) => `  ${realpathSync(target)}*) ${action} ;;`),
      "esac",
      `exec ${JSON.stringify(process.execPath)} "$@"`,
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
}

// THE END-TO-END HALF OF COUNSELORS FINDING 2, and the only construction on a
// one-Node-family machine that can produce a genuinely failing project verdict
// through doctor itself. A scratch checkout carrying test/fixtures'
// pre-N-API addon built for THIS interpreter's ABI: the scratch `hive doctor`
// runs fine, and a project whose shim resolves the second interpreter gets a
// real ERR_DLOPEN_FAILED from Node rather than a fabricated one.
//
// Without this block the unit tests above still pass with
// probeSessionInterpreter hardcoded to `ok: true`. With it, that mutation
// reports a loading addon for a project that measurably cannot load it.
describe("hive doctor reports a project that genuinely cannot load the addon", () => {
  const abiDirs = scratchDirs();
  const good = join(abiDirs.tmp, "abi-good");
  const bad = join(abiDirs.tmp, "abi-bad");
  const shimDir = join(abiDirs.tmp, "abi-shim");
  const pinGood = join(abiDirs.tmp, "pin-good");
  const pinSame = join(abiDirs.tmp, "pin-same");
  const pinCannot = join(abiDirs.tmp, "pin-cannot");
  const matchingFixture = classicAddonFixture({ matches: true });
  const SKIP =
    alt && matchingFixture
      ? false
      : alt
        ? `no pre-N-API better-sqlite3 fixture for ${process.platform}-${process.arch} ABI ${process.versions.modules} - add one (see test/fixtures/native-addon-abi/README.md) or this coverage is silently gone`
        : "no second Node with a different ABI on this machine";
  let scratch;

  before(async () => {
    if (SKIP) return;
    for (const dir of [good, bad, shimDir, pinGood, pinSame, pinCannot]) mkdirSync(dir, { recursive: true });
    scratch = writeScratchAddon(join(abiDirs.tmp, "classic-tree"), {
      prebuild: matchingFixture,
      classic: true,
    });
    const opts = { dataDir: abiDirs.dataDir, tmp: abiDirs.tmp };
    for (const dir of [good, bad]) {
      const init = await runNode(scratch.cli, ["init"], { ...opts, cwd: dir });
      assert.equal(init.code, 0, init.stderr);
    }
    writeShim(shimDir, [[bad, `exec ${JSON.stringify(realpathSync(alt.path))} "$@"`]]);
    const { dispatcherScript } = await import("../dist/dispatcher.js");
    writeFileSync(join(pinGood, "hive"), dispatcherScript(process.execPath, scratch.cli));
    writeFileSync(join(pinSame, "hive"), dispatcherScript(realpathSync(alt.path), scratch.cli));
    // AN ALIAS OF THE SAME BROKEN INTERPRETER, which is what makes the
    // "pinned interpreter cannot load it either" branch reachable with only
    // two Nodes on the machine: process.execPath always reports the RESOLVED
    // real path, so a pin naming the symlink is a DIFFERENT path than the
    // probe reports while being the same binary. kickoff-reexec.test.mjs uses
    // the identical construction for the same reason.
    const altAlias = join(abiDirs.tmp, "alt-node-alias");
    symlinkSync(realpathSync(alt.path), altAlias);
    writeFileSync(join(pinCannot, "hive"), dispatcherScript(altAlias, scratch.cli));
  });

  const doctor = (binDir) =>
    runNode(scratch.cli, ["doctor"], {
      cwd: good,
      dataDir: abiDirs.dataDir,
      tmp: abiDirs.tmp,
      env: { HIVE_BIN_DIR: binDir, PATH: `${shimDir}:${process.env.PATH}` },
    });

  const lineFor = (stdout, dir) =>
    stdout.split("\n").findIndex((l) => l.includes(`(${realpathSync(dir)})`));

  it("warns for the failing project and stays info for the healthy one", { skip: SKIP }, async () => {
    const { stdout } = await doctor(pinGood);
    const lines = stdout.split("\n");
    const badLine = lineFor(stdout, bad);
    assert.ok(badLine >= 0, `no line for the failing project:\n${stdout}`);
    assert.match(lines[badLine], /^ {2}warn {2}project /, stdout);
    assert.match(lines.slice(badLine).join("\n"), /CANNOT load hive's addon/);
    // The control in the same run: doctor is not simply warning about
    // everything. This is the mutation guard - `if (true)` in the verdict, or
    // `ok: true` in the probe, breaks one of these two lines.
    const goodLine = lineFor(stdout, good);
    assert.ok(goodLine >= 0, stdout);
    assert.match(lines[goodLine], /^ {2}info {2}project /, stdout);
    assert.match(lines[goodLine], /which loads hive's addon/);
  });

  it("says the re-exec covers it only after loading the addon under the pinned interpreter", { skip: SKIP }, async () => {
    const { stdout } = await doctor(pinGood);
    const from = lineFor(stdout, bad);
    const text = stdout.split("\n").slice(from, from + 8).join("\n");
    assert.match(text, /hive loaded the addon under that interpreter to check/);
  });

  it("refuses to call it covered when the pinned interpreter cannot load it either", { skip: SKIP }, async () => {
    // COUNSELORS P1 END TO END: the dispatcher pins an interpreter that EXISTS
    // and cannot load the addon. The old code reported this project as covered
    // by the re-exec; the hook would have re-execed into it and printed the
    // banner anyway. Nothing but probing the pin can tell these two apart -
    // existsSync answers identically here and in the covered case above.
    const { stdout } = await doctor(pinCannot);
    const from = lineFor(stdout, bad);
    assert.ok(from >= 0, stdout);
    const text = stdout.split("\n").slice(from, from + 8).join("\n");
    assert.match(text, /CANNOT load the addon either/);
    assert.match(text, /does not rescue this/);
    // IMMUNE to generated data, same reasoning as the unit-level version of
    // this same assertion above: "survives this" is a fixed phrase inside
    // sessionProbe.ts's own hard-coded sentence, and this describe block's
    // scratch paths (good/bad/pinGood/pinSame/pinCannot, all mkdtempSync +
    // join) never contain a space, so they cannot supply it.
    assert.doesNotMatch(text, /survives this/);
  });

  it("says re-execing changes nothing when the pin resolves to the same failing interpreter", { skip: SKIP }, async () => {
    const { stdout } = await doctor(pinSame);
    const from = lineFor(stdout, bad);
    assert.ok(from >= 0, stdout);
    assert.match(stdout.split("\n").slice(from, from + 8).join("\n"), /pins this same interpreter/);
  });
});
