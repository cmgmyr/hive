#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, globSync, readFileSync } from "node:fs";
import { join, matchesGlob } from "node:path";

export const REPO = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const RULES_DIR = join(REPO, ".claude/rules");

export function parseRulePaths(content) {
  const frontmatter = /^---\n([\s\S]*?)\n---/.exec(content);
  if (!frontmatter) return [];
  return [...frontmatter[1].matchAll(/^\s*-\s*"([^"]+)"/gm)].map((m) => m[1]);
}

export function loadRules(rulesDir = RULES_DIR) {
  return globSync("*.md", { cwd: rulesDir })
    .sort()
    .map((name) => {
      const content = readFileSync(join(rulesDir, name), "utf8");
      return { name, content, globs: parseRulePaths(content) };
    });
}

export function coveringRules(changedFiles, rules) {
  return rules.filter(({ globs }) => globs.some((pattern) => changedFiles.some((file) => matchesGlob(file, pattern))));
}

const MENTION_RE =
  /`(src\/[\w./*-]+\.(?:ts|md)|test\/[\w./*-]+\.(?:mjs|md)|scripts\/[\w./*-]+\.mjs|docs\/[\w./*-]+\.md|\.claude\/rules\/[\w.*-]+\.md)`/g;

const TABLE_ROW_RE = /^\s*\|/;

export function mentionedPaths(content) {
  const found = new Set();
  for (const line of content.split("\n")) {
    if (TABLE_ROW_RE.test(line)) continue;
    for (const m of line.matchAll(MENTION_RE)) found.add(m[1]);
  }
  return [...found];
}

export function loadDocs(repoRoot = REPO) {
  const candidates = [
    { name: "CLAUDE.md", path: join(repoRoot, "CLAUDE.md") },
    ...globSync("docs/*.md", { cwd: repoRoot })
      .sort()
      .map((name) => ({ name, path: join(repoRoot, name) })),
  ];
  return candidates.filter(({ path }) => existsSync(path)).map(({ name, path }) => ({ name, content: readFileSync(path, "utf8") }));
}

export function nameOnlyMentions(changedFiles, docs, structuralFiles = changedFiles) {
  const findings = [];
  for (const { name, content, globs = [] } of docs) {
    const mentioned = mentionedPaths(content).filter((path) => {
      const pool = path.includes("*") ? structuralFiles : changedFiles;
      return pool.some((file) => matchesGlob(file, path));
    });
    const uncovered = mentioned.filter((path) => !globs.some((pattern) => matchesGlob(path, pattern)));
    if (uncovered.length > 0) findings.push({ name, files: uncovered });
  }
  return findings;
}

export function changedFiles(base, repoRoot = REPO) {
  const out = execFileSync("git", ["diff", "--no-renames", "--name-only", `${base}...HEAD`], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  return out.split("\n").filter(Boolean);
}

export function changedFilesWithStatus(base, repoRoot = REPO) {
  const out = execFileSync("git", ["diff", "--no-renames", "--name-status", `${base}...HEAD`], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [status, ...rest] = line.split("\t");
      return { status: status[0], path: rest.join("\t") };
    });
}

export function report(base, repoRoot = REPO, rulesDir = join(repoRoot, ".claude/rules")) {
  const files = changedFiles(base, repoRoot);
  const rules = loadRules(rulesDir);
  const hits = coveringRules(files, rules);
  const lines = ["CLAUDE.md Invariants section (always in scope, no path glob)"];
  for (const { name } of hits) lines.push(`.claude/rules/${name}`);

  const structuralFiles = changedFilesWithStatus(base, repoRoot)
    .filter(({ status }) => status !== "M")
    .map(({ path }) => path);
  const docs = [...loadDocs(repoRoot), ...rules.map((r) => ({ ...r, name: `.claude/rules/${r.name}` }))];
  const mentions = nameOnlyMentions(files, docs, structuralFiles);
  if (mentions.length > 0) {
    lines.push("NAMES A FILE IN YOUR DIFF BUT DOES NOT COVER IT -- read for stale claims:");
    for (const { name, files: mentionedFiles } of mentions) lines.push(`  ${name}: ${mentionedFiles.join(", ")}`);
  }
  return lines;
}

const USAGE = `usage: covering-rules.mjs [<base>]

Prints which .claude/rules/*.md files cover the diff between <base> and
HEAD (git diff --name-only <base>...HEAD), plus CLAUDE.md's Invariants
section, which is always in scope regardless of what changed.

Also prints a weaker, second category: any of CLAUDE.md, docs/*.md, or a
rule file whose PROSE names a file the diff touched, even when its own
paths: frontmatter does not cover it. That doc may hold a claim the diff
just made stale -- read it, don't just re-glob it.

<base> defaults to "main" when omitted.

Reads COMMITTED work only. Uncommitted changes in the working tree are
invisible to it, so run it after committing -- which is where runbook step 7
puts it, just before the PR opens.`;

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
