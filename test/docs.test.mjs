import assert from "node:assert/strict";
import { existsSync, globSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { CLI, isolateTmux, runCli, scratchDirs } from "./helpers.mjs";

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

  it("tells a reader to re-pin the interpreter after an update", () => {
    const readme = readRepo("README.md");
    // The Updating section used to promise no reinstall and no
    // re-registration "on any machine". True until npm install rebuilds the
    // addon under a different Node than the one the dispatcher names.
    assert.match(readme, /## Updating[\s\S]*?hive setup\s+# re-pin/);
    assert.doesNotMatch(readme, /no re-registration, on any machine/);
    assert.match(readme, /export PATH="\$HOME\/\.local\/bin:\$PATH"/);
  });

  it("records why a passing require proves nothing", () => {
    // Moved out of CLAUDE.md into a path-scoped rule, so it now has to be
    // asserted where it actually lives. The claim is the mechanism ("does NOT
    // load it"), not the consequence: a reader who only learns that require is
    // insufficient still does not know what to run instead.
    const rule = readRepo(".claude/rules/native-addon.md");
    assert.match(rule, /ABI-locked to the interpreter that built it/);
    assert.match(rule, /does NOT load it: the binding loads lazily inside `new Database\(\)`/);
    assert.match(rule, /hive setup/);
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
