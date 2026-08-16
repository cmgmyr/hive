#!/usr/bin/env node
// Caps how much of src/ is comment (todo 436). Run directly for the report.
import { globSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const CEILING_PCT = 5;

// Comment spans, skipping strings, templates and regexes. A line-prefix match
// would count src/dashboard.ts's embedded browser JS as comments.
export function findComments(src) {
  const out = [];
  let i = 0;
  let line = 1;
  let prev = "";
  // `${}` pushes a code context so its contents scan by the same rules. Both
  // desyncs this scanner has had were silent under-counts; see its tests.
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
    // Whole identifiers: `return /re/` and `x /re/` differ only in this word.
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

// A comment LINE is one that exists only for its comment. One trailing real
// code costs no line and is not counted.
export function countFile(src) {
  const spans = findComments(src);
  let blanked = "";
  let last = 0;
  for (const s of spans) {
    // Newlines survive, or a block comment collapses the lines after it.
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

export function measure(repo = ".") {
  const files = [];
  let comment = 0;
  let code = 0;
  for (const rel of globSync("src/**/*.ts", { cwd: repo }).sort()) {
    const r = countFile(readFileSync(join(repo, rel), "utf8"));
    files.push({ file: rel, ...r });
    comment += r.comment;
    code += r.code;
  }
  return { files, comment, code, pct: comment + code ? (100 * comment) / (comment + code) : 0 };
}

export function overBudgetMessage(m) {
  return [
    `src/ is ${m.pct.toFixed(1)}% comment lines (${m.comment} comment, ${m.code} code).`,
    `The ceiling is ${CEILING_PCT}%.`,
    "",
    "Do not delete the comment to get green. Route it to whichever of these",
    "reaches the reader who needs it, and keep here only what the next person",
    "editing that exact line would get wrong without:",
    "  a prohibition spanning files      -> .claude/rules/ or CLAUDE.md",
    "  evidence, mechanism, measurement  -> a skill's references",
    "  a standing lesson about the work  -> the lessons pad",
    "  why this lane decided it          -> a todo comment",
    "  what changed and why              -> the commit message",
    "",
    "Raising CEILING_PCT is a decision, not a fix. Ask first.",
  ].join("\n");
}

// pathToFileURL: a `file://` template fails on any path needing encoding.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const m = measure(process.argv[2] ?? ".");
  for (const f of [...m.files].sort((a, b) => b.comment - a.comment).slice(0, 10)) {
    if (f.comment) console.log(`${String(f.comment).padStart(6)}c ${String(f.code).padStart(6)}k  ${f.file}`);
  }
  console.log(`\nsrc/: ${m.comment} comment, ${m.code} code, ${m.pct.toFixed(1)}% (ceiling ${CEILING_PCT}%)`);
}
