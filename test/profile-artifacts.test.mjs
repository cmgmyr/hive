import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { after, describe, it } from "node:test";
import { failureCount, isolateTmux, runCli, scratchDirs } from "./helpers.mjs";

const { cleanup: cleanupTmux } = isolateTmux("the profile artifacts tests");
after(() => cleanupTmux());

const REPO = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const scratch = mkdtempSync(join(tmpdir(), "hive-profile-artifacts-"));
process.env.HIVE_DATA_DIR = scratch;
after(() => rmSync(scratch, { recursive: true, force: true }));

const {
  isValidProfileFileName,
  isValidProfileName,
  profileFileNames,
  readProfileFile,
  renderProfileFile,
  resolveProfileFile,
} = await import("../dist/profiles.js");

function writeExtra(name, file, content) {
  const dir = join(scratch, "profiles", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), content);
}

describe("todo 339/454: a fork-local .md that is not one of the three named files", () => {
  it("resolves and reads, returning source \"user\", with no forking involved", () => {
    writeExtra("orchestration", "extra.md", "Review checklist for {{repo}}.\n");
    const resolved = resolveProfileFile("orchestration", "extra.md");
    assert.equal(resolved.source, "user");
    assert.equal(readProfileFile("orchestration", "extra.md"), "Review checklist for {{repo}}.\n");
  });

  it("renders its {{vars}} the same as the three named files, drops sections whose var is unset", () => {
    writeExtra(
      "orchestration",
      "extra.md",
      ["Repo: {{repo}}", "<!--if:strict-->", "Strict mode: {{strict}}", "<!--end-->"].join("\n"),
    );
    const rendered = renderProfileFile("orchestration", "extra.md", { repo: "cmgmyr/hive" });
    assert.match(rendered, /Repo: cmgmyr\/hive/);
    assert.doesNotMatch(rendered, /Strict mode/);
  });

  it("profileFileNames lists the three named files first, extras sorted after", () => {
    writeExtra("ordering-repro", "posture.md", "p\n");
    writeExtra("ordering-repro", "zzz-extra.md", "z\n");
    writeExtra("ordering-repro", "aaa-extra.md", "a\n");
    const names = profileFileNames("ordering-repro");
    assert.deepEqual(names, ["posture.md", "aaa-extra.md", "zzz-extra.md"]);
  });

  it("prints through `hive profile read <file> --profile <name>`", async () => {
    writeExtra("orchestration", "extra.md", "Fixed review text, no vars.\n");
    const dirs = scratchDirs();
    const { code, stdout } = await runCli(
      ["profile", "read", "extra.md", "--profile", "orchestration"],
      { cwd: dirs.projectDir, dataDir: scratch, tmp: dirs.tmp },
    );
    assert.equal(code, 0, stdout);
    assert.match(stdout, /Fixed review text, no vars\./);
  });

  it("`hive profile read` defaults to the current project's profile and vars", async () => {
    writeExtra("orchestration", "extra.md", "Repo under review: {{repo}}\n");
    const dirs = scratchDirs();
    writeFileSync(join(dirs.projectDir, "hive.yml"), "profile: orchestration\nvars:\n  repo: cmgmyr/hive\n");
    const { code, stdout } = await runCli(["profile", "read", "extra.md"], {
      cwd: dirs.projectDir,
      dataDir: scratch,
      tmp: dirs.tmp,
    });
    assert.equal(code, 0, stdout);
    assert.match(stdout, /Repo under review: cmgmyr\/hive/);
  });

  it("names what IS present and exits 1 for an unknown file", async () => {
    const dirs = scratchDirs();
    const { code, stdout } = await runCli(
      ["profile", "read", "does-not-exist.md", "--profile", "orchestration"],
      { cwd: dirs.projectDir, dataDir: scratch, tmp: dirs.tmp },
    );
    assert.equal(code, 1);
    assert.match(stdout, /No readable "does-not-exist\.md" for profile "orchestration"/);
    assert.match(stdout, /Files present: posture\.md, runbook\.md, worker\.md/);
  });

  it("reads correctly with --profile BEFORE the file argument, not just after", async () => {
    writeExtra("orchestration", "extra.md", "Fixed review text, no vars.\n");
    const dirs = scratchDirs();
    const { code, stdout } = await runCli(
      ["profile", "read", "--profile", "orchestration", "extra.md"],
      { cwd: dirs.projectDir, dataDir: scratch, tmp: dirs.tmp },
    );
    assert.equal(code, 0, stdout);
    assert.match(stdout, /Fixed review text, no vars\./);
  });
});

