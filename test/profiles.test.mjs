import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { isolateTmux, runCli, scratchDirs } from "./helpers.mjs";

const { cleanup: cleanupTmux } = isolateTmux("the profile tests");
after(() => cleanupTmux());

const scratch = mkdtempSync(join(tmpdir(), "hive-profiles-"));
process.env.HIVE_DATA_DIR = scratch;
const {
  forkProfile,
  isValidProfileName,
  profileExists,
  profileNames,
  profileStatus,
  readProfileFile,
  referencedPads,
  referencedPaths,
  renderTemplate,
  resolveProfileFile,
  REWRITE_THRESHOLD,
  shippedProfilesDir,
  templateVars,
} = await import("../dist/profiles.js");
const { loadProjectYml } = await import("../dist/projectYml.js");

after(() => rmSync(scratch, { recursive: true, force: true }));

function ymlProject(body) {
  const dir = mkdtempSync(join(tmpdir(), "hive-yml-"));
  writeFileSync(join(dir, "hive.yml"), body);
  return dir;
}

describe("profile resolution", () => {
  it("finds hive's shipped profiles", () => {
    assert.deepEqual(profileNames().includes("orchestration"), true);
    assert.deepEqual(profileNames().includes("simple"), true);
    assert.equal(resolveProfileFile("orchestration", "posture.md").source, "shipped");
    assert.equal(profileExists("orchestration"), true);
    assert.equal(profileExists("nope"), false);
  });

  it("prefers a user file over the shipped one, per file", () => {
    mkdirSync(join(scratch, "profiles", "orchestration"), { recursive: true });
    writeFileSync(join(scratch, "profiles", "orchestration", "posture.md"), "mine\n");

    assert.equal(resolveProfileFile("orchestration", "posture.md").source, "user");
    assert.equal(readProfileFile("orchestration", "posture.md"), "mine\n");

    assert.equal(resolveProfileFile("orchestration", "runbook.md").source, "shipped");
    assert.equal(resolveProfileFile("orchestration", "worker.md").source, "shipped");
  });

  it("reports nothing for a profile that does not exist", () => {
    assert.equal(resolveProfileFile("ghost", "posture.md"), null);
    assert.equal(readProfileFile("ghost", "runbook.md"), null);
  });

  it("refuses names that could walk out of the profile directories", () => {

    for (const bad of ["../evil", "a/b", "..", "/etc/passwd", "", ".hidden"]) {
      assert.equal(isValidProfileName(bad), false, `${bad} should be rejected`);
      assert.equal(resolveProfileFile(bad, "posture.md"), null);
      assert.equal(profileExists(bad), false);
    }
    assert.equal(isValidProfileName("orchestration"), true);
    assert.equal(isValidProfileName("work.v2-b_1"), true);
  });
});

describe("profile fork", () => {
  it("copies on write and never clobbers an existing fork", () => {
    const first = forkProfile("simple");
    assert.deepEqual(first.copied, ["posture.md"]);
    assert.equal(readFileSync(join(scratch, "profiles", "simple", "posture.md"), "utf8").length > 0, true);

    writeFileSync(join(scratch, "profiles", "simple", "posture.md"), "edited\n");
    const second = forkProfile("simple");
    assert.deepEqual(second.copied, []);
    assert.deepEqual(second.skipped, ["posture.md"]);
    assert.equal(readProfileFile("simple", "posture.md"), "edited\n");
  });

  it("reports when hive's default moved after a fork", () => {

    const before = profileStatus("simple").files.find((f) => f.file === "posture.md");
    assert.equal(before.source, "user");
    assert.equal(before.upstreamMoved, false);

    const origins = JSON.parse(readFileSync(join(scratch, "profiles", "simple", ".hive-origin.json"), "utf8"));
    origins["posture.md"] = "0000000000000000";
    writeFileSync(join(scratch, "profiles", "simple", ".hive-origin.json"), JSON.stringify(origins));

    assert.equal(profileStatus("simple").files.find((f) => f.file === "posture.md").upstreamMoved, true);
  });
});

