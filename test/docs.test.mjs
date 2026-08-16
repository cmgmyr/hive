import assert from "node:assert/strict";
import { existsSync, globSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { parseRulePaths } from "../scripts/covering-rules.mjs";
import { CLI, isolateTmux, registeredToolNames, runCli, scratchDirs, toolRegistrationsByFile } from "./helpers.mjs";

const { cleanup: cleanupTmux } = isolateTmux("the docs tests");
after(() => cleanupTmux());

const dirs = scratchDirs();
const REPO = new URL("..", import.meta.url).pathname;
const readRepo = (file) => readFileSync(join(REPO, file), "utf8");

const readRuleAndReference = (name) =>
  readRepo(`.claude/rules/${name}`) + "\n" + readRepo(`.claude/skills/hive-internals/references/${name}`);

const backtickPaths = (cell) => [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1]).sort();

const RULE_ROW_RE = /^\| `(\.claude\/rules\/[\w.-]+\.md)` \| ([^|]+) \|/gm;

const COMMANDS = (() => {
  const table = /const COMMANDS = \[([\s\S]*?)\];/.exec(readFileSync(CLI, "utf8"));
  assert.ok(table, "COMMANDS table not found in dist/cli.js");
  return [...table[1].matchAll(/"([a-z]+)"/g)].map((m) => m[1]);
})();

const { RAW_ATTACH_TMUX_CONFIG, TMUX_DOC } = await import("../dist/tmux.js");

