import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { assertScratchStore, clearHiveEnv, scratchDirs } from "./helpers.mjs";

// Todo 411. Three truncation helpers - dashboard.ts's truncateWithEllipsis,
// kickoff.ts's truncate, wakes.ts's truncateBody - sliced on raw UTF-16 code
// units, so a cut landing inside an astral character (a surrogate PAIR) could
// emit a lone surrogate half: not valid UTF-16, not round-trippable through
// UTF-8, and JSON.stringify has to escape it. src/slug.ts's fallbackSlug
// already had a surrogate-safe walk (todo 318); this lane extracted it as
// cutToUnitBudget and wired all three sites to it, keeping each site's own
// suffix and bound exactly as they were. Every function exercised here is
// pure - no tmux reached, no process spawned - but dist/tools/wakes.js's own
// import chain reaches src/db.js at module load, which refuses the real
// store under a test runner unless HIVE_DATA_DIR points at a scratch dir
// first (test/CLAUDE.md's store-isolation guard).
clearHiveEnv();
process.env.HIVE_DATA_DIR = scratchDirs().dataDir;
await assertScratchStore();

// Mutation this file dies against: reverting any of the three call sites to
// its own naive `text.slice(0, N)` in place of `cutToUnitBudget(text, N)`.
const { truncateWithEllipsis } = await import("../dist/dashboard.js");
const { truncate } = await import("../dist/kickoff.js");
const { truncateBody } = await import("../dist/tools/wakes.js");

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

// Todo 411's own reproducer: 39 "e" then U+1F600 (an astral emoji, a UTF-16
// surrogate pair), then more text. A bound of 40 cuts exactly between the
// emoji's two halves under a naive code-unit slice: units 0-38 are the 39
// "e"s, units 39-40 are the emoji's high and low surrogate, and
// `.slice(0, 40)` keeps the high half and drops the low one.
const reproducer = (n) => `${"e".repeat(n)}\u{1F600} rest of text after the emoji`;

// cutToUnitBudget accumulates whole code points and stops BEFORE one that
// would overrun the budget (fallbackSlug's own documented behaviour) rather
// than including a partial one - so at the exact bug-reproducing offset (the
// emoji's own 2 units would push 39 e's to 41 against a 40 budget) the
// correct output drops the emoji whole instead of splitting it. To confirm
// the emoji survives when it actually FITS, `budget - 2` filler chars line
// it up so all of it lands inside the budget.
describe("surrogate-safe truncation (todo 411)", () => {
  it("dashboard.ts's truncateWithEllipsis does not split an astral character at the bound", () => {
    const out = truncateWithEllipsis(reproducer(39), 40);
    assert.ok(!LONE_SURROGATE.test(out), `must not contain a lone surrogate half: ${JSON.stringify(out)}`);
  });

  it("dashboard.ts's truncateWithEllipsis keeps an astral character whole when it fits inside the bound", () => {
    const out = truncateWithEllipsis(reproducer(38), 40);
    assert.ok(!LONE_SURROGATE.test(out), `must not contain a lone surrogate half: ${JSON.stringify(out)}`);
    assert.ok(out.includes("\u{1F600}"), `must keep a fitting emoji intact: ${JSON.stringify(out)}`);
  });

  it("kickoff.ts's truncate does not split an astral character at the bound", () => {
    const out = truncate(reproducer(39), 40);
    assert.ok(!LONE_SURROGATE.test(out), `must not contain a lone surrogate half: ${JSON.stringify(out)}`);
  });

  it("kickoff.ts's truncate keeps an astral character whole when it fits inside the bound", () => {
    const out = truncate(reproducer(38), 40);
    assert.ok(!LONE_SURROGATE.test(out), `must not contain a lone surrogate half: ${JSON.stringify(out)}`);
    assert.ok(out.includes("\u{1F600}"), `must keep a fitting emoji intact: ${JSON.stringify(out)}`);
  });

  it("wakes.ts's truncateBody does not split an astral character at its fixed 120 bound", () => {
    // truncateBody has no parameter - its bound is fixed at 120, so the
    // reproducer needs 119 filler chars rather than 39 to land the emoji
    // exactly on that bound instead of the 40 the other two sites use.
    const out = truncateBody(reproducer(119));
    assert.ok(!LONE_SURROGATE.test(out), `must not contain a lone surrogate half: ${JSON.stringify(out)}`);
  });

  it("wakes.ts's truncateBody keeps an astral character whole when it fits inside the bound", () => {
    const out = truncateBody(reproducer(118));
    assert.ok(!LONE_SURROGATE.test(out), `must not contain a lone surrogate half: ${JSON.stringify(out)}`);
    assert.ok(out.includes("\u{1F600}"), `must keep a fitting emoji intact: ${JSON.stringify(out)}`);
  });

  // Todo 411 warns against a user-visible length change as a side effect of
  // the correctness fix. None of the three sites reserve budget for their
  // suffix (unlike fallbackSlug, which has a zod round-trip constraint these
  // sites don't share) - the suffix is appended AFTER the cut, so for
  // BMP-only input the cut point, and therefore the whole output, must be
  // byte-identical to what the old `.slice(0, N)` produced.
  describe("no output change for input with no astral character on the boundary", () => {
    it("truncateWithEllipsis: unchanged on plain ASCII past the bound", () => {
      const text = "c".repeat(50);
      assert.equal(truncateWithEllipsis(text, 40), `${text.slice(0, 40)}…`);
    });

    it("truncateWithEllipsis: unchanged (no ellipsis) on text under the bound", () => {
      const text = "short text";
      assert.equal(truncateWithEllipsis(text, 40), text);
    });

    it("truncate: unchanged on plain ASCII past the bound", () => {
      const text = "c".repeat(50);
      assert.equal(truncate(text, 40), `${text.slice(0, 40).trimEnd()}\n[truncated]`);
    });

    it("truncate: unchanged on text under the bound", () => {
      const text = "short text";
      assert.equal(truncate(text, 40), text);
    });

    it("truncateBody: unchanged on plain ASCII past the 120 bound", () => {
      const text = "c".repeat(150);
      assert.equal(truncateBody(text), `${text.slice(0, 120)}…`);
    });

    it("truncateBody: unchanged on text under the 120 bound", () => {
      const text = "short body";
      assert.equal(truncateBody(text), text);
    });
  });
});
