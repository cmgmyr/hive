import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { CEILING_PCT, countFile, GROUPS, measure, overBudgetMessage } from "../scripts/comment-ratio.mjs";

const REPO = fileURLToPath(new URL("..", import.meta.url));

test("every group stays under the comment ceiling", () => {
  const m = measure(REPO);
  for (const g of m.groups) {
    // Per group, never pooled: test/'s 31,920 code lines would otherwise fund
    // ~2,470 comment lines that could all land in src/, taking it to 17% green.
    assert.ok(g.pct <= CEILING_PCT, overBudgetMessage(m, g));
  }
});

// A glob that stopped matching reports zero comments and reads exactly like a
// clean tree. Renaming scripts/*.mjs to *.js, or moving tests under
// test/unit/*.test.js, used to drop that group out of the cap with the suite
// still green - the first false-green shape test/CLAUDE.md names.
test("every group matches files, so none can silently leave the cap", () => {
  const m = measure(REPO);
  assert.equal(m.groups.length, GROUPS.length);
  for (const g of m.groups) {
    assert.ok(g.files > 0, `group ${g.name} matched no files; its globs have gone stale`);
    assert.ok(g.code > 0, `group ${g.name} measured no code lines`);
  }
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

test("a shell comment line counts, a shebang does not", () => {
  assert.deepEqual(countFile("#!/bin/sh\n# why\necho hi\n", "sh"), { comment: 1, code: 2 });
  assert.deepEqual(countFile('echo "a # b"\n', "sh"), { comment: 0, code: 1 });
});

test("the over-budget message routes rather than telling you to delete", () => {
  const msg = overBudgetMessage({ pct: 9, comment: 1, code: 10, groups: [] }, { name: "src/", pct: 9, comment: 1, code: 10 });
  assert.match(msg, /skill's references/);
  assert.match(msg, /lessons record/);
  assert.match(msg, /Do not delete the comment to get green/);
});
