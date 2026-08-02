import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { changedFiles, coveringRules, loadRules, parseRulePaths, report, REPO } from "../scripts/covering-rules.mjs";
import { scratchGit } from "./helpers.mjs";

describe("parseRulePaths", () => {
  it("extracts every glob in a paths: frontmatter list", () => {
    const rule = '---\npaths:\n  - "src/a.ts"\n  - "src/b.ts"\n---\n\n# A rule\n';
    assert.deepEqual(parseRulePaths(rule), ["src/a.ts", "src/b.ts"]);
  });

  it("returns nothing for a file with no frontmatter at all", () => {
    assert.deepEqual(parseRulePaths("# Just a heading\n"), []);
  });

  it("returns nothing for frontmatter that declares no paths, the dead-rule shape", () => {
    const rule = "---\ntags: [x]\n---\n\n# A rule with no paths key\n";
    assert.deepEqual(parseRulePaths(rule), []);
  });
});

describe("coveringRules", () => {
  it("matches a rule whose glob hits a changed file", () => {
    const rules = [{ name: "tmux.md", globs: ["src/tmux.ts"] }];
    const hits = coveringRules(["src/tmux.ts"], rules);
    assert.deepEqual(hits.map((r) => r.name), ["tmux.md"]);
  });

  it("does not match a rule whose glob covers none of the changed files", () => {
    const rules = [{ name: "tmux.md", globs: ["src/tmux.ts"] }];
    const hits = coveringRules(["src/hook.ts"], rules);
    assert.deepEqual(hits, []);
  });

  it("matches through a wildcard glob, not just a literal path", () => {
    const rules = [{ name: "tools.md", globs: ["src/tools/*.ts"] }];
    const hits = coveringRules(["src/tools/wakes.ts"], rules);
    assert.deepEqual(hits.map((r) => r.name), ["tools.md"]);
  });

  it("matches a rule covered by any one of several changed files, not just the first", () => {
    const rules = [{ name: "b.md", globs: ["src/b.ts"] }];
    const hits = coveringRules(["src/a.ts", "src/b.ts"], rules);
    assert.deepEqual(hits.map((r) => r.name), ["b.md"]);
  });

  // The defect PR #93's gate caught: an earlier version matched via
  // fs.globSync against the filesystem, so a changed path with no file
  // backing it on disk -- exactly what a delete or a rename leaves behind
  // in `git diff --name-only` -- silently matched nothing. The path here is
  // deliberately one that does not exist anywhere on this machine, not just
  // one absent from a fixture: a path that happens to be real in THIS repo
  // (src/tmux.ts, say) would pass against the old fs.globSync code too,
  // since old coveringRules() defaulted repoRoot to the real checkout and
  // would find it there by accident, discriminating nothing.
  it("matches a rule-covered path with no file behind it anywhere, the delete/rename shape", () => {
    const rules = [{ name: "tmux.md", globs: ["src/this-path-has-never-existed-84.ts"] }];
    const hits = coveringRules(["src/this-path-has-never-existed-84.ts"], rules);
    assert.deepEqual(hits.map((r) => r.name), ["tmux.md"]);
  });
});

