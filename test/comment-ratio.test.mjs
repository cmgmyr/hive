import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { CEILING_PCT, countFile, measure, overBudgetMessage } from "../scripts/comment-ratio.mjs";

const REPO = fileURLToPath(new URL("..", import.meta.url));

test("src/ stays under the comment ceiling", () => {
  const m = measure(REPO);
  assert.ok(m.code > 0, "measured no code at all, so the check cannot fail");
  assert.ok(m.pct <= CEILING_PCT, overBudgetMessage(m));
});

test("a comment on its own line counts, one trailing real code does not", () => {
  assert.deepEqual(countFile("// why\nconst a = 1;\n"), { comment: 1, code: 1 });
  assert.deepEqual(countFile("const a = 1; // why\n"), { comment: 0, code: 1 });
  assert.deepEqual(countFile("/* a\n b */\nconst a = 1;\n"), { comment: 2, code: 1 });
});

test("comment markers inside strings, templates and regexes are not comments", () => {
  assert.deepEqual(countFile('const u = "http://x";\n'), { comment: 0, code: 1 });
  assert.deepEqual(countFile("const r = /a\\/\\/b/;\n"), { comment: 0, code: 1 });
  assert.deepEqual(countFile("const s = `\n// page script\n`;\n"), { comment: 0, code: 3 });
});

test("a regex and a nested template inside one substitution do not desync it", () => {
  const src = "const q = `'${s.replace(/'/g, `'\\''`)}'`;\n// counted\nconst a = 1;\n";
  assert.deepEqual(countFile(src), { comment: 1, code: 2 });
});

test("a keyword before a slash opens a regex, an identifier before one does not", () => {
  assert.deepEqual(countFile("function f(x) {\n  return /d(o)n't/.test(x);\n}\n// one\n// two\nconst a = 1;\n"), {
    comment: 2,
    code: 4,
  });
  assert.deepEqual(countFile("const r = a / b / c;\n// one\n"), { comment: 1, code: 1 });
  assert.deepEqual(countFile("const q = typeof a;\nconst r = a / b;\n// one\n"), { comment: 1, code: 2 });
});

test("the over-budget message routes rather than telling you to delete", () => {
  const msg = overBudgetMessage({ pct: 9, comment: 1, code: 10 });
  assert.match(msg, /skill's references/);
  assert.match(msg, /lessons pad/);
  assert.match(msg, /Do not delete the comment to get green/);
});
