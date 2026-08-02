#!/usr/bin/env node
// Issue #84: makes "which rules cover this lane" mechanical instead of a
// memory exercise. Every .claude/rules/*.md file declares `paths:` globs in
// its frontmatter; this intersects a diff's changed files against those
// globs and prints which rules cover it, with no judgment required.
//
// Matches with node:path's matchesGlob, a pure string comparison, not
// fs.globSync. globSync answers "does this glob match a file that exists on
// disk right now", which is the right question for test/docs.test.mjs (is
// this rule dead, matching nothing real) and the wrong one here: a lane
// that DELETES a rule-covered file still has that path in changedFiles(),
// but the file is gone from the working tree, so a filesystem-based match
// silently drops it. That is the exact class of miss #84 exists to catch,
// reached through deletion instead of a missing frontmatter entry.
// matchesGlob asks the question this script actually has -- does this
// STRING match this pattern -- whether or not anything is there to back
// it. (An earlier version of this file used fs.globSync here too,
// reasoning that sharing docs.test.mjs's matcher couldn't disagree with
// it; that reasoning answered a different question than this one asks, and
// PR #93's gate caught the gap.)
//
// A RENAME is the same class of miss reached a second way, and matchesGlob
// alone does not cover it: git's own rename detection collapses a `git mv`
// (or a close-enough edit) into just the NEW path, so the old, rule-covered
// name never reaches changedFiles() at all. changedFiles() passes
// --no-renames to `git diff` specifically to stop that collapse -- see its
// own comment before treating that flag as a stray one to clean up.
//
// CLAUDE.md's Invariants section is named unconditionally, not matched
// against the diff: unlike a rule, it has no path scope; it applies to
// every lane by definition, so "no rule matched" is never the same as
// "nothing to re-read". README is deliberately not a candidate here: it is
// user-facing, changes for different reasons than an invariant does, and
// #83 pins its structure separately.
//
// This file needs Node 22.5.0: fs.globSync below landed in 22.0, and
// matchesGlob landed at 22.5.0 (backported to 20.17). package.json's
// engines.node used to claim ">=18", so a Node 18 or 20 run threw a
// SyntaxError at import before any code ran, including --help. It now says
// ">=22.5.0". CI tests 22 and 24, but `node-version: 22` resolves to the
// latest 22.x, so the .5.0 is reasoned from matchesGlob's own history rather
// than exercised; 22.0 through 22.4 would still throw here. A 20 leg was
// tried and failed on this file and on test/docs.test.mjs, which has depended
// on globSync all along without anything testing it.

import { execFileSync } from "node:child_process";
import { globSync, readFileSync } from "node:fs";
import { join, matchesGlob } from "node:path";

export const REPO = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const RULES_DIR = join(REPO, ".claude/rules");

// Pulls the `paths:` glob list out of a rule file's frontmatter. Returns []
// for a file with no frontmatter or no paths, the same "never fires" case
// test/docs.test.mjs already flags as a dead rule.
export function parseRulePaths(content) {
  const frontmatter = /^---\n([\s\S]*?)\n---/.exec(content);
  if (!frontmatter) return [];
  return [...frontmatter[1].matchAll(/^\s*-\s*"([^"]+)"/gm)].map((m) => m[1]);
}

export function loadRules(rulesDir = RULES_DIR) {
  return globSync("*.md", { cwd: rulesDir })
    .sort()
    .map((name) => ({
      name,
      globs: parseRulePaths(readFileSync(join(rulesDir, name), "utf8")),
    }));
}

// A pure string match, deliberately not filesystem-based: see the header
// comment on why fs.globSync is wrong for this question. changedFiles here
// can include paths that no longer exist in the working tree (a delete or
// a rename shows up as one in `git diff --name-only`), and those still
// need to match.
export function coveringRules(changedFiles, rules) {
  return rules.filter(({ globs }) => globs.some((pattern) => changedFiles.some((file) => matchesGlob(file, pattern))));
}

// Triple-dot: diffs against the MERGE BASE with `base`, not against base's
// current tip. A two-dot diff on a branch that is behind base reports files
// on base as changed on the branch, which is not the question this answers.
//
// --no-renames is load-bearing, not a stray flag to tidy up. git's
// diff.renames defaults to on, so a `git mv` (or an edit similar enough for
// git's own heuristic to call it one) is reported as ONLY the new path;
// the old, rule-covered name never reaches changedFiles() at all, which
// drops a rule exactly as silently as the delete case above did. Verified
// against a real `git mv` in a scratch repo: default `--name-only` prints
// only the new path, `--name-status` shows R100 for the pair, and
// `--no-renames --name-only` prints both the old and the new path. This
// script wants the old path, so renames stay disabled here on purpose.
export function changedFiles(base, repoRoot = REPO) {
  const out = execFileSync("git", ["diff", "--no-renames", "--name-only", `${base}...HEAD`], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  return out.split("\n").filter(Boolean);
}

export function report(base, repoRoot = REPO, rulesDir = join(repoRoot, ".claude/rules")) {
  const files = changedFiles(base, repoRoot);
  const hits = coveringRules(files, loadRules(rulesDir));
  const lines = ["CLAUDE.md Invariants section (always in scope, no path glob)"];
  for (const { name } of hits) lines.push(`.claude/rules/${name}`);
  return lines;
}

const USAGE = `usage: covering-rules.mjs [<base>]

Prints which .claude/rules/*.md files cover the diff between <base> and
HEAD (git diff --name-only <base>...HEAD), plus CLAUDE.md's Invariants
section, which is always in scope regardless of what changed.

<base> defaults to "main" when omitted.

Reads COMMITTED work only. Uncommitted changes in the working tree are
invisible to it, so run it after committing -- which is where runbook step 7
puts it, just before the PR opens.`;

// Checked separately from running the diff itself: an unresolved <base>
// otherwise reaches `git diff --name-only <base>...HEAD` as a bad rev, and
// git's own error names `git diff`, which points a reader at the wrong tool
// for a mistake made against this one.
function baseResolves(base, repoRoot = REPO) {
  try {
    execFileSync("git", ["rev-parse", "--verify", "--quiet", `${base}^{commit}`], {
      cwd: repoRoot,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

function main() {
  const arg = process.argv[2];
  if (arg === "-h" || arg === "--help") {
    console.log(USAGE);
    return;
  }
  const base = arg || "main";
  if (!baseResolves(base)) {
    console.error(`covering-rules: "${base}" does not resolve to a commit here.\n\n${USAGE}`);
    process.exitCode = 1;
    return;
  }
  for (const line of report(base)) console.log(line);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
