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

const { cleanup } = isolateTmux("the doctor session-interpreter tests");
after(() => cleanup());

const dirs = scratchDirs();
const alt = alternateInterpreter();

async function brokenAddonTree(dir) {
  const { checkAbi } = await import("../dist/abi.js");
  const real = checkAbi().addon;
  assert.ok(real, "this test needs the real, working addon as its control");
  return writeScratchAddon(dir, { prebuild: real, napiVersion: 99 });
}

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

      const { code, stdout, stderr } = await runNode(PROBE, [], { ...opts, node: alt.path });
      assert.equal(code, 0, stderr);
      assert.equal(JSON.parse(stdout).execPath, realpathSync(alt.path));
    },
  );

  it("reports a real Node-API refusal, measured rather than described", async () => {

    const root = join(probeDirs.tmp, "napi-probe");
    mkdirSync(root, { recursive: true });
    const scratch = await brokenAddonTree(root);
    const { code, stdout, stderr } = await runNode(join(scratch.dist, "abiProbe.js"), [], opts);

    assert.equal(code, 0, stderr);
    const answer = JSON.parse(stdout);
    assert.equal(answer.ok, false);
    assert.equal(answer.failure, "napi");
    assert.match(answer.detail, /built against Node-API 99/);
  });
});

describe("a pinned interpreter that is gone says so instead of vanishing quietly", () => {
  const goneDirs = scratchDirs();
  const binDir = join(goneDirs.tmp, "gone-bin");
  const okBin = join(goneDirs.tmp, "ok-bin");
  const goneNode = join(goneDirs.tmp, "pruned-by-a-version-manager", "bin", "node");
  const leadProject = join(goneDirs.tmp, "gone-project");
  const featureProject = join(goneDirs.tmp, "feature-branch-project");

  const hivelessPath = `${join(process.execPath, "..")}:/usr/bin:/bin`;
  const opts = { cwd: goneDirs.projectDir, dataDir: goneDirs.dataDir, tmp: goneDirs.tmp };
  let cliPath;
  let report;

  let scratch;

  before(async () => {
    for (const dir of [binDir, okBin, leadProject, featureProject]) mkdirSync(dir, { recursive: true });
    const dispatcher = await import("../dist/dispatcher.js");
    cliPath = dispatcher.cliPath();
    writeFileSync(join(binDir, "hive"), dispatcher.dispatcherScript(goneNode, cliPath));
    writeFileSync(join(okBin, "hive"), dispatcher.dispatcherScript(process.execPath, cliPath));

    writeFileSync(join(leadProject, "hive.yml"), "profile: orchestration\n");
    git(leadProject, "init", "-q", "-b", "main");
    git(leadProject, "commit", "-q", "--allow-empty", "-m", "root");

    writeFileSync(join(featureProject, "hive.yml"), "profile: orchestration\n");
    git(featureProject, "init", "-q", "-b", "some-feature");
    git(featureProject, "commit", "-q", "--allow-empty", "-m", "root");
    scratch = await brokenAddonTree(join(goneDirs.tmp, "kickoff-gone"));

    report = await runCli(["doctor"], { ...opts, env: { HIVE_BIN_DIR: binDir, PATH: hivelessPath } });
  });

  it("doctor names the missing interpreter, in the warning itself", () => {
    const line = report.stdout.split("\n").find((l) => l.startsWith("  warn  dispatcher:")) ?? "";

    assert.ok(line.includes(goneNode), `the warn should name the missing interpreter:\n${report.stdout}`);
  });

  it("doctor's repair names an interpreter, because a bare `hive setup` cannot run at all here", () => {

    assert.ok(
      report.stdout.includes(`"${cliPath}" setup`),
      `the repair has to name the CLI by path:\n${report.stdout}`,
    );

    assert.doesNotMatch(report.stdout, /npm install && npm run build && hive setup/);
  });

  it("the addon banner names the pruned pin, so the symptom identifies its own cause", async () => {

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

    const { stderr } = await runNode(scratch.kickoffMjs, [], {
      cwd: leadProject,
      dataDir: goneDirs.dataDir,
      tmp: goneDirs.tmp,
      env: { HIVE_BIN_DIR: okBin },
    });

    assert.doesNotMatch(stderr, /is not on disk/);
    assert.match(stderr, /hive: this Node is too old/, "the banner is still the control");
  });

  it("prints NOTHING in a session that declines before the banner", async () => {

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

    rmSync(join(withoutYml, "hive.yml"));
  });

  it("skips a registered project with no hive.yml, which never reaches the addon", async () => {

    const { stdout } = await runCli(["doctor"], opts);
    assert.ok(
      stdout.includes(`(${realpathSync(withYml)})`),
      `the control: a project WITH hive.yml is reported:\n${stdout}`,
    );
    assert.ok(!stdout.includes(`(${realpathSync(withoutYml)})`), stdout);
  });

  it("reports only this project under HIVE_PROJECT_LOCK", async () => {

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

    assert.match(lines[index + 1], /no node version set for this directory/);
    assert.ok(warningCount(report.stdout) >= 1, report.stdout);
  });
});

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

    const { stdout } = await doctor(pinCannot);
    const from = lineFor(stdout, bad);
    assert.ok(from >= 0, stdout);
    const text = stdout.split("\n").slice(from, from + 8).join("\n");
    assert.match(text, /CANNOT load the addon either/);
    assert.match(text, /does not rescue this/);

    assert.doesNotMatch(text, /survives this/);
  });

  it("says re-execing changes nothing when the pin resolves to the same failing interpreter", { skip: SKIP }, async () => {
    const { stdout } = await doctor(pinSame);
    const from = lineFor(stdout, bad);
    assert.ok(from >= 0, stdout);
    assert.match(stdout.split("\n").slice(from, from + 8).join("\n"), /pins this same interpreter/);
  });
});