describe("changedFiles", () => {
  it("lists a file the branch changed relative to base, not base's own history", () => {
    const dir = mkdtempSync(join(tmpdir(), "covering-rules-git-"));
    scratchGit(dir, "init", "-q", "-b", "main");
    writeFileSync(join(dir, "a.txt"), "1");
    scratchGit(dir, "add", "a.txt");
    scratchGit(dir, "commit", "-q", "-m", "base");
    scratchGit(dir, "checkout", "-q", "-b", "lane");
    writeFileSync(join(dir, "b.txt"), "1");
    scratchGit(dir, "add", "b.txt");
    scratchGit(dir, "commit", "-q", "-m", "lane change");

    assert.deepEqual(changedFiles("main", dir), ["b.txt"]);
  });

  it("uses the merge base, not base's tip: a commit landing on main after the branch forked must not appear", () => {
    // This is the exact two-dot-vs-three-dot trap: `git diff --name-only
    // main..HEAD` would report main's own post-fork commit (c.txt) as
    // changed on the branch, because it diffs tip-to-tip rather than from
    // the point the branch actually diverged.
    const dir = mkdtempSync(join(tmpdir(), "covering-rules-git-behind-"));
    scratchGit(dir, "init", "-q", "-b", "main");
    writeFileSync(join(dir, "a.txt"), "1");
    scratchGit(dir, "add", "a.txt");
    scratchGit(dir, "commit", "-q", "-m", "base");
    scratchGit(dir, "checkout", "-q", "-b", "lane");
    writeFileSync(join(dir, "b.txt"), "1");
    scratchGit(dir, "add", "b.txt");
    scratchGit(dir, "commit", "-q", "-m", "lane change");
    scratchGit(dir, "checkout", "-q", "main");
    writeFileSync(join(dir, "c.txt"), "1");
    scratchGit(dir, "add", "c.txt");
    scratchGit(dir, "commit", "-q", "-m", "main moved on without the lane");
    scratchGit(dir, "checkout", "-q", "lane");

    assert.deepEqual(changedFiles("main", dir), ["b.txt"]);
  });

  // The defect PR #93's gate caught on e5afc45: git's own rename detection
  // (diff.renames, on by default) collapses a `git mv` into just the NEW
  // path, so a plain `git diff --name-only` never lists the OLD, possibly
  // rule-covered name at all. Verified by hand first (see the header
  // comment above changedFiles()) before writing this: default output
  // prints only src/renamed.ts; --no-renames prints both.
  it("lists both the old and new path across a rename, not just the new one", () => {
    const dir = mkdtempSync(join(tmpdir(), "covering-rules-git-rename-"));
    scratchGit(dir, "init", "-q", "-b", "main");
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "tmux.ts"), "line\n".repeat(40));
    scratchGit(dir, "add", "src/tmux.ts");
    scratchGit(dir, "commit", "-q", "-m", "base, tmux.ts exists");
    scratchGit(dir, "checkout", "-q", "-b", "lane");
    scratchGit(dir, "mv", "src/tmux.ts", "src/renamed.ts");
    scratchGit(dir, "commit", "-q", "-m", "lane renames the rule-covered file");

    const files = changedFiles("main", dir);
    assert.ok(files.includes("src/tmux.ts"), "old path missing: renames were collapsed");
    assert.ok(files.includes("src/renamed.ts"), "new path missing");
  });
});

