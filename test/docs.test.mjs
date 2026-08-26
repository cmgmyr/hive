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

  it("keeps .claude/skills a symlink to .agents/skills, not a copy", () => {

    const full = join(REPO, ".claude/skills");
    assert.ok(existsSync(full), ".claude/skills is missing; codex and Claude Code would both lose the repo's skills");
    assert.equal(
      readlinkSync(full),
      "../.agents/skills",
      ".claude/skills should be a symlink to ../.agents/skills, not a copy",
    );
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

    const referencePath = ".claude/skills/hive-internals/references/test-CLAUDE.md";
    assert.ok(existsSync(join(REPO, referencePath)), `test/CLAUDE.md has no reference half at ${referencePath}`);
    assert.match(claudeMd, /test-CLAUDE\.md/, "CLAUDE.md does not name test/CLAUDE.md's reference half");

    const referenceMd = readRepo(referencePath);
    const referenceCited = new Set([...referenceMd.matchAll(/`((?:src|test)\/[\w./-]+)`/g)].map((m) => m[1]));
    for (const path of referenceCited) {
      assert.ok(existsSync(join(REPO, path)), `${referencePath} cites ${path}, which does not exist`);
    }
  });
});

describe("docs enumerate every statusline hold label the CLI can print", () => {
  const cli = readFileSync(CLI, "utf8");

  const DECLARED = (() => {
    const decl = /HELD_REASON_LABELS = \[([\s\S]*?)\]/.exec(cli);
    assert.ok(decl, "HELD_REASON_LABELS not found in dist/cli.js");
    return [...decl[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  })();

  const RETURNED = (() => {
    const fn = /function heldReasonLabel\([\s\S]*?\n\}/.exec(cli);
    assert.ok(fn, "heldReasonLabel not found in dist/cli.js");
    return [...fn[0].matchAll(/return "([^"]+)"/g)].map((m) => m[1]);
  })();

  it("parsed a real label set, so a silent parse failure cannot pass this block", () => {
    assert.ok(DECLARED.length >= 2, `parsed ${DECLARED.length} declared labels; the regex has drifted`);
    assert.ok(RETURNED.length >= 2, `parsed ${RETURNED.length} returned labels; the regex has drifted`);
  });

  it("returns nothing the declared set does not carry, and declares nothing it cannot return", () => {
    for (const label of RETURNED) {
      assert.ok(DECLARED.includes(label), `heldReasonLabel returns "${label}", missing from HELD_REASON_LABELS`);
    }
    for (const label of DECLARED) {
      assert.ok(RETURNED.includes(label), `HELD_REASON_LABELS carries "${label}", which heldReasonLabel never returns`);
    }
  });

  for (const file of ["README.md", "docs/install.md"]) {
    it(`names every label in ${file}, which states them as a closed list`, () => {
      const doc = readRepo(file);
      for (const label of DECLARED) {
        assert.ok(
          doc.includes(`\`${label}\``),
          `${file} does not name the statusline label \`${label}\`; both docs enumerate this set with a count, ` +
            "so adding a label without adding it here leaves a sentence that is wrong rather than merely short",
        );
      }
    });
  }
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

describe("docs cite real code, not just real files", () => {

  const CITATION_RE = /`([a-zA-Z0-9_./-]+\.(?:ts|mjs))?:([0-9][0-9,-]*)`/g;
  const BACKTICK_RE = /`([^`]+)`/g;
  const BEFORE_WINDOW = 150;
  const AFTER_WINDOW = 100;

  const stripFences = (text) => text.replace(/```[\s\S]*?```/g, (m) => m.replace(/[^\n]/g, " "));

  function anchorLines(spec) {
    return spec.split(",").map((part) => Number(part.split("-")[0]));
  }

  const isCitationSpan = (s) => /^:?[0-9][0-9,-]*$/.test(s) || /\.(ts|mjs):/.test(s);

  function normalizeCandidate(candidate) {

    const bareCall = /^([A-Za-z_$][\w$]*)\(\)$/.exec(candidate);
    if (bareCall) return `${bareCall[1]}(`;
    const ellipsis = candidate.indexOf("...");
    return ellipsis === -1 ? candidate : candidate.slice(0, ellipsis);
  }

  function isStrong(candidate) {
    if (candidate.length >= 6) return true;
    if (/[_.()[\]/"-]/.test(candidate)) return true;
    if (/^[A-Z][A-Z0-9_]+$/.test(candidate)) return true;
    if (/[a-z][A-Z]/.test(candidate)) return true;
    return false;
  }

  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  function containsAnchor(content, candidate) {

    const bareCall = /^([A-Za-z_$][\w$]*)\($/.exec(candidate);
    if (bareCall) return new RegExp(`(?<![\\w$])${escapeRe(bareCall[1])}\\(`).test(content);
    if (/^[A-Za-z_$][\w$]*$/.test(candidate)) return new RegExp(`(?<![\\w$])${escapeRe(candidate)}(?![\\w$])`).test(content);
    return content.includes(candidate);
  }

  function allSpans(text) {
    return [...text.matchAll(BACKTICK_RE)]
      .map((m) => ({ value: m[1], start: m.index, end: m.index + m[0].length }))
      .filter((s) => !isCitationSpan(s.value));
  }

  function candidatesNear(spans, matchIndex, matchLen) {
    const before = spans
      .filter((s) => s.end <= matchIndex && matchIndex - s.end <= BEFORE_WINDOW)
      .slice(-2)
      .reverse();
    const after = spans
      .filter((s) => s.start >= matchIndex + matchLen && s.start - (matchIndex + matchLen) <= AFTER_WINDOW)
      .slice(0, 2);

    return [...new Set([...before, ...after].map((s) => s.value).map(normalizeCandidate))].filter(isStrong);
  }

  function extractCitations(rawText) {
    const text = stripFences(rawText);
    const spans = allSpans(text);
    const citations = [];
    let currentFile = null;
    let m;
    CITATION_RE.lastIndex = 0;
    while ((m = CITATION_RE.exec(text))) {
      if (m[1]) currentFile = m[1];
      citations.push({
        file: currentFile,
        spec: m[2],
        candidates: candidatesNear(spans, m.index, m[0].length),
      });
    }
    return citations;
  }

  function checkCitations(text) {
    return extractCitations(text)
      .map((c) => {
        if (!c.file) return { ...c, detail: "no file in scope for a bare :NNN citation" };
        if (c.candidates.length === 0) return { ...c, detail: "no strong candidate symbol found near citation" };
        if (!existsSync(join(REPO, c.file))) return { ...c, detail: `${c.file} does not exist` };
        const srcLines = readRepo(c.file).split("\n");
        const anchors = anchorLines(c.spec);
        const content = anchors.map((n) => srcLines[n - 1] ?? "").join(" ");
        const hit = c.candidates.find((cand) => containsAnchor(content, cand));
        if (hit) return null;
        return {
          ...c,
          detail:
            `${c.file}:${c.spec} named ${JSON.stringify(c.candidates)} nearby, none of which appear on ` +
            `anchor line(s) ${anchors.join(",")} (the first line of each cited part - a range does not get ` +
            "credit for a symbol anywhere inside it)",
        };
      })
      .filter(Boolean);
  }

  it("finds a non-trivial number of file:line citations across docs/*.md", () => {
    const total = globSync("docs/*.md", { cwd: REPO })
      .map((doc) => extractCitations(readRepo(doc)).length)
      .reduce((a, b) => a + b, 0);
    assert.ok(total >= 20, `expected at least 20 file:line citations across docs/*.md, found ${total} - did the citation regex break?`);
  });

  it("keeps every docs/*.md citation's anchor line naming the symbol its prose cites it for", () => {
    const failures = globSync("docs/*.md", { cwd: REPO }).flatMap((doc) =>
      checkCitations(readRepo(doc)).map((f) => `${doc} -> ${f.detail}`),
    );
    assert.deepEqual(failures, []);
  });

  it("would have failed against architecture.md's diagram-3 paragraph before 2e4bc34's citation fix (todo 461)", () => {

    const preFixParagraph =
      "`agent_spawn` resolves the target project and refuses a `cwd` that belongs to a different, already-registered " +
      "one before it does anything else (`src/tools/agents.ts:451-467`). `launchAgent` (`src/spawn.ts:180-243`) then " +
      "does something specific on purpose: it `INSERT`s the `agents` row and mints `agentId` (`:189-205`) *before* a " +
      "pane exists. The row exists first because the worker's brief needs `agentId` and `actorId` to write itself " +
      "(`buildCommand`'s closure, `src/tools/agents.ts:492-508`, calling `writeAgentBrief`/`workerBrief`), and that " +
      "brief path has to be ready before the pane that will read it is created. The brief reaches the worker's " +
      "system prompt through `--append-system-prompt-file` (`src/brief.ts:116`), not through anything typed into " +
      "the pane. `placeAgentPane` creates the pane only after that (`src/spawn.ts:230`), and `recordPane` stores " +
      "its target and socket (`:233`). Back in the tool handler, `waitForPaneInput` polls for the worker's prompt " +
      "box before the receipt returns (`src/tools/agents.ts:535`; `src/tmux.ts:969-989`).";

    const failures = checkCitations(preFixParagraph);
    assert.ok(
      failures.length > 0,
      "precondition: this real pre-fix paragraph (commit aae3fd0) must disagree with today's rebased source",
    );
  });

  it("catches most single-line drift when every cited line shifts by one (measured, not assumed)", () => {

    const SENSITIVITY_FLOOR = 0.75;

    const shiftSpec = (spec) =>
      spec
        .split(",")
        .map((part) => part.split("-").map((n) => String(Number(n) + 1)).join("-"))
        .join(",");

    function checkShifted(text) {
      return extractCitations(text)
        .map((c) => {
          if (!c.file || c.candidates.length === 0 || !existsSync(join(REPO, c.file))) return null;
          const srcLines = readRepo(c.file).split("\n");
          const anchors = anchorLines(shiftSpec(c.spec));
          const content = anchors.map((n) => srcLines[n - 1] ?? "").join(" ");
          return c.candidates.some((cand) => containsAnchor(content, cand)) ? null : c;
        })
        .filter(Boolean);
    }

    const totalCitations = globSync("docs/*.md", { cwd: REPO })
      .map((doc) => extractCitations(readRepo(doc)).length)
      .reduce((a, b) => a + b, 0);
    const caught = globSync("docs/*.md", { cwd: REPO })
      .map((doc) => checkShifted(readRepo(doc)).length)
      .reduce((a, b) => a + b, 0);

    const rate = caught / totalCitations;
    assert.ok(
      rate >= SENSITIVITY_FLOOR,
      `shift-by-one sensitivity dropped to ${caught}/${totalCitations} (${Math.round(rate * 1000) / 10}%), ` +
        `below the ${SENSITIVITY_FLOOR * 100}% floor CLAUDE.md's guard sentence promises - tighten the checker or ` +
        "the citations, not the floor",
    );
  });
});