describe("profile divergence", () => {

  const divergenceScratch = mkdtempSync(join(tmpdir(), "hive-profiles-divergence-"));
  after(() => rmSync(divergenceScratch, { recursive: true, force: true }));

  function withDivergenceDataDir(fn) {
    const prev = process.env.HIVE_DATA_DIR;
    process.env.HIVE_DATA_DIR = divergenceScratch;
    try {
      return fn();
    } finally {
      process.env.HIVE_DATA_DIR = prev;
    }
  }

  it("reports null for a file that has never been forked", () => {
    withDivergenceDataDir(() => {
      const status = profileStatus("orchestration").files.find((f) => f.file === "worker.md");
      assert.equal(status.source, "shipped");
      assert.equal(status.divergence, null);
    });
  });

  it("stays well below the rewrite threshold for a one-line edit", () => {
    withDivergenceDataDir(() => {
      mkdirSync(join(divergenceScratch, "profiles", "orchestration"), { recursive: true });
      const shipped = readFileSync(join(shippedProfilesDir, "orchestration", "posture.md"), "utf8");
      const lines = shipped.split("\n");
      lines[0] = `${lines[0]} -- one word added`;
      writeFileSync(join(divergenceScratch, "profiles", "orchestration", "posture.md"), lines.join("\n"));

      const status = profileStatus("orchestration").files.find((f) => f.file === "posture.md");
      assert.equal(status.source, "user");
      assert.ok(
        status.divergence > 0 && status.divergence < REWRITE_THRESHOLD,
        `expected drift below ${REWRITE_THRESHOLD}, got ${status.divergence}`,
      );
    });
  });

  it("crosses the rewrite threshold for a fork sharing almost no lines with hive's default", () => {
    withDivergenceDataDir(() => {
      mkdirSync(join(divergenceScratch, "profiles", "orchestration"), { recursive: true });
      writeFileSync(
        join(divergenceScratch, "profiles", "orchestration", "runbook.md"),
        "this runbook is written from scratch for this project and shares nothing with hive's shipped default\n",
      );

      const status = profileStatus("orchestration").files.find((f) => f.file === "runbook.md");
      assert.equal(status.source, "user");
      assert.ok(status.divergence >= REWRITE_THRESHOLD, `expected a rewrite, got ${status.divergence}`);
    });
  });

  it("is symmetric and near zero for an identical copy", () => {
    withDivergenceDataDir(() => {
      mkdirSync(join(divergenceScratch, "profiles", "orchestration"), { recursive: true });
      const shipped = readFileSync(join(shippedProfilesDir, "orchestration", "worker.md"), "utf8");
      writeFileSync(join(divergenceScratch, "profiles", "orchestration", "worker.md"), shipped);

      const status = profileStatus("orchestration").files.find((f) => f.file === "worker.md");
      assert.equal(status.source, "user");
      assert.equal(status.divergence, 0);
    });
  });
});

