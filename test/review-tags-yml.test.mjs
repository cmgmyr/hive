import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { loadProjectYml } from "../dist/projectYml.js";

function ymlProject(body) {
  const dir = mkdtempSync(join(tmpdir(), "hive-yml-review-tags-"));
  writeFileSync(join(dir, "hive.yml"), body);
  return dir;
}

describe("hive.yml review_tags key (todo 748)", () => {
  it("is empty when the key is absent, so hive names no review vocabulary of its own", () => {
    const { config, warnings } = loadProjectYml(ymlProject("placement: split\n"));
    assert.deepEqual(config.review_tags, []);
    assert.deepEqual(warnings, []);
  });

  it("keeps the project's tags in the order the file lists them", () => {
    const { config, warnings } = loadProjectYml(ymlProject("review_tags: [from-review, needs-triage]\n"));
    assert.deepEqual(config.review_tags, ["from-review", "needs-triage"]);
    assert.deepEqual(warnings, []);
  });

  it("trims each entry and drops a duplicate, so the doctor line cannot repeat a tag", () => {
    const { config, warnings } = loadProjectYml(ymlProject('review_tags: ["  from-review  ", from-review]\n'));
    assert.deepEqual(config.review_tags, ["from-review"]);
    assert.deepEqual(warnings, []);
  });

  it("warns and tracks nothing when the value is not a list", () => {
    const { config, warnings } = loadProjectYml(ymlProject("review_tags: from-review\n"));
    assert.deepEqual(config.review_tags, []);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /review_tags must be a list of todo tags/);
  });

  it("warns and skips an empty or non-string entry without losing the rest of the list", () => {
    const { config, warnings } = loadProjectYml(ymlProject('review_tags: [from-review, "", 7]\n'));
    assert.deepEqual(config.review_tags, ["from-review"]);
    assert.equal(warnings.length, 2);
    assert.match(warnings[0], /review_tags entry must be a non-empty tag/);
  });
});
