import assert from "node:assert/strict";
import { existsSync, globSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { CLI, isolateTmux, registeredToolNames, runCli, scratchDirs, toolRegistrationsByFile } from "./helpers.mjs";

// runCli spawns hive, whose commands probe tmux; isolate first (see helpers.mjs).
const { cleanup: cleanupTmux } = isolateTmux("the docs tests");
after(() => cleanupTmux());

// A command nobody can find is not shipped. The list of commands lives in one
// place in the source, so both checks read it from there rather than keeping a
// copy that drifts the first time someone adds a command.
const dirs = scratchDirs();
const REPO = new URL("..", import.meta.url).pathname;
const readRepo = (file) => readFileSync(join(REPO, file), "utf8");

const COMMANDS = (() => {
  const table = /const COMMANDS = \[([\s\S]*?)\];/.exec(readFileSync(CLI, "utf8"));
  assert.ok(table, "COMMANDS table not found in dist/cli.js");
  return [...table[1].matchAll(/"([a-z]+)"/g)].map((m) => m[1]);
})();

// Same argument as COMMANDS, one surface over: the tmux settings hive tells a
// raw-attach user to set are the ones docs/tmux.md has to explain. IMPORTED,
// not transcribed and not scraped, so a fourth setting added to the CLI and
// not to the doc fails rather than shipping unexplained.
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
    // Guard the loop before trusting it: a for-loop over an empty array passes
    // while proving nothing, which is the first of the false-green shapes
    // test/CLAUDE.md names.
    assert.ok(
      RAW_ATTACH_TMUX_CONFIG.length >= 1,
      `expected a raw-attach block, got ${RAW_ATTACH_TMUX_CONFIG.length} lines`,
    );
    const doc = readRepo(TMUX_DOC);
    // The WHOLE line, not the option name. Pinning the name alone would let
    // the doc recommend pane-border-status bottom while the CLI prints top,
    // and pass.
    for (const line of RAW_ATTACH_TMUX_CONFIG) {
      assert.ok(doc.includes(line), `${TMUX_DOC} omits "${line}", which the CLI recommends`);
    }
  });

  it("keeps the README's raw attach advice scoped to hive-owned windows", () => {
    const readme = readRepo("README.md");
    assert.match(readme, /hive configures the tmux windows it creates/);
    assert.match(readme, /allow-passthrough all.*global notification recommendation/);
    assert.doesNotMatch(readme, /pane-border-status top.*~\/\.tmux\.conf/);
  });

  it("ships the tmux doc the CLI points at", () => {
    assert.ok(existsSync(join(REPO, TMUX_DOC)), `the CLI points at ${TMUX_DOC}, which does not exist`);
  });

  // Todo 275 (topology-3c). Sessions are one per STORE now, not one per
  // project (`hive-main`, not `hive-<project_id>`); a doc still teaching the
  // old naming sends a reader to attach at a session that does not exist.
  // `\d+\b` alone would also flag the current, correct `hive-main` or a
  // scratch store's hash-tagged `hive-<tag>-main` (the tag mixes letters and
  // digits, and `\b` never falls inside one \w run), so this only matches
  // what the old naming actually looked like: a project id, digits alone
  // right after the prefix, or the literal `<project_id>` placeholder.
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
    // The Updating section used to promise no reinstall and no
    // re-registration "on any machine". True until npm install rebuilds the
    // addon under a different Node than the one the dispatcher names.
    //
    // The recipe invokes setup as `node dist/cli.js setup`, not bare `hive
    // setup`: typing `hive setup` runs through the dispatcher, which execs
    // the OLD pinned interpreter, and that interpreter may no longer be able
    // to load the addon this same recipe just rebuilt -- src/cli.ts imports
    // db.js at module scope, so guardAbi() would exit before cmdSetup ever
    // ran. Verified by hand: reproduced that exact failure, then confirmed
    // `node dist/cli.js setup` bypasses it and re-pins correctly.
    assert.match(readme, /## Updating[\s\S]*?node dist\/cli\.js setup\s+# not `hive setup`/);
    assert.doesNotMatch(readme, /no re-registration, on any machine/);
    assert.match(readme, /export PATH="\$HOME\/\.local\/bin:\$PATH"/);
  });

  it("records why a passing require proves nothing", () => {
    // Moved out of CLAUDE.md into a path-scoped rule, so it now has to be
    // asserted where it actually lives. The claim is the mechanism ("does NOT
    // load the addon"), not the consequence: a reader who only learns that
    // require is insufficient still does not know what to run instead.
    //
    // Issue #105 lane B. better-sqlite3 13 moved to N-API, which is
    // deliberately ABI-stable across Node majors, so the addon no longer
    // cares which interpreter built it - the rule's opening claim changed
    // with it (see the rule itself for the measurement). The lazy-binding
    // trap this test exists for is unchanged, so that half is still pinned.
    const rule = readRepo(".claude/rules/native-addon.md");
    assert.match(rule, /deliberately ABI-stable across Node majors/);
    assert.match(rule, /does NOT load the addon/);
    assert.match(rule, /binding loads lazily inside `new Database\(\)`/);
    assert.match(rule, /hive setup/);

    // Issue #105 lane B1. "ABI-stable across Node majors" is true and, left
    // unscoped, is what the rule used to say - it called the mismatch
    // unreachable "on any platform" while Node 22.5.0 to 22.13.x segfaulted.
    // The scope is the claim now, so it is pinned like one.
    assert.match(rule, /Node-API 10, which begins at Node 22\.14\.0/);
    assert.match(rule, /unreachable on any Node that clears that floor/);
    // The other overclaim, which contradicted the issue #51 bullet in the same
    // list: npm never invokes node-gyp for this package, so nothing falls back
    // to a source build on its own.
    assert.doesNotMatch(rule, /which still builds from source/);
    assert.match(rule, /npm will not build one/i);
  });

  it("names the guards that make test isolation structural, and they exist", () => {
    // CLAUDE.md used to assert "real data stays untouched" as a property when
    // it was a convention, and it was false on the day it mattered. The
    // invariant names what enforces it instead, which is only worth more than
    // the old sentence for as long as the things it names are real.
    const rule = readRepo(".claude/rules/store-and-datadir.md");
    assert.match(rule, /Test isolation is enforced, not conventional/);
    assert.match(rule, /The data dir is read at call time/);
    // The exact old claim, not the phrase: the rule quotes it to say what it
    // replaced, and a check that cannot tell a quotation from a claim is the
    // kind that gets deleted rather than satisfied.
    assert.doesNotMatch(rule, /scratch directories; real data stays untouched/);

    const cited = new Set([...rule.matchAll(/`((?:src|test)\/[\w.-]+\.(?:ts|mjs))`/g)].map((m) => m[1]));
    // The guards themselves, by name. Losing any of these means the rule
    // stopped saying where the enforcement lives.
    for (const file of ["src/db.ts", "test/suite-isolation.test.mjs", "test/store-isolation.test.mjs"]) {
      assert.ok(cited.has(file), `the rule should name ${file}, cites: ${[...cited].join(", ")}`);
    }
    for (const path of cited) {
      assert.ok(existsSync(join(REPO, path)), `the rule cites ${path}, which does not exist`);
    }
  });

  it("keeps every path-scoped rule alive, indexed, and citing real files", () => {
    // The root CLAUDE.md was cut from ~22k to ~6k by moving invariants into
    // .claude/rules/, which only helps while the rules still fire and a reader
    // can still find them. Three ways that silently stops being true, all
    // checked here.
    const ruleFiles = globSync("*.md", { cwd: join(REPO, ".claude/rules") }).sort();
    assert.ok(ruleFiles.length > 0, "no rules found; did .claude/rules move?");
    const claudeMd = readRepo("CLAUDE.md");

    for (const name of ruleFiles) {
      const body = readRepo(join(".claude/rules", name));

      // 1. A rule with no paths frontmatter never fires at all.
      const frontmatter = /^---\n([\s\S]*?)\n---/.exec(body);
      assert.ok(frontmatter, `${name} has no frontmatter, so it never fires`);
      const globs = [...frontmatter[1].matchAll(/^\s*-\s*"([^"]+)"/gm)].map((m) => m[1]);
      assert.ok(globs.length > 0, `${name} declares no paths, so it never fires`);

      // 2. A glob matching nothing is a dead rule, and nothing else would ever
      // report it. This is the shape a renamed source file creates: the rule
      // keeps existing, stops firing, and the invariant quietly leaves the
      // project. Same family as the dead alternation branch in test/CLAUDE.md.
      for (const pattern of globs) {
        const hits = globSync(pattern, { cwd: REPO });
        assert.ok(hits.length > 0, `${name} declares path "${pattern}", which matches no file`);
      }

      // 3. Every repo path the prose cites must exist, same as for CLAUDE.md.
      const cited = new Set([...body.matchAll(/`((?:src|test)\/[\w./-]+\.(?:ts|mjs))`/g)].map((m) => m[1]));
      for (const path of cited) {
        assert.ok(existsSync(join(REPO, path)), `${name} cites ${path}, which does not exist`);
      }

      // 4. A rule the root does not index is invisible while planning, which
      // is exactly when you need to know it exists: rules fire on file access,
      // and planning happens before that.
      assert.match(claudeMd, new RegExp(`\\.claude/rules/${name.replace(".", "\\.")}`), `CLAUDE.md does not index ${name}`);
    }
  });

  it("keeps AGENTS.md pointing at the same instructions Claude reads", () => {
    // Codex is a counselors review seat and reads AGENTS.md, not CLAUDE.md.
    // Verified empirically: it loads both the root and the nested one without
    // being asked to. Symlinks rather than copies, because two files with the
    // same job drift, and the drift is silent until a reviewer argues from a
    // stale invariant.
    for (const [link, target] of [["AGENTS.md", "CLAUDE.md"], ["test/AGENTS.md", "CLAUDE.md"]]) {
      const full = join(REPO, link);
      assert.ok(existsSync(full), `${link} is missing; codex would lose the project instructions`);
      assert.equal(readlinkSync(full), target, `${link} should be a symlink to ${target}, not a copy`);
    }
    // Codex has no equivalent of .claude/rules' paths globs, so the rules are
    // invisible to it. src/AGENTS.md is what closes that gap; without it a
    // codex seat reviews src/ with none of the invariants that constrain it.
    const srcAgents = readRepo("src/AGENTS.md");
    for (const name of globSync("*.md", { cwd: join(REPO, ".claude/rules") })) {
      assert.match(srcAgents, new RegExp(name.replace(".", "\\.")), `src/AGENTS.md does not name ${name}`);
    }
  });

  it("keeps the suite's own rules reachable from the root CLAUDE.md, and their citations real", () => {
    // The root CLAUDE.md was cut from ~22k to ~11k by moving the suite's rules
    // into test/CLAUDE.md, which only helps for as long as a reader can still
    // find them. A pointer nobody checks is how the old "real data stays
    // untouched" claim rotted: the file kept saying it long after it stopped
    // being true. So pin the hop, not just the destination.
    const claudeMd = readRepo("CLAUDE.md");
    assert.match(claudeMd, /`test\/CLAUDE\.md`/, "root CLAUDE.md must point at the suite's rules");

    const testMd = readRepo("test/CLAUDE.md");
    // The two guards named in the root invariant have to be the two this file
    // explains, or the pointer sends a reader somewhere that argues for
    // something else.
    assert.match(testMd, /storeDir\(\)/);
    assert.match(testMd, /suite-isolation\.test\.mjs/);
    // The rules that exist because breaking them damaged the machine, rather
    // than merely failing a test. Losing any of these silently is the whole
    // risk of having moved them out of the always-loaded file.
    assert.match(testMd, /isolateTmux\(\)/);
    assert.match(testMd, /list-panes -a/);
    assert.match(testMd, /assertScratchStore\(\)/);

    // Same citation rule as above: every repo path this file names must exist,
    // since a renamed test file is exactly what leaves a doc naming a guard
    // nobody can find.
    const cited = new Set([...testMd.matchAll(/`((?:src|test)\/[\w./-]+)`/g)].map((m) => m[1]));
    for (const path of cited) {
      assert.ok(existsSync(join(REPO, path)), `test/CLAUDE.md cites ${path}, which does not exist`);
    }
  });
});