describe("todo 339/454: the filename guard is the load-bearing part of the widening", () => {
  it("refuses a separator, \"..\", a leading dot, or a missing .md suffix", () => {
    for (const bad of ["../secret.md", "sub/dir.md", "..md", ".hidden.md", "noext", ""]) {
      assert.equal(isValidProfileFileName(bad), false, `${bad} should be rejected`);
      assert.equal(resolveProfileFile("orchestration", bad), null, `${bad} should not resolve`);
    }
  });

  it("accepts a plain <name>.md", () => {
    assert.equal(isValidProfileFileName("extra.md"), true);
    assert.equal(isValidProfileFileName("review-notes.md"), true);
    assert.equal(isValidProfileFileName("checklist.md"), true);
  });

  it("cannot escape the profile directory even when the target file exists one level up", () => {
    writeFileSync(join(scratch, "profiles", "leaked.md"), "should never be reachable\n");
    mkdirSync(join(scratch, "profiles", "orchestration"), { recursive: true });
    assert.equal(resolveProfileFile("orchestration", "../leaked.md"), null);
    assert.equal(readProfileFile("orchestration", "../leaked.md"), null);
  });

  it("`hive profile read` refuses a path-shaped file argument", async () => {
    const dirs = scratchDirs();
    const { code, stdout } = await runCli(
      ["profile", "read", "../leaked.md", "--profile", "orchestration"],
      { cwd: dirs.projectDir, dataDir: scratch, tmp: dirs.tmp },
    );
    assert.equal(code, 1);
    assert.match(stdout, /No readable "\.\.\/leaked\.md"/);
  });

  it("profileFileNames refuses a name that escapes the profile directories, same as every sibling", () => {
    const escape = relative(join(scratch, "profiles"), join(REPO, "docs"));
    assert.equal(isValidProfileName(escape), false, "precondition: the escape path must be an invalid name");
    assert.deepEqual(profileFileNames(escape), []);
  });

  it("`hive profile read`'s error message never leaks filenames from outside the profile dirs", async () => {
    const dirs = scratchDirs();
    const escape = relative(join(scratch, "profiles"), join(REPO, "docs"));
    const { code, stdout } = await runCli(
      ["profile", "read", "extra.md", "--profile", escape],
      { cwd: dirs.projectDir, dataDir: scratch, tmp: dirs.tmp },
    );
    assert.equal(code, 1);
    assert.doesNotMatch(stdout, /profiles\.md|concepts\.md|tools\.md/, "docs/ filenames must never appear here");
  });
});

describe("todo 339/454: doctor sees an unset {{var}} in a fork-local extra", () => {
  it("reports a var referenced only by the extra, not by runbook or posture", async () => {
    const dirs = scratchDirs();
    const opts = { cwd: dirs.projectDir, dataDir: dirs.dataDir, tmp: dirs.tmp };
    const dir = join(dirs.dataDir, "profiles", "extra-var-repro");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "posture.md"), "# posture\n");
    writeFileSync(join(dir, "runbook.md"), "# runbook\n");
    writeFileSync(join(dir, "extra.md"), "Run {{reviewer_command}} before merging.\n");
    writeFileSync(join(dirs.projectDir, "hive.yml"), "profile: extra-var-repro\n");

    const init = await runCli(["init"], opts);
    assert.equal(init.code, 0, init.stderr);

    const out = await runCli(["doctor"], opts);
    assert.match(out.stdout, /info {2}profile vars: profile files reference reviewer_command/);
    assert.match(out.stdout, /info {2}profile vars: not set here \(sections drop\): reviewer_command/);
  });

  it("never reports worker.md's per-spawn identity vars as missing (agent_name, actor_id, ...)", async () => {
    const dirs = scratchDirs();
    const opts = { cwd: dirs.projectDir, dataDir: dirs.dataDir, tmp: dirs.tmp };
    writeFileSync(join(dirs.projectDir, "hive.yml"), "profile: orchestration\n");
    const init = await runCli(["init"], opts);
    assert.equal(init.code, 0, init.stderr);

    const out = await runCli(["doctor"], opts);
    assert.doesNotMatch(out.stdout, /agent_name/);
    assert.doesNotMatch(out.stdout, /actor_id/);
  });

  it("does not report a hive.yml var as unreferenced when only worker.md's conditional block uses it", async () => {
    const dirs = scratchDirs();
    const opts = { cwd: dirs.projectDir, dataDir: dirs.dataDir, tmp: dirs.tmp };
    const dir = join(dirs.dataDir, "profiles", "worker-only-var");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "posture.md"), "Repo: {{repo}}\n");
    writeFileSync(join(dir, "runbook.md"), "# runbook\n");
    writeFileSync(join(dir, "worker.md"), ["<!--if:check-->", "Run {{check}} before you report done.", "<!--end-->"].join("\n"));
    writeFileSync(
      join(dirs.projectDir, "hive.yml"),
      "profile: worker-only-var\nvars:\n  repo: cmgmyr/hive\n  check: npm run build\n",
    );

    const init = await runCli(["init"], opts);
    assert.equal(init.code, 0, init.stderr);

    const out = await runCli(["doctor"], opts);
    assert.match(out.stdout, /info {2}profile vars: profile files reference repo/);
    assert.doesNotMatch(out.stdout, /defined but unreferenced/);
  });
});

