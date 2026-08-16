import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { REPO } from "./helpers.mjs";

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

describe("zod resolves to exactly one copy in the tree", () => {
  const isZod = (p) => p.split("node_modules/").pop() === "zod";
  const REASON =
    "A duplicate means hive's zod range and its consumers' have diverged, so the SDK is being handed " +
    "schemas from a version it does not declare support for. Reconcile the ranges rather than accepting " +
    "the duplicate; see this file's header for what does and does not actually break.";

  it("package-lock.json records no second zod anywhere", () => {
    const lock = JSON.parse(readFileSync(join(REPO, "package-lock.json"), "utf8"));
    const paths = Object.keys(lock.packages ?? {}).filter(isZod);
    assert.deepEqual(paths, ["node_modules/zod"], `lockfile resolves zod to ${JSON.stringify(paths)}. ${REASON}`);
  });

  it("node_modules contains no second zod on disk", () => {

    const found = [];
    const dirsIn = (dir) => {
      try {
        return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && e.name !== ".bin");
      } catch {

        return [];
      }
    };

    const visitPackage = (dir, rel, scoped) => {

      if (!scoped && rel.split("/").pop() === "zod") found.push(rel);
      scan(join(dir, "node_modules"), `${rel}/node_modules`);
    };
    const scan = (nmDir, nmRel) => {
      for (const e of dirsIn(nmDir)) {
        if (e.name.startsWith("@")) {
          for (const pkg of dirsIn(join(nmDir, e.name))) {
            visitPackage(join(nmDir, e.name, pkg.name), `${nmRel}/${e.name}/${pkg.name}`, true);
          }
        } else {
          visitPackage(join(nmDir, e.name), `${nmRel}/${e.name}`, false);
        }
      }
    };
    scan(join(REPO, "node_modules"), "node_modules");
    assert.deepEqual(found, ["node_modules/zod"], `node_modules holds zod at ${JSON.stringify(found)}. ${REASON}`);
  });

  it("a package other than hive still declares a zod range, so a duplicate is still reachable", () => {

    const lock = JSON.parse(readFileSync(join(REPO, "package-lock.json"), "utf8"));
    const declarers = Object.entries(lock.packages ?? {})
      .filter(([path, meta]) => path !== "" && !isZod(path) && (meta.dependencies?.zod || meta.peerDependencies?.zod))
      .map(([path]) => path);
    assert.ok(
      declarers.length > 0,
      "nothing but hive declares a zod dependency any more; the single-copy checks above may now be vacuous",
    );
  });
});

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

    const lock = JSON.parse(readFileSync(join(REPO, "package-lock.json"), "utf8"));
    assert.equal(
      lock.packages?.[""]?.engines?.node,
      range,
      "package-lock.json's root engines drifted from package.json - run npm install to refresh it",
    );
  });

  it("derives the range from start points rather than restating it", async () => {
    const { nodeRangeForNodeApi } = await import("../dist/abi.js");

    assert.equal(nodeRangeForNodeApi(10), "^22.14.0 || >=23.6.0");
    assert.doesNotMatch(nodeRangeForNodeApi(10), /^>=22\.14\.0$/, "a bare >= admits the 23.0-23.5 gap");
    assert.equal(nodeRangeForNodeApi(99), null, "an unrecorded level gets no invented range");
  });
});