// Issue #83. The CLI half above has been pinned for a while; this is the same
// idiom applied to the MCP half, which never had it: 42 tools registered
// across src/tools/*.ts, a README table describing them, and src/help.ts
// naming them in prose, with nothing connecting the three before this.
//
// toolRegistrationsByFile() and registeredToolNames() (test/helpers.mjs) do
// the parsing, shared with test/tool-registration.test.mjs, so this file and
// that one read one list rather than keeping two copies of the same regex
// that could silently agree on the same wrong answer. See that function's own
// comment for why a second copy of the pattern is the exact risk this lane
// exists to remove.
//
// THE HONEST LIMIT, stated here because this is where a reader lands after
// trusting a green run: every assertion below is ONE-DIRECTIONAL. It catches
// "the registration names something the docs never mention" (or the reverse,
// where the two-way checks below say so explicitly). It cannot catch a doc
// paragraph that is simply WRONG about what a tool does or how a variable
// behaves - that is a prose-accuracy question, and no regex answers it. A
// green suite here means the surface is not silently omitted, not that the
// words next to it are correct.
describe("docs keep up with the MCP surface", () => {
  const TOOL_REGISTRATIONS = toolRegistrationsByFile();
  const REGISTERED_TOOLS = registeredToolNames();

  // The Tools section only, between its own heading and the next one.
  // Scoping this way keeps a backtick-quoted word in an unrelated table (the
  // attach-mode options table above it uses the identical "| `auto` | ... |"
  // row shape) from being misread as a tool name.
  const toolsSection = (readme) => {
    const match = /^## Tools.*\n([\s\S]*?)\n^## /m.exec(readme);
    assert.ok(match, "README has no ## Tools section (or no ## heading after it)");
    return match[1];
  };
  // A tool row is "| `tool_name` | ...". The group header rows ("|
  // **pads** | | |") carry no backtick name and never match this pattern.
  const readmeToolNames = (section) => [...section.matchAll(/^\| `([a-z_]+)` \|/gm)].map((m) => m[1]);

  it("parsed at least one registered tool, with the parse verified complete", () => {
    // Guard the extraction before trusting it, matching the loop-over-empty-
    // array shape test/CLAUDE.md names as the first false-green.
    assert.ok(REGISTERED_TOOLS.length > 0, "no registered tools found; did src/tools/ move?");
    // The same blind spot tool-registration.test.mjs guards against: a tool
    // name this regex cannot see (a digit or hyphen in the literal) makes
    // registerTool( occurrences outnumber parsed names. Checked independently
    // here so this file's own pin does not depend on that file having run.
    for (const { file, src, names } of TOOL_REGISTRATIONS) {
      const occurrences = [...src.matchAll(/registerTool\(/g)].length;
      assert.equal(occurrences, names.length, `${file}: registerTool( occurrences do not match parsed tool names`);
    }
  });

  it("documents every registered tool in the README table, and names nothing extra", () => {
    // Two-way, or the check rots: a one-way "every tool is documented" still
    // passes after a tool is deleted and its row left behind, same as the
    // CLI shape above.
    const documented = readmeToolNames(toolsSection(readRepo("README.md")));
    for (const name of REGISTERED_TOOLS) {
      assert.ok(documented.includes(name), `${name} is registered but has no row in README's Tools table`);
    }
    for (const name of documented) {
      assert.ok(REGISTERED_TOOLS.includes(name), `README's Tools table names "${name}", which is not a registered tool`);
    }
  });

  it("pins the Tools heading count to the parsed registration count, not a literal", () => {
    const readme = readRepo("README.md");
    const heading = /^## Tools \((\d+)\)/m.exec(readme);
    assert.ok(heading, "README has no `## Tools (N)` heading");
    assert.equal(
      Number(heading[1]),
      REGISTERED_TOOLS.length,
      `README says ${heading[1]} tools, src/tools/*.ts registers ${REGISTERED_TOOLS.length}`,
    );
  });

  // Issue #83 item 3. Every HIVE_* variable actually read from process.env
  // under src/ has to appear in README or src/help.ts, or be on the
  // exemption list below with a reason. The exemption list is the feature:
  // it turns an undocumented variable into a line someone deliberately
  // wrote, rather than a gap nobody saw.
  const HIVE_ENV_VARS = (() => {
    const names = new Set();
    for (const file of globSync("src/**/*.ts", { cwd: REPO })) {
      const src = readRepo(file);
      for (const m of src.matchAll(/process\.env\.(HIVE_[A-Z0-9_]+)/g)) names.add(m[1]);
      for (const m of src.matchAll(/process\.env\[\s*["'](HIVE_[A-Z0-9_]+)["']\s*\]/g)) names.add(m[1]);
      // src/backup.ts's envInt(name, fallback) reads process.env[name] where
      // name arrives as a string literal one call away; a bare
      // process.env.HIVE_X scan never sees through that indirection, so it
      // is matched here by the call site instead.
      for (const m of src.matchAll(/envInt\(\s*["'](HIVE_[A-Z0-9_]+)["']/g)) names.add(m[1]);
    }
    return [...names].sort();
  })();

  // HIVE_PROJECT_ID is deliberately undocumented (issue #63): src/context.ts
  // and src/spawn.ts mention it only inside comments explaining why a
  // worker's project pin does NOT come from it. It is never actually read
  // from process.env, so HIVE_ENV_VARS above never contains it today - the
  // negative assertion below checks that directly, so the day someone wires
  // it up for real the exemption stops applying instead of grandfathering
  // the omission in silently.
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
    // Issue #83 item 4. The table names 13 of the 30 files under src/*.ts,
    // and always has, including files (src/spawn.ts, src/strictInput.ts)
    // other rules treat as load-bearing - an exhaustive table would need
    // every file added since, which this project does not do at this
    // granularity anywhere else. Curated is the decision; this line is what
    // stops an absent file from reading as an oversight.
    assert.match(readRepo("CLAUDE.md"), /Curated, not exhaustive/);
  });
});