describe("todo 339/454: no-regression, the three named files behave exactly as before", () => {
  it("posture is still injected and rendered, unaffected by an extra sitting alongside it", async () => {
    const dirs = scratchDirs();
    const opts = { cwd: dirs.projectDir, dataDir: dirs.dataDir, tmp: dirs.tmp };
    const dir = join(dirs.dataDir, "profiles", "orchestration");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "posture.md"), "Lead for {{repo}}.\n");
    writeFileSync(join(dir, "extra.md"), "unrelated extra\n");
    writeFileSync(join(dirs.projectDir, "hive.yml"), "profile: orchestration\nvars:\n  repo: cmgmyr/hive\n");

    const { code, stdout } = await runCli(["posture"], opts);
    assert.equal(code, 0);
    assert.match(stdout, /Lead for cmgmyr\/hive\./);
    assert.doesNotMatch(stdout, /unrelated extra/);
  });

  it("doctor still fails a profile with no readable runbook.md when an extra is the only readable file", async () => {
    const dirs = scratchDirs();
    const opts = { cwd: dirs.projectDir, dataDir: dirs.dataDir, tmp: dirs.tmp };
    const dir = join(dirs.dataDir, "profiles", "extra-only");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "extra.md"), "an extra with no runbook alongside it\n");
    writeFileSync(join(dirs.projectDir, "hive.yml"), "profile: extra-only\n");

    const init = await runCli(["init"], opts);
    assert.equal(init.code, 0, init.stderr);
    const out = await runCli(["doctor"], opts);

    assert.match(out.stdout, /FAIL {2}profile: "extra-only" has no readable runbook\.md/);
    assert.match(out.stdout, /info {2}profile: extra-only \(extra\.md: user\)/);
  });

  it("`hive profile list` still shows the three named files, plus an extra with no drift column", async () => {
    const dirs = scratchDirs();
    const opts = { cwd: dirs.projectDir, dataDir: dirs.dataDir, tmp: dirs.tmp };
    const dir = join(dirs.dataDir, "profiles", "orchestration");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "extra.md"), "an extra\n");
    writeFileSync(join(dirs.projectDir, "hive.yml"), "profile: orchestration\n");

    const { code, stdout } = await runCli(["profile", "list"], opts);
    assert.equal(code, 0);
    assert.match(stdout, /posture\.md\s+shipped/);
    assert.match(stdout, /runbook\.md\s+shipped/);
    assert.match(stdout, /worker\.md\s+shipped/);
    assert.match(stdout, /extra\.md\s+user\s+\S+extra\.md$/m);
    assert.doesNotMatch(stdout, /extra\.md.*rewrite/);
    assert.doesNotMatch(stdout, /extra\.md.*diverged/);
  });

  it("widens the filename column to fit a longer extra, keeping the source column aligned", async () => {
    const dirs = scratchDirs();
    const opts = { cwd: dirs.projectDir, dataDir: dirs.dataDir, tmp: dirs.tmp };
    const dir = join(dirs.dataDir, "profiles", "orchestration");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "checklist.md"), "a file name longer than the 11-char column\n");
    writeFileSync(join(dirs.projectDir, "hive.yml"), "profile: orchestration\n");

    const { code, stdout } = await runCli(["profile", "list"], opts);
    assert.equal(code, 0);

    const lines = stdout.split("\n").filter((l) => /^\s{4}\S+\.md\s/.test(l));
    assert.ok(lines.length > 1, "expected more than one file row to compare column positions against");
    const sourceColumnAt = (line) => line.search(/\b(user|shipped)\b/);
    const positions = new Set(lines.map(sourceColumnAt));
    assert.equal(positions.size, 1, `source column should start at the same offset on every row: ${lines.join(" | ")}`);

    assert.match(stdout, /checklist\.md\s+user/);
  });
});