describe("template rendering", () => {
  const doc = [
    "repo {{repo}}",
    "<!--if:ticket_prefix-->",
    "ticket lane {{ticket_prefix}}-NNN",
    "<!--if:start_command-->",
    "start with {{start_command}}",
    "<!--end-->",
    "<!--end-->",
    "tail",
  ].join("\n");

  it("substitutes {{var}} and keeps sections whose var is set", () => {
    const out = renderTemplate(doc, { repo: "owner/name", ticket_prefix: "DEVX", start_command: "/jira-start" });
    assert.match(out, /repo owner\/name/);
    assert.match(out, /ticket lane DEVX-NNN/);
    assert.match(out, /start with \/jira-start/);
    assert.doesNotMatch(out, /<!--/);
  });

  it("drops a section when its var is missing", () => {
    const out = renderTemplate(doc, { repo: "owner/name" });
    assert.doesNotMatch(out, /ticket lane/);
    assert.doesNotMatch(out, /start with/);
    assert.match(out, /^tail$/m);
  });

  it("treats an empty or whitespace var as missing", () => {
    for (const value of ["", "   "]) {
      const out = renderTemplate(doc, { ticket_prefix: value });
      assert.doesNotMatch(out, /ticket lane/, `"${value}" should drop the section`);
    }
  });

  it("drops a nested section without dropping its parent", () => {
    const out = renderTemplate(doc, { ticket_prefix: "DEVX" });
    assert.match(out, /ticket lane DEVX-NNN/);
    assert.doesNotMatch(out, /start with/);
  });

  it("leaves an undefined {{var}} visible instead of silently emptying it", () => {

    assert.match(renderTemplate("repo {{repo}}", {}), /repo \{\{repo\}\}/);
  });

  it("leaves the model's own <placeholders> alone", () => {
    const text = "work on <branch> in <files/area>";
    assert.equal(renderTemplate(text, { branch: "main" }), text);
  });

  it("lists every var a template references", () => {
    assert.deepEqual(templateVars(doc), ["repo", "start_command", "ticket_prefix"]);
  });

  it("renders hive's shipped runbook without leaving markers behind", () => {
    const out = renderTemplate(readProfileFile("orchestration", "runbook.md"), {
      repo: "cmgmyr/hive",
      install: "npm install",
    });
    assert.doesNotMatch(out, /<!--if:|<!--\s*end/);
    assert.match(out, /cmgmyr\/hive/);
    assert.doesNotMatch(out, /TICKET LANE \(/, "the ticket section drops without ticket_prefix");
    assert.match(out, /A fresh worktree has no dependencies installed: npm install/);
  });
});

describe("referenced pads and paths (todo 332)", () => {
  it("catches all four high-confidence pad shapes", () => {
    const text = [
      "Read the pad with `hive pad lessons --save`.",
      'pad_read(name="board")',
      'pad_write(name="scratch")',
      '"prompts" pad is optional.',
      'append to pad "ledger" when you ship.',
    ].join("\n");
    assert.deepEqual(referencedPads(text), ["board", "ledger", "lessons", "prompts", "scratch"]);
  });

  it("does not read `hive pad <name>`'s own placeholder syntax as a pad name", () => {

    assert.deepEqual(referencedPads("`hive pad\n<name> --save` when a pad is too large to edit."), []);
  });

  it("does not read a CLI flag after `hive pad` as the pad name", () => {

    assert.deepEqual(referencedPads("use `hive pad --save <file>` for a large pad."), []);
  });

  it("catches both path shapes, a directory and a file", () => {
    const text = "See `.claude/rules/` and `scripts/covering-rules.mjs` for the covering rules.";
    assert.deepEqual(referencedPaths(text), [".claude/rules/", "scripts/covering-rules.mjs"]);
  });

  it("resolves a glob suffix to its directory, matching the real fork's `.claude/rules/*.md`", () => {
    assert.deepEqual(referencedPaths("Every `.claude/rules/*.md` file declares `paths:` globs."), [
      ".claude/rules/*.md",
    ]);
  });

  it("ignores an absolute or home-relative path - not repo-relative, out of scope", () => {
    assert.deepEqual(referencedPaths("run `python3 ~/.claude/skills/usage/scripts/usage.py`."), []);
    assert.deepEqual(referencedPaths("see `/etc/hosts` for details."), []);
  });

  it("ignores a shell command with flags, even one containing a slash", () => {
    assert.deepEqual(referencedPaths("run `git commit --no-gpg-sign` first."), []);
    assert.deepEqual(referencedPaths("check `hive doctor --strict` output."), []);
  });

  it("ignores a bare filename with a known extension and no slash (measured false positive)", () => {

    assert.deepEqual(referencedPaths("Read `working-on.md` plus every dead-end that applies."), []);
  });

  it("ignores an unbackticked path in prose", () => {
    assert.deepEqual(referencedPaths("tooling that exists only in hive (.claude/rules/, scripts/x.mjs)"), []);
  });
});

describe("hive.yml profile keys", () => {
  it("reads profile, lead_branches, and vars", () => {
    const { config, warnings } = loadProjectYml(
      ymlProject("profile: orchestration\nlead_branches: [main, trunk]\nvars:\n  repo: owner/name\n  ticket_prefix: DEVX\n"),
    );
    assert.deepEqual(warnings, []);
    assert.equal(config.profile, "orchestration");
    assert.deepEqual(config.lead_branches, ["main", "trunk"]);
    assert.deepEqual(config.vars, { repo: "owner/name", ticket_prefix: "DEVX" });
  });

  it("keeps absent apart from none", () => {

    assert.equal(loadProjectYml(ymlProject("placement: split\n")).config.profile, null);
    assert.equal(loadProjectYml(ymlProject("profile: none\n")).config.profile, "none");
    assert.deepEqual(loadProjectYml(ymlProject("placement: split\n")).config.lead_branches, null);
  });

  it("warns and ignores a profile name that could escape the profile dirs", () => {
    const { config, warnings } = loadProjectYml(ymlProject("profile: ../../etc\n"));
    assert.equal(config.profile, null);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /not a valid profile name/);
  });

  it("warns and ignores malformed lead_branches and vars", () => {
    const { config, warnings } = loadProjectYml(ymlProject("lead_branches: main\nvars:\n  nested:\n    a: 1\n"));
    assert.equal(config.lead_branches, null);
    assert.deepEqual(config.vars, {});
    assert.equal(warnings.length, 2);
  });
});

