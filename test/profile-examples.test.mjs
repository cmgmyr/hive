import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { isolateTmux, runCli, scratchDirs } from "./helpers.mjs";

const { cleanup: cleanupTmux } = isolateTmux("the profile example tests");
after(() => cleanupTmux());

const REPO = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const examplePath = join(REPO, "claude-plugin", "skills", "profile", "references", "examples", "two-projects.md");
const body = readFileSync(examplePath, "utf8");

function fences() {
  return [...body.matchAll(/^```(\S+) ([^\n]+)\n([\s\S]*?)^```$/gm)].map((m) => ({
    lang: m[1],
    label: m[2].trim().split(/\s+/),
    text: m[3],
  }));
}

const ymls = fences().filter((f) => f.lang === "yaml" && f.label[0] === "hive.yml");
const excerpts = fences().filter((f) => f.lang === "text" && f.label[0] === "rendered");
const COMMANDS = { posture: ["posture"], runbook: ["runbook"], worker: ["profile", "read", "worker.md"] };

describe("two-projects.md rendered excerpts are verbatim slices of the shipped orchestration profile", () => {
  const dirs = scratchDirs();
  const rendered = {};

  before(async () => {
    assert.ok(ymls.length >= 2, "two-projects.md must carry at least two hive.yml blocks");
    for (const yml of ymls) {
      const name = yml.label[1];
      const projectDir = join(dirs.projectDir, name);
      mkdirSync(projectDir, { recursive: true });
      const opts = { cwd: projectDir, dataDir: dirs.dataDir, tmp: dirs.tmp };
      const init = await runCli(["init", "--no-profile"], opts);
      assert.equal(init.code, 0, init.stderr);
      writeFileSync(join(projectDir, "hive.yml"), yml.text);
      rendered[name] = {};
      for (const [file, args] of Object.entries(COMMANDS)) {
        const out = await runCli(args, opts);
        assert.equal(out.code, 0, `${name} ${file}: ${out.stderr}`);
        rendered[name][file] = out.stdout;
      }
    }
  });

  it("every hive.yml block selects the shipped orchestration profile", () => {
    for (const yml of ymls) assert.match(yml.text, /^profile: orchestration$/m, yml.label.join(" "));
  });

  it("every rendered excerpt names a project and file it was rendered from", () => {
    assert.ok(excerpts.length >= 6, `expected at least 6 rendered excerpts, got ${excerpts.length}`);
    for (const ex of excerpts) {
      const [, project, file] = ex.label;
      assert.ok(project && file, `bad label: ${ex.label.join(" ")}`);
    }
  });

  it("each rendered excerpt appears verbatim in the render it names", () => {
    for (const ex of excerpts) {
      const [, project, file] = ex.label;
      const out = rendered[project]?.[file];
      assert.ok(out, `no render for ${project} ${file}`);
      const slice = ex.text.replace(/\n$/, "");
      assert.ok(out.includes(slice), `not a verbatim slice of ${project} ${file}:\n${slice}`);
    }
  });

  it("the two projects differ: a work-only line is absent from the personal render", () => {
    assert.match(rendered.work.runbook, /PAY-NNN/);
    assert.doesNotMatch(rendered.personal.runbook, /PAY-NNN/);
  });
});
