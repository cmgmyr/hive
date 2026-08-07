import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { REPO } from "./helpers.mjs";

// test/fixtures/native-addon-abi/ holds four third-party BINARIES that this
// suite dlopen()s, and its README carried a sha256 for each one. Nothing
// hashed them. A provenance table nobody checks is a claim about four
// executables, and this project would flag exactly that shape in someone
// else's repo (hive todo 297 item 2).
//
// THE README IS THE CHECK, rather than a second table copied into this file.
// Two tables drift, and the failure mode of drift here is that the enforced
// copy quietly becomes the authority while the human-readable one still says
// something else. Parsing the README means an edit to the documented hash is
// an edit to the assertion, and there is nowhere for the two to disagree.
const FIXTURE_DIR = join(REPO, "test", "fixtures", "native-addon-abi");

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

// The table's data rows: | `file.node` | source | ABI | `sha256` |. Anchored on
// a backticked .node filename in the first cell so the header and separator
// rows cannot match, and so a future table elsewhere in the file needs its own
// parser rather than silently feeding this one.
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

    // Both directions. Without the first, a fixture added without a table row
    // is unchecked and this test still passes; without the second, a row whose
    // file was renamed or deleted passes too, and the table starts describing
    // something that is not there. The README's own instruction to ADD a pair
    // when CI's matrix moves is the case that makes the first direction live.
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

  // From lane B1's teardown (hive todo 297 comment 528 item 3). classic-package
  // shipped without its LICENSE while vendor/bindings and vendor/file-uri-to-path
  // both carried theirs, so the omission read as deliberate rather than
  // forgotten, and it survived a review round and a gate. MIT requires the
  // notice to travel with the copy, so the rule is per vendored package, not
  // per directory tree.
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
