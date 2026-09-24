import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
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
    assert.ok(info.build_id.length > 0);
    assert.deepEqual(readdirSync(join(scratch, "dist")), ["build-info.json"]);
    assert.deepEqual(info, { build_id: info.build_id, version: "1.2.3", sha, dirty: false });
  });

  it("stamps a checkout with local edits as dirty: true", () => {
    const scratch = scratchGenerator(dirs.tmp);
    const sha = initGitRepo(scratch);
    writeFileSync(join(scratch, "package.json"), JSON.stringify({ version: "1.2.3", extra: true }));
    execFileSync(process.execPath, [join(scratch, "scripts", "gen-version.mjs")], { cwd: scratch });
    const info = JSON.parse(readFileSync(join(scratch, "dist", "build-info.json"), "utf8"));
    assert.ok(info.build_id.length > 0);
    assert.deepEqual(readdirSync(join(scratch, "dist")), ["build-info.json"]);
    assert.deepEqual(info, { build_id: info.build_id, version: "1.2.3", sha, dirty: true });
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
    assert.ok(info.build_id.length > 0);
    assert.deepEqual(readdirSync(join(scratch, "dist")), ["build-info.json"]);
    assert.deepEqual(info, { build_id: info.build_id, version: "1.2.3", sha: null, dirty: false });
  });
});


describe("running build identity", () => {
  const stamp = { version: "1.2.3", sha: "abc", dirty: true, build_id: "first" };
  async function fixture(initial = stamp) {
    const scratch = scratchVersionModule(dirs.tmp);
    const path = join(scratch, "dist", "build-info.json");
    if (initial !== null) writeFileSync(path, JSON.stringify(initial));
    const module = await import(join(scratch, "dist", "version.js"));
    const swap = (value) => {
      writeFileSync(path + ".tmp", typeof value === "string" ? value : JSON.stringify(value));
      renameSync(path + ".tmp", path);
    };
    return { ...module, path, swap };
  }

  it("equal ids stay silent, including after atomic replacement", async () => {
    const f = await fixture();
    assert.equal(f.runningBuildChange(), null);
    f.swap(stamp);
    assert.equal(f.runningBuildChange(), null);
  });

  it("an atomic same-sha dirty rebuild changes identity without changing the startup snapshot", async () => {
    const f = await fixture();
    const disk = { ...stamp, build_id: "second" };
    f.swap(disk);
    assert.deepEqual(f.runningBuildChange(), { loaded: stamp, disk });
    f.swap({ ...stamp, build_id: "third" });
    assert.equal(f.runningBuildChange().loaded.build_id, "first");
    assert.equal(f.runningBuildChange().disk.build_id, "third");
    assert.match(f.runningBuildNotice(f.runningBuildChange()), /the build on disk changed.*Restart this session/);
  });

  it("a stamp repaired by chmod is re-read without a rewrite", async (t) => {
    const f = await fixture();
    const disk = { ...stamp, build_id: "second" };
    f.swap(disk);
    const mode = statSync(f.path).mode & 0o777;
    chmodSync(f.path, 0);
    try {
      try {
        readFileSync(f.path);
        t.skip("the current user can read mode-000 files, so chmod cannot simulate an unreadable stamp");
        return;
      } catch {
        assert.equal(f.runningBuildChange(), null);
      }
    } finally {
      chmodSync(f.path, mode);
    }
    assert.deepEqual(f.runningBuildChange(), { loaded: stamp, disk });
  });

  it("missing, malformed, legacy and invalid disk identities are silent and recover after replacement", async () => {
    const f = await fixture();
    rmSync(f.path);
    assert.equal(f.runningBuildChange(), null);
    for (const value of ["{", null, { version: "1" }, { ...stamp, build_id: 5 }, { ...stamp, build_id: "" }]) {
      f.swap(value);
      assert.equal(f.runningBuildChange(), null);
    }
    f.swap({ ...stamp, build_id: "recovered" });
    assert.equal(f.runningBuildChange().disk.build_id, "recovered");
  });

  it("an unknown startup identity is never replaced by a later valid disk stamp", async () => {
    for (const initial of [null, { version: "1.2.3", sha: null, dirty: false }]) {
      const f = await fixture(initial);
      f.swap(stamp);
      assert.equal(f.runningBuildChange(), null);
    }
  });
});


it("restart notices describe changed versions, sha and dirty state, abbreviating ids only for identical descriptions", async () => {
  const scratch = scratchVersionModule(dirs.tmp);
  const { runningBuildNotice } = await import(join(scratch, "dist", "version.js"));
  const loaded = { version: "1.1.0", sha: "abc1234", dirty: false, build_id: "28fca1bf-1111-2222-3333-444444444444" };
  const disk = { version: "1.2.0", sha: "def5678", dirty: true, build_id: "91deb234-1111-2222-3333-444444444444" };
  const prefix = "hive: this session's hive server loaded ";
  const remedy = ". Restart this session, or reconnect hive in /mcp, to pick it up.";
  assert.equal(runningBuildNotice({ loaded, disk }),
    prefix + "hive 1.1.0 (abc1234); the build on disk changed to hive 1.2.0 (def5678-dirty)" + remedy);
  assert.equal(runningBuildNotice({ loaded, disk: { ...loaded, build_id: disk.build_id } }),
    prefix + "hive 1.1.0 (abc1234, build 28fca1bf); the build on disk changed to hive 1.1.0 (abc1234, build 91deb234)" + remedy);
  assert.equal(runningBuildNotice({ loaded: { ...loaded, sha: null }, disk: { ...disk, sha: null } }),
    prefix + "hive 1.1.0 (no git sha); the build on disk changed to hive 1.2.0 (no git sha)" + remedy);
});
