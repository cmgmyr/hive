import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  changedFiles,
  changedFilesWithStatus,
  coveringRules,
  loadDocs,
  loadRules,
  mentionedPaths,
  nameOnlyMentions,
  parseRulePaths,
  report,
  REPO,
} from "../scripts/covering-rules.mjs";
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

  it("matches a rule-covered path with no file behind it anywhere, the delete/rename shape", () => {
    const rules = [{ name: "tmux.md", globs: ["src/this-path-has-never-existed-84.ts"] }];
    const hits = coveringRules(["src/this-path-has-never-existed-84.ts"], rules);
    assert.deepEqual(hits.map((r) => r.name), ["tmux.md"]);
  });
});

describe("mentionedPaths", () => {
  it("extracts a backtick-quoted src/*.ts path from prose", () => {
    assert.deepEqual(mentionedPaths("see `src/cli.ts` for the adopt check"), ["src/cli.ts"]);
  });

  it("extracts test/*.mjs, scripts/*.mjs and docs/*.md, the other core scoped pairs", () => {
    const prose = "`test/helpers.mjs`, `scripts/covering-rules.mjs` and `docs/tmux.md` all changed";
    assert.deepEqual(mentionedPaths(prose), ["test/helpers.mjs", "scripts/covering-rules.mjs", "docs/tmux.md"]);
  });

  it("ignores a dir/extension pair outside the scoped ones, docs/*.ts here", () => {
    assert.deepEqual(mentionedPaths("`docs/notes.ts` is not one of the scoped pairs"), []);
  });

  it("ignores a path not wrapped in backticks", () => {
    assert.deepEqual(mentionedPaths("src/cli.ts with no backticks"), []);
  });

  it("dedupes a path mentioned more than once", () => {
    assert.deepEqual(mentionedPaths("`src/cli.ts` ... later, `src/cli.ts` again"), ["src/cli.ts"]);
  });

  it("extracts a .claude/rules/*.md path", () => {
    assert.deepEqual(mentionedPaths("see `.claude/rules/tmux-and-panes.md`"), [".claude/rules/tmux-and-panes.md"]);
  });

  it("extracts src/AGENTS.md and test/CLAUDE.md, the two real bare-.md-under-a-code-prefix cases", () => {
    assert.deepEqual(mentionedPaths("`src/AGENTS.md` and `test/CLAUDE.md`"), ["src/AGENTS.md", "test/CLAUDE.md"]);
  });

  it("still ignores a bare filename with no directory prefix, the accepted residual", () => {
    assert.deepEqual(mentionedPaths("`docs.test.mjs` and `CLAUDE.md`"), []);
  });

  it("extracts a glob-shaped mention", () => {
    assert.deepEqual(mentionedPaths("the group lives under `src/tools/*.ts`"), ["src/tools/*.ts"]);
  });

  it("ignores a mention inside a markdown table row", () => {
    assert.deepEqual(mentionedPaths("| `src/cli.ts` | the CLI entry |"), []);
  });

  it("ignores a mention inside a table's separator or header row too, same `|`-prefixed shape", () => {
    assert.deepEqual(mentionedPaths("| Rule | Fires on |\n|---|---|\n| x | `src/cli.ts` |"), []);
  });

  it("still extracts a mention from an ordinary paragraph, unaffected by the table exclusion", () => {
    assert.deepEqual(mentionedPaths("`cmdLead` lives in `src/cli.ts` and does the adopt check"), ["src/cli.ts"]);
  });

  it("extracts a paragraph mention and ignores a table mention in the same content", () => {
    const content = "`cmdLead` lives in `src/cli.ts`.\n\n| `.claude/rules/tmux-and-panes.md` | `src/tmux.ts` | why |\n";
    assert.deepEqual(mentionedPaths(content), ["src/cli.ts"]);
  });
});

