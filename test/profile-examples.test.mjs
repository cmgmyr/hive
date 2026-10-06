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
  const out = [];
  let open = null;
  for (const line of body.split("\n")) {
    if (open === null) {
      const m = line.match(/^```(.*)$/);
      if (m) open = { info: m[1].trim().split(/\s+/).filter(Boolean), lines: [] };
    } else if (line === "```") {
      out.push({ lang: open.info[0] ?? "", label: open.info.slice(1), text: open.lines.join("\n") + "\n" });
      open = null;
    } else open.lines.push(line);
  }
  assert.equal(open, null, "two-projects.md has an unclosed fence");
  return out;
}

const ymls = fences().filter((f) => f.lang === "yaml" && f.label[0] === "hive.yml");
const excerpts = fences().filter((f) => f.lang === "text" && f.label[0] === "rendered");

function hasConsecutiveLines(output, excerptText) {
  const haystack = output.split("\n");
  const needle = excerptText.replace(/\n$/, "").split("\n");
  for (let i = 0; i + needle.length <= haystack.length; i++) {
    if (needle.every((line, j) => haystack[i + j] === line)) return true;
  }
  return false;
}
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

  it("holds exactly 9 rendered excerpts and 2 hive.yml blocks, so none can vanish unnoticed", () => {
    assert.equal(excerpts.length, 9);
    assert.equal(ymls.length, 2);
  });

  it("no fence labelled rendered or hive.yml carries the wrong language", () => {
    for (const f of fences()) {
      if (f.label[0] === "hive.yml") assert.equal(f.lang, "yaml", f.label.join(" "));
      if (f.label[0] === "rendered") assert.equal(f.lang, "text", f.label.join(" "));
    }
  });

  it("every rendered excerpt names a known project and file and is not empty", () => {
    for (const ex of excerpts) {
      const [, project, file] = ex.label;
      assert.ok(ymls.some((y) => y.label[1] === project), `unknown project in: ${ex.label.join(" ")}`);
      assert.ok(file in COMMANDS, `unknown file in: ${ex.label.join(" ")}`);
      assert.ok(ex.text.trim().length > 0, `empty excerpt: ${ex.label.join(" ")}`);
    }
  });

  it("each rendered excerpt is a run of whole, consecutive lines of the render it names", () => {
    for (const ex of excerpts) {
      const [, project, file] = ex.label;
      const out = rendered[project]?.[file];
      assert.ok(out, `no render for ${project} ${file}`);
      assert.ok(hasConsecutiveLines(out, ex.text), `not a verbatim slice of ${project} ${file}:\n${ex.text}`);
    }
  });

  it("the two projects differ: a work-only line is absent from the personal render", () => {
    assert.match(rendered.work.runbook, /PAY-NNN/);
    assert.doesNotMatch(rendered.personal.runbook, /PAY-NNN/);
  });

  it("the personal render has no full suite, no gate command and no gate line in the worker list", () => {
    assert.doesNotMatch(rendered.personal.runbook, /Full suite|Gate command/);
    assert.doesNotMatch(rendered.personal.worker, /Also run this project's gates/);
    assert.deepEqual(
      [...rendered.personal.worker.slice(rendered.personal.worker.indexOf("BEFORE YOU REPORT DONE")).matchAll(/^(\d)\. /gm)].map((m) => Number(m[1])).slice(0, 4),
      [1, 2, 3, 4],
    );
  });
});

describe("skeleton.md names only things the shipped orchestration files contain", () => {
  const skeleton = readFileSync(join(REPO, "claude-plugin", "skills", "profile", "references", "examples", "skeleton.md"), "utf8");
  const shipped = ["posture.md", "runbook.md", "worker.md"]
    .map((f) => readFileSync(join(REPO, "profiles", "orchestration", f), "utf8"))
    .join("\n");
  const unique = (xs) => [...new Set(xs)];
  const templates = [...skeleton.matchAll(/^```markdown\n([\s\S]*?)^```$/gm)].map((m) => m[1]).join("\n");
  assert.ok(templates.length > 0, "skeleton.md has no markdown template blocks");

  it("every {{var}} it names appears in a shipped file", () => {
    const names = unique([...templates.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]));
    assert.ok(names.length >= 10, `expected the skeleton to name many vars, got ${names.length}`);
    for (const n of names) assert.ok(shipped.includes(`{{${n}}}`), `{{${n}}} is not in the shipped files`);
  });

  it("every <!--if:var--> gate it names appears in a shipped file", () => {
    const gates = unique([...templates.matchAll(/<!--if:(\w+)-->/g)].map((m) => m[1]));
    assert.ok(gates.length >= 6, `expected several gates, got ${gates.length}`);
    for (const g of gates) assert.ok(shipped.includes(`<!--if:${g}-->`), `<!--if:${g}--> is not in the shipped files`);
  });

  it("every section heading it names starts a line in a shipped file", () => {
    const headings = [];
    for (const line of templates.split("\n")) {
      if (/^[A-Z][A-Z ,'-]+(?: \| [A-Z][A-Z ,'-]+)*(?: \(inside it\))?$/.test(line)) {
        headings.push(...line.replace(/ \(inside it\)$/, "").split(" | "));
      }
    }
    assert.ok(headings.length >= 20, `expected many headings, got ${headings.length}`);
    for (const h of unique(headings)) assert.ok(shipped.split("\n").some((l) => l === h || l.startsWith(`${h} (`)), `heading "${h}" is not a line in the shipped files`);
  });
});
