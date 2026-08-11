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

  // Counselors (todo 354) measured three real, load-bearing shapes the
  // original four-pair version missed: a `.claude/rules/*.md` path (the
  // exact PR #159 CLAUDE.md-table shape, reached from another doc's prose
  // about a rule rather than the rule's own frontmatter), and a `.md` file
  // under src/ or test/ (src/AGENTS.md, test/CLAUDE.md), which the original
  // pairs excluded purely because the extension didn't match that prefix.
  it("extracts a .claude/rules/*.md path", () => {
    assert.deepEqual(mentionedPaths("see `.claude/rules/tmux-and-panes.md`"), [".claude/rules/tmux-and-panes.md"]);
  });

  it("extracts src/AGENTS.md and test/CLAUDE.md, the two real bare-.md-under-a-code-prefix cases", () => {
    assert.deepEqual(mentionedPaths("`src/AGENTS.md` and `test/CLAUDE.md`"), ["src/AGENTS.md", "test/CLAUDE.md"]);
  });

  // Still excluded on purpose: a bare filename with no directory at all.
  // Recognising it means matching against the real repo's file tree, not a
  // fixed shape -- the "relevance ranking" escalation line the todo itself
  // named. See MENTION_RE's own comment.
  it("still ignores a bare filename with no directory prefix, the accepted residual", () => {
    assert.deepEqual(mentionedPaths("`docs.test.mjs` and `CLAUDE.md`"), []);
  });

  // A glob-shaped mention (Hole B): the character class allows `*`, so
  // `` `src/tools/*.ts` `` is captured as a mention now, not silently
  // dropped. What it matches against a diff is nameOnlyMentions()'s job, via
  // matchesGlob -- see that describe block below.
  it("extracts a glob-shaped mention", () => {
    assert.deepEqual(mentionedPaths("the group lives under `src/tools/*.ts`"), ["src/tools/*.ts"]);
  });

  // The index-vs-claim distinction (Chris, todo 354): a table row names
  // your file because the table names EVERYTHING, which carries no
  // information; a paragraph names your file because it is making a claim
  // ABOUT it. Table-row is the cheap syntactic proxy, checked against all
  // three recorded failures -- see TABLE_ROW_RE's own comment for which
  // stayed caught and which was dropped, and why dropping the third one
  // loses nothing.
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

  // Hole B (counselors, todo 354): the original `changedFiles.includes(path)`
  // check was a plain string equality, so a glob-shaped mention could never
  // match a literal changed file even after mentionedPaths() started
  // extracting one. First fix matched through matchesGlob() instead, the
  // same primitive coveringRules() already uses -- and Chris then measured
  // that fix against real multi-file lanes (not this file's own small diff)
  // and found it unusable: `src/tools/*.ts` matched almost any changed
  // TypeScript file, because matchesGlob answers "is this file under this
  // glob", not "did this glob's MEMBERSHIP change". A category statement
  // can never be falsified by editing one member of the category, only by
  // one being added or removed -- PR #147's real failure shape agrees:
  // docs/reviewer-preamble.md said "four rule files", and what falsified it
  // was a rule file being ADDED, not any existing one's content changing.
  // So a glob mention now matches only against `structuralFiles` (added or
  // deleted), the third argument, which defaults to `changedFiles` so every
  // literal-only test above keeps passing unchanged.
  it("reports a glob-shaped mention when the matching file was ADDED, not merely modified", () => {
    const docs = [{ name: "CLAUDE.md", content: "MCP tools live under `src/tools/*.ts`" }];
    const findings = nameOnlyMentions(["src/tools/wakes.ts"], docs, ["src/tools/wakes.ts"]);
    assert.deepEqual(findings, [{ name: "CLAUDE.md", files: ["src/tools/*.ts"] }]);
  });

  it("does NOT report a glob-shaped mention when the matching file was only MODIFIED", () => {
    const docs = [{ name: "CLAUDE.md", content: "MCP tools live under `src/tools/*.ts`" }];
    // src/tools/wakes.ts changed, but structuralFiles is empty -- nothing
    // was added or deleted, so the category's membership is unchanged.
    const findings = nameOnlyMentions(["src/tools/wakes.ts"], docs, []);
    assert.deepEqual(findings, []);
  });

  // The PR #159 shape stays intact deliberately: a LITERAL mention is
  // already a claim about that one specific file, so it is unaffected by
  // the structural restriction and still matches on an ordinary modify --
  // exactly the case that made tmux-and-panes.md's own prose stale.
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
    // Names alone would still pass if content were read from the wrong path
    // or dropped entirely -- assert the actual bytes, not just that a doc
    // with the right name showed up.
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

  // A `git mv` under --no-renames is a delete-of-old plus an add-of-new,
  // same reasoning as changedFiles()'s own rename test -- and the right
  // answer for THIS function specifically, per its own header comment: a
  // rename really does change glob membership at both the old path (leaves
  // it) and the new path (joins it), so both must read as structural, never
  // as a single M that report() would then treat as a non-event.
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

  // End-to-end version of Hole 1/2 (todo 354): CLAUDE.md names a changed file
  // in prose, and a rule's prose names a second changed file its own globs
  // do not cover. Neither reaches the strong "covers" list above; both must
  // still surface, in the separate weaker category.
  it("adds the weaker 'names but does not cover' category after the strong hits", () => {
    const dir = mkdtempSync(join(tmpdir(), "covering-rules-git-report5-"));
    scratchGit(dir, "init", "-q", "-b", "main");
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "a.ts"), "1");
    scratchGit(dir, "add", "src/a.ts");
    scratchGit(dir, "commit", "-q", "-m", "base");
    scratchGit(dir, "checkout", "-q", "-b", "lane");
    // Two changed files, the mentioned one listed SECOND -- git sorts
    // `diff --name-only` output alphabetically, so "aaa-" sorts before
    // "cli.ts" regardless of add/commit order. An implementation that only
    // checked changedFiles[0] would pass every other test here and still
    // miss this one (test/CLAUDE.md shape 6, a fixture too small to reach
    // the bound).
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

  // End-to-end version of the measurement that blocked the first version of
  // this lane from merging: Chris ran covering-rules.mjs against real,
  // multi-file historical diffs and found a glob-shaped mention like
  // `` `src/tools/*.ts` `` matching almost any changed file, since
  // matchesGlob answers "is this file under the glob", not "did the glob's
  // MEMBERSHIP change" -- wired here as a real `git diff --name-status`
  // through report() itself, not a hand-built array, so the fix is proven
  // at the layer it actually has to hold at.
  it("a glob-shaped mention fires on an added file but stays silent on a modify-only one", () => {
    const dir = mkdtempSync(join(tmpdir(), "covering-rules-git-report6-"));
    scratchGit(dir, "init", "-q", "-b", "main");
    mkdirSync(join(dir, "src", "tools"), { recursive: true });
    writeFileSync(join(dir, "src", "tools", "wakes.ts"), "1");
    scratchGit(dir, "add", "src/tools/wakes.ts");
    scratchGit(dir, "commit", "-q", "-m", "base");
    scratchGit(dir, "checkout", "-q", "-b", "lane");
    // A pure modify: wakes.ts's content changes, but the src/tools/*
    // category gains and loses nothing.
    writeFileSync(join(dir, "src", "tools", "wakes.ts"), "2");
    scratchGit(dir, "add", "src/tools/wakes.ts");
    scratchGit(dir, "commit", "-q", "-m", "modify only");

    writeFileSync(join(dir, "CLAUDE.md"), "MCP tools live under `src/tools/*.ts`");
    const rulesDir = mkdtempSync(join(tmpdir(), "covering-rules-rules6-"));

    assert.deepEqual(report("main", dir, rulesDir), ["CLAUDE.md Invariants section (always in scope, no path glob)"]);

    // Now add a second tool file on the same branch -- real category
    // membership change, and this is the shape that should fire.
    writeFileSync(join(dir, "src", "tools", "reviews.ts"), "1");
    scratchGit(dir, "add", "src/tools/reviews.ts");
    scratchGit(dir, "commit", "-q", "-m", "adds a new tool file");

    assert.deepEqual(report("main", dir, rulesDir), [
      "CLAUDE.md Invariants section (always in scope, no path glob)",
      "NAMES A FILE IN YOUR DIFF BUT DOES NOT COVER IT -- read for stale claims:",
      "  CLAUDE.md: src/tools/*.ts",
    ]);
  });

  // End-to-end version of the fix that reduced CLAUDE.md from a dozen paths
  // to what a reader would actually open: a table row naming src/cli.ts
  // (an INDEX, no information -- the table names every module) stays
  // silent, while a paragraph naming the same file (a CLAIM about it)
  // still fires. This is PR #159's own two failures side by side in one
  // doc: the table half is dropped here because it's exactly covered by
  // the frontmatter-vs-table pin test instead; the prose half stays caught.
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

  // loadDocs()'s CLAUDE.md-optional skip (see its own comment) is deliberate
  // for scratch fixtures; this is the one assertion that makes the loud
  // backstop for the REAL repo deliberate too, rather than incidental
  // cross-coverage from test/docs.test.mjs's own unconditional reads
  // (counselors, todo 354).
  it("loads CLAUDE.md and both real docs/*.md files, not silently fewer", () => {
    const docs = loadDocs();
    assert.deepEqual(
      docs.map((d) => d.name).sort(),
      ["CLAUDE.md", "docs/reviewer-preamble.md", "docs/tmux.md"],
    );
    for (const doc of docs) assert.ok(doc.content.length > 0, `${doc.name} loaded with empty content`);
  });
});

// Red-proof (todo 354): the exact shape PR #159 nearly shipped. At commit
// 8440b59 -- the parent of 61b6f6d, the doc-fix commit -- tmux-and-panes.md's
// own prose already named src/cli.ts (`git show
// 8440b59:.claude/rules/tmux-and-panes.md`, verified interactively), but its
// frontmatter did not yet list it. PRE_FIX_PROSE below is that revision's
// real text, excerpted verbatim (only elided with "..." for length, never
// paraphrased); PRE_FIX_FRONTMATTER is its real paths list, src/cli.ts
// missing exactly as it was. Frozen as a fixture rather than a live `git
// show` for the same reason as docs.test.mjs's sibling check: 8440b59 is
// unreachable from any branch or tag after PR #159's squash-merge, so it
// would not survive a fresh clone or a `git gc`, and this suite has to.
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