describe("docs keep up with the CLI", () => {
  it("lists every command in hive --help", async () => {
    const { stdout } = await runCli(["--help"], { cwd: dirs.projectDir, dataDir: dirs.dataDir });
    for (const command of COMMANDS) {
      assert.match(stdout, new RegExp(`hive ${command}\\b`), `hive --help omits "${command}"`);
    }
  });

  it("documents every command in the README", () => {
    const readme = readRepo("README.md");
    for (const command of COMMANDS) {
      assert.match(readme, new RegExp(`hive ${command}\\b`), `README omits "${command}"`);
    }
  });

  it("explains every tmux setting the CLI recommends, at the value it recommends", () => {

    assert.ok(
      RAW_ATTACH_TMUX_CONFIG.length >= 1,
      `expected a raw-attach block, got ${RAW_ATTACH_TMUX_CONFIG.length} lines`,
    );
    const doc = readRepo(TMUX_DOC);

    for (const line of RAW_ATTACH_TMUX_CONFIG) {
      assert.ok(doc.includes(line), `${TMUX_DOC} omits "${line}", which the CLI recommends`);
    }
  });

  it("keeps docs/tmux.md's raw attach advice scoped to hive-owned windows", () => {

    const doc = readRepo(TMUX_DOC);
    assert.match(doc, /hive configures the tmux windows it creates/);
    assert.match(doc, /allow-passthrough all.*global notification recommendation/);

  });

  it("ships the tmux doc the CLI points at", () => {
    assert.ok(existsSync(join(REPO, TMUX_DOC)), `the CLI points at ${TMUX_DOC}, which does not exist`);
  });

  it("carries no hive-<project_id> session reference anywhere in docs/, README.md, or src/help.ts", () => {
    const STALE = /hive-(?:<project_id>|\d+)\b/;
    const candidates = [
      ...globSync("docs/*.md", { cwd: REPO }),
      "README.md",
      "src/help.ts",
    ];
    for (const path of candidates) {
      const text = readRepo(path);
      assert.doesNotMatch(text, STALE, `${path} still names a per-project session (hive-<project_id> shape)`);
    }
  });

  it("tells a reader to re-pin the interpreter after an update", () => {
    const readme = readRepo("README.md");

    assert.match(readme, /## Updating[\s\S]*?node dist\/cli\.js setup\s+# not `hive setup`/);
    assert.doesNotMatch(readme, /no re-registration, on any machine/);
    assert.match(readme, /export PATH="\$HOME\/\.local\/bin:\$PATH"/);
  });

  it("records why a passing require proves nothing", () => {

    const rule = readRuleAndReference("native-addon.md");
    assert.match(rule, /deliberately ABI-stable across Node majors/);
    assert.match(rule, /does NOT load the addon/);
    assert.match(rule, /binding loads lazily inside `new Database\(\)`/);
    assert.match(rule, /hive setup/);

    assert.match(rule, /Node-API 10, which begins at Node 22\.14\.0/);
    assert.match(rule, /unreachable on any Node that clears that floor/);

    assert.doesNotMatch(rule, /which still builds from source/);
    assert.match(rule, /npm will not build one/i);
  });

  it("names the guards that make test isolation structural, and they exist", () => {

    const rule = readRuleAndReference("store-and-datadir.md");
    assert.match(rule, /Test isolation is enforced, not conventional/);
    assert.match(rule, /The data dir is read at call time/);

    assert.doesNotMatch(rule, /scratch directories; real data stays untouched/);

    const cited = new Set([...rule.matchAll(/`((?:src|test)\/[\w.-]+\.(?:ts|mjs))`/g)].map((m) => m[1]));

    for (const file of ["src/db.ts", "test/suite-isolation.test.mjs", "test/store-isolation.test.mjs"]) {
      assert.ok(cited.has(file), `the rule should name ${file}, cites: ${[...cited].join(", ")}`);
    }
    for (const path of cited) {
      assert.ok(existsSync(join(REPO, path)), `the rule cites ${path}, which does not exist`);
    }
  });

  it("keeps every path-scoped rule alive, indexed, and citing real files", () => {

    const ruleFiles = globSync("*.md", { cwd: join(REPO, ".claude/rules") }).sort();
    assert.ok(ruleFiles.length > 0, "no rules found; did .claude/rules move?");
    const claudeMd = readRepo("CLAUDE.md");

    for (const name of ruleFiles) {
      const body = readRepo(join(".claude/rules", name));

      const frontmatter = /^---\n([\s\S]*?)\n---/.exec(body);
      assert.ok(frontmatter, `${name} has no frontmatter, so it never fires`);
      const globs = [...frontmatter[1].matchAll(/^\s*-\s*"([^"]+)"/gm)].map((m) => m[1]);
      assert.ok(globs.length > 0, `${name} declares no paths, so it never fires`);

      for (const pattern of globs) {
        const hits = globSync(pattern, { cwd: REPO });
        assert.ok(hits.length > 0, `${name} declares path "${pattern}", which matches no file`);
      }

      const referencePath = `.claude/skills/hive-internals/references/${name}`;
      assert.ok(existsSync(join(REPO, referencePath)), `${name} has no reference half at ${referencePath}`);
      const pair = body + "\n" + readRepo(referencePath);
      const cited = new Set([...pair.matchAll(/`((?:src|test)\/[\w./-]+\.(?:ts|mjs))`/g)].map((m) => m[1]));
      for (const path of cited) {
        assert.ok(existsSync(join(REPO, path)), `${name} or its reference cites ${path}, which does not exist`);
      }

      assert.match(claudeMd, new RegExp(`\\.claude/rules/${name.replace(".", "\\.")}`), `CLAUDE.md does not index ${name}`);
    }
  });

  it("keeps CLAUDE.md's rules table Fires-on column in sync with each rule's own frontmatter", () => {
    const claudeMd = readRepo("CLAUDE.md");
    const rows = [...claudeMd.matchAll(RULE_ROW_RE)];
    assert.ok(rows.length > 0, "no rule rows found in CLAUDE.md's table; did its format change?");

    const ruleFiles = globSync("*.md", { cwd: join(REPO, ".claude/rules") });
    for (const name of ruleFiles) {
      assert.ok(
        rows.some(([, rulePath]) => rulePath === `.claude/rules/${name}`),
        `CLAUDE.md's table has no row for .claude/rules/${name}`,
      );
    }

    for (const [, rulePath, firesOnCell] of rows) {
      const tableGlobs = backtickPaths(firesOnCell);
      const frontmatterGlobs = parseRulePaths(readRepo(rulePath)).sort();
      assert.deepEqual(
        tableGlobs,
        frontmatterGlobs,
        `${rulePath}: CLAUDE.md's Fires-on column says ${JSON.stringify(tableGlobs)}, frontmatter says ${JSON.stringify(frontmatterGlobs)}`,
      );
    }
  });

  it("would have failed against the real pre-fix row from PR #159 (commit 61b6f6d)", () => {
    const preFixRow =
      "| `.claude/rules/tmux-and-panes.md` | `src/tmux.ts`, `src/spawn.ts`, `src/scheduler.ts`, `src/tools/agents.ts` | " +
      "why a private tmux server plus the default store is refused |";
    const preFixFrontmatterGlobs = ["src/tmux.ts", "src/spawn.ts", "src/scheduler.ts", "src/tools/agents.ts", "src/cli.ts", "docs/*.md"];

    const [row] = [...preFixRow.matchAll(RULE_ROW_RE)];
    assert.ok(row, "precondition: the fixture row must match the production row regex");
    const [, rulePath, firesOnCell] = row;
    assert.equal(rulePath, ".claude/rules/tmux-and-panes.md");

    const tableGlobs = backtickPaths(firesOnCell);
    assert.notDeepEqual(tableGlobs, [...preFixFrontmatterGlobs].sort(), "precondition: the pre-fix row and frontmatter must disagree");
  });

  it("keeps AGENTS.md pointing at the same instructions Claude reads", () => {

    for (const [link, target] of [["AGENTS.md", "CLAUDE.md"], ["test/AGENTS.md", "CLAUDE.md"]]) {
      const full = join(REPO, link);
      assert.ok(existsSync(full), `${link} is missing; codex would lose the project instructions`);
      assert.equal(readlinkSync(full), target, `${link} should be a symlink to ${target}, not a copy`);
    }

    const srcAgents = readRepo("src/AGENTS.md");
    for (const name of globSync("*.md", { cwd: join(REPO, ".claude/rules") })) {
      assert.match(srcAgents, new RegExp(name.replace(".", "\\.")), `src/AGENTS.md does not name ${name}`);

      const refName = name.replace(/\.md$/, "");
      assert.match(
        srcAgents,
        new RegExp(`references/${refName}\\.md`),
        `src/AGENTS.md does not name the hive-internals reference for ${name}`,
      );
    }
  });

  it("keeps the suite's own rules reachable from the root CLAUDE.md, and their citations real", () => {

    const claudeMd = readRepo("CLAUDE.md");
    assert.match(claudeMd, /`test\/CLAUDE\.md`/, "root CLAUDE.md must point at the suite's rules");

    const testMd = readRepo("test/CLAUDE.md");

    assert.match(testMd, /storeDir\(\)/);
    assert.match(testMd, /suite-isolation\.test\.mjs/);

    assert.match(testMd, /isolateTmux\(\)/);
    assert.match(testMd, /list-panes -a/);
    assert.match(testMd, /assertScratchStore\(\)/);

    const cited = new Set([...testMd.matchAll(/`((?:src|test)\/[\w./-]+)`/g)].map((m) => m[1]));
    for (const path of cited) {
      assert.ok(existsSync(join(REPO, path)), `test/CLAUDE.md cites ${path}, which does not exist`);
    }
  });
});

describe("docs keep up with the MCP surface", () => {
  const TOOL_REGISTRATIONS = toolRegistrationsByFile();
  const REGISTERED_TOOLS = registeredToolNames();

  const toolsSection = (doc) => {
    const match = /^# Tools.*\n([\s\S]*)$/m.exec(doc);
    assert.ok(match, "docs/tools.md has no # Tools heading");
    return match[1];
  };

  const readmeToolNames = (section) => [...section.matchAll(/^\| `([a-z_]+)` \|/gm)].map((m) => m[1]);

  it("parsed at least one registered tool, with the parse verified complete", () => {

    assert.ok(REGISTERED_TOOLS.length > 0, "no registered tools found; did src/tools/ move?");

    for (const { file, src, names } of TOOL_REGISTRATIONS) {
      const occurrences = [...src.matchAll(/registerTool\(/g)].length;
      assert.equal(occurrences, names.length, `${file}: registerTool( occurrences do not match parsed tool names`);
    }
  });

  it("documents every registered tool in docs/tools.md, and names nothing extra", () => {

    const documented = readmeToolNames(toolsSection(readRepo("docs/tools.md")));
    for (const name of REGISTERED_TOOLS) {
      assert.ok(documented.includes(name), `${name} is registered but has no row in docs/tools.md's table`);
    }
    for (const name of documented) {
      assert.ok(REGISTERED_TOOLS.includes(name), `docs/tools.md names "${name}", which is not a registered tool`);
    }
  });

  it("pins the Tools heading count to the parsed registration count, not a literal", () => {
    const doc = readRepo("docs/tools.md");
    const heading = /^# Tools \((\d+)\)/m.exec(doc);
    assert.ok(heading, "docs/tools.md has no `# Tools (N)` heading");
    assert.equal(
      Number(heading[1]),
      REGISTERED_TOOLS.length,
      `docs/tools.md says ${heading[1]} tools, src/tools/*.ts registers ${REGISTERED_TOOLS.length}`,
    );
  });

  const HIVE_ENV_VARS = (() => {
    const names = new Set();
    for (const file of globSync("src/**/*.ts", { cwd: REPO })) {
      const src = readRepo(file);
      for (const m of src.matchAll(/process\.env\.(HIVE_[A-Z0-9_]+)/g)) names.add(m[1]);
      for (const m of src.matchAll(/process\.env\[\s*["'](HIVE_[A-Z0-9_]+)["']\s*\]/g)) names.add(m[1]);

      for (const m of src.matchAll(/envInt\(\s*["'](HIVE_[A-Z0-9_]+)["']/g)) names.add(m[1]);
    }
    return [...names].sort();
  })();

  const EXEMPT_HIVE_ENV_VARS = new Set(["HIVE_PROJECT_ID"]);

  it("documents every HIVE_* variable read from process.env, or exempts it explicitly", () => {
    assert.ok(HIVE_ENV_VARS.length > 0, "no HIVE_* env reads found under src/; did the sweep pattern break?");
    for (const name of EXEMPT_HIVE_ENV_VARS) {
      assert.ok(
        !HIVE_ENV_VARS.includes(name),
        `${name} is on the exemption list as deliberately undocumented, but IS now read from process.env - ` +
          "document it and drop the exemption",
      );
    }
    const docs = readRepo("README.md") + readRepo("src/help.ts");
    for (const name of HIVE_ENV_VARS) {
      if (EXEMPT_HIVE_ENV_VARS.has(name)) continue;
      assert.match(
        docs,
        new RegExp(name),
        `${name} is read from process.env under src/ but appears in neither README.md nor src/help.ts`,
      );
    }
  });

  it("states what CLAUDE.md's architecture table is: curated, not exhaustive", () => {

    assert.match(readRepo("CLAUDE.md"), /Curated, not exhaustive/);
  });
});
