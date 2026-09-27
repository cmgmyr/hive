import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { isolateTmux, runCli, scratchDirs } from "./helpers.mjs";

const { cleanup: cleanupTmux } = isolateTmux("the profile skill tests");
after(() => cleanupTmux());

const REPO = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const skillDir = join(REPO, "claude-plugin", "skills", "profile");
const recipesDir = join(skillDir, "references", "recipes");

const scratch = mkdtempSync(join(tmpdir(), "hive-profile-skill-loader-"));
process.env.HIVE_DATA_DIR = scratch;
after(() => rmSync(scratch, { recursive: true, force: true }));

const { renderTemplate, shippedProfilesDir, templateVars } = await import("../dist/profiles.js");

const RECIPE_HEADINGS = ["Problem", "Offer when", "Requirements", "Add", "Verify", "Remove", "Boundaries"];

function indexRows() {
  const raw = readFileSync(join(recipesDir, "index.md"), "utf8");
  const rows = [...raw.matchAll(/^\| \[([^\]]+)\]\(([^)]+)\) \| [^|]+\| [^|]+\| ([^|]+) \|$/gm)];
  assert.ok(rows.length > 0, "index.md's table did not parse - did its column shape change?");
  return rows.map((m) => ({ label: m[1], link: m[2], route: m[3].trim() }));
}

