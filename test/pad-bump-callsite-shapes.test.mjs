import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { REPO } from "./helpers.mjs";

// Fix round 1 on todo 345 / issue #148. Counselors found that this suite's
// handler-level tests (pad-revision-race, lease-owner-race,
// project-registration-race) pin the HELPER functions (bumpPad,
// extendOwnedLease) and not the CALL SITES: change pad_edit to pass
// args.expected_revision instead of pad.revision, or pad_write/pad_delete
// the same way, and the whole suite stays green - that restores the exact
// lost update this fix exists to close, silently.
//
// A handler-level test cannot close this: the lost update needs a
// concurrent write inside ONE handler invocation, better-sqlite3 is
// synchronous, and racing two real processes for a window that narrow has
// already been rejected three times in this same lane (pad-revision-race,
// lease-owner-race, lease-acquire-conflict-undefined test files). The
// remedy is a SOURCE-LEVEL assertion, matching this suite's own precedent
// (test/tool-registration.test.mjs scans src/tools/*.ts for run(),
// test/suite-isolation.test.mjs scans the suite itself for isolateTmux()).
// A regex over five known call sites is the intent here, not a parser:
// this file recognises the three fixed shapes this round establishes and
// counts them; it does not evaluate arbitrary expressions.
//
// The three shapes, and why each is the right one for its caller:
//   pad.revision            - always-guard. pad_write, pad_edit, and
//                              overwritePadContent (the CLI's `hive pad
//                              --save` path) all rewrite content in JS from
//                              a stale read, so the write must be
//                              conditioned on the revision THIS call read,
//                              whether or not the caller passed
//                              expected_revision.
//   args.expected_revision  - caller-specified-only, exactly one caller:
//                              pad_append. It concatenates in SQL against
//                              the live column (and, since fix round 1,
//                              decides its separator in the same statement
//                              too - see APPEND_WITH_SEPARATOR_SET), so it
//                              cannot lose data from an unrelated write and
//                              needs no guard when the caller did not ask
//                              for one.
//   undefined                - never-guard, exactly one caller:
//                              pad_archive. Archived is a metadata flag,
//                              not content; a lost race there flips it back
//                              and forth rather than destroying anything,
//                              and is out of this fix's scope (todo
//                              345/issue #148 name pads.ts's
//                              content-rewriting writes, not this one).
//
// UNTESTED BRANCH, named rather than implied covered: this file proves each
// call site passes the right EXPRESSION, not that pad.revision is always
// the freshest possible read at the point it's passed - a future edit that
// reads pad earlier and mutates the row before calling bumpPad would defeat
// the guarantee while still matching this test's shape textually. The
// revision-race, lease-owner-race, and lease-acquire-* tests are what prove
// the GUARD ITSELF works once the right value reaches it; this file only
// proves the right value is what gets sent.

const SOURCE = readFileSync(`${REPO}/src/tools/pads.ts`, "utf8");

// Every CALL, not bumpPad's own definition line - "function " immediately
// precedes "bumpPad(" only there ("export function bumpPad(...)").
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
