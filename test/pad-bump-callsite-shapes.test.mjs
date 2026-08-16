import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { REPO } from "./helpers.mjs";

const SOURCE = readFileSync(`${REPO}/src/tools/pads.ts`, "utf8");

const ALL_CALLS = SOURCE.match(/(?<!function )\bbumpPad\(/g) ?? [];

const SHAPES = {
  "pad.revision": /bumpPad\(\s*[\w.]+\s*,\s*pad\.revision\s*,/g,
  "args.expected_revision": /bumpPad\(\s*[\w.]+\s*,\s*args\.expected_revision\s*,/g,
  undefined: /bumpPad\(\s*[\w.]+\s*,\s*undefined\s*,/g,
};

describe("every bumpPad( call site in src/tools/pads.ts passes one of the three named predicate shapes", () => {
  it("has exactly the five call sites this fix produces (update this count deliberately if a call site is added or removed)", () => {
    assert.equal(ALL_CALLS.length, 5);
  });

  it("every call matches pad.revision, args.expected_revision, or undefined - no other shape reaches bumpPad's predicate", () => {
    const matched = Object.values(SHAPES).reduce((n, re) => n + (SOURCE.match(re) ?? []).length, 0);
    assert.equal(
      matched,
      ALL_CALLS.length,
      "a bumpPad( call passes something other than the three named shapes (pad.revision / args.expected_revision / undefined). " +
        "If it's a genuinely new, deliberate policy: name and comment it here and above the call site, the way pad_append and " +
        "pad_archive are. If it's accidental, it likely reopens the exact lost-update race this fix exists to close.",
    );
  });

  it("pad.revision (always-guard) is used by exactly three call sites: overwritePadContent, pad_write, pad_edit", () => {
    assert.equal((SOURCE.match(SHAPES["pad.revision"]) ?? []).length, 3);
  });

  it("args.expected_revision (caller-specified-only) is used by exactly one call site: pad_append", () => {
    assert.equal((SOURCE.match(SHAPES["args.expected_revision"]) ?? []).length, 1);
  });

  it("undefined (never-guard) is used by exactly one call site: pad_archive", () => {
    assert.equal((SOURCE.match(SHAPES.undefined) ?? []).length, 1);
  });
});