describe("recipe index links five real, well-formed recipes", () => {
  const rows = indexRows();

  it("parses exactly five rows, matching the starter set", () => {
    assert.equal(rows.length, 5);
  });

  for (const { label, link, route } of rows) {
    it(`"${label}" links a recipe file that exists, relative to the index`, () => {
      assert.equal(existsSync(join(recipesDir, link)), true, `${link} does not exist next to index.md`);
    });

    it(`"${label}" declares a route that is simple, orchestration, or both`, () => {
      assert.match(route.toLowerCase(), /^(simple|orchestration|both)\b/);
    });

    it(`"${label}" carries all seven recipe headings, in order`, () => {
      const body = readFileSync(join(recipesDir, link), "utf8");
      const headings = [...body.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
      assert.deepEqual(headings, RECIPE_HEADINGS, `${link} headings: ${headings.join(", ")}`);
    });
  }
});

describe("a recipe's fenced additions render the same way hive's loader renders any profile file", () => {
  function fencedBlocks(body, lang) {
    return [...body.matchAll(new RegExp("```" + lang + "\\n([\\s\\S]*?)```", "g"))].map((m) => m[1]);
  }

  const rows = indexRows();
  for (const { label, link } of rows) {
    const body = readFileSync(join(recipesDir, link), "utf8");
    const markdownBlocks = fencedBlocks(body, "markdown");

    it(`"${label}" has at least one fenced markdown addition to render`, () => {
      assert.ok(markdownBlocks.length > 0, `${link} has no fenced markdown block under its Add heading`);
    });

    for (const [i, block] of markdownBlocks.entries()) {
      const opens = [...block.matchAll(/<!--\s*if:[A-Za-z_][A-Za-z0-9_]*\s*-->/g)].length;
      const ends = [...block.matchAll(/<!--\s*end\s*-->/g)].length;

      it(`"${label}" block ${i} balances its conditional markers 1:1`, () => {
        assert.equal(opens, ends, `${link} block ${i} has ${opens} <!--if--> against ${ends} <!--end-->`);
      });

      const vars = templateVars(block);
      if (vars.length > 0) {
        it(`"${label}" block ${i} renders every referenced var and strips its markers when all are set`, () => {
          const synthetic = Object.fromEntries(vars.map((v) => [v, `test-${v}`]));
          const rendered = renderTemplate(block, synthetic);
          assert.doesNotMatch(rendered, /<!--/, `${link} block ${i} left a marker behind when every var was set`);
          for (const v of vars) assert.match(rendered, new RegExp(`test-${v}`), `${link} block ${i} did not substitute {{${v}}}`);
        });

        it(`"${label}" block ${i} drops each conditional section when its var is unset`, () => {
          const rendered = renderTemplate(block, {});
          for (const v of vars) assert.doesNotMatch(rendered, new RegExp(`\\{\\{${v}\\}\\}`), `${link} block ${i} left {{${v}}} rendered with nothing set`);
        });
      }

      const slotMatch = block.match(/<[a-z][^<>{}]*>/);
      if (slotMatch) {
        it(`"${label}" block ${i} leaves its own <input slot> untouched by rendering`, () => {
          const rendered = renderTemplate(block, Object.fromEntries(vars.map((v) => [v, "x"])));
          assert.ok(rendered.includes(slotMatch[0]), `${link} block ${i}'s "${slotMatch[0]}" should survive rendering untouched`);
        });
      }
    }
  }
});

describe("hive's loader accepts the profiles the skill would produce", () => {
  const dirs = scratchDirs();
  const cliOpts = { cwd: dirs.projectDir, dataDir: dirs.dataDir, tmp: dirs.tmp };

  before(async () => {
    const init = await runCli(["init", "--no-profile"], cliOpts);
    assert.equal(init.code, 0, init.stderr);
  });

  it("a generated simple profile (posture + a minimal runbook) resolves, lists, and passes doctor", async () => {
    const target = join(dirs.dataDir, "profiles", "my-simple");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "posture.md"), readFileSync(join(shippedProfilesDir, "simple", "posture.md"), "utf8"));
    writeFileSync(
      join(target, "runbook.md"),
      ["RUNBOOK — a first profile written from one interview.", "", "<!--if:check-->", "Before you report done: {{check}}", "<!--end-->", ""].join("\n"),
    );
    writeFileSync(join(dirs.projectDir, "hive.yml"), "profile: my-simple\nvars:\n  check: npm run build\n");

    const list = await runCli(["profile", "list"], cliOpts);
    assert.equal(list.code, 0, list.stderr);
    assert.match(list.stdout, /\* my-simple/);
    assert.match(list.stdout, /posture\.md\s+user/);
    assert.match(list.stdout, /runbook\.md\s+user/);

    const doctor = await runCli(["doctor"], cliOpts);
    assert.doesNotMatch(doctor.stdout, /FAIL {2}profile/, doctor.stdout);

    const rendered = await runCli(["profile", "read", "runbook.md"], cliOpts);
    assert.equal(rendered.code, 0, rendered.stderr);
    assert.match(rendered.stdout, /Before you report done: npm run build/);
    assert.doesNotMatch(rendered.stdout, /<!--/);
  });

  it("a generated orchestration profile keeps worker.md's reserved identity placeholders literal", async () => {
    const target = join(dirs.dataDir, "profiles", "my-orchestration");
    mkdirSync(target, { recursive: true });
    for (const file of ["posture.md", "runbook.md", "worker.md"]) {
      writeFileSync(join(target, file), readFileSync(join(shippedProfilesDir, "orchestration", file), "utf8"));
    }
    writeFileSync(join(dirs.projectDir, "hive.yml"), "profile: my-orchestration\n");

    const doctor = await runCli(["doctor"], cliOpts);
    assert.doesNotMatch(doctor.stdout, /FAIL {2}profile/, doctor.stdout);

    const rendered = await runCli(["profile", "read", "worker.md"], cliOpts);
    assert.equal(rendered.code, 0, rendered.stderr);
    assert.match(rendered.stdout, /\{\{agent_name\}\}/, "worker.md's identity vars are per-spawn, not hive.yml vars, and must stay visible");
  });

  it("an added fork-local extra .md is resolved and reported, never treated as required", async () => {
    const target = join(dirs.dataDir, "profiles", "my-simple");
    writeFileSync(join(target, "notes.md"), "A team habit: keep it small.\n");

    const list = await runCli(["profile", "list"], cliOpts);
    assert.equal(list.code, 0, list.stderr);
    assert.match(list.stdout, /notes\.md\s+user/);

    const doctor = await runCli(["doctor"], cliOpts);
    assert.doesNotMatch(doctor.stdout, /FAIL {2}profile/, "an extra .md must never become a required file");

    const rendered = await runCli(["profile", "read", "notes.md", "--profile", "my-simple"], cliOpts);
    assert.equal(rendered.code, 0, rendered.stderr);
    assert.match(rendered.stdout, /A team habit: keep it small\./);
  });

  it("a generated profile with an accepted flows.md diagram is still accepted", async () => {
    const target = join(dirs.dataDir, "profiles", "my-simple");
    writeFileSync(
      target + "/flows.md",
      ["FLOWS", "", "```mermaid", "flowchart TD", "  A[You ask for a check] --> B[Session runs it]", "  B --> C{Passed?}", "  C -->|yes| D[Report done]", "  C -->|no| E[Fix and re-run]", "```", ""].join("\n"),
    );

    const list = await runCli(["profile", "list"], cliOpts);
    assert.equal(list.code, 0, list.stderr);
    assert.match(list.stdout, /flows\.md\s+user/);

    const doctor = await runCli(["doctor"], cliOpts);
    assert.doesNotMatch(doctor.stdout, /FAIL {2}profile/, "flows.md must never become a required file");

    const rendered = await runCli(["profile", "read", "flows.md", "--profile", "my-simple"], cliOpts);
    assert.equal(rendered.code, 0, rendered.stderr);
    assert.match(rendered.stdout, /flowchart TD/);
    assert.match(rendered.stdout, /C -->\|yes\| D\[Report done\]/);
  });

  it("refuses a proposed profile name that could escape the profile directory, through the existing CLI", async () => {
    const created = await runCli(["profile", "create", "../evil"], cliOpts);
    assert.equal(created.code, 1);
    assert.match(created.stdout, /not a valid profile name/);
  });

  it("refuses clobbering an existing profile name on creation", async () => {
    const created = await runCli(["profile", "create", "my-simple"], cliOpts);
    assert.equal(created.code, 1);
    assert.match(created.stdout, /already have a profile named "my-simple"/);
  });
});
