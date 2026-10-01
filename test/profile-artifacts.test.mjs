import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
    const opts = { cwd: dirs.projectDir, dataDir: scratch, tmp: dirs.tmp };
    await runCli(["init", "--no-profile"], opts);
    writeFileSync(join(dirs.projectDir, "hive.yml"), "profile: orchestration\nvars:\n  repo: cmgmyr/hive\n");
    const { code, stdout } = await runCli(["profile", "read", "extra.md"], opts);
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
    await runCli(["init", "--no-profile"], opts);
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
    assert.match(stdout, /extra\.md\s+user\s+\S+extra\.md \[\d+ rendered bytes\]$/m);
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

describe("todo 1633: profile list and doctor show the rendered size, and advise only above 25600 bytes", () => {
  const ADVISORY = /rendered size exceeds 25600 bytes/;

  async function project(profile, files, yml = `profile: ${profile}\n`) {
    const d = scratchDirs();
    const o = { cwd: d.projectDir, dataDir: d.dataDir, tmp: d.tmp };
    const dir = join(d.dataDir, "profiles", profile);
    mkdirSync(dir, { recursive: true });
    for (const [file, content] of Object.entries(files)) writeFileSync(join(dir, file), content);
    await runCli(["init", "--no-profile"], o);
    writeFileSync(join(d.projectDir, "hive.yml"), yml);
    return o;
  }

  const readBytes = async (o, profile, file) => {
    const read = await runCli(["profile", "read", file, "--profile", profile], o);
    assert.equal(read.code, 0, read.stdout);
    return Buffer.byteLength(read.stdout, "utf8");
  };

  const listedBytes = (stdout, profile, file) => {
    const block = stdout.split(/^[* ] (?=\S)/m).find((b) => b.startsWith(`${profile}\n`));
    assert.ok(block, `profile ${profile} missing from:\n${stdout}`);
    const m = new RegExp(`^ {4}${file.replace(".", "\\.")}\\s.*\\[(\\d+) rendered bytes\\]$`, "m").exec(block);
    assert.ok(m, `no byte field for ${file} in:\n${block}`);
    return Number(m[1]);
  };

  const doctorBytes = (stdout, profile, file) => {
    const m = new RegExp(`info {2}profile size: ${profile}/${file.replace(".", "\\.")}: (\\d+) rendered bytes`).exec(stdout);
    assert.ok(m, `no doctor size row for ${file} in:\n${stdout}`);
    return Number(m[1]);
  };

  it("matches the bytes `profile read` prints for UTF-8, var expansion, stripped conditionals and literal worker vars", async () => {
    const o = await project(
      "sized",
      {
        "posture.md": "h\u00e9llo \u2603 {{repo}}\n",
        "runbook.md": ["start", "<!--if:strict-->", "x".repeat(500), "<!--end-->", "end"].join("\n"),
        "worker.md": "You are {{agent_name}} in {{repo}}.\n",
        "extra.md": "no trailing newline",
      },
      "profile: sized\nvars:\n  repo: a-much-longer-repository-name\n",
    );
    const list = await runCli(["profile", "list"], o);
    const doctor = await runCli(["doctor"], o);
    for (const file of ["posture.md", "runbook.md", "worker.md", "extra.md"]) {
      const expected = await readBytes(o, "sized", file);
      assert.equal(listedBytes(list.stdout, "sized", file), expected, `list ${file}`);
      assert.equal(doctorBytes(doctor.stdout, "sized", file), expected, `doctor ${file}`);
    }
    const worker = await runCli(["profile", "read", "worker.md", "--profile", "sized"], o);
    assert.match(worker.stdout, /You are \{\{agent_name\}\} in a-much-longer-repository-name\./);
    assert.doesNotMatch(list.stdout, ADVISORY);
  });

  it("counts an empty file as zero bytes, the same as profile read prints", async () => {
    const o = await project("empty-sized", { "posture.md": "p\n", "runbook.md": "r\n", "extra.md": "" });
    const list = await runCli(["profile", "list"], o);
    assert.equal(await readBytes(o, "empty-sized", "extra.md"), 0);
    assert.equal(listedBytes(list.stdout, "empty-sized", "extra.md"), 0);
  });

  it("shows a user override's size, not the shipped file's", async () => {
    const o = await project("orchestration", { "posture.md": "short override\n" });
    const list = await runCli(["profile", "list"], o);
    assert.equal(listedBytes(list.stdout, "orchestration", "posture.md"), Buffer.byteLength("short override\n"));
    assert.equal(await readBytes(o, "orchestration", "posture.md"), Buffer.byteLength("short override\n"));
  });

  it("renders a profile other than the active one with the reading project's vars", async () => {
    const o = await project("active-one", { "posture.md": "p\n", "runbook.md": "r\n" }, "profile: active-one\nvars:\n  repo: twelve-chars\n");
    const dir = join(o.dataDir, "profiles", "other-one");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "posture.md"), "{{repo}}\n");
    const list = await runCli(["profile", "list"], o);
    assert.equal(listedBytes(list.stdout, "other-one", "posture.md"), Buffer.byteLength("twelve-chars\n"));
    assert.equal(await readBytes(o, "other-one", "posture.md"), Buffer.byteLength("twelve-chars\n"));
  });

  it("lists outside a registered project with no project vars", async () => {
    const o = await project("novars", { "posture.md": "{{repo}}|<!--if:repo-->gone<!--end-->\n", "runbook.md": "r\n" });
    const bare = scratchDirs();
    mkdirSync(join(bare.dataDir, "profiles"), { recursive: true });
    const outside = { cwd: bare.projectDir, dataDir: o.dataDir, tmp: bare.tmp };
    const list = await runCli(["profile", "list"], outside);
    assert.equal(list.code, 0, list.stdout);
    assert.equal(listedBytes(list.stdout, "novars", "posture.md"), await readBytes(outside, "novars", "posture.md"));
  });

  it("reports an unreadable resolved file as unavailable, on both surfaces, without a failure", async () => {
    const o = await project("unreadable", { "posture.md": "p\n", "runbook.md": "r\n", "extra.md": "x\n" });
    const extra = join(o.dataDir, "profiles", "unreadable", "extra.md");
    chmodSync(extra, 0o000);
    try {
      const list = await runCli(["profile", "list"], o);
      const doctor = await runCli(["doctor"], o);
      assert.match(list.stdout, /extra\.md\s+user\s+\S+extra\.md \[rendered size unavailable\]$/m);
      assert.match(doctor.stdout, /info {2}profile size: unreadable\/extra\.md: rendered size unavailable/);
      assert.doesNotMatch(doctor.stdout, /FAIL {2}profile/);
    } finally {
      chmodSync(extra, 0o644);
    }
  });

  it("advises at 25601 bytes and not at 25599 or 25600, on list and doctor alike", async () => {
    const cases = [
      [25599, false],
      [25600, false],
      [25601, true],
    ];
    for (const [bytes, advises] of cases) {
      const name = `edge-${bytes}`;
      const o = await project(name, { "posture.md": "p\n", "runbook.md": "r\n", "big.md": `${"a".repeat(bytes - 1)}\n` });
      const list = await runCli(["profile", "list"], o);
      const doctor = await runCli(["doctor"], o);
      assert.equal(listedBytes(list.stdout, name, "big.md"), bytes);
      assert.equal(doctorBytes(doctor.stdout, name, "big.md"), bytes);
      assert.equal(await readBytes(o, name, "big.md"), bytes);
      assert.equal(ADVISORY.test(list.stdout), advises, `list at ${bytes}`);
      assert.equal(ADVISORY.test(doctor.stdout), advises, `doctor at ${bytes}`);
      if (advises) {
        assert.match(list.stdout, new RegExp(`${name}/big\\.md: rendered size exceeds 25600 bytes`));
        assert.match(doctor.stdout, new RegExp(`info {2}profile size warning: ${name}/big\\.md: rendered size exceeds`));
        assert.match(doctor.stdout, /redirect hive profile read to a file and read by section/);
      }
    }
  });

  it("measures the rendered size: a large raw conditional stays quiet, a small raw var advises", async () => {
    const stripped = await project("raw-large", {
      "posture.md": "p\n",
      "runbook.md": "r\n",
      "cond.md": `<!--if:unset_var-->\n${"z".repeat(30000)}\n<!--end-->\nok\n`,
    });
    const strippedList = await runCli(["profile", "list"], stripped);
    assert.equal(listedBytes(strippedList.stdout, "raw-large", "cond.md"), await readBytes(stripped, "raw-large", "cond.md"));
    assert.ok(listedBytes(strippedList.stdout, "raw-large", "cond.md") < 25600);
    assert.doesNotMatch(strippedList.stdout, ADVISORY);

    const expanded = await project(
      "raw-small",
      { "posture.md": "p\n", "runbook.md": "r\n", "var.md": "{{blob}}\n" },
      `profile: raw-small\nvars:\n  blob: ${"b".repeat(26000)}\n`,
    );
    const expandedList = await runCli(["profile", "list"], expanded);
    const expandedDoctor = await runCli(["doctor"], expanded);
    assert.equal(listedBytes(expandedList.stdout, "raw-small", "var.md"), 26001);
    assert.match(expandedList.stdout, ADVISORY);
    assert.match(expandedDoctor.stdout, ADVISORY);
  });
});
