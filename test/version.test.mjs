import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { DIST, isolateTmux, REPO, runCli, runFixture, scratchDirs } from "./helpers.mjs";

const { cleanup } = isolateTmux("the version tests");
after(() => cleanup());

const dirs = scratchDirs();
const isolated = { cwd: dirs.projectDir, dataDir: dirs.dataDir, tmp: dirs.tmp };

const buildInfo = JSON.parse(readFileSync(join(DIST, "build-info.json"), "utf8"));
const stampedLine = `hive ${buildInfo.version} (${buildInfo.sha}${buildInfo.dirty ? "-dirty" : ""})`;

describe("hive --version reports the build-time stamp `npm run build` wrote to dist/build-info.json", () => {
  it("--version prints it and exits 0", async () => {
    const result = await runCli(["--version"], isolated);
    assert.equal(result.code, 0);
    assert.equal(result.stdout.trim(), stampedLine);
  });

  it("-v is the same flag as --version", async () => {
    const result = await runCli(["-v"], isolated);
    assert.equal(result.code, 0);
    assert.equal(result.stdout.trim(), stampedLine);
  });

  it("exits before touching the project store, so a directory with no reachable database still answers", async () => {
    const result = await runCli(["--version"], {
      cwd: dirs.tmp,
      dataDir: join(dirs.tmp, "no-such-parent", "data"),
      tmp: dirs.tmp,
    });
    assert.equal(result.code, 0);
    assert.equal(result.stdout.trim(), stampedLine);
  });

  it("hive doctor prints the identical stamp as one of its checks", async () => {
    const result = await runCli(["doctor"], isolated);
    assert.match(result.stdout, /\n {2}ok {4}version: /, `doctor did not run a "version" check:\n${result.stdout}`);
    assert.ok(
      result.stdout.includes(`  ok    version: ${stampedLine}`),
      `expected doctor to report "${stampedLine}", got:\n${result.stdout}`,
    );
  });
});

// Ignore dist/build-info.json and the runFixture .mjs script the tests write after this commit,
// or those untracked files make the scratch tree read as dirty regardless of what's under test.
function initGitRepo(dir, ignore = ["dist/", "*.mjs"]) {
  const git = (...cmdArgs) =>
    execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "user.email=test@test", "-c", "user.name=test", ...cmdArgs], {
      cwd: dir,
      encoding: "utf8",
    });
  writeFileSync(join(dir, ".gitignore"), ignore.join("\n") + "\n");
  git("init", "-q");
  git("add", "-A");
  git("commit", "-q", "-m", "initial");
  return git("rev-parse", "--short", "HEAD").trim();
}

function scratchVersionModule(tmp) {
  const scratch = mkdtempSync(join(tmp, "version-fixture-"));
  mkdirSync(join(scratch, "dist"), { recursive: true });
  cpSync(join(DIST, "version.js"), join(scratch, "dist", "version.js"));
  writeFileSync(join(scratch, "package.json"), JSON.stringify({ version: "9.9.9" }));
  return scratch;
}

const CALL_VERSION_INFO = `
import { versionInfo } from "./dist/version.js";
console.log(JSON.stringify(versionInfo()));
`;