describe("nameOnlyMentions", () => {
  it("reports a globless doc (CLAUDE.md-shaped) that mentions a changed file, Hole 2", () => {
    const docs = [{ name: "CLAUDE.md", content: "see `src/cli.ts` for the adopt check" }];
    const findings = nameOnlyMentions(["src/cli.ts"], docs);
    assert.deepEqual(findings, [{ name: "CLAUDE.md", files: ["src/cli.ts"] }]);
  });

  it("reports a rule whose prose names a changed file its own globs do not cover, Hole 1", () => {
    const docs = [{ name: "tmux.md", content: "`cmdLead` lives in `src/cli.ts`", globs: ["src/tmux.ts"] }];
    const findings = nameOnlyMentions(["src/cli.ts"], docs);
    assert.deepEqual(findings, [{ name: "tmux.md", files: ["src/cli.ts"] }]);
  });

  it("does not report a rule for a mention its own globs already cover, no duplicate noise", () => {
    const docs = [{ name: "tmux.md", content: "see `src/tmux.ts`", globs: ["src/tmux.ts"] }];
    assert.deepEqual(nameOnlyMentions(["src/tmux.ts"], docs), []);
  });

  it("does not report a mention that is not in the diff at all", () => {
    const docs = [{ name: "CLAUDE.md", content: "see `src/cli.ts`" }];
    assert.deepEqual(nameOnlyMentions(["src/unrelated.ts"], docs), []);
  });

  it("reports a glob-shaped mention when the matching file was ADDED, not merely modified", () => {
    const docs = [{ name: "CLAUDE.md", content: "MCP tools live under `src/tools/*.ts`" }];
    const findings = nameOnlyMentions(["src/tools/wakes.ts"], docs, ["src/tools/wakes.ts"]);
    assert.deepEqual(findings, [{ name: "CLAUDE.md", files: ["src/tools/*.ts"] }]);
  });

  it("does NOT report a glob-shaped mention when the matching file was only MODIFIED", () => {
    const docs = [{ name: "CLAUDE.md", content: "MCP tools live under `src/tools/*.ts`" }];

    const findings = nameOnlyMentions(["src/tools/wakes.ts"], docs, []);
    assert.deepEqual(findings, []);
  });

  it("still reports a literal mention on a modify-only change, unaffected by the structural restriction", () => {
    const docs = [{ name: "tmux.md", content: "`cmdLead` lives in `src/cli.ts`", globs: ["src/tmux.ts"] }];
    const findings = nameOnlyMentions(["src/cli.ts"], docs, []);
    assert.deepEqual(findings, [{ name: "tmux.md", files: ["src/cli.ts"] }]);
  });

  it("subtracts a glob-shaped self-mention already covered by the rule's own identical glob", () => {
    const docs = [{ name: "tool-contract.md", content: "every tool lives in `src/tools/*.ts`", globs: ["src/tools/*.ts"] }];
    assert.deepEqual(nameOnlyMentions(["src/tools/wakes.ts"], docs, ["src/tools/wakes.ts"]), []);
  });

  it("does not match a glob-shaped mention against an added file outside it", () => {
    const docs = [{ name: "CLAUDE.md", content: "see `src/tools/*.ts`" }];
    assert.deepEqual(nameOnlyMentions(["src/cli.ts"], docs, ["src/cli.ts"]), []);
  });
});

