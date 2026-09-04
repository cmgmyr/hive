#!/usr/bin/env node

import { globSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const CEILING_PCT = 5;

// PER GROUP, not pooled. One pooled ratio over every tree lets test/'s 31,920
// code lines fund comments that all land in src/: 5% of the pool is ~2,470
// lines against src/'s own ~630, so src/ could reach 17% with the check green.
// Each group carries the same ceiling instead, which is what "the whole repo
// has the same ratio test" has to mean to be worth anything (todo 438).
export const GROUPS = [
  { name: "src/", globs: ["src/**/*.ts"], lang: "js" },
  { name: "test/", globs: ["test/**/*.mjs"], lang: "js" },
  { name: "scripts/", globs: ["scripts/**/*.mjs"], lang: "js" },
  { name: "scripts/ shell", globs: ["scripts/**/*.sh"], lang: "sh" },
  { name: "claude-plugin/", globs: ["claude-plugin/**/*.mjs"], lang: "js" },
  { name: ".github/workflows/", globs: [".github/workflows/*.yml", ".github/workflows/*.yaml"], lang: "sh" },
];

export function findComments(src) {
  const out = [];
  let i = 0;
  let line = 1;
  let prev = "";

  const stack = [{ kind: "code", depth: 0 }];

  const at = (n) => src[i + n];
  const bump = (n) => {
    for (let k = 0; k < n; k++) if (src[i + k] === "\n") line++;
    i += n;
  };
  const top = () => stack[stack.length - 1];

  while (i < src.length) {
    const c = src[i];

    if (top().kind === "template") {
      if (c === "\\") { bump(2); continue; }
      if (c === "`") { bump(1); stack.pop(); prev = "str"; continue; }
      if (c === "$" && at(1) === "{") { bump(2); stack.push({ kind: "code", depth: 0 }); prev = ""; continue; }
      bump(1);
      continue;
    }

    if (c === "/" && at(1) === "/") {
      const start = i;
      const startLine = line;
      while (i < src.length && src[i] !== "\n") i++;
      out.push({ start, end: i, text: src.slice(start, i), line: startLine });
      continue;
    }

    if (c === "/" && at(1) === "*") {
      const start = i;
      const startLine = line;
      bump(2);
      while (i < src.length && !(src[i] === "*" && at(1) === "/")) bump(1);
      bump(2);
      out.push({ start, end: i, text: src.slice(start, i), line: startLine });
      continue;
    }

    if (c === '"' || c === "'") {
      const quote = c;
      bump(1);
      while (i < src.length && src[i] !== quote) {
        if (src[i] === "\\") bump(1);
        bump(1);
      }
      bump(1);
      prev = "str";
      continue;
    }

    if (c === "`") { bump(1); stack.push({ kind: "template" }); continue; }

    if (c === "{") { top().depth++; bump(1); prev = "{"; continue; }
    if (c === "}") {
      if (top().depth === 0 && stack.length > 1) { bump(1); stack.pop(); prev = "str"; continue; }
      top().depth--;
      bump(1);
      prev = "}";
      continue;
    }

    if (c === "/" && regexCanFollow(prev)) {
      const start = i;
      const startLine = line;
      bump(1);
      let inClass = false;
      let closed = false;
      while (i < src.length) {
        const d = src[i];
        if (d === "\\") { bump(2); continue; }
        if (d === "[") inClass = true;
        else if (d === "]") inClass = false;
        else if (d === "/" && !inClass) { bump(1); closed = true; break; }
        else if (d === "\n") break;
        bump(1);
      }
      if (closed) { prev = "regex"; continue; }
      i = start;
      line = startLine;
      bump(1);
      prev = "/";
      continue;
    }

    if (/\s/.test(c)) { bump(1); continue; }

    if (/[A-Za-z_$]/.test(c)) {
      let w = "";
      while (i < src.length && /[A-Za-z0-9_$]/.test(src[i])) { w += src[i]; bump(1); }
      prev = KEYWORDS_BEFORE_REGEX.has(w) ? "keyword" : "ident";
      continue;
    }
    if (/[0-9]/.test(c)) {
      while (i < src.length && /[0-9._eExXa-fA-F]/.test(src[i])) bump(1);
      prev = "ident";
      continue;
    }
    prev = c;
    bump(1);
  }
  return out;
}

const KEYWORDS_BEFORE_REGEX = new Set([
  "return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw",
  "case", "do", "else", "yield", "await",
]);

function regexCanFollow(prev) {
  if (prev === "") return true;
  if (prev === "keyword") return true;
  if (prev === "str" || prev === "regex" || prev === "ident" || prev === ")" || prev === "]") return false;
  return "([{,;:=!&|?+-*%<>~^".includes(prev);
}

// Shell needs no strings-vs-comment scanner: a `#` opening a line is a
// comment, one mid-line is usually inside a string here, and line 1's shebang
// is not a comment and must survive.
export function findShellComments(src) {
  const out = [];
  let pos = 0;
  src.split("\n").forEach((raw, n) => {
    const lead = raw.length - raw.trimStart().length;
    if (raw.trim().startsWith("#") && !(n === 0 && raw.startsWith("#!"))) {
      out.push({ start: pos + lead, end: pos + raw.length, text: raw.trim(), line: n + 1 });
    }
    pos += raw.length + 1;
  });
  return out;
}

export function countFile(src, lang = "js") {
  const spans = lang === "sh" ? findShellComments(src) : findComments(src);
  let blanked = "";
  let last = 0;
  for (const s of spans) {

    blanked += src.slice(last, s.start) + src.slice(s.start, s.end).replace(/[^\n]/g, " ");
    last = s.end;
  }
  blanked += src.slice(last);

  const before = src.split("\n");
  const after = blanked.split("\n");
  let comment = 0;
  let code = 0;
  for (let n = 0; n < before.length; n++) {
    const wasBlank = before[n].trim() === "";
    const isBlank = after[n].trim() === "";
    if (wasBlank) continue;
    if (isBlank) comment++;
    else code++;
  }
  return { comment, code };
}

const pctOf = (comment, code) => (comment + code ? (100 * comment) / (comment + code) : 0);

export function measure(repo = ".") {
  const groups = [];
  const files = [];
  let comment = 0;
  let code = 0;
  for (const g of GROUPS) {
    const paths = g.globs.flatMap((p) => globSync(p, { cwd: repo })).sort();
    let gc = 0;
    let gk = 0;
    for (const rel of paths) {
      const r = countFile(readFileSync(join(repo, rel), "utf8"), g.lang);
      files.push({ file: rel, ...r });
      gc += r.comment;
      gk += r.code;
    }
    groups.push({ name: g.name, files: paths.length, comment: gc, code: gk, pct: pctOf(gc, gk) });
    comment += gc;
    code += gk;
  }
  return { groups, files, comment, code, pct: pctOf(comment, code) };
}

export function overBudgetMessage(m, over = m.groups?.find((g) => g.pct > CEILING_PCT) ?? m) {
  return [
    `${over.name} is ${over.pct.toFixed(1)}% comment lines (${over.comment} comment, ${over.code} code).`,
    `The ceiling is ${CEILING_PCT}%, per group, and the repo is ${m.pct.toFixed(1)}%.`,
    "",
    "Do not delete the comment to get green. Route it to whichever of these",
    "reaches the reader who needs it, and keep here only what the next person",
    "editing that exact line would get wrong without:",
    "  a prohibition spanning files      -> .claude/rules/ or CLAUDE.md",
    "  evidence, mechanism, measurement  -> a skill's references",
    "  a standing lesson about the work  -> the project's lessons record, if it keeps one",
    "  why this lane decided it          -> a todo comment",
    "  what changed and why              -> the commit message",
    "",
    "Raising CEILING_PCT is a decision, not a fix. Ask first.",
  ].join("\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const m = measure(process.argv[2] ?? ".");
  for (const f of [...m.files].sort((a, b) => b.comment - a.comment).slice(0, 10)) {
    if (f.comment) console.log(`${String(f.comment).padStart(6)}c ${String(f.code).padStart(6)}k  ${f.file}`);
  }
  for (const g of m.groups) {
    console.log(`${g.pct.toFixed(1).padStart(5)}%  ${String(g.comment).padStart(5)}c ${String(g.code).padStart(6)}k  ${g.files} files  ${g.name}`);
  }
  console.log(`\nrepo: ${m.comment} comment, ${m.code} code, ${m.pct.toFixed(1)}% (ceiling ${CEILING_PCT}% per group)`);
}