describe("versionInfo() (src/version.ts): stamp plus a runtime drift check against git", () => {
  it("with no stamp and no git reachable, says so honestly rather than guessing", () => {
    const scratch = scratchVersionModule(dirs.tmp);
    const info = runFixture(scratch, "call", CALL_VERSION_INFO, { PATH: dirname(process.execPath) });
    assert.equal(info.line, "hive 9.9.9 (build unknown; not built from a git checkout)");
    assert.equal(info.drift, null);
  });

  it("with no stamp but a git checkout present, falls back to the live git state", () => {
    const scratch = scratchVersionModule(dirs.tmp);
    const sha = initGitRepo(scratch);
    const info = runFixture(scratch, "call", CALL_VERSION_INFO);
    assert.equal(info.line, `hive 9.9.9 (${sha})`);
    assert.equal(info.drift, null);
  });

  it("with a stamp matching the current checkout, reports it with no drift note", () => {
    const scratch = scratchVersionModule(dirs.tmp);
    const sha = initGitRepo(scratch);
    writeFileSync(join(scratch, "dist", "build-info.json"), JSON.stringify({ version: "9.9.9", sha, dirty: false }));
    const info = runFixture(scratch, "call", CALL_VERSION_INFO);
    assert.equal(info.line, `hive 9.9.9 (${sha})`);
    assert.equal(info.drift, null);
  });

  it("with an uncommitted edit since the build, keeps the stamp but flags the checkout as dirty now", () => {
    const scratch = scratchVersionModule(dirs.tmp);
    const sha = initGitRepo(scratch);
    writeFileSync(join(scratch, "dist", "build-info.json"), JSON.stringify({ version: "9.9.9", sha, dirty: false }));
    writeFileSync(join(scratch, "untracked-since-build.txt"), "edited after the build ran");
    const info = runFixture(scratch, "call", CALL_VERSION_INFO);
    assert.equal(info.line, `hive 9.9.9 (${sha})`);
    assert.equal(info.drift, `checkout has moved since this build: now ${sha}-dirty`);
  });

  it("with a new commit since the build, names the new sha in the drift note rather than lying with the old one", () => {
    const scratch = scratchVersionModule(dirs.tmp);
    const staleSha = initGitRepo(scratch);
    writeFileSync(join(scratch, "dist", "build-info.json"), JSON.stringify({ version: "9.9.9", sha: staleSha, dirty: false }));
    execFileSync(
      "git",
      ["-c", "commit.gpgsign=false", "-c", "user.email=test@test", "-c", "user.name=test", "commit", "--allow-empty", "-q", "-m", "second"],
      { cwd: scratch },
    );
    const freshSha = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: scratch, encoding: "utf8" }).trim();
    const info = runFixture(scratch, "call", CALL_VERSION_INFO);
    assert.notEqual(freshSha, staleSha, "test needs a real second commit to exercise this path");
    assert.equal(info.line, `hive 9.9.9 (${staleSha})`);
    assert.equal(info.drift, `checkout has moved since this build: now ${freshSha}`);
  });

  it("with a stamp present but git unreachable at runtime, trusts the stamp silently rather than refusing to answer", () => {
    const scratch = scratchVersionModule(dirs.tmp);
    const sha = initGitRepo(scratch);
    writeFileSync(join(scratch, "dist", "build-info.json"), JSON.stringify({ version: "9.9.9", sha, dirty: true }));
    const info = runFixture(scratch, "call", CALL_VERSION_INFO, { PATH: dirname(process.execPath) });
    assert.equal(info.line, `hive 9.9.9 (${sha}-dirty)`);
    assert.equal(info.drift, null);
  });
});

describe("scripts/gen-version.mjs: the build-time stamp writer", () => {
  function scratchGenerator(tmp) {
    const scratch = mkdtempSync(join(tmp, "gen-version-fixture-"));
    mkdirSync(join(scratch, "scripts"), { recursive: true });
    mkdirSync(join(scratch, "dist"), { recursive: true });
    cpSync(join(REPO, "scripts", "gen-version.mjs"), join(scratch, "scripts", "gen-version.mjs"));
    writeFileSync(join(scratch, "package.json"), JSON.stringify({ version: "1.2.3" }));
    return scratch;
  }

  it("stamps a clean checkout with sha and dirty: false", () => {
    const scratch = scratchGenerator(dirs.tmp);
    const sha = initGitRepo(scratch);
    execFileSync(process.execPath, [join(scratch, "scripts", "gen-version.mjs")], { cwd: scratch });
    const info = JSON.parse(readFileSync(join(scratch, "dist", "build-info.json"), "utf8"));
    assert.deepEqual(info, { version: "1.2.3", sha, dirty: false });
  });

  it("stamps a checkout with local edits as dirty: true", () => {
    const scratch = scratchGenerator(dirs.tmp);
    const sha = initGitRepo(scratch);
    writeFileSync(join(scratch, "package.json"), JSON.stringify({ version: "1.2.3", extra: true }));
    execFileSync(process.execPath, [join(scratch, "scripts", "gen-version.mjs")], { cwd: scratch });
    const info = JSON.parse(readFileSync(join(scratch, "dist", "build-info.json"), "utf8"));
    assert.deepEqual(info, { version: "1.2.3", sha, dirty: true });
  });

  it("exits 0 and stamps sha: null when git is not reachable, rather than failing the build", () => {
    const scratch = scratchGenerator(dirs.tmp);
    const result = execFileSync(process.execPath, [join(scratch, "scripts", "gen-version.mjs")], {
      cwd: scratch,
      env: { PATH: dirname(process.execPath) },
      encoding: "utf8",
    });
    assert.equal(result, "");
    const info = JSON.parse(readFileSync(join(scratch, "dist", "build-info.json"), "utf8"));
    assert.deepEqual(info, { version: "1.2.3", sha: null, dirty: false });
  });
});