describe("report", () => {
  it("always names CLAUDE.md's Invariants section, matched rule or not", () => {
    const dir = mkdtempSync(join(tmpdir(), "covering-rules-git-report-"));
    const rulesDir = mkdtempSync(join(tmpdir(), "covering-rules-rules-"));
    scratchGit(dir, "init", "-q", "-b", "main");
    writeFileSync(join(dir, "a.txt"), "1");
    scratchGit(dir, "add", "a.txt");
    scratchGit(dir, "commit", "-q", "-m", "base");
    scratchGit(dir, "checkout", "-q", "-b", "lane");
    writeFileSync(join(dir, "unrelated.txt"), "1");
    scratchGit(dir, "add", "unrelated.txt");
    scratchGit(dir, "commit", "-q", "-m", "touches nothing a rule covers");

    const lines = report("main", dir, rulesDir);
    assert.equal(lines[0], "CLAUDE.md Invariants section (always in scope, no path glob)");
    assert.equal(lines.length, 1, "no rule should have matched an unrelated file");
  });

  it("lists a matched rule after the Invariants line", () => {
    const dir = mkdtempSync(join(tmpdir(), "covering-rules-git-report2-"));
    scratchGit(dir, "init", "-q", "-b", "main");
    writeFileSync(join(dir, "a.txt"), "1");
    scratchGit(dir, "add", "a.txt");
    scratchGit(dir, "commit", "-q", "-m", "base");
    scratchGit(dir, "checkout", "-q", "-b", "lane");
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "tmux.ts"), "1");
    scratchGit(dir, "add", "src/tmux.ts");
    scratchGit(dir, "commit", "-q", "-m", "touches a covered file");

    const rulesDir = mkdtempSync(join(tmpdir(), "covering-rules-rules2-"));
    writeFileSync(join(rulesDir, "tmux.md"), '---\npaths:\n  - "src/tmux.ts"\n---\n');

    const lines = report("main", dir, rulesDir);
    assert.deepEqual(lines, ["CLAUDE.md Invariants section (always in scope, no path glob)", ".claude/rules/tmux.md"]);
  });

  // End-to-end version of the delete/rename gap PR #93's gate found: the
  // file is genuinely gone from the lane's working tree by the time
  // report() runs, not just absent from a synthetic fixture. A
  // filesystem-based matcher fails this exactly because `git diff
  // --name-only` still lists the path while nothing on disk backs it.
  it("still names a rule whose covered file was deleted, not just added or modified", () => {
    const dir = mkdtempSync(join(tmpdir(), "covering-rules-git-report3-"));
    scratchGit(dir, "init", "-q", "-b", "main");
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "tmux.ts"), "1");
    scratchGit(dir, "add", "src/tmux.ts");
    scratchGit(dir, "commit", "-q", "-m", "base, tmux.ts exists");
    scratchGit(dir, "checkout", "-q", "-b", "lane");
    scratchGit(dir, "rm", "-q", "src/tmux.ts");
    scratchGit(dir, "commit", "-q", "-m", "lane deletes the rule-covered file");

    const rulesDir = mkdtempSync(join(tmpdir(), "covering-rules-rules3-"));
    writeFileSync(join(rulesDir, "tmux.md"), '---\npaths:\n  - "src/tmux.ts"\n---\n');

    const lines = report("main", dir, rulesDir);
    assert.deepEqual(lines, ["CLAUDE.md Invariants section (always in scope, no path glob)", ".claude/rules/tmux.md"]);
  });

  // End-to-end version of the rename gap PR #93's gate found on e5afc45:
  // the new name (src/renamed.ts) matches no rule at all, so this can only
  // pass if the OLD, rule-covered name (src/tmux.ts) reaches
  // coveringRules() too -- exactly what --no-renames in changedFiles() is
  // for. #81's own incident was this shape: src/config.ts, a second
  // consumer of store-and-datadir.md's guard, missing from that rule's
  // frontmatter until it was added by hand.
  it("still names a rule whose covered file was renamed to an uncovered path", () => {
    const dir = mkdtempSync(join(tmpdir(), "covering-rules-git-report4-"));
    scratchGit(dir, "init", "-q", "-b", "main");
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "tmux.ts"), "line\n".repeat(40));
    scratchGit(dir, "add", "src/tmux.ts");
    scratchGit(dir, "commit", "-q", "-m", "base, tmux.ts exists");
    scratchGit(dir, "checkout", "-q", "-b", "lane");
    scratchGit(dir, "mv", "src/tmux.ts", "src/renamed.ts");
    scratchGit(dir, "commit", "-q", "-m", "lane renames the rule-covered file away");

    const rulesDir = mkdtempSync(join(tmpdir(), "covering-rules-rules4-"));
    writeFileSync(join(rulesDir, "tmux.md"), '---\npaths:\n  - "src/tmux.ts"\n---\n');

    const lines = report("main", dir, rulesDir);
    assert.deepEqual(lines, ["CLAUDE.md Invariants section (always in scope, no path glob)", ".claude/rules/tmux.md"]);
  });
});

describe("the CLI entry", () => {
  const SCRIPT = join(REPO, "scripts/covering-rules.mjs");

  it("--help prints this script's own usage rather than running a diff", () => {
    const stdout = execFileSync(process.execPath, [SCRIPT, "--help"], { encoding: "utf8" });
    assert.match(stdout, /usage: covering-rules\.mjs/);
  });

  it("-h is the same as --help", () => {
    const stdout = execFileSync(process.execPath, [SCRIPT, "-h"], { encoding: "utf8" });
    assert.match(stdout, /usage: covering-rules\.mjs/);
  });

  it("an unresolved base prints this script's own error, not git diff's usage text", () => {
    assert.throws(
      () =>
        execFileSync(process.execPath, [SCRIPT, "not-a-real-ref-xyz"], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        }),
      (err) => {
        assert.equal(err.status, 1);
        assert.match(err.stderr, /covering-rules: "not-a-real-ref-xyz" does not resolve/);
        assert.doesNotMatch(err.stderr, /usage: git diff/);
        return true;
      },
    );
  });
});

describe("against the real repo", () => {
  it("loads every real rule with at least one glob, and tmux-and-panes.md covers src/tmux.ts", () => {
    const rules = loadRules();
    assert.ok(rules.length >= 4, "expected the four known rule files");
    for (const rule of rules) {
      assert.ok(rule.globs.length > 0, `${rule.name} declares no paths`);
    }
    const tmuxRule = rules.find((r) => r.name === "tmux-and-panes.md");
    assert.ok(tmuxRule, "tmux-and-panes.md should be among the real rules");
    const hits = coveringRules(["src/tmux.ts"], [tmuxRule]);
    assert.deepEqual(hits, [tmuxRule]);
  });
});