describe("hive runbook and hive profile", () => {
  const dirs = scratchDirs();
  const cliOpts = { cwd: dirs.projectDir, dataDir: dirs.dataDir, tmp: dirs.tmp };

  it("prints the profile runbook with the project's vars resolved", async () => {
    writeFileSync(
      join(dirs.projectDir, "hive.yml"),
      "profile: orchestration\nvars:\n  repo: cmgmyr/hive\n  ticket_prefix: DEVX\n",
    );
    const { code, stdout } = await runCli(["runbook"], cliOpts);
    assert.equal(code, 0);
    assert.match(stdout, /RUNBOOK/);
    assert.doesNotMatch(stdout, /<!--/);

    assert.match(stdout, /DEVX-NNN/, "a declared var substitutes and opens its section");
    assert.match(stdout, /cmgmyr\/hive/);
    assert.doesNotMatch(stdout, /not approved/, "there is no approval step any more");
  });

  it("falls back to the runbook pad when the project chose profile: none", async () => {

    writeFileSync(join(dirs.projectDir, "hive.yml"), "placement: split\n");
    const init = await runCli(["init", "--no-profile"], cliOpts);
    assert.equal(init.code, 0, init.stderr);
    assert.match(readFileSync(join(dirs.projectDir, "hive.yml"), "utf8"), /^profile: none$/m);

    const { code, stdout } = await runCli(["runbook"], cliOpts);
    assert.equal(code, 0);
    assert.match(stdout, /RUNBOOK — standing instructions/);
  });

  it("lists profiles and marks the current project's", async () => {
    writeFileSync(join(dirs.projectDir, "hive.yml"), "profile: orchestration\n");
    const { code, stdout } = await runCli(["profile", "list"], cliOpts);
    assert.equal(code, 0);
    assert.match(stdout, /\* orchestration/);
    assert.match(stdout, /posture\.md\s+shipped/);
    assert.match(stdout, /^\s+simple/m);
  });

  it("names a fork's drift the same way doctor does (todo 326 comment 723)", async () => {

    const fresh = scratchDirs();
    const freshOpts = { cwd: fresh.projectDir, dataDir: fresh.dataDir, tmp: fresh.tmp };
    mkdirSync(join(fresh.dataDir, "profiles", "orchestration"), { recursive: true });
    writeFileSync(
      join(fresh.dataDir, "profiles", "orchestration", "runbook.md"),
      "this runbook is written from scratch for this project and shares nothing with hive's shipped default\n",
    );

    writeFileSync(
      join(fresh.dataDir, "profiles", "orchestration", ".hive-origin.json"),
      JSON.stringify({ "runbook.md": "0000000000000000" }),
    );
    writeFileSync(join(fresh.projectDir, "hive.yml"), "profile: orchestration\n");

    const { code, stdout } = await runCli(["profile", "list"], freshOpts);

    assert.equal(code, 0);

    assert.match(stdout, /runbook\.md is a \d+% rewrite of hive's default, not an edited copy of it/);
    assert.doesNotMatch(stdout, /changed since you forked/);
  });

  it("forks into the data dir and then resolves the fork", async () => {
    const fork = await runCli(["profile", "fork", "orchestration", "posture.md"], cliOpts);
    assert.equal(fork.code, 0, fork.stdout);
    assert.match(fork.stdout, /forked posture\.md/);

    const { stdout } = await runCli(["profile", "path", "orchestration", "posture.md"], cliOpts);
    assert.equal(stdout.trim(), join(dirs.dataDir, "profiles", "orchestration", "posture.md"));
  });

  it("renders posture the same way it renders the runbook", async () => {

    const forked = join(dirs.dataDir, "profiles", "orchestration");
    mkdirSync(forked, { recursive: true });
    writeFileSync(
      join(forked, "posture.md"),
      [
        "Lead for {{repo}}.",
        "<!--if:ticket_prefix-->",
        "Ticket work is {{ticket_prefix}}-NNN.",
        "<!--end-->",
        "Undefined stays visible: {{nothing}}",
      ].join("\n"),
    );
    writeFileSync(join(dirs.projectDir, "hive.yml"), "profile: orchestration\nvars:\n  repo: cmgmyr/hive\n");

    const { code, stdout } = await runCli(["posture"], cliOpts);
    assert.equal(code, 0);
    assert.match(stdout, /Lead for cmgmyr\/hive\./, "a declared var substitutes, same as the runbook");
    assert.doesNotMatch(stdout, /Ticket work/, "an unset var drops its section, same as the runbook");
    assert.match(stdout, /\{\{nothing\}\}/, "an undefined var stays visible, same as the runbook");
    assert.doesNotMatch(stdout, /<!--/);
  });

  it("says so when the project has no profile to take posture from", async () => {
    writeFileSync(join(dirs.projectDir, "hive.yml"), "profile: none\n");
    const { code, stdout } = await runCli(["posture"], cliOpts);
    assert.equal(code, 1);
    assert.match(stdout, /no profile/);
  });

  it("fails cleanly on an unknown profile", async () => {
    const { code, stdout } = await runCli(["profile", "path", "ghost"], cliOpts);
    assert.equal(code, 1);
    assert.match(stdout, /No profile named "ghost"/);
  });
});
