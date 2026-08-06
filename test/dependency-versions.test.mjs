import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { REPO } from "./helpers.mjs";

// Issue #105. @types/better-sqlite3 described better-sqlite3 v7 while the
// runtime ran v12, for the life of the project, and nothing noticed for
// sixteen months. The issue that started this asked for a check that the
// types' major matches the runtime's major. THAT IS NOT IMPLEMENTABLE:
// DefinitelyTyped's major.minor convention has plainly diverged from the
// package it describes. There is no 8.x of @types/better-sqlite3 at all; the
// DT line jumps 7.6.13 straight to 9.6.0, which is the ts5.7-ts6.0 tag, while
// better-sqlite3 itself is at major 12 going on 13. A "majors must match"
// assertion would be false the moment it was written, and loosening it into
// something that cannot fail would be worse than deleting it.
//
// So this pins the VERIFIED PAIR instead: the exact (better-sqlite3,
// @types/better-sqlite3) versions that a human has actually built and opened
// a real store under, together. Any bump to either side fails this test until
// somebody updates VERIFIED_PAIR deliberately - which is the exact event that
// went unnoticed for sixteen months, now forced into the open. A bump to only
// one side (e.g. types alone, or the addon alone) is exactly what this
// catches; a coincidental matching pair of version numbers cannot satisfy it
// by accident, because there is nothing coincidental to match.
//
// If you are updating this because a lane just bumped one of these packages:
// confirm the new pair actually opens a real store under the interpreter hive
// runs (see .claude/rules/native-addon.md - `require()` proves nothing), then
// move VERIFIED_PAIR to match package.json and say so in the PR body. That is
// this check doing its job, not a check to route around.
const VERIFIED_PAIR = {
  "better-sqlite3": "^12.11.1",
  "@types/better-sqlite3": "^9.6.0",
};

describe("the better-sqlite3 / @types/better-sqlite3 verified pair", () => {
  it("package.json still declares the pair that was actually built and opened together", () => {
    const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));
    for (const [name, version] of Object.entries(VERIFIED_PAIR)) {
      const declared = pkg.dependencies?.[name] ?? pkg.devDependencies?.[name];
      assert.equal(
        declared,
        version,
        `${name} drifted from the verified pair (expected ${version}, package.json has ${declared}). ` +
          "If this bump was deliberate and the new pair has been rebuilt and opened against a real " +
          "store, update VERIFIED_PAIR in this file to match.",
      );
    }
  });
});