describe("loadDocs", () => {
  it("loads CLAUDE.md and docs/*.md content from a repo root", () => {
    const dir = mkdtempSync(join(tmpdir(), "covering-rules-docs-"));
    writeFileSync(join(dir, "CLAUDE.md"), "root doc");
    mkdirSync(join(dir, "docs"));
    writeFileSync(join(dir, "docs", "tmux.md"), "tmux doc");

    const docs = loadDocs(dir);
    assert.deepEqual(
      docs.map((d) => d.name).sort(),
      ["CLAUDE.md", "docs/tmux.md"],
    );

    assert.deepEqual(
      docs.map((d) => d.content).sort(),
      ["root doc", "tmux doc"],
    );
  });

  it("skips a missing CLAUDE.md or docs/ dir rather than throwing", () => {
    const dir = mkdtempSync(join(tmpdir(), "covering-rules-docs-empty-"));
    assert.deepEqual(loadDocs(dir), []);
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

describe("changedFilesWithStatus", () => {
  it("tags a modified file M, an added file A, and a deleted file D", () => {
    const dir = mkdtempSync(join(tmpdir(), "covering-rules-git-status-"));
    scratchGit(dir, "init", "-q", "-b", "main");
    writeFileSync(join(dir, "modified.txt"), "1");
    writeFileSync(join(dir, "deleted.txt"), "1");
    scratchGit(dir, "add", "modified.txt", "deleted.txt");
    scratchGit(dir, "commit", "-q", "-m", "base");
    scratchGit(dir, "checkout", "-q", "-b", "lane");
    writeFileSync(join(dir, "modified.txt"), "2");
    writeFileSync(join(dir, "added.txt"), "1");
    scratchGit(dir, "rm", "-q", "deleted.txt");
    scratchGit(dir, "add", "modified.txt", "added.txt");
    scratchGit(dir, "commit", "-q", "-m", "modify, add, delete");

    const statuses = changedFilesWithStatus("main", dir);
    assert.deepEqual(
      statuses.sort((a, b) => a.path.localeCompare(b.path)),
      [
        { status: "A", path: "added.txt" },
        { status: "D", path: "deleted.txt" },
        { status: "M", path: "modified.txt" },
      ],
    );
  });

  it("tags a renamed file as D (old path) and A (new path), never M", () => {
    const dir = mkdtempSync(join(tmpdir(), "covering-rules-git-status-rename-"));
    scratchGit(dir, "init", "-q", "-b", "main");
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "tmux.ts"), "line\n".repeat(40));
    scratchGit(dir, "add", "src/tmux.ts");
    scratchGit(dir, "commit", "-q", "-m", "base");
    scratchGit(dir, "checkout", "-q", "-b", "lane");
    scratchGit(dir, "mv", "src/tmux.ts", "src/renamed.ts");
    scratchGit(dir, "commit", "-q", "-m", "rename");

    const statuses = changedFilesWithStatus("main", dir);
    assert.deepEqual(
      statuses.sort((a, b) => a.path.localeCompare(b.path)),
      [
        { status: "A", path: "src/renamed.ts" },
        { status: "D", path: "src/tmux.ts" },
      ],
    );
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

  it("adds the weaker 'names but does not cover' category after the strong hits", () => {
    const dir = mkdtempSync(join(tmpdir(), "covering-rules-git-report5-"));
    scratchGit(dir, "init", "-q", "-b", "main");
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "a.ts"), "1");
    scratchGit(dir, "add", "src/a.ts");
    scratchGit(dir, "commit", "-q", "-m", "base");
    scratchGit(dir, "checkout", "-q", "-b", "lane");

    writeFileSync(join(dir, "src", "aaa-unrelated.ts"), "1");
    writeFileSync(join(dir, "src", "cli.ts"), "1");
    scratchGit(dir, "add", "src/aaa-unrelated.ts", "src/cli.ts");
    scratchGit(dir, "commit", "-q", "-m", "touches src/aaa-unrelated.ts and src/cli.ts");

    writeFileSync(join(dir, "CLAUDE.md"), "see `src/cli.ts` for the adopt check");

    const rulesDir = mkdtempSync(join(tmpdir(), "covering-rules-rules5-"));
    writeFileSync(
      join(rulesDir, "tmux.md"),
      '---\npaths:\n  - "src/tmux.ts"\n---\n\n`cmdLead` lives in `src/cli.ts`\n',
    );

    const lines = report("main", dir, rulesDir);
    assert.deepEqual(lines, [
      "CLAUDE.md Invariants section (always in scope, no path glob)",
      "NAMES A FILE IN YOUR DIFF BUT DOES NOT COVER IT -- read for stale claims:",
      "  CLAUDE.md: src/cli.ts",
      "  .claude/rules/tmux.md: src/cli.ts",
    ]);
  });

  it("a glob-shaped mention fires on an added file but stays silent on a modify-only one", () => {
    const dir = mkdtempSync(join(tmpdir(), "covering-rules-git-report6-"));
    scratchGit(dir, "init", "-q", "-b", "main");
    mkdirSync(join(dir, "src", "tools"), { recursive: true });
    writeFileSync(join(dir, "src", "tools", "wakes.ts"), "1");
    scratchGit(dir, "add", "src/tools/wakes.ts");
    scratchGit(dir, "commit", "-q", "-m", "base");
    scratchGit(dir, "checkout", "-q", "-b", "lane");

    writeFileSync(join(dir, "src", "tools", "wakes.ts"), "2");
    scratchGit(dir, "add", "src/tools/wakes.ts");
    scratchGit(dir, "commit", "-q", "-m", "modify only");

    writeFileSync(join(dir, "CLAUDE.md"), "MCP tools live under `src/tools/*.ts`");
    const rulesDir = mkdtempSync(join(tmpdir(), "covering-rules-rules6-"));

    assert.deepEqual(report("main", dir, rulesDir), ["CLAUDE.md Invariants section (always in scope, no path glob)"]);

    writeFileSync(join(dir, "src", "tools", "reviews.ts"), "1");
    scratchGit(dir, "add", "src/tools/reviews.ts");
    scratchGit(dir, "commit", "-q", "-m", "adds a new tool file");

    assert.deepEqual(report("main", dir, rulesDir), [
      "CLAUDE.md Invariants section (always in scope, no path glob)",
      "NAMES A FILE IN YOUR DIFF BUT DOES NOT COVER IT -- read for stale claims:",
      "  CLAUDE.md: src/tools/*.ts",
    ]);
  });

  it("drops a table-row mention but keeps a paragraph mention of the same file, in the same doc", () => {
    const dir = mkdtempSync(join(tmpdir(), "covering-rules-git-report7-"));
    scratchGit(dir, "init", "-q", "-b", "main");
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "cli.ts"), "1");
    scratchGit(dir, "add", "src/cli.ts");
    scratchGit(dir, "commit", "-q", "-m", "base");
    scratchGit(dir, "checkout", "-q", "-b", "lane");
    writeFileSync(join(dir, "src", "cli.ts"), "2");
    scratchGit(dir, "add", "src/cli.ts");
    scratchGit(dir, "commit", "-q", "-m", "modify src/cli.ts");

    writeFileSync(
      join(dir, "CLAUDE.md"),
      "| `src/cli.ts` | `hive` CLI entry |\n\n" + "`cmdLead` (`src/cli.ts`) resolves a project's window.\n",
    );
    const rulesDir = mkdtempSync(join(tmpdir(), "covering-rules-rules7-"));

    assert.deepEqual(report("main", dir, rulesDir), [
      "CLAUDE.md Invariants section (always in scope, no path glob)",
      "NAMES A FILE IN YOUR DIFF BUT DOES NOT COVER IT -- read for stale claims:",
      "  CLAUDE.md: src/cli.ts",
    ]);
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

  it("names nothing for src/cli.ts against tmux-and-panes.md as it stands today, the fix having landed", () => {
    const tmuxRule = loadRules().find((r) => r.name === "tmux-and-panes.md");
    assert.ok(tmuxRule.globs.includes("src/cli.ts"), "the rule's frontmatter should already cover src/cli.ts");
    assert.deepEqual(nameOnlyMentions(["src/cli.ts"], [tmuxRule]), []);
  });

  it("loads CLAUDE.md and every real docs/*.md file, not silently fewer", () => {

    const docs = loadDocs();
    assert.deepEqual(
      docs.map((d) => d.name).sort(),
      [
        "CLAUDE.md",
        "docs/concepts.md",
        "docs/daily-driver.md",
        "docs/development.md",
        "docs/install.md",
        "docs/profiles.md",
        "docs/projects.md",
        "docs/tmux.md",
        "docs/tools.md",
        "docs/troubleshooting.md",
      ],
    );
    for (const doc of docs) assert.ok(doc.content.length > 0, `${doc.name} loaded with empty content`);
  });
});

describe("red-proof against real history: tmux-and-panes.md before PR #159's doc fix", () => {
  const PRE_FIX_FRONTMATTER = ["src/tmux.ts", "src/spawn.ts", "src/scheduler.ts", "src/tools/agents.ts", "docs/*.md"];
  const PRE_FIX_PROSE =
    "`ensureLeadRow`'s fresh INSERT and `cmdLead`'s restart CAS (`src/cli.ts`), all from `tmuxSocketPath()` ... " +
    "and `startYmlCommand`/`cmdLead`'s stillThere check/`hive doctor`'s lead report (`src/cli.ts`).";

  it("would have named tmux-and-panes.md as naming-but-not-covering src/cli.ts", () => {
    assert.ok(!PRE_FIX_FRONTMATTER.includes("src/cli.ts"), "precondition: the pre-fix frontmatter must not yet cover src/cli.ts");
    const findings = nameOnlyMentions(
      ["src/cli.ts"],
      [{ name: "tmux-and-panes.md", content: PRE_FIX_PROSE, globs: PRE_FIX_FRONTMATTER }],
    );
    assert.deepEqual(findings, [{ name: "tmux-and-panes.md", files: ["src/cli.ts"] }]);
  });
});
