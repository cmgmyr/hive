import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { REPO } from "./helpers.mjs";

const FIXTURE_DIR = join(REPO, "test", "fixtures", "native-addon-abi");

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function documentedHashes() {
  const readme = readFileSync(join(FIXTURE_DIR, "README.md"), "utf8");
  const rows = [...readme.matchAll(/^\|\s*`([^`]+\.node)`\s*\|[^|]*\|[^|]*\|\s*`([0-9a-f]{64})`\s*\|/gm)];
  return new Map(rows.map((m) => [m[1], m[2]]));
}

describe("the vendored native-addon fixtures match their documented provenance", () => {
  it("every .node file in the fixture directory has a documented sha256, and matches it", () => {
    const documented = documentedHashes();
    const present = readdirSync(FIXTURE_DIR)
      .filter((f) => f.endsWith(".node"))
      .sort();

    assert.deepEqual(
      present,
      [...documented.keys()].sort(),
      "the fixture directory and the README's sha256 table name different files. Add the row, " +
        "or remove it, so every binary this suite dlopen()s is one the README accounts for.",
    );
    assert.ok(present.length > 0, "no .node fixtures found at all - the table above cannot be checked");

    for (const file of present) {
      assert.equal(
        sha256(join(FIXTURE_DIR, file)),
        documented.get(file),
        `${file} does not hash to the sha256 test/fixtures/native-addon-abi/README.md records for it. ` +
          "These are third-party binaries this suite loads into its own process: re-download from the " +
          "release the README names and compare, rather than updating the table to match the file.",
      );
    }
  });

  it("every vendored fixture package carries its licence", () => {
    const classicPkg = join(FIXTURE_DIR, "classic-package");
    const vendored = [classicPkg, ...readdirSync(join(classicPkg, "vendor")).map((d) => join(classicPkg, "vendor", d))];

    assert.ok(vendored.length > 1, `expected classic-package plus its vendored deps, found ${vendored.length}`);
    for (const dir of vendored) {
      const names = readdirSync(dir);
      assert.ok(
        names.some((n) => /^licen[cs]e/i.test(n)),
        `${dir.slice(REPO.length + 1)} vendors third-party code with no licence file. Take it from the same ` +
          "tarball the code came from; anything vendored here brings its licence with it.",
      );
    }
  });
});
