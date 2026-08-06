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
  "better-sqlite3": "^13.0.3",
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

// Issue #105 lane B1, and the reason this is a test rather than a comment in
// package.json: engines.node is NOT an independent choice. better-sqlite3 13's
// addon is built with NAPI_VERSION=10, a Node that does not provide Node-API 10
// segfaults inside dlopen with no output at all, and hive declared ">=22.5.0"
// through that whole range because nothing tied the two numbers together.
//
// Both sides are read here, neither is derived from the other: the required
// level comes from the installed dependency's own binding.gyp, and the
// declaration comes from package.json.
//
// THE ASSERTION'S SHAPE IS THE FIX, NOT THE VERSION IN IT. This test first
// shipped asserting `engines.node === ">=" + <one lowest version>`, which
// hardcoded the assumption that a Node-API level starts at a single version.
// It does not - it starts once per release line - so the CORRECT declaration
// (`^22.14.0 || >=23.6.0`, which excludes the Node-API 9 releases 23.0.0 to
// 23.5.0) FAILED the test that claimed to keep the numbers in step. A test
// that has to be edited to accept a correct value was pinning the bug.
// Comparing against the derived range means the test follows the model
// instead of restating one case of it.
describe("the engines declaration and the addon's Node-API requirement", () => {
  it("package.json admits exactly the Nodes that provide the level the installed addon needs", async () => {
    const { requiredNodeApi, nodeRangeForNodeApi } = await import("../dist/abi.js");
    const required = requiredNodeApi();
    assert.ok(required !== null, "better-sqlite3 stopped stating NAPI_VERSION; src/abi.ts's guard is void without it");
    const range = nodeRangeForNodeApi(required);
    assert.ok(
      range,
      `no start points recorded for Node-API ${required} - add its per-release-line versions to ` +
        "NODE_API_STARTS in src/abi.ts, or the guard can report a level and not a fix",
    );
    const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));
    assert.equal(
      pkg.engines?.node,
      range,
      `the addon needs Node-API ${required}, which only Node ${range} provides, but package.json ` +
        `advertises ${pkg.engines?.node}. A Node the declaration admits and the level excludes installs ` +
        "cleanly and cannot load the addon.",
    );
    // The lockfile carries its own copy of engines and npm only refreshes it
    // on an install. It was left at ">=22.5.0" for a whole commit after
    // package.json moved, which is a second declaration saying something
    // false about the same tree.
    const lock = JSON.parse(readFileSync(join(REPO, "package-lock.json"), "utf8"));
    assert.equal(
      lock.packages?.[""]?.engines?.node,
      range,
      "package-lock.json's root engines drifted from package.json - run npm install to refresh it",
    );
  });

  it("derives the range from start points rather than restating it", async () => {
    const { nodeRangeForNodeApi } = await import("../dist/abi.js");
    // The property, stated where it can fail: every line but the last is
    // capped at its own major, because the next major sits BELOW the level
    // until its own start point. Node 23.0.0-23.5.0 is the concrete case -
    // it satisfies ">=22.14.0" and provides Node-API 9.
    assert.equal(nodeRangeForNodeApi(10), "^22.14.0 || >=23.6.0");
    assert.doesNotMatch(nodeRangeForNodeApi(10), /^>=22\.14\.0$/, "a bare >= admits the 23.0-23.5 gap");
    assert.equal(nodeRangeForNodeApi(99), null, "an unrecorded level gets no invented range");
  });
});
